import type { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import type { HandoffMessage } from "./handoff.js";

/** Provider recorded on the checkpoint record; no model produced it. */
export declare const LOCAL_PROVIDER: "local";
/** Model recorded on the checkpoint record; no model produced it. */
export declare const LOCAL_MODEL: "local-handoff";

/**
 * Compaction backend whose summarizer never calls a model. Every other
 * compaction behaviour is inherited unchanged.
 */
export declare class LocalHandoffCompactionEngine extends BasicCompactionEngine {
	static inject: string[];
	static Config: typeof BasicCompactionEngine.Config;
	summarize(
		input: { messages?: readonly HandoffMessage[]; tools?: readonly unknown[] },
		agent?: unknown,
		signal?: AbortSignal
	): Promise<{
		summary: { type: "text"; text: string }[];
		provider: string;
		model: string;
	}>;
}

export default LocalHandoffCompactionEngine;
