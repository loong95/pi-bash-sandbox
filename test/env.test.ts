import assert from "node:assert/strict";
import test from "node:test";
import { matchGlob, resolveSandboxEnv } from "../src/env.ts";

test("matchGlob: literals, star, question mark", () => {
	assert.equal(matchGlob("PATH", "PATH"), true);
	assert.equal(matchGlob("PATHX", "PATH"), false);
	assert.equal(matchGlob("LC_ALL", "LC_*"), true);
	assert.equal(matchGlob("ANTHROPIC_API_KEY", "*_KEY"), true);
	assert.equal(matchGlob("OPENAI_API_KEY", "OPENAI_*"), true);
	assert.equal(matchGlob("AB", "A?"), true);
	assert.equal(matchGlob("ABC", "A?"), false);
});

test("resolveSandboxEnv: passthrough only, deny wins, set wins last", () => {
	const source = {
		PATH: "/usr/bin:/bin",
		HOME: "/home/u",
		TERM: "xterm-256color",
		LC_ALL: "en_US.UTF-8",
		ANTHROPIC_API_KEY: "secret",
		MY_TOKEN: "secret",
		RANDOM_UNLISTED: "nope",
	};

	const env = resolveSandboxEnv(source, {
		passthrough: ["PATH", "HOME", "TERM", "LANG", "LC_*"],
		deny: ["*_KEY", "*_TOKEN"],
		set: { HOME: "/home/u", PATH: "/custom/bin" },
	});

	assert.deepEqual(env, {
		HOME: "/home/u",
		LC_ALL: "en_US.UTF-8",
		PATH: "/custom/bin",
		TERM: "xterm-256color",
	});
});

test("resolveSandboxEnv: keys are sorted for deterministic argv", () => {
	const env = resolveSandboxEnv({ ZED: "1", ALPHA: "2", MIKE: "3" }, {
		passthrough: ["*"],
		deny: [],
		set: {},
	});
	assert.deepEqual(Object.keys(env), ["ALPHA", "MIKE", "ZED"]);
});
