/**
 * Pure translation from the extension's resolved policy to the stable MXC
 * `1.0.0` create-and-run request.
 *
 * MXC's filesystem model is deny-by-default: a path that is not named in
 * `filesystem.*` does not exist inside the sandbox. The extension has always
 * exposed the host read-only and then layered writes/denies on top, so the
 * builder reproduces that on every platform:
 *
 * - Linux → every existing entry at `/` except the virtual filesystems
 * - macOS → `/` (Seatbelt handles nested rules with deepest-match-wins)
 * - Windows → every existing drive root (`C:\`, `D:\`, ...)
 *
 * `denyWrite` maps to `readonlyPaths` (readable, not writable), while
 * `denyRead` maps to `deniedPaths` (masked entirely). That is the same split
 * the bubblewrap engine implements with `--ro-bind` and `--tmpfs`/`/dev/null`.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix, win32 } from "node:path";
import type { ResolvedSandboxConfig } from "../types.ts";
import type { MxcBackend, MxcCommandSpec, MxcRequest } from "./types.ts";

export interface BuildMxcRequestInput {
	command: string;
	cwd: string;
	env: Record<string, string>;
	config: ResolvedSandboxConfig;
	shell: MxcCommandSpec;
	backend: MxcBackend;
	platform?: NodeJS.Platform;
	/** Timeout in milliseconds; 0 means none. */
	timeoutMs?: number;
	/** Test seams. */
	readdir?: (path: string) => string[];
	exists?: (path: string) => boolean;
	readable?: (path: string) => boolean;
	hostTmpdir?: string;
}

/** Explicit config wins; `auto` uses the probe result, then the platform default. */
export function resolveRequestedBackend(
	choice: ResolvedSandboxConfig["mxc"]["backend"],
	probed: MxcBackend | undefined,
	platform: NodeJS.Platform = process.platform,
): MxcBackend {
	if (choice !== "auto") return choice;
	return probed ?? resolveMxcBackend("auto", platform);
}

/** Resolve the effective backend for a platform. */
export function resolveMxcBackend(
	choice: ResolvedSandboxConfig["mxc"]["backend"],
	platform: NodeJS.Platform = process.platform,
): MxcBackend {
	if (choice !== "auto") return choice;
	switch (platform) {
		case "win32":
			return "processcontainer";
		case "darwin":
			return "seatbelt";
		default:
			return "bubblewrap";
	}
}

function pathApi(platform: NodeJS.Platform) {
	return platform === "win32" ? win32 : posix;
}

function normalizeForCompare(path: string, platform: NodeJS.Platform): string {
	const api = pathApi(platform);
	const normalized = api.normalize(path);
	return platform === "win32" ? normalized.toLowerCase().replace(/\\+$/, "") : normalized.replace(/\/+$/, "");
}

/** True when `child` is `parent` or lives inside it (case-insensitive on Windows). */
export function isPathInside(parent: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
	const api = pathApi(platform);
	const from = normalizeForCompare(parent, platform);
	const to = normalizeForCompare(child, platform);
	if (from === to) return true;
	const relative = api.relative(from, to);
	return relative.length > 0 && !relative.startsWith("..") && !api.isAbsolute(relative);
}

function dedupePaths(paths: string[], platform: NodeJS.Platform): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const path of paths) {
		const key = normalizeForCompare(path, platform);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(path);
	}
	return out;
}

/**
 * Drive roots on Windows. `fsutil fsinfo drives` avoids `existsSync("A:\\")`
 * blocking on an empty optical drive or a disconnected network mapping.
 * Cached briefly because the request builder runs per command.
 */
let driveCache: { roots: string[]; expires: number } | undefined;

function windowsDriveRoots(): string[] {
	const now = Date.now();
	if (driveCache && driveCache.expires > now) return driveCache.roots;

	let roots: string[] = [];
	try {
		const fsutil = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\fsutil.exe`;
		const result = spawnSync(fsutil, ["fsinfo", "drives"], {
			encoding: "utf-8",
			timeout: 2000,
			windowsHide: true,
		});
		if (result.status === 0) {
			// Parse every `X:\` token rather than the localized "Drives:" prefix.
			roots = [...(result.stdout ?? "").matchAll(/([A-Za-z]):\\/g)].map(
				(match) => `${match[1].toUpperCase()}:\\`,
			);
		}
	} catch {
		// Fall through to the conservative list below.
	}

	if (roots.length === 0) {
		const add = (path: string | undefined) => {
			const match = /^([A-Za-z]):/.exec(path ?? "");
			if (match) roots.push(`${match[1].toUpperCase()}:\\`);
		};
		add(process.env.SystemDrive);
		add(process.env.USERPROFILE);
		add(process.cwd());
		roots = [...new Set(roots)];
	}

	driveCache = { roots, expires: now + 60_000 };
	return roots;
}

function canRead(path: string): boolean {
	try {
		accessSync(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

/** Read-only roots that reproduce the extension's "host is readable" model. */
export function mxcReadonlyRoots(
	platform: NodeJS.Platform = process.platform,
	options: {
		readdir?: (path: string) => string[];
		exists?: (path: string) => boolean;
		readable?: (path: string) => boolean;
	} = {},
): string[] {
	const readdir = options.readdir ?? ((path: string) => readdirSync(path));
	const exists = options.exists ?? existsSync;
	const readable = options.readable ?? canRead;

	if (platform === "linux") {
		// MXC mounts these itself; naming them here would shadow the sandbox's
		// own /dev, /proc and tmpfs /tmp with host bind mounts.
		const skip = new Set(["dev", "proc", "sys", "tmp"]);
		try {
			return readdir("/")
				.filter((name) => !skip.has(name))
				.map((name) => posix.join("/", name))
				.filter((path) => exists(path) && readable(path));
		} catch {
			return ["/"];
		}
	}

	if (platform === "darwin") return ["/"];

	if (platform === "win32") {
		// Tests pass an `exists` seam; use the exhaustive loop so fake drive
		// layouts are deterministic. At runtime, ask Windows for the real drives.
		const candidates = options.exists
			? Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`)
			: windowsDriveRoots();
		return candidates.filter((root) => exists(root) && readable(root));
	}

	return [];
}

function resolveEnvArray(env: Record<string, string>, platform: NodeJS.Platform): string[] {
	const out = { ...env };
	if (platform === "win32") {
		// BusyBox and PowerShell both expand `~` against HOME. Windows has no
		// HOME by default, so derive it from USERPROFILE.
		const hasHome = Object.keys(out).some((key) => key.toLowerCase() === "home");
		const profile = Object.entries(out).find(([key]) => key.toLowerCase() === "userprofile")?.[1];
		if (!hasHome && profile) out.HOME = profile;
	}
	return Object.keys(out)
		.sort((a, b) => (platform === "win32" ? a.localeCompare(b) : a < b ? -1 : a > b ? 1 : 0))
		.map((key) => `${key}=${out[key]}`);
}

export function networkPolicy(
	config: ResolvedSandboxConfig,
	platform: NodeJS.Platform = process.platform,
): MxcRequest["network"] {
	if (config.network === "host") {
		// Bubblewrap's network namespace has no route in and its loopback is not
		// the host's, so it rejects both `ingress.allow` and `hostLoopback.allow`.
		if (platform === "linux") {
			return {
				egress: { default: "allow" },
				ingress: { default: "deny", hostLoopback: "deny" },
			};
		}
		return {
			egress: { default: "allow" },
			ingress: { default: "allow", hostLoopback: "allow" },
		};
	}
	return {
		egress: { default: "deny" },
		ingress: { default: "deny", hostLoopback: "deny" },
	};
}

/**
 * Assemble the request. Pure apart from the host filesystem probes that
 * enumerate read-only roots and the shared temp directory.
 */
export function buildMxcRequest(input: BuildMxcRequestInput): MxcRequest {
	const platform = input.platform ?? process.platform;
	const { config, shell } = input;
	const readonlyRoots = mxcReadonlyRoots(platform, input);
	const hostTmp = input.hostTmpdir ?? tmpdir();

	const readwrite = dedupePaths(
		[
			...config.allowWrite.map((path) => path.path),
			...config.mxc.extraReadwrite.map((path) => path.path),
			...(config.tmp === "shared" ? [hostTmp] : []),
		],
		platform,
	);

	const readable = input.readable ?? canRead;
	const readonly = dedupePaths(
		[
			...readonlyRoots,
			...config.denyWrite.map((path) => path.path),
			...config.mxc.extraReadonly.map((path) => path.path),
		],
		platform,
	).filter((path) => readable(path)).filter(
		// An exact rw grant must not be shadowed by an equal ro entry.
		(path) => !readwrite.some((rw) => normalizeForCompare(rw, platform) === normalizeForCompare(path, platform)),
	);

	// `chdir` happens after the mounts; a cwd that no grant covers fails to
	// start. Grant it read-only when the user did not make it writable.
	const cwdCovered = readwrite.some((path) => isPathInside(path, input.cwd, platform));
	if (!cwdCovered) {
		const cwdKey = normalizeForCompare(input.cwd, platform);
		if (!readonly.some((path) => normalizeForCompare(path, platform) === cwdKey)) readonly.push(input.cwd);
	}

	const denied = dedupePaths(
		[
			...config.denyRead.map((path) => path.path),
			...config.denyCreate.map((path) => path.path),
			...config.mxc.extraDenied.map((path) => path.path),
		],
		platform,
	);

	return {
		version: "1.0.0",
		containment: input.backend,
		lifecycle: { destroyOnExit: true, preservePolicy: false },
		process: {
			commandLine: shell.commandLine,
			cwd: input.cwd,
			env: resolveEnvArray(input.env, platform),
			timeout: input.timeoutMs ?? 0,
		},
		filesystem: {
			readwritePaths: readwrite,
			readonlyPaths: readonly,
			deniedPaths: denied,
		},
		network: networkPolicy(config, platform),
		ui: {
			// BusyBox-w32 and PowerShell need Win32k during process init.
			disable: platform === "win32" ? !shell.allowsUi : true,
			clipboard: "none",
			injection: false,
		},
	};
}

/** Convenience for `/sandbox-test` and diagnostics. */
export function formatMxcRequest(request: MxcRequest): string {
	return JSON.stringify(request, null, 2);
}
