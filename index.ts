/**
 * pi-bash-sandbox extension entry point.
 *
 * Overrides the built-in `bash` tool with a bubblewrap-sandboxed
 * implementation, routes `!` / `!!` user bash through the same operations,
 * gates the built-in file tools via `tool_call`, and registers the
 * `/sandbox*` commands.
 */

import {
	createBashToolDefinition,
	createLocalBashOperations,
	getShellConfig,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { buildBwrapArgs } from "./src/bwrap.ts";
import { clearConfigCache, loadSandboxConfig, resolveAgentDir } from "./src/config.ts";
import {
	configPathForScope,
	type ConfigScope,
	setConfigEnabled,
	writeConfigTemplate,
} from "./src/config-write.ts";
import { resolveSandboxEnv } from "./src/env.ts";
import { createSandboxedBashOperations } from "./src/exec.ts";
import { evaluateToolCall, explainPath, POLICY_TOOLS } from "./src/policy.ts";
import { clearProbeCache, probeBwrap } from "./src/probe.ts";
import { clearProjectCache, resolveProjectRoot } from "./src/project.ts";
import { clearShellSettingsCache, resolveShellSettings } from "./src/settings.ts";
import { formatArgv, formatPathExplanation, formatSandboxStatus } from "./src/ui.ts";

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

	async function configForContext(ctx: ExtensionContext) {
		const cwd = ctx.cwd;
		const project = await resolveProjectRoot(cwd);
		const config = loadSandboxConfig({
			projectRoot: project.projectRoot,
			worktreeRoot: project.worktreeRoot,
			cwd,
			projectTrusted: ctx.isProjectTrusted(),
			agentDir: resolveAgentDir(),
		});
		return { cwd, project, config };
	}

	const scopeCompletions = (prefix: string) =>
		["project", "global"]
			.filter((scope) => scope.startsWith(prefix))
			.map((scope) => ({ value: scope, label: scope }));

	function setEnabledHandler(enabled: boolean) {
		return async (args: string, ctx: ExtensionCommandContext) => {
			const scopeArg = args.trim().toLowerCase();
			if (scopeArg && scopeArg !== "global" && scopeArg !== "project") {
				ctx.ui.notify("Scope must be 'project' or 'global'.", "warning");
				return;
			}
			const scope: ConfigScope = scopeArg === "global" ? "global" : "project";
			const project = await resolveProjectRoot(ctx.cwd);
			const path = configPathForScope(scope, {
				projectRoot: project.projectRoot,
				worktreeRoot: project.worktreeRoot,
				agentDir: resolveAgentDir(),
			});
			try {
				setConfigEnabled(path, enabled);
				clearConfigCache();
				ctx.ui.notify(`Sandbox ${enabled ? "enabled" : "disabled"} (${scope}) \u2192 ${path}`, "info");
			} catch (error) {
				ctx.ui.notify((error as Error).message, "error");
			}
		};
	}

	pi.registerCommand("sandbox", {
		description: "Show resolved sandbox configuration and bwrap status",
		handler: async (_args, ctx) => {
			const { project, config } = await configForContext(ctx);
			ctx.ui.notify(
				formatSandboxStatus({
					enabled: !pi.getFlag("no-sandbox"),
					project,
					config,
					capabilities: probeBwrap(),
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

	pi.registerCommand("sandbox-test", {
		description: "Dry-run: show the bwrap argv for a command without executing it",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command) {
				ctx.ui.notify("Usage: /sandbox-test <command>", "warning");
				return;
			}
			const { cwd, config } = await configForContext(ctx);
			const capabilities = probeBwrap();
			const shellSettings = resolveShellSettings(cwd, ctx.isProjectTrusted());
			const shell = getShellConfig(shellSettings.shellPath);
			const enabled = config.enabled && !pi.getFlag("no-sandbox");
			const argv = buildBwrapArgs({
				command,
				cwd,
				env: resolveSandboxEnv(process.env, config.env),
				config,
				capabilities,
				shell,
			});
			ctx.ui.notify(
				[
					`sandbox: ${enabled ? "enabled" : "DISABLED (this command would run unsandboxed)"}`,
					`bwrap: ${capabilities.available ? "available" : "UNAVAILABLE"}`,
					formatArgv(argv),
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("sandbox-why", {
		description: "Explain how a path is treated by the sandbox policy",
		handler: async (args, ctx) => {
			const path = args.trim();
			if (!path) {
				ctx.ui.notify("Usage: /sandbox-why <path>", "warning");
				return;
			}
			const { cwd, config } = await configForContext(ctx);
			ctx.ui.notify(formatPathExplanation(explainPath({ path, cwd, config })), "info");
		},
	});

	pi.registerCommand("sandbox-init", {
		description: "Create a .pi/sandbox.json template in the current project",
		handler: async (_args, ctx) => {
			const project = await resolveProjectRoot(ctx.cwd);
			const path = configPathForScope("project", {
				projectRoot: project.projectRoot,
				worktreeRoot: project.worktreeRoot,
				agentDir: resolveAgentDir(),
			});
			try {
				writeConfigTemplate(path);
				clearConfigCache();
				ctx.ui.notify(`Created ${path}`, "info");
			} catch (error) {
				ctx.ui.notify((error as Error).message, "warning");
			}
		},
	});

	pi.registerCommand("sandbox-enable", {
		description: "Enable the sandbox in the project (or global) config",
		getArgumentCompletions: scopeCompletions,
		handler: setEnabledHandler(true),
	});

	pi.registerCommand("sandbox-disable", {
		description: "Disable the sandbox in the project (or global) config",
		getArgumentCompletions: scopeCompletions,
		handler: setEnabledHandler(false),
	});
}
