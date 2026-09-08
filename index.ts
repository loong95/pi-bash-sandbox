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
import { clearProbeCache, probeBwrap } from "./src/probe.ts";
import { clearProjectCache, resolveProjectRoot } from "./src/project.ts";
import { formatSandboxStatus } from "./src/ui.ts";

export default function piBashSandbox(pi: ExtensionAPI): void {
	pi.registerFlag("no-sandbox", {
		type: "boolean",
		default: false,
		description: "Run bash without bubblewrap sandboxing",
	});

	const fallback = createLocalBashOperations();

	function makeOperations(projectTrusted: boolean, ctx?: ExtensionContext) {
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
			shell: () => getShellConfig(),
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
			const operations = makeOperations(trusted, ctx);
			const sandboxed = createBashToolDefinition(cwd, { operations });
			return sandboxed.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});

	// Route `!` / `!!` user commands through the sandbox too.
	pi.on("user_bash", async (_event, ctx) => {
		return { operations: makeOperations(ctx.isProjectTrusted(), ctx) };
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
			ctx.ui.notify("Sandbox caches cleared; config will be re-read on the next command.", "info");
		},
	});
}
