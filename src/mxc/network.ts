/**
 * Host prerequisites for MXC network policy.
 *
 * Bubblewrap runs the workload in a private network namespace. Opening egress
 * is not a simple flag: MXC stands up a `slirp4netns` provider plus
 * namespace-local firewall rules. A host without those tools rejects an
 * `egress.default: "allow"` request at launch. The old bwrap engine did not
 * unshare the network for `network: "host"`, so `auto` falls back to it when
 * the provider is missing — otherwise a default global config would break
 * every command after upgrading.
 */

import type { NetworkMode } from "../types.ts";
import { findExecutable } from "./shell.ts";

export interface MxcNetworkSupport {
	ok: boolean;
	error?: string;
}

export function checkMxcNetwork(
	network: NetworkMode,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): MxcNetworkSupport {
	if (network !== "host") return { ok: true };
	// ProcessContainer and Seatbelt enforce egress in-process; only the
	// bubblewrap backend needs an external network provider.
	if (platform !== "linux") return { ok: true };

	if (!findExecutable("slirp4netns", { platform, env })) {
		return {
			ok: false,
			error:
				"MXC network access on Linux requires slirp4netns (plus iproute2 and iptables). " +
				"Install slirp4netns, or keep network:\"none\", or use engine:\"bwrap\".",
		};
	}
	return { ok: true };
}
