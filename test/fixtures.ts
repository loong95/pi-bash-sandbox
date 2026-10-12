/**
 * Shared fixtures for the unit tests.
 *
 * `makeResolvedConfig` fills in every field of `ResolvedSandboxConfig` so a
 * test only has to name the fields it cares about. Keeping this in one place
 * means adding a field to the resolved type does not break four test files.
 */

import type {
	ConfigSources,
	PathVariables,
	ResolvedGitGuard,
	ResolvedSandboxConfig,
} from "../src/types.ts";

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
