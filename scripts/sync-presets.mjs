#!/usr/bin/env node
/**
 * Regenerate `cordis.patch.yml` from the shipped preset manifests.
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
 * The source of truth is `@deepseek-ai/dsh-web-app/presets/*.patch.yml` — the
 * files the harness actually ships. It is deliberately NOT
 * `dsh --dump-default-config`: this bundle is itself a bundle, so its own patch
 * is already applied by the time a dump is rendered. Reading the dump meant
 * reading this file's own output back, which made `check:presets` compare the
 * file against itself and fail forever with "no preset with a compaction group
 * found in the dump" — a drift guard that could never pass is worse than none,
 * because it looks like protection.
 *
 * The manifests are copied verbatim except for the one swapped row, so this file
 * must be regenerated whenever a harness upgrade changes them:
 *
 *   npm run sync:presets           # rewrite cordis.patch.yml
 *   npm run check:presets          # fail when it is out of date
 *
 * Usage:
 *   node scripts/sync-presets.mjs [--presets-dir <dir>] [--check]
 */
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "cordis.patch.yml");

/** The backend this bundle installs, and the row it replaces. */
const REPLACEMENT = ["compaction-local-handoff", "dsh-compaction-local-handoff"];
const REPLACED = ["compaction-basic", "@deepseek-ai/dsh-compaction-basic"];
/** How far a shipped manifest indents its preset row inside its `- insert:` wrapper. */
const MANIFEST_INDENT = 4;
/** Indentation of a preset's own rows in the generated (de-indented) form. */
const ROW_INDENT = " ".repeat(10);

const args = process.argv.slice(2);
const check = args.includes("--check");
const presetsDirArg = valueOf("--presets-dir");

function valueOf(flag) {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
}

/** First `name` executable on PATH, or undefined. Windows-aware: npm installs
 * `dsh`, `dsh.cmd` and `dsh.ps1` shims side by side, so PATHEXT matters.
 * `platform`/`pathEnv`/`pathextEnv` default to the live process and exist only
 * so tests can exercise both platforms from either one. */
export function which(name, opts = {}) {
	const platform = opts.platform ?? process.platform;
	const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
	const exts =
		platform === "win32"
			? ["", ...new Set((opts.pathextEnv ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase()))]
			: [""];
	for (const dir of pathEnv.split(delimiter)) {
		if (dir.length === 0) continue;
		for (const ext of exts) {
			const candidate = join(dir, name + ext);
			try {
				if (statSync(candidate).isFile()) return candidate;
			} catch {
				// keep looking
			}
		}
	}
	return undefined;
}

/** Whether `path` exists and is a directory. */
function existsDir(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Preset-dir candidates derived from one `@deepseek-ai/dsh` package directory:
 * the nested install (`<pkg>/node_modules/...`, what global npm/pnpm produce)
 * and the monorepo checkout (`<pkg>/../dsh-web-app`). */
export function candidatesFromDshPackage(pkgDir) {
	return [
		join(pkgDir, "node_modules", "@deepseek-ai", "dsh-web-app", "presets"),
		join(pkgDir, "..", "dsh-web-app", "presets")
	];
}

/** Try `require.resolve` starting from `baseDir`, returning undefined instead of
 * throwing. Used before touching PATH so a working module layout wins over any
 * shim guessing. */
function tryResolve(request, baseDir) {
	try {
		return createRequire(join(baseDir, "package.json")).resolve(request);
	} catch {
		return undefined;
	}
}

/** Collect candidate `@deepseek-ai/dsh` package dirs from `dshBin` (already
 * realpath'd). A real `bin.js` resolves two levels up; an npm shim
 * (extensionless shell script, `.cmd`, `.ps1`) lives in a bin dir whose
 * sibling `node_modules` holds the package — `<bindir>/../node_modules` on
 * Windows npm globals, `<bindir>/../lib/node_modules` when the bin dir is a
 * `bin` (mac/linux npm globals). */
export function candidatesFromBin(binPath, opts = {}) {
	const platform = opts.platform ?? process.platform;
	const ext = extname(binPath).toLowerCase();
	if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return [dirname(dirname(binPath))];
	const binDir = dirname(binPath);
	const out = [join(binDir, "node_modules", "@deepseek-ai", "dsh")];
	if (platform !== "win32" || /^bin$/i.test(binDir.split(/[/\\]/).pop() ?? "")) {
		out.push(join(dirname(binDir), "lib", "node_modules", "@deepseek-ai", "dsh"));
	}
	return out;
}

/** Directory holding the shipped preset manifests.
 * Order: explicit `--presets-dir`, Node resolution from this bundle and from
 * the profile runtime, then the `dsh` binary on PATH (shim-aware). Every
 * failed candidate is listed in the throw so a new layout is diagnosable. */
export function shippedPresetsDir(opts = {}) {
	const tried = [];
	const considerPresets = (dir) => {
		if (dir === undefined || tried.includes(dir)) return undefined;
		tried.push(dir);
		return existsDir(dir) ? dir : undefined;
	};
	const considerPackage = (pkgDir) => {
		if (pkgDir === undefined) return undefined;
		for (const candidate of candidatesFromDshPackage(pkgDir)) {
			const hit = considerPresets(candidate);
			if (hit !== undefined) return hit;
		}
		return undefined;
	};

	const dshHome = opts.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
	for (const base of [root, dshHome]) {
		const resolved = tryResolve("@deepseek-ai/dsh-web-app/package.json", base);
		if (resolved !== undefined) {
			const hit = considerPresets(join(dirname(resolved), "presets"));
			if (hit !== undefined) return hit;
		}
		const dshPkg = tryResolve("@deepseek-ai/dsh/package.json", base);
		if (dshPkg !== undefined) {
			const hit = considerPackage(dirname(dshPkg));
			if (hit !== undefined) return hit;
		}
	}

	const dshBin = opts.dshBin ?? which("dsh", opts);
	if (dshBin !== undefined) {
		let real = dshBin;
		try {
			real = realpathSync(dshBin);
		} catch {
			// keep the unresolved path; candidates are still worth trying
		}
		for (const pkgDir of candidatesFromBin(real, opts)) {
			const hit = considerPackage(pkgDir);
			if (hit !== undefined) return hit;
		}
		// Last resort: let Node search upward from the bin dir itself (covers
		// managers whose global node_modules sits above their bin dir).
		const dshPkg = tryResolve("@deepseek-ai/dsh/package.json", dirname(real));
		if (dshPkg !== undefined) {
			const hit = considerPackage(dirname(dshPkg));
			if (hit !== undefined) return hit;
		}
	}

	if (tried.length === 0) throw new Error("找不到 dsh 可执行文件；用 --presets-dir 指定官方 preset 目录");
	throw new Error(`找不到官方 preset 目录，试过：\n  ${tried.join("\n  ")}`);
}

/**
 * Read one shipped manifest and reshape it into the generated file's form.
 *
 * The `- insert:` wrapper drops away — the generated file emits the row as a
 * top-level id-keyed patch instead — and the body de-indents by
 * {@link MANIFEST_INDENT} to match the patch file's own indentation.
 *
 * @param presetsDir - directory holding the shipped `*.patch.yml` manifests.
 * @param file - manifest file name, e.g. `standard.patch.yml`.
 * @returns the preset block lines.
 */
export function readShippedManifest(presetsDir, file) {
	const lines = readFileSync(join(presetsDir, file), "utf8").split("\n");
	const start = lines.indexOf("- insert:");
	if (start === -1) throw new Error(`${file}: 没有 '- insert:' 包装层，上游 manifest 结构变了`);
	const body = lines.slice(start + 1);
	while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
	const pad = " ".repeat(MANIFEST_INDENT);
	return body.map((line) => (line.startsWith(pad) ? line.slice(MANIFEST_INDENT) : line));
}

/** The preset's declared order, so the generated file keeps the shipped order. */
function presetOrder(lines, presetId) {
	for (const line of lines) {
		const match = /^ {4}order: (\d+)$/.exec(line);
		if (match !== null) return Number(match[1]);
	}
	throw new Error(`${presetId}: 找不到 'order:' 行`);
}

/** Swap the replaced backend for this bundle's engine inside one preset block. */
function swapCompaction(lines, presetId) {
	const replacedAt = [];
	for (let index = 0; index < lines.length; index += 1) {
		if (lines[index] !== `${ROW_INDENT}- id: ${REPLACED[0]}`) continue;
		if (lines[index + 1] !== `${ROW_INDENT}  name: '${REPLACED[1]}'`) {
			throw new Error(
				`${presetId}: ${REPLACED[0]} 不是预期的两行形状（第 ${index + 1} 行）；` +
					"上游 manifest 变了，这个生成器要跟着改"
			);
		}
		replacedAt.push(index);
	}
	if (replacedAt.length === 0) throw new Error(`${presetId}: 找不到 ${REPLACED[0]} 行`);
	if (replacedAt.length > 1) throw new Error(`${presetId}: 找到 ${replacedAt.length} 个 ${REPLACED[0]} 行，预期 1 个`);

	const at = replacedAt[0];
	return [
		...lines.slice(0, at),
		`${ROW_INDENT}- id: ${REPLACEMENT[0]}`,
		`${ROW_INDENT}  name: '${REPLACEMENT[1]}'`,
		...lines.slice(at + 2)
	];
}

/** Preset overrides, in shipped order, for every preset that mounts a compaction group. */
export function collectPresets(presetsDir) {
	const presets = [];
	for (const file of readdirSync(presetsDir).filter((name) => name.endsWith(".patch.yml")).sort()) {
		const block = readShippedManifest(presetsDir, file);
		if (!block.includes(`${ROW_INDENT}- id: ${REPLACED[0]}`)) continue;
		const presetId = /^- id: (.+)$/.exec(block[0] ?? "")?.[1] ?? file.replace(/\.patch\.yml$/, "");
		presets.push({ presetId, order: presetOrder(block, presetId), block: swapCompaction(block, presetId) });
	}
	presets.sort((a, b) => a.order - b.order);

	if (presets.length === 0) throw new Error(`${presetsDir} 里没有任何带压缩组的 preset`);
	return presets;
}

/** Normalize checkout line endings (CRLF on Windows) to the LF the generator emits. */
export function normalizeNewlines(text) {
	return text.replace(/\r\n/g, "\n");
}

/** Render the generated patch file for the presets found in `presetsDir`. */
export function buildOutput(presetsDir) {
	const presets = collectPresets(presetsDir);
	const header = [
		"# GENERATED FILE -- do not edit by hand.",
		"#",
		"# Regenerate with `npm run sync:presets` after a harness upgrade changes the",
		"# shipped agent presets (`npm run check:presets` fails while this file is stale).",
		"# See scripts/sync-presets.mjs for why the presets must be restated.",
		"#",
		"# The profile root keeps a model-free backend too, which is what presets without",
		"# their own compaction group inherit.",
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

	return { output: `${header}\n${presetSection}\n`, presets };
}

function main() {
	const presetsDir = presetsDirArg ?? shippedPresetsDir();
	const { output, presets } = buildOutput(presetsDir);

	if (check) {
		// Windows 检出可能是 CRLF（core.autocrlf），官方 manifest 与生成器只用
		// LF：比较前归一化，换行符差异不算过期。
		const current = normalizeNewlines(readFileSync(target, "utf8"));
		if (current !== output) {
			const a = current.split("\n");
			const b = output.split("\n");
			const at = a.findIndex((line, index) => line !== b[index]);
			console.error("check:presets: cordis.patch.yml 已过期；跑 `npm run sync:presets` 重新生成。");
			console.error(`  第一处差异在第 ${at + 1} 行：`);
			console.error(`    本文件: ${JSON.stringify(a[at] ?? "<文件结束>")}`);
			console.error(`    官方版: ${JSON.stringify(b[at] ?? "<文件结束>")}`);
			process.exit(1);
		}
		console.log(`check:presets: 已是最新（${presets.length} 个 preset 覆盖，来源 ${presetsDir}）`);
	} else {
		writeFileSync(target, output);
		console.log(`sync:presets: 已写入 cordis.patch.yml（${presets.length} 个 preset 覆盖）`);
		for (const { presetId } of presets) console.log(`  - ${presetId}`);
	}
}

// Importing this module (e.g. from tests) must not regenerate anything.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
