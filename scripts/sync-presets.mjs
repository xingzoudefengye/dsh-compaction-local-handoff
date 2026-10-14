#!/usr/bin/env node
/**
 * Regenerate `cordis.patch.yml` from a pristine profile dump.
 *
 * Why this exists: the compaction backend is mounted *twice* — once at the
 * profile root and once inside each agent preset's isolated `compaction` group.
 * The preset manifests are `config.plugins` data registered with
 * `@deepseek-ai/dsh-agent-preset-registry`, not loader rows, so the loader's
 * id-addressed patches cannot reach them: an id-targeted patch only descends
 * into rows that carry `group: true`, and a preset row does not.
 *
 * The registry documents the supported override: "A new preset or an override of
 * a shipped one is a bundle patch: an `insert` of a `@deepseek-ai/dsh-agent-preset`
 * row, or a patch keyed by that row's id." This script emits the second form, so
 * every preset that ships a compaction group keeps its own backend replaced.
 *
 * The preset manifests are copied verbatim except for the one swapped row, so
 * this file must be regenerated whenever a harness upgrade changes them:
 *
 *   npm run sync:presets           # rewrite cordis.patch.yml
 *   npm run check:presets          # fail when it is out of date
 *
 * Usage:
 *   node scripts/sync-presets.mjs [--profile web] [--from dump.yml] [--check]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "cordis.patch.yml");

/** The backend this bundle installs, and the row it replaces. */
const REPLACEMENT = ["compaction-local-handoff", "dsh-compaction-local-handoff"];
const REPLACED = ["compaction-basic", "@deepseek-ai/dsh-compaction-basic"];

const args = process.argv.slice(2);
const check = args.includes("--check");
const profile = valueOf("--profile") ?? "web";
const from = valueOf("--from");

function valueOf(flag) {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
}

/** Load the pristine composed tree, either from a file or a fresh dump. */
function loadDefaultConfig() {
	if (from !== undefined) return readFileSync(from, "utf8");
	return execFileSync("dsh", ["--profile", profile, "--dump-default-config"], { encoding: "utf8" });
}

/** Split one entry list into its top-level rows, preserving every line verbatim. */
function topLevelBlocks(lines) {
	const blocks = [];
	let current = null;
	for (const line of lines) {
		if (/^- /.test(line) || /^-[^\s]/.test(line)) {
			if (current !== null) blocks.push(current);
			current = [];
		}
		if (current !== null) current.push(line);
	}
	if (current !== null) blocks.push(current);
	return blocks;
}

/** Swap the replaced backend for this bundle's engine inside one preset block. */
function swapCompaction(lines, presetId) {
	const replacedAt = [];
	for (let index = 0; index < lines.length; index += 1) {
		if (lines[index] !== `          - id: ${REPLACED[0]}`) continue;
		if (lines[index + 1] !== `            name: '${REPLACED[1]}'`) {
			throw new Error(
				`${presetId}: the ${REPLACED[0]} row is not the expected two-line shape at line ${index + 1}; ` +
					"the upstream manifest changed and this generator must be updated"
			);
		}
		replacedAt.push(index);
	}
	if (replacedAt.length === 0) throw new Error(`${presetId}: no ${REPLACED[0]} row found`);
	if (replacedAt.length > 1) throw new Error(`${presetId}: ${replacedAt.length} ${REPLACED[0]} rows found, expected 1`);

	const at = replacedAt[0];
	return [...lines.slice(0, at), `          - id: ${REPLACEMENT[0]}`, `            name: '${REPLACEMENT[1]}'`, ...lines.slice(at + 2)];
}

const dump = loadDefaultConfig();
const blocks = topLevelBlocks(dump.split("\n"));

/** Preset rows that own a compaction group, in dump order. */
const presets = [];
for (const block of blocks) {
	const idLine = block[0] ?? "";
	if (!/^- id: preset-/.test(idLine)) continue;
	const presetId = idLine.slice("- id: ".length).trim();
	if (!block.some((line) => line === `          - id: ${REPLACED[0]}`)) continue;
	presets.push({ presetId, block: swapCompaction(block, presetId) });
}

if (presets.length === 0) throw new Error("no preset with a compaction group found in the dump");

const header = [
	"# GENERATED FILE -- do not edit by hand.",
	"#",
	"# Regenerate with `npm run sync:presets` after a harness upgrade changes the",
	"# shipped agent presets (`npm run check:presets` fails while this file is stale).",
	"# See scripts/sync-presets.mjs for why the presets must be restated.",
	"#",
	"# The profile root keeps a model-free backend too, which is what presets without",
	"# their own compaction group (for example `preset-minimal`) inherit.",
	"",
	"# Profile root: replace the model-backed summarizer.",
	"- id: compaction-basic",
	"  disabled: true",
	"",
	"- insert:",
	`    - id: ${REPLACEMENT[0]}`,
	`      name: '${REPLACEMENT[1]}'`
].join("\n");

const presetSection = [
	"",
	"# Agent presets: each one mounts its own isolated `compaction` group, so the",
	"# root swap above does not reach it. These rows replace the shipped preset",
	"# manifests verbatim, with only the compaction backend swapped.",
	...presets.flatMap(({ block }) => ["", ...block])
].join("\n");

const output = `${header}\n${presetSection}\n`;

if (check) {
	const current = readFileSync(target, "utf8");
	if (current !== output) {
		console.error("check:presets: cordis.patch.yml is out of date; run `npm run sync:presets`");
		process.exit(1);
	}
	console.log(`check:presets: up to date (${presets.length} preset overrides)`);
} else {
	writeFileSync(target, output);
	console.log(`sync:presets: wrote cordis.patch.yml with ${presets.length} preset overrides`);
	for (const { presetId } of presets) console.log(`  - ${presetId}`);
}
