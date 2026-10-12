import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
	clearProjectCache,
	fallbackProjectInfo,
	parseProjectInfo,
	parseWorktreePaths,
	resolveProjectRoot,
} from "../src/project.ts";

function tempDir(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "pibs-proj-")));
}

test("parseProjectInfo: main checkout", () => {
	const info = parseProjectInfo("/repo", "/repo/.git\n/repo/.git\n/repo\n");
	assert.ok(info);
	assert.equal(info.cwd, "/repo");
	assert.equal(info.projectRoot, "/repo");
	assert.equal(info.worktreeRoot, "/repo");
	assert.equal(info.isWorktree, false);
	assert.equal(info.git?.commonDir, "/repo/.git");
	assert.equal(info.git?.gitDir, "/repo/.git");
	// The built-in hooks dir is always a candidate, existing or not.
	assert.deepEqual(info.git?.hooksDirs, ["/repo/.git/hooks"]);
	assert.equal(info.git?.worktreeConfigEnabled, false);
});

test("parseProjectInfo: linked worktree", () => {
	const info = parseProjectInfo(
		"/repo/wt",
		"/repo/.git\n/repo/.git/worktrees/wt\n/repo/wt\n",
		"worktree /repo\0worktree /repo/wt\0",
	);
	assert.ok(info);
	assert.equal(info.projectRoot, "/repo");
	assert.equal(info.worktreeRoot, "/repo/wt");
	assert.equal(info.isWorktree, true);
	assert.equal(info.git?.commonDir, "/repo/.git");
	assert.equal(info.git?.gitDir, "/repo/.git/worktrees/wt");
	assert.deepEqual(info.git?.worktrees, ["/repo", "/repo/wt"]);
});

test("parseProjectInfo: malformed output returns null", () => {
	assert.equal(parseProjectInfo("/x", ""), null);
	assert.equal(parseProjectInfo("/x", "/only/one/line\n"), null);
	assert.equal(parseProjectInfo("/x", "/a\n/b\n"), null);
});

test("parseProjectInfo: worktree listing is optional", () => {
	// Without a listing the current worktree is still known, so the set falls
	// back to it rather than being empty (an empty set would silently drop the
	// worktree from `$worktrees`).
	const info = parseProjectInfo("/repo", "/repo/.git\n/repo/.git\n/repo\n");
	assert.deepEqual(info?.git?.worktrees, ["/repo"]);
	assert.equal(info?.git?.mainCheckout, "/repo");
});

test("parseWorktreePaths parses NUL-separated porcelain output", () => {
	assert.deepEqual(
		parseWorktreePaths("worktree /a\0HEAD abc\0branch refs/heads/main\0\0worktree /b\0HEAD def\0\0"),
		["/a", "/b"],
	);
	assert.deepEqual(parseWorktreePaths(""), []);
});

test("fallbackProjectInfo: non-git dir is its own project", () => {
	const info = fallbackProjectInfo("/some/dir");
	assert.equal(info.projectRoot, "/some/dir");
	assert.equal(info.worktreeRoot, "/some/dir");
	assert.equal(info.isWorktree, false);
	assert.equal(info.git, null);
});

test("resolveProjectRoot: real git repo and linked worktree", async () => {
	const root = tempDir();
	const repo = join(root, "repo");
	mkdirSync(repo, { recursive: true });
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });

	git(repo, "init", "-q");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "test");
	git(repo, "commit", "-q", "--allow-empty", "-m", "init");

	const worktree = join(root, "wt");
	git(repo, "worktree", "add", "-q", worktree);

	clearProjectCache();
	const mainInfo = await resolveProjectRoot(repo, { ttlMs: 0 });
	assert.equal(mainInfo.projectRoot, repo);
	assert.equal(mainInfo.worktreeRoot, repo);
	assert.equal(mainInfo.isWorktree, false);

	clearProjectCache();
	const wtInfo = await resolveProjectRoot(worktree, { ttlMs: 0 });
	assert.equal(wtInfo.projectRoot, repo);
	assert.equal(wtInfo.worktreeRoot, worktree);
	assert.equal(wtInfo.isWorktree, true);
	assert.ok(wtInfo.git);
	assert.equal(wtInfo.git.gitDir, join(repo, ".git", "worktrees", basename(worktree)));
	assert.equal(wtInfo.git.commonDir, join(repo, ".git"));
	assert.deepEqual(
		[...wtInfo.git.worktrees].sort(),
		[repo, worktree].sort(),
	);
});

test("resolveProjectRoot: non-git dir falls back to itself", async () => {
	const dir = tempDir();
	clearProjectCache();
	const info = await resolveProjectRoot(dir, { ttlMs: 0 });
	assert.equal(info.projectRoot, dir);
	assert.equal(info.worktreeRoot, dir);
	assert.equal(info.isWorktree, false);
});

test("resolveProjectRoot: cache is reused within TTL", async () => {
	clearProjectCache();
	let calls = 0;
	const runGit = async () => {
		calls += 1;
		return "/repo/.git\n/repo\n";
	};
	const now = () => 1000;

	await resolveProjectRoot("/repo", { runGit, now, ttlMs: 60_000 });
	await resolveProjectRoot("/repo", { runGit, now, ttlMs: 60_000 });
	assert.equal(calls, 1);
});

test("resolveProjectRoot: a new worktree is visible before the TTL expires", async () => {
	const root = tempDir();
	const repo = join(root, "repo");
	mkdirSync(repo, { recursive: true });
	const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "test");
	git(repo, "commit", "-q", "--allow-empty", "-m", "init");

	clearProjectCache();
	// Long TTL: only the worktree-set freshness check can invalidate this.
	const first = await resolveProjectRoot(repo, { ttlMs: 60_000 });
	assert.equal(first.git?.worktrees.length, 1);

	git(repo, "worktree", "add", "-q", join(root, "added"), "-b", "added");
	const second = await resolveProjectRoot(repo, { ttlMs: 60_000 });
	assert.equal(second.git?.worktrees.length, 2);
});

test("parseProjectInfo: core.hooksPath and worktreeConfig are read from config", () => {
	const info = parseProjectInfo(
		"/repo/wt",
		"/repo/.git\n/repo/.git/worktrees/wt\n/repo/wt\n",
		"worktree /repo\0worktree /repo/wt\0",
		"core.hookspath .husky/_\nextensions.worktreeconfig true\n",
	);
	assert.ok(info?.git);
	assert.equal(info.git.worktreeConfigEnabled, true);
	// Relative hooksPath resolves per worktree, so every worktree is a candidate.
	assert.deepEqual(info.git.hooksDirs, [
		"/repo/.git/hooks",
		"/repo/.husky/_",
		"/repo/wt/.husky/_",
	]);
});

test("parseProjectInfo: absolute core.hooksPath is a single candidate", () => {
	const info = parseProjectInfo(
		"/repo/wt",
		"/repo/.git\n/repo/.git/worktrees/wt\n/repo/wt\n",
		"worktree /repo\0worktree /repo/wt\0",
		"core.hookspath /opt/hooks\n",
	);
	assert.deepEqual(info?.git?.hooksDirs, ["/repo/.git/hooks", "/opt/hooks"]);
});

test("parseWorktreePaths keeps trailing spaces (a legal directory name)", () => {
	assert.deepEqual(parseWorktreePaths("worktree /a \0HEAD x\0\0"), ["/a "]);
});
