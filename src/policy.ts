/**
 * Tool-call policy: the second half of the sandbox.
 *
 * bubblewrap only wraps `bash`. The built-in `read`, `write`, and `edit`
 * tools run directly on the host, so they are gated here via the `tool_call`
 * hook using the same rules as the bash sandbox:
 * - `read` is blocked when the target matches a denyRead rule
 * - `write` / `edit` are blocked on denyRead or denyWrite, and (by default)
 *   when the target is outside every allowWrite rule
 *
 * Rules are matched against the raw config strings, so globs like `.env.*`
 * and `*.pem` protect files that do not exist yet (unlike the bwrap path
 * expansion, which can only bind paths that exist at load time).
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { expandTilde, hasGlob } from "./config.ts";
import type { ResolvedSandboxConfig } from "./types.ts";

function escapeRegex(input: string): string {
	return input.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Path glob: `**` crosses separators, `*` / `?` do not. */
export function globToPathRegex(pattern: string): RegExp {
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				out += ".*";
				i++;
			} else {
				out += "[^/]*";
			}
		} else if (char === "?") {
			out += "[^/]";
		} else {
			out += escapeRegex(char);
		}
	}
	return new RegExp(`^${out}$`);
}

function resolveRule(rule: string, cwd: string): string {
	const expanded = expandTilde(rule);
	return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}

/** Resolve a tool target to an absolute, symlink-resolved path (new files keep a real parent). */
export function normalizeTarget(raw: string, cwd: string): string {
	const expanded = expandTilde(raw);
	const absolute = isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
	if (existsSync(absolute)) {
		try {
			return realpathSync(absolute);
		} catch {
			return absolute;
		}
	}
	try {
		return join(realpathSync(dirname(absolute)), basename(absolute));
	} catch {
		return absolute;
	}
}

/** allowWrite semantics: the target is the rule path or inside it (or matches a glob rule). */
export function targetWithinRule(target: string, rule: string, cwd: string): boolean {
	const absolute = resolveRule(rule, cwd);
	if (hasGlob(absolute)) return globToPathRegex(absolute).test(target);
	return target === absolute || target.startsWith(absolute.endsWith("/") ? absolute : `${absolute}/`);
}

/** deny semantics: a bare relative pattern (`.env`, `*.pem`) matches the basename anywhere. */
export function targetMatchesDenyRule(target: string, rule: string, cwd: string): boolean {
	const expanded = expandTilde(rule);
	if (!isAbsolute(expanded) && !expanded.includes("/")) {
		return globToPathRegex(expanded).test(basename(target));
	}
	return targetWithinRule(target, rule, cwd);
}

export interface ToolCallPolicyInput {
	toolName: string;
	path: string;
	cwd: string;
	config: ResolvedSandboxConfig;
}

export interface ToolCallPolicyDecision {
	block: boolean;
	reason?: string;
}

export function evaluateToolCall(input: ToolCallPolicyInput): ToolCallPolicyDecision {
	const { toolName, path, cwd, config } = input;
	if (!config.tools.enabled) return { block: false };
	if (toolName !== "read" && toolName !== "write" && toolName !== "edit") return { block: false };

	const target = normalizeTarget(path, cwd);
	const matchesDenyRead = config.rules.denyRead.some((rule) => targetMatchesDenyRule(target, rule, cwd));
	const matchesDenyWrite = config.rules.denyWrite.some((rule) => targetMatchesDenyRule(target, rule, cwd));

	if (toolName === "read") {
		if (matchesDenyRead) return { block: true, reason: `read blocked: "${path}" matches denyRead` };
		return { block: false };
	}

	if (matchesDenyRead) return { block: true, reason: `${toolName} blocked: "${path}" matches denyRead` };
	if (matchesDenyWrite) return { block: true, reason: `${toolName} blocked: "${path}" matches denyWrite` };

	if (config.tools.requireAllowWrite) {
		const withinAllowWrite = config.rules.allowWrite.some((rule) => targetWithinRule(target, rule, cwd));
		if (!withinAllowWrite) return { block: true, reason: `${toolName} blocked: "${path}" is outside allowWrite` };
	}

	return { block: false };
}
