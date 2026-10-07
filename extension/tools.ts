import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type * as zod from "@oh-my-pi/omptype/zod";
import { renderAgents, renderBoard, renderInbox, renderTaskDetail, renderTasks } from "./render";
import { poolFloor } from "./scaling";
import { patternsConflict, type SwarmStore } from "./store";
import type { BoardType, DecisionKind, SwarmConfig, SwarmMessage, SwarmTask, SwarmVote, TaskStatus } from "./types";
import { resolveVotingConfig, type VoteOutcome, type VotingConfig } from "./voting";

export interface SwarmIdentity {
	id: string;
	role: string;
	capabilities: string[];
	worktree?: string;
	isMain: boolean;
}

export interface SwarmToolDeps {
	store: SwarmStore;
	config: SwarmConfig;
	identity: SwarmIdentity;
	/** omptype Zod-compatible builder (`pi.zod`). */
	z: typeof zod;
	/** Wake a peer session with a message; the driver delivers it by prompting that session. */
	wake?: (to: string, text: string, urgent: boolean) => void;
	/** Notified after ownership-changing calls so the driver can refresh its panel. */
	onChange?: () => void;
	/**
	 * `swarm_wait`'s clock. Injected so a test can drive the wait window without a wall-clock sleep —
	 * the tool blocks by looping, and a fake clock turns that loop into a deterministic no-op. Left out
	 * in production, where `Date.now`/`Bun.sleep` are used (`driver.ts` injects `timers` the same way).
	 */
	clock?: WaitClock;
}

/** The two time primitives the wait tool needs, as one seam. */
export interface WaitClock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

type ZodBuilder = typeof zod;

function ok(text: string, details: Record<string, unknown> = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

/** Same shape as `ok`, but flagged so the model sees a refused call, not a success. */
function err(text: string, details: Record<string, unknown> = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details, isError: true };
}

const BOARD_TYPES: Record<BoardType, true> = {
	FACT: true,
	FAIL: true,
	OBSERVATION: true,
	CLAIM: true,
	RESULT: true,
	QUESTION: true,
	REVIEW: true,
	DECISION: true,
};

const TASK_STATUSES: Record<TaskStatus, true> = {
	ready: true,
	claimed: true,
	blocked: true,
	review: true,
	done: true,
	failed: true,
};

export function isBoardType(value: string): value is BoardType {
	return value in BOARD_TYPES;
}

export function isTaskStatus(value: string): value is TaskStatus {
	return value in TASK_STATUSES;
}

/**
 * Tools shared by the main session and every worker session.
 * The identity is fixed per toolkit, so a worker can only ever act as itself.
 */
export function buildSwarmTools(deps: SwarmToolDeps): CustomTool[] {
	const { store, config, identity, z, wake, onChange } = deps;
	const clock: WaitClock = deps.clock ?? { now: Date.now, sleep: (ms) => Bun.sleep(ms) };

	// Every tool call proves the agent is alive and keeps its leases warm.
	const touch = (status?: "idle" | "working" | "reviewing") => {
		store.heartbeat(identity.id, status, undefined, config.leaseSeconds);
	};

	/**
	 * Release ONLY the reservations the task being closed registered. A lifecycle tool must never drop
	 * holds the caller still needs elsewhere: the blanket `releaseReservations(identity.id)` this
	 * replaces deleted every pattern the agent owned, so `swarm_renew` — the tool whose whole purpose is
	 * to keep a hold alive while you work — eviscerated the file lock it was meant to protect, and
	 * finishing one task also released another task's files (FAIL #602). Matching on the stored
	 * `taskId` (rather than on the task's declared files) keeps this exact: the reservation rows carry
	 * the patterns that were actually registered, so no normalization has to agree.
	 */
	const releaseTaskReservations = (taskId: string) => {
		const mine = store.listReservations().filter((row) => row.owner === identity.id && row.taskId === taskId);
		if (mine.length > 0) store.releaseReservations(identity.id, mine.map((row) => row.pattern));
	};

	/**
	 * The ready rows THIS agent can actually take: capability-matching, and not blocked by a live file
	 * reservation another agent holds. The claim path reserves a task's declared files and refuses on a
	 * conflict, so a row whose files someone else holds is not work — reporting it as available spent a
	 * full model turn on an attempt that could only fail (FAIL #648). Read-only: the wait never acquires
	 * anything. `swarm_tasks` deliberately still lists the whole pool; only the wake decision narrows here.
	 */
	const claimable = () => {
		const now = Date.now();
		const held = store.listReservations().filter((row) => row.owner !== identity.id && row.leaseUntil > now);
		return store
			.listTasks({ status: "ready", limit: 100 })
			.filter((t) => t.requiredCapabilities.length === 0 || t.requiredCapabilities.some((cap) => identity.capabilities.includes(cap)))
			.filter((t) => t.files.length === 0 || !held.some((row) => t.files.some((file) => patternsConflict(file, row.pattern))));
	};

	const statusSchema = z.object({});
	const statusTool: CustomTool<typeof statusSchema> = {
		name: "swarm_status",
		label: "Swarm Status",
		description: "Show the swarm: agents, online/idle/working counts, task counts, blocked and claimed work.",
		parameters: statusSchema,
		approval: "read",
		async execute() {
			touch();
			const snapshot = store.snapshot(config.offlineAfterSeconds, true);
			const blocked = store.listTasks({ status: "blocked", limit: 20 });
			const lines = [
				`agents: ${snapshot.agents.length} total, ${snapshot.agents.filter((a) => a.status !== "offline").length} online, ${snapshot.agents.filter((a) => a.status === "working").length} working, ${snapshot.agents.filter((a) => a.status === "idle").length} idle`,
				`tasks: ready ${snapshot.counts.ready}, claimed ${snapshot.counts.claimed}, review ${snapshot.counts.review}, blocked ${snapshot.counts.blocked}, done ${snapshot.counts.done}, failed ${snapshot.counts.failed}`,
				`board: ${Object.entries(snapshot.board).map(([k, v]) => `${k} ${v}`).join(", ") || "empty"}`,
			];
			if (blocked.length > 0) {
				lines.push(
					`blocked: ${blocked
						.map((t) => `${t.id}<-${t.dependencies.join("+")} (${store.blockedReason(t.id) ?? "unknown"})`)
						.join(", ")}`,
				);
			}
			const goals = store.liveGoals();
			if (goals.length > 0) {
				lines.push(
					`goal(s): ${goals
						.map((goal) => {
							const text = goal.goal.length > 160 ? `${goal.goal.slice(0, 157)}...` : goal.goal;
							return `${goal.id} open (${goal.agents} agents, planning task ${goal.planningTask}, ${store.listProposals(goal).length} proposal(s)) "${text}"`;
						})
						.join("; ")}`,
				);
			}
			const asks = store.pendingScaleRequests();
			if (asks.length > 0) {
				lines.push(`scale ask(s) pending: ${asks.map((ask) => `${ask.agentId} -> ${ask.requested} agent(s) ("${ask.reason}")`).join("; ")}`);
			}
			return ok(lines.join("\n"), { counts: snapshot.counts, agents: snapshot.agents.length, goals: goals.length });
		},
	};

	const tasksSchema = z.object({
		status: z.string().optional(),
		capability: z.string().optional(),
		mine: z.boolean().optional(),
		limit: z.number().optional(),
	});
	const tasksTool: CustomTool<typeof tasksSchema> = {
		name: "swarm_tasks",
		label: "Swarm Tasks",
		description: "List tasks in the shared pool. Filter by status (ready|claimed|blocked|review|done|failed), capability, or mine=true.",
		parameters: tasksSchema,
		approval: "read",
		async execute(_id, params) {
			touch();
			let status: TaskStatus | undefined;
			if (params.status !== undefined) {
				if (!isTaskStatus(params.status)) return ok(`unknown status ${params.status}`);
				status = params.status;
			}
			const tasks = store.listTasks({
				status,
				capability: params.capability,
				agent: params.mine ? identity.id : undefined,
				limit: params.limit ?? 40,
			});
			return ok(renderTasks(tasks, Date.now()), { count: tasks.length });
		},
	};

	const claimSchema = z.object({ task_id: z.string(), files: z.array(z.string()).optional() });
	const claimTool: CustomTool<typeof claimSchema> = {
		name: "swarm_claim",
		label: "Claim Task",
		description:
			"Atomically claim a ready task from the shared pool. Fails if another agent won the race, if dependencies are unfinished, or if you lack a required capability. Reserves the files the task declares, plus any extra files you pass.",
		parameters: claimSchema,
		approval: "write",
		async execute(_id, params) {
			touch();
			// A task's declared files are the ownership contract of the pool: reserve them
			// even when the caller names none, so two tasks that overlap cannot be claimed
			// side by side.
			const declared = store.getTask(params.task_id)?.files ?? [];
			const reserved = [...new Set([...(params.files ?? []), ...declared])];
			if (reserved.length > 0) {
				const reservation = store.acquireReservations(identity.id, reserved, config.leaseSeconds * 2, params.task_id);
				if (!reservation.ok) return ok(`claim aborted, file conflict:\n${reservation.conflicts.join("\n")}`, { conflict: true });
			}
			const result = store.claim(params.task_id, identity.id, config.leaseSeconds, identity.capabilities);
			onChange?.();
			if (!result.ok) {
				if (reserved.length > 0) store.releaseReservations(identity.id, reserved);
				return ok(`claim failed: ${result.reason}`, { claimed: false });
			}
			return ok(`claimed ${params.task_id}\n\n${renderTaskDetail(result.task!)}`, { claimed: true, task: result.task });
		},
	};

	const renewSchema = z.object({ task_id: z.string().optional() });
	const renewTool: CustomTool<typeof renewSchema> = {
		name: "swarm_renew",
		label: "Renew Lease",
		description: "Extend the lease on a task you hold (or all tasks you hold) so no other agent can reclaim it while you work.",
		parameters: renewSchema,
		approval: "write",
		async execute(_id, params) {
			touch();
			const held = store.listTasks({ status: "claimed", agent: identity.id, limit: 50 });
			const targets = params.task_id ? held.filter((t) => t.id === params.task_id) : held;
			if (targets.length === 0) return ok("no held tasks to renew");
			const renewed = targets.filter((t) => store.renew(t.id, identity.id, config.leaseSeconds)).map((t) => t.id);
			// A lease extension is not an ownership change, so renewing must not release anything: this
			// call used to be a blanket wipe, which made "renew while you work" drop the file lock you
			// were renewing for.
			return ok(`renewed: ${renewed.join(", ") || "none"}`, { renewed });
		},
	};

	const releaseSchema = z.object({ task_id: z.string(), reason: z.string().optional() });
	const releaseTool: CustomTool<typeof releaseSchema> = {
		name: "swarm_release",
		label: "Release Task",
		description: "Give a task back to the pool when you cannot finish it (unknown area, blocked by another change, too large). Releasing beats stalling.",
		parameters: releaseSchema,
		approval: "write",
		async execute(_id, params) {
			touch();
			const released = store.release(params.task_id, identity.id, params.reason ?? "released");
			releaseTaskReservations(params.task_id);
			onChange?.();
			if (!released) return ok(`nothing released: ${params.task_id} is not claimed by you`);
			if (params.reason) store.postBoard({ type: "OBSERVATION", agentId: identity.id, taskId: params.task_id, content: `released: ${params.reason}` });
			return ok(`released ${params.task_id}`, { released: true });
		},
	};

	const completeSchema = z.object({
		task_id: z.string(),
		summary: z.string(),
		commit: z.string().optional(),
		files: z.array(z.string()).optional(),
	});
	const completeTool: CustomTool<typeof completeSchema> = {
		name: "swarm_complete",
		label: "Complete Task",
		description:
			"Finish your task: verify the result first, then report a summary (and commit/files when relevant). Review-required work moves to review instead of done.",
		parameters: completeSchema,
		approval: "write",
		async execute(_id, params) {
			touch();
			const result = store.complete(params.task_id, identity.id, {
				summary: params.summary,
				commit: params.commit,
				files: params.files,
				reviewEnabled: config.review,
			});
			onChange?.();
			if (!result.ok) return ok(`complete failed: ${result.reason}`);
			store.postBoard({
				type: "RESULT",
				agentId: identity.id,
				taskId: params.task_id,
				content: params.summary,
				files: params.files,
				tags: ["result"],
			});
			releaseTaskReservations(params.task_id);
			const state = result.task?.status ?? "done";
			return ok(`${params.task_id} -> ${state}${state === "review" ? " (a peer must review before it counts as done)" : ""}`, {
				status: state,
			});
		},
	};

	const failSchema = z.object({ task_id: z.string(), reason: z.string(), vote_id: z.string().optional() });
	const failTool: CustomTool<typeof failSchema> = {
		name: "swarm_fail",
		label: "Fail Task",
		description:
			"Mark your task failed with the reason. A FAIL entry is posted to the blackboard automatically so peers never repeat the dead end. Closing a task you do NOT hold is a CLUSTER-LEVEL decision: when the swarm has voting on it needs a passed `close-task` round (`vote_id`), because two cases exist and both close someone else's row, since the pool has no delete or archive: (1) a dependency of it can never reach done (a `failed`/missing/cyclic dependency) — permanently-blocked residue; (2) it is `ready` or `blocked` with every dependency satisfied but NO online agent holds the capabilities it declares, and it has sat that way for at least ten minutes — a row nothing could claim would otherwise keep the batch from ever draining. A row any online agent could still claim is refused exactly as before.",
		parameters: failSchema,
		approval: "write",
		async execute(_id, params) {
			touch();
			const target = store.getTask(params.task_id);
			// The unroutable close needs the window the config owns; the store never reads policy itself.
			const close = () =>
				store.fail(params.task_id, identity.id, params.reason, { offlineAfterMs: config.offlineAfterSeconds * 1000 });
			// Failing your OWN row is not a cluster-level decision; closing someone else's is, and the ticket
			// must name the row it closes — one pass used to be able to close several other agents' rows.
			const gated =
				target !== undefined && target.claimedBy !== identity.id
					? voteGate("close-task", params.vote_id, { task_id: params.task_id }, close)
					: { ok: true as const, value: close() };
			if (!gated.ok) return err(gated.reason, { failed: false, gated: true });
			const result = gated.value;
			onChange?.();
			if (!result.ok) return ok(`fail rejected: ${result.reason}`);
			releaseTaskReservations(params.task_id);
			return ok(`${params.task_id} -> failed; FAIL posted to the board`, { failed: true });
		},
	};

	const createSchema = z.object({
		title: z.string(),
		description: z.string().optional(),
		priority: z.number().optional(),
		dependencies: z.array(z.string()).optional(),
		required_capabilities: z.array(z.string()).optional(),
		files: z.array(z.string()).optional(),
		review_required: z.boolean().optional(),
		vote_id: z.string().optional(),
	});
	const createTool: CustomTool<typeof createSchema> = {
		name: "swarm_task_create",
		label: "Create Task",
		description:
			"Add work to the shared pool. Use it to split an oversized task, or to record a dependency you discovered. Tasks with unfinished dependencies start blocked. Creating a task is a CLUSTER-LEVEL decision: when the swarm has voting on, a regular agent must pass a vote first (swarm_vote with kind `create-task`, whose payload_json carries the task's fields — the round creates the task ITSELF when it passes and is then spent, so re-issuing this call with that vote_id is refused: a passed round is one decision, one action). The coordinator's own goal round and an operator instruction are seeds and never vote.",
		parameters: createSchema,
		approval: "write",
		async execute(_id, params) {
			touch();
			// The fields the round froze ARE the decision: they travel in CreateTaskInput's own shape, so the
			// ticket can only ever authorise the task that was actually voted on (goal-9's payload binding).
			const fields = {
				title: params.title,
				description: params.description,
				priority: params.priority,
				dependencies: params.dependencies,
				requiredCapabilities: params.required_capabilities,
				files: params.files,
				reviewRequired: params.review_required,
			};
			let task: SwarmTask;
			try {
				const gated = voteGate("create-task", params.vote_id, fields, () => store.createTask({ ...fields, createdBy: identity.id }));
				if (!gated.ok) return err(gated.reason, { created: false, gated: true });
				task = gated.value;
			} catch (error) {
				// A rejected dependency graph is a tool error, never a blocked row.
				return err(`create refused: ${error instanceof Error ? error.message : String(error)}`, { created: false });
			}
			onChange?.();
			// A shared file is legal (docs + tests, dependent work), so the create is not refused -
			// but the creator must see the other owner now, not when their claim is refused later.
			const files = params.files ?? [];
			const shared = store.tasksSharingFiles(files, [task.id]);
			const clash = shared
				.map((other) => `${other.id} (${other.status}) already owns ${other.files.filter((file) => files.includes(file)).join(", ")}`)
				.join("; ");
			return ok(`created ${task.id} (${task.status})${shared.length > 0 ? `\nduplicate risk: ${clash} — check the pool before adding a second writer` : ""}\n${renderTaskDetail(task)}`, {
				id: task.id,
				status: task.status,
				duplicateRisk: shared.map((other) => other.id),
			});
		},
	};

	const goalSchema = z.object({ goal: z.string(), agents: z.number(), vote_id: z.string().optional() });
	const goalTool: CustomTool<typeof goalSchema> = {
		name: "swarm_goal",
		label: "Open A Goal",
		description:
			"Open a goal's planning round: you decide only HOW MANY agents it needs (`agents`), never the task list. The workers read the goal, each post their own split with swarm_propose, and the first of them to claim the goal's planning task becomes the scribe that merges it with swarm_plan. Use this instead of swarm_task_create while planning is swarm-side. The budget is what grows the pool, so it is a CLUSTER-LEVEL decision: the coordinator's own goal is a seed (rule 2), while a regular agent must pass a `spawn` round whose payload_json is {\"agents\":N} and re-issue with `vote_id` — no agent can raise the roster with no ballot.",
		parameters: goalSchema,
		approval: "write",
		async execute(_id, params) {
			touch();
			if (config.planning === "coordinator") {
				return ok('this swarm uses coordinator planning (planning: "coordinator"): write the task list yourself with swarm_task_create');
			}
			const goal = params.goal.trim();
			if (goal === "") return err("a goal needs the user's request: swarm_goal({ goal, agents })", { opened: false });
			const wanted = Number.isFinite(params.agents) ? Math.floor(params.agents) : 0;
			if (wanted < 1) return err("agents must be at least 1: you decide how many workers the goal needs", { opened: false });
			const agents = Math.min(wanted, config.workers);
			// A goal's `agents` is the budget AutoController.planRoster grows the pool against, so this is
			// where the roster actually grows: gated on the SIZE asked for, with the coordinator's own goal
			// as the seed authority (rule 2). Before goal-9 the call checked no identity at all, so any
			// agent could raise N and the pool grew with no ballot.
			const gated = voteGate("spawn", params.vote_id, { agents: wanted }, () =>
				store.createGoal({ goal, agents, createdBy: identity.id }),
			);
			if (!gated.ok) return err(gated.reason, { opened: false, gated: true });
			const opened = gated.value;
			onChange?.();
			return ok(
				[
					`${opened.goal.id} open with ${agents} agent(s)${agents < wanted ? ` (capped by config.workers=${config.workers})` : ""}.`,
					`planning task: ${opened.planningTask.id} - the first agent to claim it is the scribe.`,
					"the workers post their own splits (swarm_propose) and converge; report the goal to the user and do not write the task list yourself.",
				].join("\n"),
				{ id: opened.goal.id, agents, planningTask: opened.planningTask.id },
			);
		},
	};

	const proposedTaskSchema = z.object({
		title: z.string(),
		deliverable: z.string().optional(),
		capabilities: z.array(z.string()).optional(),
		files: z.array(z.string()).optional(),
		depends_on: z.array(z.string()).optional(),
		review_required: z.boolean().optional(),
	});
	const proposeSchema = z.object({ goal_id: z.string().optional(), tasks: z.array(proposedTaskSchema) });
	const proposeTool: CustomTool<typeof proposeSchema> = {
		name: "swarm_propose",
		label: "Propose A Split",
		description:
			"Post YOUR OWN split of an open goal (a board entry tagged `proposal`, so every worker and the scribe can read it). One entry per task you think the goal needs: title, the deliverable, optional capabilities/files/review_required, and depends_on = titles of other proposed tasks. Any number of workers may propose; the scribe merges them by DELIVERABLE - the target artifact (normalized, so one artifact written several ways is one artifact) plus the kind of work read from the title, in English or Chinese - so phrase your tasks around the files they produce and do not re-propose work another agent already described.",
		parameters: proposeSchema,
		approval: "write",
		async execute(_id, params) {
			touch();
			const goal = params.goal_id !== undefined ? store.getGoal(params.goal_id) : store.liveGoals()[0];
			if (goal === undefined) {
				return ok(
					params.goal_id !== undefined
						? `unknown goal ${params.goal_id}; swarm_status lists the live ones`
						: "no open goal: the coordinator has not opened one yet - swarm_wait, then look again",
				);
			}
			if (goal.status !== "open") return ok(`goal ${goal.id} is ${goal.status}; its round is over, claim the real tasks instead`);
			if (params.tasks.length === 0) return ok("a proposal needs at least one task");
			const entry = store.postProposal(goal, identity.id, params.tasks);
			const posted = store.listProposals(goal).length;
			return ok(
				`posted proposal #${entry.id} for ${goal.id}: ${params.tasks.length} task(s); ${posted} proposal(s) on the board so far.\nNow claim the planning task ${goal.planningTask} - the first claimer is the scribe that merges them (swarm_plan) - or claim the real tasks once the DECISION lands.`,
				{ id: entry.id, goal: goal.id, proposals: posted },
			);
		},
	};

	const planSchema = z.object({ goal_id: z.string().optional() });
	const planTool: CustomTool<typeof planSchema> = {
		name: "swarm_plan",
		label: "Merge The Split",
		description:
			"The scribe's convergence step, exactly once: claim the goal's planning task FIRST, then call this. It parses every swarm_propose split of the round, merges them by DELIVERABLE (the target artifact, normalized, plus the kind of work - never the phrasing: two writers on one artifact are always one task, a writer and a verifier of one artifact are two, and an unknown kind contradicts nothing), creates the real task graph with its dependencies resolved onto the surviving rows, posts the merged split and every fold with its reason as a DECISION, and marks the goal planned.",
		parameters: planSchema,
		approval: "write",
		async execute(_id, params) {
			touch();
			const goal = params.goal_id !== undefined ? store.getGoal(params.goal_id) : store.liveGoals()[0];
			if (goal === undefined) {
				return ok(
					params.goal_id !== undefined
						? `unknown goal ${params.goal_id}; swarm_status lists the live ones`
						: "no open goal to plan; swarm_status lists the live ones",
				);
			}
			const planning = store.getTask(goal.planningTask);
			if (planning?.status !== "claimed" || planning.claimedBy !== identity.id) {
				return ok(
					`claim the goal's planning task first: swarm_claim ${goal.planningTask} - the first agent to claim it is the scribe. (Then swarm_plan again.)`,
					{ planned: false },
				);
			}
			const result = store.planGoal(goal.id, identity.id, { ceiling: config.workers });
			if (!result.ok) return err(`plan refused: ${result.reason}`, { planned: false });
			const done = store.complete(goal.planningTask, identity.id, {
				summary: `planned ${goal.id}: ${result.created.length} task(s) from ${result.proposals} proposal(s)`,
				reviewEnabled: false,
			});
			onChange?.();
			return ok(
				[
					`${goal.id} planned: ${result.created.length} task(s) created${result.skipped.length > 0 ? `, ${result.skipped.length} skipped (already in the pool)` : ""}${result.folds.length > 0 ? `, ${result.folds.length} duplicate row(s) folded into ${result.folded.length} deliverable(s)` : ""}.`,
					`SIZE: peak parallelism ${result.peak} task(s) at once; recommended agents ${result.recommended} (ceiling ${config.workers}). Any agent can ask for a different size with swarm_scale({ agents, reason }).`,
					done.ok ? `planning task ${goal.planningTask} completed; the DECISION with the merged split is on the board.` : `planning task ${goal.planningTask} could not be completed (${done.reason}); release it.`,
					...result.created.map((id) => {
						const task = store.getTask(id);
						return task === undefined ? `- ${id}` : `- ${id} ${task.title} (${task.status})`;
					}),
				].join("\n"),
				{ planned: true, created: result.created, goal: goal.id },
			);
		},
	};

	const scaleSchema = z.object({ agents: z.number(), reason: z.string(), vote_id: z.string().optional() });
	const scaleTool: CustomTool<typeof scaleSchema> = {
		name: "swarm_scale",
		label: "Request Pool Size",
		description:
			"Ask for a different pool size when the task graph needs more or fewer peers than the pool has: `agents` is the size you want and `reason` is why (recorded verbatim). Resizing the pool is a CLUSTER-LEVEL decision: when the swarm has voting on, a regular agent must pass a `scale` round first (`swarm_vote` with kind `scale`, then re-issue with `vote_id`) — the coordinator's own resize is a seed. It is ADVISORY and auditable, never a direct spawn — the controller is the only writer and applies it on its next tick (~2 s); several agents asking at once collapse to ONE resize (the largest ask). config.workers is the operator's ceiling: a larger ask is clamped and reported, never refused silently, and workers holding work are never stopped (a shrink stops idle peers only).",
		parameters: scaleSchema,
		approval: "write",
		async execute(_id, params) {
			touch();
			const reason = params.reason.trim();
			if (reason === "") return err("a scale request needs a reason: it is recorded verbatim for the audit trail", { recorded: false });
			const requested = Number.isFinite(params.agents) ? Math.floor(params.agents) : 0;
			if (requested < 1) return err(`agents must be at least 1 (asked for ${params.agents}); a pool of zero is /swarm off, not a scale request`, { recorded: false });
			const ceiling = config.workers;
			const counts = store.counts();
			const current = store.listAgents().filter((agent) => agent.status !== "offline").length;
			const floor = poolFloor(counts);
			const target = Math.min(Math.max(requested, floor), ceiling);
			// The ticket names the SIZE that was voted on: a round passed for 2 cannot authorise a request for
			// 5, and the same round cannot be re-used for a second resize (goal-9).
			const gated = voteGate("scale", params.vote_id, { agents: requested }, () =>
				store.recordScaleRequest({ agentId: identity.id, requested, reason, current }),
			);
			if (!gated.ok) return err(gated.reason, { recorded: false, gated: true });
			const request = gated.value;
			store.postBoard({
				type: "OBSERVATION",
				agentId: identity.id,
				content: `asked for ${requested} agent(s) (pool ${current}); reason: ${reason}`,
				tags: ["scale"],
			});
			onChange?.();
			const verdict =
				requested > ceiling
					? `clamped: asked for ${requested}, the operator's ceiling is config.workers=${ceiling}`
					: target > requested
						? `raised to ${target}: the live work shape (${counts.claimed} claimed + ${counts.review} in review + ${counts.ready} ready) keeps at least ${floor} worker(s)`
						: target === current
							? `recorded, but the pool is already ${current}`
							: `accepted: ${current} -> ${target}`;
			return ok(
				[
					`scale request #${request.id} ${verdict}.`,
					`the controller reconciles the pool on its next tick (~2 s); a resize cooldown can defer it, and only idle peers are ever stopped. Ask size ${target} of ceiling ${ceiling}.`,
				].join("\n"),
				{ recorded: true, id: request.id, requested, target, current, floor, ceiling },
			);
		},
	};

	const integrateSchema = z.object({
		task_ids: z.array(z.string()),
		title: z.string().optional(),
		description: z.string().optional(),
		vote_id: z.string().optional(),
	});
	const integrateTool: CustomTool<typeof integrateSchema> = {
		name: "swarm_integrate",
		label: "Create Integration Task",
		description:
			"Create an integration task that depends on several finished tasks. It becomes claimable by whichever free agent has the `integrator` capability — there is no permanent integrator. It CREATES A TASK, so it is the same cluster-level decision as swarm_task_create: when the swarm has voting on, a regular agent must have a passed `create-task` round whose payload_json carries the fields below (the coordinator's own call is a seed).",
		parameters: integrateSchema,
		approval: "write",
		async execute(_id, params) {
			touch();
			if (params.task_ids.length === 0) return ok("no task ids given");
			// The same decision swarm_task_create makes, so the same gate and the same payload binding: an
			// ungated create HERE is exactly the door the ticket system exists to close (found by SwiftTiger's
			// gate-coverage probe, board FAIL #797).
			const fields = {
				title: params.title ?? `Integrate ${params.task_ids.join(" + ")}`,
				description: params.description ?? "Merge and verify the combined result of the dependent tasks.",
				priority: 5,
				dependencies: params.task_ids,
				requiredCapabilities: ["integrator"],
			};
			let task: SwarmTask;
			try {
				const gated = voteGate("create-task", params.vote_id, fields, () => store.createTask({ ...fields, createdBy: identity.id }));
				if (!gated.ok) return err(gated.reason, { created: false, gated: true });
				task = gated.value;
			} catch (error) {
				return err(`integrate refused: ${error instanceof Error ? error.message : String(error)}`, { created: false });
			}
			onChange?.();
			return ok(`created ${task.id} (${task.status}); required capability: integrator`, { id: task.id });
		},
	};

	const retrySchema = z.object({ task_id: z.string(), reason: z.string().optional() });
	const retryTool: CustomTool<typeof retrySchema> = {
		name: "swarm_task_retry",
		label: "Retry Task",
		description:
			"Revive a `failed` or `blocked` task (fresh attempt, claim cleared) so its dependents can be promoted once it completes. A task whose own dependencies are unresolved stays `blocked` — it is never left in `ready` where `claim()` would refuse it forever. Refuses a task that is claimed, in review, or done.",
		parameters: retrySchema,
		approval: "write",
		async execute(_id, params) {
			touch();
			const result = store.retryTask(params.task_id, params.reason, identity.id);
			onChange?.();
			if (!result.ok) return err(`retry refused: ${result.reason}`, { retried: false });
			const pending = store.unresolvedDependencies(params.task_id);
			const dead = store.deadDependencies(params.task_id);
			const note =
				pending.length === 0
					? ""
					: dead.length > 0
						? `; still blocked: ${dead.join(", ")} can never reach done, so a claim will always be refused — close it with swarm_fail if it is superseded`
						: `; still blocked by ${pending.join(", ")} — a claim is refused until they are done`;
			const state = result.task?.status ?? "ready";
			return ok(`${params.task_id} -> ${state} (attempt ${result.task?.attempts ?? 0})${note}`, { retried: true, task: result.task });
		},
	};

	/**
	 * goal-14's clause 3: repair a row nobody can claim, through a legitimate operation with an
	 * audit trail. Without it the only path was a worker editing the database directly — DECISION
	 * #1076 is the record of that attempt, and what it cost. The repair is deliberately NOT gated by
	 * a vote: it is not a cluster-level decision about ownership, it is a label correction on a row
	 * that has no owner and cannot get one, and the gate it needs is the rule in `planCapsRepair`
	 * (a claimable row is refused, so a planner's routing can never be quietly overridden) plus the
	 * board entry + event the store writes for every repair.
	 */
	const repairCapsSchema = z.object({
		task_id: z.string(),
		reason: z.string().optional(),
	});
	const repairCapsTool: CustomTool<typeof repairCapsSchema> = {
		name: "swarm_repair_caps",
		label: "Repair Row Capabilities",
		description:
			"Relax the capability label of a task row that NO configured role can claim (e.g. caps=[\"reviewer\"] while every agent carries [\"general\"]) so the claim gate stops refusing the whole pool. Only that case is repaired: a row some role CAN claim is refused, because relaxing it would override a planner's routing rather than fix a strand. Every repair leaves a board entry and a caps.repair event naming what changed and who asked, so a relaxed label is never mistaken for the original one.",
		parameters: repairCapsSchema,
		approval: "write",
		async execute(_id, params) {
			touch();
			const before = store.capsBefore(params.task_id) ?? [];
			const result = store.repairCaps(params.task_id, identity.id, { config, reason: params.reason });
			onChange?.();
			if (!result.ok) return err(`repair refused: ${result.reason}`, { repaired: false });
			const row = result.task;
			const stranded = store.strandedTasks(config);
			return ok(
				[
					`${params.task_id} repaired: required capability ${JSON.stringify(row?.requiredCapabilities ?? [])} (was ${JSON.stringify(before)})`,
					`recorded on the board + a caps.repair event, requested by ${identity.id}`,
					stranded.length > 0
						? `still stranded: ${stranded.map((t) => `${t.id} (needs ${t.missingCapabilities.join(",")})`).join(", ")}`
						: "no stranded rows remain",
				].join("\n"),
				{ repaired: true, task: row },
			);
		},
	};

	const postSchema = z.object({
		type: z.string(),
		content: z.string(),
		task_id: z.string().optional(),
		tags: z.array(z.string()).optional(),
		files: z.array(z.string()).optional(),
	});
	const postTool: CustomTool<typeof postSchema> = {
		name: "board_post",
		label: "Post To Blackboard",
		description:
			"Share knowledge with the whole swarm: FACT (verified), FAIL (dead end — always post these), OBSERVATION, CLAIM, RESULT, QUESTION, REVIEW, DECISION. Append-only.",
		parameters: postSchema,
		approval: "write",
		async execute(_id, params) {
			touch();
			if (!isBoardType(params.type)) return ok(`unknown board type ${params.type}; expected FACT|FAIL|OBSERVATION|CLAIM|RESULT|QUESTION|REVIEW|DECISION`);
			const entry = store.postBoard({
				type: params.type,
				agentId: identity.id,
				content: params.content,
				taskId: params.task_id,
				tags: params.tags,
				files: params.files,
			});
			return ok(`posted #${entry.id} ${entry.type}`, { id: entry.id, type: entry.type });
		},
	};

	const searchSchema = z.object({
		query: z.string().optional(),
		type: z.string().optional(),
		task_id: z.string().optional(),
		agent_id: z.string().optional(),
		tags: z.array(z.string()).optional(),
		limit: z.number().optional(),
	});
	const searchTool: CustomTool<typeof searchSchema> = {
		name: "board_search",
		label: "Search Blackboard",
		description: "Search shared knowledge before starting work — especially FAIL entries, so you never repeat a dead end.",
		parameters: searchSchema,
		approval: "read",
		async execute(_id, params) {
			touch();
			const type = params.type !== undefined && isBoardType(params.type) ? params.type : undefined;
			if (params.type !== undefined && type === undefined) return ok(`unknown board type ${params.type}`);
			const entries = store.searchBoard({
				query: params.query,
				type,
				taskId: params.task_id,
				agentId: params.agent_id,
				tags: params.tags,
				limit: params.limit ?? 20,
			});
			return ok(renderBoard(entries), { count: entries.length });
		},
	};

	const agentsSchema = z.object({});
	const agentsTool: CustomTool<typeof agentsSchema> = {
		name: "swarm_agents",
		label: "Swarm Agents",
		description: "List peer agents with role, state, current task, heartbeat age, capabilities and worktree.",
		parameters: agentsSchema,
		approval: "read",
		async execute() {
			touch();
			const agents = store.listAgents();
			return ok(renderAgents(agents, Date.now()), { count: agents.length });
		},
	};

	const messageSchema = z.object({ to: z.string(), message: z.string(), urgent: z.boolean().optional(), task_id: z.string().optional() });
	const messageTool: CustomTool<typeof messageSchema> = {
		name: "swarm_message",
		label: "Message Peer",
		description:
			"Send a direct message to one peer (`to` = agent id) or to everyone (`to` = all). Urgent messages interrupt the target's current turn. Use for blockers and decisions, not chatter.",
		parameters: messageSchema,
		approval: "write",
		async execute(_id, params) {
			touch();
			const urgent = params.urgent ?? false;
			if (params.to === "all") {
				const message = store.sendMessage({ to: "*", from: identity.id, body: params.message, urgent, taskId: params.task_id });
				for (const agent of store.listAgents()) {
					if (agent.id !== identity.id) wake?.(agent.id, `[broadcast from ${identity.id}] ${params.message}`, urgent);
				}
				return ok(`broadcast delivered to ${store.listAgents().length - 1} peers`, { id: message.id });
			}
			const target = store.getAgent(params.to);
			if (!target) return ok(`unknown agent ${params.to}; use swarm_agents to list peers`);
			const message = store.sendMessage({ to: params.to, from: identity.id, body: params.message, urgent, taskId: params.task_id });
			wake?.(params.to, `[message from ${identity.id}] ${params.message}`, urgent);
			return ok(`sent to ${params.to}`, { id: message.id });
		},
	};

	const inboxSchema = z.object({ peek: z.boolean().optional() });
	const inboxTool: CustomTool<typeof inboxSchema> = {
		name: "swarm_inbox",
		label: "Read Messages",
		description: "Read your unread peer messages. Messages are marked read unless peek=true.",
		parameters: inboxSchema,
		approval: "read",
		async execute(_id, params) {
			touch();
			const messages: SwarmMessage[] = store.inbox(identity.id, 50);
			if (messages.length > 0 && params.peek !== true) store.markMessagesRead(identity.id, messages.map((m) => m.id));
			return ok(renderInbox(messages), { count: messages.length });
		},
	};

	const reviewSchema = z.object({ task_id: z.string(), approve: z.boolean(), notes: z.string() });
	const reviewTool: CustomTool<typeof reviewSchema> = {
		name: "swarm_review",
		label: "Review Task",
		description:
			"Review a task that is in `review`: approve it (-> done) or reject it with notes (-> ready for another attempt). You may not review your own work.",
		parameters: reviewSchema,
		approval: "write",
		async execute(_id, params) {
			touch("reviewing");
			const result = store.decide(params.task_id, identity.id, params.approve, params.notes);
			onChange?.();
			if (!result.ok) return ok(`review failed: ${result.reason}`);
			return ok(`${params.task_id} ${params.approve ? "approved -> done" : "rejected -> ready"}`, { status: result.task?.status });
		},
	};

	const reserveSchema = z.object({ paths: z.array(z.string()), task_id: z.string().optional(), reason: z.string().optional() });
	const reserveTool: CustomTool<typeof reserveSchema> = {
		name: "swarm_reserve",
		label: "Reserve Files",
		description:
			"Reserve files/directories before editing them (`src/auth/**`, `src/parser.ts`). Overlapping reservations from other agents are refused, so parallel edits never collide. Reservations expire with your lease.",
		parameters: reserveSchema,
		approval: "write",
		async execute(_id, params) {
			touch();
			const result = store.acquireReservations(identity.id, params.paths, config.leaseSeconds * 2, params.task_id);
			if (!result.ok) return ok(`reservation refused:\n${result.conflicts.join("\n")}`, { conflict: true });
			if (params.reason) store.postBoard({ type: "CLAIM", agentId: identity.id, taskId: params.task_id, content: `reserving ${params.paths.join(", ")}: ${params.reason}` });
			return ok(`reserved ${params.paths.join(", ")}`, { reserved: params.paths });
		},
	};

	const unreserveSchema = z.object({ paths: z.array(z.string()).optional() });
	const unreserveTool: CustomTool<typeof unreserveSchema> = {
		name: "swarm_unreserve",
		label: "Release Reservations",
		description: "Release your file reservations (all of them when no paths are given).",
		parameters: unreserveSchema,
		approval: "write",
		async execute(_id, params) {
			touch();
			const released = store.releaseReservations(identity.id, params.paths);
			return ok(`released ${released} reservation(s)`, { released });
		},
	};

	const waitSchema = z.object({ seconds: z.number().optional() });
	const waitTool: CustomTool<typeof waitSchema> = {
		name: "swarm_wait",
		label: "Wait For Work",
		description:
			"Block until a claimable task or a peer message appears (default 25s, max 120s). A cheap wait while someone else's work finishes: work that lands inside the window costs no model call. If nothing changes, END YOUR TURN — the driver wakes you on the next real change (claimable work, a review you may take, an unread message, a new goal), so waiting again only buys another model call for nothing.",
		parameters: waitSchema,
		approval: "read",
		async execute(_id, params, _onUpdate, _ctx, signal) {
			const deadline = clock.now() + Math.min(Math.max(params.seconds ?? 25, 1), 120) * 1000;
			while (clock.now() < deadline) {
				if (signal?.aborted) return ok("interrupted");
				touch();
				if (store.inbox(identity.id, 1).length > 0) return ok("message waiting: call swarm_inbox", { wake: "message" });
				const next = claimable();
				if (next.length > 0) return ok(`work available: ${next.map((t) => t.id).join(", ")}\n${renderTasks(next.slice(0, 10), Date.now())}`, { wake: "task" });
				await clock.sleep(1000);
			}
			// The window is for catching work that lands while someone else finishes, not for keeping this
			// worker alive: the driver wakes an idle worker by itself when agent-relevant state changes
			// (a matching ready row, a review it may take, an unread message, a new/live goal), so asking
			// the worker to wait again is one model call spent on nothing. `wake: "timeout"` is kept — it
			// is the contract callers and tests key on.
			return ok(
				"no work within the wait window, and nothing changed: the pool is idle. END YOUR TURN here — you will be woken when something changes. Do not invent work to stay busy; an empty pool is a real answer, not a gap to fill.",
				{ wake: "timeout" },
			);
		},
	};

	/**
	 * The operator's voting policy, with an optional agent request TIGHTENED onto it (rule 6): a caller
	 * may raise the threshold, never lower it, so no request can talk the pool below the operator's line.
	 */
	function votePolicyFor(requestedThreshold?: number): VotingConfig {
		return resolveVotingConfig(
			{ threshold: requestedThreshold },
			{ threshold: config.voteThreshold, minBase: config.voteMinBase, timeoutMs: config.voteTimeoutSeconds * 1000 },
		);
	}

	/**
	 * The gate every cluster-level decision point passes through. It CONSUMES the round it acts on, in
	 * the same transaction as the action (goal-9's high 1): a passed round is a one-shot ticket for the
	 * exact payload it froze, never a standing permission for its kind. A refusal names the arithmetic,
	 * so the caller sees what to do instead of guessing.
	 *
	 * Seed authority (rule 2) is the operator's and the coordinator's: `identity.isMain` acting WITHOUT a
	 * `vote_id` goes straight through, and with the operator's constraint off nothing is gated at all.
	 * A coordinator that passes a `vote_id` deliberately still spends it — one decision, one action.
	 */
	function voteGate<T>(
		kind: DecisionKind,
		voteId: string | undefined,
		payload: Record<string, unknown>,
		action: () => T,
	): { ok: true; value: T } | { ok: false; reason: string } {
		if (!config.voteEnabled || (identity.isMain && voteId === undefined)) return { ok: true, value: action() };
		if (voteId === undefined) {
			return {
				ok: false,
				reason: [
					`this is a cluster-level decision (${kind}): the pool must pass a vote first.`,
					`open one with swarm_vote({ kind: "${kind}", question: "...", payload_json: ${JSON.stringify(JSON.stringify(payload))} }) and let the eligible agents ballot it (swarm_vote({ decision_id, approve })).`,
					`a round needs strictly more than ${config.voteThreshold} of the eligible base — at least ${config.voteMinBase} voters — within ${config.voteTimeoutSeconds}s.`,
					kind === "create-task"
						? "a passed create-task round creates the task itself, and then it is spent: re-issuing the call cannot execute it twice."
						: "then re-issue this call with vote_id set to the PASSED round.",
					"short of that the round is denied at its bound with vote_failed and the full tally, and NOTHING is executed.",
				].join(" "),
			};
		}
		return store.consumeVote({
			kind,
			voteId,
			payload,
			consumedBy: identity.id,
			offlineAfterSeconds: config.offlineAfterSeconds,
			action: () => action(),
		});
	}

	/** One round as the caller reads it: the arithmetic first, then who is missing. */
	function renderVote(vote: SwarmVote, outcome: VoteOutcome): string {
		const list = (ids: string[]) => (ids.length === 0 ? "-" : ids.join(", "));
		return [
			`${vote.id} (${vote.kind}) ${vote.status}: ${vote.question}`,
			outcome.reason,
			`eligible ${outcome.base} [${list(outcome.eligible)}]; for ${outcome.approvals.length} [${list(outcome.approvals)}]; against ${outcome.rejections.length} [${list(outcome.rejections)}]; absent ${outcome.absent.length} [${list(outcome.absent)}]`,
			`needs ${outcome.needed} of ${outcome.base} at >${vote.threshold}${outcome.ignored.length > 0 ? `; ignored ${list(outcome.ignored.map((ballot) => ballot.voter))}` : ""}`,
			...(outcome.offline.length === 0
				? []
				: [`dropped ${outcome.offline.length} ballot(s), voter offline at settlement: ${list(outcome.offline)}`]),
		].join("\n");
	}

	const VOTE_KINDS: Record<DecisionKind, true> = {
		"create-task": true,
		"close-task": true,
		spawn: true,
		stop: true,
		scale: true,
	};

	const voteSchema = z.object({
		kind: z.string().optional(),
		question: z.string().optional(),
		payload_json: z.string().optional(),
		decision_id: z.string().optional(),
		approve: z.boolean().optional(),
		threshold: z.number().optional(),
	});
	const voteTool: CustomTool<typeof voteSchema> = {
		name: "swarm_vote",
		label: "Vote",
		description:
			"A cluster-level decision (create-task / close-task / spawn / stop / scale) is VOTED ON, not assumed. Open a round with `kind` + `question` + `payload_json` — the payload IS the decision: a create-task round takes swarm_task_create's own field names, close-task takes {\"task_id\":\"task-7\"}, scale and spawn take {\"agents\":N}. Read one with `decision_id` alone; cast a ballot with `decision_id` + `approve`. The decision executes only if the yes share is STRICTLY above the threshold — 3 of 4 (exactly 75%) does not pass. A passed round is a ONE-SHOT ticket for exactly that payload: the acting call repeats it, and a second use (same payload) or a different payload under the same vote_id is refused, never silently executed. The deadline DENIES by default: at its bound the not-yet-voted count as absent and `vote_failed` goes to the events AND the board with the full tally (for / against / absent / offline), never a silent failure and never an infinite retry. One agent, one ballot (a repeat is refused); an offline agent drops out of the base instead of vetoing, and a ballot dropped that way is NAMED in the tally rather than swallowed. The coordinator's own goal and an operator instruction are seeds and never vote. `threshold` is optional and can only RAISE the operator's threshold.",
		parameters: voteSchema,
		approval: "write",
		async execute(_id, params) {
			touch();
			const offlineAfterSeconds = config.offlineAfterSeconds;
			if (params.decision_id !== undefined) {
				if (params.approve === undefined) {
					const tally = store.tallyVote(params.decision_id, offlineAfterSeconds);
					if (tally === undefined) return err(`unknown vote ${params.decision_id}`, { found: false });
					return ok(renderVote(tally.vote, tally.outcome), { vote: tally.vote.id, status: tally.vote.status, settled: tally.outcome.settled });
				}
				const cast = store.castBallot(params.decision_id, identity.id, params.approve, offlineAfterSeconds);
				if (!cast.ok) return err(`ballot refused: ${cast.reason}`, { cast: false });
				const settled = store.settleVote(params.decision_id, offlineAfterSeconds);
				if (settled === undefined) return err(`${params.decision_id} vanished while settling`, { cast: true });
				onChange?.();
				return ok(
					[
						`${identity.id} voted ${params.approve ? "FOR" : "AGAINST"} ${settled.vote.id}${settled.outcome.settled ? " (round settled)" : ""}`,
						renderVote(settled.vote, settled.outcome),
						settled.vote.result === undefined ? "" : `result: ${settled.vote.result}`,
					].join("\n"),
					{ vote: settled.vote.id, status: settled.vote.status, settled: settled.outcome.settled, cast: true },
				);
			}
			const kind = params.kind ?? "";
			if (!(kind in VOTE_KINDS)) return err(`opening a round needs a kind: one of ${Object.keys(VOTE_KINDS).join(", ")}`, { opened: false });
			const question = (params.question ?? "").trim();
			if (question === "") return err("opening a round needs the question: one line saying what is being decided", { opened: false });
			let payload: Record<string, unknown> = {};
			if (params.payload_json !== undefined) {
				try {
					payload = JSON.parse(params.payload_json) as Record<string, unknown>;
				} catch (error) {
					return err(`payload_json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { opened: false });
				}
			}
			// The coordinator's own round is a seed (rule 2): it executes without a ballot, which is what
			// stops the cold start from deadlocking on a pool that does not exist yet.
			const seed = identity.isMain;
			const vote = store.openVote({
				kind: kind as DecisionKind,
				question,
				payload,
				openedBy: identity.id,
				policy: votePolicyFor(params.threshold),
				seed,
			});
			onChange?.();
			if (seed) {
				const executed = store.executeSeededVote(vote.id);
				if (executed === undefined) return err(`seed ${vote.id} vanished`, { opened: true, seeded: true });
				return ok(`seeded ${executed.id} (${executed.kind}): no ballot — the coordinator's own decision.\n${executed.result ?? ""}`, {
					vote: executed.id,
					status: executed.status,
					seeded: true,
				});
			}
			return ok(
				[
					`opened ${vote.id} (${vote.kind}): ${vote.question}`,
					`needs strictly more than ${vote.threshold} of the eligible base, at least ${vote.minBase} voters, within ${config.voteTimeoutSeconds}s — denied by default at the bound.`,
					`ballot it with swarm_vote({ decision_id: "${vote.id}", approve: true | false })${vote.kind === "create-task" ? "; a passed round creates the task itself" : ""}.`,
				].join("\n"),
				{ vote: vote.id, status: vote.status, opened: true },
			);
		},
	};

	const tools: CustomTool[] = [
		statusTool,
		tasksTool,
		claimTool,
		renewTool,
		releaseTool,
		completeTool,
		failTool,
		createTool,
		goalTool,
		proposeTool,
		planTool,
		voteTool,
		scaleTool,
		retryTool,
		repairCapsTool,
		integrateTool,
		postTool,
		searchTool,
		agentsTool,
		messageTool,
		inboxTool,
		reviewTool,
		reserveTool,
		unreserveTool,
		waitTool,
	];
	return tools;
}

export const SWARM_TOOL_NAMES = [
	"swarm_status",
	"swarm_tasks",
	"swarm_claim",
	"swarm_renew",
	"swarm_release",
	"swarm_complete",
	"swarm_fail",
	"swarm_task_create",
	"swarm_goal",
	"swarm_propose",
	"swarm_plan",
	"swarm_vote",
	"swarm_scale",
	"swarm_task_retry",
	"swarm_repair_caps",
	"swarm_integrate",
	"board_post",
	"board_search",
	"swarm_agents",
	"swarm_message",
	"swarm_inbox",
	"swarm_review",
	"swarm_reserve",
	"swarm_unreserve",
	"swarm_wait",
] as const;

/** Adapt a CustomTool to the extension `ToolDefinition` shape (different argument order). */
export function toToolDefinition<TSchemaType extends TSchema>(tool: CustomTool<TSchemaType>) {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		approval: tool.approval,
		execute: async (
			toolCallId: string,
			params: Parameters<CustomTool<TSchemaType>["execute"]>[1],
			signal: AbortSignal | undefined,
			onUpdate: Parameters<CustomTool<TSchemaType>["execute"]>[2],
			ctx: Parameters<CustomTool<TSchemaType>["execute"]>[3],
		) => tool.execute(toolCallId, params, onUpdate, ctx, signal),
	};
}
