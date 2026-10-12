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

要在 linked worktree 里提交，把 `allowWrite` 改成 `["$worktrees", "/tmp"]`
（见下方“路径变量”）。

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

git 存储和 git 保护走的就是同样两步：存储追加到 `allowWrite`，保护追加到 `denyWrite`。
因为 `denyWrite` 在 `allowWrite` 之后应用，保护总能覆盖宽泛的 `allowWrite`。

`--clearenv` 加显式 `--setenv` 意味着沙箱从一个干净的环境开始，只有白名单里的变量存在。

## 配置

### 位置与优先级

| 作用域 | 路径 |
|---|---|
| 全局 | `~/.pi/agent/sandbox.json`（尊重 `PI_CODING_AGENT_DIR`） |
| 项目 | `<项目>/.pi/sandbox.json`（仅当项目被信任时加载） |

合并顺序：**内置默认 ← 全局 ← 项目**。项目数组默认会拼接对应的全局数组，并自动去重。
如果需要让某些数组只使用项目值，可以在项目配置的 `replaceGlobalArrays` 中列出它们的点号路径：

```json
{
  "replaceGlobalArrays": ["filesystem.allowWrite", "env.deny"],
  "filesystem": {
    "allowWrite": ["./dist"],
    "denyRead": ["./local-secrets"]
  },
  "env": {
    "deny": ["PROJECT_*"]
  }
}
```

上例中，`filesystem.allowWrite` 和 `env.deny` 只使用项目值，
而 `filesystem.denyRead` 仍然是全局值加项目值。支持的数组字段为
`filesystem.allowWrite`、`filesystem.denyWrite`、`filesystem.denyRead`、
`env.passthrough` 和 `env.deny`。项目未声明某个数组时，继续继承全局值。
`env.set` 始终按 key 合并。`extraBwrapArgs` 仍然只覆盖不拼接，因为参数顺序可能影响沙箱行为。
linked worktree 优先用自己那份 `.pi/sandbox.json`，没有则回退到主 checkout 的。

`enabled` 同样遵循这套分层：写在全局就是所有项目的默认开关，写在项目里就只覆盖该项目。
`/sandbox-enable` 和 `/sandbox-disable` 会帮你写入。

### 字段

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `replaceGlobalArrays` | string[] | `[]` | 项目级配置中需要替换而不是继承全局值的数组字段（使用点号路径） |
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

路径规则支持 `~` 展开、相对路径（相对命令 cwd 解析）、glob（`*`、`?`、`**`）以及路径变量。
不带 `/` 的相对模式（如 `.env`、`*.pem`）按 basename 匹配。匹配不到任何文件的规则会被跳过
——`bwrap` 只能绑定已存在的路径；而工具策略匹配的是**原始模式**，所以 `.env.*`
对之后才创建的文件同样有效。

### 路径变量

worktree 目录跟机器、分支都相关，硬编码进 `sandbox.json` 不可行。任何路径规则里都可以用这三个变量：

| 变量 | 展开为 |
|---|---|
| `$repo` | 主 checkout 根（所有 worktree 共享） |
| `$worktree` | 命令所在 worktree 的 toplevel |
| `$worktrees` | 所有 worktree 根，主 checkout 在最前（**多值**） |

`$worktrees` 是多值的：一条规则展开成每个 worktree 一条，所以
`allowWrite: ["$worktrees"]` 一次覆盖所有 linked worktree，**包括会话启动后才新建的**
（每条命令都重新展开；worktree 集合的缓存会被 `git worktree add`/`remove` 改动的目录 mtime
立即失效，不必等 TTL 到期）。

```json
{
  "filesystem": {
    "allowWrite": ["$worktrees", "/tmp"],
    "denyWrite": ["~/.ssh", ".env", "*.pem"]
  }
}
```

字面量 `$` 写作 `\$`。未知的 `$name` 会在 `/sandbox` 里告警并原样保留，因此该规则永不命中。

用 `$worktree` 而不是 `$worktrees`，则各 worktree 互相隔离——变量是通用能力，不只是用来放开权限。

### 自动 git 保护

检测到 git 仓库时，沙箱会从 git 布局自动推导额外规则。**无需配置**，`/sandbox` 会以 `git guard` 展示。

git 目录里有两个路径等同于宿主机代码执行，因为 git 会在沙箱**之外**执行它们：
`.git/config` / `config.worktree`（通过 `core.hooksPath`）和 hooks 目录。保护层覆盖这两者，另加
`info`、每个兄弟 worktree 的私有 gitdir、主 checkout 的 `HEAD`/`index`/`ORIG_HEAD`、
以及每个 worktree 的 `.git` 指针文件，使得一个 worktree 无法破坏另一个的状态，也无法重定向 gitdir 指针。
保护以 `denyWrite` 下发，因此**优先于**任何 `allowWrite`，包括 `$repo` 和 `$worktrees`。

三种容易做错的情况都已显式处理：

- **所有 hooks 候选。** 相对的 `core.hooksPath`（husky 默认的 `.husky/_`）按 git 运行时的 cwd 解析，
  因此宿主机可能执行到与本条命令不同的目录。保护层覆盖每个候选，而不只是当前这一个。
- **尚不存在的路径。** `bwrap` 会创建 bind 的目标，所以对不存在的文件做只读绑定会在宿主机留下 0 字节残留；
  对不存在的**目录**则会留下一个文件，导致之后的 `mkdir -p` 失败。这类路径改为**遮蔽**
  （目录用 `tmpfs`，文件用 `/dev/null`）。`config.worktree` 仅在
  `extensions.worktreeConfig` 打开时才遮蔽（否则 git 根本不会读它）。
- **符号链接。** 保护记录的是 realpath 解析后的路径，因为工具策略会对目标做归一化；
  若按字面路径记录，符号链接的 `.git/config` 就会被漏掉，`write` 工具即可穿透。

引用 git 变量时，还会额外打开提交所必需的 git 存储：worktree 的私有 gitdir
以及共享的 `objects`、`refs`、`logs`。这是选择性开放，且**只认 `allowWrite`**——
在 `denyWrite` 里提到 `$worktrees` 不会意外放宽可写范围。
若不用任何 git 变量，则什么都不打开，纯字面量路径的配置在 linked worktree 里无法提交。

```mermaid
flowchart TD
  A["allowWrite: ['$worktrees']"] --> B["展开变量"]
  B --> C["绑定每个 worktree"]
  C --> D["+ git 存储<br/>gitdir, objects, refs, logs"]
  D --> E["git 保护（denyWrite）<br/>config, hooks, info,<br/>兄弟 gitdir, .git 指针"]
```

保护层只列举**已存在**的路径，除非创建它们本身就是攻击面：
`config.worktree`（`extensions.worktreeConfig` 打开时）和尚未存在的 hooks 目录会改为遮蔽而非只读绑定。
`git worktree add` 故意**不**放开——它需要可写的 `config`，而那正是 hook 执行通道。请用 git 本身创建 worktree。

### 工具策略语义

`read` / `grep` / `find` / `ls` 的 `path`（默认 cwd）命中 `denyRead` 时被拦截。
`write` / `edit` 命中 `denyRead` 或 `denyWrite` 时被拦截，且默认必须落在 `allowWrite` 内。
把 `tools.requireAllowWrite` 设为 `false` 可以只保留 deny 列表、放宽写入范围限制。
git 保护在这里同样生效，所以内置 `write` 工具也够不到 bash 沙箱会拒绝的路径。

## 命令

| 命令 | 说明 |
|---|---|
| `/sandbox` | 展示解析后的配置、配置来源、bwrap 状态 |
| `/sandbox-test <command>` | 干跑：打印实际 bwrap argv，不执行 |
| `/sandbox-why <path>` | 解释某路径如何被处理（命中哪些规则、bash vs 工具策略） |
| `/sandbox-init` | 在当前项目生成 `.pi/sandbox.json` 模板 |
| `/sandbox-enable [project\|global]` | 写入 `enabled: true`（默认作用域：项目） |
| `/sandbox-disable [project\|global]` | 写入 `enabled: false`（默认作用域：项目） |
| `/sandbox-reload` | 清空所有缓存（配置、探测、项目、设置） |
| `--no-sandbox` | 本次会话同时关闭 bash 沙箱和工具策略 |

## 安全模型与限制

**被隔离的部分**

- `bash` 和 `!` / `!!` 用户命令运行在 bwrap 的 mount/pid/net/user 命名空间里，环境干净。
- `read` / `write` / `edit` / `grep` / `find` / `ls` 由 `tool_call` 策略拦截，使用同一套规则
  （这是策略，不是 OS 级隔离）。

**已知限制**

- **项目间可互读。** `--ro-bind / /` 意味着任何项目默认能读其它项目，除非把它加进
  `denyRead`。要更强的隔离，请显式 `denyRead` 或用最小 root 配置。
- **`$worktrees` 是共享写面。** 一条规则放开所有 worktree，因此 worktree A 里的 agent
  可以改 worktree B 的文件。若想让各 checkout 互相隔离，请用 `$worktree`。
- **`git worktree add` 不放开。** 它需要可写的 `.git/worktrees`，而那正是必须保持只读、
  以保证 hook 安全的目录。请用 git 本身创建 worktree。
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
| `src/config.ts` | 配置发现、分层、校验、路径展开、git 保护层 |
| `src/project.ts` | cwd → 项目根 / worktree 根 / git 布局 |
| `src/variables.ts` | `$repo` / `$worktree` / `$worktrees` 展开 |
| `src/bwrap.ts` | 纯函数 `buildBwrapArgs` |
| `src/env.ts` | 环境变量白名单/deny 匹配 |
| `src/probe.ts` | bwrap 可用性与能力探测 |
| `src/exec.ts` | `SandboxedBashOperations` |
| `src/policy.ts` | 内置文件工具的 `tool_call` 策略 |
| `src/config-write.ts` | `/sandbox-init` 与 enable/disable 的配置写入 |
| `src/settings.ts` | 从 pi 设置读取 `shellCommandPrefix` / `shellPath` |
| `src/ui.ts` | `/sandbox` 输出 |

集成测试会真的跑 `bwrap`，没有它时自动跳过，因此在没有 bubblewrap 的机器上测试仍然全绿。

## License

MIT
