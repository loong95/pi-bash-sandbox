import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CONFIG_TEMPLATE,
	configPathForScope,
	setConfigEnabled,
	writeConfigTemplate,
} from "../src/config-write.ts";

function tempDir(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "pibs-cfgwrite-")));
}

test("configPathForScope picks global vs worktree-local project path", () => {
	const input = { projectRoot: "/repo", worktreeRoot: "/repo/wt", agentDir: "/agent" };
	assert.equal(configPathForScope("global", input), join("/agent", "sandbox.json"));
	assert.equal(configPathForScope("project", input), join("/repo/wt", ".pi", "sandbox.json"));
});

test("setConfigEnabled creates the file", () => {
	const path = join(tempDir(), ".pi", "sandbox.json");
	setConfigEnabled(path, false);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), { enabled: false });
});

test("setConfigEnabled preserves other keys", () => {
	const path = join(tempDir(), "sandbox.json");
	writeFileSync(path, JSON.stringify({ network: "host", enabled: true }));
	setConfigEnabled(path, false);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), { network: "host", enabled: false });
});

test("setConfigEnabled rejects non-object JSON", () => {
	const path = join(tempDir(), "sandbox.json");
	writeFileSync(path, "[]");
	assert.throws(() => setConfigEnabled(path, true), /not a JSON object/);
});

test("writeConfigTemplate creates the template and refuses to overwrite", () => {
	const path = join(tempDir(), ".pi", "sandbox.json");
	writeConfigTemplate(path);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), CONFIG_TEMPLATE);
	assert.throws(() => writeConfigTemplate(path), /already exists/);
});
