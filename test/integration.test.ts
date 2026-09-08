/**
 * End-to-end tests: build argv with the real config loader, then run it
 * through the real `bwrap` binary. Skipped automatically when bwrap is not
 * available or cannot create a user namespace.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildBwrapArgs } from "../src/bwrap.ts";
import { loadSandboxConfig } from "../src/config.ts";
import { resolveSandboxEnv } from "../src/env.ts";
import type { BwrapCapabilities } from "../src/types.ts";

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
