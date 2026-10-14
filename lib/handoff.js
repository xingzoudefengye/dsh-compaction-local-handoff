/**
 * Deterministic, model-free "local handoff" construction.
 *
 * Ported in spirit from ComeCode's `packages/core/src/compact/local-handoff.ts`:
 * the replacement checkpoint is assembled from the very messages being shadowed,
 * with fixed per-field character budgets and no model call, so compaction stays
 * free, immediate, and reproducible.
 *
 * The output is intentionally *not* a summary of the work: it is a bounded
 * handoff of what the disappearing span still owes the ongoing task — the last
 * user request, the constraints that were in force, the files that were touched,
 * and the last few actions and their outcomes. Everything else is expected to be
 * re-read from the session log on demand.
 *
 * @module dsh-compaction-local-handoff/handoff
 */

/** Hard ceiling for the assembled handoff text, in characters. */
export const MAX_LOCAL_HANDOFF_CHARS = 6_000;
/** Share of the budget spent on the leading guide (the rest goes to the summary). */
const GUIDE_BUDGET_RATIO = 0.55;
/** Smallest budget this builder will honour, even for a tiny region. */
const MIN_BUDGET_CHARS = 256;
const MAX_USER_CHARS = 1_600;
const MAX_PROGRESS_CHARS = 900;
const MAX_CONSTRAINT_CHARS = 300;
const MAX_CONSTRAINTS = 3;
const MAX_TOOL_CHARS = 280;
const MAX_TOOL_DESCRIPTION_CHARS = 160;
const MAX_RECENT_TOOLS = 4;
const MAX_FILES = 25;
const MAX_PRIOR_CHARS = 1_200;
const MAX_ERRORS = 2;

/** Tag framing a persisted checkpoint body, owned by the compaction backend. */
const SUMMARY_OPEN_TAG = "<compacted-summary>";
const SUMMARY_CLOSE_TAG = "</compacted-summary>";

/** Argument keys that name a file the call acted on, most specific first. */
const FILE_ARGUMENT_KEYS = ["file_path", "filePath", "path", "notebook_path", "notebookPath"];
/** Argument keys worth quoting as the one-line description of a call. */
const DESCRIPTION_ARGUMENT_KEYS = [
	"file_path",
	"filePath",
	"path",
	"command",
	"pattern",
	"query",
	"description"
];

const GUIDE_HEADER =
	"以下仅为当前工作的本地交接，不表示任务已经完成。遵循最新用户要求；不要复活旧目标或重复已完成操作。";
const GUIDE_FOOTER =
	"压缩区间之前的完整原文仍保留在会话日志中；缺失细节请按需重新读取，不要凭记忆重放旧历史。";
const SUMMARY_HEADER = "当前任务交接（本地生成，未调用模型；更早的细节可以丢弃）";
const SUMMARY_FOOTER =
	"工具结果只保留预览，原始记录仍在本地。继续当前工作，缺失的必要细节按需读取，不重新展开历史。";

/**
 * Extract the model-visible text of one message content value.
 * @param content - a message's `content`, either a string or content blocks.
 * @returns the concatenated text of its text blocks, or `""`.
 */
export function visibleText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

/** Drop reasoning wrappers, redact credential-shaped text, and collapse whitespace. */
function normalize(text) {
	return String(text ?? "")
		.replace(/<(?:thinking|analysis)>[\s\S]*?<\/(?:thinking|analysis)>/giu, "")
		.replace(/\b(?:sk|sess-key)-[A-Za-z0-9_-]{8,}/gu, "[redacted]")
		.replace(
			/((?:api[_-]?key|authorization|password|secret|token)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|Bearer\s+\S+|\S+)/giu,
			"$1[redacted]"
		)
		.replace(/Bearer\s+[A-Za-z0-9._-]+/giu, "Bearer [redacted]")
		.replace(/\s+/gu, " ")
		.trim();
}

/** Cut text to a character budget without collapsing its whitespace. */
function truncate(text, limit) {
	if (limit <= 0) return "";
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/**
 * Normalize and cut one field to a character budget.
 * @param text - raw field text.
 * @param limit - maximum characters to keep.
 * @returns redacted, single-line, truncated text.
 */
export function shortText(text, limit) {
	return truncate(normalize(text), limit);
}

/** Parse a tool call's `arguments` into an object when it is JSON text. */
function parseArguments(args) {
	if (args !== null && typeof args === "object") return args;
	if (typeof args !== "string" || args.trim().length === 0) return null;
	try {
		const parsed = JSON.parse(args);
		return parsed !== null && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

/** Return every `tool-call` block of one assistant message content. */
function toolCallBlocks(content) {
	if (!Array.isArray(content)) return [];
	return content.filter((block) => block !== null && typeof block === "object" && block.type === "tool-call");
}

/** First string argument that names a file, or `undefined`. */
function fileFromArguments(args) {
	if (args === null) return undefined;
	for (const key of FILE_ARGUMENT_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

/** One-line description of a tool call from its most telling arguments. */
function describeArguments(args) {
	if (args === null) return "";
	const parts = [];
	for (const key of DESCRIPTION_ARGUMENT_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.trim().length > 0) parts.push(value.trim());
	}
	return truncate(normalize(parts.join(" ")), MAX_TOOL_DESCRIPTION_CHARS);
}

/** Inner text of the last persisted checkpoint found in the region, or `""`. */
function priorCheckpointText(text) {
	const start = text.indexOf(SUMMARY_OPEN_TAG);
	const end = text.lastIndexOf(SUMMARY_CLOSE_TAG);
	if (start < 0) return "";
	return end > start ? text.slice(start + SUMMARY_OPEN_TAG.length, end) : text.slice(start + SUMMARY_OPEN_TAG.length);
}

/**
 * Collect the handoff material from the messages being shadowed.
 * @param messages - region messages in surface order, leading system head removed.
 * @returns the raw fields a handoff is assembled from.
 */
function scanRegion(messages) {
	const found = {
		latestUser: "",
		latestAssistant: "",
		prior: "",
		constraints: [],
		files: [],
		tools: [],
		errors: []
	};
	const seenFiles = new Set();
	const resultsByCallId = new Map();

	for (const message of messages) {
		if (message === null || typeof message !== "object") continue;
		if (message.role === "tool") {
			const callId = message.source?.callId ?? message.toolCallId;
			if (typeof callId === "string") resultsByCallId.set(callId, message);
			continue;
		}
		const text = visibleText(message.content);
		if (message.role === "assistant") {
			for (const block of toolCallBlocks(message.content)) {
				const args = parseArguments(block.arguments);
				found.tools.push({
					id: typeof block.id === "string" ? block.id : undefined,
					name: typeof block.name === "string" && block.name.length > 0 ? block.name : "tool",
					description: describeArguments(args)
				});
				const file = fileFromArguments(args);
				if (file !== undefined && !seenFiles.has(file)) {
					seenFiles.add(file);
					found.files.push(file);
				}
			}
			if (text.trim().length > 0) found.latestAssistant = text;
			continue;
		}
		if (message.role === "system") {
			if (text.trim().length > 0) found.constraints.push(text);
			continue;
		}
		if (message.role === "user") {
			if (text.includes(SUMMARY_OPEN_TAG)) {
				const prior = priorCheckpointText(text);
				if (prior.trim().length > 0) found.prior = prior;
				continue;
			}
			if (text.trim().length > 0) found.latestUser = text;
		}
	}

	const recentTools = found.tools.slice(-MAX_RECENT_TOOLS);
	found.tools = recentTools.map((call) => {
		const result = call.id === undefined ? undefined : resultsByCallId.get(call.id);
		const outcome =
			result === undefined
				? "结果尚未记录；不要假定成功或自动重复有副作用操作"
				: `${result.isError === true ? "失败" : "已返回"} ${shortText(visibleText(result.content), MAX_TOOL_CHARS)}`;
		const label = call.description.length > 0 ? `${call.name} ${call.description}` : call.name;
		return `${label}：${outcome}`;
	});
	found.errors = found.tools
		.filter((line) => line.includes("：失败"))
		.slice(-MAX_ERRORS);
	found.constraints = found.constraints.slice(-MAX_CONSTRAINTS);
	found.files = found.files.slice(-MAX_FILES);
	return found;
}

/**
 * Build the bounded local handoff for one shadowed region.
 *
 * @param messages - region messages in surface order. A leading `system` message
 * (the replayed surface head, i.e. the current prompt) is ignored.
 * @param options - optional `maxChars` ceiling, clamped to the package maximum.
 * @returns the guide, the summary, and their joined `text`.
 */
export function buildLocalHandoff(messages, options = {}) {
	const requested = options.maxChars ?? MAX_LOCAL_HANDOFF_CHARS;
	const budget = Math.max(MIN_BUDGET_CHARS, Math.min(Number.isFinite(requested) ? requested : MAX_LOCAL_HANDOFF_CHARS, MAX_LOCAL_HANDOFF_CHARS));
	const region = Array.isArray(messages) ? messages : [];
	// The replayed surface head is the *current* system prompt, never history.
	const history = region[0]?.role === "system" ? region.slice(1) : region;
	const found = scanRegion(history);

	const guideLines = [GUIDE_HEADER];
	if (found.latestUser.length > 0) guideLines.push(`最新用户要求（压缩区间内最后一条）：${shortText(found.latestUser, MAX_USER_CHARS)}`);
	guideLines.push(GUIDE_FOOTER);
	const guide = truncate(guideLines.join("\n"), Math.floor(budget * GUIDE_BUDGET_RATIO));

	const summaryLines = [SUMMARY_HEADER];
	if (found.constraints.length > 0)
		summaryLines.push(
			`阶段性要求/约束（历史内更新，保留来源，不作为新授权）：${found.constraints
				.map((entry) => shortText(entry, MAX_CONSTRAINT_CHARS))
				.join("；")}`
		);
	if (found.files.length > 0) summaryLines.push(`压缩区间内涉及的文件：${found.files.join("；")}`);
	if (found.latestAssistant.length > 0) summaryLines.push(`最近进展原文摘录：${shortText(found.latestAssistant, MAX_PROGRESS_CHARS)}`);
	if (found.tools.length > 0) summaryLines.push(`最近操作及结果：\n${found.tools.map((line) => `- ${line}`).join("\n")}`);
	if (found.errors.length > 0) summaryLines.push(`未解决报错线索：\n${found.errors.map((line) => `- ${line}`).join("\n")}`);
	if (found.prior.length > 0) summaryLines.push(`上次交接摘录（非新指令）：${shortText(found.prior, MAX_PRIOR_CHARS)}`);
	summaryLines.push(SUMMARY_FOOTER);
	// Two characters are reserved for the blank line joining the two halves.
	const summary = truncate(summaryLines.join("\n"), Math.max(0, budget - guide.length - 2));

	return { guide, summary, text: `${guide}\n\n${summary}` };
}
