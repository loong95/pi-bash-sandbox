/**
 * Human-readable `/sandbox` output. Kept separate from index.ts so it can be
 * unit tested without a running pi session.
 */

import type { PathExplanation } from "./policy.ts";
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
	lines.push(
		`tools: ${config.tools.enabled ? `intercepted (requireAllowWrite=${config.tools.requireAllowWrite})` : "NOT intercepted"}`,
	);

	if (config.extraBwrapArgs.length > 0) {
		lines.push(`extraBwrapArgs (RISK — verbatim): ${config.extraBwrapArgs.join(" ")}`);
	}
	if (config.sources.warnings.length > 0) {
		lines.push("warnings:");
		for (const warning of config.sources.warnings) lines.push(`  - ${warning}`);
	}

	return lines.join("\n");
}

/** POSIX single-quote an argument when it is not obviously safe. */
export function shellQuote(argument: string): string {
	if (argument.length > 0 && /^[A-Za-z0-9_./:=@%+,-]+$/.test(argument)) return argument;
	return `'${argument.replace(/'/g, "'\\''")}'`;
}

/** Render an argv as a copy-pasteable shell command. */
export function formatArgv(argv: string[]): string {
	return argv.map(shellQuote).join(" ");
}

/** Render a `/sandbox-why` explanation. */
export function formatPathExplanation(explanation: PathExplanation): string {
	const lines: string[] = [`path: ${explanation.target}`];
	const decision = (label: string, value: { block: boolean; reason?: string }) =>
		`  ${label}: ${value.block ? `BLOCKED \u2014 ${value.reason}` : "allowed"}`;

	lines.push(decision("read ", explanation.read));
	lines.push(decision("write", explanation.write));
	lines.push(
		`  bash : ${explanation.bashReadHidden ? "read hidden" : "readable"}, ${
			explanation.bashWriteBlocked ? "write blocked" : "writable"
		}`,
	);
	if (explanation.denyReadRules.length > 0) lines.push(`  denyRead  \u2190 ${explanation.denyReadRules.join(", ")}`);
	if (explanation.denyWriteRules.length > 0) lines.push(`  denyWrite \u2190 ${explanation.denyWriteRules.join(", ")}`);
	if (explanation.allowWriteRules.length > 0)
		lines.push(`  allowWrite \u2190 ${explanation.allowWriteRules.join(", ")}`);

	return lines.join("\n");
}
