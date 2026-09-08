/**
 * Human-readable `/sandbox` output. Kept separate from index.ts so it can be
 * unit tested without a running pi session.
 */

import type { ProjectInfo } from "./project.ts";
import type { BwrapCapabilities, ResolvedPath, ResolvedSandboxConfig } from "./types.ts";

function formatPaths(paths: ResolvedPath[]): string {
	return paths.length ? paths.map((path) => path.path).join(", ") : "(none)";
}

export interface SandboxStatusInput {
	/** Whether sandboxing is active (not disabled by `--no-sandbox`). */
	enabled: boolean;
	project: ProjectInfo;
	config: ResolvedSandboxConfig;
	capabilities: BwrapCapabilities;
}

export function formatSandboxStatus(input: SandboxStatusInput): string {
	const { config, capabilities, project } = input;
	const lines: string[] = [];

	lines.push(`bash sandbox: ${input.enabled ? "enabled" : "DISABLED (--no-sandbox)"}`);
	lines.push(`project root: ${project.projectRoot}${project.isWorktree ? " (linked worktree)" : ""}`);
	if (project.isWorktree) lines.push(`worktree: ${project.worktreeRoot}`);
	lines.push(
		`config: global=${config.sources.globalPath} project=${config.sources.projectPath ?? "(none)"} trusted=${config.sources.projectTrusted}`,
	);
	lines.push(
		`bwrap: ${
			capabilities.available ? `available${capabilities.version ? ` v${capabilities.version}` : ""}` : "UNAVAILABLE"
		} (userns=${capabilities.userNamespace}, proc=${capabilities.procMount})`,
	);
	if (capabilities.error) lines.push(`  note: ${capabilities.error}`);

	lines.push(`network: ${config.network}`);
	lines.push(`tmp: ${config.tmp}`);
	lines.push(`allowWrite: ${formatPaths(config.allowWrite)}`);
	lines.push(`denyWrite: ${formatPaths(config.denyWrite)}`);
	lines.push(`denyRead: ${formatPaths(config.denyRead)}`);
	lines.push(`env passthrough: ${config.env.passthrough.join(", ") || "(none)"}`);
	lines.push(`env deny: ${config.env.deny.join(", ") || "(none)"}`);

	if (config.extraBwrapArgs.length > 0) {
		lines.push(`extraBwrapArgs (RISK — verbatim): ${config.extraBwrapArgs.join(" ")}`);
	}
	if (config.sources.warnings.length > 0) {
		lines.push("warnings:");
		for (const warning of config.sources.warnings) lines.push(`  - ${warning}`);
	}

	return lines.join("\n");
}
