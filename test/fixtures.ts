/**
 * Shared fixtures for the unit tests.
 *
 * `makeResolvedConfig` fills in every field of `ResolvedSandboxConfig` so a
 * test only has to name the fields it cares about. Keeping this in one place
 * means adding a field to the resolved type does not break four test files.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { GitLayout } from "../src/project.ts";
import type {
	ConfigSources,
	PathVariables,
	ResolvedGitGuard,
	ResolvedSandboxConfig,
} from "../src/types.ts";

export interface WorktreeRepo {
	root: string;
	main: string;
	worktree: string;
}

/**
 * Create a real repo with one linked worktree under `baseDir`.
 *
 * The base directory matters: integration tests must stay outside `/tmp`,
 * because the default `tmp: "private"` would hide a repo created under it.
 * The git layout is returned in both raw and derived forms so a caller can
 * use whichever it needs.
 */
export function createWorktreeRepo(baseDir: string, options: { prefix?: string } = {}): WorktreeRepo {
	const root = realpathSync(mkdtempSync(join(baseDir, options.prefix ?? "repo-")));
	const main = join(root, "main");
	mkdirSync(main, { recursive: true });

	const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
	git(main, "init", "-q");
	git(main, "config", "user.email", "test@example.com");
	git(main, "config", "user.name", "test");
	git(main, "commit", "-q", "--allow-empty", "-m", "init");

	const worktree = join(root, "feature");
	git(main, "worktree", "add", "-q", worktree, "-b", "feature");
	return { root, main: realpathSync(main), worktree: realpathSync(worktree) };
}

/**
 * Derive a `GitLayout` for a repo made by `createWorktreeRepo`, as git would
 * report it. Used by unit tests that need a layout without running git.
 */
export function gitLayoutFor(repo: WorktreeRepo): GitLayout {
	const commonDir = realpathSync(join(repo.main, ".git"));
	return {
		commonDir,
		gitDir: realpathSync(join(commonDir, "worktrees", "feature")),
		mainCheckout: repo.main,
		worktrees: [repo.main, repo.worktree],
		siblingGitDirs: [],
		hooksDirs: [join(commonDir, "hooks")],
		worktreeConfigEnabled: false,
	};
}

export const NO_GIT_GUARD: ResolvedGitGuard = {
	detected: false,
	active: false,
	commonDir: null,
	gitDir: null,
	writable: [],
	readOnly: [],
	blockCreate: [],
};

export function makeVariables(input: Partial<PathVariables> = {}): PathVariables {
	const repo = input.repo ?? "/repo";
	const worktree = input.worktree ?? repo;
	return { repo, worktree, worktrees: input.worktrees ?? [worktree] };
}

export function makeSources(overrides: Partial<ConfigSources> = {}): ConfigSources {
	const projectRoot = overrides.projectRoot ?? "/repo";
	const worktreeRoot = overrides.worktreeRoot ?? projectRoot;
	return {
		globalPath: "/global/sandbox.json",
		projectPath: null,
		projectTrusted: false,
		warnings: [],
		projectRoot,
		worktreeRoot,
		...overrides,
	};
}

export function makeResolvedConfig(
	overrides: Partial<ResolvedSandboxConfig> = {},
): ResolvedSandboxConfig {
	const sources = overrides.sources ?? makeSources();
	return {
		enabled: true,
		network: "none",
		allowWrite: [],
		denyWrite: [],
		denyRead: [],
		tmp: "private",
		env: { passthrough: [], deny: [], set: {} },
		unsharePid: true,
		weakerNestedSandbox: false,
		onUnavailable: "error",
		extraBwrapArgs: [],
		rules: { allowWrite: [], denyWrite: [], denyRead: [] },
		denyCreate: [],
		variables: makeVariables({ repo: sources.projectRoot, worktree: sources.worktreeRoot }),
		gitGuard: NO_GIT_GUARD,
		tools: { enabled: true, requireAllowWrite: true },
		sources,
		...overrides,
	};
}
