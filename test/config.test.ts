import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildGitGuard,
	clearConfigCache,
	DEFAULT_CONFIG,
	expandTilde,
	getConfigPaths,
	loadSandboxConfig,
	mergeConfigLayers,
} from "../src/config.ts";
import type { GitLayout } from "../src/project.ts";

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

test("project layer extends global arrays by default", () => {
	const merged = mergeConfigLayers(
		DEFAULT_CONFIG,
		{ filesystem: { allowWrite: ["/global"] } },
		{ filesystem: { allowWrite: ["/project"] } },
	);
	assert.deepEqual(merged.filesystem?.allowWrite, ["/global", "/project"]);
});

test("project layer can replace selected global arrays", () => {
	const merged = mergeConfigLayers(
		DEFAULT_CONFIG,
		{
			filesystem: {
				allowWrite: ["/global-write"],
				denyRead: ["/global-secret"],
			},
			env: { deny: ["GLOBAL_*"] },
		},
		{
			replaceGlobalArrays: ["filesystem.allowWrite", "env.deny"],
			filesystem: {
				allowWrite: ["/project-write"],
				denyRead: ["/project-secret"],
			},
			env: { deny: ["PROJECT_*"] },
		},
	);
	assert.deepEqual(merged.filesystem?.allowWrite, ["/project-write"]);
	assert.deepEqual(merged.filesystem?.denyRead, ["/global-secret", "/project-secret"]);
	assert.deepEqual(merged.env?.deny, ["PROJECT_*"]);
});

test("array merging removes duplicates in inherited and replacement values", () => {
	const merged = mergeConfigLayers(
		DEFAULT_CONFIG,
		{
			filesystem: {
				allowWrite: ["/global", "/global"],
			},
			env: { deny: ["GLOBAL_*", "GLOBAL_*"] },
		},
		{
			replaceGlobalArrays: ["filesystem.allowWrite"],
			filesystem: {
				allowWrite: ["/project", "/project"],
				denyRead: ["/secret", "/secret"],
			},
		},
	);
	assert.deepEqual(merged.filesystem?.allowWrite, ["/project"]);
	assert.deepEqual(merged.filesystem?.denyRead, ["/secret"]);
	assert.deepEqual(merged.env?.deny, ["GLOBAL_*"]);
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

test("files created after first load are picked up without reload", () => {
	clearConfigCache();
	const root = tempDir();
	const project = join(root, "proj");
	mkdirSync(project, { recursive: true });
	writeConfig(project, { filesystem: { denyWrite: [".env.*", "*.pem"] } });

	const input = {
		projectRoot: project,
		worktreeRoot: project,
		cwd: project,
		projectTrusted: true,
		agentDir: join(root, "agent"),
	};

	// Nothing matches yet.
	assert.deepEqual(loadSandboxConfig(input).denyWrite, []);

	// Files appear after the config was already parsed/merged and cached.
	writeFileSync(join(project, ".env.local"), "secret");
	writeFileSync(join(project, "key.pem"), "key");

	assert.deepEqual(
		loadSandboxConfig(input)
			.denyWrite.map((path) => path.path)
			.sort(),
		[join(project, ".env.local"), join(project, "key.pem")].sort(),
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
	writeConfig(project, {
		network: "whitelist",
		bogus: true,
		replaceGlobalArrays: ["filesystem.allowWrite", "not.a.field"],
		filesystem: { allowRead: ["x"] },
	});

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
	assert.ok(cfg.sources.warnings.some((warning) => warning.includes("replaceGlobalArrays.not.a.field:")));
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

// ---------------------------------------------------------------------------
// Git layer
// ---------------------------------------------------------------------------

/** Build a real repo + linked worktree on disk and return its GitLayout. */
function realGitLayout(): { root: string; main: string; worktree: string; git: GitLayout } {
	const root = tempDir();
	const main = join(root, "main");
	mkdirSync(main, { recursive: true });
	const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
	git(main, "init", "-q");
	git(main, "config", "user.email", "t@e.st");
	git(main, "config", "user.name", "t");
	git(main, "commit", "-q", "--allow-empty", "-m", "init");

	const worktree = join(root, "wt");
	git(main, "worktree", "add", "-q", worktree, "-b", "feature");

	const commonDir = realpathSync(join(main, ".git"));
	const gitDir = realpathSync(join(commonDir, "worktrees", "wt"));
	return {
		root,
		main,
		worktree: realpathSync(worktree),
		git: {
			commonDir,
			gitDir,
			hooksDir: join(commonDir, "hooks"),
			worktrees: [realpathSync(main), realpathSync(worktree)],
			siblingGitDirs: [],
		},
	};
}

test("buildGitGuard protects config, hooks, and pointer files", () => {
	const { git } = realGitLayout();
	const guard = buildGitGuard(git);
	assert.equal(guard.detected, true);
	assert.equal(guard.active, true);
	assert.ok(guard.readOnly.includes(join(git.commonDir, "config")));
	assert.ok(guard.readOnly.includes(join(git.commonDir, "hooks")));
	assert.ok(guard.readOnly.includes(join(git.gitDir, "commondir")));
	assert.ok(guard.readOnly.includes(join(git.gitDir, "gitdir")));
	// Every worktree's `.git` *pointer file* is protected. The main checkout's
	// `.git` is a directory holding the shared store, so it is not a guard.
	for (const worktree of git.worktrees) {
		const pointer = join(worktree, ".git");
		if (statSync(pointer).isFile()) {
			assert.ok(guard.readOnly.includes(pointer), `missing ${pointer}`);
		} else {
			assert.equal(guard.readOnly.includes(pointer), false, `directory must not be guarded: ${pointer}`);
		}
	}
	// The linked worktree's pointer file is the one that actually exists.
	assert.ok(guard.readOnly.includes(join(git.worktrees[1], ".git")));
});

test("buildGitGuard is inert without a repository", () => {
	const guard = buildGitGuard(null);
	assert.equal(guard.detected, false);
	assert.equal(guard.active, false);
	assert.deepEqual(guard.readOnly, []);
});

test("buildGitGuard never names a missing path (bwrap would create it)", () => {
	const { git } = realGitLayout();
	const guard = buildGitGuard(git);
	for (const path of guard.readOnly) assert.ok(existsSync(path), `guarded path must exist: ${path}`);
});

test("buildGitGuard skips the main checkout's nonexistent commondir/gitdir", () => {
	const { git } = realGitLayout();
	const guard = buildGitGuard({ ...git, gitDir: git.commonDir });
	assert.equal(guard.readOnly.includes(join(git.commonDir, "commondir")), false);
	assert.equal(guard.readOnly.includes(join(git.commonDir, "gitdir")), false);
	assert.ok(guard.readOnly.includes(join(git.commonDir, "config")));
});

