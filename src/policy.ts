/**
 * Tool-call policy: the second half of the sandbox.
 *
 * bubblewrap only wraps `bash`. The built-in `read`, `write`, and `edit`
 * tools run directly on the host, so they are gated here via the `tool_call`
 * hook using the same rules as the bash sandbox:
 * - `read` / `grep` / `find` / `ls` are blocked when the target matches a
 *   denyRead rule
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

/** Built-in read-only tools that can reach denyRead paths via their `path` argument. */
export const READ_ONLY_POLICY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** Built-in mutating tools. */
export const WRITE_POLICY_TOOLS = new Set(["write", "edit"]);

/** Every tool the policy intercepts. */
export const POLICY_TOOLS = new Set([...READ_ONLY_POLICY_TOOLS, ...WRITE_POLICY_TOOLS]);

export function evaluateToolCall(input: ToolCallPolicyInput): ToolCallPolicyDecision {
	const { toolName, path, cwd, config } = input;
	if (!config.tools.enabled) return { block: false };

	const isReadOnly = READ_ONLY_POLICY_TOOLS.has(toolName);
	const isWrite = WRITE_POLICY_TOOLS.has(toolName);
	if (!isReadOnly && !isWrite) return { block: false };

	const target = normalizeTarget(path, cwd);
	const matchesDenyRead = config.rules.denyRead.some((rule) => targetMatchesDenyRule(target, rule, cwd));
	const matchesDenyWrite = config.rules.denyWrite.some((rule) => targetMatchesDenyRule(target, rule, cwd));

	if (isReadOnly) {
		if (matchesDenyRead) return { block: true, reason: `${toolName} blocked: "${path}" matches denyRead` };
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

export interface PathExplanation {
	target: string;
	read: ToolCallPolicyDecision;
	write: ToolCallPolicyDecision;
	denyReadRules: string[];
	denyWriteRules: string[];
	allowWriteRules: string[];
	/** True when the bash sandbox hides the path from reads. */
	bashReadHidden: boolean;
	/** True when the bash sandbox blocks writes (deny rule, or outside allowWrite). */
	bashWriteBlocked: boolean;
}

/** Explain how a path is treated by both the bash sandbox and the tool policy. */
export function explainPath(input: {
	path: string;
	cwd: string;
	config: ResolvedSandboxConfig;
}): PathExplanation {
	const { path, cwd, config } = input;
	const target = normalizeTarget(path, cwd);
	const denyReadRules = config.rules.denyRead.filter((rule) => targetMatchesDenyRule(target, rule, cwd));
	const denyWriteRules = config.rules.denyWrite.filter((rule) => targetMatchesDenyRule(target, rule, cwd));
	const allowWriteRules = config.rules.allowWrite.filter((rule) => targetWithinRule(target, rule, cwd));

	return {
		target,
		read: evaluateToolCall({ toolName: "read", path, cwd, config }),
		write: evaluateToolCall({ toolName: "write", path, cwd, config }),
		denyReadRules,
		denyWriteRules,
		allowWriteRules,
		bashReadHidden: denyReadRules.length > 0,
		bashWriteBlocked: denyReadRules.length > 0 || denyWriteRules.length > 0 || allowWriteRules.length === 0,
	};
}
