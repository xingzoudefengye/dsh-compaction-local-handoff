/**
 * Model-free compaction backend for DeepSeek Harness.
 *
 * `BasicCompactionEngine` owns the trigger policy (`thresholdRatio`), the
 * verbatim retention window (`retainRatio` / `retainTokens`), tool-pairing-safe
 * region selection, the log-recorded compaction transaction, the durable
 * concurrency lock, overflow recovery, and the `/compact` command. It exposes
 * exactly one extension point — `summarize()` — which this backend overrides to
 * assemble a bounded local handoff instead of paying for a summarization call.
 *
 * Nothing else about compaction changes: the threshold is still
 * `floor(min(W x 0.8, W - O - headroom))`, the recent tail is still kept
 * verbatim, and the checkpoint still replaces the oldest balanced span.
 *
 * @module dsh-compaction-local-handoff
 */
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import { MAX_CHRONICLE_CHARS, MAX_LOCAL_HANDOFF_CHARS, buildLocalHandoff, visibleText } from "./handoff.js";

/** Provider recorded on the checkpoint record; no model produced it. */
export const LOCAL_PROVIDER = "local";
/** Model recorded on the checkpoint record; no model produced it. */
export const LOCAL_MODEL = "local-handoff";

/**
 * Compaction backend whose summarizer never calls a model.
 *
 * The inherited `inject` list is restated so this row waits for exactly the same
 * services as the backend it replaces; `llm` is no longer used by `summarize()`
 * but keeps activation ordering identical.
 */
export class LocalHandoffCompactionEngine extends BasicCompactionEngine {
	static inject = ["llm", "tokenMeter", "sessions"];
	static Config = BasicCompactionEngine.Config;

	/**
	 * Assemble the replacement checkpoint locally.
	 * @param input - replayed conversation prefix; a leading `system` message is the
	 * current prompt and is never part of the handoff.
	 * @param agent - owner of the session, used to read the optional chronicle.
	 * @param signal - live turn cancellation signal.
	 * @returns text summary blocks plus the synthetic provider/model record.
	 */
	async summarize(input, agent, signal) {
		signal?.throwIfAborted();
		const messages = Array.isArray(input?.messages) ? input.messages : [];
		const { text } = buildLocalHandoff(messages, {
			maxChars: handoffBudget(messages),
			chronicle: sessionChronicleText(this.ctx, agent)
		});
		return {
			summary: [{ type: "text", text }],
			provider: LOCAL_PROVIDER,
			model: LOCAL_MODEL
		};
	}
}

/**
 * Read the optional session chronicle through the recall bundle's service.
 *
 * The service is deliberately optional: without it this backend behaves exactly
 * as before. A chronicle failure must never break a compaction, so it degrades
 * to no chronicle section instead of propagating.
 * @param ctx - the engine's context.
 * @param agent - owner of the session being compacted.
 * @returns bounded chronicle text, or `""` when unavailable.
 */
function sessionChronicleText(ctx, agent) {
	const service = ctx?.get?.("sessionChronicle");
	if (service === undefined || service === null || typeof service.render !== "function") return "";
	if (agent?.session === undefined) return "";
	try {
		const text = service.render(agent.session, { maxChars: MAX_CHRONICLE_CHARS });
		return typeof text === "string" ? text : "";
	} catch {
		return "";
	}
}

/**
 * Characters reserved for the backend's own checkpoint framing.
 *
 * The backend wraps whatever this hook returns in a fixed preamble plus
 * `<compacted-summary>` tags before pricing it, so the budget must leave room for
 * that wrapper. The exact wrapper is private to the backend; this is a
 * deliberately generous estimate of it.
 */
const FRAMING_ALLOWANCE_CHARS = 600;

/**
 * Keep the handoff smaller than the span it replaces.
 *
 * The backend prices both sides with the same fixed ~4-characters-per-token
 * heuristic and rejects a framed checkpoint that is not smaller than the
 * shadowed content, so half the shadowed character volume minus the framing
 * allowance stays under that bar.
 * @param messages - the replayed conversation prefix being condensed. A leading
 * `system` message is the current prompt, not shadowed history, and is excluded.
 * @returns the character budget for this compaction.
 */
function handoffBudget(messages) {
	const history = messages[0]?.role === "system" ? messages.slice(1) : messages;
	let shadowedChars = 0;
	for (const message of history) shadowedChars += visibleText(message?.content).length;
	const share = Math.floor(shadowedChars / 2) - FRAMING_ALLOWANCE_CHARS;
	return Math.min(MAX_LOCAL_HANDOFF_CHARS, share);
}

export default LocalHandoffCompactionEngine;
