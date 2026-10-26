/**
 * Types for the MXC (Microsoft eXecution Container) engine.
 *
 * The extension talks to MXC through its standalone executor binaries rather
 * than the in-process SDK:
 *
 * - Linux:   `lxc-exec`
 * - macOS:   `mxc-exec-mac`
 * - Windows: `wxc-exec.exe`
 *
 * The executor consumes the stable `1.0.0` JSON contract and owns the workload
 * stdio, which keeps pi's own Node version requirement unchanged and avoids
 * loading native FFI libraries into the agent process.
 */

export type MxcBackend = "bubblewrap" | "seatbelt" | "processcontainer";

/** Windows shell used to interpret bash commands inside ProcessContainer. */
export type MxcWindowsShellKind = "busybox" | "powershell" | "cmd" | "custom";

/** A resolved command line plus the UI posture the shell needs. */
export interface MxcCommandSpec {
	commandLine: string;
	/** Write the command to stdin instead of embedding it in the command line. */
	commandFromStdin: boolean;
	/**
	 * Some shells (BusyBox-w32, PowerShell) need the Win32k subsystem to
	 * initialize, so the Windows sandbox must not disable UI access.
	 */
	allowsUi: boolean;
	/** Human-readable shell label for `/sandbox`. */
	label: string;
}

export interface MxcCapabilities {
	available: boolean;
	backend?: MxcBackend;
	executor?: string;
	version?: string;
	tier?: string;
	/** Resolved Windows shell label, or the POSIX shell path. */
	shell?: string;
	error?: string;
}

/** One filesystem policy list, already normalized to absolute host paths. */
export interface MxcFilesystemPolicy {
	readwritePaths: string[];
	readonlyPaths: string[];
	deniedPaths: string[];
}

/** The stable MXC 1.0.0 create-and-run request consumed by the executors. */
export interface MxcRequest {
	version: "1.0.0";
	containment: MxcBackend;
	lifecycle: {
		destroyOnExit: true;
		preservePolicy: false;
	};
	process: {
		commandLine: string;
		cwd: string;
		env: string[];
		timeout: number;
	};
	filesystem: MxcFilesystemPolicy;
	network: {
		egress: { default: "allow" | "deny" };
		ingress: { default: "allow" | "deny"; hostLoopback: "allow" | "deny" };
	};
	ui: {
		disable: boolean;
		clipboard: "none";
		injection: false;
	};
}
