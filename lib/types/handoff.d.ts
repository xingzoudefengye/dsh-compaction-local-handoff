/** Content blocks, as far as local handoff construction cares about them. */
export interface ContentBlock {
	readonly type?: string;
	readonly text?: string;
}

/** One message of the region being compacted. */
export interface HandoffMessage {
	readonly role?: string;
	readonly content?: string | readonly ContentBlock[] | undefined;
	readonly source?: { readonly callId?: string };
	readonly toolCallId?: string;
	readonly isError?: boolean;
}

/** Hard ceiling for the assembled handoff text, in characters. */
export declare const MAX_LOCAL_HANDOFF_CHARS: number;

/** Concatenate the text blocks of one message content value. */
export declare function visibleText(content: string | readonly ContentBlock[] | undefined): string;

/** Redact, collapse, and cut one field to a character budget. */
export declare function shortText(text: unknown, limit: number): string;

/**
 * Build the bounded local handoff for one shadowed region.
 * A leading `system` message (the replayed surface head) is ignored.
 */
export declare function buildLocalHandoff(
	messages: readonly HandoffMessage[] | undefined,
	options?: { maxChars?: number }
): { guide: string; summary: string; text: string };
