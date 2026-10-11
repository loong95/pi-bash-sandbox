/**
 * Shared fixtures for the unit tests.
 *
 * `makeResolvedConfig` fills in every field of `ResolvedSandboxConfig` so a
 * test only has to name the fields it cares about. Keeping this in one place
 * means adding a field to the resolved type does not break four test files.
 */

import { realpathSync } from "node:fs";
import type { ConfigSources, ResolvedGitGuard, ResolvedSandboxConfig } from "../src/types.ts";

export const NO_GIT_GUARD: ResolvedGitGuard = {
	detected: false,
	active: false,
	commonDir: null,
	gitDir: null,
	readOnly: [],
};

export function makeSources(overrides: Partial<ConfigSources> = {}): ConfigSources {
	return {
		globalPath: "/global/sandbox.json",
		projectPath: null,
		projectTrusted: false,
		warnings: [],
		...overrides,
	};
}

export function makeResolvedConfig(
	overrides: Partial<ResolvedSandboxConfig> = {},
): ResolvedSandboxConfig {
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
		gitGuard: NO_GIT_GUARD,
		tools: { enabled: true, requireAllowWrite: true },
		sources: makeSources(),
		...overrides,
	};
}

export function realDir(): string {
	return realpathSync(process.cwd());
}
