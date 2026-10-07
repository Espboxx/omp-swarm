[English](README.md) · **简体中文**
# omp-swarm — 面向 OMP 的去中心化对等 agent 集群

一个扁平的多 agent 集群：**N 个对等 agent，没有常设管理者**，通过同一块共享 SQLite 黑板协作 —— 共享任务池、原子认领、租约、文件预留、评审，以及只追加的共享知识。

```
                 ┌──────────────────────────────┐
                 │      .swarm/swarm.db         │
                 │  TASK · CLAIM · LEASE        │
                 │  FACT · FAIL · RESULT        │
                 │  MESSAGE · RESERVATION       │
                 └──────────────┬───────────────┘
        ┌────────────┬──────────┼──────────┬────────────┐
     Agent A      Agent B    Agent C    Agent D       (bootstrap)
        │            │          │          │              │
        └──────── shared working directory / git worktrees ┘
```

每个参与者都是对等的。启动器只负责*启动* worker 并*驱动*它们的心跳；每一个决定 —— 领哪个任务、何时拆分、分享什么、何时上报 —— 都由持有工具的那个 agent 做出，所有权冲突由数据库裁定，而不是靠 agent 之间的礼让。

## OMP 已经提供什么（复用，不重新实现）

| 能力 | OMP 接口 | 集群如何使用它 |
|---|---|---|
| Agent 运行时 | `pi.pi.createAgentSession`（SDK） | 每个 worker 都是进程内真实的 OMP `AgentSession`，有自己的模型、自己的会话文件、自己的 `AgentRegistry` |
| 会话 | `SessionManager.create(cwd, dir)` | 每个 worker 的转录存放在 `.swarm/sessions/<name>/` 下 |
| 工具 API | `CustomTool` / `createAgentSession({ customTools })` | 22 个 swarm 工具被注入到 worker 会话中 |
| 受限工具集 | `toolNames` + `restrictToolNames` + `allowRestrictedCustomTools` | worker 只拿到编码工具 + swarm 工具，别的什么都没有 |
| 系统提示分层 | `appendSystemPrompt` | worker 章程是**追加**的，不替换 OMP 的提示 |
| 子 agent 可观测性 | `session.subscribe()`（`agent_start` / `agent_end.isTerminal`） | 用于 tick 投递的空闲检测 |
| 消息投递 | `session.prompt()` / `sendUserMessage({deliverAs: "steer" \| "followUp"})` | 同伴消息以 prompt 形式投递，而不是走私有协议 |
| 托管定时器 | `ctx.setInterval` / `ctx.clearTimer` | 心跳、清扫、tick、面板 —— 抛出被兜住 |
| TUI | `ctx.ui.setStatus` / `ctx.ui.setWidget` / `ctx.ui.notify` | 实时集群状态行、编辑器上方的 `swarm-panel` 文本 widget、以及告警行 |
| 完成横幅 | `TERMINAL.sendNotification`（`@oh-my-pi/pi-tui`） | 批次完成告警走宿主自己的 “Complete” 通道 |
| 斜杠命令 | `pi.registerCommand("swarm", …)` | `/swarm start`、`/swarm status` 等 |
| 隔离检出 | `git worktree`（与 OMP 处理任务的方式相同） | `worktrees: true` 给每个 worker 一个分支 + 检出 |
| 进程执行 | `pi.exec` | 创建 worktree |

这里没有任何东西 fork OMP、打核心补丁，或另造一套 LLM 抽象。集群自己的那部分，恰好就是 OMP 没有提供的那部分：**共享任务池、原子认领、租约、黑板、文件预留、自主 worker 循环、评审、swarm 面板**。

对“复用原生 agent 消息”的一处刻意偏离：OMP 的 `agent://` / IRC 通道寻址的是**同一棵会话树内部**的 agent。而集群中的同伴是相互独立的顶层会话，还必须能扛住进程重启，所以消息是共享数据库里的一张持久表，投递到同伴则走 OMP 自己的 prompt 路径。只有一条传输通道，不是两条。

## 文件

`config.example.json` —— 复制到项目的 `.swarm/config.json`。

```
extension/
  index.ts     extension entry: tool registration, /swarm commands, status panel, lazy runtimes
  auto.ts      multi-agent mode: roster derivation (incl. the goal budget), mid-run growth + the auto-assemble/self-stop state machine + the planning round's bound
  driver.ts    worker lifecycle: spawn sessions, add workers to a running pool, tick, heartbeat, wake, worktrees, shutdown
  tools.ts     the 23 agent tools (shared by workers and the main session)
  store.ts     the reliability core: atomic claim, lease, review, reservations, board, messages, goals and the scribe's merge
  planning.ts  the planning round's pure rules: proposal parsing, the dedupe key, the merge and the creation order
  scaling.ts   the pool-size rule: collapsing the agents' asks into one resize, the ceiling clamp, the shrink floor and who may be stopped
  db.ts        SQLite schema, WAL setup, typed facade over bun:sqlite
  config.ts    `.swarm/config.json` loading + role expansion
  render.ts    text rendering for the panel, task table, summary, task progress and the batch-completion summary
  agentinfo.ts pure agent-list rows: AgentInfo facts -> one fitted ASCII line per worker
  color.ts     the reminder palette: per-agent and per-status colours, host-parity visible width, control-byte sanitization
  agentnav.ts  the agent-list selection model: main-first entries, cursor movement with wrap, the marker column, row rendering
  types.ts     domain types
  web.ts       `/swarm web`: the dashboard's child process, its argument parsing and the free-port scan
web/
  server.ts    the dashboard's transport: read-only HTTP + SSE over `.swarm/swarm.db`, 127.0.0.1 only
  snapshot.ts  the pure reader: one `swarm.db` -> the frozen Snapshot JSON
  lib/         the read-only DB handle, asset path resolution and the row types
  assets/      the page itself: index.html, app.js, style.css, strings.js (zh/en) and its sample snapshot
tests/
  unit/store.test.ts           45 unit tests of atomic claim, leases and crash recovery, dependencies, review, the blackboard, reservations, messaging and the two ways an unclaimable row can be closed
  unit/auto.test.ts            56 unit tests of multi-agent mode: roster derivation, the goal budget, the planning round's bound, mid-run growth and the assemble/self-stop state machine
  unit/planning.test.ts        38 unit tests of the planning round's pure rules: the dedupe key, proposal parsing, the merge, the creation order and the task brief
  unit/scaling.test.ts         18 unit tests of the pool-size rule: collapsing concurrent asks into one resize, the ceiling clamp, the floor, the shrink deferral and the cooldown
  unit/starvation.test.ts      12 unit tests of the unclaimable-ready-work rule: which ready rows no online agent can take, and the notice that must follow
  unit/goals.test.ts           14 unit tests of the goal lifecycle: the exactly-once scribe (incl. a 3-process race), the merge's idempotence, lease takeover and the bound
  unit/goal-tools.test.ts       9 unit tests of the round at the TOOL layer: swarm_goal -> swarm_propose -> swarm_claim -> swarm_plan
  unit/render.test.ts          49 unit tests of the panel, task table, summary, progress bar, drain summary and age formatting
  unit/agentinfo.test.ts       30 unit tests of the agent-row facts: token/cost/context compaction, sorting, line fitting and colour
  unit/color.test.ts           39 unit tests of the reminder palette, status colours, painted output, host-parity width and control-byte sanitization
  unit/agentnav.test.ts        23 unit tests of the selection model: main-first entries, cursor wrap and clamping, the marker column and row rendering
  unit/web-command-parsing.test.ts 17 unit tests of `/swarm web`'s pure surface: argument parsing, port validation, the free-port scan and the URL
  unit/web-server.test.ts      10 unit tests of the dashboard's HTTP surface: the frozen contract, the error surface, SSE change detection, read-only
  unit/web-snapshot.test.ts    11 unit tests of the snapshot reader: counts, blockedReason, the newest-first feeds and the task-size cap
  unit/web-dashboard.test.ts    1 browser test of the page's own DOM: the newest-first feeds and a group header that cannot contradict the counts chip
  unit/web-format.test.ts       6 unit tests of the page's pure presentation helper: where a long path may break, and that the transform loses nothing
  unit/index.test.ts            8 unit tests of the extension's optional host-module seams: the lazy key matcher and the completion alert, both branches
  unit/host-free-load.test.ts   3 checks that the extension loads under `bun --no-install` in a node_modules-free tree, with a negative control
  helpers/swarm-child.ts       child-process worker used by the race tests
  unit/helpers/goal-child.ts   child-process scribe used by the cross-process planning-race test
  integration/harness.ts       scratch project, seeded tasks, shared assertions
  integration/sdk-run.ts       live swarm driven through the SDK (headless)
  integration/swarm-run.ts     live swarm driven through a real `omp --mode rpc` session
  integration/auto-run.ts       multi-agent mode end to end: one plain task, no /swarm command
  integration/rpc-client.ts    minimal OMP RPC client (NDJSON over stdio)
  integration/rpc-dump.ts      frame-level RPC diagnostics
```

## 安装

### 从 marketplace 安装（自托管）

本仓库自身就是一个 marketplace —— `.omp-plugin/marketplace.json`（目录 `espboxx-plugins`）指回仓库根目录，所以一个 URL 就够了：

```
/marketplace add Espboxx/omp-swarm
/marketplace install omp-swarm@espboxx-plugins
```

等价的 CLI 命令：先 `omp plugin marketplace add Espboxx/omp-swarm`，再
`omp plugin install omp-swarm@espboxx-plugins`（`--dry-run` 只预览，不拉取、不写盘）。

安装**默认是用户级**（对所有项目生效）；加 `--scope project` 可限定到当前项目，`--force` 可重装。`/reload-plugins` 会刷新 skills、斜杠命令、agents 和 MCP server，但**新安装的 extension 模块需要重启会话**才能让 `/swarm` 及其工具存在。包名 `omp-swarm` 在每个 scope 内全局唯一，所以 marketplace 安装会与已经 `omp plugin link` 的检出冲突（`Runtime package name "omp-swarm"
conflicts with installed plugin "omp-swarm@espboxx-plugins"`）—— 先卸载那个 link。

### 从本地检出安装

开发模式（任意目录，无需安装）：

```bash
omp -e /abs/path/to/omp-swarm/extension/index.ts
```

作为插件（每个会话都会加载 —— 已验证：`omp plugin doctor` 报告 5 个 ok，且在没有 `-e` 启动的会话里工具与 `/swarm` 都可用）：

```bash
omp plugin install /abs/path/to/omp-swarm      # links the package into ~/.omp/plugins
omp plugin list                                 # confirm omp-swarm is listed
omp plugin doctor                               # health check
```

与 `-e` 不同，安装器是给包做链接，所以 `extension/` 下的改动会在下个会话生效，无需重装。用 `omp plugin uninstall omp-swarm` 卸载。

或者从配置里引用：

```yaml
# ~/.omp/agent/config.yml
extensions:
  - /abs/path/to/omp-swarm/extension/index.ts
```

需要 OMP 18.6.1+（用到 `pi.pi.createAgentSession` 和 extension 的 `ui.setWidget` 接口）。

## 配置

集群根目录下的 `.swarm/config.json`（首次使用时创建；`/swarm config` 会打印生效值）。本仓库里有一份可直接复制的模板 `config.example.json`：

```json
{
  "workers": 4,
  "leaseSeconds": 120,
  "heartbeatSeconds": 10,
  "offlineAfterSeconds": 45,
  "idleTickSeconds": 20,
  "review": true,
  "auto": false,
  "worktrees": true,
  "model": "provider/model-selector",
  "thinkingLevel": "medium",
  "roles": [
    { "name": "general", "count": 2, "capabilities": ["general"] },
    { "name": "reviewer", "count": 1, "capabilities": ["general", "reviewer"] },
    { "name": "integrator", "count": 1, "capabilities": ["integrator", "reviewer"] }
  ],
  "tools": ["read", "grep", "glob", "edit", "write", "bash", "ast_grep", "ast_edit", "todo"]
}
```

`model` 是可选的 —— 省略它，worker 就继承会话/供应商的默认值。角色的 `count` 会展开成呼号（`SwiftTiger`、`CalmFalcon` 等）；`capabilities` 决定认领资格。

`planning` 决定由谁来拆分工作。它是唯一会改变协调者整体行为的键，也是这里提到的键当中唯一一个随仓库发布的 `config.example.json` 尚未收录的 —— 原样复制那份模板依然正确，因为缺这个键时默认值就会生效：

- `"planning": "swarm"` —— **默认值**。协调者只判断请求需要多少个 agent，并用 `swarm_goal` 开一个目标；worker 各自用 `swarm_propose` 发布自己的拆分提案，第一个认领目标规划任务的人（*scribe*）用 `swarm_plan` 把它们合并、去重成真正的任务图，之后所有人从那张图里认领。这一轮的流程与代价见「多 agent 模式（`/swarm on`）」一节。
- `"planning": "coordinator"` —— 2026-10-07 之前的行为，保留在开关后面：协调者自己用 `swarm_task_create` 写出整张任务清单，worker 只从中认领。

其他任何取值都会回落到 `"swarm"`。

## 使用

```
/swarm on             # multi-agent mode: the next task you type is executed by a swarm
/swarm off            # leave the mode (running workers are stopped)
/swarm start 4        # spawn 4 workers (reads .swarm/config.json for roles/lease/review)
/swarm status         # full snapshot: mode phase, agents, task counts, in-flight tasks with elapsed/attempts, throughput, board histogram
/swarm agents         # roster with role, state, task, heartbeat age, capabilities, worktree
/swarm nav            # the same list as an overlay: arrows move the cursor, Enter marks the target (see below)
/swarm tasks ready    # task pool by status
/swarm board FAIL     # blackboard by type
/swarm task <title>   # operator-created task (bootstrap)
/swarm message <agent|all> <text>   # operator → worker(s), delivered as a prompt
/swarm approve <id> [notes] | /swarm reject <id> <notes>
/swarm config | /swarm roles
/swarm web            # dashboard on 127.0.0.1:8787: starts it, prints the URL; /swarm web stop ends it
/swarm stop           # workers release their work, post final notes, sessions disposed
```

`/swarm start` 立即返回：会话在后台创建，agent 约 30 秒内加入（用 `/swarm agents` 或面板观察）。启动失败的 worker 会被报告并跳过，而不是阻塞整个集群。设置 `SWARM_TRACE=1` 会把每个 worker 的里程碑写入 `.swarm/driver.log`。

集群运行时，编辑器上方的 widget 和 `swarm` 状态行会实时更新。在 worker 行上方，widget 承载任务进度 —— 一个进度条（`█████████░`）压着一行 `TASKS 7/8 · 1 running · 1 blocked · 88%` —— 状态行则承载紧凑形式（`SWARM 7/8 done`）。分母是**可执行**的工作量（`ready + claimed + review + done + failed`）；`blocked` 被刻意排除并单独作为一段报告，因为一个依赖已被判定为 superseded 而关闭的任务会永远 blocked，把它算进去的进度条永远到不了 100%。widget 之后每个 worker 一行 —— `state`、它持有的任务、git 分支、`ctx <n>%`、输入/输出 token、`$cost`、轮次和最近活动 —— 按终端宽度从右侧整字段地丢弃以适配。要看数据库对同一集群的看法，`/swarm agents` 列出名册（`role`、`state`、`task`、心跳年龄、capabilities、worktree），`/swarm tasks` 列出任务表。

### 提醒色

widget 的 agent 行和计数器采用提醒色，而不是读起来像一整块白：每个 worker 的名字从固定的 8 色调色板里分到自己的槽位，按名字顺序分配而非按显示顺序 —— 同一帧内槽位互不相同，worker 改变状态只会让行重新排序、不会给任何人换色，所以颜色在多次重绘间都能标识同一个 agent（有新 worker 加入名册时仍可能让靠后的槽位整体挪一位）。状态标记会取该状态的颜色（`working` 绿色、`reviewing` 青色、`waiting` 琥珀色、`blocked` 红色、`idle`/`offline` 灰色），非零计数器使用同一套语言 —— `BLOCKED` 红色、`FAILED` 亮红、`DONE` 绿色，为零的计数器保持素色，这样干净的池子看起来是平静的。颜色只在一个地方决定，`extension/index.ts`（`colorEnabled(process.env, process.stdout.isTTY)`），只要输出不是交互式终端或设置了 `NO_COLOR` 就关闭：`NO_COLOR=1 omp` 与 `omp | cat` 输出逐字节相同的纯文本，零转义字节。这些转义是零宽的 —— 每一行仍按**可见**列度量和裁剪，用的是宿主自己的 `Bun.stringWidth` 规则（ANSI 记 0，每个 tab 记 3 格）—— 所以一行彩色内容与纯文本行一样精确适配终端，CJK 或 emoji 标题亦然。每行里承载存储文本的字段（名字、状态、任务 id 与标题、分支）在度量或绘制前都会先净化：转义序列和 C0/C1 控制字符被丢弃，所以任务标题永远无法把光标移动、清屏或写剪贴板偷渡进终端。状态行的 `SWARM n/m done` 用同样的颜色组成，但宿主在绘制状态文本前会先净化它（`pi-tui` 的 `sanitizeStatusText`），所以那一个界面读起来是素色的 —— 这是实测，不是假设。

### Agent 列表导航

`/swarm nav` 把 agent 列表作为左对齐浮层打开，按键归你：

| 按键 | 动作 |
|---|---|
| `↑` / `↓`（或 `k` / `j`） | 移动光标；到两端会环绕 |
| `Enter` | 把高亮行设为**当前目标**，然后关闭 |
| `Esc`（或 `q`） | 关闭，什么都不改 |

每一行都带一个三列 ASCII 标记：`>` 是光标，`*` 是当前目标，两者互相独立 —— 走列表不会移动 `*`，只有 `Enter` 会。第 0 行是主会话（`main session · this terminal`），所以主会话和各 worker 是同一张列表，操作者可以在其间移动；其余行与 widget 绘制的完全一致（`state`、任务、分支、`ctx`、tokens、`$cost`、轮次）。选择器关闭时 widget 仍继续绘制这两个标记，所以当前目标随时可读，重绘也不会丢失选择。

浮层是让这些按键成为可能的前提，而不是风格选择：OMP 会静默丢弃任何 extension `registerShortcut` 里的 `enter`/`escape`，而编辑器上方的 widget 永远不会获得焦点，所以一个能持有焦点的组件才是唯一能同时拥有方向键**和** Enter 的界面。这里没有任何全局抢占 —— 在输入框里打字不受影响（选择器只在 `/swarm nav` 之后才看到按键），`Esc` 关闭它且不改选择，没有 TUI 的宿主则保留纯文本的 `/swarm agents`。选择状态存在 extension 的 per-root runtime 里，能扛住重绘，并会对实时名册做钳制：光标永远不会停在最后一行之后，目标 agent 离开时会回落到主会话。

主会话那一行会占用宿主十条 widget 行中的一条，而且记在本来就是靠预算的那一块上：进度条与它的计数行在最多三个 worker 时都能放下，四个 worker 时只剩计数行，五个及以上两者都不在 widget 里 —— worker 行、计数器和 board 统计不受影响，进度本身仍由 `SWARM n/m done` 状态行和 `/swarm status` 报告。名册很大时，常驻的批次摘要在同一行上收缩；状态行标题和转录里的副本不受影响。

**`Enter` 到底做什么：** 它在集群自己的列表里标记目标，**不会**自己切换会话面板 —— 那是宿主的界面。`Alt+A` 打开宿主的 Agent Hub，它现在会列出每一个存活的 worker（每个都被创造成 `AgentRegistry.global()` 里的宿主子 agent，见 `extension/driver.ts`），在某个 worker 行上按 `Enter` 会把这个 worker 的实时会话接进主面板（`Viewing agent <id>`），在空编辑器上按 `Esc` 或双击 `←` 则回到主会话（`Returned to main
session`）。Hub 里按 `x` 会释放一个 worker：driver 通过 agent registry 得知，把它从池子里移除并标记为 `offline`，所以它持有的任务只会存活到租约过期。`/swarm
message <id> <text>`（或 `swarm_message` 工具）仍然能在不离开这个面板的情况下触达你标记的 agent。

### 批次完成告警

操作者每个批次只会收到**一条**告警，重绘不会重复。这个边沿在本来就在跑的 tick 上求值（不新增定时器）：没有可执行工作、该批次至少有一个任务完成、并且计数在 `DRAIN_SETTLE_MS` 内保持不动（10 秒 —— driver 每 3 秒采样一次，所以告警落在最后一个任务完成后的 10–13 秒，这也正是让“即将认领下一个任务”的 worker 不会提前结束批次的原因）。之后出现的任务会开启一个新批次，告警可以为它再次触发。

告警走三个界面：

- 宿主自己的完成通道 —— `TERMINAL.sendNotification({ title: "SWARM DONE", body:
  <headline>, type: "completion" })`，与宿主用于 “Complete” 横幅的是同一个（被 `PI_NOTIFICATIONS=off` 抑制，在无头终端里是 no-op）；
- 一行 `ui.notify`，以及在多 agent 模式关闭时转录里的完整多行摘要（模式开启时控制器会自己发完成通知，聊天里一条告警就够了）；
- 一个**常驻标记**：widget 保留摘要行，状态行保留标题 ——
  `SWARM DONE · 9/9 tasks (7 done, 2 failed) · 3 agents · 12m40s · $0.42` —— 直到出现新的可执行工作或下一次 `/swarm start`。

批次就是那次运行所负责的范围：池子启动时尚未终结的任务，加上运行期间创建的。摘要对它知道的事情保持诚实：完成者是从事件日志里拼出来的（`complete()`/`fail()` 会清空 `claimedBy`），时长是创建到完成（工作窗口不可复原），成本是这个批次的 worker 会话折叠到一起 —— 没有按任务计价，所以不打印。什么也没完成就结束的运行属于停滞通知的场景，不是这里的，而且它永远不会声称 “the swarm finished”。

有一条范围规则值得说明，因为两种数字共用一行：标题里的计数是排空时刻**整块 board** 的存储总量（这就是 `DrainSummary.counts`，也是 `/swarm tasks` 报告的）—— 只有耗时、agent 数、成本和每任务的行属于这个批次。在一个本来就带着已完成工作的池子上，标题读起来会比这个批次大；每任务的行才是这个批次自己的记录。

### 多 agent 模式（`/swarm on`）

手动集群需要操作者做两件事（创建任务，然后 `/swarm start N`）。在多 agent 模式下，会话自己把两件都做了：

1. `/swarm on` 把 `"auto": true` 持久化进 `.swarm/config.json`，状态行切换为
   `MULTI-AGENT ON · idle`。模式是按项目生效的，且能扛住重启（配置写着 `auto: true` 的会话一启动就在模式里）。
2. 在普通输入框里打一个任务。extension 会标出一个规划窗口，并且在那一个回合里，协调者会收到常驻指令，内容取决于 `planning`：
   - `"swarm"`（默认）：判断这个请求需要多少个 agent，然后用 `swarm_goal({ goal, agents })` 开一个目标 —— 协调者**不**写任务清单。这一调用会记录目标、铸出它唯一的那一个规划任务；随后池子按目标的 agent 预算启动（至少 `agents`，上限 `config.workers`），因为这一轮自己的计划只有一个任务，没有这个预算它就会单线程地跑。
   - `"coordinator"`：用 `swarm_task_create` 把请求拆成 2–6 个独立任务、发布一条 `DECISION`，并且不要自己去改 worker 的文件。
   两种模式下协调者都不再自己动手做这件事，并保持可应答进度问题。
3. 一旦协调者停止发布任务（20 秒静默期，这样名册会按整个计划定规模，而不是按一个仍在运行的回合里的第一个任务；在 `"swarm"` 模式下目标的 agent 预算给出下限，因为一个存活的目标在任何任务存在之前就已经算作工作了），就根据任务的需要推导出名册（`required_capabilities`）：一个能力一个 agent，富余给具备 general 能力的角色 —— 唯一例外是**需要 review 的角色**：当 `review: true` 且存在需要评审的工作时它会被加进来，并**按需求定编**（要求 `reviewer` 的活跃行数），因为一个审查者无法审计自己写的东西，而一串需要 review 的行配上单个审查代理，在结构上就无法被认领。名册按计划确定规模并受 `config.workers` 上限约束 —— 排在依赖后面的工作也算，所以依赖链不会让整次运行串行化。worker 随即启动、认领并执行。名册不会在第一次定规模时就冻结：driver 存活且池子既没排空也没停滞时，每个 tick 只要 ready 工作超过存活 worker 数**和**池子当初据以定规模的 ready 数，就按计划还需要的增量扩大池子
   （`auto.ts:AutoController.tick` → `driver.addWorkers`），衡量基准取存活与计划 worker 数的较大者，并且只在计划中的 worker 少于 `config.workers` 时进行。增长在每一次 ready 计数上升时最多发生一次（水位在每一步重新绑定，并在模式重新布防、关闭、销毁、排空或停滞时重置），所以一个还没起来的 spawn 既不会自己触发一次增长，也不会被重复计数。因此，池子启动之后才发布的任务（协调者追加工作、某个 worker 拆分一个过大的任务）会拿到 worker，而不是排在一个对它来说太小的池子后面。
4. 当每个任务都是 `done`/`failed` 时，集群自己停下，主会话收到带计数的完成通知，操作者收到批次完成告警（见上）—— 先回答，如果有下一个任务就发出去。

规划轮（模式 `"swarm"`）按顺序是这样：

1. `swarm_goal({ goal, agents })` 在一个事务里写入目标行和它唯一的那一个规划任务，池子随后按目标的 agent 预算启动（至少 `agents`，上限 `config.workers`）。存活的目标在任何任务存在之前就已经计入名册定规模，并且它被刻意排除在停滞通知之外。
2. 每个 worker 读这个目标（`swarm_status` 会列出它；规划任务本身带着简报），并用 `swarm_propose` 发布自己的拆分 —— 一条打了 `proposal` 标签、限定在该目标下的 board `OBSERVATION`，所以整个集群都能读到并回应它（可以用 `swarm_message` 完善别的 agent 的提案）。
3. 第一个 `swarm_claim` 到规划任务的 worker 就是 **scribe**。随后 `swarm_plan` 在一次事务里合并这一轮：只有在调用者仍持有那次认领、目标仍然 open、并且至少有一条提案时它才继续。它按**产出什么**而不是标题措辞去重：标题完全相同的一律合并；其余情况下的键是**目标产物**（提案声明的 `files`，否则是标题里的文件名 —— 只有路径形状、或结尾是已知文件扩展名的 token 才算文件名，所以 `1.2.3`、`v1.0.beta` 这类版本号不是文件名，也就无法把两个交付物并成一个）加上**工作类型**（write/verify/fix/document/remove/refactor）。同一个产物上的两个 **writer** 永远只算一个交付物 —— 产物只有一个归属 —— 而同一交付物上的两个非写入视角（比如一个 writer 和一个 verifier）则在「一方是另一方的某一节」或措辞足够接近时才合并。文件、能力与依赖取并集并入存留者，描述取最长的那条；池子里已经持有的交付物会被跳过并如实报告；**没有可识别产物**的提案不与任何东西匹配（错误合并会丢工作，错误拆分只是多一个任务）。合并后的拆分以 `DECISION` 发布，目标被标记为 planned。
4. 规划任务完成，之后所有人通过那条并未改动的循环认领真正的任务。

恰好一次靠的是**原子认领**，而不是时序：两个 agent 不可能同时持有规划任务，而一个过期租约（scribe 中途死掉）会把它交给下一个认领者，后者可以安全地重新合并，因为创建对池子而言是幂等的。

这一轮花掉什么、又如何结束：每个提交提案的 worker 都要自己读一遍目标、自己写一份提案 —— 大致是 N × 一轮协调的开销，而不是协调者里那一轮协调，这正是「协调者不再写清单」的诚实代价。这一轮是有界的：目标开出后 10 分钟内没有产出计划，它就会被关闭为 `failed`，无人认领的规划任务随之关闭，并在 board 上留下一条 `FAIL` 加一条通知，所以无法收敛的一轮是被报告的，而不是空转。而去重键是交付物本身 —— 它的目标产物加上工作类型 —— 从不是标题的措辞：同一个产物上的两个 writer 永远只变成一个任务，因为产物只有一个归属。仍然会被拆开的，是键完全看不见的那种提案：没有声明 `files`、标题里也没有文件名，它就没有可用于匹配的产物，不与任何东西合并，于是同一个交付物两种相去甚远的说法就会留下两个任务 —— 这正是 scribe 需要自己读一遍这一轮的原因。

状态行会跟踪模式：`idle`、`planning`、`running`（`3a r0 c2 v0 d1` = 在线 agent 数，ready/claimed/review/done）、`done n/m`、`stalled`，池子存在时以紧凑进度为前缀（`SWARM 7/9 done`），批次排空后被它的标题替换
（`SWARM DONE · 9/9 tasks (7 done, 2 failed) · 3 agents · 12m40s · $0.42`）；编辑器上方的 widget 在进度块之上带一个 `MULTI-AGENT MODE · <phase>` 表头，每个 worker 一行富信息（状态、任务、分支、ctx%、tokens、成本、轮次、年龄 —— 见上），并在进度块的位置保留已排空的摘要；`/swarm agents` 从存储里列出名册。`/swarm off` 停掉正在运行的 worker 并持久化
`"auto": false`；一个没有可认领工作而被卡住的集群会在 90 秒后被停止并报告为 `stalled`，而不是空转。如果协调者对一个仍在流式输出的请求没有开目标（或者在 `"coordinator"` 模式下没有创建任何任务），它会在 90 秒后被催一次，模式回到 `idle`。

在池子未运行时出现的任务 —— 手写的 `/swarm task`、`/swarm stop` 之后的遗留 —— 会按同样的规则为它们启动一个池子。池子运行时发布的任务由该池子接手，并向它们增长，上限是 `config.workers`。

不用 TUI 也能复现这套 UI 界面（重复 `--command` 可在同一个会话里走一段序列）：

```bash
bun run rpc:dump -- --ui --installed --command "/swarm on" --command "/swarm off" --gap 10 --seconds 40
# → setStatus statusText=MULTI-AGENT ON · idle after "on"; no MULTI-AGENT frame after "off"
```

### 池子大小：协调者给的 `N` 只是一个起点

你在 `swarm_goal` 里给出的 agent 数量只决定池子启动时的大小，没有任何东西被冻结在那里。上面说的「计划的自行成长」会随着 `ready` 工作出现把池子撑大，所以一个低估了工作量的目标是在运行中被纠正的，而不是用偏少的人手跑完整个批次。

任何 agent 也可以主动请求一个大小，而请求是池子成长的唯一另一条路：

```
swarm_scale({ agents: 6, reason: "5 ready tasks and 2 in flight" })
```

- 它是**建议性的、且留痕的**，从不是直接拉起 agent。请求会记录谁提的、为什么、改前的大小以及最后发生了什么，并在黑板上以带 `scale` 标签的 `OBSERVATION` 发布。返回值会说明四种结果里的哪一种发生了：`accepted`、`clamped`（请求高于上限）、`raised to N`（当前工作形态保住了下限），或 `recorded, but the pool is already N`。
- **controller 是池子大小的唯一写者**，它在本来就在跑的 tick 上（每 2 秒）重算。同一个 60 秒窗口里多个 agent 感到同样的短缺，会塌缩成**一次**改尺寸：决策每个 tick 都从头重算，且取最大的那个请求，所以 N 个 agent 各要一个，结果是一个，而不是 N 个。超过 60 秒的请求会被当作过期丢弃，而不会在促成它的工作形态早已消失之后才被应用。
- `config.workers` 是**操作者的上限**，它在改尺寸发生的地方强制生效，而不是靠约定：更大的请求会被钳制执行，并且返回值会说明这一点。任何 agent 无论要多少，都无法花超过操作者设定的预算。上限同时**压过工作形态给出的下限**：当当前工作需要的 worker 数超过预算时，池子会**停在上限**而不是越过预算去规划，并按 (需要的数量, 上限) 的不同组合各提示一次 `pool.underBudgeted`。扩编上报的是宿主**实际启动**的 worker 数，而不是请求的增量。
- 池子现在也会**收缩**，这是以前完全没有的。收缩只会停掉**什么都没拿**的 worker —— 没有认领、没有评审租约、没有文件预留，也不在回合中间。其他情况一律推迟这次收缩，而被推迟的请求会留在待处理状态，下一个 tick 仍可应用。大小的下限由当前工作形态决定（每个被持有的任务保住自己的工作 worker，留一个空闲 worker 接下一次认领，有 `ready` 工作时再多留一个），并且只要还有可做的事就绝不降到 1 以下 —— 停掉整个池子是 `/swarm off` 或排空路径的事，不是 scaler 的事。
- 计划本身会说出它认为需要的大小：`swarm_plan` 会报告**峰值并行度**（新建的任务里能同时跑几个）和一个**建议的 agent 数量**，连同上限一起给出，所以「N 猜对了吗」在任何人开始干活之前就有答案。

代价：把池子撑大是真的开新会话、花真实的 token，所以上限是限制，不是目标。改尺寸是限速的，不是即时的 —— 两次改尺寸之间至少隔 30 秒，请求 60 秒后过期 —— 所以错的 `N` 会在一两个 tick 内被纠正，但绝不会越过 `config.workers`。

### Web 看板（`/swarm web`）

TUI 在信息量大时读起来吃力，所以集群也提供了一个页面 —— 一条命令启动它，并打印它真正绑定的 URL：

```
/swarm web                  # 启动（默认 127.0.0.1:8787）并打印 URL
/swarm web --port 9100      # 从指定端口开始
/swarm web status           # 是否在跑、哪个端口、哪个 pid
/swarm web stop             # 停掉它并释放端口
```

它作为**独立的子进程**运行（`bun web/server.ts`），绝不在 TUI 自己的进程里，所以一个缓慢或坏掉的页面无法阻塞编辑器或集群。页面呈现的是从外部看到的池子：每个 agent 以及它手上握着什么、按状态分组的任务池、协作信息流（board 条目、agent 之间的消息、原始事件）以及进度拆分 —— 数据全部读自集群自己写的同一个 `.swarm/swarm.db`。

从构造上就是本地且只读：只绑定 `127.0.0.1`（不使用任何网络接口），以 SQLite 的只读标志打开数据库，并让每一个非 GET 请求得到 405。命令本身什么都不改：不会打开多 agent 模式，不会写数据库，也不需要任何配置键。

诚实的限制 —— 被占住的端口很容易被忘掉：

- 默认端口被占用时，会用下一个空闲端口并把 URL 打印出来 —— 绝不静默失败。而显式指定的 `--port` 若被占用则会被**拒绝**，并指出可用的替代端口，而不是偷偷换成你没要求的端口。
- 每个集群根目录一个看板：在同一个根目录里第二次 `/swarm web` 只会报告正在运行的那个，不会另起一个。两个不同的根目录可以各有一个，跑在不同端口上。
- 它是读者：只渲染快照，不能运行、认领或改变任何东西。
- 用完请停掉。`/swarm web stop`、`/swarm stop` 和退出 omp 都会杀掉这个子进程 —— 在 Windows 上实测过，即使对 omp 硬杀，子进程也会随之消失，端口随后空闲。运行期间它会占用一个端口和一个只读数据库句柄。

## 工具（worker 与主会话都可用）

| 工具 | 用途 |
|---|---|
| `swarm_status` | 在线/工作中/空闲的 agent、任务计数、带原因的 blocked 工作、board 直方图 |
| `swarm_tasks` | 列出任务池（`status`、`capability`、`mine`、`limit`） |
| `swarm_claim` | **原子**认领；同一次调用里可选地预留文件 |
| `swarm_renew` | 延长你持有的租约 |
| `swarm_release` | 带原因把工作交回（绝不静默停摆） |
| `swarm_complete` | 带摘要/commit/files 完成 → `review` 或 `done` |
| `swarm_fail` | 带原因失败；会自动写入一条 FAIL board 记录。也会关闭无人持有的任务，两种情形：其依赖永不可能到达 `done`（永久残留）；或它已停置十分钟、依赖全部满足、而**没有任何在线 agent** 持有它声明的能力 —— 一行谁也认领不了的任务 |
| `swarm_task_create` | 添加你发现的工作或依赖；会拒绝未知、自指或闭环的依赖 |
| `swarm_goal` | 开一个目标的规划轮：你只选它需要多少个 agent（`agents`），永远不写任务清单 —— 拆分由 worker 自己做 |
| `swarm_propose` | 把你**自己**的拆分发布到一个 open 目标上（打 `proposal` 标签、限定在该目标下），交给 scribe 合并 |
| `swarm_plan` | scribe 的合并：先认领目标的规划任务，然后由它把这一轮去重成真正的任务图、发布 DECISION 并把目标标记为 planned |
| `swarm_scale` | 请求改变池子大小（`agents`、`reason`）—— 仅供建议并留痕；controller 会把它钳制到 `config.workers`，在下一个 tick 应用，并且只会停掉空闲的同伴 |
| `swarm_task_retry` | 复活 `failed`/`blocked` 任务（全新尝试、清空认领），以便其依赖项被提升；当它自身的依赖尚未解决时保持 `blocked` |
| `swarm_integrate` | 创建一个需要 `integrator` 能力的集成任务 |
| `board_post` | FACT / FAIL / OBSERVATION / CLAIM / RESULT / QUESTION / REVIEW / DECISION |
| `board_search` | 按 type/task/agent/tag/keyword 过滤 |
| `swarm_agents` | 同伴名册 |
| `swarm_message` | 直发消息或 `to: "all"` 广播 —— 通过目标的 prompt 路径投递 |
| `swarm_inbox` | 读取（并消费）你的消息 |
| `swarm_review` | 批准 → `done`，或带笔记驳回 → `ready`；拒绝自审 |
| `swarm_reserve` / `swarm_unreserve` | 由租约支撑的文件/目录预留 |
| `swarm_wait` | 阻塞直到出现可认领的工作或一条消息（1–120 秒） |

## 难点是怎么解决的

**原子认领。** `claim()` 依次执行 `BEGIN IMMEDIATE` → 过期陈旧租约 → 校验 `status='ready'`、依赖已完成、能力满足 → `UPDATE … WHERE id=? AND status='ready'` → 检查
`changes === 1`。SQLite 会串行化写事务，所以 N 个 agent 在同一瞬间调用
`claim(task-17)` 时恰好只有一个成功，其余拿到一个原因字符串。这一点用三个真实操作系统进程抢同一个任务验证过（`tests/store.test.ts`）。

**任务图。** 依赖在创建事务内检查（`store.ts:createTask` →
`#assertDependencies`），在任何行被写入之前：未知 id 被拒绝为
`unknown dependency: task-99`，自指边被拒绝为 `dependency_self: task-2 depends on itself`，而会闭环的边被拒绝为
`dependency_cycle: task-2 -> task-1 -> task-2` —— 什么都不插入。`blockedReason()` 会解释任何仍处于 blocked 的行 —— 依赖 id 已不存在时是 `missing: <ids>`，永不可能到达 `done` 的图是 `cycle: <path>`，否则是 `waiting` —— `swarm_status` 会把这个原因打印在任务旁边。`failed` 任务不再是死路：`swarm_task_retry`（`store.ts:retryTask`）把它以全新尝试放回池子并置为 `ready`，随后常规的 `sweep()` 会在它完成时提升其依赖项。镜像的情形是残留：依赖永不可能到达 `done` 的任务（`store.ts:deadDependencies` —— 依赖为 `failed`、缺失或成环）同样永远无法被认领，所以只要没有任何 agent 持有它，`fail()` 也能由非持有者关闭它。一行也可能以另一种方式不可行：依赖全部满足，却没有任何**在线** agent 持有它声明的能力 —— 这类行停置 `UNROUTABLE_GRACE_MS`（10 分钟）之后同样可由 `fail()` 关闭，而只要有在线 agent 还能认领它就会被拒绝。没有删除，也没有归档，所以这两条就是不可认领的行仅有的出口。

**租约 + 心跳。** 每次认领都会写入 `claimed_by`/`lease_until`。任何工具调用以及 driver 的心跳都会续租。清扫器（`sweep()`）在每次认领内部以及每个心跳上运行：租约过期的任务回到 `ready` 并产生一个 `task.reclaim` 事件，由租约支撑的文件预留也随之过期。因此崩溃的 agent 无法卡住池子，而存活的租约永远不会被抢。

**Worker 循环。** 引导之后，每个空闲 worker 只有存在事情可做时才被驱动（有未读消息、持有任务、有匹配其能力的可认领任务，或有一个它可以接的评审）；无事可做时每个 `idleTickSeconds` 催一次。驱动携带的是*事实*，从不是决定 —— 任务选择、拆分、分享和上报都留在 agent 那里，它循环执行
`inbox → board → claim → work → verify → post → complete/ fail → wait`，直到集群停止。

**文件预留。** 模式是路径形状的（`src/auth/**`、`src/parser.ts`）；重叠的请求会被拒绝并给出冲突的持有者。预留随租约过期，所以崩溃不会永久锁住一个文件。

**评审。** 对需要评审的任务调用 `swarm_complete` 会把它移到 `review`；评审槽位受租约保护，作者会被拒绝（`reviewer must not be the author of the change`）；批准会提升依赖项，驳回则把任务带着笔记退回 `ready`。

**事件。** 每一次变更都会追加到 `events` 表*以及* `.swarm/events.jsonl`
（`task.claim`、`task.reclaim`、`review.approve`、`reservation.acquire`、`agent.join` 等）。

## 测试与已记录的运行

```bash
bun run test                   # 389 unit tests in the 18 tracked files under tests/unit (incl. a 3-process claim race, a 3-process scribe race and a browser test)
bun run typecheck              # tsc against the real OMP 18.6.1 host types
bun run swarm:sdk              # live swarm, SDK-driven (headless, no TUI)
bun run swarm:rpc              # live swarm through a real `omp --mode rpc` session + /swarm start
bun run auto:rpc               # multi-agent mode: config says auto, ONE plain task, no /swarm command
bun run rpc:dump -- --command "/swarm status"   # frame-level RPC diagnostics
```

集成运行器会播种一个临时项目，包含五个真实任务（实现一个 parser 及其测试、写 README、审计构建配置并发一条 FAIL、询问同伴状态、集成结果），启动 N 个 worker，并在任务中途杀掉一个 worker 以强制租约恢复，然后对共享数据库和事件日志做断言。`tests/integration/last-run.json` 由**两个**运行器写入（RPC 是 `swarm-run.ts:112`，SDK 是 `sdk-run.ts:138`），所以一次真实的 SDK 运行会覆盖 RPC 运行的报告；磁盘上的 `last-run-sdk.json` 是更早一次运行的陈旧残留。多 agent 模式的报告落在 `last-run-auto.json` / `last-run-auto-ui.json`（`auto-run.ts:260`）。它们全部由运行器在本地生成，且**不被本仓库跟踪**（`.gitignore`：
`tests/integration/last-run*.json`），所以下面引用的路径是产生它们的机器上的本地记录，而不是 clone 里就有的文件。
`auto-run.ts` 会以 `"auto": true` 启动项目并发送一个普通任务 —— 一份关于模式自行组装过程的报告，转录里没有 `/swarm` 命令。

### 在这台机器上验证过（OMP 18.6.1，4 个 worker，评审开启）

`tests/integration/last-run-sdk.json` —— **16/16 checks**（更早一次运行：该路径是上面说的那个陈旧产物，不是今天 `bun run swarm:sdk` 写入的内容）：

| 检查项 | 证据 |
|---|---|
| 4 个 worker 加入 | `SwiftTiger, CalmTiger, BrightTiger, VividTiger` |
| ≥2 个 agent 认领了工作 | 四个都至少认领了一个任务 |
| 没有任务同时被两个 agent 持有 | 6 次成功认领中 0 个重叠的认领窗口 |
| 真实产物 | `src/parser.ts`（16 行）、`src/parser.test.ts`、`README.md` 由 worker 写出 |
| 集群自己写的测试通过 | 临时项目里的 `bun test` → 3 pass, 0 fail |
| 同伴消息 | 4 条直发消息 + 回复 |
| FAIL 已发布 | 构建审计任务报告了确切的 `bun run build` 失败 |
| RESULT / DECISION | 6 条 RESULT；集成者发布了一条 DECISION 验证 parser ↔ README |
| 评审流程 | task-5 → `review` → 同伴 `review.start` + `review.approve` → `done` |
| 崩溃恢复 | 杀掉持有 task-1 的 `VividTiger` → `task.reclaim`（租约过期）→ `BrightTiger` 认领并完成 |
| 关停卫生 | 没有任务留在 claimed，五个任务全部 `done` |

RPC 运行（它的报告是 `last-run.json`，直到下一次 SDK 运行覆盖它）走的是和用户完全相同的代码路径 —— 加载 extension 的 `omp --mode rpc`、经命令处理器派发的 `/swarm start 4` —— 并产生了同样的结果（agent 在宿主进程内加入、认领、完成、FAIL/DECISION、租约回收）。

**修复前的运行，保留作为记录：** `bun run swarm:sdk -- --workers 5 --timeout 600` → **14/16
checks passed**（`tests/integration/last-run.json`，5 个 worker，691 秒；验证者的字面输出，board FACT #25）。红项：`review cycle ran — 0 started, 0
approved` 与 `seeded tasks reached a terminal or review state — task-1:done, task-2:done,
task-3:done, task-4:done, task-5:ready`。原因在两次验证者运行中都可复现，而且**不是** iteration-2 改动带来的回归：harness 的崩溃测试杀掉了第一个工作中的 agent，而播种的 task-5 需要 `requiredCapabilities: ["integrator"]`（`harness.ts:101`）—— 当受害者是唯一的 integrator 持有者时（`harness.ts:54`），那个任务不可认领，运行器永远到不了它的跳出条件，于是在自己的 `--timeout` 上结束，所以那个确实到达 `review` 的任务的评审流程从未开始。

**最新的一次字面运行，诚实记录：** 在 harness 修好之后，`bun run swarm:sdk -- --workers 5 --timeout 600`
→ **16/16 checks passed**（`tests/integration/last-run.json`，5 个 worker，273 秒；写这份文档时验证者自己的运行）。`review cycle ran — 1 started, 1 approved`；`seeded tasks reached a terminal or review state — task-1:done, task-2:done, task-3:done, task-4:done, task-5:done`；`expired lease was reclaimed and the task re-claimed by a peer — 1 lease-expiry reclaim(s) of 1 total`。崩溃测试现在杀的是一个持有任务、但不是未完成工作仍然需要的某个能力的唯一存活持有者的工作中的 agent（`harness.ts:pickCrashVictim`），所以回收检查仍然跑在一次真实认领上，而一次把受能力门控的 ready 工作困住的运行会以 `[stuck]` 行提前结束（`sdk-run.ts:114`），而不是等到超时。

### 验证过多 agent 模式（私有工作流）

`tests/integration/last-run-auto.json`（无头）—— **15/15 checks**，以及
`last-run-auto-ui.json`（`--ui`）—— **16/16 checks**。两次运行都启动一个配置已经写着 `"auto": true` 的项目，派发一个普通任务，完全不发送任何 `/swarm` 命令：

**这两次已记录的运行都早于 swarm 侧规划**：它们是在协调者自己写任务清单的时候录的，也就是今天的 `planning: "coordinator"`。「协调者拆解了任务 —— 在任何 worker 存在之前由 `main` 创建了 4 个任务」这一行是那条路径的记录，按当时的样子保留。本文件里还没有记录过 `"swarm"` 默认模式的端到端运行；该默认模式今天有的是单元测试套件（`unit/planning.test.ts` 覆盖这一轮的规则，`unit/goals.test.ts` 包含那个三进程 scribe 竞态，`unit/goal-tools.test.ts` 覆盖工具层的整轮流程）以及一次真实宿主加载检查（对一个全新根目录从磁盘加载 extension，并创建出 `goals` 表）。等新的默认模式有了真实运行，就会补记在这里。

| 检查项 | 证据 |
|---|---|
| 模式是活的 | 无头：事件轨迹里有 `swarm.auto.idle` + `swarm.auto.planning`；`--ui`：`setStatus MULTI-AGENT ON` + widget 帧 |
| 协调者拆解了任务 | 在任何 worker 存在之前由 `main` 创建了 4 个任务 |
| 组装出一个与集群相称的池子 | `SwiftTiger, CalmTiger, BrightTiger` —— 三个都在池子启动后 1.4 秒内加入 |
| 工作由 worker 执行 | 三个都认领了不同任务；0 个重叠的认领窗口 |
| 真实产物 | `src/parser.ts`、`src/parser.test.ts`、`README.md`；临时项目里的 `bun test` 通过 |
| 集群自己停下 | 池子在 228–349 秒排空，随后每个 worker 都有 `agent.leave`，没有任何操作者命令 |
| 没有东西被重启 | 完成通知之后任务行与 agent 行均无变化 |

UI 那次运行还断言了状态行跟随整个过程：`idle → planning → running → done 4/4`。

手动 TUI 验证（Windows Terminal，`workers: 2`，一个要求三个独立模块的普通任务）：`/swarm on` → `MULTI-AGENT ON · idle` 以及一个 `MULTI-AGENT MODE · idle` 的 widget 表头；任务把状态行推进到 `· planning`，再到 `· 2a r3 c0 v0 d0`，面板显示
`SWARM running · 2 agents`；两个 worker 认领了不同任务；最后一个任务之后会话收到完成通知，面板显示 `SWARM stopped · 0 agents`，状态行回到
`· idle`（模式仍然开启）；`/swarm off` 清掉该行并持久化 `"auto": false`。那个项目里的 `bun test` 退出码为 0。

实时进度 + 完成告警（Windows Terminal，隔离沙箱根，`workers: 2`，
`review: false`，`/swarm start 2`）：

| 帧 | 证据 |
|---|---|
| 运行中 | `██████████░░░░░░░░░░` 压在 `TASKS 2/4 · 2 running · 50%` 之上，两个 worker 都 `working` 在自己的任务上，页脚 `READY 0 CLAIMED 2 REVIEW 0 BLOCKED 0 DONE 2 FAILED 0`，状态行 `swarm 2a r0 c2 v0 d2 · SWARM 2/4 done` |
| 排空 | 一个横幅框 `SWARM DONE · 4/4 tasks (4 done) · 2 agents · 3m39s · $0.01`，每个任务一行（`v task-3 Write out/three.txt (SwiftTiger · 1m)`），同样的摘要替换 widget 里的进度块，标题上状态行 |
| ≥30 秒后 | 完全一致 —— 没有第二条告警，转录里还是那两个批次框，widget 与状态行未变 |
| 输入框 | 每一帧都完好：widget 位于编辑器上方，`╰─` 输入行与状态行在它下面，没有任何东西画穿 |

第二个批次（池子运行时发布的两个任务）在自己的沉降窗口过后发出了它自己的告警，并带有正确的每任务行 —— 这就是同一次运行里的一批次一告警规则与“新任务重新打开边沿”规则。

## 已知限制

- worker 是进程内会话：一个 OMP 进程承载整个集群。跨机器集群不在范围内（存储是本地 SQLite 文件）。
- 每个根一个集群：`.swarm/` 是按工作目录的，driver 也是按根创建的。
- 评审至少需要两个存活 agent（自审被拒绝）。只有一个 worker 时，手工完成评审：`/swarm approve <id>` 或 `/swarm reject <id> <notes>`。
- tick/心跳循环依赖宿主进程存活；存储在重启后仍在，但必须重新执行 `/swarm start`。在多 agent 模式下，配置写着 `auto: true` 的会话会在启动时重新布防模式及其 tick 循环。
- 多 agent 模式依赖协调者遵守注入的策略：一个回合如果没有 `swarm_goal`（模式 `"swarm"`）、也没有任何
  `swarm_task_create` 行（模式 `"coordinator"`），什么都不会启动 —— 它会在 90 秒后催一次，然后回到 `idle` —— 而只有问题、闲聊或解释类请求会按平常方式回答。模式开启时你手工创建的任务会在下一个 tick 启动池子，手工打开的目标也一样。
- 存活的目标算作工作：它让池子不落入停滞通知，并自己决定名册规模，所以一个没人能规划的目标会由这一轮自己的界限来报告（10 分钟后一条 `FAIL`），而不是以 `stalled` 报告。两者的延迟并不相同：如果规划任务在目标仍 open 时就已经被关闭为 `failed`，池子可以在那个界限剩下的时间里看起来毫无动静，之后 `FAIL` 才落地 —— 有报告，但比一次停滞通知要晚。
- 名册增长以 ready 工作为键：每次 ready 计数上升最多一步，绝不超过
  `config.workers`，且只在池子运行且未排空时发生 —— 池子停止或排空后才发布的任务会等下一次 `/swarm start`。因为触发条件是 ready 计数，启动失败的 worker 不会被后续的增长补上：只有新的可认领工作才会让池子增长。触发条件的比较对象是**存活** worker 数（`auto.ts:301`），而不是能力：没有任何存活 worker 能认领的 ready 工作不会自己让池子增长（在修复前的 SDK 运行里可见：1 个只有 `integrator` 能力的 ready 任务对上 4 个存活 worker → 0 个 `roster.grow` 事件；现在 harness 会以 `[stuck]` 行结束这类运行，而不是等超时）。增量本身以 `max(live, planned)` 为基准衡量（`auto.ts:304`）。
- 状态行和 widget 是 extension 的 UI 帧 —— 无头会话（`--no-ui`）按宿主契约不产出；要看它们请用 UI 模式的会话。
- 批次完成告警每批次一条，落在任务计数停止变化后的 `DRAIN_SETTLE_MS`（10 秒），而不是最后一个任务完成的瞬间：池子必须看起来空闲超过一个 tick 的时间，否则一个即将认领下一个任务的 worker 会提前结束批次。一个批次的任务是它开始时的那批加上运行期间创建的任何任务，所以稍后重启的运行不会重复报告已完成的工作。
- 最响的那个界面是 `TERMINAL.sendNotification`，`PI_NOTIFICATIONS=off` 会抑制它，无头终端会丢弃它。常驻标记（widget + 状态行）也只存在于 UI，所以 `--no-ui` 会话只有在多 agent 模式关闭时才会以转录消息的形式拿到摘要。
- `swarm_wait` 会阻塞一个 worker 回合；它不是调度器的替代品。
- 环现在无法进入任务图（`store.ts:createTask` 拒绝未知/自指/成环的依赖），但在那个检查存在之前创建的行仍可能成环：它们会一直 `blocked`，并由 `swarm_status` 报告为 `cycle: <path>`（`store.ts:blockedReason`）—— 没有任何东西会就地修复它们。
- 没有删除，也没有归档：残留以 `failed` 关闭，而只有当某个依赖永不可能到达 `done` 时，`fail()` 才接受一个无人持有的行（`store.ts:deadDependencies`）。依赖只是尚未完成的任务仍然无法关闭，所以这个出口不能被用来跳过工作 —— 而用早于当前代码树的扩展加载的池子仍然完全拒绝这种关闭。

## 扩展到 8 / 16 / 32 个 agent

按它们咬人的先后顺序排列的瓶颈：

1. **单一 SQLite 写者。** WAL 让读者并发，但写者只有一个；`BEGIN IMMEDIATE` 调用会串行化。到几十个 agent 都没问题；再往上就分片认领热点（按区域的任务表）或加一个认领队列。
2. **一个宿主进程。** 所有 worker 会话共享该进程：模型流、工具执行和清扫器竞争同一个事件循环。超过约 16 个之前，先把 agent 分片到多个进程/CLI（每个进程针对同一个 DB 跑自己的 driver）。
3. **Tick 扇出。** 每个间隔的 tick 循环是 O(agents)；32 个 agent 时 3 秒的 tick 仍有富余，但每个 worker 的 `swarm_wait` 会成为更便宜的空闲路径。
4. **Git worktree。** 每个 agent 一个 worktree，按仓库算便宜，按索引算昂贵；一台机器上 32 个并发检出时，宁可用几个分片仓库，而不是 32 个 worktree。
5. **两个 agent 改同一个文件** 靠文件预留解决，而不是靠运气 —— 但预留对 LLM 是劝告性的，所以在角色配置里按文件区域给并行度设上限，而不是指望它。

## 许可证

MIT —— Copyright (c) 2026 Espboxx。见 [LICENSE](LICENSE)。
