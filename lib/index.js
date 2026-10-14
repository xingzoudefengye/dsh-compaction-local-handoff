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
import { MAX_LOCAL_HANDOFF_CHARS, buildLocalHandoff, visibleText } from "./handoff.js";

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
	 * @param _agent - unused; present for the inherited hook signature.
	 * @param signal - live turn cancellation signal.
	 * @returns text summary blocks plus the synthetic provider/model record.
	 */
	async summarize(input, _agent, signal) {
		signal?.throwIfAborted();
		const messages = Array.isArray(input?.messages) ? input.messages : [];
		const { text } = buildLocalHandoff(messages, { maxChars: handoffBudget(messages) });
		return {
			summary: [{ type: "text", text }],
			provider: LOCAL_PROVIDER,
			model: LOCAL_MODEL
		};
	}
}

/**
 * Keep the handoff smaller than the span it replaces.
 *
 * The backend prices both sides with the same fixed ~4-characters-per-token
 * heuristic and rejects a framed checkpoint that is not smaller than the
 * shadowed content, so a handoff of at most half the shadowed character volume
 * stays safely under that bar even after the backend's fixed preamble is added.
 * @param messages - messages being shadowed.
 * @returns the character budget for this compaction.
 */
function handoffBudget(messages) {
	let shadowedChars = 0;
	for (const message of messages) shadowedChars += visibleText(message?.content).length;
	return Math.min(MAX_LOCAL_HANDOFF_CHARS, Math.floor(shadowedChars / 2));
}

export default LocalHandoffCompactionEngine;
