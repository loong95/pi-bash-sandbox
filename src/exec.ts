/**
 * Sandboxed `BashOperations` dispatcher.
 *
 * Stateless: every call resolves config for its own cwd, selects an engine,
 * and spawns a fresh sandbox. No long-lived sandbox object.
 *
 * Engines:
 * - `mxc`: Microsoft eXecution Container (bubblewrap / Seatbelt /
 *   ProcessContainer), invoked through its standalone executor binary.
 * - `bwrap`: the original bubblewrap argument builder, used on Linux as the
 *   fallback when MXC is unavailable.
 *
 * `engine: "auto"` (default) prefers MXC and falls back to bwrap on Linux.
 *
 * Contract mirrors pi's built-in local shell operations:
 * - stdout and stderr both stream through `onData(Buffer)`
 * - abort kills the whole process tree and rejects with `Error("aborted")`
 * - timeout kills the process tree and rejects with `Error("timeout:<seconds>")`
 */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { buildBwrapArgs, type ShellSpec } from "./bwrap.ts";
import { resolveTimeoutMs, waitForChildProcess } from "./child.ts";
import { resolveSandboxEnv } from "./env.ts";
import { runMxcCommand } from "./mxc/exec.ts";
import { checkMxcNetwork } from "./mxc/network.ts";
import { resolveRequestedBackend } from "./mxc/request.ts";
import { resolveWindowsCommand } from "./mxc/shell.ts";
import type { MxcCapabilities } from "./mxc/types.ts";
import type { BwrapCapabilities, MxcShellChoice, ResolvedSandboxConfig } from "./types.ts";

export interface SandboxedExecDeps {
	/** Resolve the sandbox config for the command cwd. */
	resolveConfig: (cwd: string) => Promise<ResolvedSandboxConfig>;
	/** Probe bwrap capabilities (cached by the caller/probe module). */
	capabilities: () => BwrapCapabilities;
	/** Probe MXC availability (cached by the caller/probe module). */
	mxcCapabilities?: (config: ResolvedSandboxConfig) => MxcCapabilities;
	/** Resolve the POSIX shell used inside the sandbox (Linux/macOS). */
	shell: () => ShellSpec;
	/** Whether sandboxing is enabled at all (e.g. `--no-sandbox`). Default: true. */
	enabled?: () => boolean;
	/** Operations used when disabled or when policy is "fallback". */
	fallback: BashOperations;
	/** Override the bwrap binary (tests). */
	bwrapPath?: string;
	/** Host environment for the MXC executor process (tests). */
	hostEnv?: NodeJS.ProcessEnv;
	/** Test seam for Windows shell detection. */
	exists?: (path: string) => boolean;
	/** Force the Windows shell for this operations instance (PowerShell tool). */
	mxcShell?: MxcShellChoice;
	/** Called when the selected engine is unavailable and policy is "fallback". */
	onUnavailable?: (reason: string, cwd: string) => void;
	platform?: NodeJS.Platform;
}

export type SandboxEngine = "mxc" | "bwrap";

function unavailableReason(error: string | undefined, fallback: string): string {
	return error && error.trim().length > 0 ? error : fallback;
}

/** Engine selection shared by execution, `/sandbox`, and `/sandbox-test`. */
export function chooseSandboxEngine(
	config: ResolvedSandboxConfig,
	mxcAvailable: boolean,
	platform: NodeJS.Platform = process.platform,
	mxcNetworkOk = true,
): SandboxEngine {
	if (config.engine === "bwrap") return "bwrap";
	if (config.engine === "mxc") return "mxc";
	// auto: Windows/macOS have no bubblewrap fallback.
	if (platform === "win32" || platform === "darwin") return "mxc";
	return mxcAvailable && mxcNetworkOk ? "mxc" : "bwrap";
}

export function selectSandboxEngine(
	config: ResolvedSandboxConfig,
	deps: SandboxedExecDeps,
	platform: NodeJS.Platform,
): SandboxEngine {
	// Avoid probing MXC when the user explicitly selected bwrap.
	if (config.engine === "bwrap") return "bwrap";
	const network = checkMxcNetwork(config.network, platform, deps.hostEnv ?? process.env);
	return chooseSandboxEngine(
		config,
		deps.mxcCapabilities?.(config).available ?? false,
		platform,
		network.ok,
	);
}

async function runBwrap(
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
	const [bin, ...args] = argv;
	const platform = process.platform;

	const child = spawn(bin, args, {
		cwd: input.cwd,
		detached: platform !== "win32",
		stdio: [input.commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
		windowsHide: true,
	});

	if (input.commandFromStdin) {
		child.stdin?.on("error", () => {});
		child.stdin?.end(input.command);
	}

	let timedOut = false;
	let timeoutHandle: NodeJS.Timeout | undefined;
	const onAbort = () => {
		if (!child.pid) return;
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			try {
				process.kill(child.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	};

	if (input.timeout !== undefined) {
		const timeoutMs = input.timeout * 1000;
		timeoutHandle = setTimeout(() => {
			timedOut = true;
			onAbort();
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
	const platform = deps.platform ?? process.platform;

	return {
		async exec(command, cwd, options) {
			const { onData, signal, timeout, env } = options;
			if (signal?.aborted) throw new Error("aborted");
			resolveTimeoutMs(timeout);

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

			const engine = selectSandboxEngine(config, deps, platform);

			if (engine === "mxc") {
				const capabilities = deps.mxcCapabilities?.(config) ?? {
					available: false,
					error: "MXC support is not wired into this command",
				};
				const network = checkMxcNetwork(config.network, platform, deps.hostEnv ?? process.env);
				const shellError =
					platform === "win32"
						? resolveWindowsCommand({
								choice: deps.mxcShell ?? config.mxc.shell,
								command: "",
								busyboxPath: config.mxc.busyboxPath,
								env: deps.hostEnv ?? process.env,
								exists: deps.exists,
							}).error
						: undefined;
				if (!capabilities.available || !capabilities.executor || !network.ok || shellError) {
					const reason = unavailableReason(
						shellError ?? (!network.ok ? network.error : capabilities.error),
						"MXC is not available",
					);
					if (config.onUnavailable === "error") {
						throw new Error(`Sandbox unavailable: ${reason}. Run /sandbox for details.`);
					}
					deps.onUnavailable?.(reason, cwd);
					return deps.fallback.exec(command, cwd, options);
				}

				return runMxcCommand({
					executor: capabilities.executor,
					backend: resolveRequestedBackend(config.mxc.backend, capabilities.backend, platform),
					command,
					cwd,
					env: resolveSandboxEnv(env ?? process.env, config.env, platform),
					config,
					posixShell:
						platform === "win32" ? { shell: "sh", args: ["-c"] } : deps.shell(),
					onData,
					signal,
					timeout,
					platform,
					hostEnv: deps.hostEnv ?? process.env,
					shellChoice: deps.mxcShell,
					exists: deps.exists,
				});
			}

			const capabilities = deps.capabilities();
			if (!capabilities.available) {
				const reason = unavailableReason(capabilities.error, "bubblewrap is not usable");
				if (config.onUnavailable === "error") {
					throw new Error(`Sandbox unavailable: ${reason}. Run /sandbox for details.`);
				}
				deps.onUnavailable?.(reason, cwd);
				return deps.fallback.exec(command, cwd, options);
			}

			const shell = deps.shell();
			const argv = buildBwrapArgs({
				command,
				cwd,
				env: resolveSandboxEnv(env ?? process.env, config.env, platform),
				config,
				capabilities,
				shell,
				bwrapPath: deps.bwrapPath,
			});

			return runBwrap(argv, {
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
