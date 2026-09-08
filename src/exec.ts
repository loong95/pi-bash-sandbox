/**
 * Sandboxed `BashOperations`.
 *
 * Stateless: every call resolves config for its own cwd, probes bwrap (cached),
 * builds argv, and spawns a fresh `bwrap`. No long-lived sandbox object.
 *
 * Contract mirrors pi's built-in local shell operations:
 * - stdout and stderr both stream through `onData(Buffer)`
 * - abort kills the whole process group and rejects with `Error("aborted")`
 * - timeout kills the process group and rejects with `Error("timeout:<seconds>")`
 */

import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { buildBwrapArgs, type ShellSpec } from "./bwrap.ts";
import { resolveSandboxEnv } from "./env.ts";
import type { BwrapCapabilities, ResolvedSandboxConfig } from "./types.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const EXIT_STDIO_GRACE_MS = 100;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
	}
	return timeoutMs;
}

function killProcessGroup(pid: number | undefined): void {
	if (!pid) return;
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

/**
 * Wait for a child to terminate without hanging on inherited stdio handles.
 * Ported from pi's `utils/child-process.ts` so sandboxed commands behave the
 * same as built-in ones when a detached descendant keeps a pipe open.
 */
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const cleanup = () => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};

		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};

		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) finalize(exitCode);
		};

		const armIdleTimer = () => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
		};

		const onData = () => {
			if (exited && !settled) armIdleTimer();
		};
		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};
		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};
		const onError = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onExit = (code: number | null) => {
			exited = true;
			exitCode = code;
			maybeFinalizeAfterExit();
			if (!settled) armIdleTimer();
		};
		const onClose = (code: number | null) => finalize(code);

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}

export interface SandboxedExecDeps {
	/** Resolve the sandbox config for the command cwd. */
	resolveConfig: (cwd: string) => Promise<ResolvedSandboxConfig>;
	/** Probe bwrap capabilities (cached by the caller/probe module). */
	capabilities: () => BwrapCapabilities;
	/** Resolve the shell to run inside the sandbox. */
	shell: () => ShellSpec;
	/** Whether sandboxing is enabled at all (e.g. `--no-sandbox`). Default: true. */
	enabled?: () => boolean;
	/** Operations used when disabled or when policy is "fallback". */
	fallback: BashOperations;
	/** Override the bwrap binary (tests). */
	bwrapPath?: string;
	/** Called when bwrap is unavailable and policy is "fallback". */
	onUnavailable?: (reason: string, cwd: string) => void;
}

async function runSandboxed(
	argv: string[],
	input: {
		command: string;
		cwd: string;
		commandFromStdin: boolean;
		onData: (data: Buffer) => void;
		signal?: AbortSignal;
		timeout?: number;
	},
): Promise<{ exitCode: number | null }> {
	const timeoutMs = resolveTimeoutMs(input.timeout);
	const [bin, ...args] = argv;

	const child = spawn(bin, args, {
		cwd: input.cwd,
		detached: process.platform !== "win32",
		stdio: [input.commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
		windowsHide: true,
	});

	if (input.commandFromStdin) {
		child.stdin?.on("error", () => {});
		child.stdin?.end(input.command);
	}

	let timedOut = false;
	let timeoutHandle: NodeJS.Timeout | undefined;
	const onAbort = () => killProcessGroup(child.pid);

	if (timeoutMs !== undefined) {
		timeoutHandle = setTimeout(() => {
			timedOut = true;
			killProcessGroup(child.pid);
		}, timeoutMs);
	}
	if (input.signal) {
		if (input.signal.aborted) onAbort();
		else input.signal.addEventListener("abort", onAbort, { once: true });
	}

	child.stdout?.on("data", input.onData);
	child.stderr?.on("data", input.onData);

	try {
		const exitCode = await waitForChildProcess(child);
		if (input.signal?.aborted) throw new Error("aborted");
		if (timedOut) throw new Error(`timeout:${input.timeout}`);
		return { exitCode };
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		if (input.signal) input.signal.removeEventListener("abort", onAbort);
	}
}

export function createSandboxedBashOperations(deps: SandboxedExecDeps): BashOperations {
	return {
		async exec(command, cwd, options) {
			const { onData, signal, timeout, env } = options;
			if (signal?.aborted) throw new Error("aborted");

			try {
				await access(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			}

			if (deps.enabled && !deps.enabled()) {
				return deps.fallback.exec(command, cwd, options);
			}

			const config = await deps.resolveConfig(cwd);
			if (!config.enabled) {
				return deps.fallback.exec(command, cwd, options);
			}

			const capabilities = deps.capabilities();
			if (!capabilities.available) {
				if (config.onUnavailable === "error") {
					throw new Error(
						`Sandbox unavailable: ${capabilities.error ?? "bubblewrap is not usable"}. Run /sandbox for details.`,
					);
				}
				deps.onUnavailable?.(capabilities.error ?? "bubblewrap unavailable", cwd);
				return deps.fallback.exec(command, cwd, options);
			}

			const sourceEnv = env ?? process.env;
			const sandboxEnv = resolveSandboxEnv(sourceEnv, config.env);
			const shell = deps.shell();
			const argv = buildBwrapArgs({
				command,
				cwd,
				env: sandboxEnv,
				config,
				capabilities,
				shell,
				bwrapPath: deps.bwrapPath,
			});

			return runSandboxed(argv, {
				command,
				cwd,
				commandFromStdin: shell.commandTransport === "stdin",
				onData,
				signal,
				timeout,
			});
		},
	};
}
