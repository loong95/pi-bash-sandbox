/**
 * Resolve a command cwd to its project root, current worktree, and git layout.
 *
 * Linked worktrees report a shared `--git-common-dir`; the parent of that
 * directory is the main checkout (`projectRoot`). The current worktree's
 * `--show-toplevel` is kept separately so config can prefer a worktree-local
 * `.pi/sandbox.json` and fall back to the main checkout (decision O3).
 *
 * `GitLayout` additionally records the paths the sandbox has to treat
 * specially: the shared git dir (writable objects/refs, read-only config and
 * hooks), this checkout's private git dir, and every other worktree's private
 * git dir. See `buildGitLayer` in config.ts.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Git plumbing paths for one checkout, shared and per-worktree. */
export interface GitLayout {
	/** Shared git dir (`--git-common-dir`). */
	commonDir: string;
	/** This checkout's private git dir (`--git-dir`); equals `commonDir` in the main checkout. */
	gitDir: string;
	/** Effective hooks dir (`--git-path hooks`, honors `core.hooksPath`); null when missing. */
	hooksDir: string | null;
	/** Every worktree root from `git worktree list`, main checkout first. */
	worktrees: string[];
	/** Private git dirs of the *other* worktrees (children of `<commonDir>/worktrees`). */
	siblingGitDirs: string[];
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
}

function safeRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Parse `git worktree list --porcelain -z` into absolute worktree roots, main first. */
export function parseWorktreePaths(stdout: string): string[] {
	return stdout
		.split("\0")
		.join("\n")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("worktree "))
		.map((line) => safeRealpath(line.slice("worktree ".length).trim()));
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
 * --show-toplevel --git-path hooks` plus `git worktree list --porcelain -z`.
 * Pure: returns null when the rev-parse output is incomplete.
 */
export function parseProjectInfo(cwd: string, stdout: string, worktreeStdout = ""): ProjectInfo | null {
	const lines = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length < 3) return null;

	const [commonDirRaw, gitDirRaw, toplevelRaw, hooksDirRaw] = lines;
	const commonDir = safeRealpath(commonDirRaw);
	const gitDir = safeRealpath(gitDirRaw);
	const worktreeRoot = safeRealpath(toplevelRaw);
	const projectRoot = safeRealpath(dirname(commonDir));
	const hooksDirCandidate = hooksDirRaw ? safeRealpath(hooksDirRaw) : null;

	return {
		cwd,
		projectRoot,
		worktreeRoot,
		isWorktree: worktreeRoot !== projectRoot,
		git: {
			commonDir,
			gitDir,
			hooksDir: hooksDirCandidate && existsSync(hooksDirCandidate) ? hooksDirCandidate : null,
			worktrees: parseWorktreePaths(worktreeStdout),
			siblingGitDirs: listSiblingGitDirs(commonDir, gitDir),
		},
	};
}

/** Non-git fallback: the directory itself is the project. */
export function fallbackProjectInfo(cwd: string): ProjectInfo {
	const root = safeRealpath(cwd);
	return { cwd, projectRoot: root, worktreeRoot: root, isWorktree: false, git: null };
}

const cache = new Map<string, { info: ProjectInfo; expires: number }>();

export function clearProjectCache(): void {
	cache.clear();
}

async function defaultRunGit(cwd: string): Promise<string> {
	const { stdout } = await execFileAsync(
		"git",
		[
			"-C",
			cwd,
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
			"--git-dir",
			"--show-toplevel",
			"--git-path",
			"hooks",
		],
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

export async function resolveProjectRoot(
	cwd: string,
	options: ResolveProjectOptions = {},
): Promise<ProjectInfo> {
	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? 60_000;

	const cached = cache.get(cwd);
	if (cached && cached.expires > now()) return cached.info;

	let info: ProjectInfo;
	try {
		const stdout = await (options.runGit ?? defaultRunGit)(cwd);
		let worktreeStdout = "";
		try {
			worktreeStdout = await (options.runWorktrees ?? defaultRunWorktrees)(cwd);
		} catch {
			// A bare or broken worktree listing is not fatal; git still works.
		}
		info = parseProjectInfo(cwd, stdout, worktreeStdout) ?? fallbackProjectInfo(cwd);
	} catch {
		info = fallbackProjectInfo(cwd);
	}

	cache.set(cwd, { info, expires: now() + ttlMs });
	return info;
}
