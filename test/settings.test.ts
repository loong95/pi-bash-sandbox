import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearShellSettingsCache, resolveShellSettings } from "../src/settings.ts";

function tempDir(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "pibs-settings-")));
}

function withAgentDir(agentDir: string, run: () => void): void {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		run();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
}

test("resolveShellSettings reads shellCommandPrefix and shellPath", () => {
	const root = tempDir();
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases", shellPath: "/bin/bash" }),
	);
	const cwd = join(root, "proj");
	mkdirSync(cwd, { recursive: true });

	withAgentDir(agentDir, () => {
		clearShellSettingsCache();
		assert.deepEqual(resolveShellSettings(cwd, true), {
			commandPrefix: "shopt -s expand_aliases",
			shellPath: "/bin/bash",
		});
	});
});

test("project settings override global when trusted", () => {
	const root = tempDir();
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellCommandPrefix: "global" }));
	const cwd = join(root, "proj");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ shellCommandPrefix: "project" }));

	withAgentDir(agentDir, () => {
		clearShellSettingsCache();
		assert.equal(resolveShellSettings(cwd, true).commandPrefix, "project");
	});
});

test("missing settings fall back to empty", () => {
	const root = tempDir();
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const cwd = join(root, "proj");
	mkdirSync(cwd, { recursive: true });

	withAgentDir(agentDir, () => {
		clearShellSettingsCache();
		assert.deepEqual(resolveShellSettings(cwd, true), {});
	});
});
