import assert from "node:assert/strict";
import test from "node:test";

// The engine module only loads when the real peer dependency resolves, so the
// suite still passes in a bare checkout; scripts/dev-link.mjs wires it up.
let plugin = null;
let base = null;
try {
	plugin = await import("../lib/index.js");
	base = await import("@deepseek-ai/dsh-compaction-basic");
} catch {
	plugin = null;
}

const skip = plugin === null ? "peer dependency @deepseek-ai/dsh-compaction-basic is not resolvable" : false;

test("subclasses the published engine without redeclaring its policy", { skip }, () => {
	const { LocalHandoffCompactionEngine, LOCAL_MODEL, LOCAL_PROVIDER } = plugin;
	assert.ok(LocalHandoffCompactionEngine.prototype instanceof base.BasicCompactionEngine);
	assert.deepEqual(LocalHandoffCompactionEngine.inject, ["llm", "tokenMeter", "sessions"]);
	assert.equal(LocalHandoffCompactionEngine.Config, base.BasicCompactionEngine.Config);
	assert.equal(LOCAL_PROVIDER, "local");
	assert.equal(LOCAL_MODEL, "local-handoff");
});

test("returns the summary blocks and provider record the backend expects", { skip }, async () => {
	const { LocalHandoffCompactionEngine, LOCAL_MODEL, LOCAL_PROVIDER } = plugin;
	// Only `summarize()` is exercised, so a prototype-only instance avoids
	// needing a cordis Context.
	const engine = Object.create(LocalHandoffCompactionEngine.prototype);
	const input = {
		tools: [{ name: "Read" }],
		messages: [
			{ role: "system", content: [{ type: "text", text: "You are a coding agent." }] },
			{ role: "user", content: [{ type: "text", text: "把 timeout 改成 30 秒。" }] },
			{
				role: "assistant",
				content: [{ type: "tool-call", id: "c1", name: "Read", arguments: '{"file_path":"/repo/src/config.ts"}' }]
			},
			{
				role: "tool",
				source: { kind: "tool", callId: "c1" },
				content: [{ type: "text", text: "export const timeoutMs = 5000;" }],
				isError: false
			}
		]
	};

	const out = await engine.summarize(input, undefined, undefined);

	assert.equal(out.provider, LOCAL_PROVIDER);
	assert.equal(out.model, LOCAL_MODEL);
	assert.ok(Array.isArray(out.summary));
	assert.equal(out.summary.length, 1);
	assert.equal(out.summary[0].type, "text");
	assert.match(out.summary[0].text, /把 timeout 改成 30 秒/);
	assert.match(out.summary[0].text, /\/repo\/src\/config\.ts/);
	assert.ok(!out.summary[0].text.includes("You are a coding agent"), "the replayed system head is not history");
});

test("propagates cancellation before doing any work", { skip }, async () => {
	const { LocalHandoffCompactionEngine } = plugin;
	const engine = Object.create(LocalHandoffCompactionEngine.prototype);
	const signal = AbortSignal.abort(new Error("cancelled by test"));

	await assert.rejects(() => engine.summarize({ messages: [] }, undefined, signal), /cancelled by test/);
});

test("sizes the handoff from shadowed history, not the replayed system head", { skip }, async () => {
	const { LocalHandoffCompactionEngine } = plugin;
	const engine = Object.create(LocalHandoffCompactionEngine.prototype);
	// The replayed head is the current prompt: it is never shadowed, so it must not
	// buy the handoff a bigger budget than the span it replaces.
	const head = { role: "system", content: [{ type: "text", text: "S".repeat(50_000) }] };
	const region = [];
	for (let index = 0; index < 8; index += 1)
		region.push({ role: "user", content: [{ type: "text", text: `段落 ${index} `.repeat(60) }], source: { kind: "user" } });

	const out = await engine.summarize({ messages: [head, ...region] }, undefined, undefined);
	const text = out.summary[0].text;

	assert.ok(text.length <= 2_000, `handoff was ${text.length} characters for a ~2,400-character span`);
	assert.match(text, /段落 7/);
});

test("includes the chronicle service's text when the recall bundle is installed", { skip }, async () => {
	const { LocalHandoffCompactionEngine } = plugin;
	const engine = Object.create(LocalHandoffCompactionEngine.prototype);
	let requested = null;
	engine.ctx = {
		get: (name) =>
			name === "sessionChronicle"
				? {
						render: (session, options) => {
							requested = options;
							return "会话史书：\n- #1 09:00 回合完成；目标：建立基线；回复：基线已建立";
						}
					}
				: undefined
	};

	const out = await engine.summarize(
		{ messages: [{ role: "user", content: [{ type: "text", text: "继续。" }], source: { kind: "user" } }] },
		{ session: { snapshotEvents: () => [] } },
		undefined
	);

	assert.match(out.summary[0].text, /回合级史书/);
	assert.match(out.summary[0].text, /回复：基线已建立/);
	assert.ok(requested !== null && Number.isFinite(requested.maxChars), "the chronicle is asked for a bounded render");
});

test("an unavailable or failing chronicle never breaks compaction", { skip }, async () => {
	const { LocalHandoffCompactionEngine } = plugin;
	const input = { messages: [{ role: "user", content: [{ type: "text", text: "继续。" }], source: { kind: "user" } }] };

	for (const ctx of [
		undefined,
		{ get: () => undefined },
		{ get: () => ({ render: () => { throw new Error("chronicle exploded"); } }) },
		{ get: () => ({ render: () => 42 }) }
	]) {
		const engine = Object.create(LocalHandoffCompactionEngine.prototype);
		engine.ctx = ctx;
		const out = await engine.summarize(input, { session: {} }, undefined);
		assert.ok(out.summary[0].text.length > 0);
		assert.ok(!out.summary[0].text.includes("回合级史书"));
	}
});
