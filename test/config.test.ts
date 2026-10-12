import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildGitGuard,
	clearConfigCache,
	DEFAULT_CONFIG,
	expandTilde,
	getConfigPaths,
	gitWritablePaths,
	loadSandboxConfig,
	mergeConfigLayers,
} from "../src/config.ts";
import type { GitLayout } from "../src/project.ts";
import { createWorktreeRepo, gitLayoutFor } from "./fixtures.ts";

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
	const repo = createWorktreeRepo(tmpdir(), { prefix: "pibs-git-" });
	return { ...repo, git: gitLayoutFor(repo) };
}

test("buildGitGuard protects config, hooks, and pointer files", () => {
	const { git } = realGitLayout();
	const guard = buildGitGuard(git);
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
	assert.equal(guard.active, false);
	assert.deepEqual(guard.readOnly, []);
	assert.deepEqual(guard.writable, []);
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

test("gitWritablePaths opens the worktree gitdir plus the shared store", () => {
	const { git } = realGitLayout();
	const paths = gitWritablePaths(git);
	assert.ok(paths.includes(git.gitDir));
	assert.ok(paths.includes(join(git.commonDir, "objects")));
	assert.ok(paths.includes(join(git.commonDir, "refs")));
	assert.ok(paths.includes(join(git.commonDir, "logs")));
	// config/hooks must never be writable
	assert.equal(paths.includes(join(git.commonDir, "config")), false);
	assert.equal(paths.includes(join(git.commonDir, "hooks")), false);
});

test("gitWritablePaths returns only the common dir for the main checkout", () => {
	const { git } = realGitLayout();
	assert.deepEqual(gitWritablePaths({ ...git, gitDir: git.commonDir }), [git.commonDir]);
});

test("$worktrees expands to every worktree, including siblings", () => {
	clearConfigCache();
	const { main, worktree, git } = realGitLayout();
	writeConfig(main, { filesystem: { allowWrite: ["$worktrees"] } });

	const cfg = loadSandboxConfig({
		projectRoot: main,
		worktreeRoot: worktree,
		cwd: worktree,
		projectTrusted: true,
		agentDir: join(main, "agent"),
		git,
	});

	const paths = cfg.allowWrite.map((path) => path.path);
	assert.ok(paths.includes(worktree), `expected ${worktree} in ${paths}`);
	assert.ok(paths.includes(realpathSync(main)), `expected main checkout in ${paths}`);
});

test("the git layer is opt-in: literal rules leave .git alone", () => {
	clearConfigCache();
	const { main, worktree, git } = realGitLayout();
	writeConfig(main, { filesystem: { allowWrite: ["."] } });

	const cfg = loadSandboxConfig({
		projectRoot: main,
		worktreeRoot: worktree,
		cwd: worktree,
		projectTrusted: true,
		agentDir: join(main, "agent"),
		git,
	});

	assert.equal(cfg.gitGuard.detected, true);
	assert.equal(cfg.gitGuard.active, false);
	// The store stays closed...
	assert.equal(cfg.gitGuard.writable.length, 0);
	assert.equal(
		cfg.allowWrite.some((path) => path.path.startsWith(git.commonDir)),
		false,
	);
	// ...but the config/hooks guards still apply, because they only remove
	// access. Without them a broad `allowWrite` would expose `core.hooksPath`.
	assert.ok(cfg.gitGuard.readOnly.length > 0);
	assert.ok(cfg.denyWrite.some((path) => path.path === join(git.commonDir, "config")));
});

test("a git variable enables the writable git store and the read-only guards", () => {
	clearConfigCache();
	const { main, worktree, git } = realGitLayout();
	writeConfig(main, { filesystem: { allowWrite: ["$worktree"] } });

	const cfg = loadSandboxConfig({
		projectRoot: main,
		worktreeRoot: worktree,
		cwd: worktree,
		projectTrusted: true,
		agentDir: join(main, "agent"),
		git,
	});

	const writable = cfg.allowWrite.map((path) => path.path);
	assert.ok(writable.includes(git.gitDir));
	assert.ok(writable.includes(join(git.commonDir, "objects")));

	const readOnly = cfg.denyWrite.map((path) => path.path);
	assert.ok(readOnly.includes(join(git.commonDir, "config")));
	assert.ok(readOnly.includes(join(git.commonDir, "hooks")));
	assert.ok(readOnly.includes(join(git.gitDir, "commondir")));

	// denyWrite is applied after allowWrite by bwrap, so the guard wins.
	for (const path of readOnly) assert.equal(writable.includes(path), false);
});

test("$worktrees falls back to the current directory outside a git repo", () => {
	clearConfigCache();
	const root = tempDir();
	const project = join(root, "proj");
	mkdirSync(project, { recursive: true });
	writeConfig(project, { filesystem: { allowWrite: ["$worktrees"] } });

	const cfg = loadSandboxConfig({
		projectRoot: project,
		worktreeRoot: project,
		cwd: project,
		projectTrusted: true,
		agentDir: join(root, "agent"),
		git: null,
	});

	// $worktrees falls back to the current worktree, which does exist.
	assert.deepEqual(cfg.allowWrite.map((path) => path.path), [project]);
	assert.equal(cfg.gitGuard.detected, false);
	assert.equal(cfg.gitGuard.active, false);
	assert.deepEqual(cfg.gitGuard.readOnly, []);
});

test("git guards also reach the tool policy, not just bwrap", () => {
	clearConfigCache();
	const { main, worktree, git } = realGitLayout();
	writeConfig(main, { filesystem: { allowWrite: ["$worktrees"] } });

	const cfg = loadSandboxConfig({
		projectRoot: main,
		worktreeRoot: worktree,
		cwd: worktree,
		projectTrusted: true,
		agentDir: join(main, "agent"),
		git,
	});

	// `write`/`edit` never enter bwrap, so the guards have to be in the raw
	// rules the tool policy matches against. Missing them here would let the
	// `write` tool set core.hooksPath and reach host code execution.
	assert.ok(cfg.rules.denyWrite.includes(join(git.commonDir, "config")));
	assert.ok(cfg.rules.denyWrite.includes(join(git.commonDir, "hooks")));
	assert.ok(cfg.rules.denyWrite.includes(join(git.gitDir, "commondir")));
});

// ---------------------------------------------------------------------------
// Git guard hardening (review findings)
// ---------------------------------------------------------------------------

test("git guard blocks creating a missing hooks dir (relative core.hooksPath)", () => {
	clearConfigCache();
	const { main, worktree, git } = realGitLayout();
	// husky-style: relative path, resolved per worktree, directory not created yet.
	const hooksPath = join(worktree, ".husky", "_");
	const withHooks = {
		...git,
		hooksDirs: [join(git.commonDir, "hooks"), hooksPath],
	};
	writeConfig(main, { filesystem: { allowWrite: ["$worktrees"] } });

	const cfg = loadSandboxConfig({
		projectRoot: main,
		worktreeRoot: worktree,
		cwd: worktree,
		projectTrusted: true,
		agentDir: join(main, "agent"),
		git: withHooks,
	});

	// A directory that does not exist must be masked with tmpfs, not /dev/null:
	// binding /dev/null would leave a *file* artifact that breaks a later mkdir.
	const blocked = cfg.denyCreate.find((entry) => entry.path === hooksPath);
	assert.ok(blocked, `expected ${hooksPath} in denyCreate`);
	assert.equal(blocked.isDir, true);
});

test("git guard blocks config.worktree only when worktreeConfig is enabled", () => {
	clearConfigCache();
	const { main, worktree, git } = realGitLayout();
	writeConfig(main, { filesystem: { allowWrite: ["$worktrees"] } });
	const input = {
		projectRoot: main,
		worktreeRoot: worktree,
		cwd: worktree,
		projectTrusted: true,
		agentDir: join(main, "agent"),
	};

	const off = loadSandboxConfig({ ...input, git: { ...git, worktreeConfigEnabled: false } });
	assert.equal(off.denyCreate.some((entry) => entry.path.endsWith("config.worktree")), false);

	const on = loadSandboxConfig({ ...input, git: { ...git, worktreeConfigEnabled: true } });
	assert.ok(on.denyCreate.some((entry) => entry.path === join(git.gitDir, "config.worktree")));
});

test("git guard protects the main checkout HEAD/index from a linked worktree", () => {
	clearConfigCache();
	const { main, worktree, git } = realGitLayout();
	writeConfig(main, { filesystem: { allowWrite: ["$worktrees"] } });

	const cfg = loadSandboxConfig({
		projectRoot: main,
		worktreeRoot: worktree,
		cwd: worktree,
		projectTrusted: true,
		agentDir: join(main, "agent"),
		git,
	});

	const readOnly = cfg.gitGuard.readOnly;
	assert.ok(readOnly.includes(join(git.commonDir, "HEAD")));
	assert.ok(readOnly.includes(join(git.commonDir, "index")));
});

test("the main checkout does not guard its own HEAD (it must be able to commit)", () => {
	clearConfigCache();
	const { main, git } = realGitLayout();
	writeConfig(main, { filesystem: { allowWrite: ["."] } });

	const cfg = loadSandboxConfig({
		projectRoot: main,
		worktreeRoot: main,
		cwd: main,
		projectTrusted: true,
		agentDir: join(main, "agent"),
		git: { ...git, gitDir: git.commonDir },
	});

	assert.equal(cfg.gitGuard.readOnly.includes(join(git.commonDir, "HEAD")), false);
	assert.equal(cfg.gitGuard.readOnly.includes(join(git.commonDir, "index")), false);
});

test("a symlinked git config is guarded by its resolved path", () => {
	clearConfigCache();
	const { root, main, worktree, git } = realGitLayout();
	const realConfig = join(root, "managed-gitconfig");
	writeFileSync(realConfig, "[core]\n");
	rmSync(join(git.commonDir, "config"));
	symlinkSync(realConfig, join(git.commonDir, "config"));

	writeConfig(main, { filesystem: { allowWrite: ["$worktrees"] } });
	const cfg = loadSandboxConfig({
		projectRoot: main,
		worktreeRoot: worktree,
		cwd: worktree,
		projectTrusted: true,
		agentDir: join(main, "agent"),
		git,
	});

	// The tool policy canonicalizes targets, so the guard must be the resolved
	// path or the two layers disagree and `write` slips through.
	assert.ok(cfg.rules.denyWrite.includes(realpathSync(realConfig)));
});

test("a deny-only git variable does not open the git store", () => {
	clearConfigCache();
	const { main, worktree, git } = realGitLayout();
	writeConfig(main, { filesystem: { allowWrite: ["."], denyWrite: ["$worktrees/secret"] } });

	const cfg = loadSandboxConfig({
		projectRoot: main,
		worktreeRoot: worktree,
		cwd: worktree,
		projectTrusted: true,
		agentDir: join(main, "agent"),
		git,
	});

	assert.equal(cfg.gitGuard.active, false);
	assert.equal(cfg.gitGuard.writable.length, 0);
});

test("an unknown path variable is warned about and never matches", () => {
	clearConfigCache();
	const root = tempDir();
	const project = join(root, "proj");
	mkdirSync(project, { recursive: true });
	writeConfig(project, { filesystem: { allowWrite: ["$bogus"] } });

	const cfg = loadSandboxConfig({
		projectRoot: project,
		worktreeRoot: project,
		cwd: project,
		projectTrusted: true,
		agentDir: join(root, "agent"),
	});

	assert.deepEqual(cfg.allowWrite, []);
	assert.ok(cfg.sources.warnings.some((warning) => warning.includes("$bogus")));
});
