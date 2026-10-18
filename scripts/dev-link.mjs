#!/usr/bin/env node
/**
 * Link the installed DeepSeek Harness peer package into this checkout so
 * `npm test` can exercise the real base class.
 *
 * Cross-platform port of the former `scripts/dev-link.sh`. Windows has neither
 * bash nor an unprivileged POSIX `ln -s`, so this uses Node's filesystem API and
 * a directory junction on win32; macOS and Linux get an ordinary directory
 * symlink.
 *
 * Not needed to install the plugin into a profile: the profile already provides
 * the peer, and Node resolves it from the profile's own node_modules.
 *
 * Usage:
 *   node scripts/dev-link.mjs [directory-containing-dsh-compaction-basic]
 *
 * Environment:
 *   DSH_PACKAGE_DIR  same as the positional argument
 *   DSH_HOME         DSH home to resolve the peer from (default ~/.dsh)
 *   PATH / PATHEXT   used to locate the `dsh` install when no directory is given
 */
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { candidatesFromBin, which } from "./sync-presets.mjs";

/** This checkout. */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Where the peer must appear for `lib/index.js` to resolve it. */
const target = join(root, "node_modules", "@deepseek-ai", "dsh-compaction-basic");
const PEER = "dsh-compaction-basic";
const PKG = `@deepseek-ai/${PEER}`;

/** Whether `path` exists and is a directory (following links). */
function isDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Resolve a module request from `baseDir`, returning undefined instead of throwing. */
function tryResolve(request, baseDir) {
	try {
		return createRequire(join(baseDir, "package.json")).resolve(request);
	} catch {
		return undefined;
	}
}

/** The peer package directory when `dir` is a directory that contains it. */
function peerUnder(dir) {
	const peer = join(dir, PEER);
	if (isDirectory(peer)) return peer;
	// Also accept the peer package directory itself as the argument.
	try {
		const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		if (manifest.name === PKG) return dir;
	} catch {
		// Not a package directory.
	}
	return undefined;
}

/** Peer resolved next to the `dsh` executable on PATH, shim-aware. */
function peerFromDshBin() {
	const dshBin = which("dsh");
	if (dshBin === undefined) return undefined;
	let real = dshBin;
	try {
		real = realpathSync(dshBin);
	} catch {
		// Keep the unresolved path; candidates are still worth trying.
	}
	for (const pkgDir of candidatesFromBin(real)) {
		for (const parent of [join(pkgDir, "node_modules", "@deepseek-ai"), dirname(pkgDir)]) {
			const peer = peerUnder(parent);
			if (peer !== undefined) return peer;
		}
	}
	// Last resort: let Node search upward from the bin directory itself.
	const resolved = tryResolve(`${PKG}/package.json`, dirname(real));
	return resolved === undefined ? undefined : dirname(resolved);
}

/** Peer resolvable from this checkout, DSH_HOME, or an initialized profile. */
function peerFromModules() {
	const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const bases = [root, dshHome];
	try {
		const profiles = join(dshHome, "profiles");
		for (const name of readdirSync(profiles)) bases.push(join(profiles, name));
	} catch {
		// No profiles directory yet.
	}
	for (const base of bases) {
		const resolved = tryResolve(`${PKG}/package.json`, base);
		if (resolved !== undefined) return dirname(resolved);
	}
	return undefined;
}

/** Resolve the peer package directory, or throw with the paths that were tried. */
function resolvePeer() {
	const explicit = process.argv[2] ?? process.env.DSH_PACKAGE_DIR;
	if (explicit !== undefined && explicit.length > 0) {
		const peer = peerUnder(explicit);
		if (peer === undefined) {
			throw new Error(`no ${PEER} under '${explicit}'; pass the directory that contains the peer package`);
		}
		return peer;
	}
	const found = peerFromDshBin() ?? peerFromModules();
	if (found === undefined) {
		throw new Error(
			`could not find ${PKG}. Install DSH so 'dsh' is on PATH, or pass the directory that contains ${PEER} (DSH_PACKAGE_DIR)`
		);
	}
	return found;
}

/** Create (or replace) the link inside this checkout's node_modules. */
function link(peer) {
	let real = peer;
	try {
		real = realpathSync(peer);
	} catch {
		real = resolve(peer);
	}
	mkdirSync(dirname(target), { recursive: true });

	let existing;
	try {
		existing = lstatSync(target);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (existing !== undefined) {
		if (!existing.isSymbolicLink()) {
			throw new Error(`refusing to replace '${target}': it is a real directory, not a link`);
		}
		// Removes the link itself; the linked package is untouched.
		rmSync(target, { force: true });
	}

	// A junction needs no administrator privilege or Developer Mode on Windows.
	symlinkSync(real, target, process.platform === "win32" ? "junction" : "dir");
	console.log(`dev-link: linked ${real}`);
	console.log("dev-link: run 'npm test' to exercise the real engine");
}

try {
	link(resolvePeer());
} catch (error) {
	console.error(`dev-link: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
