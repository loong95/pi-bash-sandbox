/**
 * Public types for pi-bash-sandbox.
 *
 * `SandboxConfigFile` is the user-editable shape of `sandbox.json`.
 * `ResolvedSandboxConfig` is the fully expanded form handed to the bwrap
 * argument builder: every path is absolute, existing, and realpath-resolved.
 */

export type NetworkMode = "none" | "host";
export type TmpMode = "private" | "shared";
export type UnavailablePolicy = "error" | "fallback";

/**
 * Execution engine.
 *
 * - `auto`: MXC where the host supports it, bubblewrap otherwise (Linux).
 * - `mxc`: MXC only; `onUnavailable` decides what happens if it cannot run.
 * - `bwrap`: the original bubblewrap argument builder (Linux only).
 */
export type EngineMode = "auto" | "mxc" | "bwrap";
export type MxcBackendChoice = "auto" | "bubblewrap" | "seatbelt" | "processcontainer";

/** Windows shell used to interpret bash commands under ProcessContainer. */
export type MxcShellChoice = "busybox" | "powershell" | "cmd" | string;

/** User-editable `mxc` section. */
export interface MxcConfigFile {
	backend?: MxcBackendChoice;
	/** Windows only. A kind (`busybox`/`powershell`/`cmd`) or an executable path. */
	shell?: MxcShellChoice;
	/** Explicit busybox.exe location; defaults to PATH lookup. */
	busyboxPath?: string;
	/** Override the MXC executor binary (advanced/testing). */
	executorPath?: string;
	/** Extra policy paths layered on top of the standard rules. */
	extraReadwritePaths?: string[];
	extraReadonlyPaths?: string[];
	extraDeniedPaths?: string[];
}

/** Policy for intercepting read/write/edit via the `tool_call` hook. */
export interface ToolsPolicyConfig {
	/** Intercept read/write/edit. Default true. */
	enabled?: boolean;
	/** Require write/edit targets to be inside an allowWrite rule. Default true. */
	requireAllowWrite?: boolean;
}

/** User-editable configuration. Every field is optional; layers merge. */
export interface SandboxConfigFile {
	/** Project-only escape hatch for array fields; global arrays are inherited by default. */
	replaceGlobalArrays?: string[];
	enabled?: boolean;
	/** Execution engine. Default `auto`: MXC when available, bubblewrap on Linux. */
	engine?: EngineMode;
	mxc?: MxcConfigFile;
	network?: NetworkMode;
	filesystem?: {
		allowWrite?: string[];
		denyWrite?: string[];
		denyRead?: string[];
	};
	tmp?: TmpMode;
	env?: {
		passthrough?: string[];
		deny?: string[];
		set?: Record<string, string>;
	};
	unsharePid?: boolean;
	weakerNestedSandbox?: boolean;
	onUnavailable?: UnavailablePolicy;
	/** Raw bwrap args appended verbatim. Powerful and risky; surfaced by /sandbox. */
	extraBwrapArgs?: string[];
	tools?: ToolsPolicyConfig;
}

/** A filesystem rule expanded to a concrete path. */
export interface ResolvedPath {
	/** Absolute, symlink-resolved path. */
	path: string;
	/** True for directories (denyRead uses tmpfs for dirs, /dev/null for files). */
	isDir: boolean;
	/** The original config rule that produced this path, for diagnostics. */
	rule: string;
}

/**
 * Paths that `$repo`, `$worktree`, and `$worktrees` expand to. Derived from
 * the git layout so a single `allowWrite: ["$worktrees"]` covers every linked
 * worktree, including ones created after the session started.
 *
 * This is the one definition of what the variables hold: `variables.ts`
 * substitutes against it and the tool policy (policy.ts) matches against it.
 */
export interface PathVariables {
	/** Main checkout root, shared by every worktree. */
	repo: string;
	/** Toplevel of the worktree the command runs in. */
	worktree: string;
	/** Every worktree root, main checkout first. Falls back to `[worktree]`. */
	worktrees: string[];
}

/** A path that must not be created, plus how to mask it in the mount layer. */
export interface GitBlockCreate {
	path: string;
	/** True when the path is a directory (mask with tmpfs); false masks with `/dev/null`. */
	isDir: boolean;
}

/** Auto-injected git protection, surfaced by `/sandbox` for diagnostics. */
export interface ResolvedGitGuard {
	/** True when a git repository was detected. */
	detected: boolean;
	/** True when the layer was applied (repo detected *and* a git variable used). */
	active: boolean;
	/** Shared git dir (`--git-common-dir`). */
	commonDir: string | null;
	/** This checkout's private git dir (`--git-dir`). */
	gitDir: string | null;
	/** Paths git must be able to write (added to allowWrite). */
	writable: string[];
	/** Paths kept read-only even when allowWrite covers the repo (added to denyWrite). */
	readOnly: string[];
	/**
	 * Paths that do not exist yet but must not be *created*, because git would
	 * read them once created (e.g. `config.worktree` with worktreeConfig on).
	 * Masked in the mount layer rather than read-only self-bound.
	 */
	blockCreate: GitBlockCreate[];
}

export interface ResolvedEnvConfig {
	passthrough: string[];
	deny: string[];
	set: Record<string, string>;
}

export interface ConfigSources {
	globalPath: string;
	projectPath: string | null;
	projectTrusted: boolean;
	warnings: string[];
	/** Main checkout root, used to expand `$repo`. */
	projectRoot: string;
	/** Current worktree toplevel, used to expand `$worktree`. */
	worktreeRoot: string;
}

/** Raw path rules for the tool_call policy matcher (globs stay unexpanded, variables are substituted). */
export interface RawPathRules {
	allowWrite: string[];
	denyWrite: string[];
	denyRead: string[];
}

export interface ResolvedToolsPolicy {
	enabled: boolean;
	requireAllowWrite: boolean;
}

/** Fully resolved `mxc` section. */
export interface ResolvedMxcConfig {
	backend: MxcBackendChoice;
	shell: MxcShellChoice;
	busyboxPath?: string;
	executorPath?: string;
	extraReadwrite: ResolvedPath[];
	extraReadonly: ResolvedPath[];
	extraDenied: ResolvedPath[];
}

/** Fully resolved config, ready for the selected engine. */
export interface ResolvedSandboxConfig {
	enabled: boolean;
	engine: EngineMode;
	mxc: ResolvedMxcConfig;
	network: NetworkMode;
	allowWrite: ResolvedPath[];
	denyWrite: ResolvedPath[];
	denyRead: ResolvedPath[];
	tmp: TmpMode;
	env: ResolvedEnvConfig;
	unsharePid: boolean;
	weakerNestedSandbox: boolean;
	onUnavailable: UnavailablePolicy;
	extraBwrapArgs: string[];
	/** Raw rules for the tool_call policy matcher (globs are not pre-expanded). */
	rules: RawPathRules;
	/**
	 * Paths that must not be *created*. Distinct from `denyWrite`, which
	 * read-only self-binds an existing path: these do not exist yet, so they are
	 * masked instead (tmpfs for a directory, `/dev/null` for a file).
	 */
	denyCreate: ResolvedPath[];	/** Resolved `$repo` / `$worktree` / `$worktrees` values. */
	variables: PathVariables;
	/** Automatic git protection layer derived from the repository layout. */
	gitGuard: ResolvedGitGuard;
	tools: ResolvedToolsPolicy;
	sources: ConfigSources;
}

/** Result of probing the local `bwrap` binary. */
export interface BwrapCapabilities {
	available: boolean;
	version?: string;
	/** Whether `--unshare-user` works (unprivileged user namespaces). */
	userNamespace: boolean;
	/** Whether `--proc /proc` can be mounted (requires `--unshare-pid`). */
	procMount: boolean;
	/** Human-readable reason when probing failed. */
	error?: string;
}
