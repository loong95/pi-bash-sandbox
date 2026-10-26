/**
 * Execute one command through an MXC executor binary.
 *
 * The executor owns the workload stdio and the MXC-side timeout. This module
 * only has to:
 *
 * - translate policy into a `1.0.0` request,
 * - stream stdout/stderr to pi,
 * - translate abort/host errors into pi's `aborted` / `timeout:<seconds>`
 *   contract,
 * - remove the temporary request file (it carries the sandbox env, which may
 *   include credentials).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShellSpec } from "../bwrap.ts";
import { resolveTimeoutMs, waitForChildProcess } from "../child.ts";
import type { MxcShellChoice, ResolvedSandboxConfig } from "../types.ts";
import { buildMxcRequest } from "./request.ts";
import { resolvePosixCommand, resolveWindowsCommand } from "./shell.ts";
import type { MxcBackend, MxcCommandSpec, MxcRequest } from "./types.ts";

/** Keep enough stderr to recover the terminal MXC error object. */
const STDERR_TAIL_BYTES = 64 * 1024;
/**
 * Stderr withheld until the process exits. MXC prints its terminal error as a
 * JSON object on stderr; forwarding it would put parser noise in the tool
 * output for timeouts and policy failures. Keeping a small rolling tail lets
 * us drop exactly that terminal object while still streaming everything else.
 */
const STDERR_HOLDBACK_BYTES = 4096;
/** Backstop above the MXC timeout, for a wedged executor. */
const TIMEOUT_BACKSTOP_MS = 15_000;

export interface RunMxcInput {
	executor: string;
	backend: MxcBackend;
	command: string;
	cwd: string;
	env: Record<string, string>;
	config: ResolvedSandboxConfig;
	posixShell: ShellSpec;
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	/** Timeout in seconds, as pi passes it. */
	timeout?: number;
	platform?: NodeJS.Platform;
	/** Environment for the executor process itself. */
	hostEnv?: NodeJS.ProcessEnv;
	/** Test seam for Windows shell detection. */
	exists?: (path: string) => boolean;
	/** Force the Windows shell (e.g. the PowerShell tool). */
	shellChoice?: MxcShellChoice;
	/** Test seams. */
	createConfigFile?: (request: MxcRequest) => { path: string; cleanup: () => void };
	spawnChild?: typeof spawn;
}

export interface RunMxcResult {
	exitCode: number | null;
}

export interface ResolvedMxcCommand {
	spec?: MxcCommandSpec;
	request?: MxcRequest;
	error?: string;
}

function defaultConfigFile(request: MxcRequest): { path: string; cleanup: () => void } {
	const directory = mkdtempSync(join(tmpdir(), "pi-mxc-"));
	const path = join(directory, "request.json");
	writeFileSync(path, JSON.stringify(request), { encoding: "utf-8", mode: 0o600 });
	return {
		path,
		cleanup: () => {
			try {
				rmSync(directory, { recursive: true, force: true });
			} catch {
				// A transient Windows handle must not fail the command.
			}
		},
	};
}

/** Resolve shell + request without spawning. Used by `/sandbox-test`. */
export function resolveMxcCommand(input: {
	command: string;
	cwd: string;
	env: Record<string, string>;
	config: ResolvedSandboxConfig;
	posixShell: ShellSpec;
	backend: MxcBackend;
	timeout?: number;
	platform?: NodeJS.Platform;
	hostEnv?: NodeJS.ProcessEnv;
	shellChoice?: MxcShellChoice;
	exists?: (path: string) => boolean;
}): ResolvedMxcCommand {
	const platform = input.platform ?? process.platform;
	let spec: MxcCommandSpec | undefined;
	let error: string | undefined;

	if (platform === "win32") {
		const resolved = resolveWindowsCommand({
			choice: input.shellChoice ?? input.config.mxc.shell,
			command: input.command,
			busyboxPath: input.config.mxc.busyboxPath,
			env: input.hostEnv ?? process.env,
			exists: input.exists,
		});
		spec = resolved.spec;
		error = resolved.error;
	} else {
		spec = resolvePosixCommand(input.posixShell, input.command);
	}

	if (!spec) return { error };

	const timeoutMs = resolveTimeoutMs(input.timeout);
	const request = buildMxcRequest({
		command: input.command,
		cwd: input.cwd,
		env: input.env,
		config: input.config,
		shell: spec,
		backend: input.backend,
		platform,
		timeoutMs,
	});
	return { spec, request };
}

function killTree(child: ChildProcess, platform: NodeJS.Platform): void {
	const pid = child.pid;
	if (!pid) return;
	if (platform === "win32") {
		// Node's child.kill() terminates only wxc-exec.exe; the BusyBox/shell
		// descendants would survive. taskkill /T walks the process tree.
		try {
			const killer = spawn(
				join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{ windowsHide: true, stdio: "ignore" },
			);
			killer.on("error", () => {});
		} catch {
			try {
				child.kill();
			} catch {
				// Already gone.
			}
		}
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
}

function extractMxcError(stderr: string): { code?: string; message?: string } | null {
	const index = stderr.lastIndexOf('{"error"');
	if (index < 0) return null;
	try {
		const parsed = JSON.parse(stderr.slice(index).trim()) as {
			error?: { code?: unknown; message?: unknown };
		};
		const error = parsed?.error;
		if (!error || typeof error.message !== "string") return null;
		return {
			code: typeof error.code === "string" ? error.code : undefined,
			message: error.message,
		};
	} catch {
		return null;
	}
}

/** Spawn the executor and stream one workload. */
export async function runMxcCommand(input: RunMxcInput): Promise<RunMxcResult> {
	const platform = input.platform ?? process.platform;
	const timeoutMs = resolveTimeoutMs(input.timeout);
	const resolved = resolveMxcCommand({ ...input, timeout: input.timeout });
	if (!resolved.spec || !resolved.request) {
		throw new Error(`Sandbox unavailable: ${resolved.error ?? "could not resolve the MXC shell"}`);
	}
	const request = resolved.request;
	const spec = resolved.spec;

	const configFile = (input.createConfigFile ?? defaultConfigFile)(request);
	const spawnChild = input.spawnChild ?? spawn;

	const child = spawnChild(input.executor, ["--config", configFile.path], {
		cwd: input.cwd,
		env: input.hostEnv ?? process.env,
		detached: platform !== "win32",
		windowsHide: true,
		stdio: [spec.commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
	});

	if (spec.commandFromStdin) {
		child.stdin?.on("error", () => {});
		child.stdin?.end(input.command);
	}

	let stderrTail = "";
	let pendingStderr: Buffer = Buffer.alloc(0);
	child.stdout?.on("data", (data: Buffer) => input.onData(data));
	child.stderr?.on("data", (data: Buffer) => {
		stderrTail = (stderrTail + data.toString()).slice(-STDERR_TAIL_BYTES);
		pendingStderr = pendingStderr.length ? Buffer.concat([pendingStderr, data]) : data;
		if (pendingStderr.length > STDERR_HOLDBACK_BYTES) {
			const flush = pendingStderr.subarray(0, pendingStderr.length - STDERR_HOLDBACK_BYTES);
			pendingStderr = pendingStderr.subarray(pendingStderr.length - STDERR_HOLDBACK_BYTES);
			input.onData(flush);
		}
	});

	let aborted = false;
	let backstopFired = false;
	let backstop: NodeJS.Timeout | undefined;
	const onAbort = () => {
		aborted = true;
		killTree(child, platform);
	};

	if (timeoutMs !== undefined) {
		backstop = setTimeout(() => {
			backstopFired = true;
			killTree(child, platform);
		}, timeoutMs + TIMEOUT_BACKSTOP_MS);
	}
	if (input.signal) {
		if (input.signal.aborted) onAbort();
		else input.signal.addEventListener("abort", onAbort, { once: true });
	}

	try {
		const exitCode = await waitForChildProcess(child);
		if (aborted || input.signal?.aborted) throw new Error("aborted");

		const mxcError = extractMxcError(stderrTail);
		const timedOut = backstopFired || (mxcError?.message?.includes("timed out") ?? false);
		if (timedOut) throw new Error(`timeout:${input.timeout}`);

		if (exitCode === 255 && mxcError) {
			// Terminal MXC failure: the pending tail is the error object itself.
			throw new Error(`mxc: ${mxcError.message}${mxcError.code ? ` (${mxcError.code})` : ""}`);
		}

		if (pendingStderr.length > 0) input.onData(pendingStderr);
		return { exitCode };
	} finally {
		if (backstop) clearTimeout(backstop);
		if (input.signal) input.signal.removeEventListener("abort", onAbort);
		try {
			configFile.cleanup();
		} catch {
			// Cleanup is best-effort.
		}
	}
}
