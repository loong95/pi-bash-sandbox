/**
 * Locate the MXC executor and probe the host backend.
 *
 * The probe is deliberately cheap compared with the runner's own launch
 * checks; failures are cached briefly so a transient problem does not
 * permanently disable the engine, and `/sandbox-reload` clears it.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { MxcCapabilities } from "./types.ts";

export interface ExecutorLookupInput {
	executorPath?: string;
	platform?: NodeJS.Platform;
	arch?: string;
	/** Override the resolved package root (tests). */
	packageRoot?: string;
}

export interface ExecutorLookup {
	executor: string | null;
	error?: string;
}

/** Map Node's architecture to MXC's asset directory. */
export function mxcAssetArch(arch: string = process.arch): string | null {
	if (arch === "arm64") return "arm64";
	if (arch === "x64") return "x64";
	return null;
}

/** The executor binary name for a platform. */
export function mxcExecutorName(platform: NodeJS.Platform = process.platform): string | null {
	switch (platform) {
		case "win32":
			return "wxc-exec.exe";
		case "linux":
			return "lxc-exec";
		case "darwin":
			return "mxc-exec-mac";
		default:
			return null;
	}
}

function defaultPackageRoot(): string | null {
	try {
		const require = createRequire(import.meta.url);
		return dirname(require.resolve("@microsoft/mxc-sdk/package.json"));
	} catch {
		return null;
	}
}

/**
 * Resolve `node_modules/@microsoft/mxc-sdk/bin/<arch>/<executor>`.
 *
 * Note that the published SDK ships no macOS x64 binary; that combination is
 * reported as unavailable rather than attempting a Rosetta translation.
 */
export function findMxcExecutor(input: ExecutorLookupInput = {}): ExecutorLookup {
	const platform = input.platform ?? process.platform;
	const name = mxcExecutorName(platform);
	if (!name) return { executor: null, error: `MXC does not support platform ${platform}` };

	if (input.executorPath) {
		if (existsSync(input.executorPath)) return { executor: input.executorPath };
		return { executor: null, error: `configured mxc.executorPath not found: ${input.executorPath}` };
	}

	const envExecutor = process.env.PI_MXC_EXECUTOR;
	if (envExecutor) {
		if (existsSync(envExecutor)) return { executor: envExecutor };
		return { executor: null, error: `PI_MXC_EXECUTOR not found: ${envExecutor}` };
	}

	const arch = mxcAssetArch(input.arch ?? process.arch);
	if (!arch) return { executor: null, error: `MXC does not ship binaries for architecture ${input.arch ?? process.arch}` };

	const root = input.packageRoot ?? defaultPackageRoot();
	if (!root) {
		return { executor: null, error: "package @microsoft/mxc-sdk is not installed (run `npm install`)" };
	}

	const candidate = join(root, "bin", arch, name);
	if (existsSync(candidate)) return { executor: candidate };

	if (platform === "darwin" && arch === "x64") {
		return { executor: null, error: "MXC publishes no macOS x64 binary (Apple silicon only)" };
	}
	return { executor: null, error: `MXC executor missing: ${candidate}` };
}

export interface ProbeResult {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
}

export type MxcProbeRunner = (command: string, args: string[]) => ProbeResult;

export interface MxcProbeOptions extends ExecutorLookupInput {
	ttlMs?: number;
	now?: () => number;
	run?: MxcProbeRunner;
	/** Override the macOS product version (tests). */
	macosVersion?: string;
}

interface CacheEntry {
	capabilities: MxcCapabilities;
	expires: number;
}

const cache = new Map<string, CacheEntry>();

export function clearMxcProbeCache(): void {
	cache.clear();
}

function defaultRunner(command: string, args: string[]): ProbeResult {
	const result = spawnSync(command, args, {
		encoding: "utf-8",
		timeout: 20_000,
		windowsHide: true,
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		error: result.error,
	};
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function probeWindows(
	executor: string,
	run: MxcProbeRunner,
): MxcCapabilities {
	const result = run(executor, ["--probe"]);
	if (result.error) {
		return { available: false, executor, error: `wxc-exec --probe failed: ${result.error.message}` };
	}
	if (result.status !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
		return { available: false, executor, error: `wxc-exec --probe failed: ${detail}` };
	}
	const payload = parseJson(result.stdout) as
		| { tier?: unknown; probes?: { baseContainerApiPresent?: unknown }; warnings?: unknown }
		| undefined;
	const present = payload?.probes?.baseContainerApiPresent === true;
	if (!present) {
		return {
			available: false,
			executor,
			error: "Windows ProcessContainer is unavailable (PSEC/BaseContainer API not present)",
		};
	}
	return {
		available: true,
		backend: "processcontainer",
		executor,
		tier: typeof payload?.tier === "string" ? payload.tier : undefined,
	};
}

function probeLinux(executor: string, run: MxcProbeRunner): MxcCapabilities {
	const result = run(executor, ["--available-backends"]);
	if (result.error) {
		return { available: false, executor, error: `lxc-exec --available-backends failed: ${result.error.message}` };
	}
	if (result.status !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
		return { available: false, executor, error: `lxc-exec --available-backends failed: ${detail}` };
	}
	const backends = parseJson(result.stdout);
	if (!Array.isArray(backends)) {
		return { available: false, executor, error: "MXC backend discovery returned invalid JSON" };
	}
	const bubblewrap = backends.find(
		(entry): entry is Record<string, unknown> =>
			!!entry && typeof entry === "object" && (entry as Record<string, unknown>).backend === "bubblewrap",
	);
	if (!bubblewrap) {
		return { available: false, executor, error: "MXC reports no bubblewrap backend on this host" };
	}
	return { available: true, backend: "bubblewrap", executor };
}

function probeMacos(
	executor: string,
	options: MxcProbeOptions,
	run: MxcProbeRunner,
): MxcCapabilities {
	const versionResult = options.macosVersion
		? { status: 0, stdout: options.macosVersion, stderr: "" }
		: run("sw_vers", ["-productVersion"]);
	const version = versionResult.stdout.trim();
	const major = Number.parseInt(version.split(".")[0] ?? "", 10);
	if (Number.isFinite(major) && major < 15) {
		return {
			available: false,
			executor,
			error: `Seatbelt requires macOS 15 or later (host is ${version})`,
		};
	}
	return { available: true, backend: "seatbelt", executor, version: version || undefined };
}

function detect(executor: string, platform: NodeJS.Platform, options: MxcProbeOptions, run: MxcProbeRunner): MxcCapabilities {
	switch (platform) {
		case "win32":
			return probeWindows(executor, run);
		case "linux":
			return probeLinux(executor, run);
		case "darwin":
			return probeMacos(executor, options, run);
		default:
			return { available: false, error: `MXC does not support platform ${platform}` };
	}
}

export function probeMxc(options: MxcProbeOptions = {}): MxcCapabilities {
	const platform = options.platform ?? process.platform;
	const lookup = findMxcExecutor(options);
	if (!lookup.executor) return { available: false, error: lookup.error };

	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? 300_000;
	const key = `${platform}|${lookup.executor}`;
	const cached = cache.get(key);
	if (cached && cached.expires > now()) return cached.capabilities;

	const capabilities = detect(lookup.executor, platform, options, options.run ?? defaultRunner);
	cache.set(key, { capabilities, expires: now() + ttlMs });
	return capabilities;
}
