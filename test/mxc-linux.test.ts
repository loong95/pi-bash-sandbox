/**
 * Linux end-to-end coverage for the MXC bubblewrap engine.
 *
 * The bwrap argv suite in integration.test.ts pins the original engine; this
 * file exercises the MXC request builder, executor spawn, streaming,
 * abort/timeout, and deny semantics. Skipped when MXC or bubblewrap is
 * unavailable.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { createSandboxedBashOperations } from "../src/exec.ts";
import { probeMxc } from "../src/mxc/probe.ts";
import type { ResolvedSandboxConfig } from "../src/types.ts";
import { NO_GIT_GUARD, makeResolvedConfig } from "./fixtures.ts";

const probe = process.platform === "linux" ? probeMxc() : { available: false, error: "not Linux" };
let skip =
	process.platform !== "linux"
		? "Linux only"
		: !probe.available
			? `MXC unavailable: ${probe.error ?? "unknown"}`
			: false;

function config(cwd: string, overrides: Partial<ResolvedSandboxConfig> = {}): ResolvedSandboxConfig {
	return makeResolvedConfig({
		engine: "mxc",
		mxc: {
			backend: "auto",
			shell: "busybox",
			extraReadwrite: [],
			extraReadonly: [],
			extraDenied: [],
		},
		network: "none",
		allowWrite: [{ path: cwd, isDir: true, rule: "." }],
		denyWrite: [],
		denyRead: [],
		denyCreate: [],
		tmp: "private",
		env: { passthrough: ["PATH", "HOME", "TERM", "LANG"], deny: ["*_TOKEN"], set: {} },
		variables: { repo: cwd, worktree: cwd, worktrees: [cwd] },
		gitGuard: NO_GIT_GUARD,
		sources: {
			globalPath: "",
			projectPath: null,
			projectTrusted: true,
			warnings: [],
			projectRoot: cwd,
			worktreeRoot: cwd,
		},
		...overrides,
	});
}

function operationsFor(cfg: ResolvedSandboxConfig) {
	const fallback: BashOperations = {
		async exec() {
			throw new Error("fallback must not run");
		},
	};
	return createSandboxedBashOperations({
		resolveConfig: async () => cfg,
		capabilities: () => ({ available: false, userNamespace: false, procMount: false }),
		mxcCapabilities: (resolved) => probeMxc({ executorPath: resolved.mxc.executorPath }),
		shell: () => ({ shell: "/bin/bash", args: ["-c"] }),
		fallback,
		platform: "linux",
	});
}

// A probe can succeed while the backend still cannot launch (e.g. AppArmor
// denying user namespaces, or an unsupported Windows build). Run one command
// and skip the suite with the real reason instead of failing every test.
if (!skip) {
	const cwd = mkdtempSync(join(tmpdir(), "pibs-mxc-smoke-"));
	try {
		const result = await operationsFor(config(cwd)).exec("echo smoke", cwd, {
			onData: () => {},
			timeout: 20,
		});
		if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode}`);
	} catch (error) {
		skip = `MXC smoke failed: ${(error as Error).message}`;
	}
}

test("MXC bubblewrap streams output, exposes /dev/null, and writes", { skip }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pibs-mxc-linux-"));
	let output = "";
	const result = await operationsFor(config(cwd)).exec(
		"pwd; echo hello-linux; echo x >/dev/null && echo devnull-ok; echo data > out.txt && echo write-ok; git --version",
		cwd,
		{ onData: (data) => (output += data), timeout: 30 },
	);
	assert.equal(result.exitCode, 0);
	assert.match(output, /hello-linux/);
	assert.match(output, /devnull-ok/);
	assert.match(output, /write-ok/);
	assert.match(output, /git version/);
});

test("MXC bubblewrap hides denyRead files and directories", { skip }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pibs-mxc-linux-deny-"));
	const secret = join(cwd, "secret");
	mkdirSync(secret, { recursive: true });
	writeFileSync(join(secret, "private.txt"), "TOPSECRET");
	let output = "";
	const result = await operationsFor(
		config(cwd, { denyRead: [{ path: secret, isDir: true, rule: "secret" }] }),
	).exec("cat secret/private.txt 2>&1; echo done", cwd, { onData: (data) => (output += data), timeout: 30 });
	assert.equal(result.exitCode, 0);
	assert.equal(output.includes("TOPSECRET"), false);
	assert.match(output, /Permission denied|No such file/);
});

test("MXC bubblewrap makes denyWrite files read-only", { skip }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pibs-mxc-linux-ro-"));
	writeFileSync(join(cwd, ".env"), "VISIBLE");
	let output = "";
	const result = await operationsFor(
		config(cwd, { denyWrite: [{ path: join(cwd, ".env"), isDir: false, rule: ".env" }] }),
	).exec("cat .env; echo hacked > .env 2>&1; echo rc=$?", cwd, {
		onData: (data) => (output += data),
		timeout: 30,
	});
	assert.equal(result.exitCode, 0);
	assert.match(output, /VISIBLE/);
	assert.match(output, /Read-only file system/);
});

test("MXC bubblewrap timeout is clean", { skip }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pibs-mxc-linux-to-"));
	let output = "";
	await assert.rejects(
		operationsFor(config(cwd)).exec("echo before; sleep 5; echo after", cwd, {
			onData: (data) => (output += data),
			timeout: 1,
		}),
		/timeout:1/,
	);
	assert.equal(output.includes('"error"'), false);
});

test("MXC bubblewrap abort kills the process tree", { skip }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pibs-mxc-linux-abort-"));
	const controller = new AbortController();
	const promise = operationsFor(config(cwd)).exec("sleep 30", cwd, {
		onData: () => {},
		signal: controller.signal,
	});
	setTimeout(() => controller.abort(), 200);
	await assert.rejects(promise, /aborted/);
});
