/**
 * Resolve a command cwd to its project root, current worktree, and git layout.
 *
 * Linked worktrees report a shared `--git-common-dir`; the main checkout is the
 * first entry of `git worktree list`. The current worktree's `--show-toplevel`
 * is kept separately so config can prefer a worktree-local `.pi/sandbox.json`
 * and fall back to the main checkout (decision O3).
 *
 * `GitLayout` records everything the sandbox has to treat specially. Two
 * details are easy to get wrong and are called out below:
 *
 * - `hooksDirs` is a *list*. A relative `core.hooksPath` (the husky default,
 *   `.husky/_`) resolves against whichever cwd git runs in, so the host may
 *   execute a hook from a different directory than the one this command would
 *   resolve. Every candidate has to be guarded.
 * - `worktreeConfigEnabled` mirrors `extensions.worktreeConfig`. A per-worktree
 *   `config.worktree` is only read when that extension is on, which decides
 *   whether guarding a *missing* `config.worktree` is necessary.
 */

import { execFile } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Git plumbing paths for one checkout, shared and per-worktree. */
export interface GitLayout {
	/** Shared git dir (`--git-common-dir`). */
	commonDir: string;
	/** This checkout's private git dir (`--git-dir`); equals `commonDir` in the main checkout. */
	gitDir: string;
	/** Main checkout root (first `git worktree list` entry), or `dirname(commonDir)` as a fallback. */
	mainCheckout: string;
	/** Every worktree root from `git worktree list`, main checkout first. */
	worktrees: string[];
	/** Private git dirs of the *other* worktrees (children of `<commonDir>/worktrees`). */
	siblingGitDirs: string[];
	/**
	 * Every directory git may execute hooks from. For an absolute
	 * `core.hooksPath` that is one path; for a relative one it is one path per
	 * worktree, because the resolution depends on the cwd git runs in.
	 */
	hooksDirs: string[];
	/** True when `extensions.worktreeConfig` is on, so `config.worktree` is read. */
	worktreeConfigEnabled: boolean;
}

export interface ProjectInfo {
	/** Directory the command was requested in. */
	cwd: string;
	/** Main checkout root (parent of the shared `.git`), or `cwd` when not a git repo. */
	projectRoot: string;
	/** Toplevel of the current worktree, or `cwd` when not a git repo. */
	worktreeRoot: string;
	/** True when `worktreeRoot !== projectRoot`. */
	isWorktree: boolean;
	/** Git plumbing paths, or null outside a git repository. */
	git: GitLayout | null;
}

export interface ResolveProjectOptions {
	/** Cache TTL in ms. Default 60s. */
	ttlMs?: number;
	now?: () => number;
	/** Injectable git runner for tests. */
	runGit?: (cwd: string) => Promise<string>;
	/** Injectable `git worktree list` runner for tests. */
	runWorktrees?: (cwd: string) => Promise<string>;
	/** Injectable `git config --get-regexp` runner for tests. */
	runGitConfig?: (cwd: string) => Promise<string>;
}

function safeRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function expandTilde(path: string, home: string = homedir()): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

/**
 * Parse `git worktree list --porcelain -z` into worktree roots, main first.
 * Paths are NOT trimmed: a trailing space is a legal part of a directory name,
 * and trimming it would silently drop the worktree from the writable set.
 */
export function parseWorktreePaths(stdout: string): string[] {
	return stdout
		.split("\0")
		.filter((field) => field.startsWith("worktree "))
		.map((field) => safeRealpath(field.slice("worktree ".length)))
		.filter((path) => path.length > 0);
}

/** Parse the `git config --get-regexp` output used to discover git behaviour flags. */
export function parseGitConfigFlags(stdout: string): {
	hooksPath: string | null;
	worktreeConfigEnabled: boolean;
} {
	let hooksPath: string | null = null;
	let worktreeConfigEnabled = false;
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const space = trimmed.indexOf(" ");
		if (space === -1) continue;
		const key = trimmed.slice(0, space).toLowerCase();
		const value = trimmed.slice(space + 1).trim();
		if (key === "core.hookspath") hooksPath = value;
		else if (key === "extensions.worktreeconfig") worktreeConfigEnabled = value === "true";
	}
	return { hooksPath, worktreeConfigEnabled };
}

/** Every directory git may run hooks from, for the given raw `core.hooksPath`. */
function hooksCandidates(rawHooksPath: string | null, commonDir: string, worktrees: string[]): string[] {
	// The built-in location always applies when core.hooksPath is unset, and is
	// harmless to guard even when it is set.
	const candidates = [join(commonDir, "hooks")];
	if (rawHooksPath) {
		const expanded = expandTilde(rawHooksPath);
		if (isAbsolute(expanded)) candidates.push(expanded);
		else for (const worktree of worktrees) candidates.push(join(worktree, expanded));
	}
	return [...new Set(candidates)];
}

/** Every git dir under `<commonDir>/worktrees` except this checkout's own. */
function listSiblingGitDirs(commonDir: string, gitDir: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(join(commonDir, "worktrees"));
	} catch {
		return [];
	}
	return entries
		.map((name) => safeRealpath(join(commonDir, "worktrees", name)))
		.filter((path) => path !== gitDir);
}

/**
 * Parse `git rev-parse --path-format=absolute --git-common-dir --git-dir
 * --show-toplevel`, plus the worktree list and config flags. Pure: returns
 * null when the rev-parse output is incomplete.
 */
export function parseProjectInfo(
	cwd: string,
	stdout: string,
	worktreeStdout = "",
	configStdout = "",
): ProjectInfo | null {
	const lines = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length < 3) return null;

	const [commonDirRaw, gitDirRaw, toplevelRaw] = lines;
	const commonDir = safeRealpath(commonDirRaw);
	const gitDir = safeRealpath(gitDirRaw);
	const worktreeRoot = safeRealpath(toplevelRaw);

	// `git worktree list` is authoritative for the main checkout. Deriving it
	// from `dirname(commonDir)` breaks under `--separate-git-dir`, where the
	// common dir lives outside the checkout entirely.
	const worktrees = parseWorktreePaths(worktreeStdout);
	const projectRoot = worktrees[0] ?? safeRealpath(dirname(commonDir));
	const flags = parseGitConfigFlags(configStdout);

	return {
		cwd,
		projectRoot,
		worktreeRoot,
		isWorktree: worktreeRoot !== projectRoot,
		git: {
			commonDir,
			gitDir,
			mainCheckout: projectRoot,
			worktrees: worktrees.length > 0 ? worktrees : [worktreeRoot],
			siblingGitDirs: listSiblingGitDirs(commonDir, gitDir),
			hooksDirs: hooksCandidates(flags.hooksPath, commonDir, worktrees.length > 0 ? worktrees : [worktreeRoot]),
			worktreeConfigEnabled: flags.worktreeConfigEnabled,
		},
	};
}

/** Non-git fallback: the directory itself is the project. */
export function fallbackProjectInfo(cwd: string): ProjectInfo {
	const root = safeRealpath(cwd);
	return { cwd, projectRoot: root, worktreeRoot: root, isWorktree: false, git: null };
}

interface CacheEntry {
	info: ProjectInfo;
	expires: number;
	/**
	 * mtime of `<commonDir>/worktrees` when this entry was built. A worktree
	 * added or removed touches that directory, which is a far cheaper
	 * invalidation signal than re-running git on every command.
	 */
	worktreesStamp: string;
}

const cache = new Map<string, CacheEntry>();

export function clearProjectCache(): void {
	cache.clear();
}

/** Cheap freshness stamp for the worktree set; changes when one is added or removed. */
function worktreesStamp(commonDir: string): string {
	try {
		const stat = statSync(join(commonDir, "worktrees"));
		return `${stat.mtimeMs}:${stat.ino}`;
	} catch {
		return "none";
	}
}

async function defaultRunGit(cwd: string): Promise<string> {
	const { stdout } = await execFileAsync(
		"git",
		["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir", "--show-toplevel"],
		{ timeout: 5000 },
	);
	return stdout;
}

async function defaultRunWorktrees(cwd: string): Promise<string> {
	const { stdout } = await execFileAsync(
		"git",
		["-C", cwd, "worktree", "list", "--porcelain", "-z"],
		{ timeout: 5000 },
	);
	return stdout;
}

async function defaultRunGitConfig(cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["-C", cwd, "config", "--get-regexp", "^(core\\.hookspath|extensions\\.worktreeconfig)$"],
			{ timeout: 5000 },
		);
		return stdout;
	} catch {
		// Exit status 1 just means neither key is set.
		return "";
	}
}

export async function resolveProjectRoot(
	cwd: string,
	options: ResolveProjectOptions = {},
): Promise<ProjectInfo> {
	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? 60_000;

	const cached = cache.get(cwd);
	if (cached && cached.expires > now()) {
		// A new or removed worktree must be visible on the very next command, so
		// the TTL alone is not enough to trust the entry.
		if (!cached.info.git || cached.worktreesStamp === worktreesStamp(cached.info.git.commonDir)) {
			return cached.info;
		}
	}

	let info: ProjectInfo;
	try {
		const stdout = await (options.runGit ?? defaultRunGit)(cwd);
		let worktreeStdout = "";
		try {
			worktreeStdout = await (options.runWorktrees ?? defaultRunWorktrees)(cwd);
		} catch {
			// A bare or broken worktree listing is not fatal; git still works.
		}
		let configStdout = "";
		try {
			configStdout = await (options.runGitConfig ?? defaultRunGitConfig)(cwd);
		} catch {
			// Unreadable config just means no flags; guards fall back to defaults.
		}
		info = parseProjectInfo(cwd, stdout, worktreeStdout, configStdout) ?? fallbackProjectInfo(cwd);
	} catch {
		info = fallbackProjectInfo(cwd);
	}

	cache.set(cwd, {
		info,
		expires: now() + ttlMs,
		worktreesStamp: info.git ? worktreesStamp(info.git.commonDir) : "none",
	});
	return info;
}
