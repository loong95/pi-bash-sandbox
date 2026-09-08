import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	clearProjectCache,
	fallbackProjectInfo,
	parseProjectInfo,
	resolveProjectRoot,
} from "../src/project.ts";

function tempDir(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "pibs-proj-")));
}

test("parseProjectInfo: main checkout", () => {
	const info = parseProjectInfo("/repo", "/repo/.git\n/repo\n");
	assert.deepEqual(info, {
		cwd: "/repo",
		projectRoot: "/repo",
		worktreeRoot: "/repo",
		isWorktree: false,
	});
});

test("parseProjectInfo: linked worktree", () => {
	const info = parseProjectInfo("/repo/wt", "/repo/.git\n/repo/wt\n");
	assert.equal(info?.projectRoot, "/repo");
	assert.equal(info?.worktreeRoot, "/repo/wt");
	assert.equal(info?.isWorktree, true);
});

test("parseProjectInfo: malformed output returns null", () => {
	assert.equal(parseProjectInfo("/x", ""), null);
	assert.equal(parseProjectInfo("/x", "/only/one/line\n"), null);
});

test("fallbackProjectInfo: non-git dir is its own project", () => {
	const info = fallbackProjectInfo("/some/dir");
	assert.equal(info.projectRoot, "/some/dir");
	assert.equal(info.worktreeRoot, "/some/dir");
	assert.equal(info.isWorktree, false);
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
