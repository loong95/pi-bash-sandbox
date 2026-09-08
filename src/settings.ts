/**
 * Read the pi settings that affect bash execution.
 *
 * pi core bakes `shellCommandPrefix` and `shellPath` into the built-in bash
 * tool. Overriding that tool means we must apply them ourselves, otherwise a
 * configured prefix or shell is silently dropped. This also matters in
 * pi-web: its `pi-web-project-command-environment` host extension applies the
 * same settings, but it deliberately steps aside when a user extension
 * registers `bash`, so we inherit the responsibility.
 *
 * The agent bin directory (`~/.pi/agent/bin`) on PATH and the removal of
 * `NEXT_*` / `PORT` / `NODE_ENV` are already handled elsewhere: the former by
 * pi's `getShellEnv()` (which produces the env handed to `exec`), the latter
 * by our `--clearenv` + explicit passthrough.
 */

import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

export interface ShellSettings {
	commandPrefix?: string;
	shellPath?: string;
}

const cache = new Map<string, ShellSettings>();

export function clearShellSettingsCache(): void {
	cache.clear();
}

export function resolveShellSettings(cwd: string, projectTrusted: boolean): ShellSettings {
	const key = `${cwd}|${projectTrusted}`;
	const cached = cache.get(key);
	if (cached) return cached;

	let settings: ShellSettings = {};
	try {
		const manager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
		const commandPrefix = manager.getShellCommandPrefix();
		const shellPath = manager.getShellPath();
		if (commandPrefix !== undefined) settings.commandPrefix = commandPrefix;
		if (shellPath !== undefined) settings.shellPath = shellPath;
	} catch {
		// Unreadable settings fall back to pi defaults (no prefix, default shell).
	}

	cache.set(key, settings);
	return settings;
}
