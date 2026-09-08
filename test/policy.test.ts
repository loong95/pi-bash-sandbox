import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	evaluateToolCall,
	globToPathRegex,
	normalizeTarget,
	targetMatchesDenyRule,
	targetWithinRule,
} from "../src/policy.ts";
import type { ResolvedSandboxConfig } from "../src/types.ts";

const HOME = realpathSync(mkdtempSync(join(tmpdir(), "pibs-policy-")));
const PROJECT = join(HOME, "proj");
const SECRET_DIR = join(HOME, ".ssh");
mkdirSync(join(PROJECT, "sub"), { recursive: true });
mkdirSync(SECRET_DIR, { recursive: true });
writeFileSync(join(SECRET_DIR, "id_ed25519"), "key");
writeFileSync(join(PROJECT, ".env"), "A=1");

function makeConfig(overrides: Partial<ResolvedSandboxConfig> = {}): ResolvedSandboxConfig {
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
		rules: {
			allowWrite: [PROJECT, "/tmp"],
			denyWrite: [".env", ".env.*", "*.pem"],
			denyRead: [SECRET_DIR],
		},
		tools: { enabled: true, requireAllowWrite: true },
		sources: { globalPath: "/g", projectPath: null, projectTrusted: false, warnings: [] },
		...overrides,
	};
}

function decide(toolName: string, path: string, config = makeConfig()) {
	return evaluateToolCall({ toolName, path, cwd: PROJECT, config });
}

test("read is blocked inside a denyRead directory", () => {
	assert.equal(decide("read", join(SECRET_DIR, "id_ed25519")).block, true);
	assert.equal(decide("read", SECRET_DIR).block, true);
});

test("read is allowed elsewhere, including outside allowWrite", () => {
	assert.equal(decide("read", join(PROJECT, "sub", "file.txt")).block, false);
	assert.equal(decide("read", join(HOME, "notes.txt")).block, false);
});

test("read of a denyWrite-only file is still allowed", () => {
	assert.equal(decide("read", join(PROJECT, ".env")).block, false);
});

test("write is blocked on denyWrite basename globs, even for new files", () => {
	assert.equal(decide("write", join(PROJECT, ".env")).block, true);
	assert.equal(decide("write", join(PROJECT, ".env.production")).block, true);
	assert.equal(decide("write", join(PROJECT, "key.pem")).block, true);
});

test("write is blocked inside denyRead", () => {
	const decision = decide("write", join(SECRET_DIR, "injected"));
	assert.equal(decision.block, true);
	assert.match(decision.reason ?? "", /denyRead/);
});

test("write outside allowWrite is blocked by default", () => {
	const config = makeConfig({
		rules: { allowWrite: [PROJECT], denyWrite: [".env", ".env.*", "*.pem"], denyRead: [SECRET_DIR] },
	});
	const decision = decide("write", join(HOME, "outside.txt"), config);
	assert.equal(decision.block, true);
	assert.match(decision.reason ?? "", /outside allowWrite/);
});

test("write inside allowWrite (project and /tmp) is allowed", () => {
	assert.equal(decide("write", join(PROJECT, "sub", "new.txt")).block, false);
	assert.equal(decide("write", join("/tmp", "scratch.txt")).block, false);
	assert.equal(decide("edit", join(PROJECT, "sub", "existing.ts")).block, false);
});

test("requireAllowWrite=false allows writes outside allowWrite (deny still wins)", () => {
	const config = makeConfig({
		rules: { allowWrite: [PROJECT], denyWrite: [".env", ".env.*", "*.pem"], denyRead: [SECRET_DIR] },
		tools: { enabled: true, requireAllowWrite: false },
	});
	assert.equal(decide("write", join(HOME, "outside.txt"), config).block, false);
	assert.equal(decide("write", join(SECRET_DIR, "x"), config).block, true);
});

test("tools.enabled=false disables all interception", () => {
	const config = makeConfig({ tools: { enabled: false, requireAllowWrite: true } });
	assert.equal(decide("read", join(SECRET_DIR, "id_ed25519"), config).block, false);
	assert.equal(decide("write", join(SECRET_DIR, "x"), config).block, false);
});

test("non file tools are ignored", () => {
	assert.equal(decide("bash", join(SECRET_DIR, "id_ed25519")).block, false);
	assert.equal(decide("grep", join(SECRET_DIR, "id_ed25519")).block, false);
});

test("globToPathRegex: * does not cross separators, ** does", () => {
	assert.equal(globToPathRegex("/a/*/c").test("/a/b/c"), true);
	assert.equal(globToPathRegex("/a/*/c").test("/a/b/x/c"), false);
	assert.equal(globToPathRegex("/a/**/c").test("/a/b/x/c"), true);
});

test("rule helpers: within vs deny semantics", () => {
	assert.equal(targetWithinRule(join(PROJECT, "a", "b"), PROJECT, PROJECT), true);
	assert.equal(targetWithinRule(join(HOME, "elsewhere"), PROJECT, PROJECT), false);
	assert.equal(targetMatchesDenyRule(join(PROJECT, "deep", ".env"), ".env", PROJECT), true);
	assert.equal(targetMatchesDenyRule(join(PROJECT, "a.pem"), "*.pem", PROJECT), true);
	assert.equal(targetMatchesDenyRule(join(PROJECT, "a.txt"), "*.pem", PROJECT), false);
});

test("normalizeTarget resolves symlinked parents for new files", () => {
	const target = normalizeTarget(join(PROJECT, "sub", "brand-new.txt"), PROJECT);
	assert.equal(target, join(PROJECT, "sub", "brand-new.txt"));
});
