import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
	chooseSandboxEngine,
	createSandboxedBashOperations,
} from "../src/exec.ts";
import { checkMxcNetwork } from "../src/mxc/network.ts";
import { clearMxcProbeCache, findMxcExecutor, probeMxc } from "../src/mxc/probe.ts";
import {
	buildMxcRequest,
	mxcReadonlyRoots,
	networkPolicy,
	resolveMxcBackend,
	resolveRequestedBackend,
} from "../src/mxc/request.ts";
import {
	quoteWindowsArg,
	resolvePosixCommand,
	resolveWindowsCommand,
} from "../src/mxc/shell.ts";
import type { ResolvedSandboxConfig } from "../src/types.ts";
import { makeResolvedConfig } from "./fixtures.ts";

const WORK = "D:\\work";
const CWD = "D:\\work";

function windowsConfig(overrides: Partial<ResolvedSandboxConfig> = {}): ResolvedSandboxConfig {
	return makeResolvedConfig({
		engine: "mxc",
		mxc: {
			backend: "auto",
			shell: "busybox",
			busyboxPath: "C:\\tools\\busybox.exe",
			extraReadwrite: [],
			extraReadonly: [],
			extraDenied: [],
		},
		network: "none",
		allowWrite: [{ path: WORK, isDir: true, rule: "." }],
		denyWrite: [{ path: "D:\\work\\.env", isDir: false, rule: ".env" }],
		denyRead: [{ path: "C:\\Users\\me\\.ssh", isDir: true, rule: "~/.ssh" }],
		env: { passthrough: ["PATH"], deny: [], set: {} },
		...overrides,
	});
}

const WINDOWS_SHELL = resolveWindowsCommand({
	choice: "busybox",
	command: "echo hi",
	busyboxPath: "C:\\tools\\busybox.exe",
	env: { Path: "C:\\Windows\\System32", PATHEXT: ".COM;.EXE" },
	exists: (path) => path === "C:\\tools\\busybox.exe",
}).spec!;

const WINDOWS_ENV = {
	PATH: "C:\\Windows\\System32;C:\\tools",
	SystemRoot: "C:\\Windows",
	USERPROFILE: "C:\\Users\\me",
};

test("linux backend maps denyWrite to read-only and denyRead to masked paths", () => {
	const config = makeResolvedConfig({
		engine: "mxc",
		network: "none",
		allowWrite: [{ path: "/work", isDir: true, rule: "." }],
		denyWrite: [{ path: "/work/.env", isDir: false, rule: ".env" }],
		denyRead: [{ path: "/home/me/.ssh", isDir: true, rule: "~/.ssh" }],
		tmp: "shared",
	});
	const shell = resolvePosixCommand({ shell: "/bin/bash", args: ["-c"] }, "echo hi");
	const request = buildMxcRequest({
		command: "echo hi",
		cwd: "/work",
		env: { PATH: "/bin" },
		config,
		shell,
		backend: "bubblewrap",
		platform: "linux",
		readdir: () => ["bin", "dev", "proc", "sys", "tmp", "home", "lost+found"],
		exists: () => true,
		readable: (path) => path !== "/lost+found",
		hostTmpdir: "/tmp",
	});

	assert.equal(request.containment, "bubblewrap");
	assert.equal(request.ui.disable, true);
	assert.deepEqual(request.filesystem.readwritePaths, ["/work", "/tmp"]);
	assert.deepEqual(request.filesystem.readonlyPaths, ["/bin", "/home", "/work/.env"]);
	assert.deepEqual(request.filesystem.deniedPaths, ["/home/me/.ssh"]);
	assert.deepEqual(request.network, {
		egress: { default: "deny" },
		ingress: { default: "deny", hostLoopback: "deny" },
	});
	assert.equal(request.process.commandLine, "/bin/bash -c 'echo hi'");
});

test("linux network host uses a private namespace (no ingress or host loopback)", () => {
	const config = makeResolvedConfig({ engine: "mxc", network: "host" });
	assert.deepEqual(networkPolicy(config, "linux"), {
		egress: { default: "allow" },
		ingress: { default: "deny", hostLoopback: "deny" },
	});
	assert.deepEqual(networkPolicy(config, "win32"), {
		egress: { default: "allow" },
		ingress: { default: "allow", hostLoopback: "allow" },
	});
});

test("windows request uses drive roots, busybox and UI enabled", () => {
	const request = buildMxcRequest({
		command: "echo hi",
		cwd: CWD,
		env: WINDOWS_ENV,
		config: windowsConfig(),
		shell: WINDOWS_SHELL,
		backend: "processcontainer",
		platform: "win32",
		exists: (path) => path === "C:\\" || path === "D:\\" || path === "D:\\work\\.env",
		readable: () => true,
	});

	assert.equal(request.containment, "processcontainer");
	assert.equal(request.ui.disable, false);
	assert.deepEqual(request.filesystem.readwritePaths, [WORK]);
	assert.deepEqual(request.filesystem.readonlyPaths, ["C:\\", "D:\\", "D:\\work\\.env"]);
	assert.deepEqual(request.filesystem.deniedPaths, ["C:\\Users\\me\\.ssh"]);
	assert.equal(request.process.cwd, CWD);
	assert.ok(request.process.env.includes("HOME=C:\\Users\\me"));
	assert.match(request.process.commandLine, /^C:\\tools\\busybox\.exe sh -c "echo hi"$/);
});

test("windows cwd that no writable grant covers is added read-only", () => {
	const request = buildMxcRequest({
		command: "echo hi",
		cwd: "C:\\elsewhere",
		env: WINDOWS_ENV,
		config: windowsConfig(),
		shell: WINDOWS_SHELL,
		backend: "processcontainer",
		platform: "win32",
		exists: (path) => path === "C:\\" || path === "D:\\" || path === "D:\\work\\.env",
		readable: () => true,
	});
	assert.ok(request.filesystem.readonlyPaths.includes("C:\\elsewhere"));
});

test("macos request uses seatbelt and a read-only root", () => {
	const request = buildMxcRequest({
		command: "echo hi",
		cwd: "/Users/me/work",
		env: { PATH: "/bin" },
		config: makeResolvedConfig({ engine: "mxc", network: "host" }),
		shell: resolvePosixCommand({ shell: "/bin/bash", args: ["-c"] }, "echo hi"),
		backend: "seatbelt",
		platform: "darwin",
	});
	assert.equal(request.containment, "seatbelt");
	assert.equal(request.ui.disable, true);
	assert.ok(request.filesystem.readonlyPaths.includes("/"));
	assert.deepEqual(request.network, {
		egress: { default: "allow" },
		ingress: { default: "allow", hostLoopback: "allow" },
	});
});

test("readonly roots exclude virtual filesystems and unreadable directories", () => {
	assert.deepEqual(
		mxcReadonlyRoots("linux", {
			readdir: () => ["bin", "dev", "proc", "sys", "tmp", "home", "lost+found"],
			exists: () => true,
			readable: (path) => path !== "/lost+found",
		}),
		["/bin", "/home"],
	);
	assert.deepEqual(
		mxcReadonlyRoots("win32", {
			exists: (path) => path === "C:\\" || path === "D:\\",
			readable: () => true,
		}),
		["C:\\", "D:\\"],
	);
	assert.deepEqual(mxcReadonlyRoots("darwin"), ["/"]);
});

test("backend defaults are platform appropriate", () => {
	assert.equal(resolveMxcBackend("auto", "win32"), "processcontainer");
	assert.equal(resolveMxcBackend("auto", "linux"), "bubblewrap");
	assert.equal(resolveMxcBackend("auto", "darwin"), "seatbelt");
	assert.equal(resolveMxcBackend("seatbelt", "win32"), "seatbelt");
	assert.equal(resolveRequestedBackend("seatbelt", "bubblewrap", "linux"), "seatbelt");
	assert.equal(resolveRequestedBackend("auto", "processcontainer", "win32"), "processcontainer");
	assert.equal(resolveRequestedBackend("auto", undefined, "linux"), "bubblewrap");
});

test("windows quoting follows the MSVC CRT rules", () => {
	assert.equal(quoteWindowsArg("echo"), "echo");
	assert.equal(quoteWindowsArg("echo hi"), '"echo hi"');
	assert.equal(quoteWindowsArg('say "hi"'), '"say \\"hi\\""');
	assert.equal(quoteWindowsArg("a b\\"), '"a b\\\\"');
	assert.equal(quoteWindowsArg(""), '""');
});

test("windows shell resolution covers busybox, missing busybox, and cmd", () => {
	const exists = (path: string) => path === "C:\\tools\\busybox.exe" || path === "C:\\Windows\\System32\\cmd.exe";
	const busybox = resolveWindowsCommand({
		choice: "busybox",
		command: "echo hi",
		busyboxPath: "C:\\tools\\busybox.exe",
		env: {},
		exists,
	});
	assert.equal(busybox.error, undefined);
	assert.equal(busybox.spec?.allowsUi, true);
	assert.match(busybox.spec!.commandLine, /busybox\.exe sh -c "echo hi"$/);

	const missing = resolveWindowsCommand({ choice: "busybox", command: "echo hi", env: {}, exists });
	assert.match(missing.error ?? "", /busybox\.exe not found/);

	const cmd = resolveWindowsCommand({
		choice: "cmd",
		command: "echo hi",
		env: { SystemRoot: "C:\\Windows" },
		exists,
	});
	assert.equal(cmd.spec?.allowsUi, false);
	assert.match(cmd.spec!.commandLine, /cmd\.exe.*\/d \/s \/c "echo hi"$/);
});

test("executor lookup is platform and architecture aware", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pibs-mxc-pkg-")));
	mkdirSync(join(root, "bin", "x64"), { recursive: true });
	mkdirSync(join(root, "bin", "arm64"), { recursive: true });
	writeFileSync(join(root, "bin", "x64", "lxc-exec"), "");
	writeFileSync(join(root, "bin", "x64", "wxc-exec.exe"), "");
	writeFileSync(join(root, "bin", "arm64", "mxc-exec-mac"), "");
	writeFileSync(join(root, "bin", "arm64", "wxc-exec.exe"), "");

	assert.match(findMxcExecutor({ packageRoot: root, platform: "linux", arch: "x64" }).executor ?? "", /lxc-exec$/);
	assert.match(
		findMxcExecutor({ packageRoot: root, platform: "win32", arch: "x64" }).executor ?? "",
		/wxc-exec\.exe$/,
	);
	assert.match(
		findMxcExecutor({ packageRoot: root, platform: "darwin", arch: "arm64" }).executor ?? "",
		/mxc-exec-mac$/,
	);
	assert.match(
		findMxcExecutor({ packageRoot: root, platform: "darwin", arch: "x64" }).error ?? "",
		/no macOS x64 binary/,
	);
	assert.match(
		findMxcExecutor({ packageRoot: root, platform: "linux", arch: "ia32" }).error ?? "",
		/architecture ia32/,
	);
});

function fakeExecutor(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pibs-mxc-probe-")));
	mkdirSync(join(root, "bin", "x64"), { recursive: true });
	writeFileSync(join(root, "bin", "x64", "lxc-exec"), "");
	writeFileSync(join(root, "bin", "x64", "wxc-exec.exe"), "");
	return root;
}

test("windows probe parses ProcessContainer capability facts", () => {
	clearMxcProbeCache();
	const root = fakeExecutor();
	const result = probeMxc({
		packageRoot: root,
		platform: "win32",
		arch: "x64",
		run: () => ({
			status: 0,
			stdout: JSON.stringify({ tier: "base-container", probes: { baseContainerApiPresent: true } }),
			stderr: "",
		}),
	});
	assert.equal(result.available, true);
	assert.equal(result.backend, "processcontainer");
	assert.equal(result.tier, "base-container");
});

test("windows probe reports missing BaseContainer API", () => {
	clearMxcProbeCache();
	const root = fakeExecutor();
	const result = probeMxc({
		packageRoot: root,
		platform: "win32",
		arch: "x64",
		run: () => ({ status: 0, stdout: JSON.stringify({ probes: { baseContainerApiPresent: false } }), stderr: "" }),
	});
	assert.equal(result.available, false);
	assert.match(result.error ?? "", /BaseContainer/);
});

test("linux probe finds bubblewrap in backend discovery", () => {
	clearMxcProbeCache();
	const root = fakeExecutor();
	const result = probeMxc({
		packageRoot: root,
		platform: "linux",
		arch: "x64",
		run: () => ({ status: 0, stdout: JSON.stringify([{ backend: "bubblewrap" }]), stderr: "" }),
	});
	assert.equal(result.available, true);
	assert.equal(result.backend, "bubblewrap");
});

test("macos probe enforces the Seatbelt minimum version", () => {
	clearMxcProbeCache();
	const root = fakeExecutor();
	mkdirSync(join(root, "bin", "arm64"), { recursive: true });
	writeFileSync(join(root, "bin", "arm64", "mxc-exec-mac"), "");
	const old = probeMxc({ packageRoot: root, platform: "darwin", arch: "arm64", macosVersion: "14.7" });
	assert.equal(old.available, false);
	assert.match(old.error ?? "", /macOS 15/);
	clearMxcProbeCache();
	const current = probeMxc({ packageRoot: root, platform: "darwin", arch: "arm64", macosVersion: "15.1" });
	assert.equal(current.available, true);
	assert.equal(current.backend, "seatbelt");
});

test("MXC network host on Linux requires slirp4netns", () => {
	const empty = checkMxcNetwork("host", "linux", { PATH: "" });
	assert.equal(empty.ok, false);
	assert.match(empty.error ?? "", /slirp4netns/);

	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pibs-slirp-")));
	writeFileSync(join(dir, "slirp4netns"), "");
	assert.equal(checkMxcNetwork("host", "linux", { PATH: dir }).ok, true);
	assert.equal(checkMxcNetwork("none", "linux", { PATH: "" }).ok, true);
	assert.equal(checkMxcNetwork("host", "win32", { PATH: "" }).ok, true);
});

test("engine selection prefers MXC but falls back on Linux", () => {
	const config = makeResolvedConfig({ engine: "auto", network: "none" });
	assert.equal(chooseSandboxEngine(config, true, "linux"), "mxc");
	assert.equal(chooseSandboxEngine(config, false, "linux"), "bwrap");
	assert.equal(chooseSandboxEngine(config, true, "linux", false), "bwrap");
	assert.equal(chooseSandboxEngine(config, false, "win32"), "mxc");
	assert.equal(chooseSandboxEngine(config, false, "darwin"), "mxc");
	assert.equal(chooseSandboxEngine({ ...config, engine: "bwrap" }, true, "linux"), "bwrap");
	assert.equal(chooseSandboxEngine({ ...config, engine: "mxc" }, false, "linux"), "mxc");
});

function winUnavailableConfig(overrides: Partial<ResolvedSandboxConfig> = {}): ResolvedSandboxConfig {
	const base = makeResolvedConfig({ engine: "mxc", ...overrides });
	return { ...base, mxc: { ...base.mxc, busyboxPath: "C:\\tools\\busybox.exe" } };
}

function fallbackSpy(): { ops: BashOperations; calls: string[] } {
	const calls: string[] = [];
	return {
		ops: {
			async exec(command) {
				calls.push(command);
				return { exitCode: 0 };
			},
		},
		calls,
	};
}

test("MXC unavailable honors onUnavailable=error", async () => {
	const { ops } = fallbackSpy();
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pibs-mxc-err-")));
	const operations = createSandboxedBashOperations({
		resolveConfig: async () => winUnavailableConfig(),
		capabilities: () => ({ available: false, userNamespace: false, procMount: false }),
		mxcCapabilities: () => ({ available: false, error: "no executor" }),
		shell: () => ({ shell: "/bin/bash", args: ["-c"] }),
		fallback: ops,
		hostEnv: {},
		exists: () => true,
		platform: "win32",
	});
	await assert.rejects(operations.exec("echo hi", cwd, { onData: () => {} }), /Sandbox unavailable: no executor/);
});

test("MXC unavailable honors onUnavailable=fallback", async () => {
	const { ops, calls } = fallbackSpy();
	let reason = "";
	const operations = createSandboxedBashOperations({
		resolveConfig: async () => winUnavailableConfig({ onUnavailable: "fallback" }),
		capabilities: () => ({ available: false, userNamespace: false, procMount: false }),
		mxcCapabilities: () => ({ available: false, error: "no executor" }),
		shell: () => ({ shell: "/bin/bash", args: ["-c"] }),
		fallback: ops,
		hostEnv: {},
		exists: () => true,
		platform: "win32",
		onUnavailable: (r) => {
			reason = r;
		},
	});
	// The test path must exist for the initial cwd check.
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pibs-mxc-fb-")));
	await operations.exec("echo hi", cwd, { onData: () => {} });
	assert.deepEqual(calls, ["echo hi"]);
	assert.equal(reason, "no executor");
});

test("mxc.extra* policy paths are layered into the request", () => {
	const config = windowsConfig({
		mxc: {
			backend: "auto",
			shell: "busybox",
			busyboxPath: "C:\\tools\\busybox.exe",
			extraReadwrite: [{ path: "D:\\tools", isDir: true, rule: "D:\\tools" }],
			extraReadonly: [{ path: "D:\\shared", isDir: true, rule: "D:\\shared" }],
			extraDenied: [{ path: "D:\\secrets", isDir: true, rule: "D:\\secrets" }],
		},
	});
	const request = buildMxcRequest({
		command: "echo hi",
		cwd: CWD,
		env: WINDOWS_ENV,
		config,
		shell: WINDOWS_SHELL,
		backend: "processcontainer",
		platform: "win32",
		exists: () => true,
		readable: () => true,
	});
	assert.ok(request.filesystem.readwritePaths.includes("D:\\tools"));
	assert.ok(request.filesystem.readonlyPaths.includes("D:\\shared"));
	assert.ok(request.filesystem.deniedPaths.includes("D:\\secrets"));
});
