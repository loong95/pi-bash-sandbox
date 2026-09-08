import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectInfo } from "../src/project.ts";
import type { BwrapCapabilities, ResolvedSandboxConfig } from "../src/types.ts";
import { formatArgv, formatPathExplanation, formatSandboxStatus, shellQuote } from "../src/ui.ts";

const PROJECT: ProjectInfo = {
	cwd: "/repo/wt",
	projectRoot: "/repo",
	worktreeRoot: "/repo/wt",
	isWorktree: true,
};

const CONFIG: ResolvedSandboxConfig = {
	enabled: true,
	network: "none",
	allowWrite: [{ path: "/repo/wt", isDir: true, rule: "." }],
	denyWrite: [{ path: "/repo/wt/.env", isDir: false, rule: ".env" }],
	denyRead: [],
	tmp: "private",
	env: { passthrough: ["PATH"], deny: ["*_TOKEN"], set: {} },
	unsharePid: true,
	weakerNestedSandbox: false,
	onUnavailable: "error",
	extraBwrapArgs: [],
	rules: { allowWrite: ["."], denyWrite: [".env"], denyRead: ["~/.ssh"] },
	tools: { enabled: true, requireAllowWrite: true },
	sources: {
		globalPath: "/home/u/.pi/agent/sandbox.json",
		projectPath: "/repo/wt/.pi/sandbox.json",
		projectTrusted: true,
		warnings: ["bogus: unknown key, ignoring"],
	},
};

const CAPS: BwrapCapabilities = { available: true, version: "0.9.0", userNamespace: true, procMount: true };

test("formatSandboxStatus reports the important fields", () => {
	const text = formatSandboxStatus({ enabled: true, project: PROJECT, config: CONFIG, capabilities: CAPS });
	assert.match(text, /bash sandbox: enabled/);
	assert.match(text, /project root: \/repo \(linked worktree\)/);
	assert.match(text, /worktree: \/repo\/wt/);
	assert.match(text, /bwrap: available v0\.9\.0/);
	assert.match(text, /network: none/);
	assert.match(text, /allowWrite: \/repo\/wt/);
	assert.match(text, /denyWrite: \/repo\/wt\/\.env/);
	assert.match(text, /warnings:/);
});

test("formatSandboxStatus flags unavailable bwrap and disabled state", () => {
	const text = formatSandboxStatus({
		enabled: false,
		project: { ...PROJECT, isWorktree: false },
		config: CONFIG,
		capabilities: { available: false, userNamespace: false, procMount: false, error: "not found" },
	});
	assert.match(text, /DISABLED/);
	assert.match(text, /bwrap: UNAVAILABLE/);
	assert.match(text, /note: not found/);
});

test("formatSandboxStatus surfaces extraBwrapArgs as risky", () => {
	const text = formatSandboxStatus({
		enabled: true,
		project: PROJECT,
		config: { ...CONFIG, extraBwrapArgs: ["--hostname", "x"] },
		capabilities: CAPS,
	});
	assert.match(text, /extraBwrapArgs \(RISK/);
});

test("shellQuote and formatArgv", () => {
	assert.equal(shellQuote("/bin/bash"), "/bin/bash");
	assert.equal(shellQuote("echo hi"), "'echo hi'");
	assert.equal(shellQuote("it's"), "'it'\\''s'");
	assert.equal(formatArgv(["bwrap", "--setenv", "K", "a b"]), "bwrap --setenv K 'a b'");
});

test("formatPathExplanation renders decisions and matched rules", () => {
	const text = formatPathExplanation({
		target: "/home/u/.ssh/id_ed25519",
		read: { block: true, reason: 'read blocked: "x" matches denyRead' },
		write: { block: true, reason: 'write blocked: "x" matches denyRead' },
		denyReadRules: ["~/.ssh"],
		denyWriteRules: [],
		allowWriteRules: [],
		bashReadHidden: true,
		bashWriteBlocked: true,
	});
	assert.match(text, /path: \/home\/u\/\.ssh\/id_ed25519/);
	assert.match(text, /read : BLOCKED/);
	assert.match(text, /write: BLOCKED/);
	assert.match(text, /bash : read hidden, write blocked/);
	assert.match(text, /denyRead\s+\u2190 ~\/\.ssh/);
});
