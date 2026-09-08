# pi-bash-sandbox

用 [bubblewrap](https://github.com/containers/bubblewrap)（`bwrap`）为
[pi](https://pi.dev/) 的 `bash` 工具提供 OS 级沙箱。

> [English](README.md)

- **按项目、无状态。** 每条命令各自解析策略、各自启动一个新的 `bwrap`。没有常驻沙箱进程，没有全局单例。
- **文件系统、网络、环境变量可控**，通过可编辑的 `sandbox.json` 合并全局层与项目层。
- **同时拦截内置文件工具**（`read` / `write` / `edit` / `grep` / `find` / `ls`）——它们不跑在 `bwrap` 里。
- **默认 fail-closed**：`bwrap` 不可用时命令直接报错，而不是悄悄不沙箱地执行。

## 环境要求

- Linux（含 WSL2），已安装 `bwrap`。
- bubblewrap **≥ 0.4**（开发与实测使用 0.9.0）。
- 启用非特权 user namespace。

```bash
# Debian / Ubuntu
sudo apt install bubblewrap
# Fedora / RHEL
sudo dnf install bubblewrap
# Arch
sudo pacman -S bubblewrap
```

Ubuntu 24.04+ 的 AppArmor 会限制非特权 user namespace。如果探测报告
`userns=false`，见下文的 `weakerNestedSandbox`。

macOS 与 Windows 不支持 OS 级隔离。这些平台上探测会失败，默认
`onUnavailable: "error"` 会拒绝执行；改成 `onUnavailable: "fallback"` 才会不沙箱地运行。

## 安装

```bash
# 免安装试用
pi -e /path/to/pi-bash-sandbox

# 作为扩展安装（git 源）
pi install git:github.com/<you>/pi-bash-sandbox
```

在会话里验证：

```
/sandbox
```

## 快速开始

创建 `~/.pi/agent/sandbox.json`（全局）或 `<项目>/.pi/sandbox.json`（项目）：

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
  "tools": { "enabled": true, "requireAllowWrite": true }
}
```

完全不写配置时，使用上面这套内置默认值。注意默认 `network: "none"` 会挡住
`git push`、`pnpm install`、`curl` 等；需要联网时改成 `"network": "host"`。

## 工作原理

```
LLM 调用 bash 工具
        │
        ▼
createBashToolDefinition(cwd, { operations })   ← 复用 pi 的管线
        │  exec(command, cwd, { onData, signal, timeout, env })
        ▼
SandboxedBashOperations
        ├─ resolveProjectRoot(cwd)               → 项目根（worktree 归并）
        ├─ loadSandboxConfig(...)                → 合并 + 展开 + 信任门禁
        ├─ probeBwrap()                          → 带缓存的能力探测
        ├─ buildBwrapArgs(...)                   → 纯函数 argv 构造
        └─ spawn(bwrap, argv)                    → 流式输出、进程组 kill
```

`bash` 工具按名字覆盖；pi 内置的渲染、输出截断、流式更新、timeout 处理全部复用。
`!` / `!!` 用户命令也通过 `user_bash` 事件走同一套 operations。

### 挂载顺序（bwrap）

后挂载覆盖先挂载，所以顺序有意义：

```
--ro-bind / /                        只读的宿主根
--dev /dev
--tmpfs /tmp                         （tmp: private）必须在 allowWrite 之前，
                                     否则会遮住位于 /tmp 下的项目
--bind <allowWrite> <allowWrite>     可写路径
--ro-bind <denyWrite> <denyWrite>    只读自重绑：内容可读、写入失败
--tmpfs <denyRead 目录> --remount-ro 内容为空且只读
--ro-bind /dev/null <denyRead 文件>  内容被屏蔽
--unshare-net                        network: none
--unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup-try
--unshare-user --cap-drop ALL
--proc /proc
--chdir <cwd>
-- <shell> -c <command>
```

`--clearenv` 加显式 `--setenv` 意味着沙箱从一个干净的环境开始，只有白名单里的变量存在。

## 配置

### 位置与优先级

| 作用域 | 路径 |
|---|---|
| 全局 | `~/.pi/agent/sandbox.json`（尊重 `PI_CODING_AGENT_DIR`） |
| 项目 | `<项目>/.pi/sandbox.json`（仅当项目被信任时加载） |

合并顺序：**内置默认 ← 全局 ← 项目**。数组字段是**覆盖**而不是拼接，所以项目可以删掉
全局规则；`env.set` 按键合并。linked worktree 优先用自己那份 `.pi/sandbox.json`，
没有则回退到主 checkout 的。

### 字段

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关 |
| `network` | `"none"` \| `"host"` | `"none"` | `none` 会加 `--unshare-net` |
| `filesystem.allowWrite` | string[] | `[".", "/tmp"]` | 可写路径（其余只读） |
| `filesystem.denyWrite` | string[] | `["~/.ssh", ".env", ".env.*", "*.pem", "*.key"]` | 只读路径 |
| `filesystem.denyRead` | string[] | `["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gh"]` | 被隐藏的路径 |
| `tmp` | `"private"` \| `"shared"` | `"private"` | `private` 挂一个空的 `/tmp` |
| `env.passthrough` | string[] | `["PATH","HOME","TERM","LANG","LC_*","TMPDIR","PI_*"]` | 从 pi 环境保留的变量（支持 glob） |
| `env.deny` | string[] | `["*_KEY","*_TOKEN","*_SECRET","*_PASSWORD","ANTHROPIC_*","OPENAI_*"]` | 被移除的变量（优先级高于 passthrough） |
| `env.set` | object | `{}` | 强制设置的变量 |
| `unsharePid` | boolean | `true` | 隔离 pid/ipc/uts/cgroup 命名空间 |
| `weakerNestedSandbox` | boolean | `false` | 绑定宿主 `/proc` 而不是新挂载（用于没有 `CAP_SYS_ADMIN` 的容器） |
| `onUnavailable` | `"error"` \| `"fallback"` | `"error"` | `bwrap` 不可用时怎么办 |
| `extraBwrapArgs` | string[] | `[]` | 原样追加到 `--` 之前。强大且危险 |
| `tools.enabled` | boolean | `true` | 通过 `tool_call` 拦截 `read`/`write`/`edit`/`grep`/`find`/`ls` |
| `tools.requireAllowWrite` | boolean | `true` | `write`/`edit` 目标必须在 `allowWrite` 内 |

路径规则支持 `~` 展开、相对路径（相对命令 cwd 解析）以及 glob（`*`、`?`、`**`）。
不带 `/` 的相对模式（如 `.env`、`*.pem`）按 basename 匹配。匹配不到任何文件的规则会被跳过
——`bwrap` 只能绑定已存在的路径；而工具策略匹配的是**原始模式**，所以 `.env.*`
对之后才创建的文件同样有效。

### 工具策略语义

`read` / `grep` / `find` / `ls` 的 `path`（默认 cwd）命中 `denyRead` 时被拦截。
`write` / `edit` 命中 `denyRead` 或 `denyWrite` 时被拦截，且默认必须落在 `allowWrite` 内。
把 `tools.requireAllowWrite` 设为 `false` 可以只保留 deny 列表、放宽写入范围限制。

## 命令

| 命令 | 说明 |
|---|---|
| `/sandbox` | 展示解析后的配置、配置来源、bwrap 状态 |
| `/sandbox-reload` | 清空所有缓存（配置、探测、项目、设置） |
| `--no-sandbox` | 同时关闭 bash 沙箱和工具策略 |

## 安全模型与限制

**被隔离的部分**

- `bash` 和 `!` / `!!` 用户命令运行在 bwrap 的 mount/pid/net/user 命名空间里，环境干净。
- `read` / `write` / `edit` / `grep` / `find` / `ls` 由 `tool_call` 策略拦截，使用同一套规则
  （这是策略，不是 OS 级隔离）。

**已知限制**

- **项目间可互读。** `--ro-bind / /` 意味着任何项目默认能读其它项目，除非把它加进
  `denyRead`。要更强的隔离，请显式 `denyRead` 或用最小 root 配置。
- **工具策略是尽力而为。** 它拦截内置文件工具，但自定义扩展工具、pi-web 的网页终端 /
  文件浏览器不在覆盖范围内。
- **交互式 TTY 命令**（vim、htop）在沙箱内不可用。
- **重型 glob。** 路径/glob 规则每条命令都会重新展开，所以新建文件立即生效；但像
  `**/*.pem` 这样的递归模式会每条命令扫一遍目录树，建议用精确模式。
- **`extraBwrapArgs` 是把上了膛的枪。** 它会被原样追加。

## 开发

```bash
pnpm install
pnpm test        # 单元测试 + 真实 bwrap 集成测试（无 bwrap 时自动跳过）
pnpm run check   # tsc --noEmit
pnpm run all     # check + test
```

| 路径 | 用途 |
|---|---|
| `src/config.ts` | 配置发现、分层、校验、路径展开 |
| `src/project.ts` | cwd → 项目根 / worktree 根 |
| `src/bwrap.ts` | 纯函数 `buildBwrapArgs` |
| `src/env.ts` | 环境变量白名单/deny 匹配 |
| `src/probe.ts` | bwrap 可用性与能力探测 |
| `src/exec.ts` | `SandboxedBashOperations` |
| `src/policy.ts` | 内置文件工具的 `tool_call` 策略 |
| `src/settings.ts` | 从 pi 设置读取 `shellCommandPrefix` / `shellPath` |
| `src/ui.ts` | `/sandbox` 输出 |

集成测试会真的跑 `bwrap`，没有它时自动跳过，因此在没有 bubblewrap 的机器上测试仍然全绿。

## License

MIT
