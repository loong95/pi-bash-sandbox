/**
 * Resolve a command cwd to its project root and current worktree toplevel.
 *
 * Linked worktrees report a shared `--git-common-dir`; the parent of that
 * directory is the main checkout (`projectRoot`). The current worktree's
 * `--show-toplevel` is kept separately so config can prefer a worktree-local
 * `.pi/sandbox.json` and fall back to the main checkout (decision O3).
 */

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProjectInfo {
	/** Directory the command was requested in. */
	cwd: string;
	/** Main checkout root (parent of the shared `.git`), or `cwd` when not a git repo. */
	projectRoot: string;
	/** Toplevel of the current worktree, or `cwd` when not a git repo. */
	worktreeRoot: string;
	/** True when `worktreeRoot !== projectRoot`. */
	isWorktree: boolean;
}

export interface ResolveProjectOptions {
	/** Cache TTL in ms. Default 60s. */
	ttlMs?: number;
	now?: () => number;
	/** Injectable git runner for tests. */
	runGit?: (cwd: string) => Promise<string>;
}

function safeRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * Parse `git rev-parse --path-format=absolute --git-common-dir --show-toplevel`.
 * Pure: returns null when the output does not contain both lines.
 */
export function parseProjectInfo(cwd: string, stdout: string): ProjectInfo | null {
	const lines = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length < 2) return null;

	const [gitCommonDir, toplevel] = lines;
	const projectRoot = safeRealpath(dirname(gitCommonDir));
	const worktreeRoot = safeRealpath(toplevel);
	return { cwd, projectRoot, worktreeRoot, isWorktree: worktreeRoot !== projectRoot };
}

/** Non-git fallback: the directory itself is the project. */
export function fallbackProjectInfo(cwd: string): ProjectInfo {
	const root = safeRealpath(cwd);
	return { cwd, projectRoot: root, worktreeRoot: root, isWorktree: false };
}

const cache = new Map<string, { info: ProjectInfo; expires: number }>();

export function clearProjectCache(): void {
	cache.clear();
}

async function defaultRunGit(cwd: string): Promise<string> {
	const { stdout } = await execFileAsync(
		"git",
		["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
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
		info = parseProjectInfo(cwd, stdout) ?? fallbackProjectInfo(cwd);
	} catch {
		info = fallbackProjectInfo(cwd);
	}

	cache.set(cwd, { info, expires: now() + ttlMs });
	return info;
}
