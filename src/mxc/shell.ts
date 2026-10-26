/**
 * Shell selection and command-line construction for MXC.
 *
 * On Unix the shell is whatever pi would have used (`/bin/bash -c`), quoted
 * for the `sh -c` wrapper MXC uses on the bubblewrap and Seatbelt backends.
 *
 * Windows ProcessContainer executes the command line directly with
 * `CreateProcessW`, and the natural choice — Git Bash — cannot run there:
 * MSYS2/Cygwin creates its shared-memory directory under
 * `\BaseNamedObjects`, which the container's object namespace blocks. The
 * working alternatives are:
 *
 * - `busybox` (BusyBox-w32): POSIX `sh`, no Cygwin runtime, needs Win32k
 * - `powershell`: native but not bash-compatible
 * - `cmd`: native, most limited
 *
 * BusyBox and PowerShell require `ui.disable: false` so Win32k can initialize;
 * cmd can run with UI fully disabled.
 */

import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join, win32 } from "node:path";
import type { ShellSpec } from "../bwrap.ts";
import type { MxcShellChoice } from "../types.ts";
import type { MxcCommandSpec } from "./types.ts";

/** POSIX single-quote an argument. */
export function quotePosixArg(argument: string): string {
	if (argument.length > 0 && /^[A-Za-z0-9_./:=@%+,-]+$/.test(argument)) return argument;
	return `'${argument.replace(/'/g, "'\\''")}'`;
}

/**
 * Quote one argument using the MSVC CRT algorithm that `CreateProcessW`
 * consumers (including BusyBox and PowerShell) use.
 */
export function quoteWindowsArg(argument: string): string {
	if (argument.length === 0) return '""';
	if (!/[\s"]/.test(argument)) return argument;

	let out = '"';
	let backslashes = 0;
	for (const char of argument) {
		if (char === "\\") {
			backslashes++;
			continue;
		}
		if (char === '"') {
			out += "\\".repeat(backslashes * 2 + 1) + '"';
			backslashes = 0;
			continue;
		}
		out += "\\".repeat(backslashes) + char;
		backslashes = 0;
	}
	out += "\\".repeat(backslashes * 2) + '"';
	return out;
}

/** `cmd.exe /c` has its own quote rules: double embedded quotes. */
export function quoteCmdArg(argument: string): string {
	return `"${argument.replace(/"/g, '""')}"`;
}

export interface FindExecutableOptions {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	exists?: (path: string) => boolean;
}

function windowsExtensions(env: NodeJS.ProcessEnv): string[] {
	const pathext = Object.entries(env).find(([key]) => key.toLowerCase() === "pathext")?.[1];
	const listed = (pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
	return [...new Set(["", ...listed.map((ext) => ext.toLowerCase())])];
}

/** Find an executable by absolute path or on PATH. */
export function findExecutable(
	name: string,
	options: FindExecutableOptions = {},
): string | null {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const exists = options.exists ?? existsSync;

	if (platform === "win32") {
		if (win32.isAbsolute(name) && exists(name)) return name;
		const hasExtension = /\.[^.\\/]+$/.test(name);
		const suffixes = hasExtension ? [""] : windowsExtensions(env);
		const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
		for (const directory of pathValue.split(win32.delimiter)) {
			if (!directory) continue;
			for (const suffix of suffixes) {
				const candidate = win32.join(directory, `${name}${suffix}`);
				if (exists(candidate)) return candidate;
			}
		}
		return null;
	}

	if (isAbsolute(name)) return exists(name) ? name : null;
	for (const directory of (env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		const candidate = join(directory, name);
		if (exists(candidate)) return candidate;
	}
	return null;
}

function windowsLabel(kind: string, executable: string): string {
	return `${kind}: ${executable}`;
}

function windowsSpec(
	commandLine: string,
	label: string,
	allowsUi: boolean,
	commandFromStdin = false,
): MxcCommandSpec {
	return { commandLine, commandFromStdin, allowsUi, label };
}

/**
 * Resolve the Windows shell and build its command line.
 *
 * `choice` is the `mxc.shell` config value. Anything that is not one of the
 * three known kinds is treated as a custom executable invoked as `<exe> -c
 * <command>` — useful for a portable BusyBox or another POSIX-compatible
 * shell. Cygwin/MSYS2 shells will fail at startup inside ProcessContainer.
 */
export function resolveWindowsCommand(input: {
	choice: MxcShellChoice;
	command: string;
	busyboxPath?: string;
	env?: NodeJS.ProcessEnv;
	exists?: (path: string) => boolean;
}): { spec?: MxcCommandSpec; error?: string } {
	const env = input.env ?? process.env;
	const exists = input.exists ?? existsSync;
	const find = (name: string) => findExecutable(name, { platform: "win32", env, exists });

	if (input.choice === "busybox") {
		const candidates = [input.busyboxPath, "busybox", "busybox64"].filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		);
		let executable: string | null = null;
		for (const candidate of candidates) {
			executable = find(candidate);
			if (executable) break;
		}
		if (!executable) {
			return {
				error:
					"busybox.exe not found. Install BusyBox-w32 (e.g. `scoop install busybox`) or set mxc.busyboxPath. " +
					"Git Bash cannot run inside Windows ProcessContainer.",
			};
		}
		const commandLine = [executable, "sh", "-c", input.command].map(quoteWindowsArg).join(" ");
		return { spec: windowsSpec(commandLine, windowsLabel("busybox", executable), true) };
	}

	if (input.choice === "powershell") {
		const executable = find("pwsh") ?? find("powershell");
		if (!executable) return { error: "PowerShell not found (pwsh.exe or powershell.exe)." };
		const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", input.command];
		const commandLine = [executable, ...args].map(quoteWindowsArg).join(" ");
		return { spec: windowsSpec(commandLine, windowsLabel("powershell", executable), true) };
	}

	if (input.choice === "cmd") {
		const lookup = (name: string) =>
			Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
		const comspec = lookup("COMSPEC");
		const executable = comspec ?? win32.join(lookup("SystemRoot") ?? "C:\\Windows", "System32", "cmd.exe");
		if (!exists(executable)) return { error: `cmd.exe not found at ${executable}.` };
		const commandLine = `${quoteWindowsArg(executable)} /d /s /c ${quoteCmdArg(input.command)}`;
		return { spec: windowsSpec(commandLine, "cmd.exe", false) };
	}

	// Custom executable path or name. Assume POSIX-style `-c`.
	const executable = find(input.choice);
	if (!executable) return { error: `configured mxc.shell not found: ${input.choice}` };
	const commandLine = [executable, "-c", input.command].map(quoteWindowsArg).join(" ");
	return { spec: windowsSpec(commandLine, windowsLabel("custom", executable), true) };
}

/** Build the command line for a POSIX shell (Linux/macOS). */
export function resolvePosixCommand(shell: ShellSpec, command: string): MxcCommandSpec {
	if (shell.commandTransport === "stdin") {
		return {
			commandLine: [shell.shell, ...shell.args].map(quotePosixArg).join(" "),
			commandFromStdin: true,
			allowsUi: false,
			label: shell.shell,
		};
	}
	return {
		commandLine: [shell.shell, ...shell.args, command].map(quotePosixArg).join(" "),
		commandFromStdin: false,
		allowsUi: false,
		label: shell.shell,
	};
}
