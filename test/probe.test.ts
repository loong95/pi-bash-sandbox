import assert from "node:assert/strict";
import test from "node:test";
import { clearProbeCache, probeBwrap, type ProbeResult } from "../src/probe.ts";

const ok: ProbeResult = { status: 0, stdout: "", stderr: "" };
const fail = (stderr: string): ProbeResult => ({ status: 1, stdout: "", stderr });

test("missing bwrap -> unavailable with reason", () => {
	clearProbeCache();
	const caps = probeBwrap({
		run: () => ({ status: null, stdout: "", stderr: "", error: new Error("spawn bwrap ENOENT") }),
	});
	assert.equal(caps.available, false);
	assert.match(caps.error ?? "", /not found/);
});

test("full smoke success -> userns + proc available, version parsed", () => {
	clearProbeCache();
	const run = (_command: string, args: string[]): ProbeResult =>
		args[0] === "--version" ? { status: 0, stdout: "bubblewrap 0.9.0\n", stderr: "" } : ok;
	const caps = probeBwrap({ run });
	assert.deepEqual(
		{
			available: caps.available,
			userNamespace: caps.userNamespace,
			procMount: caps.procMount,
			version: caps.version,
		},
		{ available: true, userNamespace: true, procMount: true, version: "0.9.0" },
	);
});

test("restricted userns -> available but weaker, with a note", () => {
	clearProbeCache();
	let smokeCalls = 0;
	const run = (_command: string, args: string[]): ProbeResult => {
		if (args[0] === "--version") return { status: 0, stdout: "bubblewrap 0.9.0", stderr: "" };
		smokeCalls += 1;
		return smokeCalls === 1 ? fail("No permissions to create new namespace") : ok;
	};
	const caps = probeBwrap({ run });
	assert.equal(caps.available, true);
	assert.equal(caps.userNamespace, false);
	assert.equal(caps.procMount, false);
	assert.match(caps.error ?? "", /user namespace/);
});

test("both smoke tests fail -> unavailable", () => {
	clearProbeCache();
	const run = (_command: string, args: string[]): ProbeResult =>
		args[0] === "--version" ? { status: 0, stdout: "0.9.0", stderr: "" } : fail("operation not permitted");
	const caps = probeBwrap({ run });
	assert.equal(caps.available, false);
	assert.match(caps.error ?? "", /operation not permitted/);
});

test("probe results are cached within the TTL", () => {
	clearProbeCache();
	let calls = 0;
	const run = (): ProbeResult => {
		calls += 1;
		return ok;
	};
	probeBwrap({ run, now: () => 1000, ttlMs: 60_000 });
	probeBwrap({ run, now: () => 1000, ttlMs: 60_000 });
	assert.equal(calls, 2); // one --version + one full smoke
});
