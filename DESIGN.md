# pi-bash-sandbox 设计文档

面向"用 bubblewrap 替代内置 bash 工具、按项目隔离、配置化"的开发方案。

- 状态：设计草案（未实现）
- 目标读者：实现者
- 参考实现：`carderne/pi-sandbox`、`/tmp/pi-web-sandbox-sdk085`
- 关联：pi 仓库 `packages/coding-agent/examples/extensions/sandbox`、pi-web

---

## 1. 背景

pi 的内置 `bash` 工具直接在宿主上执行命令。我们要提供一个替代实现：命令运行在
[bubblewrap](https://github.com/containers/bubblewrap)（`bwrap`）创建的命名空间里，
文件系统与网络访问由用户可编辑的 `sandbox.json` 控制。

当前有两个现成参考：

1. pi 仓库自带的 `examples/extensions/sandbox`，用 `@anthropic-ai/sandbox-runtime`
   （Linux 上内部调 bwrap，另带网络代理、seccomp、违规监控）。
2. `carderne/pi-sandbox`，用 `@carderne/sandbox-runtime` 做了更完整的
   权限提示 UI。

本设计文档描述的是一套**更轻、无状态、按项目隔离**的新实现。

---

## 2. 目标与非目标

### 目标

- 用 `bwrap` 隔离 bash 命令的文件系统访问。
- 每个项目（含 linked worktree）使用自己的 `sandbox.json`。
- 配置可合并（全局 + 项目）、可热改，无需重启。
- 在 pi CLI 与 pi-web 中行为一致。
- 命令级无状态：不依赖任何进程级单例或长生命周期资源。
- 失败策略显式：bwrap 不可用时默认 fail-closed。

### 非目标（第一阶段）

- 域名级网络白名单（只支持全开 / 全断）。
- 隔离 `read` / `write` / `edit` / `grep` / `find` / `ls` 的 OS 级访问（它们不在 bwrap 内；只用 `tool_call` 策略拦截）。
- Windows / macOS 的 OS 级隔离（Linux 优先，其他平台回退或禁用）。
- 交互式 TTY 命令（vim、htop 等）。

---

## 3. 已定决策

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 复用 `createBashToolDefinition`，只替换 `BashOperations.exec` | 免费获得输出截断、流式更新、timeout/abort、内置渲染 |
| D2 | 以同名 `bash` 注册工具覆盖内置工具 | pi 的 `toolRegistry` 按名字覆盖（`agent-session.ts:2733`） |
| D3 | 每次命令现算 bwrap 参数，不维护常驻沙盒 | bwrap 本身无状态，per-project / worktree 天然正确 |
| D4 | 不使用 `SandboxManager` 单例（除非将来要域名白名单） | 该库网络状态是进程级全局，与多会话/多项目冲突 |
| D5 | 配置合并：内置默认 ← 全局 ← 项目 | 与现有 pi 扩展习惯一致 |
| D6 | 项目配置只在项目可信时加载 | 否则不可信仓库可篡改沙箱策略 |
| D7 | 用 `--ro-bind / /` 打底 + 显式 deny | 兼容性最好；项目间读取隔离靠 denyRead 显式声明 |
| D8 | bwrap 不可用时默认报错（fail-closed） | 安全默认；可配置回退 |

---

## 4. 已定决策（原 O1–O5，已拍板）

| 编号 | 决策 | 说明 |
|---|---|---|
| O1 网络 | **A：只做 none / host** | 无状态；域名白名单推迟到可选阶段 3，且必须接受 per-project broker |
| O2 worktree | **A：按 projectRoot 共享策略** | 写范围按 cwd，worktree 各自只能写自己那份 |
| O3 配置来源 | **B：优先 worktree 自己的 `.pi/sandbox.json`，回退主 checkout** | 比只读主 checkout 更符合直觉，成本低 |
| O4 项目隔离 | **v1 用 A：`--ro-bind / /` + 默认 denyRead 敏感目录** | 最小 root（B）留阶段 2 作为可选模式；v1 在 §12 明确残余风险 |
| O5 bwrap 缺失 | **A：fail-closed 默认，可配 fallback** | 与 D8 一致 |

---

## 5. 已验证的关键事实

以下均已在本机（bubblewrap 0.9.0，Linux，非特权用户）实测。

### 5.1 bwrap 无状态

每次 exec 都是一次新的 `bwrap` 调用，建新的 mount / pid / net 命名空间，命令结束即销毁。
不存在"沙盒对象"。因此"每个项目一个沙盒"= 每次命令按该项目策略重新构造命名空间。

### 5.2 基础调用可用

```bash
bwrap --new-session --die-with-parent \
  --ro-bind / / --dev /dev \
  --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup-try \
  --unshare-user --cap-drop ALL --proc /proc \
  --bind /tmp/proj /tmp/proj \
  --tmpfs /tmp/proj/secret \
  --chdir /tmp/proj \
  -- /bin/bash -c 'pwd; echo x >> out.txt; cat secret/token.txt'
```

实测：cwd 正确；写绑定回写宿主；`--tmpfs` 后 secret 读不到；`/proc/1` 是 bwrap；
非特权用户可用。

### 5.3 环境可完全控制

`--clearenv` 生效，配合 `--setenv` 可精确控制子进程环境：

```bash
bwrap --clearenv --setenv PATH /usr/bin:/bin --setenv HOME /home/loong ... -- /bin/bash -c 'env'
# 输出只有 HOME / PATH / PWD / SHLVL / _
```

### 5.4 网络

`--unshare-net` 使沙箱内网络完全不可达（`connect: Network is unreachable`）。
bwrap 无法做域名过滤。

### 5.5 库的边界（`@carderne/sandbox-runtime` 0.0.71）

实测结论：

- 只传 `customConfig.filesystem`、不传 network、不调用 `initialize()`，`wrapWithSandbox`
  可直接生成可用的 bwrap 命令，无代理、无 socat、无全局状态。
- 传 `network: { allowedDomains: [] }`（想全断）会抛
  `Sandbox network proxy is not initialized`。库把任何 network 配置都视为"必须走代理"。
- 不传 network = 共享宿主网络（生成命令里没有 `--unshare-net`）。
- `filterNetworkRequest` 读的是模块级 `config.network.allowedDomains/deniedDomains`
  （`sandbox-manager.js:111,118`），per-call 的 `allowedDomains` 只决定是否启用代理。
- 默认会套 `apply-seccomp` 阻断 `AF_UNIX` socket，并自动加默认写路径
  （`~/.npm/_logs`、`~/.claude/debug` 等）。

**推论**：如果网络只需全开/全断，直接用库不划算，自己写 bwrap args 更简单、可控、无状态。
只有需要域名白名单时才用库，并接受 per-project broker 的复杂度。

---

## 6. 架构

### 6.1 总览

```
LLM 调用 bash 工具
        │
        ▼
createBashToolDefinition(cwd, { operations })   ← 复用 pi 内置管线
        │  exec(command, cwd, { onData, signal, timeout, env })
        ▼
SandboxedBashOperations
        │
        ├─ resolveProjectRoot(cwd)              → 项目根（worktree 归并）
        ├─ loadSandboxConfig(projectRoot, cwd)  → 合并 + 路径展开 + 信任门禁
        ├─ probeBwrap()                         → 可用性/能力缓存
        ├─ buildBwrapArgs(...)                  → 纯函数，返回 argv
        └─ spawn(bwrap, argv, { detached })     → 流式输出、进程组 kill
```

关键点：**除了缓存（配置 mtime、bwrap 探测结果），没有任何进程级状态。**

### 6.2 文件布局

```
pi-bash-sandbox/
  index.ts                 # 扩展入口：registerTool + user_bash + 命令
  src/
    types.ts               # SandboxConfig / ResolvedConfig / BwrapCapabilities
    config.ts              # 读取、合并、校验、路径展开
    project.ts             # cwd → projectRoot / worktree 解析
    bwrap.ts               # buildBwrapArgs 纯函数
    env.ts                 # env 白名单/deny 匹配与 resolveSandboxEnv
    settings.ts            # 读回 shellCommandPrefix / shellPath                 ✅
    exec.ts                # createSandboxedBashOperations (BashOperations)   ✅
    probe.ts               # bwrap 可用性与能力探测                          ✅
    ui.ts                  # /sandbox 输出                                  ✅
    policy.ts              # allow/deny 匹配（供 tool_call 策略复用）          ✅
  test/
    bwrap.test.ts          # 纯函数 golden 测试
    config.test.ts
    project.test.ts
    env.test.ts
    integration.test.ts    # 需要 bwrap，条件跳过
  sandbox.json             # 示例配置
```

---

## 7. 模块设计

### 7.1 类型（`src/types.ts`）

```ts
export type NetworkMode = "none" | "host";

export interface SandboxConfigFile {
  enabled?: boolean;
  network?: NetworkMode;
  filesystem?: {
    allowWrite?: string[];
    denyWrite?: string[];
    denyRead?: string[];
  };
  tmp?: "private" | "shared";
  env?: {
    passthrough?: string[];
    deny?: string[];
    set?: Record<string, string>;
  };
  unsharePid?: boolean;
  weakerNestedSandbox?: boolean;
  onUnavailable?: "error" | "fallback";
  extraBwrapArgs?: string[];
  tools?: { enabled?: boolean; requireAllowWrite?: boolean };
}

/** 已解析的路径：绝对、已 realpath、且已确认存在。 */
export interface ResolvedPath {
  path: string;
  isDir: boolean;
  /** 产生该路径的原始规则，用于诊断。 */
  rule: string;
}

/** 已解析：路径已展开为绝对路径，默认值已填充。 */
export interface ResolvedSandboxConfig {
  enabled: boolean;
  network: NetworkMode;
  allowWrite: ResolvedPath[];
  denyWrite: ResolvedPath[];
  denyRead: ResolvedPath[];
  tmp: "private" | "shared";
  env: { passthrough: string[]; deny: string[]; set: Record<string, string> };
  unsharePid: boolean;
  weakerNestedSandbox: boolean;
  onUnavailable: "error" | "fallback";
  extraBwrapArgs: string[];
  /** 原始规则（未展开 glob），供 tool_call 策略匹配。 */
  rules: { allowWrite: string[]; denyWrite: string[]; denyRead: string[] };
  /** read/write/edit 的 tool_call 拦截策略。 */
  tools: { enabled: boolean; requireAllowWrite: boolean };
  /** 配置来源，用于错误信息和 /sandbox 展示。 */
  sources: { globalPath: string; projectPath: string | null; projectTrusted: boolean; warnings: string[] };
}

export interface BwrapCapabilities {
  available: boolean;
  version?: string;
  /** 是否支持 --unshare-user（非特权） */
  userNamespace: boolean;
  /** 是否支持 --proc（需要 --unshare-pid） */
  procMount: boolean;
  /** 探测失败原因，用于 UI 报错 */
  error?: string;
}
```

### 7.2 配置加载（`src/config.ts`）

```ts
export function getConfigPaths(projectRoot: string): { globalPath: string; projectPath: string };
export function loadSandboxConfig(input: {
  projectRoot: string;
  cwd: string;
  projectTrusted: boolean;
}): ResolvedSandboxConfig;
```

规则：

- 合并顺序：内置默认 ← `<globalPath>` ← `<projectPath>`（仅当 `projectTrusted`）。
- 数组字段：项目覆盖全局（或按 O3 决定累加）。默认行为建议"覆盖"，避免用户删不掉全局规则。
- 路径展开：`~` → 宿主 `HOME`；相对路径 → 相对 `cwd`；然后 `realpath`（解析 symlink）。
- 过滤不存在路径：`--tmpfs` / `--ro-bind /dev/null` 对不存在路径会失败或在宿主创建挂载点。
  实现上直接跳过不存在的路径（无内容也就无需屏蔽）。
- 缓存：按文件 `mtimeMs + size` 缓存解析结果，避免每条命令都读盘。
- 解析失败：打印警告并回退到上一层配置（不要静默使用空策略）。

### 7.3 项目解析（`src/project.ts`）

```ts
export interface ProjectInfo {
  projectRoot: string;
  isWorktree: boolean;
}

export async function resolveProjectRoot(cwd: string): Promise<ProjectInfo>;
```

实现参考 pi-web `lib/worktree.ts:85-123`：

- `git -C <cwd> rev-parse --path-format=absolute --git-common-dir --show-toplevel`
- linked worktree 的 `--git-common-dir` 指向主仓库 `.git`，其父目录即 `projectRoot`。
- 非 git 目录：`projectRoot = cwd`。
- 结果按 cwd 缓存，短 TTL（如 60s），worktree 增删时失效。

### 7.4 bwrap 参数构造（`src/bwrap.ts`，纯函数）

```ts
export interface BuildBwrapInput {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  config: ResolvedSandboxConfig;
  capabilities: BwrapCapabilities;
  shell: { shell: string; args: string[] }; // 来自 getShellConfig()
}

/** 返回可直接传给 spawn 的 argv，argv[0] === "bwrap"。 */
export function buildBwrapArgs(input: BuildBwrapInput): string[];
```

**必须按以下顺序**（mount 是后压前，顺序影响语义）：

```
bwrap
  --new-session --die-with-parent
  --clearenv
  --setenv ...                       # 见 7.5
  --ro-bind / /                      # 只读根打底
  --dev /dev
  --tmpfs /tmp                       # tmp=private 时；shared 则 --bind /tmp /tmp
                                     # 必须在 allowWrite 之前，否则会遮住 /tmp 下的项目
  --bind <allowWrite> <allowWrite>   # 逐个可写路径
  --ro-bind <denyWrite> <denyWrite>  # 只读自重绑：内容可读、写入失败
  --tmpfs <denyRead 目录>             # 屏蔽读目录（跳过不存在）
  --remount-ro <denyRead 目录>        # 使该 tmpfs 只读，写入报 EROFS 而非静默消失
  --ro-bind /dev/null <denyRead 文件> # 屏蔽文件内容（跳过不存在）
  --unshare-net                      # network=none
  --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup-try
  --unshare-user --cap-drop ALL
  --proc /proc                       # 必须紧跟 --unshare-pid 且在其后
  --chdir <cwd>
  [extraBwrapArgs...]
  -- <shell> <args...> <command>
```

顺序理由：

1. `--ro-bind / /` 必须最先，后续 `--bind` / `--tmpfs` / `--proc` / `--dev` 才能覆盖它。
2. `--tmpfs /tmp` 必须在 `allowWrite` 之前：项目若位于 `/tmp` 下，先 bind 再 tmpfs 会把项目遮掉，所有写入失败。
3. `denyRead` 放在 `denyWrite` 之后：同一路径同时命中两者时，`denyRead` 生效（更安全）。
4. `--proc /proc` 必须在 `--ro-bind / /` 和 `--unshare-pid` 之后，否则 `/proc` 是宿主只读视图。
5. `--unshare-user --cap-drop ALL` 必须有，否则有 CAP_SYS_ADMIN 时可把 `--ro-bind` remount 成 rw。
6. `--die-with-parent` 保证 pi 崩溃时沙箱进程全灭；配合 spawn 的进程组 kill 处理 abort/timeout。

边界处理：

- `allowWrite` 路径若不存在：跳过（或按配置报错）。
- `denyRead` / `denyWrite` 路径若不存在：跳过，避免 bwrap 在宿主创建挂载点文件。
- `denyWrite` 用 `--ro-bind <realpath> <realpath>`（内容保留可读、写入报 `Read-only file system`），
  **不要**用 `--ro-bind /dev/null`（那会连读也一起屏蔽）。
- `denyRead` 目录用 `--tmpfs` + `--remount-ro`：内容为空且**写入报 `Read-only file system`**。
  只加 `--tmpfs` 的话目录可写，写入会静默消失（agent 会误以为写成功）。
- `denyRead` 文件用 `--ro-bind /dev/null`（内容变为空）。
- 文件 deny 的目标若是 symlink：解析到 realpath 再 bind（bwrap 不支持对 symlink 目标做文件 bind）。
- 路径含 glob：第一阶段不支持，遇到时告警并跳过（bwrap 需要真实路径）。
- `weakerNestedSandbox = true`：跳过 `--proc /proc`，改用 `--bind /proc /proc`（用于无 CAP_SYS_ADMIN 的容器）。

### 7.5 环境变量

默认 `--clearenv` + 显式白名单，避免把 pi 进程里的 API key 带进沙箱：

- **来源是 pi 传给 `exec` 的 `env`**（`resolveSpawnContext` 已算好，含 `PI_*` 与 spawnHook 结果），
  在其上做白名单/deny 过滤；**不要**直接读 `process.env`，否则会破坏 pi 的 session env 语义。

- 默认 passthrough：`PATH`、`HOME`、`TERM`、`LANG`、`LC_*`、`TMPDIR`。
- 默认 deny：`*_KEY`、`*_TOKEN`、`*_SECRET`、`*_PASSWORD`、`ANTHROPIC_*`、`OPENAI_*`。
- 来自 pi 的 `PI_SESSION_ID` / `PI_MODEL` 等按需透传。
- 若某变量同时在 passthrough 和 deny：deny 优先。
- `PATH` 必须显式设置（用宿主值），否则 bash 可能找不到命令。

### 7.6 执行（`src/exec.ts`）

```ts
export interface SandboxedExecDeps {
  resolveConfig(cwd: string): Promise<ResolvedSandboxConfig>;
  capabilities(): Promise<BwrapCapabilities>;
  shellPath?: string;
  onUnavailable?: (reason: string) => void;
}

export function createSandboxedBashOperations(deps: SandboxedExecDeps): BashOperations;
```

`exec` 必须严格实现 pi 的契约（`tools/bash.ts:53`）：

- stdout + stderr 都调 `onData(Buffer)`。
- abort：kill 整个进程组（`process.kill(-child.pid, "SIGKILL")`），抛 `new Error("aborted")`。
- timeout：kill 进程组，抛 `new Error(\`timeout:${timeout}\`)`。
- 正常结束：返回 `{ exitCode }`。
- `spawn` 用 `{ detached: true, stdio: ["ignore", "pipe", "pipe"] }`。
- `cwd` 不存在：抛明确错误。
- bwrap 不可用且 `onUnavailable === "error"`：抛明确错误，不执行命令。
- 不要在 `exec` 里缓存子进程或全局资源。

### 7.7 扩展入口（`index.ts`）

```ts
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("no-sandbox", { type: "boolean", default: false, description: "..." });

  const localBash = createBashToolDefinition(process.cwd());
  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate, ctx) {
      // 1. 判断是否启用（flag / config.enabled）
      // 2. 构造 sandboxed operations
      // 3. 委托给 createBashToolDefinition(ctx.cwd, { operations, shellPath })
    },
  });

  pi.on("user_bash", ...);       // 让 `!` / `!!` 也进沙箱
  pi.registerCommand("sandbox", ...);       // 展示解析后的配置与探测结果
  pi.registerCommand("sandbox-reload", ...); // 清缓存，重读配置
}
```

注意：工具定义里 `createBashToolDefinition(cwd, ...)` 的 `cwd` 只是兜底，
实际执行用 `ctx.cwd`（`tools/bash.ts` 里 `ctx?.cwd || cwd`）。

---

## 8. sandbox.json

### 8.1 位置与合并

| 作用域 | 路径 |
|---|---|
| 全局 | `~/.pi/agent/sandbox.json` |
| 项目 | `<projectRoot>/.pi/sandbox.json`（仅项目可信时加载） |

### 8.2 示例

```json
{
  "enabled": true,
  "network": "none",
  "filesystem": {
    "allowWrite": [".", "/tmp"],
    "denyWrite": ["~/.ssh", ".env", ".env.*", "*.pem", "*.key"],
    "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gh"]
  },
  "tmp": "private",
  "env": {
    "passthrough": ["PATH", "HOME", "TERM", "LANG", "TMPDIR"],
    "deny": ["*_KEY", "*_TOKEN", "*_SECRET"]
  },
  "unsharePid": true,
  "weakerNestedSandbox": false,
  "onUnavailable": "error",
  "extraBwrapArgs": [],
  "tools": { "enabled": true, "requireAllowWrite": true }
}
```

### 8.3 校验

- `network` 只接受 `"none"` / `"host"`（第一阶段）。
- 所有数组元素必须是字符串。
- 未知字段：告警但不失败（便于向前兼容）。
- `extraBwrapArgs`：原样追加，风险自负；在 `/sandbox` 输出中显著标记。

---

## 9. 项目与 worktree

- `projectRoot` 由 `git rev-parse --git-common-dir` 推导，linked worktree 归并到主仓库根。
- 配置按 `projectRoot` 解析（O3 决定读主 checkout 还是各 worktree）。
- `allowWrite` 里 `.` 展开为**当前 cwd**（即具体 worktree 路径），不是 `projectRoot`。
  这样同一项目的不同 worktree 只能写自己那份。
- 若 O2 选"每个 worktree 独立沙盒"：配置 key 改为 worktree 路径；写权限天然隔离，
  但网络代理（若将来引入）会重复起。
- 若 O4 选"禁止项目间读取"：需要把其他已知项目根加入 `denyRead`，或改最小 root。

---

## 10. 网络策略

### 10.1 第一阶段：none / host

- `none`：追加 `--unshare-net`，完全无网络。
- `host`：不追加，共享宿主网络。
- 无状态，无代理，per-project 天然成立。

### 10.2 第二阶段（可选）：域名白名单

只有确认需要时才做，且必须接受有状态架构：

- 每个 `projectRoot` 一个 broker 子进程，各自持有独立的 sandbox-runtime 实例
  （自己的 HTTP/SOCKS 代理、unix socket、seccomp monitor）。
- 按 projectRoot 引用计数：第一个用到的 session 创建，最后一个退出时销毁。
- bash exec 路由到对应 broker；broker 内调用 `SandboxManager.wrapWithSandbox`。
- 不要用扩展的 `session_shutdown` 无条件 `SandboxManager.reset()`（会拆掉其他 session 的代理）。

备选：fork 库，把模块级状态改成实例状态（工作量大，不建议）。

---

## 11. pi-web 集成

pi-web 把 SDK 直接跑在 Next.js server 进程里（`lib/rpc-manager.ts:2000-2070`），
扩展发现与 CLI 相同，且实现了完整的扩展 UI 协议（含 `ctx.ui.custom()`）。
因此无状态 bash 工具在 pi-web 中可直接工作。需要注意：

1. **project-command 环境**：pi-web 内置 `pi-web-project-command-environment` 扩展也会覆盖 `bash`。
   但它的 `preferUserBashExtension()` 在发现用户扩展已注册 `bash` 时**主动移除自己**，
   所以我们的实现优先，不会被它覆盖。它原本负责的三件事：
   - 把 `~/.pi/agent/bin` 加入 PATH —— pi 的 `getShellEnv()` 已经做了（传进 `exec` 的 env 里就有）。
   - 清洗 `NEXT_*` / `PORT` / `NODE_ENV` —— 我们 `--clearenv` + 白名单天然丢弃。
   - 应用 `shellCommandPrefix` / `shellPath` —— **这一项会丢**，因此 `src/settings.ts`
     用 `SettingsManager.create()` 读回并传给 `createBashToolDefinition`。

2. **不要用 `process.cwd()`**：pi-web server 的 cwd 不是 session cwd。配置解析和
   `SettingsManager` 都应基于 `ctx.cwd`。

3. **不要改全局 env**：避免 `process.env.NODE_USE_ENV_PROXY = ...` 这类写法影响整个 server。

4. **未覆盖面**：pi-web 的网页终端（node-pty，`lib/terminal-manager.ts`）、文件浏览器、
   上传、git 变更都不走沙箱。`read` / `write` / `edit` 只靠 `tool_call` 策略拦截。
   若需要真正隔离，要单独处理。

5. **多会话**：无状态设计下，多 session / 多项目 / 多 worktree 并发无需任何协调。

---

## 12. 安全与已知限制

| 限制 | 说明 | 缓解 |
|---|---|---|
| 项目间可读 | `--ro-bind / /` 默认能读全盘 | 显式 `denyRead` 兄弟项目；或改最小 root |
| read/write/edit/grep/find/ls 不在 bwrap 内 | 由 `tool_call` 策略拦截（同一套 denyRead/denyWrite/allowWrite 规则） | 已实现 `policy.ts`；pi-web 网页终端/文件浏览器仍不拦截 |
| 网络全开风险 | `host` 模式下命令可外联并读取沙箱内可见的密钥 | 默认 `none`；`--clearenv` 默认清洗密钥 |
| env 泄密 | pi 进程 env 含 API key | 默认白名单 + deny 规则 |
| 非特权 userns 限制 | Ubuntu 24.04 AppArmor、无 CAP_SYS_ADMIN 容器 | 启动自检 + `weakerNestedSandbox` 降级 |
| 交互式命令 | TTY 命令在沙箱内不可用 | 文档说明 |
| bwrap 挂载点副作用 | 屏蔽不存在路径会在宿主创建空文件 | 跳过不存在路径 |
| symlink | `--ro-bind /dev/null <symlink>` 会失败 | 解析 realpath |
| glob 规则 | bwrap 需要真实路径 | 第一阶段不支持，告警 |

**启动自检**：`bwrap --ro-bind / / --dev /dev --unshare-user -- true`。
失败时在 `/sandbox` 与启动通知中给出可操作原因（AppArmor sysctl、缺 bwrap、容器权限）。

---

## 13. 测试计划

### 纯函数测试（无需 bwrap）

- `buildBwrapArgs` golden 测试：给定 config / cwd / env，断言 argv 完全相等。
  - 顺序、`--unshare-net` 有无、`--clearenv` + `--setenv`、跳过不存在路径、symlink realpath。
- `loadSandboxConfig`：合并优先级、`~` 展开、相对路径、项目不可信时忽略项目配置、mtime 缓存。
- `resolveProjectRoot`：普通目录、git 仓库、linked worktree（可用临时 git 仓库构造）。
- env 白名单/deny 匹配。

### 集成测试（`bwrap` 存在时运行，否则 skip）

- `allowWrite` 内可写，且宿主可见。
- `denyRead` 目录/文件读不到。
- `denyWrite` 文件写失败。
- `network: "none"` 时连接失败；`"host"` 时成功（可选，避免依赖外网）。
- 项目 A 的沙箱读不到项目 B 的路径（当配置了 denyRead）。
- abort / timeout 能杀掉整个进程组。
- bwrap 缺失时 `onUnavailable: "error"` 抛错，`"fallback"` 回退本地 bash。

### 手动 / e2e

- pi CLI：`pi -e .`，跑几条命令，验证 `/sandbox` 输出。
- pi-web：在网页会话里跑 bash，确认 project-command 环境（PATH 里有 `~/.pi/agent/bin`）
  与权限提示仍正常。

---

## 14. 路线图

### 阶段 0：骨架与纯函数 ✅ 已完成

- 建目录、`package.json`、`tsconfig`。
- 实现 `types.ts`、`bwrap.ts`、`config.ts`、`project.ts`、`env.ts`。
- 40 个测试全绿（纯函数 + 真实 bwrap 集成），`tsc --noEmit` 通过。
- 已修正：`denyWrite` 用只读自重绑；`--tmpfs /tmp` 在 `allowWrite` 之前；env 过滤基于 pi 传入的 env。

### 阶段 1：可用 bash 沙箱 ✅ 已完成

- `probe.ts` + `exec.ts` + `ui.ts` + `index.ts`。
- 覆盖 `bash`、`user_bash`；`--no-sandbox` 逃生口；`/sandbox` + `/sandbox-reload`。
- `network: none/host`，`--clearenv` 环境白名单（默认透传 `PI_*`）。
- 项目信任取自 `ctx.isProjectTrusted()`；禁用/回退时委托 `createLocalBashOperations`。
- 60 个测试全绿，含真实 bwrap 的流式/timeout/abort 与扩展装配（mock `ExtensionAPI`）测试。

### 阶段 1.5：read/write/edit 策略拦截 ✅ 已完成

- `policy.ts` + `tool_call` 钩子：`read`/`grep`/`find`/`ls` 受 denyRead 限制（`path` 缺省时按 cwd）；`write`/`edit` 受 denyRead/denyWrite 限制，且默认必须在 allowWrite 内。
- 规则按原始字符串匹配，所以 `.env.*` / `*.pem` 对**尚不存在**的文件也生效（bwrap 只能 bind 已存在的路径）。
- 新增 `tools.enabled` / `tools.requireAllowWrite` 配置项。
- 76 个测试全绿。

### 阶段 2：pi-web 兼容 ✅ 已完成（网页终端/文件浏览器不在范围）

- `src/settings.ts` 读回 `shellCommandPrefix` / `shellPath`，避免覆盖 `bash` 后丢失。
- 其余 pi-web 环境（agent bin PATH、`NEXT_*`/`PORT`/`NODE_ENV` 清洗）已由 pi 管线与 `--clearenv` 覆盖。
- pi-web 的 `preferUserBashExtension()` 保证用户 bash 覆盖优先。
- 网页终端与文件浏览器明确不做限制（不在 pi 范围内）。
- `/sandbox-reload` 同时清理 settings 缓存。

### 阶段 3（可选）：域名白名单

- 仅在 O1 选 B 时做。
- per-project broker + 引用计数。
- 或者放弃，维持 none/host。

---

## 15. 参考资料

- pi 扩展机制：`packages/coding-agent/docs/extensions.md`
- pi 内置 bash 工具：`packages/coding-agent/src/core/tools/bash.ts`
- `BashOperations` 契约：同上 `:53`
- 工具覆盖机制：`packages/coding-agent/src/core/agent-session.ts:2723-2736`
- 官方 sandbox 示例：`packages/coding-agent/examples/extensions/sandbox/index.ts`
- pi-web 运行机制：`lib/rpc-manager.ts:2000-2070`、`lib/project-command-env.ts`
- pi-web worktree：`lib/worktree.ts:85-123`
- bwrap 手册：`man bwrap`
- 参考实现：`/tmp/pi-web-sandbox-sdk085`
