/**
 * Environment filtering for the sandbox.
 *
 * The source env is whatever pi already computed for the command
 * (`resolveSpawnContext` in pi's bash tool), so PI_* session variables and
 * any spawnHook edits are preserved. We apply the sandbox's allow/deny rules
 * on top and emit an explicit `--setenv` set (the sandbox runs with
 * `--clearenv`, so anything not listed here does not exist inside).
 */

import type { ResolvedEnvConfig } from "./types.ts";

function globToRegex(pattern: string): RegExp {
	let out = "";
	for (const char of pattern) {
		if (char === "*") out += ".*";
		else if (char === "?") out += ".";
		else out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`);
}

/** Match a variable name against a `*`/`?` glob. Literal names match exactly. */
export function matchGlob(name: string, pattern: string): boolean {
	if (pattern === name) return true;
	if (!pattern.includes("*") && !pattern.includes("?")) return false;
	return globToRegex(pattern).test(name);
}

/**
 * Filter `source` down to the sandbox environment.
 *
 * Rules: deny wins over passthrough; explicit `set` entries always win (the
 * user asked for them by name). Keys are sorted for deterministic output.
 */
export function resolveSandboxEnv(
	source: NodeJS.ProcessEnv,
	config: ResolvedEnvConfig,
): Record<string, string> {
	const out: Record<string, string> = {};
	const isDenied = (name: string) => config.deny.some((pattern) => matchGlob(name, pattern));
	const isAllowed = (name: string) => config.passthrough.some((pattern) => matchGlob(name, pattern));

	for (const name of Object.keys(source).sort()) {
		const value = source[name];
		if (value === undefined) continue;
		if (isDenied(name)) continue;
		if (!isAllowed(name)) continue;
		out[name] = value;
	}

	for (const name of Object.keys(config.set).sort()) {
		out[name] = config.set[name];
	}

	return out;
}
