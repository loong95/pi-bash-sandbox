# Changelog

## 0.3.0

- **MXC engine.** `engine: "auto" | "mxc" | "bwrap"`. MXC is invoked through its
  standalone executors (`wxc-exec.exe` / `lxc-exec` / `mxc-exec-mac`), so the
  extension does not require Node 24 or load native FFI into pi.
- **Windows support (validated on Windows 11 26H2).** MXC `processcontainer`,
  BusyBox-w32 for the `bash` tool, a sandboxed `powershell` tool, drive-root
  read-only policy, `denyRead` masking, `denyWrite` read-only paths, network
  none/host, and taskkill-based abort. Git Bash cannot run inside
  ProcessContainer; the failure mode and BusyBox requirement are documented.
- **macOS support.** MXC `seatbelt` request path for macOS 15+. The published
  SDK ships arm64 only; Intel Macs must build MXC from source or use
  `onUnavailable: "fallback"`.
- **Linux.** MXC `bubblewrap` is the default. The original bwrap engine is
  retained and used automatically when MXC is unavailable or
  `network: "host"` has no `slirp4netns`.
- **New config:** `engine`, `mxc.backend`, `mxc.shell`, `mxc.busyboxPath`,
  `mxc.executorPath`, `mxc.extraReadwritePaths`, `mxc.extraReadonlyPaths`,
  `mxc.extraDeniedPaths`.
- **Windows correctness:** environment-variable rules and tool-policy path
  matching are case-insensitive; glob expansion uses forward slashes.
- **Diagnostics:** `/sandbox` reports engine/MXC/backend status and
  `/sandbox-test` prints the MXC 1.0.0 request.
- **Dependencies:** `@microsoft/mxc-sdk` is a runtime dependency. The
  repository `.npmrc` pins the `@microsoft` scope to the official registry
  because some mirrors still serve MXC 0.8.x.
- **Tests:** 178 passing on Linux (3 Windows-only tests skip), plus Windows
  integration coverage in `test/mxc-windows.test.ts`.
