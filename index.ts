/**
 * pi-bash-sandbox extension entry point.
 *
 * Overrides the built-in `bash` tool with a sandboxed implementation (MXC by
 * default, bubblewrap as the Linux fallback), routes `!` / `!!` user bash
 * through the same operations, gates the built-in file tools via `tool_call`,
 * and registers the `/sandbox*` commands.
 *
 * On Windows the built-in `powershell` tool is overridden as well: MXC's
 * ProcessContainer cannot run Git Bash (MSYS2 needs the host's
 * `\BaseNamedObjects` namespace), so Windows users get a sandboxed BusyBox sh
 * for `bash` and a sandboxed PowerShell for PowerShell commands.
 */

import {
	createBashToolDefinition,
	createLocalBashOperations,
	createLocalPowerShellOperations,
	createPowerShellToolDefinition,
	getShellConfig,
	type BashOperations,
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
import { chooseSandboxEngine, createSandboxedBashOperations, type SandboxEngine } from "./src/exec.ts";
import { resolveMxcCommand } from "./src/mxc/exec.ts";
import { checkMxcNetwork } from "./src/mxc/network.ts";
import { clearMxcProbeCache, probeMxc } from "./src/mxc/probe.ts";
import { formatMxcRequest, resolveRequestedBackend } from "./src/mxc/request.ts";
import { resolveWindowsCommand } from "./src/mxc/shell.ts";
import { evaluateToolCall, explainPath, POLICY_TOOLS } from "./src/policy.ts";
import { clearProbeCache, probeBwrap } from "./src/probe.ts";
import { clearProjectCache, resolveProjectRoot } from "./src/project.ts";
import { clearShellSettingsCache, resolveShellSettings } from "./src/settings.ts";
import { formatArgv, formatPathExplanation, formatSandboxStatus } from "./src/ui.ts";

/** PowerShell needs UTF-8 output in the Windows console codepage. */
const POWERSHELL_UTF8_PREFIX = [
	"try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}",
	"try { $PSStyle.OutputRendering='PlainText' } catch {}",
	"",
].join("\n");

export default function piBashSandbox(pi: ExtensionAPI): void {
	pi.registerFlag("no-sandbox", {
		type: "boolean",
		default: false,
		description: "Run shell commands without sandboxing",
	});

	const fallback = createLocalBashOperations();

	function makeOperations(input: {
		projectTrusted: boolean;
		ctx?: ExtensionContext;
		shellPath?: string;
		/** Prefix commands with the UTF-8 setup used by pi's PowerShell tool. */
		shellMode?: "bash" | "powershell";
	}) {
		const localFallback =
			input.shellMode === "powershell" ? createLocalPowerShellOperations() : fallback;
		const operations = createSandboxedBashOperations({
			resolveConfig: async (cwd) => {
				const project = await resolveProjectRoot(cwd);
				return loadSandboxConfig({
					projectRoot: project.projectRoot,
					worktreeRoot: project.worktreeRoot,
					cwd,
					projectTrusted: input.projectTrusted,
					agentDir: resolveAgentDir(),
					git: project.git,
				});
			},
			capabilities: () => probeBwrap(),
			mxcCapabilities: (config) => probeMxc({ executorPath: config.mxc.executorPath }),
			// MXC on Windows uses its own shell; the POSIX shell is only needed
			// for the bwrap engine and for Unix MXC backends. Avoid resolving
			// Git Bash on Windows, where it may not exist.
			shell: () =>
				process.platform === "win32" ? { shell: "sh", args: ["-c"] } : getShellConfig(input.shellPath),
			enabled: () => !pi.getFlag("no-sandbox"),
			fallback: localFallback,
			platform: process.platform,
			mxcShell: input.shellMode === "powershell" ? "powershell" : undefined,
			onUnavailable: (reason, cwd) => {
				input.ctx?.ui.notify(`Sandbox unavailable in ${cwd}: ${reason}. Running unsandboxed.`, "warning");
			},
		});

		if (input.shellMode !== "powershell") return operations;
		const wrapped: BashOperations = {
			exec: (command, cwd, options) => operations.exec(`${POWERSHELL_UTF8_PREFIX}${command}`, cwd, options),
		};
		return wrapped;
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
			const operations = makeOperations({
				projectTrusted: trusted,
				ctx,
				shellPath: shellSettings.shellPath,
				shellMode: "bash",
			});
			const sandboxed = createBashToolDefinition(cwd, {
				operations,
				commandPrefix: shellSettings.commandPrefix,
				shellPath: shellSettings.shellPath,
			});
			return sandboxed.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});

	if (process.platform === "win32") {
		const localPowerShell = createPowerShellToolDefinition(process.cwd());
		pi.registerTool({
			...localPowerShell,
			label: "powershell (sandboxed)",
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const cwd = ctx?.cwd ?? process.cwd();
				const trusted = ctx?.isProjectTrusted() ?? true;
				const operations = makeOperations({
					projectTrusted: trusted,
					ctx,
					shellMode: "powershell",
				});
				const sandboxed = createPowerShellToolDefinition(cwd, { operations });
				return sandboxed.execute(toolCallId, params, signal, onUpdate, ctx);
			},
		});
	}

	// Route `!` / `!!` user commands through the sandbox too. pi core already
	// applies the shell command prefix on this path, so we only supply operations.
	pi.on("user_bash", async (_event, ctx) => {
		const shellSettings = resolveShellSettings(ctx.cwd, ctx.isProjectTrusted());
		return {
			operations: makeOperations({
				projectTrusted: ctx.isProjectTrusted(),
				ctx,
				shellPath: shellSettings.shellPath,
				shellMode: "bash",
			}),
		};
	});

	// Gate the built-in file tools, which do NOT run inside the sandbox. Read-only
	// tools default to cwd when `path` is omitted.
	pi.on("tool_call", async (event, ctx) => {
		if (pi.getFlag("no-sandbox")) return undefined;
		if (!POLICY_TOOLS.has(event.toolName)) return undefined;

		const input = event.input as { path?: unknown };
		const path = typeof input.path === "string" && input.path.length > 0 ? input.path : ctx.cwd;

		const cwd = ctx.cwd;
		const project = await resolveProjectRoot(cwd);
		const config = loadSandboxConfig({
			projectRoot: project.projectRoot,
			worktreeRoot: project.worktreeRoot,
			cwd,
			projectTrusted: ctx.isProjectTrusted(),
			agentDir: resolveAgentDir(),
			git: project.git,
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
			git: project.git,
		});
		return { cwd, project, config };
	}

	function mxcShellError(config: Awaited<ReturnType<typeof configForContext>>["config"]): string | undefined {
		if (process.platform !== "win32") return undefined;
		return resolveWindowsCommand({
			choice: config.mxc.shell,
			command: "",
			busyboxPath: config.mxc.busyboxPath,
			env: process.env,
		}).error;
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
		description: "Show resolved sandbox configuration and engine status",
		handler: async (_args, ctx) => {
			const { project, config } = await configForContext(ctx);
			const bwrap = probeBwrap();
			const mxc = probeMxc({ executorPath: config.mxc.executorPath });
			const network = checkMxcNetwork(config.network, process.platform);
			const engine: SandboxEngine = chooseSandboxEngine(config, mxc.available, process.platform, network.ok);
			ctx.ui.notify(
				formatSandboxStatus({
					enabled: !pi.getFlag("no-sandbox"),
					project,
					config,
					capabilities: bwrap,
					mxcCapabilities: mxc,
					engine,
					mxcShellError: mxcShellError(config),
					mxcNetworkError: network.error,
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
			clearMxcProbeCache();
			clearProjectCache();
			clearShellSettingsCache();
			ctx.ui.notify("Sandbox caches cleared; config will be re-read on the next command.", "info");
		},
	});

	pi.registerCommand("sandbox-test", {
		description: "Dry-run: show the sandbox request for a command without executing it",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command) {
				ctx.ui.notify("Usage: /sandbox-test <command>", "warning");
				return;
			}
			const { cwd, config } = await configForContext(ctx);
			const bwrap = probeBwrap();
			const mxc = probeMxc({ executorPath: config.mxc.executorPath });
			const network = checkMxcNetwork(config.network, process.platform);
			const engine = chooseSandboxEngine(config, mxc.available, process.platform, network.ok);
			const enabled = config.enabled && !pi.getFlag("no-sandbox");
			const shellSettings = resolveShellSettings(cwd, ctx.isProjectTrusted());

			if (engine === "mxc") {
				if (!mxc.available || !mxc.executor || !network.ok) {
					ctx.ui.notify(`MXC unavailable: ${!network.ok ? network.error : mxc.error ?? "unknown reason"}`, "warning");
					return;
				}
				const resolved = resolveMxcCommand({
					command,
					cwd,
					env: resolveSandboxEnv(process.env, config.env),
					config,
					// Unused by the Windows request builder; avoid resolving Git Bash.
					posixShell:
						process.platform === "win32"
							? { shell: "sh", args: ["-c"] }
							: getShellConfig(shellSettings.shellPath),
					backend: resolveRequestedBackend(config.mxc.backend, mxc.backend, process.platform),
					platform: process.platform,
				});
				ctx.ui.notify(
					[
						`sandbox: ${enabled ? "enabled" : "DISABLED (this command would run unsandboxed)"}`,
						`engine: mxc (${mxc.backend ?? "unknown backend"})${mxc.tier ? ` tier=${mxc.tier}` : ""}`,
						`executor: ${mxc.executor}`,
						`shell: ${resolved.spec?.label ?? "(unresolved)"}`,
						resolved.error ? `error: ${resolved.error}` : formatMxcRequest(resolved.request!),
					].join("\n"),
					resolved.error ? "warning" : "info",
				);
				return;
			}

			if (process.platform !== "linux") {
				ctx.ui.notify("The bwrap engine is only available on Linux. Set engine to \"mxc\" or \"auto\".", "warning");
				return;
			}
			const argv = buildBwrapArgs({
				command,
				cwd,
				env: resolveSandboxEnv(process.env, config.env, process.platform),
				config,
				capabilities: bwrap,
				shell: getShellConfig(shellSettings.shellPath),
			});
			ctx.ui.notify(
				[
					`sandbox: ${enabled ? "enabled" : "DISABLED (this command would run unsandboxed)"}`,
					`engine: bwrap`,
					`bwrap: ${bwrap.available ? "available" : "UNAVAILABLE"}`,
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
