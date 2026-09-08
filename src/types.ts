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

/** Policy for intercepting read/write/edit via the `tool_call` hook. */
export interface ToolsPolicyConfig {
	/** Intercept read/write/edit. Default true. */
	enabled?: boolean;
	/** Require write/edit targets to be inside an allowWrite rule. Default true. */
	requireAllowWrite?: boolean;
}

/** User-editable configuration. Every field is optional; layers merge. */
export interface SandboxConfigFile {
	enabled?: boolean;
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
}

/** Raw (unexpanded) path rules, used by the tool_call policy matcher. */
export interface RawPathRules {
	allowWrite: string[];
	denyWrite: string[];
	denyRead: string[];
}

export interface ResolvedToolsPolicy {
	enabled: boolean;
	requireAllowWrite: boolean;
}

/** Fully resolved config, ready for `buildBwrapArgs`. */
export interface ResolvedSandboxConfig {
	enabled: boolean;
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
