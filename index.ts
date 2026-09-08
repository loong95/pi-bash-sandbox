/**
 * pi-bash-sandbox extension entry point.
 *
 * Overrides the built-in `bash` tool with a bubblewrap-sandboxed
 * implementation (decision D2), routes `!` / `!!` user bash through the same
 * operations, and adds `/sandbox` + `/sandbox-reload` commands.
 */

import {
	createBashToolDefinition,
	createLocalBashOperations,
	getShellConfig,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { clearConfigCache, loadSandboxConfig, resolveAgentDir } from "./src/config.ts";
import { createSandboxedBashOperations } from "./src/exec.ts";
import { evaluateToolCall, POLICY_TOOLS } from "./src/policy.ts";
import { clearProbeCache, probeBwrap } from "./src/probe.ts";
import { clearProjectCache, resolveProjectRoot } from "./src/project.ts";
import { clearShellSettingsCache, resolveShellSettings } from "./src/settings.ts";
import { formatSandboxStatus } from "./src/ui.ts";

export default function piBashSandbox(pi: ExtensionAPI): void {
	pi.registerFlag("no-sandbox", {
		type: "boolean",
		default: false,
		description: "Run bash without bubblewrap sandboxing",
	});

	const fallback = createLocalBashOperations();

	function makeOperations(projectTrusted: boolean, ctx?: ExtensionContext, shellPath?: string) {
		return createSandboxedBashOperations({
			resolveConfig: async (cwd) => {
				const project = await resolveProjectRoot(cwd);
				return loadSandboxConfig({
					projectRoot: project.projectRoot,
					worktreeRoot: project.worktreeRoot,
					cwd,
					projectTrusted,
					agentDir: resolveAgentDir(),
				});
			},
			capabilities: () => probeBwrap(),
			shell: () => getShellConfig(shellPath),
			enabled: () => !pi.getFlag("no-sandbox"),
			fallback,
			onUnavailable: (reason, cwd) => {
				ctx?.ui.notify(`Sandbox unavailable in ${cwd}: ${reason}. Running unsandboxed.`, "warning");
			},
		});
	}

	// Override the built-in `bash` tool. `createBashToolDefinition` gives us the
	// built-in renderers, truncation, streaming, and timeout handling for free.
	const localBash = createBashToolDefinition(process.cwd());
	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwd = ctx?.cwd ?? process.cwd();
			const trusted = ctx?.isProjectTrusted() ?? true;
			const shellSettings = resolveShellSettings(cwd, trusted);
			const operations = makeOperations(trusted, ctx, shellSettings.shellPath);
			const sandboxed = createBashToolDefinition(cwd, {
				operations,
				commandPrefix: shellSettings.commandPrefix,
				shellPath: shellSettings.shellPath,
			});
			return sandboxed.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});

	// Route `!` / `!!` user commands through the sandbox too. pi core already
	// applies the shell command prefix on this path, so we only supply operations.
	pi.on("user_bash", async (_event, ctx) => {
		const shellSettings = resolveShellSettings(ctx.cwd, ctx.isProjectTrusted());
		return { operations: makeOperations(ctx.isProjectTrusted(), ctx, shellSettings.shellPath) };
	});

	// Gate the built-in file tools, which do NOT run inside bwrap. Read-only
	// tools default to cwd when `path` is omitted.
	pi.on("tool_call", async (event, ctx) => {
		if (pi.getFlag("no-sandbox")) return undefined;
		if (!POLICY_TOOLS.has(event.toolName)) return undefined;

		const input = event.input as { path?: unknown };
		const path =
			typeof input.path === "string" && input.path.length > 0 ? input.path : ctx.cwd;

		const cwd = ctx.cwd;
		const project = await resolveProjectRoot(cwd);
		const config = loadSandboxConfig({
			projectRoot: project.projectRoot,
			worktreeRoot: project.worktreeRoot,
			cwd,
			projectTrusted: ctx.isProjectTrusted(),
			agentDir: resolveAgentDir(),
		});
		if (!config.enabled) return undefined;

		const decision = evaluateToolCall({ toolName: event.toolName, path, cwd, config });
		if (decision.block) {
			ctx.ui.notify(decision.reason ?? "blocked by sandbox policy", "warning");
			return { block: true, reason: decision.reason };
		}
		return undefined;
	});

	pi.registerCommand("sandbox", {
		description: "Show resolved sandbox configuration and bwrap status",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd;
			const project = await resolveProjectRoot(cwd);
			const config = loadSandboxConfig({
				projectRoot: project.projectRoot,
				worktreeRoot: project.worktreeRoot,
				cwd,
				projectTrusted: ctx.isProjectTrusted(),
				agentDir: resolveAgentDir(),
			});
			const capabilities = probeBwrap();
			ctx.ui.notify(
				formatSandboxStatus({
					enabled: !pi.getFlag("no-sandbox"),
					project,
					config,
					capabilities,
				}),
				"info",
			);
		},
	});

	pi.registerCommand("sandbox-reload", {
		description: "Clear sandbox caches so config is re-read on the next command",
		handler: async (_args, ctx) => {
			clearConfigCache();
			clearProbeCache();
			clearProjectCache();
			clearShellSettingsCache();
			ctx.ui.notify("Sandbox caches cleared; config will be re-read on the next command.", "info");
		},
	});
}
