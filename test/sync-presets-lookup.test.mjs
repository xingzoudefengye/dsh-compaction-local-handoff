import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildOutput,
	candidatesFromBin,
	normalizeNewlines,
	shippedPresetsDir,
	which
} from "../scripts/sync-presets.mjs";

// 最小 manifest：满足 readShippedManifest 的 `- insert:` 包装、presetOrder 的
// 4 空格 order 行、swapCompaction 的 10 空格两行形状。
function writeManifest(presetsDir, file = "standard.patch.yml") {
	mkdirSync(presetsDir, { recursive: true });
	writeFileSync(
		join(presetsDir, file),
		[
			"- insert:",
			"    - id: preset-standard",
			"        order: 1",
			"              - id: compaction-basic",
			"                name: '@deepseek-ai/dsh-compaction-basic'",
			""
		].join("\n")
	);
	return presetsDir;
}

function scratch() {
	return mkdtempSync(join(tmpdir(), "sync-presets-"));
}

function nestedPresets(pkgDir) {
	return writeManifest(join(pkgDir, "node_modules", "@deepseek-ai", "dsh-web-app", "presets"));
}

test("win32 下扩展名为空的 npm shim 能被 which 找到", () => {
	const bin = scratch();
	writeFileSync(join(bin, "dsh"), "#!/bin/sh\nexit 0\n");
	writeFileSync(join(bin, "dsh.cmd"), "@ECHO off\n");
	const opts = { platform: "win32", pathEnv: bin, pathextEnv: ".COM;.EXE;.BAT;.CMD" };
	assert.equal(which("dsh", opts), join(bin, "dsh"));
});

test("win32 下只有 dsh.cmd 时 PATHEXT 能兜住，posix 下找不到", () => {
	const bin = scratch();
	writeFileSync(join(bin, "dsh.cmd"), "@ECHO off\n");
	assert.equal(
		which("dsh", { platform: "win32", pathEnv: bin, pathextEnv: ".COM;.EXE;.BAT;.CMD" }),
		join(bin, "dsh.cmd")
	);
	assert.equal(which("dsh", { platform: "linux", pathEnv: bin }), undefined);
});

test("win32 npm 全局布局：从 shim 所在 bin 目录找到嵌套安装的 presets", () => {
	const bin = scratch();
	writeFileSync(join(bin, "dsh"), "#!/bin/sh\nexit 0\n");
	const dshPkg = join(bin, "node_modules", "@deepseek-ai", "dsh");
	const expected = nestedPresets(dshPkg);
	const found = shippedPresetsDir({
		platform: "win32",
		pathEnv: bin,
		pathextEnv: ".COM;.EXE;.BAT;.CMD",
		dshHome: join(scratch(), "no-home")
	});
	assert.equal(found, expected);
});

test("mac/linux 真实 bin.js：向上两级即包根，嵌套 presets 可用", () => {
	const pkg = join(scratch(), "dsh");
	const expected = nestedPresets(pkg);
	const found = shippedPresetsDir({
		platform: "darwin",
		dshBin: join(pkg, "lib", "bin.js"),
		dshHome: join(scratch(), "no-home")
	});
	assert.equal(found, expected);
});

test("mac/linux 全局布局：bin 目录叫 bin 时回退到 ../lib/node_modules", () => {
	const prefix = scratch();
	const dshPkg = join(prefix, "lib", "node_modules", "@deepseek-ai", "dsh");
	const expected = nestedPresets(dshPkg);
	const [nested, mono] = candidatesFromBin(join(prefix, "bin", "dsh"), { platform: "darwin" });
	assert.equal(nested, join(prefix, "bin", "node_modules", "@deepseek-ai", "dsh"));
	assert.equal(mono, dshPkg);
	const found = shippedPresetsDir({
		platform: "darwin",
		dshBin: join(prefix, "bin", "dsh"),
		dshHome: join(scratch(), "no-home")
	});
	assert.equal(found, expected);
});

test("monorepo 检出布局：包根的 ../dsh-web-app/presets 可用", () => {
	const mono = scratch();
	const pkg = join(mono, "packages", "dsh-mock");
	const expected = writeManifest(join(mono, "packages", "dsh-web-app", "presets"));
	const found = shippedPresetsDir({
		platform: "darwin",
		dshBin: join(pkg, "lib", "bin.js"),
		dshHome: join(scratch(), "no-home")
	});
	assert.equal(found, expected);
});

test("哪里都找不到时报错并提示 --presets-dir", () => {
	const empty = scratch();
	assert.throws(
		() =>
			shippedPresetsDir({
				platform: "win32",
				pathEnv: empty,
				pathextEnv: ".COM;.EXE;.BAT;.CMD",
				dshHome: join(empty, "no-home")
			}),
		/--presets-dir/
	);
});

test("buildOutput 把后端换成 local-handoff 并保留 preset 顺序信息", () => {
	const { output, presets } = buildOutput(writeManifest(join(scratch(), "presets")));
	assert.equal(presets.length, 1);
	assert.equal(presets[0].presetId, "preset-standard");
	assert.ok(output.includes("- id: compaction-local-handoff"));
	assert.ok(output.includes("name: 'dsh-compaction-local-handoff'"));
	assert.ok(!output.includes("          - id: compaction-basic"));
});

test("CRLF 检出不算过期：归一化后与生成器输出一致", () => {
	const { output } = buildOutput(writeManifest(join(scratch(), "presets")));
	assert.equal(normalizeNewlines(output.replace(/\n/g, "\r\n")), output);
	assert.equal(normalizeNewlines("a\r\nb\nc\r\n"), "a\nb\nc\n");
});
