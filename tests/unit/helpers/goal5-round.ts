/**
 * Live planning rounds, verbatim: the board proposals the goal-6 operator caught, copied out of
 * .swarm/swarm.db unchanged - titles, descriptions and file lists included. They are FIXTURES, not
 * prose. Trimming them would test nothing: the hardest pairs (a terse Chinese title against a long
 * English one, a directory against the file it holds, a fix against a verification phrased in
 * Chinese) are decided by exactly this text.
 *
 * GOAL5_ENTRIES: the 5 entries whose 3 distinct splits created the 20 task rows (149-168).
 * GOAL3_ENTRIES: the 2 entries behind the false merge the merge rule must refuse - a fix that
 * swallowed a verification of a different artifact.
 */
export interface RoundTask {
	title: string;
	deliverable: string;
	files: string[];
	depends_on: string[];
}

export interface RoundEntry {
	id: number;
	agentId: string;
	tasks: RoundTask[];
}

export const GOAL5_ENTRIES: RoundEntry[] = [
	{
		"id": 552,
		"agentId": "RapidTiger",
		"tasks": [
			{
				"title": "Measure and publish the idle burn rate (transcripts x claimed tasks)",
				"deliverable": "scratch/advisory-burnrate/BURN_RATE.md + the raw measurement script and its raw output: a table of agent x holds-claimed-task x record counts in the last 30min/15min x last-write timestamp, derived reproducibly from .swarm/sessions/<agent>/*.jsonl joined with the tasks table; record counts explicitly labelled as a proxy, with token-cost estimates marked ESTIMATE vs MEASURED.",
				"files": [
					"scratch/advisory-burnrate/**"
				],
				"depends_on": []
			},
			{
				"title": "Enumerate every model-call wakeup source (not just driver.ts:651-652)",
				"deliverable": "scratch/advisory-wakeups/WAKEUP_SOURCES.md: one row per wakeup source (driver continuation/idle prompt, swarm_wait timeout return, auto.ts tick/idleTick, heartbeat, board/message delivery, pool grow/shrink/reconcile, review polling, ...) with file:line, trigger condition, and whether it fires a model call when the agent has NO claimable work AND pool state is unchanged; plus a written handoff to the task-145/146 holders stating whether the edit in flight covers the only leak, and if not, TODO + minimal patch suggestion (no code committed).",
				"files": [
					"scratch/advisory-wakeups/**"
				],
				"depends_on": []
			},
			{
				"title": "Ship an operator brake that works before the code fix lands",
				"deliverable": "scratch/advisory-brake/BRAKE.md: tested knobs (.swarm/config.json idleTickSeconds/leaseSeconds/heartbeatSeconds, swarm_wait timeout cap, parking an idle agent without stopping the pool) with what to set, measured before/after 30-min record counts, and side effects (new-task discovery latency, lease reaping); if no config-level mitigation exists, say so plainly with the evidence and a one-line operational recommendation instead of inventing a knob.",
				"files": [
					"scratch/advisory-brake/**"
				],
				"depends_on": []
			},
			{
				"title": "Diagnose the observability defect: /swarm status shows 0 online",
				"deliverable": "scratch/advisory-observability/OFFLINE_BUG.md: file:line evidence and the exact decision rule (suspected: markStaleAgentsOffline marks a busy worker that has not called a tool within 60s as offline) explaining why 4 agents writing transcripts still read as 0 online; no code change, go into the handoff.",
				"files": [
					"scratch/advisory-observability/**"
				],
				"depends_on": []
			},
			{
				"title": "Consolidate the four advisories into one operator-facing handoff",
				"deliverable": "scratch/advisory-handoff/HANDOFF.md: a single index the operator can act on now (what burns, what to turn off, what is broken observability-wise, what is already being fixed by task-145/146), linking the four evidence docs; depends on all four.",
				"files": [
					"scratch/advisory-handoff/**"
				],
				"depends_on": [
					"Measure and publish the idle burn rate (transcripts x claimed tasks)",
					"Enumerate every model-call wakeup source (not just driver.ts:651-652)",
					"Ship an operator brake that works before the code fix lands",
					"Diagnose the observability defect: /swarm status shows 0 online"
				]
			}
		]
	},
	{
		"id": 553,
		"agentId": "VividTiger",
		"tasks": [
			{
				"title": "量化烧钱速率：转录记录数 × 是否持有 claimed 任务（只读实测）",
				"deliverable": "scratch/advisory-burnrate/BURN_RATE.md — agent × 有无 claimed 任务 × 30min/15min 记录数 × 最近写入时间 的表，附可复现命令与原始输出；明确区分实测与估算（记录数≠token）",
				"files": [
					"scratch/advisory-burnrate/**"
				],
				"depends_on": []
			},
			{
				"title": "列全所有能产生模型调用的唤醒源（file:line + 无变化是否唤醒）",
				"deliverable": "scratch/advisory-wakeups/WAKEUP_SOURCES.md — 每个唤醒源的 file:line、触发条件、『agent 无可认领工作且池子状态未变化时是否产生模型调用』判定，附原始证据；另含 scratch/advisory-wakeups/HANDOFF.md 给 task-145/146 持有者的书面交接（是否唯一漏点 + 其余漏点的最小补丁建议，不提交代码）",
				"files": [
					"scratch/advisory-wakeups/**"
				],
				"depends_on": []
			},
			{
				"title": "落地前可用的『刹车』：配置档实测量化 + 副作用 + 操作建议",
				"deliverable": "scratch/advisory-brake/BRAKE.md — idleTickSeconds/leaseSeconds/heartbeatSeconds 等键的实测前后 30 分钟记录数对比、改哪个键改成什么、副作用（延迟发现新任务 / 租约回收）；若配置层无法缓解则如实写明并给一句话操作建议",
				"files": [
					"scratch/advisory-brake/**"
				],
				"depends_on": []
			},
			{
				"title": "可观测性缺陷：/swarm status 显示 0 online 的 file:line 证据与判定规则",
				"deliverable": "scratch/advisory-status/OBSERVABILITY.md — markStaleAgentsOffline（或等价实现）的 file:line、判定规则、为何忙碌 worker 被标离线，附原始证据",
				"files": [
					"scratch/advisory-status/**"
				],
				"depends_on": []
			}
		]
	},
	{
		"id": 554,
		"agentId": "SwiftTiger",
		"tasks": [
			{
				"title": "只读测量：空转烧钱速率表（agent × 有无 claimed 任务 × 30min/15min 记录数 × 最近写入）",
				"deliverable": "Watch 只读测量，产出 omp-swarm/scratch/advisory-burn/rate-table.md 并在黑板发 FACT：用可复现命令（不得照抄 goal 文本里的数字，自己复测）统计 .swarm/sessions/<agent>/*.jsonl 在滑动 30min/15min 窗口内的记录数与角色分布，并用 tasks 表说明该 agent 当时是否持有 claimed 任务；表头 agent × has-claimed-task × 30min × 15min × last-write-time。必须区分「记录数」与「真实 token 花费」（后者只能估算，标注为估算并给出换算口径）。不改 extension/**、web/**、README；只写 scratch/advisory-burn/ 与黑板。",
				"files": [
					"omp-swarm/scratch/advisory-burn/rate-table.md"
				],
				"depends_on": []
			},
			{
				"title": "只读审计：全部模型调用唤醒源清单 + markStaleAgentsOffline 证据 + 给 task-145/146 的书面交接",
				"deliverable": "只读审计，产出 omp-swarm/scratch/advisory-burn/wake-sources.md 并在黑板发 FACT：逐一定位 driver 的 continuation/空闲提示、swarm_wait 超时返回、auto.ts 的 tick/idleTick、心跳、board/message 投递、pool 的 grow/shrink/reconcile、review 轮询等唤醒源，每条给 file:line、触发条件、以及「该 agent 无可认领工作且池子状态未变化时会不会产生一次模型调用」的判定与证据，形成「唤醒源 → 是否无变化也唤醒 → 证据」表；另附 observability 缺陷证据（markStaleAgentsOffline 的 file:line 与判定规则，解释为何 4 个 agent 写转录却显示 0 online），并写明给 task-145/task-146 持有者的交接：他们改的是不是唯一漏点、还有哪些漏点以及最小补丁建议。不许自己提交代码。",
				"files": [
					"omp-swarm/scratch/advisory-burn/wake-sources.md"
				],
				"depends_on": []
			},
			{
				"title": "实测刹车：修复落地前可用的配置层/Pool 层缓解，含前后 30 分钟记录数对比",
				"deliverable": "实测，产出 omp-swarm/scratch/advisory-burn/brake.md 并在黑板发 RESULT：研究并实测修复落地前操作者就能用的刹车（.swarm/config.json 的 idleTickSeconds/leaseSeconds/heartbeatSeconds/auto/workers 等键——先验证这些键在当前版本是否真的被读取，不许假设、不许编造旋钮；swarm_wait 超时上限；不停整池前提下停放空闲 agent 的办法）。给出改哪个键、改成什么、实测前后 30 分钟记录数对比、副作用（是否延迟发现新任务、是否影响租约回收）。若结论是配置层无法缓解、只能靠代码修复或 /swarm stop，必须如实写出并给一句话操作建议。若需要重启/改运行时状态，先确认不破坏正在跑的 task-145。不改 extension/**、web/**、README。",
				"files": [
					"omp-swarm/scratch/advisory-burn/brake.md"
				],
				"depends_on": []
			}
		]
	},
	{
		"id": 555,
		"agentId": "BrightTiger",
		"tasks": [
			{
				"title": "Quantify the idle burn rate (read-only measurement)",
				"deliverable": "scratch/advisory-burnrate/BURN_RATE.md + the raw measurement script and its raw output: a table of agent x holds-claimed-task x record counts in the last 30min/15min x last-write time, derived reproducibly from .swarm/sessions/<agent>/*.jsonl joined with the tasks table; record counts labelled as a PROXY, token-cost as ESTIMATE vs MEASURED separately.",
				"files": [
					"scratch/advisory-burnrate/**"
				],
				"depends_on": []
			},
			{
				"title": "Enumerate every wakeup source that can produce a model call",
				"deliverable": "scratch/advisory-wakeups/WAKEUP_SOURCES.md: one row per wakeup source (driver continuation/idle prompt, swarm_wait timeout, auto.ts tick/idleTick, heartbeat, board/message delivery, pool grow/shrink/reconcile, review polling) with file:line, trigger condition, and whether it fires a model call when the agent has NO claimable work AND pool state is unchanged; plus HANDOFF.md to the task-145/146 holders (is the in-flight edit the only leak; else TODO + minimal patch suggestion, no code committed).",
				"files": [
					"scratch/advisory-wakeups/**"
				],
				"depends_on": []
			},
			{
				"title": "Operator brake usable before the code fix lands",
				"deliverable": "scratch/advisory-brake/BRAKE.md: tested knobs (.swarm/config.json, swarm_wait timeout cap, parking an idle agent without stopping the pool) with exact key/value, measured before/after 30-min record counts and side effects (new-task discovery latency, lease reaping); if no config-level mitigation exists, say so with evidence + a one-line operational recommendation, never invent a knob.",
				"files": [
					"scratch/advisory-brake/**"
				],
				"depends_on": [
					"Quantify the idle burn rate (read-only measurement)"
				]
			},
			{
				"title": "Observability: /swarm status shows 0 online while 4 agents write transcripts",
				"deliverable": "scratch/advisory-status/OBSERVABILITY.md: file:line evidence and the exact decision rule (markStaleAgentsOffline suspect) explaining why a busy worker that has not called a tool within the staleness window reads as offline; no code change.",
				"files": [
					"scratch/advisory-status/**"
				],
				"depends_on": []
			},
			{
				"title": "Consolidate the advisories into one operator-facing handoff",
				"deliverable": "scratch/advisory-handoff/HANDOFF.md: single index the operator can act on now (what burns, what to turn off, what is observability-broken, what task-145/146 already fix), linking the four evidence docs.",
				"files": [
					"scratch/advisory-handoff/**"
				],
				"depends_on": [
					"Quantify the idle burn rate (read-only measurement)",
					"Enumerate every wakeup source that can produce a model call",
					"Operator brake usable before the code fix lands",
					"Observability: /swarm status shows 0 online while 4 agents write transcripts"
				]
			}
		]
	},
	{
		"id": 556,
		"agentId": "LunarTiger",
		"tasks": [
			{
				"title": "量化空转烧钱速率:转录记录数 x 任务持有状态(只读,可复现)",
				"deliverable": "scratch/advisory-burn/BURN.md + 黑板 FACT:一段可复现的计数命令/脚本(读 .swarm/sessions/<agent>/*.jsonl 按时间窗计数 + 角色分布),表格式给出 agent x 是否持有 claimed 任务(join tasks.claimed_by) x 近30min/15min 记录数 x 最近一次写入时间;显式标注「记录数 != token 实测」的换算局限,估算与实测分开。只读:不改 extension/**、web/**、README。",
				"files": [
					"scratch/advisory-burn/"
				],
				"depends_on": []
			},
			{
				"title": "唤醒源普查:会触发模型调用的每条路径 file:line + 无变化是否唤醒(只读)",
				"deliverable": "scratch/advisory-wake/WAKES.md + 黑板 FACT:表「唤醒源 -> file:line -> 触发条件 -> 该 agent 无任何可认领工作且池子状态未变化时是否产生一次模型调用 -> 证据」,覆盖 driver continuation/idle 分支(driver.ts:522-540)、心跳(driver.ts:263,505-506)、auto.ts tick/idleTick、board/message 投递、pool grow/shrink/reconcile、review 轮询、swarm_wait 超时返回;另附给 task-145/task-146 持有者的书面交接(他们改的是不是唯一漏点;其余漏点的最小补丁建议,不提交代码)。",
				"files": [
					"scratch/advisory-wake/"
				],
				"depends_on": []
			},
			{
				"title": "可观测性缺陷:/swarm status 显示 0 online 的判定规则与 file:line 证据(只读)",
				"deliverable": "scratch/advisory-status/STATUS.md + 黑板 FACT:markStaleAgentsOffline 的判定规则与 file:line 证据(store.ts:447-450 判定、store.ts:1434-1435 快照调用点、offlineAfterSeconds 默认 60s 见 types.ts:204-211),说明为何 4 个正在写转录的 worker 会被标成 offline、以及复现命令与最小修法建议(不改代码)。",
				"files": [
					"scratch/advisory-status/"
				],
				"depends_on": []
			},
			{
				"title": "落地前刹车:配置档实测与一键还原(idleTickSeconds/leaseSeconds/workers)",
				"deliverable": "scratch/advisory-brake/BRAKE.md + 黑板 FACT:改哪个键、改成什么、实测前后 30 分钟记录数对比(复用 A 的计数方法)、副作用(是否延迟发现新任务、是否影响租约回收、缩小 workers 是否只停空闲 peer);给出可一键还原的备份步骤;若结论是配置层无法缓解则如实写出并给一句操作建议。改动 .swarm/config.json 前必须备份并记录原始内容。",
				"files": [
					"scratch/advisory-brake/",
					".swarm/config.json"
				],
				"depends_on": [
					"量化空转烧钱速率:转录记录数 x 任务持有状态(只读,可复现)"
				]
			},
			{
				"title": "独立核验 goal-5 四份咨询:命令可复现 + 引文准确",
				"deliverable": "黑板 REVIEW + scratch/advisory-verify/VERDICT.md:逐条重跑 A-D 的事实命令、抽查 file:line 引文与表格数字,给出 PASS/FAIL 及反例;不由被核验任务的作者自证。",
				"files": [
					"scratch/advisory-verify/"
				],
				"depends_on": [
					"量化空转烧钱速率:转录记录数 x 任务持有状态(只读,可复现)",
					"唤醒源普查:会触发模型调用的每条路径 file:line + 无变化是否唤醒(只读)",
					"可观测性缺陷:/swarm status 显示 0 online 的判定规则与 file:line 证据(只读)",
					"落地前刹车:配置档实测与一键还原(idleTickSeconds/leaseSeconds/workers)"
				]
			}
		]
	}
];

export const GOAL3_ENTRIES: RoundEntry[] = [
	{
		"id": 499,
		"agentId": "CalmTiger",
		"tasks": [
			{
				"title": "修复 settings.get 不是函数 运行时错误",
				"deliverable": "在 omp 代码库中定位并修复 `提供商配置失败: settings.get is not a function` 运行时错误：定位 settings/provider 相关调用点，改为安全的 settings 访问接口，并补充回归测试。产物：修改后的源码文件列表 + 失败复现/验证记录。",
				"files": [
					"src/**"
				],
				"depends_on": []
			},
			{
				"title": "验证修复：构建/测试/类型检查",
				"deliverable": "对修复做静态/类型验证：跑构建、类型检查与现有测试，确认没有引入回归；输出验证报告（命令 + 结果）。",
				"files": [
					"package.json",
					"tsconfig.json",
					"tests/**"
				],
				"depends_on": []
			}
		]
	},
	{
		"id": 511,
		"agentId": "BrightTiger",
		"tasks": [
			{
				"title": "审计：定位全部 settings 读取点并确认真实类型/来源",
				"deliverable": "board FACT entry: full list of every settings call site in the crash path (index.ts plus lib/store.ts and any other reader of compaction.thresholdPercent / provider config load), quoting the real type and source of the object (Settings class instance, array, or plain object) with file:line evidence, so the fix targets the root cause, not the call sites. READ-ONLY: no code edits, no tracked file touched.",
				"files": [],
				"depends_on": []
			},
			{
				"title": "侦察：确认可修源码位置（已由 task-130 完成，仅保留证据）",
				"deliverable": "board FACT/FAIL entry with absolute-path evidence for WHERE fixable source lives: source checkout under ~/.omp/** (already confirmed: C:/Users/93715/.omp/agent/extensions/provider-config/index.ts), operator code dirs, or plugin node_modules; omp.exe is a compiled 235MB binary. READ-ONLY. (Already delivered by task-130 in goal-2's split — proposing it here only so goal-3 has the same evidence in its own graph.)",
				"files": [],
				"depends_on": []
			},
			{
				"title": "修复：在根因处统一修正 settings 的访问方式",
				"deliverable": "The crash path fixed at its root with one minimal commit — no per-call-site patch, no new dependency, existing setting keys and behaviour semantics preserved; the crash point is eliminated at the source (registry handle + real settings scope), not by suppressing the error message.",
				"files": [
					"omp-swarm/extension/**",
					"C:/Users/93715/.omp/agent/extensions/provider-config/index.ts"
				],
				"depends_on": [
					"审计：定位全部 settings 读取点并确认真实类型/来源"
				]
			},
			{
				"title": "验证：受影响路径跑通且无回归",
				"deliverable": "Verification report: the affected path (config load / provider init) genuinely exercised — real command or minimal repro showing `settings.get is not a function` gone — plus `cd tests/unit && bun test` full tail, `git status --short`, `git log --oneline -1`, `git ls-remote origin master` == HEAD. Report the numbers measured, never pasted.",
				"files": [
					"omp-swarm/tests/**"
				],
				"depends_on": [
					"修复：在根因处统一修正 settings 的访问方式"
				]
			},
			{
				"title": "卫生：关闭本轮中已被先前交付取代的任务行",
				"deliverable": "Pool of unmodified store/state hygiene for this round: any row whose deliverable is already done (by an earlier goal's task or by a live process) is closed with swarm_fail carrying the superseded reason, and the board records which prior task delivered it. No work re-executed.",
				"files": [],
				"depends_on": []
			}
		]
	}
];
