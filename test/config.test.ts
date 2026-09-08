import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	clearConfigCache,
	DEFAULT_CONFIG,
	expandTilde,
	getConfigPaths,
	loadSandboxConfig,
	mergeConfigLayers,
} from "../src/config.ts";

function tempDir(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "pibs-")));
}

function writeConfig(dir: string, config: unknown, subdir = ".pi"): string {
	mkdirSync(join(dir, subdir), { recursive: true });
	const path = join(dir, subdir, "sandbox.json");
	writeFileSync(path, JSON.stringify(config));
	return path;
}

// ---------------------------------------------------------------------------
// Pure merging
// ---------------------------------------------------------------------------

test("project layer overrides global arrays (not concatenated)", () => {
	const merged = mergeConfigLayers(
		DEFAULT_CONFIG,
		{ filesystem: { allowWrite: ["/global"] } },
		{ filesystem: { allowWrite: ["/project"] } },
	);
	assert.deepEqual(merged.filesystem?.allowWrite, ["/project"]);
});

test("global layer is used when project omits the field", () => {
	const merged = mergeConfigLayers(
		DEFAULT_CONFIG,
		{ filesystem: { allowWrite: ["/global"] } },
		{ network: "host" },
	);
	assert.deepEqual(merged.filesystem?.allowWrite, ["/global"]);
});

test("env.set merges per key across layers", () => {
	const merged = mergeConfigLayers(
		{ ...DEFAULT_CONFIG, env: { ...DEFAULT_CONFIG.env, set: { A: "1", B: "1" } } },
		{ env: { set: { B: "2", C: "2" } } },
		{ env: { set: { C: "3" } } },
	);
	assert.deepEqual(merged.env?.set, { A: "1", B: "2", C: "3" });
});

test("expandTilde handles ~ and ~/x", () => {
	assert.equal(expandTilde("~", "/home/u"), "/home/u");
	assert.equal(expandTilde("~/.ssh", "/home/u"), "/home/u/.ssh");
	assert.equal(expandTilde("/abs", "/home/u"), "/abs");
});

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

test("untrusted project config is ignored and warned about", () => {
	clearConfigCache();
	const root = tempDir();
	const agentDir = join(root, "agent");
	writeConfig(agentDir, { network: "host" }, ".");
	const project = join(root, "proj");
	writeConfig(project, { network: "none" });

	const cfg = loadSandboxConfig({
		projectRoot: project,
		worktreeRoot: project,
		cwd: project,
		projectTrusted: false,
		agentDir,
	});

	assert.equal(cfg.network, "host");
	assert.ok(cfg.sources.warnings.some((warning) => warning.includes("not trusted")));
});

test("trusted project config overrides global", () => {
	clearConfigCache();
	const root = tempDir();
	const agentDir = join(root, "agent");
	writeConfig(agentDir, { network: "host" }, ".");
	const project = join(root, "proj");
	writeConfig(project, { network: "none" });

	const cfg = loadSandboxConfig({
		projectRoot: project,
		worktreeRoot: project,
		cwd: project,
		projectTrusted: true,
		agentDir,
	});

	assert.equal(cfg.network, "none");
});

test("worktree-local config wins over main checkout (O3)", () => {
	clearConfigCache();
	const root = tempDir();
	const main = join(root, "main");
	writeConfig(main, { network: "host" });
	const worktree = join(root, "wt");
	writeConfig(worktree, { network: "none" });

	const cfg = loadSandboxConfig({
		projectRoot: main,
		worktreeRoot: worktree,
		cwd: worktree,
		projectTrusted: true,
		agentDir: join(root, "agent"),
	});

	assert.equal(cfg.network, "none");
	assert.equal(cfg.sources.projectPath, join(worktree, ".pi", "sandbox.json"));
});

test("falls back to main checkout config when worktree has none (O3)", () => {
	clearConfigCache();
	const root = tempDir();
	const main = join(root, "main");
	writeConfig(main, { network: "host" });
	const worktree = join(root, "wt");
	mkdirSync(worktree, { recursive: true });

	const cfg = loadSandboxConfig({
		projectRoot: main,
		worktreeRoot: worktree,
		cwd: worktree,
		projectTrusted: true,
		agentDir: join(root, "agent"),
	});

	assert.equal(cfg.network, "host");
	assert.equal(cfg.sources.projectPath, join(main, ".pi", "sandbox.json"));
});

test("expands relative and glob rules against cwd", () => {
	clearConfigCache();
	const root = tempDir();
	const project = join(root, "proj");
	mkdirSync(project, { recursive: true });
	writeFileSync(join(project, ".env"), "a");
	writeFileSync(join(project, ".env.local"), "b");
	writeFileSync(join(project, "app.pem"), "c");
	writeConfig(project, {
		filesystem: { allowWrite: ["."], denyWrite: [".env", ".env.*", "*.pem"] },
	});

	const cfg = loadSandboxConfig({
		projectRoot: project,
		worktreeRoot: project,
		cwd: project,
		projectTrusted: true,
		agentDir: join(root, "agent"),
	});

	assert.deepEqual(cfg.allowWrite.map((p) => p.path), [project]);
	assert.deepEqual(
		cfg.denyWrite.map((p) => p.path).sort(),
		[join(project, ".env"), join(project, ".env.local"), join(project, "app.pem")].sort(),
	);
});

test("nonexistent rules are skipped (no host mount point side effects)", () => {
	clearConfigCache();
	const root = tempDir();
	const project = join(root, "proj");
	mkdirSync(project, { recursive: true });
	writeConfig(project, { filesystem: { denyRead: ["does-not-exist"], denyWrite: ["nope.pem"] } });

	const cfg = loadSandboxConfig({
		projectRoot: project,
		worktreeRoot: project,
		cwd: project,
		projectTrusted: true,
		agentDir: join(root, "agent"),
	});

	assert.deepEqual(cfg.denyRead, []);
	assert.deepEqual(cfg.denyWrite, []);
});

test("unknown keys and invalid enums warn but do not fail", () => {
	clearConfigCache();
	const root = tempDir();
	const project = join(root, "proj");
	writeConfig(project, { network: "whitelist", bogus: true, filesystem: { allowRead: ["x"] } });

	const cfg = loadSandboxConfig({
		projectRoot: project,
		worktreeRoot: project,
		cwd: project,
		projectTrusted: true,
		agentDir: join(root, "agent"),
	});

	assert.equal(cfg.network, "none");
	assert.ok(cfg.sources.warnings.some((warning) => warning.startsWith("network:")));
	assert.ok(cfg.sources.warnings.some((warning) => warning.startsWith("bogus:")));
	assert.ok(cfg.sources.warnings.some((warning) => warning.startsWith("filesystem.allowRead:")));
});

test("malformed JSON falls back to lower layers with a warning", () => {
	clearConfigCache();
	const root = tempDir();
	const project = join(root, "proj");
	mkdirSync(join(project, ".pi"), { recursive: true });
	writeFileSync(join(project, ".pi", "sandbox.json"), "{ not json");

	const cfg = loadSandboxConfig({
		projectRoot: project,
		worktreeRoot: project,
		cwd: project,
		projectTrusted: true,
		agentDir: join(root, "agent"),
	});

	assert.equal(cfg.network, "none");
	assert.ok(cfg.sources.warnings.some((warning) => warning.includes("ignoring")));
});

test("getConfigPaths dedups when worktreeRoot === projectRoot", () => {
	const root = tempDir();
	const paths = getConfigPaths({ projectRoot: root, worktreeRoot: root, agentDir: join(root, "agent") });
	assert.equal(paths.projectCandidates.length, 1);
});
