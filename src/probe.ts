/**
 * Probe the local `bwrap` binary for availability and capabilities.
 *
 * Results are cached per binary path (TTL, default 60s) because every command
 * would otherwise pay for two subprocess smoke tests.
 */

import { spawnSync } from "node:child_process";
import type { BwrapCapabilities } from "./types.ts";

export interface ProbeResult {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
}

export type ProbeRunner = (command: string, args: string[]) => ProbeResult;

export interface ProbeOptions {
	bwrapPath?: string;
	ttlMs?: number;
	now?: () => number;
	run?: ProbeRunner;
}

const FULL_SMOKE_ARGS = [
	"--ro-bind",
	"/",
	"/",
	"--dev",
	"/dev",
	"--unshare-pid",
	"--unshare-ipc",
	"--unshare-uts",
	"--unshare-cgroup-try",
	"--unshare-user",
	"--cap-drop",
	"ALL",
	"--proc",
	"/proc",
	"--",
	"/bin/sh",
	"-c",
	"true",
];

const BASIC_SMOKE_ARGS = ["--ro-bind", "/", "/", "--dev", "/dev", "--", "/bin/sh", "-c", "true"];

const cache = new Map<string, { capabilities: BwrapCapabilities; expires: number }>();

export function clearProbeCache(): void {
	cache.clear();
}

function defaultRunner(command: string, args: string[]): ProbeResult {
	const result = spawnSync(command, args, { encoding: "utf-8", timeout: 5000 });
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		error: result.error,
	};
}

function detect(bwrapPath: string, run: ProbeRunner): BwrapCapabilities {
	const version = run(bwrapPath, ["--version"]);
	if (version.error) {
		return {
			available: false,
			userNamespace: false,
			procMount: false,
			error: `bwrap not found: ${version.error.message}`,
		};
	}
	const versionString = `${version.stdout}${version.stderr}`.match(/\d+\.\d+\.\d+/)?.[0];

	const full = run(bwrapPath, FULL_SMOKE_ARGS);
	if (full.status === 0) {
		return { available: true, version: versionString, userNamespace: true, procMount: true };
	}

	const basic = run(bwrapPath, BASIC_SMOKE_ARGS);
	if (basic.status === 0) {
		const reason = full.stderr.trim() || full.error?.message || "unknown reason";
		return {
			available: true,
			version: versionString,
			userNamespace: false,
			procMount: false,
			error: `user namespace unavailable (${reason}); filesystem sandboxing still applies`,
		};
	}

	return {
		available: false,
		version: versionString,
		userNamespace: false,
		procMount: false,
		error: basic.stderr.trim() || basic.error?.message || "bwrap smoke test failed",
	};
}

export function probeBwrap(options: ProbeOptions = {}): BwrapCapabilities {
	const bwrapPath = options.bwrapPath ?? "bwrap";
	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? 60_000;

	const cached = cache.get(bwrapPath);
	if (cached && cached.expires > now()) return cached.capabilities;

	const capabilities = detect(bwrapPath, options.run ?? defaultRunner);
	cache.set(bwrapPath, { capabilities, expires: now() + ttlMs });
	return capabilities;
}
