/**
 * End-to-end tests: build argv with the real config loader, then run it
 * through the real `bwrap` binary. Skipped automatically when bwrap is not
 * available or cannot create a user namespace.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { buildBwrapArgs } from "../src/bwrap.ts";
import { loadSandboxConfig } from "../src/config.ts";
import { resolveSandboxEnv } from "../src/env.ts";
import { createSandboxedBashOperations } from "../src/exec.ts";
import { resolveProjectRoot } from "../src/project.ts";
import type { BwrapCapabilities } from "../src/types.ts";
import { createWorktreeRepo } from "./fixtures.ts";

const BWRAP = process.env.BWRAP ?? "bwrap";

function probe(): BwrapCapabilities {
	const result = spawnSync(
		BWRAP,
		[
			"--ro-bind",
			"/",
			"/",
			"--dev",
			"/dev",
			"--unshare-pid",
			"--unshare-user",
			"--proc",
			"/proc",
			"--",
			"/bin/true",
		],
		{ stdio: "ignore" },
	);
	const ok = result.status === 0;
	return { available: ok, userNamespace: ok, procMount: ok, error: ok ? undefined : "bwrap smoke test failed" };
}

const CAPS = probe();
const skip = CAPS.available ? false : `bwrap unavailable: ${CAPS.error}`;

function tempProject(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pibs-it-")));
	mkdirSync(join(dir, ".pi"), { recursive: true });
	return dir;
}

function buildArgs(project: string, config: unknown, command: string): string[] {
	writeFileSync(join(project, ".pi", "sandbox.json"), JSON.stringify(config));
	const resolved = loadSandboxConfig({
		projectRoot: project,
		worktreeRoot: project,
		cwd: project,
		projectTrusted: true,
		agentDir: join(project, "agent"),
	});
	const env = resolveSandboxEnv(
		{
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: project,
			TERM: "xterm",
			ANTHROPIC_API_KEY: "leak",
		},
		resolved.env,
	);
	return buildBwrapArgs({
		command,
		cwd: project,
		env,
		config: resolved,
		capabilities: CAPS,
		shell: { shell: "/bin/bash", args: ["-c"] },
	});
}

function run(args: string[]) {
	const [bin, ...rest] = args;
	const result = spawnSync(bin, rest, {
		encoding: "utf-8",
		env: { ...process.env, ANTHROPIC_API_KEY: "leak" },
	});
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("allowWrite: writes persist to the host", { skip }, () => {
	const project = tempProject();
	const args = buildArgs(project, {}, "echo hello >> out.txt && cat out.txt");
	const result = run(args);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "hello\n");
	assert.equal(readFileSync(join(project, "out.txt"), "utf-8"), "hello\n");
});

test("regression: project under /tmp survives private tmp", { skip }, () => {
	// tempProject() lives under /tmp, and the default tmp policy is private.
	// The /tmp tmpfs must be mounted before the allowWrite bind or it shadows
	// the project and every write fails.
	const project = tempProject();
	const args = buildArgs(project, { tmp: "private", filesystem: { allowWrite: ["."] } }, "pwd && echo ok > probe.txt");
	const result = run(args);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), project);
	assert.equal(readFileSync(join(project, "probe.txt"), "utf-8"), "ok\n");
});

test("denyRead: file content is hidden", { skip }, () => {
	const project = tempProject();
	writeFileSync(join(project, "secret.txt"), "TOPSECRET");
	const args = buildArgs(project, { filesystem: { denyRead: ["secret.txt"] } }, 'cat secret.txt; echo "|done"');
	const result = run(args);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "|done\n");
});

test("denyRead dir: contents hidden and writes fail loudly", { skip }, () => {
	const project = tempProject();
	mkdirSync(join(project, "secret"), { recursive: true });
	writeFileSync(join(project, "secret", "token.txt"), "TOPSECRET");
	const args = buildArgs(
		project,
		{ filesystem: { allowWrite: ["."], denyRead: ["secret"] } },
		'ls -A secret; echo x > secret/hh; echo "write=$?"',
	);
	const result = run(args);
	assert.equal(result.stdout.includes("TOPSECRET"), false);
	assert.equal(result.stdout.includes("hh"), false);
	assert.match(result.stdout, /write=1/);
	assert.match(result.stderr, /Read-only file system/);
});

test("denyWrite: file stays readable but writes fail and host is unchanged", { skip }, () => {
	const project = tempProject();
	writeFileSync(join(project, "protected.txt"), "orig");
	const args = buildArgs(
		project,
		{ filesystem: { allowWrite: ["."], denyWrite: ["protected.txt"] } },
		'echo hack >> protected.txt 2>/dev/null; echo "status=$?"; cat protected.txt',
	);
	const result = run(args);
	assert.match(result.stdout, /status=1/);
	assert.match(result.stdout, /orig/);
	assert.equal(result.stdout.includes("hack"), false);
	assert.equal(readFileSync(join(project, "protected.txt"), "utf-8"), "orig");
});

test("network none: outbound connections are unreachable", { skip }, () => {
	const project = tempProject();
	const args = buildArgs(
		project,
		{ network: "none" },
		"timeout 3 bash -c 'exec 3<>/dev/tcp/1.1.1.1/53' 2>/dev/null && echo OPEN || echo BLOCKED",
	);
	const result = run(args);
	assert.equal(result.stdout.trim(), "BLOCKED");
});

test("clearenv: host secrets are absent, PATH survives", { skip }, () => {
	const project = tempProject();
	const args = buildArgs(
		project,
		{},
		'test -z "$ANTHROPIC_API_KEY" && echo CLEAN; command -v bash >/dev/null && echo HAS_PATH',
	);
	const result = run(args);
	assert.match(result.stdout, /CLEAN/);
	assert.match(result.stdout, /HAS_PATH/);
});

// ---------------------------------------------------------------------------
// SandboxedBashOperations against real bwrap
// ---------------------------------------------------------------------------

function realOperations(project: string, config: unknown) {
	writeFileSync(join(project, ".pi", "sandbox.json"), JSON.stringify(config));
	return createSandboxedBashOperations({
		resolveConfig: async (cwd) =>
			loadSandboxConfig({
				projectRoot: cwd,
				worktreeRoot: cwd,
				cwd,
				projectTrusted: true,
				agentDir: join(project, "agent"),
			}),
		capabilities: () => CAPS,
		shell: () => ({ shell: "/bin/bash", args: ["-c"] }),
		fallback: {
			async exec() {
				return { exitCode: 0 };
			},
		},
	});
}

test("exec streams stdout", { skip }, async () => {
	const project = tempProject();
	const operations = realOperations(project, {});
	const chunks: Buffer[] = [];
	const result = await operations.exec("echo streamed", project, { onData: (data) => chunks.push(data) });
	assert.equal(result.exitCode, 0);
	assert.match(Buffer.concat(chunks).toString(), /streamed/);
});

test("exec timeout kills the process group", { skip }, async () => {
	const project = tempProject();
	const operations = realOperations(project, {});
	await assert.rejects(
		operations.exec("sleep 30", project, { onData: () => {}, timeout: 1 }),
		/timeout:1/,
	);
});

test("exec abort kills the process group", { skip }, async () => {
	const project = tempProject();
	const operations = realOperations(project, {});
	const controller = new AbortController();
	const promise = operations.exec("sleep 30", project, { onData: () => {}, signal: controller.signal });
	setTimeout(() => controller.abort(), 200);
	await assert.rejects(promise, /aborted/);
});

// ---------------------------------------------------------------------------
// Linked worktrees
// ---------------------------------------------------------------------------

// These repos must live *outside* /tmp. The default `tmp: "private"` mounts an
// empty /tmp, which would hide a repository created underneath it — the tests
// would then pass or fail for reasons unrelated to the git guard. They also
// must not use `tmp: "shared"`, which would make all of /tmp writable and mask
// the read-only git store this section is asserting on.
const WORKTREE_BASE = mkdtempSync(join(process.cwd(), ".worktree-tests-"));
after(() => rmSync(WORKTREE_BASE, { recursive: true, force: true }));

/** Create a real repo with one linked worktree; returns both roots. */
function worktreeProject(): { root: string; main: string; worktree: string } {
	return createWorktreeRepo(WORKTREE_BASE);
}

/** Build bwrap argv for a command in `cwd`, using the real git layout. */
async function buildArgsFor(cwd: string, config: unknown, command: string): Promise<string[]> {
	writeFileSync(join(cwd, ".pi", "sandbox.json"), JSON.stringify(config));
	const project = await resolveProjectRoot(cwd, { ttlMs: 0 });
	const resolved = loadSandboxConfig({
		projectRoot: project.projectRoot,
		worktreeRoot: project.worktreeRoot,
		cwd,
		projectTrusted: true,
		agentDir: join(cwd, "agent"),
		git: project.git,
	});
	return buildBwrapArgs({
		command,
		cwd,
		env: resolveSandboxEnv({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd }, resolved.env),
		config: resolved,
		capabilities: CAPS,
		shell: { shell: "/bin/bash", args: ["-c"] },
	});
}

test("worktree: allowWrite [$worktrees] can commit", { skip }, async () => {
	const { worktree } = worktreeProject();
	mkdirSync(join(worktree, ".pi"), { recursive: true });
	writeFileSync(join(worktree, "file.txt"), "one\n");

	const args = await buildArgsFor(
		worktree,
		{ filesystem: { allowWrite: ["$worktrees"] } },
		"git add file.txt && git commit -q -m 'from sandbox' && git log --oneline -1",
	);
	const result = run(args);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /from sandbox/);
});

test("worktree: $worktrees lets one worktree write a sibling's files", { skip }, async () => {
	const { main, worktree } = worktreeProject();
	const sibling = join(main, "..", "sibling");
	execFileSync("git", ["-C", main, "worktree", "add", "-q", sibling, "-b", "sibling"], { stdio: "pipe" });
	mkdirSync(join(worktree, ".pi"), { recursive: true });
	writeFileSync(join(sibling, "sib.txt"), "original\n");

	const args = await buildArgsFor(
		worktree,
		{ filesystem: { allowWrite: ["$worktrees"] } },
		`echo edited >> ${join(sibling, "sib.txt")}`,
	);
	const result = run(args);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(join(sibling, "sib.txt"), "utf-8"), "original\nedited\n");
});

test("worktree: the git guard blocks hooks, config, and pointer rewrites", { skip }, async () => {
	const { main, worktree } = worktreeProject();
	mkdirSync(join(worktree, ".pi"), { recursive: true });
	const hooksDir = join(main, ".git", "hooks");

	const args = await buildArgsFor(
		worktree,
		{ filesystem: { allowWrite: ["$worktrees", "$repo"] } },
		[
			`echo pwn > ${hooksDir}/post-commit && echo HOOK_LEAK || echo hook_blocked`,
			`git config core.hooksPath /tmp && echo CFG_LEAK || echo cfg_blocked`,
			`printf 'gitdir: /tmp\\n' > ${worktree}/.git && echo DOTGIT_LEAK || echo dotgit_blocked`,
		].join("; "),
	);
	const result = run(args);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /hook_blocked/);
	assert.match(result.stdout, /cfg_blocked/);
	assert.match(result.stdout, /dotgit_blocked/);
	assert.equal(result.stdout.includes("LEAK"), false, result.stdout);
});

test("worktree: the git guard does not break normal git operations", { skip }, async () => {
	const { worktree } = worktreeProject();
	mkdirSync(join(worktree, ".pi"), { recursive: true });
	writeFileSync(join(worktree, "file.txt"), "base\n");

	const args = await buildArgsFor(
		worktree,
		{ filesystem: { allowWrite: ["$worktrees"] } },
		[
			"git add file.txt && git commit -q -m c1",
			// Stash needs a real change, so touch the file first.
			"echo more >> file.txt && git stash -q && git stash pop -q",
			"git tag v1",
			"git checkout -q -b topic",
			"git log --oneline -1",
		].join(" && "),
	);
	const result = run(args);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /c1/);
});

test("worktree: a literal allowWrite leaves the git store read-only", { skip }, async () => {
	const { worktree } = worktreeProject();
	mkdirSync(join(worktree, ".pi"), { recursive: true });
	writeFileSync(join(worktree, "file.txt"), "one\n");

	const args = await buildArgsFor(
		worktree,
		{ filesystem: { allowWrite: ["."] } },
		"git add file.txt && git commit -q -m nope",
	);
	const result = run(args);
	// Committing needs the shared object store, which is not opened without a
	// git variable, so the write fails instead of silently succeeding.
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Read-only file system/);
});

test("main checkout: .git/config and hooks are read-only, commit still works", { skip }, async () => {
	const { main } = worktreeProject();
	mkdirSync(join(main, ".pi"), { recursive: true });
	writeFileSync(join(main, "file.txt"), "one\n");
	const hooksDir = join(main, ".git", "hooks");

	const args = await buildArgsFor(
		main,
		{ filesystem: { allowWrite: ["."] } },
		[
			// A plain commit must still work: the guards only cover config/hooks.
			"git add file.txt && git commit -q -m ok && git log --oneline -1",
			// Planting a hook here would run on the host on the next commit.
			`echo pwn > ${hooksDir}/post-commit && echo HOOK_LEAK || echo hook_blocked`,
			// `core.hooksPath` is the other code-execution vector.
			`git config core.hooksPath /tmp && echo CFG_LEAK || echo cfg_blocked`,
			`printf '[core]\\n\\thooksPath = /tmp\\n' >> ${main}/.git/config && echo APPEND_LEAK || echo append_blocked`,
		].join("; "),
	);
	const result = run(args);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /ok/);
	assert.match(result.stdout, /hook_blocked/);
	assert.match(result.stdout, /cfg_blocked/);
	assert.match(result.stdout, /append_blocked/);
	assert.equal(result.stdout.includes("LEAK"), false, result.stdout);
	assert.equal(existsSync(join(hooksDir, "post-commit")), false);
});

test("worktree: a missing hooks dir cannot be created (relative core.hooksPath)", { skip }, async () => {
	const { main, worktree } = worktreeProject();
	mkdirSync(join(worktree, ".pi"), { recursive: true });
	// husky-style config: relative hooksPath, resolved against the worktree.
	execFileSync("git", ["-C", main, "config", "core.hooksPath", ".husky/_"], { stdio: "pipe" });

	const args = await buildArgsFor(
		worktree,
		{ filesystem: { allowWrite: ["$worktrees"] } },
		[
			`mkdir -p ${worktree}/.husky/_ && echo DIR_OK || echo dir_blocked`,
			`echo pwn > ${worktree}/.husky/_/post-commit && echo HOOK_LEAK || echo hook_blocked`,
		].join("; "),
	);
	const result = run(args);
	assert.equal(result.stdout.includes("HOOK_LEAK"), false, result.stdout);
	assert.match(result.stdout, /hook_blocked/);
});

test("worktree: config.worktree cannot redirect hooks when the extension is on", { skip }, async () => {
	const { main, worktree } = worktreeProject();
	mkdirSync(join(worktree, ".pi"), { recursive: true });
	execFileSync("git", ["-C", main, "config", "extensions.worktreeConfig", "true"], { stdio: "pipe" });

	const args = await buildArgsFor(
		worktree,
		{ filesystem: { allowWrite: ["$worktrees"] } },
		`git config --worktree core.hooksPath ${worktree}/evilhooks && echo REDIRECTED || echo blocked`,
	);
	const result = run(args);
	assert.equal(result.stdout.includes("REDIRECTED"), false, result.stdout);
	assert.match(result.stdout, /blocked/);
});

test("worktree: the main checkout HEAD and index are protected", { skip }, async () => {
	const { main, worktree } = worktreeProject();
	mkdirSync(join(worktree, ".pi"), { recursive: true });

	const args = await buildArgsFor(
		worktree,
		{ filesystem: { allowWrite: ["$worktrees"] } },
		[
			`echo 'ref: refs/heads/feature' > ${main}/.git/HEAD && echo HEAD_LEAK || echo head_blocked`,
			`rm -f ${main}/.git/index && echo IDX_LEAK || echo idx_blocked`,
		].join("; "),
	);
	const result = run(args);
	assert.equal(result.stdout.includes("LEAK"), false, result.stdout);
	assert.match(result.stdout, /head_blocked/);
	assert.match(result.stdout, /idx_blocked/);
});

test("worktree: a worktree created after the first resolution is writable", { skip }, async () => {
	const { main, worktree } = worktreeProject();
	mkdirSync(join(worktree, ".pi"), { recursive: true });

	// Resolve once, then add a worktree, then resolve again in the same process.
	const first = await resolveProjectRoot(worktree, { ttlMs: 60_000 });
	assert.equal(first.git?.worktrees.length, 2);

	const added = join(main, "..", "late");
	execFileSync("git", ["-C", main, "worktree", "add", "-q", added, "-b", "late"], { stdio: "pipe" });
	writeFileSync(join(added, "late.txt"), "x\n");

	const args = await buildArgsFor(
		worktree,
		{ filesystem: { allowWrite: ["$worktrees"] } },
		`echo edited >> ${join(added, "late.txt")}`,
	);
	const result = run(args);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(readFileSync(join(added, "late.txt"), "utf-8"), "x\nedited\n");
});
