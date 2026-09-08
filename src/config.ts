/**
 * Config discovery, layering, validation, and path expansion.
 *
 * Layers (lowest to highest): built-in defaults <- global <- project.
 * The project layer is only read when the project is trusted (decision D6).
 * Array fields override rather than concatenate, so a project can drop a
 * global rule; `env.set` merges per key.
 *
 * Relative rules resolve against the command cwd (not projectRoot), so each
 * worktree writes only its own tree. Glob rules are expanded to concrete
 * existing paths with Node's `fs.globSync`; unmatched rules are dropped
 * because bwrap needs real paths and must not create host mount points.
 */

import { existsSync, globSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import type {
	ConfigSources,
	NetworkMode,
	ResolvedPath,
	ResolvedSandboxConfig,
	SandboxConfigFile,
	TmpMode,
	UnavailablePolicy,
} from "./types.ts";

export const CONFIG_DIR_NAME = ".pi";
export const SANDBOX_CONFIG_FILENAME = "sandbox.json";

/** pi's agent dir: `PI_CODING_AGENT_DIR` (tilde-expanded) or `~/.pi/agent`. */
export function resolveAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return expandTilde(envDir);
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

export function expandTilde(path: string, home: string = homedir()): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

export function hasGlob(path: string): boolean {
	return /[*?[\]{}]/.test(path);
}

export const DEFAULT_CONFIG: SandboxConfigFile = {
	enabled: true,
	network: "none",
	filesystem: {
		allowWrite: [".", "/tmp"],
		denyWrite: ["~/.ssh", ".env", ".env.*", "*.pem", "*.key"],
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gh"],
	},
	tmp: "private",
	env: {
		passthrough: ["PATH", "HOME", "TERM", "LANG", "LC_*", "TMPDIR", "PI_*"],
		deny: ["*_KEY", "*_TOKEN", "*_SECRET", "*_PASSWORD", "ANTHROPIC_*", "OPENAI_*"],
		set: {},
	},
	unsharePid: true,
	weakerNestedSandbox: false,
	onUnavailable: "error",
	extraBwrapArgs: [],
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface ConfigPaths {
	globalPath: string;
	/** Worktree-local config first, then the main checkout (decision O3). */
	projectCandidates: string[];
	/** First existing candidate, or null. */
	projectPath: string | null;
}

export function getConfigPaths(input: {
	projectRoot: string;
	worktreeRoot: string;
	agentDir?: string;
}): ConfigPaths {
	const agentDir = input.agentDir ?? resolveAgentDir();
	const globalPath = join(agentDir, SANDBOX_CONFIG_FILENAME);
	const projectCandidates = dedupStrings([
		join(input.worktreeRoot, CONFIG_DIR_NAME, SANDBOX_CONFIG_FILENAME),
		join(input.projectRoot, CONFIG_DIR_NAME, SANDBOX_CONFIG_FILENAME),
	]);
	const projectPath = projectCandidates.find((candidate) => existsSync(candidate)) ?? null;
	return { globalPath, projectCandidates, projectPath };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const TOP_LEVEL_KEYS = new Set([
	"enabled",
	"network",
	"filesystem",
	"tmp",
	"env",
	"unsharePid",
	"weakerNestedSandbox",
	"onUnavailable",
	"extraBwrapArgs",
]);
const FILESYSTEM_KEYS = new Set(["allowWrite", "denyWrite", "denyRead"]);
const ENV_KEYS = new Set(["passthrough", "deny", "set"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown, field: string, warnings: string[]): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		warnings.push(`${field}: expected an array, ignoring`);
		return undefined;
	}
	const out = value.filter((entry): entry is string => typeof entry === "string");
	if (out.length !== value.length) warnings.push(`${field}: dropped non-string entries`);
	return out;
}

function asEnum<T extends string>(
	value: unknown,
	allowed: readonly T[],
	field: string,
	warnings: string[],
): T | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
	warnings.push(`${field}: expected one of ${allowed.join(" | ")}, got ${JSON.stringify(value)}; ignoring`);
	return undefined;
}

function warnUnknownKeys(
	record: Record<string, unknown>,
	known: Set<string>,
	prefix: string,
	warnings: string[],
): void {
	for (const key of Object.keys(record)) {
		if (!known.has(key)) warnings.push(`${prefix}${key}: unknown key, ignoring`);
	}
}

/** Validate one parsed JSON object into a `SandboxConfigFile`. Never throws. */
export function validateConfigLayer(raw: unknown, source: string, warnings: string[]): SandboxConfigFile {
	if (!isRecord(raw)) {
		warnings.push(`${source}: expected a JSON object, ignoring`);
		return {};
	}
	warnUnknownKeys(raw, TOP_LEVEL_KEYS, "", warnings);

	const out: SandboxConfigFile = {};

	if (raw.enabled !== undefined) {
		if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
		else warnings.push(`enabled: expected boolean, ignoring`);
	}
	out.network = asEnum<NetworkMode>(raw.network, ["none", "host"], "network", warnings);
	out.tmp = asEnum<TmpMode>(raw.tmp, ["private", "shared"], "tmp", warnings);
	out.onUnavailable = asEnum<UnavailablePolicy>(
		raw.onUnavailable,
		["error", "fallback"],
		"onUnavailable",
		warnings,
	);
	if (raw.unsharePid !== undefined) {
		if (typeof raw.unsharePid === "boolean") out.unsharePid = raw.unsharePid;
		else warnings.push(`unsharePid: expected boolean, ignoring`);
	}
	if (raw.weakerNestedSandbox !== undefined) {
		if (typeof raw.weakerNestedSandbox === "boolean") out.weakerNestedSandbox = raw.weakerNestedSandbox;
		else warnings.push(`weakerNestedSandbox: expected boolean, ignoring`);
	}
	out.extraBwrapArgs = asStringArray(raw.extraBwrapArgs, "extraBwrapArgs", warnings);

	if (raw.filesystem !== undefined) {
		if (isRecord(raw.filesystem)) {
			warnUnknownKeys(raw.filesystem, FILESYSTEM_KEYS, "filesystem.", warnings);
			out.filesystem = {
				allowWrite: asStringArray(raw.filesystem.allowWrite, "filesystem.allowWrite", warnings),
				denyWrite: asStringArray(raw.filesystem.denyWrite, "filesystem.denyWrite", warnings),
				denyRead: asStringArray(raw.filesystem.denyRead, "filesystem.denyRead", warnings),
			};
		} else {
			warnings.push(`filesystem: expected object, ignoring`);
		}
	}

	if (raw.env !== undefined) {
		if (isRecord(raw.env)) {
			warnUnknownKeys(raw.env, ENV_KEYS, "env.", warnings);
			const set: Record<string, string> = {};
			if (raw.env.set !== undefined) {
				if (isRecord(raw.env.set)) {
					for (const [key, value] of Object.entries(raw.env.set)) {
						if (typeof value === "string") set[key] = value;
						else warnings.push(`env.set.${key}: expected string, ignoring`);
					}
				} else {
					warnings.push(`env.set: expected object, ignoring`);
				}
			}
			out.env = {
				passthrough: asStringArray(raw.env.passthrough, "env.passthrough", warnings),
				deny: asStringArray(raw.env.deny, "env.deny", warnings),
				set,
			};
		} else {
			warnings.push(`env: expected object, ignoring`);
		}
	}

	return out;
}

function readConfigLayer(path: string, warnings: string[]): SandboxConfigFile | null {
	if (!existsSync(path)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return validateConfigLayer(parsed, path, warnings);
	} catch (error) {
		warnings.push(`${path}: ${(error as Error).message}; ignoring`);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

function pick<T>(project: T | undefined, global: T | undefined, defaults: T | undefined): T | undefined {
	return project ?? global ?? defaults;
}

/** Merge three layers. Array fields override; `env.set` merges per key. */
export function mergeConfigLayers(
	defaults: SandboxConfigFile,
	global: SandboxConfigFile,
	project: SandboxConfigFile | null,
): SandboxConfigFile {
	const g = global ?? {};
	const p = project ?? {};

	return {
		enabled: pick(p.enabled, g.enabled, defaults.enabled),
		network: pick(p.network, g.network, defaults.network),
		filesystem: {
			allowWrite: pick(
				p.filesystem?.allowWrite,
				g.filesystem?.allowWrite,
				defaults.filesystem?.allowWrite,
			),
			denyWrite: pick(p.filesystem?.denyWrite, g.filesystem?.denyWrite, defaults.filesystem?.denyWrite),
			denyRead: pick(p.filesystem?.denyRead, g.filesystem?.denyRead, defaults.filesystem?.denyRead),
		},
		tmp: pick(p.tmp, g.tmp, defaults.tmp),
		env: {
			passthrough: pick(p.env?.passthrough, g.env?.passthrough, defaults.env?.passthrough),
			deny: pick(p.env?.deny, g.env?.deny, defaults.env?.deny),
			set: { ...defaults.env?.set, ...g.env?.set, ...p.env?.set },
		},
		unsharePid: pick(p.unsharePid, g.unsharePid, defaults.unsharePid),
		weakerNestedSandbox: pick(p.weakerNestedSandbox, g.weakerNestedSandbox, defaults.weakerNestedSandbox),
		onUnavailable: pick(p.onUnavailable, g.onUnavailable, defaults.onUnavailable),
		extraBwrapArgs: pick(p.extraBwrapArgs, g.extraBwrapArgs, defaults.extraBwrapArgs),
	};
}

// ---------------------------------------------------------------------------
// Path expansion
// ---------------------------------------------------------------------------

function expandRule(rule: string, cwd: string, warnings: string[]): ResolvedPath[] {
	const expanded = expandTilde(rule);
	const absolute = isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);

	let candidates: string[];
	if (hasGlob(absolute)) {
		try {
			candidates = globSync(absolute);
		} catch (error) {
			warnings.push(`${rule}: glob failed (${(error as Error).message}); ignoring`);
			return [];
		}
	} else {
		candidates = [absolute];
	}

	const out: ResolvedPath[] = [];
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		try {
			const real = realpathSync(candidate);
			out.push({ path: real, isDir: statSync(real).isDirectory(), rule });
		} catch {
			// Raced away or unreadable; skip rather than fail the whole command.
		}
	}
	return out;
}

function dedupPaths(paths: ResolvedPath[]): ResolvedPath[] {
	const seen = new Set<string>();
	const out: ResolvedPath[] = [];
	for (const path of paths) {
		if (seen.has(path.path)) continue;
		seen.add(path.path);
		out.push(path);
	}
	return out;
}

function dedupStrings(values: string[]): string[] {
	return [...new Set(values)];
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface LoadSandboxConfigInput {
	projectRoot: string;
	worktreeRoot: string;
	cwd: string;
	projectTrusted: boolean;
	agentDir?: string;
}

const cache = new Map<string, ResolvedSandboxConfig>();

export function clearConfigCache(): void {
	cache.clear();
}

function statKey(path: string | null): string {
	if (!path) return "none";
	try {
		const stat = statSync(path);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return "missing";
	}
}

function normalize(
	merged: SandboxConfigFile,
	cwd: string,
	sources: ConfigSources,
): ResolvedSandboxConfig {
	const warnings = sources.warnings;
	const expandAll = (rules: string[] | undefined): ResolvedPath[] =>
		dedupPaths((rules ?? []).flatMap((rule) => expandRule(rule, cwd, warnings)));

	const env = merged.env ?? {};
	return {
		enabled: merged.enabled ?? true,
		network: merged.network ?? "none",
		allowWrite: expandAll(merged.filesystem?.allowWrite),
		denyWrite: expandAll(merged.filesystem?.denyWrite),
		denyRead: expandAll(merged.filesystem?.denyRead),
		tmp: merged.tmp ?? "private",
		env: {
			passthrough: env.passthrough ?? [],
			deny: env.deny ?? [],
			set: env.set ?? {},
		},
		unsharePid: merged.unsharePid ?? true,
		weakerNestedSandbox: merged.weakerNestedSandbox ?? false,
		onUnavailable: merged.onUnavailable ?? "error",
		extraBwrapArgs: merged.extraBwrapArgs ?? [],
		sources,
	};
}

/**
 * Load, merge, and expand config for one command. Results are cached by
 * config-file stat + cwd + trust, so repeated commands do not re-read disk.
 */
export function loadSandboxConfig(input: LoadSandboxConfigInput): ResolvedSandboxConfig {
	const { globalPath, projectPath } = getConfigPaths(input);
	const key = [
		globalPath,
		statKey(globalPath),
		projectPath ?? "none",
		statKey(projectPath),
		input.cwd,
		String(input.projectTrusted),
	].join("|");

	const cached = cache.get(key);
	if (cached) return cached;

	const warnings: string[] = [];
	const globalLayer = readConfigLayer(globalPath, warnings) ?? {};
	let projectLayer: SandboxConfigFile | null = null;
	if (projectPath) {
		if (input.projectTrusted) {
			projectLayer = readConfigLayer(projectPath, warnings);
		} else {
			warnings.push(`project sandbox config ignored (project not trusted): ${projectPath}`);
		}
	}

	const merged = mergeConfigLayers(DEFAULT_CONFIG, globalLayer, projectLayer);
	const resolved = normalize(merged, input.cwd, {
		globalPath,
		projectPath,
		projectTrusted: input.projectTrusted,
		warnings,
	});

	cache.set(key, resolved);
	if (cache.size > 64) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	return resolved;
}
