/**
 * Pure bwrap argument construction.
 *
 * Mount order is significant: later mounts cover earlier ones, so it is
 * always `--ro-bind / /` first, then writable binds, then deny rules
 * (denyRead last so it wins over denyWrite for a path in both).
 *
 * denyWrite is implemented as `--ro-bind <path> <path>` (content stays
 * readable, writes fail). denyRead of a file uses `--ro-bind /dev/null`
 * (content hidden); denyRead of a directory uses `--tmpfs` (empty dir).
 */

import type { BwrapCapabilities, ResolvedSandboxConfig } from "./types.ts";

export interface ShellSpec {
	shell: string;
	args: string[];
	/** "stdin" pipes the command to the shell instead of appending it to argv. */
	commandTransport?: "argv" | "stdin";
}

export interface BuildBwrapInput {
	command: string;
	cwd: string;
	/** Fully resolved environment to expose inside the sandbox. */
	env: Record<string, string>;
	config: ResolvedSandboxConfig;
	capabilities: BwrapCapabilities;
	shell: ShellSpec;
	/** Override argv[0]; defaults to "bwrap". */
	bwrapPath?: string;
}

/** Returns argv ready for `spawn`, with `argv[0]` being the bwrap binary. */
export function buildBwrapArgs(input: BuildBwrapInput): string[] {
	const { config, capabilities, shell } = input;
	const args: string[] = [input.bwrapPath ?? "bwrap"];

	args.push("--new-session", "--die-with-parent");

	// Start from a clean env; only explicitly listed variables survive.
	args.push("--clearenv");
	for (const name of Object.keys(input.env).sort()) {
		args.push("--setenv", name, input.env[name]);
	}

	// Read-only host root. Everything below overlays this.
	args.push("--ro-bind", "/", "/");
	args.push("--dev", "/dev");

	// /tmp policy first, so allowWrite paths under /tmp are not shadowed by a
	// private tmpfs. An explicit allowWrite of /tmp still re-exposes it.
	if (config.tmp === "private") args.push("--tmpfs", "/tmp");
	else args.push("--bind", "/tmp", "/tmp");

	// Writable paths.
	for (const path of config.allowWrite) {
		args.push("--bind", path.path, path.path);
	}

	// denyWrite: keep content readable, make it read-only.
	for (const path of config.denyWrite) {
		args.push("--ro-bind", path.path, path.path);
	}

	// denyRead wins over denyWrite when a path appears in both.
	for (const path of config.denyRead) {
		if (path.isDir) args.push("--tmpfs", path.path);
		else args.push("--ro-bind", "/dev/null", path.path);
	}

	if (config.network === "none") args.push("--unshare-net");

	if (config.unsharePid) {
		args.push("--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try");
	}

	// Drop capabilities; only meaningful (and only safe) with a user namespace.
	if (capabilities.userNamespace) {
		args.push("--unshare-user", "--cap-drop", "ALL");
	}

	if (config.weakerNestedSandbox) {
		args.push("--bind", "/proc", "/proc");
	} else if (config.unsharePid && capabilities.procMount) {
		args.push("--proc", "/proc");
	}

	args.push("--chdir", input.cwd);
	args.push(...config.extraBwrapArgs);
	args.push("--", shell.shell, ...shell.args);

	if (shell.commandTransport !== "stdin") {
		args.push(input.command);
	}

	return args;
}
