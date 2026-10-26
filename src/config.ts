/**
 * Config discovery, layering, validation, and path expansion.
 *
 * Layers (lowest to highest): built-in defaults <- global <- project.
 * The project layer is only read when the project is trusted (decision D6).
 * Project array fields extend global arrays by default; `replaceGlobalArrays`
 * opts out per field. `env.set` merges per key.
 *
 * Relative rules resolve against the command cwd (not projectRoot), so each
 * worktree writes only its own tree. Glob rules are expanded to concrete
 * existing paths with Node's `fs.globSync`; unmatched rules are dropped
 * because bwrap needs real paths and must not create host mount points.
 */

import { existsSync, globSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import type { GitLayout } from "./project.ts";
import type {
	ConfigSources,
	EngineMode,
	GitBlockCreate,
	MxcBackendChoice,
	NetworkMode,
	PathVariables,
	ResolvedGitGuard,
	ResolvedPath,
	ResolvedSandboxConfig,
	SandboxConfigFile,
	TmpMode,
	UnavailablePolicy,
} from "./types.ts";
import { expandVariables, findUnknownVariables, pathVariableContext, usesKnownVariable } from "./variables.ts";

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
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
	return path;
}

export function hasGlob(path: string): boolean {
	return /[*?[\]{}]/.test(path);
}

export const DEFAULT_CONFIG: SandboxConfigFile = {
	enabled: true,
	engine: "auto",
	mxc: {
		backend: "auto",
		shell: "busybox",
		extraReadwritePaths: [],
		extraReadonlyPaths: [],
		extraDeniedPaths: [],
	},
	network: "none",
	filesystem: {
		allowWrite: [".", "/tmp"],
		denyWrite: ["~/.ssh", ".env", ".env.*", "*.pem", "*.key"],
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gh"],
	},
	tmp: "private",
	env: {
		passthrough: [
			"PATH",
			"HOME",
			"TERM",
			"LANG",
			"LC_*",
			"TMPDIR",
			"PI_*",
			// Windows shells need the Win32 environment block to initialize.
			"USERPROFILE",
			"USERNAME",
			"USERDOMAIN",
			"COMPUTERNAME",
			"SystemRoot",
			"SystemDrive",
			"WINDIR",
			"COMSPEC",
			"PATHEXT",
			"TEMP",
			"TMP",
			"APPDATA",
			"LOCALAPPDATA",
			"PROGRAMDATA",
			"PROGRAMFILES",
			"PROGRAMFILES(X86)",
			"HOMEDRIVE",
			"HOMEPATH",
			"NUMBER_OF_PROCESSORS",
			"PROCESSOR_ARCHITECTURE",
			"OS",
		],
		deny: ["*_KEY", "*_TOKEN", "*_SECRET", "*_PASSWORD", "ANTHROPIC_*", "OPENAI_*"],
		set: {},
	},
	unsharePid: true,
	weakerNestedSandbox: false,
	onUnavailable: "error",
	extraBwrapArgs: [],
	tools: {
		enabled: true,
		requireAllowWrite: true,
	},
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
	"replaceGlobalArrays",
	"enabled",
	"engine",
	"mxc",
	"network",
	"filesystem",
	"tmp",
	"env",
	"unsharePid",
	"weakerNestedSandbox",
	"onUnavailable",
	"extraBwrapArgs",
	"tools",
]);
const FILESYSTEM_KEYS = new Set(["allowWrite", "denyWrite", "denyRead"]);
const ENV_KEYS = new Set(["passthrough", "deny", "set"]);
const TOOLS_KEYS = new Set(["enabled", "requireAllowWrite"]);
const MXC_KEYS = new Set([
	"backend",
	"shell",
	"busyboxPath",
	"executorPath",
	"extraReadwritePaths",
	"extraReadonlyPaths",
	"extraDeniedPaths",
]);
const MERGEABLE_ARRAY_FIELDS = new Set([
	"filesystem.allowWrite",
	"filesystem.denyWrite",
	"filesystem.denyRead",
	"env.passthrough",
	"env.deny",
	"mxc.extraReadwritePaths",
	"mxc.extraReadonlyPaths",
	"mxc.extraDeniedPaths",
]);

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

	const replaceGlobalArrays = asStringArray(raw.replaceGlobalArrays, "replaceGlobalArrays", warnings);
	out.replaceGlobalArrays = replaceGlobalArrays?.filter((field) => {
		if (MERGEABLE_ARRAY_FIELDS.has(field)) return true;
		warnings.push(`replaceGlobalArrays.${field}: unsupported array field, ignoring`);
		return false;
	});

	if (raw.enabled !== undefined) {
		if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
		else warnings.push(`enabled: expected boolean, ignoring`);
	}
	out.engine = asEnum<EngineMode>(raw.engine, ["auto", "mxc", "bwrap"], "engine", warnings);
	if (raw.mxc !== undefined) {
		if (isRecord(raw.mxc)) {
			warnUnknownKeys(raw.mxc, MXC_KEYS, "mxc.", warnings);
			const mxc: NonNullable<SandboxConfigFile["mxc"]> = {};
			mxc.backend = asEnum<MxcBackendChoice>(
				raw.mxc.backend,
				["auto", "bubblewrap", "seatbelt", "processcontainer"],
				"mxc.backend",
				warnings,
			);
			if (raw.mxc.shell !== undefined) {
				if (typeof raw.mxc.shell === "string" && raw.mxc.shell.length > 0) mxc.shell = raw.mxc.shell;
				else warnings.push(`mxc.shell: expected a non-empty string, ignoring`);
			}
			for (const key of ["busyboxPath", "executorPath"] as const) {
				const value = raw.mxc[key];
				if (value === undefined) continue;
				if (typeof value === "string" && value.length > 0) mxc[key] = value;
				else warnings.push(`mxc.${key}: expected a non-empty string, ignoring`);
			}
			mxc.extraReadwritePaths = asStringArray(
				raw.mxc.extraReadwritePaths,
				"mxc.extraReadwritePaths",
				warnings,
			);
			mxc.extraReadonlyPaths = asStringArray(
				raw.mxc.extraReadonlyPaths,
				"mxc.extraReadonlyPaths",
				warnings,
			);
			mxc.extraDeniedPaths = asStringArray(raw.mxc.extraDeniedPaths, "mxc.extraDeniedPaths", warnings);
			out.mxc = mxc;
		} else {
			warnings.push(`mxc: expected object, ignoring`);
		}
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

	if (raw.tools !== undefined) {
		if (isRecord(raw.tools)) {
			warnUnknownKeys(raw.tools, TOOLS_KEYS, "tools.", warnings);
			const tools: SandboxConfigFile["tools"] = {};
			if (raw.tools.enabled !== undefined) {
				if (typeof raw.tools.enabled === "boolean") tools.enabled = raw.tools.enabled;
				else warnings.push(`tools.enabled: expected boolean, ignoring`);
			}
			if (raw.tools.requireAllowWrite !== undefined) {
				if (typeof raw.tools.requireAllowWrite === "boolean") tools.requireAllowWrite = raw.tools.requireAllowWrite;
				else warnings.push(`tools.requireAllowWrite: expected boolean, ignoring`);
			}
			out.tools = tools;
		} else {
			warnings.push(`tools: expected object, ignoring`);
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

/** Merge project arrays with global arrays unless explicitly opted out. */
function mergeArray(
	field: string,
	project: string[] | undefined,
	global: string[] | undefined,
	defaults: string[] | undefined,
	replaceGlobalArrays: Set<string>,
): string[] | undefined {
	if (project === undefined) {
		const inherited = global ?? defaults;
		return inherited === undefined ? undefined : [...new Set(inherited)];
	}
	if (global === undefined || replaceGlobalArrays.has(field)) return [...new Set(project)];
	return [...new Set([...global, ...project])];
}

/** Merge three layers. Project arrays extend global arrays by default; `replaceGlobalArrays` opts out per field. */
export function mergeConfigLayers(
	defaults: SandboxConfigFile,
	global: SandboxConfigFile,
	project: SandboxConfigFile | null,
): SandboxConfigFile {
	const g = global ?? {};
	const p = project ?? {};
	const replaceGlobalArrays = new Set(p.replaceGlobalArrays ?? []);

	return {
		enabled: pick(p.enabled, g.enabled, defaults.enabled),
		engine: pick(p.engine, g.engine, defaults.engine),
		mxc: {
			backend: pick(p.mxc?.backend, g.mxc?.backend, defaults.mxc?.backend),
			shell: pick(p.mxc?.shell, g.mxc?.shell, defaults.mxc?.shell),
			busyboxPath: pick(p.mxc?.busyboxPath, g.mxc?.busyboxPath, defaults.mxc?.busyboxPath),
			executorPath: pick(p.mxc?.executorPath, g.mxc?.executorPath, defaults.mxc?.executorPath),
			extraReadwritePaths: mergeArray(
				"mxc.extraReadwritePaths",
				p.mxc?.extraReadwritePaths,
				g.mxc?.extraReadwritePaths,
				defaults.mxc?.extraReadwritePaths,
				replaceGlobalArrays,
			),
			extraReadonlyPaths: mergeArray(
				"mxc.extraReadonlyPaths",
				p.mxc?.extraReadonlyPaths,
				g.mxc?.extraReadonlyPaths,
				defaults.mxc?.extraReadonlyPaths,
				replaceGlobalArrays,
			),
			extraDeniedPaths: mergeArray(
				"mxc.extraDeniedPaths",
				p.mxc?.extraDeniedPaths,
				g.mxc?.extraDeniedPaths,
				defaults.mxc?.extraDeniedPaths,
				replaceGlobalArrays,
			),
		},
		network: pick(p.network, g.network, defaults.network),
		filesystem: {
			allowWrite: mergeArray(
				"filesystem.allowWrite",
				p.filesystem?.allowWrite,
				g.filesystem?.allowWrite,
				defaults.filesystem?.allowWrite,
				replaceGlobalArrays,
			),
			denyWrite: mergeArray(
				"filesystem.denyWrite",
				p.filesystem?.denyWrite,
				g.filesystem?.denyWrite,
				defaults.filesystem?.denyWrite,
				replaceGlobalArrays,
			),
			denyRead: mergeArray(
				"filesystem.denyRead",
				p.filesystem?.denyRead,
				g.filesystem?.denyRead,
				defaults.filesystem?.denyRead,
				replaceGlobalArrays,
			),
		},
		tmp: pick(p.tmp, g.tmp, defaults.tmp),
		env: {
			passthrough: mergeArray(
				"env.passthrough",
				p.env?.passthrough,
				g.env?.passthrough,
				defaults.env?.passthrough,
				replaceGlobalArrays,
			),
			deny: mergeArray(
				"env.deny",
				p.env?.deny,
				g.env?.deny,
				defaults.env?.deny,
				replaceGlobalArrays,
			),
			set: { ...defaults.env?.set, ...g.env?.set, ...p.env?.set },
		},
		unsharePid: pick(p.unsharePid, g.unsharePid, defaults.unsharePid),
		weakerNestedSandbox: pick(p.weakerNestedSandbox, g.weakerNestedSandbox, defaults.weakerNestedSandbox),
		onUnavailable: pick(p.onUnavailable, g.onUnavailable, defaults.onUnavailable),
		extraBwrapArgs: pick(p.extraBwrapArgs, g.extraBwrapArgs, defaults.extraBwrapArgs),
		tools: {
			enabled: pick(p.tools?.enabled, g.tools?.enabled, defaults.tools?.enabled),
			requireAllowWrite: pick(
				p.tools?.requireAllowWrite,
				g.tools?.requireAllowWrite,
				defaults.tools?.requireAllowWrite,
			),
		},
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
			// Node's glob parser treats `\` as an escape. Windows paths are
			// handed to it with forward slashes and normalized by realpath below.
			candidates = globSync(process.platform === "win32" ? absolute.replace(/\\/g, "/") : absolute);
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

/** Expand one rule: substitute variables, then resolve each result to existing paths. */
function expandRuleWithVariables(
	rule: string,
	cwd: string,
	context: PathVariables,
	warnings: string[],
): ResolvedPath[] {
	const unknown = findUnknownVariables(rule);
	if (unknown.length > 0) {
		warnings.push(`${rule}: unknown variable(s) ${unknown.map((name) => `$${name}`).join(", ")}; rule will not match`);
	}
	return expandVariables(rule, context).flatMap((expanded) => expandRule(expanded, cwd, warnings));
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

/** Resolve symlinks when possible, so guards match the policy's canonicalized targets. */
function safeRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * Resolve a path that may not exist yet, by resolving its parent directory.
 * Mirrors `normalizeTarget` in policy.ts, so a guard recorded here matches the
 * target the tool policy computes for the same (not-yet-created) path.
 */
function resolveForGuard(path: string): string {
	if (existsSync(path)) return safeRealpath(path);
	try {
		return join(realpathSync(dirname(path)), basename(path));
	} catch {
		return path;
	}
}

/** Dedup by path, preferring the entry that knows it is a directory. */
function dedupBlockCreate(entries: GitBlockCreate[]): GitBlockCreate[] {
	const byPath = new Map<string, GitBlockCreate>();
	for (const entry of entries) {
		const existing = byPath.get(entry.path);
		if (!existing || (entry.isDir && !existing.isDir)) byPath.set(entry.path, entry);
	}
	return [...byPath.values()];
}

/**
 * Append guard paths that the user did not already name, recording each in
 * `seen` so a later rule for the same path is skipped.
 *
 * Guards are always directories here (git dirs and hooks dirs), which is why
 * `isDir` is not a parameter.
 */
function appendGuardPaths(out: ResolvedPath[], seen: Set<string>, paths: readonly string[]): void {
	for (const path of paths) {
		if (seen.has(path)) continue;
		seen.add(path);
		out.push({ path, isDir: true, rule: "$git" });
	}
}

/** True for a regular file; false for a directory, missing path, or error. */
function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Git layer
// ---------------------------------------------------------------------------

/**
 * Automatic git protection, applied whenever a repository is detected.
 *
 * `bash` is wrapped by bwrap, so a writable `allowWrite` path is a real write
 * capability. Paths inside a git dir turn that into host code execution,
 * because git executes them *outside* the sandbox on the next command:
 *
 * - `.git/config` and `config.worktree` (a `core.hooksPath` redirect)
 * - any hooks directory git may use
 *
 * Everything else here prevents cross-worktree damage: one worktree must not
 * rewrite another's `HEAD`/`index`, nor repoint a gitdir pointer (`commondir`,
 * `gitdir`, or the `.git` file) at an attacker-chosen directory.
 *
 * Guards are emitted as `denyWrite` (a read-only self-bind) so they win over
 * any `allowWrite` rule, including `$repo`/`$worktrees`.
 *
 * Two subtleties are load-bearing:
 *
 * - **Every path is realpath-resolved.** The tool policy canonicalizes targets
 *   (`normalizeTarget`), so a guard recorded lexically would not match a
 *   symlinked `.git/config`. Resolving here keeps the mount layer and the
 *   policy layer agreeing on the same path.
 * - **Missing paths are only guarded when git would actually read them.**
 *   bwrap creates the destination of a bind, so guarding a missing file leaves
 *   a 0-byte artifact on the host; an empty `commondir`/`gitdir` makes git fail
 *   outright. `config.worktree` is the exception: it is only read when
 *   `extensions.worktreeConfig` is on, and an empty file there is harmless, so
 *   it is worth blocking *creation* to close the redirect vector.
 */
export function buildGitGuard(git: GitLayout | null | undefined): ResolvedGitGuard {
	if (!git) {
		return { detected: false, active: false, commonDir: null, gitDir: null, writable: [], readOnly: [], blockCreate: [] };
	}

	const readOnly: string[] = [];
	const blockCreate: GitBlockCreate[] = [];

	/** Guard an existing path; a missing one is only blocked when told to. */
	const add = (
		path: string | null | undefined,
		options: { blockIfMissing?: boolean; isDir?: boolean } = {},
	): void => {
		if (!path) return;
		if (existsSync(path)) {
			readOnly.push(safeRealpath(path));
		} else if (options.blockIfMissing) {
			blockCreate.push({ path: resolveForGuard(path), isDir: options.isDir ?? false });
		}
	};

	// Shared config and hooks: writable here means code execution on the host.
	// `config.worktree` is blocked even when absent, but only when git would read
	// it; otherwise a 0-byte artifact would appear in every repo for nothing.
	add(join(git.commonDir, "config"));
	add(join(git.commonDir, "config.worktree"), { blockIfMissing: git.worktreeConfigEnabled });
	// A hooks directory that does not exist yet is still a vector: git reads it
	// once created, and a relative `core.hooksPath` (`.husky/_`) resolves inside
	// a writable worktree. Blocking creation is the only way to cover it.
	for (const hooksDir of git.hooksDirs) add(hooksDir, { blockIfMissing: true, isDir: true });
	add(join(git.commonDir, "info"));

	// Every worktree's private gitdir. Guarding a sibling wholesale covers its
	// `HEAD`, `index`, and pointer files in one mount.
	for (const sibling of git.siblingGitDirs) add(sibling);

	if (git.gitDir !== git.commonDir) {
		// Our own pointer files: rewriting them repoints the gitdir.
		add(join(git.gitDir, "commondir"));
		add(join(git.gitDir, "gitdir"));
		add(join(git.gitDir, "config.worktree"), { blockIfMissing: git.worktreeConfigEnabled });
		// The main checkout's metadata lives in the common dir, which `$repo` /
		// `$worktrees` make writable. This branch only runs for a *linked*
		// worktree, whose own HEAD/index live in `gitDir`, so guarding the main
		// checkout's copy cannot break the command being run.
		add(join(git.commonDir, "HEAD"));
		add(join(git.commonDir, "index"));
		add(join(git.commonDir, "ORIG_HEAD"));
	}

	// Every worktree's `.git` pointer *file*. The main checkout's `.git` is a
	// directory holding the shared store; guarding it would undo the writable
	// binds above.
	for (const worktree of git.worktrees) {
		const pointer = join(worktree, ".git");
		if (isFile(pointer)) add(pointer);
	}

	return {
		detected: true,
		active: true,
		commonDir: git.commonDir,
		gitDir: git.gitDir,
		writable: [],
		readOnly: dedupStrings(readOnly),
		blockCreate: dedupBlockCreate(blockCreate),
	};
}

/**
 * Paths git must be able to write to commit from a linked worktree.
 *
 * A linked worktree's `.git` file points at `<commonDir>/worktrees/<name>`,
 * which holds that checkout's `HEAD`/`index`; the shared object store, refs,
 * and reflogs live in the common dir. Only the last group needs opening, and
 * only when the user opted in by referencing a git variable.
 */
export function gitWritablePaths(git: GitLayout | null | undefined): string[] {
	if (!git) return [];
	// The main checkout's gitdir *is* the common dir and sits inside the repo,
	// so `allowWrite: ["."]` already covers it. Binding it again is harmless
	// and keeps the two cases uniform.
	if (git.gitDir === git.commonDir) return [git.commonDir];

	const paths = [git.gitDir];
	for (const name of ["objects", "refs", "logs", "packed-refs"]) {
		paths.push(join(git.commonDir, name));
	}
	return paths.filter((path) => existsSync(path));
}

/** True when any rule references `$repo`, `$worktree`, or `$worktrees`. */
function usesGitVariables(rules: string[] | undefined): boolean {
	return (rules ?? []).some((rule) => usesKnownVariable(rule));
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
	/** Git plumbing for the command cwd; enables the automatic git guard. */
	git?: GitLayout | null;
}

/**
 * Cached per config-file stat: JSON parse + layer merge only. Path and glob
 * expansion is deliberately NOT cached, so a file created after startup
 * (e.g. a new `.env`) is protected on the very next command without needing
 * `/sandbox-reload`.
 */
interface RawConfig {
	merged: SandboxConfigFile;
	globalPath: string;
	projectPath: string | null;
	projectTrusted: boolean;
	warnings: string[];
}

const rawCache = new Map<string, RawConfig>();

export function clearConfigCache(): void {
	rawCache.clear();
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
	git: GitLayout | null | undefined,
): ResolvedSandboxConfig {
	const warnings = sources.warnings;
	const variables = pathVariableContext({
		projectRoot: sources.projectRoot,
		worktreeRoot: sources.worktreeRoot,
		worktrees: git?.worktrees,
	});
	const expandAll = (rules: string[] | undefined): ResolvedPath[] =>
		dedupPaths((rules ?? []).flatMap((rule) => expandRuleWithVariables(rule, cwd, variables, warnings)));

	const gitGuard = buildGitGuard(git);
	// The read-only guards are unconditional: they only ever *remove* write
	// access that a broad allowWrite (`.`, `$repo`, `$worktrees`) would
	// otherwise grant, so applying them when nothing is granted is a harmless
	// no-op. Opening the git store is the opt-in half — and only an *allowWrite*
	// variable opts in, so mentioning `$worktrees` in denyWrite cannot silently
	// widen what the sandbox may write.
	const gitEnabled = gitGuard.detected && usesGitVariables(merged.filesystem?.allowWrite);

	const allowWrite = expandAll(merged.filesystem?.allowWrite);
	const denyWrite = expandAll(merged.filesystem?.denyWrite);
	const extraReadwrite = expandAll(merged.mxc?.extraReadwritePaths);
	const extraReadonly = expandAll(merged.mxc?.extraReadonlyPaths);
	const extraDenied = expandAll(merged.mxc?.extraDeniedPaths);

	const allowWritePaths = new Set(allowWrite.map((path) => path.path));
	const denyWritePaths = new Set(denyWrite.map((path) => path.path));

	const gitWritable: ResolvedPath[] = [];
	const gitReadOnly: ResolvedPath[] = [];
	if (gitEnabled) appendGuardPaths(gitWritable, allowWritePaths, gitWritablePaths(git));
	appendGuardPaths(gitReadOnly, denyWritePaths, gitGuard.readOnly);

	// The built-in `write`/`edit` tools do not run inside bwrap; they are gated
	// by the tool policy, which matches `rules.denyWrite` (raw patterns) rather
	// than the resolved `denyWrite` paths. The guards must appear in both, or
	// the `write` tool could set `.git/config`'s `core.hooksPath` and reach host
	// code execution without ever going through the mount layer. Paths that do
	// not exist yet (denyCreate) are included for the same reason: a denyWrite
	// *rule* cannot express "must not be created".
	const denyCreate: ResolvedPath[] = gitGuard.blockCreate.map((entry) => ({
		path: entry.path,
		isDir: entry.isDir,
		rule: "$git",
	}));
	const rawDenyWrite = dedupStrings([
		...(merged.filesystem?.denyWrite ?? []),
		...(merged.mxc?.extraReadonlyPaths ?? []),
		...gitReadOnly.map((path) => path.path),
		...denyCreate.map((path) => path.path),
	]);

	const env = merged.env ?? {};
	return {
		enabled: merged.enabled ?? true,
		engine: merged.engine ?? "auto",
		mxc: {
			backend: merged.mxc?.backend ?? "auto",
			shell: merged.mxc?.shell ?? "busybox",
			busyboxPath: merged.mxc?.busyboxPath,
			executorPath: merged.mxc?.executorPath,
			extraReadwrite,
			extraReadonly,
			extraDenied,
		},
		network: merged.network ?? "none",
		allowWrite: [...allowWrite, ...gitWritable, ...extraReadwrite],
		denyWrite: [...denyWrite, ...gitReadOnly, ...extraReadonly],
		denyCreate,
		denyRead: [...expandAll(merged.filesystem?.denyRead), ...extraDenied],
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
		rules: {
			allowWrite: [...(merged.filesystem?.allowWrite ?? []), ...(merged.mxc?.extraReadwritePaths ?? [])],
			denyWrite: rawDenyWrite,
			denyRead: [...(merged.filesystem?.denyRead ?? []), ...(merged.mxc?.extraDeniedPaths ?? [])],
		},
		variables,
		gitGuard: {
			detected: gitGuard.detected,
			active: gitEnabled,
			commonDir: gitGuard.commonDir,
			gitDir: gitGuard.gitDir,
			writable: gitWritable.map((path) => path.path),
			readOnly: gitReadOnly.map((path) => path.path),
			blockCreate: gitGuard.blockCreate,
		},
		tools: {
			enabled: merged.tools?.enabled ?? true,
			requireAllowWrite: merged.tools?.requireAllowWrite ?? true,
		},
		sources,
	};
}

/**
 * Load, merge, and expand config for one command. Results are cached by
 * config-file stat + cwd + trust, so repeated commands do not re-read disk.
 */
function loadRawConfig(input: LoadSandboxConfigInput): RawConfig {
	const { globalPath, projectPath } = getConfigPaths(input);
	const key = [
		globalPath,
		statKey(globalPath),
		projectPath ?? "none",
		statKey(projectPath),
		String(input.projectTrusted),
	].join("|");

	const cached = rawCache.get(key);
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

	const raw: RawConfig = {
		merged: mergeConfigLayers(DEFAULT_CONFIG, globalLayer, projectLayer),
		globalPath,
		projectPath,
		projectTrusted: input.projectTrusted,
		warnings,
	};

	rawCache.set(key, raw);
	if (rawCache.size > 64) {
		const oldest = rawCache.keys().next().value;
		if (oldest !== undefined) rawCache.delete(oldest);
	}
	return raw;
}

/**
 * Load, merge, and expand config for one command. Parsing/merging is cached
 * by config-file stat; path and glob expansion runs every call so files
 * created after startup are picked up immediately.
 */
export function loadSandboxConfig(input: LoadSandboxConfigInput): ResolvedSandboxConfig {
	const raw = loadRawConfig(input);
	return normalize(
		raw.merged,
		input.cwd,
		{
			globalPath: raw.globalPath,
			projectPath: raw.projectPath,
			projectTrusted: raw.projectTrusted,
			warnings: [...raw.warnings],
			projectRoot: input.projectRoot,
			worktreeRoot: input.worktreeRoot,
		},
		input.git,
	);
}
