/**
 * Wiring test for index.ts: drive the extension factory with a mock
 * ExtensionAPI, capture the registered `bash` tool, and run a real command
 * through it. Skipped when bwrap is unavailable.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
	let userBashHandler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;

	const api = {
		registerFlag: (name: string, options: { default?: unknown }) => flags.set(name, options.default),
		getFlag: (name: string) => flags.get(name),
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as Record<string, unknown>),
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, options),
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
			if (event === "user_bash") userBashHandler = handler;
		},
	} as unknown as ExtensionAPI;

	return { api, flags, commands, tools, getUserBash: () => userBashHandler };
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

function projectWithConfig(config: unknown): string {
	const project = realpathSync(mkdtempSync(join(tmpdir(), "pibs-wire-")));
	mkdirSync(join(project, ".pi"), { recursive: true });
	writeFileSync(join(project, ".pi", "sandbox.json"), JSON.stringify(config));
	return project;
}

test("extension registers the bash override, user_bash, and commands", () => {
	const { api, flags, commands, tools, getUserBash } = mockPi();
	piBashSandbox(api);
	assert.ok(flags.has("no-sandbox"));
	assert.equal(tools.has("bash"), true);
	assert.ok(commands.has("sandbox"));
	assert.ok(commands.has("sandbox-reload"));
	assert.ok(getUserBash());
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
