import assert from "node:assert/strict";
import test from "node:test";
import { buildBwrapArgs } from "../src/bwrap.ts";
import type { BwrapCapabilities, ResolvedPath, ResolvedSandboxConfig } from "../src/types.ts";

const CAPS: BwrapCapabilities = { available: true, userNamespace: true, procMount: true };
const SHELL = { shell: "/bin/bash", args: ["-c"] };

function dir(path: string, rule = path): ResolvedPath {
	return { path, isDir: true, rule };
}
function file(path: string, rule = path): ResolvedPath {
	return { path, isDir: false, rule };
}

function makeConfig(overrides: Partial<ResolvedSandboxConfig> = {}): ResolvedSandboxConfig {
	return {
		enabled: true,
		network: "none",
		allowWrite: [],
		denyWrite: [],
		denyRead: [],
		tmp: "private",
		env: { passthrough: [], deny: [], set: {} },
		unsharePid: true,
		weakerNestedSandbox: false,
		onUnavailable: "error",
		extraBwrapArgs: [],
		sources: { globalPath: "/global/sandbox.json", projectPath: null, projectTrusted: false, warnings: [] },
		...overrides,
	};
}

test("canonical argv: full golden", () => {
	const args = buildBwrapArgs({
		command: "echo hi",
		cwd: "/tmp/proj",
		env: { PATH: "/usr/bin:/bin", HOME: "/home/u" },
		config: makeConfig({
			allowWrite: [dir("/tmp/proj", ".")],
			denyWrite: [file("/tmp/proj/.env", ".env")],
			denyRead: [dir("/tmp/proj/secret"), file("/tmp/proj/key.txt")],
		}),
		capabilities: CAPS,
		shell: SHELL,
	});

	assert.deepEqual(args, [
		"bwrap",
		"--new-session",
		"--die-with-parent",
		"--clearenv",
		"--setenv",
		"HOME",
		"/home/u",
		"--setenv",
		"PATH",
		"/usr/bin:/bin",
		"--ro-bind",
		"/",
		"/",
		"--dev",
		"/dev",
		"--tmpfs",
		"/tmp",
		"--bind",
		"/tmp/proj",
		"/tmp/proj",
		"--ro-bind",
		"/tmp/proj/.env",
		"/tmp/proj/.env",
		"--tmpfs",
		"/tmp/proj/secret",
		"--ro-bind",
		"/dev/null",
		"/tmp/proj/key.txt",
		"--unshare-net",
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--unshare-cgroup-try",
		"--unshare-user",
		"--cap-drop",
		"ALL",
		"--proc",
		"/proc",
		"--chdir",
		"/tmp/proj",
		"--",
		"/bin/bash",
		"-c",
		"echo hi",
	]);
});

test("denyWrite uses read-only self-bind, never /dev/null", () => {
	const args = buildBwrapArgs({
		command: "true",
		cwd: "/p",
		env: {},
		config: makeConfig({ denyWrite: [file("/p/.env")] }),
		capabilities: CAPS,
		shell: SHELL,
	});
	const selfBind = args.findIndex(
		(value, i) => value === "--ro-bind" && args[i + 1] === "/p/.env" && args[i + 2] === "/p/.env",
	);
	assert.ok(selfBind !== -1);
	assert.equal(args.includes("/dev/null"), false);
});

test("denyRead dir -> tmpfs, file -> /dev/null", () => {
	const args = buildBwrapArgs({
		command: "true",
		cwd: "/p",
		env: {},
		config: makeConfig({ denyRead: [dir("/p/secret"), file("/p/key")] }),
		capabilities: CAPS,
		shell: SHELL,
	});
	const tmpfsSecret = args.findIndex((value, i) => value === "--tmpfs" && args[i + 1] === "/p/secret");
	assert.ok(tmpfsSecret !== -1);
	assert.deepEqual(args.slice(args.indexOf("/dev/null") - 1, args.indexOf("/dev/null") + 2), [
		"--ro-bind",
		"/dev/null",
		"/p/key",
	]);
});

test("denyRead wins over denyWrite for the same path (applied later)", () => {
	const args = buildBwrapArgs({
		command: "true",
		cwd: "/p",
		env: {},
		config: makeConfig({ denyWrite: [file("/p/.env")], denyRead: [file("/p/.env")] }),
		capabilities: CAPS,
		shell: SHELL,
	});
	const selfBind = args.findIndex(
		(value, i) => value === "--ro-bind" && args[i + 1] === "/p/.env" && args[i + 2] === "/p/.env",
	);
	const devNull = args.findIndex(
		(value, i) => value === "--ro-bind" && args[i + 1] === "/dev/null" && args[i + 2] === "/p/.env",
	);
	assert.ok(selfBind !== -1 && devNull !== -1 && devNull > selfBind);
});

test("network host omits --unshare-net", () => {
	const args = buildBwrapArgs({
		command: "true",
		cwd: "/p",
		env: {},
		config: makeConfig({ network: "host" }),
		capabilities: CAPS,
		shell: SHELL,
	});
	assert.equal(args.includes("--unshare-net"), false);
});

test("tmp shared binds /tmp instead of tmpfs", () => {
	const args = buildBwrapArgs({
		command: "true",
		cwd: "/p",
		env: {},
		config: makeConfig({ tmp: "shared" }),
		capabilities: CAPS,
		shell: SHELL,
	});
	assert.equal(args.includes("--tmpfs"), false);
	const i = args.indexOf("--bind");
	assert.deepEqual(args.slice(i, i + 3), ["--bind", "/tmp", "/tmp"]);
});

test("no user namespace -> no --unshare-user / --cap-drop", () => {
	const args = buildBwrapArgs({
		command: "true",
		cwd: "/p",
		env: {},
		config: makeConfig(),
		capabilities: { available: true, userNamespace: false, procMount: true },
		shell: SHELL,
	});
	assert.equal(args.includes("--unshare-user"), false);
	assert.equal(args.includes("--cap-drop"), false);
});

test("weakerNestedSandbox binds /proc instead of mounting it", () => {
	const args = buildBwrapArgs({
		command: "true",
		cwd: "/p",
		env: {},
		config: makeConfig({ weakerNestedSandbox: true }),
		capabilities: CAPS,
		shell: SHELL,
	});
	assert.equal(args.includes("--proc"), false);
	const i = args.findIndex((v, idx) => v === "--bind" && args[idx + 1] === "/proc");
	assert.deepEqual(args.slice(i, i + 3), ["--bind", "/proc", "/proc"]);
});

test("unsharePid false -> no pid flags and no proc mount", () => {
	const args = buildBwrapArgs({
		command: "true",
		cwd: "/p",
		env: {},
		config: makeConfig({ unsharePid: false }),
		capabilities: CAPS,
		shell: SHELL,
	});
	assert.equal(args.includes("--unshare-pid"), false);
	assert.equal(args.includes("--proc"), false);
});

test("extraBwrapArgs are appended after --chdir and before --", () => {
	const args = buildBwrapArgs({
		command: "true",
		cwd: "/p",
		env: {},
		config: makeConfig({ extraBwrapArgs: ["--hostname", "sandbox"] }),
		capabilities: CAPS,
		shell: SHELL,
	});
	const chdir = args.indexOf("--chdir");
	const dash = args.indexOf("--");
	assert.deepEqual(args.slice(chdir + 2, dash), ["--hostname", "sandbox"]);
});

test("stdin command transport omits the command from argv", () => {
	const args = buildBwrapArgs({
		command: "echo hi",
		cwd: "/p",
		env: {},
		config: makeConfig(),
		capabilities: CAPS,
		shell: { shell: "/bin/bash", args: ["-c"], commandTransport: "stdin" },
	});
	assert.deepEqual(args.slice(-2), ["/bin/bash", "-c"]);
	assert.equal(args.includes("echo hi"), false);
});
