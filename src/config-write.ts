/**
 * Write-side helpers for the config files: used by `/sandbox-init`,
 * `/sandbox-enable`, and `/sandbox-disable`.
 *
 * Existing files are read, patched, and written back as pretty JSON so that
 * unrelated keys are preserved. There are no comments in JSON, so nothing is
 * lost by round-tripping.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, SANDBOX_CONFIG_FILENAME } from "./config.ts";

export type ConfigScope = "global" | "project";

export interface ConfigPathInput {
	projectRoot: string;
	worktreeRoot: string;
	agentDir: string;
}

/** Global config, or the worktree-local project config. */
export function configPathForScope(scope: ConfigScope, input: ConfigPathInput): string {
	return scope === "global"
		? join(input.agentDir, SANDBOX_CONFIG_FILENAME)
		: join(input.worktreeRoot, CONFIG_DIR_NAME, SANDBOX_CONFIG_FILENAME);
}

export const CONFIG_TEMPLATE = {
	enabled: true,
	network: "none",
	filesystem: {
		allowWrite: [".", "/tmp"],
		denyWrite: ["~/.ssh", ".env", ".env.*", "*.pem", "*.key"],
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gh"],
	},
	tmp: "private",
	env: {
		passthrough: ["PATH", "HOME", "TERM", "LANG", "LC_*", "TMPDIR", "PI_*"],
		deny: ["*_KEY", "*_TOKEN", "*_SECRET", "*_PASSWORD", "ANTHROPIC_*", "OPENAI_*"],
	},
	tools: { enabled: true, requireAllowWrite: true },
} as const;

function readJsonObject(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${path} is not a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

function writeJsonObject(path: string, value: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Set (or clear) the `enabled` flag, preserving every other key. */
export function setConfigEnabled(path: string, enabled: boolean): void {
	const config = readJsonObject(path);
	config.enabled = enabled;
	writeJsonObject(path, config);
}

/** Create a starter config. Refuses to overwrite an existing file. */
export function writeConfigTemplate(path: string): void {
	if (existsSync(path)) throw new Error(`${path} already exists`);
	writeJsonObject(path, CONFIG_TEMPLATE as unknown as Record<string, unknown>);
}
