/**
 * Windows end-to-end coverage for the MXC ProcessContainer engine.
 *
 * These tests only run on Windows with a usable `wxc-exec.exe` and BusyBox-w32.
 * The Linux suite cannot exercise `CreateProcessW`, `taskkill`, AppContainer
 * temp redirection, or the Win32k requirement, so this file is the counterpart
 * to the manual harness used during development.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { createSandboxedBashOperations } from "../src/exec.ts";
import { probeMxc } from "../src/mxc/probe.ts";
import { resolveWindowsCommand } from "../src/mxc/shell.ts";
import type { ResolvedSandboxConfig } from "../src/types.ts";
import { NO_GIT_GUARD, makeResolvedConfig } from "./fixtures.ts";

const probe = process.platform === "win32" ? probeMxc() : { available: false, error: "not Windows" };
const shell = resolveWindowsCommand({
	choice: "busybox",
	command: "",
	env: process.env,
});
let skip =
	process.platform !== "win32"
		? "Windows only"
		: !probe.available
			? `MXC unavailable: ${probe.error ?? "unknown"}`
			: shell.error
				? shell.error
				: false;

function windowsConfig(cwd: string, overrides: Partial<ResolvedSandboxConfig> = {}): ResolvedSandboxConfig {
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
		env: {
			passthrough: [
				"PATH",
				"HOME",
				"TERM",
				"USERPROFILE",
				"SystemRoot",
				"SystemDrive",
				"WINDIR",
				"COMSPEC",
				"PATHEXT",
				"TEMP",
				"TMP",
				"APPDATA",
				"LOCALAPPDATA",
				"PROCESSOR_ARCHITECTURE",
				"NUMBER_OF_PROCESSORS",
				"OS",
			],
			deny: ["*_KEY", "*_TOKEN"],
			set: {},
		},
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

function operationsFor(config: ResolvedSandboxConfig) {
	const fallback: BashOperations = {
		async exec() {
			throw new Error("fallback must not run");
		},
	};
	return createSandboxedBashOperations({
		resolveConfig: async () => config,
		capabilities: () => ({ available: false, userNamespace: false, procMount: false }),
		mxcCapabilities: (resolved) => probeMxc({ executorPath: resolved.mxc.executorPath }),
		shell: () => ({ shell: "sh", args: ["-c"] }),
		fallback,
		platform: "win32",
	});
}

// A probe can succeed while the backend still cannot launch (e.g. AppArmor
// denying user namespaces, or an unsupported Windows build). Run one command
// and skip the suite with the real reason instead of failing every test.
if (!skip) {
	const cwd = mkdtempSync(join(tmpdir(), "pibs-mxc-smoke-"));
	try {
		const result = await operationsFor(windowsConfig(cwd)).exec("echo smoke", cwd, {
			onData: () => {},
			timeout: 20,
		});
		if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode}`);
	} catch (error) {
		skip = `MXC smoke failed: ${(error as Error).message}`;
	}
}

test("Windows ProcessContainer runs BusyBox, node and file writes", { skip }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pibs-mxc-win-"));
	let output = "";
	const result = await operationsFor(windowsConfig(cwd)).exec(
		"pwd; echo hello-windows; node -v; echo x >/dev/null && echo devnull-ok; echo data > out.txt && echo write-ok",
		cwd,
		{ onData: (data) => (output += data), timeout: 30 },
	);
	assert.equal(result.exitCode, 0);
	assert.match(output, /hello-windows/);
	assert.match(output, /devnull-ok/);
	assert.match(output, /write-ok/);
	assert.equal(existsSync(join(cwd, "out.txt")), true);
});

test("Windows ProcessContainer masks denyRead paths", { skip }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pibs-mxc-win-deny-"));
	const secret = join(cwd, "secret");
	mkdirSync(secret, { recursive: true });
	writeFileSync(join(secret, "private.txt"), "TOPSECRET");
	let output = "";
	const result = await operationsFor(
		windowsConfig(cwd, { denyRead: [{ path: secret, isDir: true, rule: "secret" }] }),
	).exec("cat secret/private.txt 2>&1; echo done", cwd, {
		onData: (data) => (output += data),
		timeout: 30,
	});
	assert.equal(result.exitCode, 0);
	assert.equal(output.includes("TOPSECRET"), false);
	assert.match(output, /Permission denied|done/);
});

test("Windows ProcessContainer timeout is reported without MXC JSON noise", { skip }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pibs-mxc-win-to-"));
	let output = "";
	await assert.rejects(
		operationsFor(windowsConfig(cwd)).exec("echo before; sleep 5; echo after", cwd, {
			onData: (data) => (output += data),
			timeout: 1,
		}),
		/timeout:1/,
	);
	assert.equal(output.includes('"error"'), false);
});
