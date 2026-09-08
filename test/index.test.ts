/**
 * Wiring test for index.ts: drive the extension factory with a mock
 * ExtensionAPI, capture the registered `bash` tool, and run a real command
 * through it. Skipped when bwrap is unavailable.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piBashSandbox from "../index.ts";
import { probeBwrap } from "../src/probe.ts";

const skip = probeBwrap().available ? false : "bwrap unavailable";

function mockPi() {
	const flags = new Map<string, unknown>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const tools = new Map<string, Record<string, unknown>>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();

	const api = {
		registerFlag: (name: string, options: { default?: unknown }) => flags.set(name, options.default),
		getFlag: (name: string) => flags.get(name),
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as Record<string, unknown>),
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, options),
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;

	return { api, flags, commands, tools, getHandler: (name: string) => handlers.get(name) };
}

function mockCtx(cwd: string, notifications: string[]) {
	return {
		cwd,
		isProjectTrusted: () => true,
		model: undefined,
		thinkingLevel: undefined,
		sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
		ui: { notify: (message: string) => notifications.push(message) },
	};
}

function bareProject(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "pibs-wire-")));
}

function projectWithConfig(config: unknown): string {
	const project = bareProject();
	mkdirSync(join(project, ".pi"), { recursive: true });
	writeFileSync(join(project, ".pi", "sandbox.json"), JSON.stringify(config));
	return project;
}

test("extension registers the bash override, user_bash, and all commands", () => {
	const { api, flags, commands, tools, getHandler } = mockPi();
	piBashSandbox(api);
	assert.ok(flags.has("no-sandbox"));
	assert.equal(tools.has("bash"), true);
	for (const name of [
		"sandbox",
		"sandbox-reload",
		"sandbox-test",
		"sandbox-why",
		"sandbox-init",
		"sandbox-enable",
		"sandbox-disable",
	]) {
		assert.ok(commands.has(name), `missing /${name}`);
	}
	assert.ok(getHandler("user_bash"));
	assert.ok(getHandler("tool_call"));
});

test("registered bash tool runs commands inside the sandbox", { skip }, async () => {
	const project = projectWithConfig({ filesystem: { allowWrite: ["."] } });
	const { api, tools } = mockPi();
	piBashSandbox(api);

	const tool = tools.get("bash") as {
		execute: (
			id: string,
			params: { command: string },
			signal: undefined,
			onUpdate: undefined,
			ctx: unknown,
		) => Promise<{ content: { type: string; text: string }[] }>;
	};

	const result = await tool.execute("call-1", { command: "echo wired && pwd" }, undefined, undefined, mockCtx(project, []));
	const text = result.content.map((part) => part.text).join("\n");
	assert.match(text, /wired/);
	assert.match(text, new RegExp(project.replace(/[/\\]/g, "\\$&")));
});

test("/sandbox command reports the resolved config", { skip }, async () => {
	const project = projectWithConfig({ network: "host" });
	const notifications: string[] = [];
	const { api, commands } = mockPi();
	piBashSandbox(api);

	await commands.get("sandbox")?.handler("", mockCtx(project, notifications));
	assert.equal(notifications.length, 1);
	assert.match(notifications[0], /bash sandbox: enabled/);
	assert.match(notifications[0], /network: host/);
});

test("tool_call blocks read/write to denyRead paths", { skip }, async () => {
	const project = projectWithConfig({ filesystem: { denyRead: ["secret.txt"] } });
	writeFileSync(join(project, "secret.txt"), "TOPSECRET");
	const { api, getHandler } = mockPi();
	piBashSandbox(api);
	const handler = getHandler("tool_call");
	assert.ok(handler);

	const blocked = (await handler({ toolName: "read", input: { path: "secret.txt" } }, mockCtx(project, []))) as {
		block?: boolean;
		reason?: string;
	};
	assert.equal(blocked.block, true);
	assert.match(blocked.reason ?? "", /denyRead/);

	const allowed = await handler({ toolName: "read", input: { path: "README.md" } }, mockCtx(project, []));
	assert.equal(allowed, undefined);
});

test("tool_call blocks read-only tools (grep/find/ls) on denyRead paths, defaults to cwd", { skip }, async () => {
	const project = projectWithConfig({ filesystem: { denyRead: ["secret"] } });
	mkdirSync(join(project, "secret"), { recursive: true });
	writeFileSync(join(project, "secret", "token.txt"), "TOPSECRET");
	const { api, getHandler } = mockPi();
	piBashSandbox(api);
	const handler = getHandler("tool_call");
	assert.ok(handler);

	for (const toolName of ["read", "grep", "find", "ls"]) {
		const blocked = (await handler(
			{ toolName, input: { path: "secret" } },
			mockCtx(project, []),
		)) as { block?: boolean; reason?: string };
		assert.equal(blocked.block, true, `${toolName} should be blocked`);
		assert.match(blocked.reason ?? "", /denyRead/);
	}

	// Omitted path defaults to cwd, which is not denied.
	const allowed = await handler({ toolName: "ls", input: {} }, mockCtx(project, []));
	assert.equal(allowed, undefined);
});

test("tool_call blocks writes outside allowWrite", { skip }, async () => {
	const project = projectWithConfig({ filesystem: { allowWrite: ["."] } });
	const { api, getHandler } = mockPi();
	piBashSandbox(api);
	const handler = getHandler("tool_call");
	assert.ok(handler);

	const blocked = (await handler(
		{ toolName: "write", input: { path: "/etc/pi-sandbox-probe", content: "x" } },
		mockCtx(project, []),
	)) as { block?: boolean; reason?: string };
	assert.equal(blocked.block, true);
	assert.match(blocked.reason ?? "", /outside allowWrite/);
});

test("/sandbox-disable project writes enabled:false", { skip }, async () => {
	const project = projectWithConfig({ enabled: true });
	const notifications: string[] = [];
	const { api, commands } = mockPi();
	piBashSandbox(api);

	await commands.get("sandbox-disable")?.handler("project", mockCtx(project, notifications));
	const written = JSON.parse(readFileSync(join(project, ".pi", "sandbox.json"), "utf-8"));
	assert.equal(written.enabled, false);
	assert.match(notifications[0], /disabled \(project\)/);
});

test("/sandbox-enable global writes to the agent dir", { skip }, async () => {
	const project = projectWithConfig({ enabled: false });
	const agentDir = join(project, "agent");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const { api, commands } = mockPi();
		piBashSandbox(api);
		await commands.get("sandbox-enable")?.handler("global", mockCtx(project, []));
		const written = JSON.parse(readFileSync(join(agentDir, "sandbox.json"), "utf-8"));
		assert.equal(written.enabled, true);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});

test("/sandbox-init creates a project config", { skip }, async () => {
	const project = bareProject();
	const notifications: string[] = [];
	const { api, commands } = mockPi();
	piBashSandbox(api);

	await commands.get("sandbox-init")?.handler("", mockCtx(project, notifications));
	assert.ok(existsSync(join(project, ".pi", "sandbox.json")));
	assert.match(notifications[0], /Created/);
});

test("/sandbox-test prints the bwrap argv without executing", { skip }, async () => {
	const project = projectWithConfig({ network: "none" });
	const notifications: string[] = [];
	const { api, commands } = mockPi();
	piBashSandbox(api);

	await commands.get("sandbox-test")?.handler("echo hi", mockCtx(project, notifications));
	assert.match(notifications[0], /sandbox: enabled/);
	assert.match(notifications[0], /--unshare-net/);
	assert.match(notifications[0], /--clearenv/);
	assert.match(notifications[0], /echo hi/);
});

test("/sandbox-why explains a blocked path", { skip }, async () => {
	const project = projectWithConfig({ filesystem: { denyRead: ["secret.txt"] } });
	writeFileSync(join(project, "secret.txt"), "TOPSECRET");
	const notifications: string[] = [];
	const { api, commands } = mockPi();
	piBashSandbox(api);

	await commands.get("sandbox-why")?.handler("secret.txt", mockCtx(project, notifications));
	assert.match(notifications[0], /read : BLOCKED/);
	assert.match(notifications[0], /denyRead/);
});
