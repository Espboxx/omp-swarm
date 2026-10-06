import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type * as zod from "@oh-my-pi/omptype/zod";
import { renderAgents, renderBoard, renderInbox, renderTaskDetail, renderTasks } from "./render";
import type { SwarmStore } from "./store";
import type { BoardType, SwarmConfig, SwarmMessage, SwarmTask, TaskStatus } from "./types";

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

	// Every tool call proves the agent is alive and keeps its leases warm.
	const touch = (status?: "idle" | "working" | "reviewing") => {
		store.heartbeat(identity.id, status, undefined, config.leaseSeconds);
	};

	const claimable = () =>
		store.listTasks({ status: "ready", limit: 100 }).filter(
			(t) => t.requiredCapabilities.length === 0 || t.requiredCapabilities.some((cap) => identity.capabilities.includes(cap)),
		);

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
			return ok(lines.join("\n"), { counts: snapshot.counts, agents: snapshot.agents.length });
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
			store.releaseReservations(identity.id);
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
			store.releaseReservations(identity.id);
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
			store.releaseReservations(identity.id);
			const state = result.task?.status ?? "done";
			return ok(`${params.task_id} -> ${state}${state === "review" ? " (a peer must review before it counts as done)" : ""}`, {
				status: state,
			});
		},
	};

	const failSchema = z.object({ task_id: z.string(), reason: z.string() });
	const failTool: CustomTool<typeof failSchema> = {
		name: "swarm_fail",
		label: "Fail Task",
		description: "Mark your task failed with the reason. A FAIL entry is posted to the blackboard automatically so peers never repeat the dead end.",
		parameters: failSchema,
		approval: "write",
		async execute(_id, params) {
			touch();
			const result = store.fail(params.task_id, identity.id, params.reason);
			onChange?.();
			if (!result.ok) return ok(`fail rejected: ${result.reason}`);
			store.releaseReservations(identity.id);
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
	});
	const createTool: CustomTool<typeof createSchema> = {
		name: "swarm_task_create",
		label: "Create Task",
		description:
			"Add work to the shared pool. Use it to split an oversized task, or to record a dependency you discovered. Tasks with unfinished dependencies start blocked.",
		parameters: createSchema,
		approval: "write",
		async execute(_id, params) {
			touch();
			let task: SwarmTask;
			try {
				task = store.createTask({
					title: params.title,
					description: params.description,
					priority: params.priority,
					createdBy: identity.id,
					dependencies: params.dependencies,
					requiredCapabilities: params.required_capabilities,
					files: params.files,
					reviewRequired: params.review_required,
				});
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

	const integrateSchema = z.object({
		task_ids: z.array(z.string()),
		title: z.string().optional(),
		description: z.string().optional(),
	});
	const integrateTool: CustomTool<typeof integrateSchema> = {
		name: "swarm_integrate",
		label: "Create Integration Task",
		description:
			"Create an integration task that depends on several finished tasks. It becomes claimable by whichever free agent has the `integrator` capability — there is no permanent integrator.",
		parameters: integrateSchema,
		approval: "write",
		async execute(_id, params) {
			touch();
			if (params.task_ids.length === 0) return ok("no task ids given");
			let task: SwarmTask;
			try {
				task = store.createTask({
					title: params.title ?? `Integrate ${params.task_ids.join(" + ")}`,
					description: params.description ?? "Merge and verify the combined result of the dependent tasks.",
					priority: 5,
					createdBy: identity.id,
					dependencies: params.task_ids,
					requiredCapabilities: ["integrator"],
				});
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
			"Revive a `failed` or `blocked` task back into the pool as ready (fresh attempt, claim cleared) so its dependents can be promoted once it completes. Refuses a task that is claimed, in review, or done.",
		parameters: retrySchema,
		approval: "write",
		async execute(_id, params) {
			touch();
			const result = store.retryTask(params.task_id, params.reason, identity.id);
			onChange?.();
			if (!result.ok) return err(`retry refused: ${result.reason}`, { retried: false });
			const pending = store.unresolvedDependencies(params.task_id);
			const note =
				pending.length > 0 ? `; still waiting on ${pending.join(", ")} — a claim will be refused until they are done` : "";
			return ok(`${params.task_id} -> ready (attempt ${result.task?.attempts ?? 0})${note}`, { retried: true, task: result.task });
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
			"Block until a claimable task or a peer message appears (default 25s, max 120s). Run this instead of ending your turn while the swarm is still running.",
		parameters: waitSchema,
		approval: "read",
		async execute(_id, params, _onUpdate, _ctx, signal) {
			const deadline = Date.now() + Math.min(Math.max(params.seconds ?? 25, 1), 120) * 1000;
			while (Date.now() < deadline) {
				if (signal?.aborted) return ok("interrupted");
				touch();
				if (store.inbox(identity.id, 1).length > 0) return ok("message waiting: call swarm_inbox", { wake: "message" });
				const next = claimable();
				if (next.length > 0) return ok(`work available: ${next.map((t) => t.id).join(", ")}\n${renderTasks(next.slice(0, 10), Date.now())}`, { wake: "task" });
				await Bun.sleep(1000);
			}
			return ok("no work within the wait window; check the board for something useful to add, then wait again or stop.", { wake: "timeout" });
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
		retryTool,
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
	"swarm_task_retry",
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
