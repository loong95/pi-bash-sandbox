import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { createSandboxedBashOperations } from "../src/exec.ts";
import type { BwrapCapabilities, ResolvedSandboxConfig } from "../src/types.ts";

const CAPS: BwrapCapabilities = { available: true, userNamespace: true, procMount: true };
const SHELL = { shell: "/bin/bash", args: ["-c"] };
const CWD = realpathSync(mkdtempSync(join(tmpdir(), "pibs-exec-")));

function makeConfig(overrides: Partial<ResolvedSandboxConfig> = {}): ResolvedSandboxConfig {
	return {
		enabled: true,
		network: "none",
		allowWrite: [],
		denyWrite: [],
		denyRead: [],
		tmp: "private",
		env: { passthrough: ["PATH"], deny: ["*_TOKEN"], set: {} },
		unsharePid: true,
		weakerNestedSandbox: false,
		onUnavailable: "error",
		extraBwrapArgs: [],
		rules: { allowWrite: [], denyWrite: [], denyRead: [] },
		tools: { enabled: true, requireAllowWrite: true },
		sources: { globalPath: "/g", projectPath: null, projectTrusted: false, warnings: [] },
		...overrides,
	};
}

function fallbackSpy(): { ops: BashOperations; calls: string[] } {
	const calls: string[] = [];
	const ops: BashOperations = {
		async exec(command) {
			calls.push(command);
			return { exitCode: 0 };
		},
	};
	return { ops, calls };
}

function opsFor(
	overrides: Partial<Parameters<typeof createSandboxedBashOperations>[0]> = {},
	config = makeConfig(),
) {
	const { ops, calls } = fallbackSpy();
	const operations = createSandboxedBashOperations({
		resolveConfig: async () => config,
		capabilities: () => CAPS,
		shell: () => SHELL,
		fallback: ops,
		...overrides,
	});
	return { operations, fallbackCalls: calls };
}

test("missing cwd rejects before running anything", async () => {
	const { operations, fallbackCalls } = opsFor();
	await assert.rejects(
		operations.exec("true", join(CWD, "does-not-exist"), { onData: () => {} }),
		/Working directory does not exist/,
	);
	assert.equal(fallbackCalls.length, 0);
});

test("enabled() false delegates to fallback", async () => {
	const { operations, fallbackCalls } = opsFor({ enabled: () => false });
	const result = await operations.exec("echo hi", CWD, { onData: () => {} });
	assert.deepEqual(result, { exitCode: 0 });
	assert.deepEqual(fallbackCalls, ["echo hi"]);
});

test("config.enabled false delegates to fallback", async () => {
	const { operations, fallbackCalls } = opsFor({}, makeConfig({ enabled: false }));
	await operations.exec("echo hi", CWD, { onData: () => {} });
	assert.deepEqual(fallbackCalls, ["echo hi"]);
});

test("bwrap unavailable + onUnavailable=error rejects (fail-closed)", async () => {
	const { operations, fallbackCalls } = opsFor({
		capabilities: () => ({ available: false, userNamespace: false, procMount: false, error: "bwrap not found" }),
	});
	await assert.rejects(operations.exec("true", CWD, { onData: () => {} }), /Sandbox unavailable: bwrap not found/);
	assert.equal(fallbackCalls.length, 0);
});

test("bwrap unavailable + onUnavailable=fallback delegates and notifies", async () => {
	let reason = "";
	const { operations, fallbackCalls } = opsFor(
		{
			capabilities: () => ({ available: false, userNamespace: false, procMount: false, error: "bwrap not found" }),
			onUnavailable: (r) => {
				reason = r;
			},
		},
		makeConfig({ onUnavailable: "fallback" }),
	);
	await operations.exec("echo hi", CWD, { onData: () => {} });
	assert.deepEqual(fallbackCalls, ["echo hi"]);
	assert.equal(reason, "bwrap not found");
});

test("sandboxed command builds argv and filters env (bwrapPath=echo)", async () => {
	const chunks: Buffer[] = [];
	const { operations, fallbackCalls } = opsFor({ bwrapPath: "/bin/echo" });
	await operations.exec("ignored-command", CWD, {
		onData: (data) => chunks.push(data),
		env: { PATH: "/bin", SECRET_TOKEN: "leak" },
	});

	const output = Buffer.concat(chunks).toString();
	assert.equal(fallbackCalls.length, 0);
	assert.match(output, /--clearenv/);
	assert.match(output, /--setenv PATH \/bin/);
	assert.match(output, /--unshare-net/);
	assert.match(output, /--ro-bind \/ \//);
	assert.equal(output.includes("SECRET_TOKEN"), false);
	assert.equal(output.includes("leak"), false);
});
