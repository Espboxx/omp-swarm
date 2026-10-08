import { appendEventLine, type Db, type SwarmPaths } from "./db";
import {
	DEDUPE_KEY_TEXT,
	GOAL_DEADLINE_MS,
	MIN_PROPOSALS,
	PROPOSAL_TAG,
	deliverableKey,
	describeDeliverable,
	goalTag,
	mergeProposals,
	orderForCreation,
	parseProposal,
	planningTaskBrief,
	peakParallelism,
	poolSkipReason,
	unclaimableReason,
	unreachableCapabilities,
	type DeliverableShape,
	type MergedTask,
	type Proposal,
} from "./planning";
import type {
	AgentStatus,
	BlackboardEntry,
	BoardType,
	ClaimResult,
	DecisionKind,
	GoalStatus,
	MergeFold,
	PlanResult,
	Reservation,
	ScaleRequest,
	SwarmAgent,
	SwarmConfig,
	SwarmGoal,
	SwarmMessage,
	SwarmTask,
	SwarmVote,
	TaskCounts,
	TaskStatus,
	VoteState,
} from "./types";
import { candidatesFromTasks, formatCapsRepair, planCapsRepair, reachableCapabilities, strandedRows, type CapsRepairRecord, type StrandedRow } from "./caps-repair";
import { retryEscalation, retryGate, type RetryMemory } from "./failure-gate";
import { goalDuplicateVerdict, goalKind, goalLedger, ledgerInjection, LEDGER_READ_LIMIT, type GoalKind, type GoalLedger } from "./coordinator-ledger";
import { duplicateRefusal, identityKeyOf, type LiveRow } from "./identity-key";
import { decide, payloadSignature, type Vote, type VoteOutcome, type VotingConfig } from "./voting";

interface TaskRow {
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
	priority: number;
	created_by: string;
	created_at: number;
	updated_at: number;
	claimed_by: string | null;
	author: string | null;
	claimed_at: number | null;
	lease_until: number | null;
	required_capabilities: string;
	files: string;
	result: string | null;
	commit_ref: string | null;
	review_required: number;
	review_status: string | null;
	reviewer: string | null;
	review_notes: string | null;
	review_lease_until: number | null;
	attempts: number;
}

interface AgentRow {
	id: string;
	session_id: string | null;
	role: string;
	status: AgentStatus;
	capabilities: string;
	current_task: string | null;
	worktree: string | null;
	pid: number | null;
	joined_at: number;
	heartbeat_at: number;
}

interface VoteRow {
	id: string;
	kind: DecisionKind;
	question: string;
	payload: string;
	opened_by: string;
	opened_at: number;
	deadline_at: number;
	threshold: number;
	min_base: number;
	status: VoteState;
	result: string | null;
	updated_at: number;
}

/** The one-shot marker of a spent round (goal-9): a passed decision authorises exactly one action. */
interface VoteConsumptionRow {
	vote_id: string;
	kind: DecisionKind;
	payload: string;
	consumed_by: string;
	consumed_at: number;
}

interface BoardRow {
	id: number;
	type: BoardType;
	agent_id: string;
	task_id: string | null;
	content: string;
	tags: string;
	files: string;
	created_at: number;
}

interface MessageRow {
	id: number;
	to_agent: string;
	from_agent: string;
	body: string;
	urgent: number;
	task_id: string | null;
	created_at: number;
	read_at: number | null;
}

interface ReservationRow {
	id: number;
	pattern: string;
	owner: string;
	task_id: string | null;
	lease_until: number;
	created_at: number;
}

interface CountRow {
	status: TaskStatus;
	n: number;
}

interface GoalRow {
	id: string;
	goal: string;
	agents: number;
	status: GoalStatus;
	created_by: string;
	created_at: number;
	updated_at: number;
	deadline_at: number;
	planning_task: string;
	planner: string | null;
	planned_at: number | null;
	result: string | null;
}

interface ScaleRow {
	id: number;
	agent_id: string;
	reason: string;
	requested: number;
	current: number;
	created_at: number;
	decided_at: number | null;
	decided_action: string | null;
	decided_size: number | null;
}

function toScaleRequest(row: ScaleRow): ScaleRequest {
	return {
		id: row.id,
		agentId: row.agent_id,
		requested: row.requested,
		reason: row.reason,
		current: row.current,
		createdAt: row.created_at,
		decidedAt: row.decided_at ?? undefined,
		decidedAction: row.decided_action ?? undefined,
		decidedSize: row.decided_size ?? undefined,
	};
}

function parseList(raw: string): string[] {
	try {
		const value = JSON.parse(raw);
		return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}

function toTask(row: TaskRow, deps: string[]): SwarmTask {
	return {
		id: row.id,
		title: row.title,
		description: row.description,
		status: row.status,
		priority: row.priority,
		createdBy: row.created_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		claimedBy: row.claimed_by ?? undefined,
		claimedAt: row.claimed_at ?? undefined,
		leaseUntil: row.lease_until ?? undefined,
		dependencies: deps,
		requiredCapabilities: parseList(row.required_capabilities),
		files: parseList(row.files),
		result: row.result ?? undefined,
		commit: row.commit_ref ?? undefined,
		review: {
			required: row.review_required === 1,
			reviewer: row.reviewer ?? undefined,
			status: (row.review_status as "pending" | "approved" | "rejected" | null) ?? undefined,
			notes: row.review_notes ?? undefined,
		},
		attempts: row.attempts,
	};
}

/**
 * What a merged deliverable says on its row: the proposer's own description, plus the provenance a
 * later reader needs (which proposals and agents it came from, and which goal round produced it).
 */
function mergedTaskDescription(task: MergedTask, goal: SwarmGoal, scribe: string): string {
	const lines = [task.deliverable ?? task.title, ""];
	lines.push(`Split by ${task.agents.join(", ")} in the planning round of ${goal.id} (goal: ${goal.goal}); merged by ${scribe}.`);
	if (task.files.length > 0) lines.push(`Files: ${task.files.join(", ")}`);
	return lines.join("\n");
}

function toGoal(row: GoalRow): SwarmGoal {
	return {
		id: row.id,
		goal: row.goal,
		agents: row.agents,
		status: row.status,
		createdBy: row.created_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		deadlineAt: row.deadline_at,
		planningTask: row.planning_task,
		planner: row.planner ?? undefined,
		plannedAt: row.planned_at ?? undefined,
		result: row.result ?? undefined,
	};
}

/**
 * Depth-first walk over the dependency edges (`task -> [dependencies]`) starting at
 * `start`. Returns the first cycle as a closed path (`[a, b, a]`) or `undefined` when
 * the subgraph is acyclic. A node's subtree is only marked settled after it has been
 * fully explored, so a node reachable from two branches is not re-walked.
 */
function findCycle(edges: Map<string, string[]>, start: string): string[] | undefined {
	const path: string[] = [];
	const onPath = new Set<string>();
	const settled = new Set<string>();
	const visit = (node: string): string[] | undefined => {
		if (onPath.has(node)) {
			path.push(node);
			return path.slice(path.indexOf(node));
		}
		if (settled.has(node)) return undefined;
		path.push(node);
		onPath.add(node);
		for (const dep of edges.get(node) ?? []) {
			const cycle = visit(dep);
			if (cycle !== undefined) return cycle;
		}
		path.pop();
		onPath.delete(node);
		settled.add(node);
		return undefined;
	};
	return visit(start);
}

/**
 * Reservation patterns are path-shaped: `src/auth/**` (subtree) or `src/parser.ts` (exact).
 * Two patterns conflict when one's normalized prefix covers the other.
 */
export function patternsConflict(a: string, b: string): boolean {
	const norm = (p: string) => p.trim().replace(/\\/g, "/").replace(/\/+\*\*$/, "").replace(/\/+$/, "");
	const x = norm(a);
	const y = norm(b);
	if (x === "" || y === "") return false;
	if (x === y) return true;
	const under = (child: string, parent: string) => parent !== "" && (child === parent || child.startsWith(`${parent}/`));
	return under(x, y) || under(y, x);
}

export interface CreateTaskInput {
	title: string;
	description?: string;
	priority?: number;
	createdBy: string;
	dependencies?: string[];
	requiredCapabilities?: string[];
	files?: string[];
	reviewRequired?: boolean;
	/**
	 * The caller's clock, stamped into `created_at`/`updated_at` exactly as `createGoal` already
	 * takes one (see {@link createGoal}). Absent means `Date.now()`, so every existing caller keeps
	 * its behaviour byte for byte; present means an age-sensitive test (or a takeover replay) can
	 * mint a row that is genuinely old instead of reaching past the store into the schema.
	 */
	now?: number;
	/**
	 * goal-14's clause 1, at this mint site. The set of capabilities the roster can actually hand an
	 * agent — `reachableCapabilities(config)` from `caps-repair.ts`, derived from `expandWorkers`.
	 * When it is SUPPLIED, a required capability outside it makes the mint a REFUSAL (see
	 * {@link CreateTaskResult}) with an actionable reason. When it is absent the guard is off and the
	 * mint is exactly what it was before, so every caller that does not opt in — the goal's own
	 * planning task, `swarm_integrate`'s `["integrator"]` label, the operator's `/swarm task`, the
	 * vote-executed creates, and every takeover replay — keeps its behaviour byte for byte.
	 */
	reachable?: Set<string>;
	/**
	 * goal-17's L2, at this mint site. When SUPPLIED, a mint whose identity key a LIVE row already
	 * holds is REFUSED — the same shape `reachable` uses, for the same reason: the guard is on for
	 * the callers that should have it and byte-for-byte absent for the ones that must not. Absent
	 * means the mint is exactly what it was before, so the goal's own planning task,
	 * `swarm_integrate`'s `["integrator"]` label, the operator's `/swarm task`, the vote-executed
	 * creates and every takeover replay all keep their behaviour.
	 *
	 * What the guard may never do is stated by the key itself rather than by a special case: a match
	 * against a `failed` row is not a refusal (the lookup is live rows only, the same rule
	 * `planGoal` already applies), a re-file that changes only `caps` to a reachable capability is a
	 * FRESH key, and a `fix` and a `verify` on one file are two keys because the kind is one of the
	 * key's four components.
	 */
	dedupe?: boolean;
}

/**
 * The in-transaction sentinel for a refused mint inside `planGoal`: the round is refused as a whole
 * and the transaction rolls back, so the caller sees a `PlanResult` with `ok:false` instead of a
 * throw escaping the tool. It exists so a refusal is data, not an exception, wherever it surfaces.
 */
export class MintRefused extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "MintRefused";
	}
}

export interface BoardQuery {
	query?: string;
	type?: BoardType;
	taskId?: string;
	agentId?: string;
	tags?: string[];
	limit?: number;
}

export interface StatusSnapshot {
	now: number;
	running: boolean;
	agents: SwarmAgent[];
	counts: TaskCounts;
	board: Record<string, number>;
	claimable: number;
	inFlight: SwarmTask[];
	/** Completed tasks, newest completion first (same limit convention as `inFlight`). */
	recentDone: SwarmTask[];
}

/**
 * How long a row must have sat undisturbed before the unroutable exit may close it. An order of
 * magnitude longer than the default offline window (60 s), so an agent reconnecting, a lease expiring
 * or a review slot freeing cannot flip the condition mid-decision — and the same length as the
 * planning round's own bound, because a capability that has not appeared in ten minutes is not coming
 * from this pool.
 */
export const UNROUTABLE_GRACE_MS = 10 * 60_000;

/**
 * Caller-supplied policy for the unroutable close, because the window belongs to the config the caller
 * already holds (the same reason `snapshot()` takes `offlineAfterSeconds` rather than reading it).
 */
export interface UnroutableClose {
	/** An agent whose heartbeat is older than this counts as offline, exactly as `snapshot()` derives it. */
	offlineAfterMs: number;
	/** Override the grace window (tests pin the boundary with it). */
	graceMs?: number;
}

/**
 * Caller-supplied policy for `repairCaps`, for the same reason as `UnroutableClose`: the roster the
 * capability label must be judged against belongs to the config the caller already holds. A store
 * that read a config of its own would judge a row against a DIFFERENT fact than the one the claim
 * gate uses, which is exactly the "two capability tables" split goal-14 forbids.
 */
export interface CapsRepairPolicy {
	/** The live config, so the repair reuses `expandWorkers`' derivation rather than a second table. */
	config: SwarmConfig;
	/** Recorded on the audit trail next to the caller, so a repair never looks authorless. */
	reason?: string;
}

/**
 * All swarm state lives in one SQLite database shared by every agent.
 * Every mutation that decides ownership runs inside `BEGIN IMMEDIATE`, so the
 * claim/lease/review races are settled by the database, not by agent etiquette.
 */
export class SwarmStore {
	readonly #db: Db;
	readonly #paths: SwarmPaths;

	constructor(db: Db, paths: SwarmPaths) {
		this.#db = db;
		this.#paths = paths;
	}

	get paths(): SwarmPaths {
		return this.#paths;
	}

	close(): void {
		this.#db.close();
	}

	#log(type: string, agentId?: string, taskId?: string, data: Record<string, unknown> = {}): void {
		const createdAt = Date.now();
		this.#db.run(
			"INSERT INTO events (type, agent_id, task_id, data, created_at) VALUES (?, ?, ?, ?, ?)",
			type,
			agentId ?? null,
			taskId ?? null,
			JSON.stringify(data),
			createdAt,
		);
		appendEventLine(this.#paths, { type, agentId, taskId, data, createdAt });
	}

	/**
	 * Record an event that no tool call produced — a controller decision such as `roster.shrink`,
	 * `roster.grow`, `pool.underBudgeted`, `swarm.auto.*`. It goes through BOTH sinks `#log` uses
	 * (the `events` table and `.swarm/events.jsonl`), because a controller event that reached only the
	 * jsonl left every reader of the table — the web panel, the DB-reading proof fixtures, ops queries —
	 * blind to the fact that the pool had changed size at all.
	 */
	logEvent(type: string, agentId: string, data: Record<string, unknown> = {}): void {
		this.#log(type, agentId, undefined, data);
	}

	// ---------------------------------------------------------------- agents

	registerAgent(agent: {
		id: string;
		role: string;
		capabilities?: string[];
		sessionId?: string;
		worktree?: string;
		pid?: number;
		status?: AgentStatus;
	}): SwarmAgent {
		const now = Date.now();
		this.#db.run(
			`INSERT INTO agents (id, session_id, role, status, capabilities, current_task, worktree, pid, joined_at, heartbeat_at)
			 VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   session_id = excluded.session_id, role = excluded.role, status = excluded.status,
			   capabilities = excluded.capabilities, worktree = excluded.worktree, pid = excluded.pid,
			   heartbeat_at = excluded.heartbeat_at`,
			agent.id,
			agent.sessionId ?? null,
			agent.role,
			agent.status ?? "idle",
			JSON.stringify(agent.capabilities ?? []),
			agent.worktree ?? null,
			agent.pid ?? null,
			now,
			now,
		);
		this.#log("agent.join", agent.id);
		return this.getAgent(agent.id) as SwarmAgent;
	}

	unregisterAgent(id: string): void {
		const held = this.#db.all<{ id: string }>("SELECT id FROM tasks WHERE claimed_by=? AND status='claimed'", id);
		this.#db.transaction(() => {
			this.#db.run("UPDATE tasks SET status='ready', claimed_by=NULL, claimed_at=NULL, lease_until=NULL WHERE claimed_by=? AND status='claimed'", id);
			this.#db.run("DELETE FROM reservations WHERE owner=?", id);
			this.#db.run("DELETE FROM agents WHERE id=?", id);
		});
		for (const task of held) this.#log("task.reclaim", id, task.id, { reason: "agent-left" });
		this.#log("agent.leave", id);
	}

	/**
	 * What the pool can PROVE about an agent from the rows it holds — the only three statuses a beat may
	 * re-derive. `blocked`/`waiting` are declared by a caller, not derived, so they are not here.
	 */
	#derivedState(agentId: string): { status: AgentStatus; currentTask: string | null } {
		const claimed = this.#db.get<{ id: string }>(
			"SELECT id FROM tasks WHERE claimed_by=? AND status='claimed' ORDER BY priority DESC, created_at ASC LIMIT 1",
			agentId,
		);
		const reviewing =
			claimed === null
				? this.#db.get<{ id: string }>(
						`SELECT id FROM tasks WHERE reviewer=? AND status='review' AND (review_lease_until IS NULL OR review_lease_until > ?)
						 ORDER BY priority DESC, created_at ASC LIMIT 1`,
						agentId,
						Date.now(),
					)
				: null;
		return {
			status: claimed !== null ? "working" : reviewing !== null ? "reviewing" : "idle",
			currentTask: claimed?.id ?? reviewing?.id ?? null,
		};
	}

	/**
	 * Put an agent row back in step with what it still holds. The four transitions used to write `idle` +
	 * a NULL `current_task` unconditionally, which is how a row could read `idle` while `tasks` still
	 * showed a row claimed by it — the contradiction behind "/swarm status says 0 working while four rows
	 * are claimed", and part of why the operator could not tell who was burning.
	 */
	#settleAgent(agentId: string, now: number): void {
		const derived = this.#derivedState(agentId);
		this.#db.run(
			"UPDATE agents SET status=?, current_task=?, heartbeat_at=? WHERE id=?",
			derived.status,
			derived.currentTask,
			now,
			agentId,
		);
	}

	heartbeat(id: string, status?: AgentStatus, currentTask?: string | null, leaseSeconds = 300): void {
		const now = Date.now();
		const agent = this.#db.get<{ status: AgentStatus; current_task: string | null }>("SELECT status, current_task FROM agents WHERE id=?", id);
		if (!agent) return;
		// `blocked`/`waiting` are DECLARED by a caller, not derived from holdings, so a beat leaves them.
		const declared = agent.status === "blocked" || agent.status === "waiting";
		const derived = declared ? { status: agent.status, currentTask: agent.current_task } : this.#derivedState(id);
		// A beat IS liveness, so it can never conclude in the corpse marker (`offline` is a read-side
		// judgement — task-173). An explicit non-offline status still wins. Otherwise the row is RE-DERIVED
		// from its holdings instead of echoed back, so a state whose cause is gone cannot be re-asserted by
		// the beat loop forever: that is how a stale `reviewing` outlived every review the agent held
		// (task-176), and the same hole applied to `working`.
		const requested = status === "offline" ? undefined : status;
		this.#db.run(
			"UPDATE agents SET heartbeat_at=?, status=?, current_task=? WHERE id=?",
			now,
			requested ?? derived.status,
			currentTask === undefined ? derived.currentTask : currentTask,
			id,
		);
		this.#db.run("UPDATE tasks SET lease_until=? WHERE claimed_by=? AND status='claimed'", now + leaseSeconds * 1000, id);
	}

	setAgentStatus(id: string, status: AgentStatus, currentTask?: string | null): void {
		this.#db.run(
			"UPDATE agents SET status=?, current_task=COALESCE(?, current_task), heartbeat_at=? WHERE id=?",
			status,
			currentTask ?? null,
			Date.now(),
			id,
		);
	}

	getAgent(id: string): SwarmAgent | undefined {
		const row = this.#db.get<AgentRow>("SELECT * FROM agents WHERE id=?", id);
		return row ? this.#toAgent(row) : undefined;
	}

	#toAgent(row: AgentRow): SwarmAgent {
		return {
			id: row.id,
			sessionId: row.session_id ?? undefined,
			role: row.role,
			status: row.status,
			capabilities: parseList(row.capabilities),
			currentTask: row.current_task ?? undefined,
			worktree: row.worktree ?? undefined,
			pid: row.pid ?? undefined,
			joinedAt: row.joined_at,
			heartbeatAt: row.heartbeat_at,
		};
	}

	markStaleAgentsOffline(offlineAfterSeconds: number): string[] {
		const cutoff = Date.now() - offlineAfterSeconds * 1000;
		const stale = this.#db.all<{ id: string }>("SELECT id FROM agents WHERE status != 'offline' AND heartbeat_at < ?", cutoff);
		for (const row of stale) this.#db.run("UPDATE agents SET status='offline' WHERE id=?", row.id);
		return stale.map((r) => r.id);
	}

	/**
	 * goal-14's clause 3: relax the capability label of a row nobody can claim, as a legitimate,
	 * audited operation. The pure rule lives in `caps-repair.ts` (`planCapsRepair`), so the store
	 * only enforces it: it refuses a row that is claimable (that would override a planner's
	 * routing), refuses a row that requires nothing, and refuses a row that is `claimed` or `done`
	 * (nothing is waiting for a claimant). The change is a single-column UPDATE — the only write of
	 * `required_capabilities` outside the INSERT — and every repair leaves a `caps.repair` event
	 * plus a board entry, so a relaxed label is never indistinguishable from a wrong one (DECISION
	 * #1076: the failure was not the write, it was the missing audit trail).
	 */
	repairCaps(taskId: string, requestedBy: string, options: CapsRepairPolicy): { ok: boolean; reason?: string; task?: SwarmTask } {
		return this.#db.transaction(() => {
			const row = this.#db.get<TaskRow>("SELECT * FROM tasks WHERE id=?", taskId);
			if (row === null) return { ok: false, reason: `unknown task ${taskId}` };
			if (row.status === "claimed" || row.status === "done") {
				return { ok: false, reason: `task ${taskId} is ${row.status} - a repair only applies to a row waiting for a claimant` };
			}
			const current = parseList(row.required_capabilities);
			const plan = planCapsRepair({ taskId, currentCapabilities: current, requestedBy, reason: options.reason }, options.config);
			if (!plan.ok) return { ok: false, reason: plan.reason };
			const now = Date.now();
			this.#db.run("UPDATE tasks SET required_capabilities=?, updated_at=? WHERE id=?", JSON.stringify(plan.to), now, taskId);
			const record: CapsRepairRecord = { taskId, from: plan.from, to: plan.to, requestedBy, reason: plan.reason, at: now };
			this.#log("caps.repair", requestedBy, taskId, { from: plan.from, to: plan.to, reason: plan.reason });
			const updated = this.getTask(taskId);
			if (updated !== undefined) {
				this.postBoard({
					type: "DECISION",
					agentId: requestedBy,
					taskId,
					content: formatCapsRepair(record),
					tags: ["caps-repair", "goal-14"],
				});
			}
			return { ok: true, task: updated };
		});
	}

	/**
	 * goal-14's clause 3, the reporting half: every row in a claimable state that no configured role
	 * can take, oldest first. The claim gate's own predicate decides (via `caps-repair.ts`), so this
	 * list is exactly what an agent would see refusing a claim — not a second opinion about it.
	 * Takes the config for the same reason `repairCaps` does.
	 */
	strandedTasks(config: SwarmConfig, now = Date.now()): StrandedRow[] {
		return strandedRows(candidatesFromTasks(this.listTasks({ status: ["ready", "blocked", "review"], limit: 1000 })), config, now);
	}

	/**
	 * Read-only companion to `repairCaps` for the caller that wants to see the label a repair
	 * replaced without re-deriving it. Not an audit trail by itself — the trail is the board entry
	 * and the `caps.repair` event — this is a convenience for a tool reply.
	 */
	capsBefore(taskId: string): string[] | undefined {
		const row = this.#db.get<{ required_capabilities: string }>("SELECT required_capabilities FROM tasks WHERE id=?", taskId);
		return row === null || row === undefined ? undefined : parseList(row.required_capabilities);
	}

	listAgents(): SwarmAgent[] {
		return this.#db.all<AgentRow>("SELECT * FROM agents ORDER BY joined_at").map((r) => this.#toAgent(r));
	}

	// ----------------------------------------------------------------- tasks

	/**
	 * Mint one task. A required capability no configured role can reach — when the caller supplies
	 * `input.reachable` — is REFUSED: the row is not written, and the returned task carries
	 * `status:"refused"` plus the reason in `mintRefusal`, so the caller reports it rather than
	 * discovering a stranded row two hours later. When `reachable` is absent the mint is exactly what
	 * it was before.
	 */
	createTask(input: CreateTaskInput): SwarmTask {
		return this.#db.transaction(() => this.#createTaskLocked(input));
	}

	/**
	 * The task insert without its own transaction, so a caller that must be atomic across several
	 * rows (`planGoal` creates a whole round) shares ONE write transaction instead of nesting them.
	 *
	 * A refusal returns a task-shaped object with `status:"refused"` and `mintRefusal` set — never a
	 * throw, and never a silently dropped row. Every caller that passes no `reachable` set gets the
	 * old behaviour exactly (`#createTaskLocked` is shared by the goal's planning task,
	 * `swarm_integrate`, the operator's bootstrap, and the vote-executed creates).
	 */
	#createTaskLocked(input: CreateTaskInput): SwarmTask {
		/** A task-shaped object for a refused mint: never written, never claimable, never counted. */
		const refusal = (reason: string): SwarmTask => ({
			...this.#blankTask(), status: "refused", mintRefusal: reason,
		});
		const required = [...new Set(input.requiredCapabilities ?? [])];
		const unreachable = input.reachable === undefined ? [] : unreachableCapabilities(required, input.reachable);
		if (unreachable.length > 0 && input.reachable !== undefined) {
			// The refusal is reported on the board as well as returned, so a row the pool never got is
			// still visible: the operator can see a stranded label being asked for, which is the exact
			// information that was missing when task-221/222/223 sat ready for two hours.
			const reason = unclaimableReason({ task: "", title: input.title, capability: unreachable[0] as string, reachable: [...input.reachable] });
			this.postBoard({
				type: "DECISION",
				agentId: input.createdBy,
				content: `MINT REFUSED (goal-14 clause 1): ${reason}\n\nThe row was NOT created. Either re-file it with a capability the pool holds, or ask the operator to add a role that carries ${unreachable.join(", ")} — that is the operator's decision, not a worker's.`,
				tags: ["mint-refusal", "goal-14"],
			});
			return refusal(reason);
		}
		if (input.dedupe === true) {
			// goal-17's L2 / task-252's G3: a mint whose identity key a LIVE row already holds is
			// refused, in exactly the capability guard's shape — the same task-shaped object, the
			// same one-entry trace, the reason naming the prior row and its status. `failed` rows are
			// never offered to the lookup (the same rule planGoal already applies), so a row the pool
			// already gave up on can never block its successor.
			const live: LiveRow[] = this.#db
				.all<{ id: string; title: string; files: string; required_capabilities: string; status: TaskStatus; created_at: number }>(
					"SELECT id, title, files, required_capabilities, status, created_at FROM tasks WHERE status!='failed'",
				)
				.map((row) => ({
					id: row.id,
					title: row.title,
					files: parseList(row.files),
					caps: parseList(row.required_capabilities),
					status: row.status,
					createdAt: row.created_at,
				}));
			const duplicate = duplicateRefusal({ title: input.title, files: input.files ?? [], caps: required }, live, input.now ?? Date.now());
			if (duplicate !== undefined) {
				this.postBoard({
					type: "DECISION",
					agentId: input.createdBy,
					content: `${duplicate.reason}\n\nREMEDY: ${duplicate.remedy}\nROUTE: ${duplicate.route} — the key that matched, so a reader can re-derive the match.`,
					tags: ["duplicate-refusal", "goal-17"],
				});
				return refusal(duplicate.reason);
			}
		}
		const now = input.now ?? Date.now();
		const deps = [...new Set(input.dependencies ?? [])];
		const next = this.#db.get<{ n: number }>("SELECT COALESCE(MAX(CAST(substr(id, 6) AS INTEGER)), 0) + 1 AS n FROM tasks");
		const id = `task-${next?.n ?? 1}`;
		this.#assertDependencies(id, deps);
		const blocked = deps.some((dep) => {
			const row = this.#db.get<{ status: TaskStatus }>("SELECT status FROM tasks WHERE id=?", dep);
			return row === null || row.status !== "done";
		});
		this.#db.run(
			`INSERT INTO tasks (id, title, description, status, priority, created_by, created_at, updated_at,
			   required_capabilities, files, review_required, attempts)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
			id,
			input.title,
			input.description ?? "",
			blocked ? "blocked" : "ready",
			input.priority ?? 0,
			input.createdBy,
			now,
			now,
			JSON.stringify(required),
			JSON.stringify(input.files ?? []),
			input.reviewRequired ? 1 : 0,
		);
		for (const dep of deps) {
			this.#db.run("INSERT OR IGNORE INTO task_deps (task_id, depends_on) VALUES (?, ?)", id, dep);
		}
		this.#log("task.create", input.createdBy, id, { title: input.title, blocked });
		return this.getTask(id) as SwarmTask;
	}

	#deps(taskId: string): string[] {
		return this.#db.all<{ depends_on: string }>("SELECT depends_on FROM task_deps WHERE task_id=? ORDER BY depends_on", taskId).map((r) => r.depends_on);
	}

	/**
	 * The shape of a task object that exists only in the caller's hand: goal-14's mint refusal. It is
	 * NOT a pool row — no id, no timestamps, no status a `WHERE status=?` query returns — so a refused
	 * mint can be reported without any caller mistaking it for work.
	 */
	#blankTask(): SwarmTask {
		const now = Date.now();
		return {
			id: "",
			title: "",
			description: "",
			status: "refused",
			priority: 0,
			createdBy: "",
			createdAt: now,
			updatedAt: now,
			dependencies: [],
			requiredCapabilities: [],
			files: [],
			review: { required: false },
			attempts: 0,
		};
	}

	/** The whole dependency graph as `task -> [dependencies]`, for cycle walks. */
	#edges(): Map<string, string[]> {
		const edges = new Map<string, string[]>();
		for (const row of this.#db.all<{ task_id: string; depends_on: string }>("SELECT task_id, depends_on FROM task_deps")) {
			const list = edges.get(row.task_id);
			if (list === undefined) edges.set(row.task_id, [row.depends_on]);
			else list.push(row.depends_on);
		}
		return edges;
	}

	/**
	 * Guard run inside the create transaction, before any row is written. An unknown
	 * id, a self-edge, or an edge into a cycle would leave the task `blocked` forever
	 * — `sweep()` can only promote work whose dependencies reach `done` — so the whole
	 * create is refused with the reason instead of inserting a task nobody can claim.
	 */
	#assertDependencies(id: string, deps: string[]): void {
		if (deps.length === 0) return;
		const edges = this.#edges();
		edges.set(id, deps);
		for (const dep of deps) {
			if (dep === id) throw new Error(`dependency_self: ${id} depends on itself`);
			if (this.#db.get<{ id: string }>("SELECT id FROM tasks WHERE id=?", dep) === null) {
				throw new Error(`unknown dependency: ${dep}`);
			}
			const cycle = findCycle(edges, dep);
			if (cycle !== undefined) throw new Error(`dependency_cycle: ${cycle.join(" -> ")}`);
		}
	}

	getTask(id: string): SwarmTask | undefined {
		const row = this.#db.get<TaskRow>("SELECT * FROM tasks WHERE id=?", id);
		return row ? toTask(row, this.#deps(id)) : undefined;
	}

	unresolvedDependencies(id: string): string[] {
		return this.#deps(id).filter((dep) => {
			const row = this.#db.get<{ status: TaskStatus }>("SELECT status FROM tasks WHERE id=?", dep);
			return row === null || row.status !== "done";
		});
	}

	/**
	 * Dependencies of `id` that can never reach `done`, so no `sweep()` will ever promote it:
	 * an id that does not exist (legacy row), a dependency closed as `failed`, or one caught in
	 * a dependency cycle. Strictly stronger than `unresolvedDependencies`, which also counts a
	 * dependency that is merely still running — that one may still finish, these cannot, so a
	 * task carrying one is permanently unclaimable and `fail()` may close it.
	 */
	deadDependencies(id: string): string[] {
		const edges = this.#edges();
		return this.#deps(id).filter((dep) => {
			const row = this.#db.get<{ status: TaskStatus }>("SELECT status FROM tasks WHERE id=?", dep);
			if (row === null || row.status === "failed") return true;
			return findCycle(edges, dep) !== undefined;
		});
	}

	/**
	 * Open tasks (ready/claimed/blocked/review) whose `files` list shares a path with the given
	 * one. Exact path matching only: this exists to expose a possible second writer at publish
	 * time, not to judge whether two tasks are the same work.
	 */
	tasksSharingFiles(files: string[], exclude: string[] = []): SwarmTask[] {
		const wanted = new Set(files);
		if (wanted.size === 0) return [];
		return this.listTasks({ status: ["ready", "claimed", "blocked", "review"], limit: 100 }).filter(
			(task) => !exclude.includes(task.id) && task.files.some((file) => wanted.has(file)),
		);
	}

	/**
	 * Why a `blocked` task cannot be claimed, in the order the causes matter:
	 * `missing: <ids>` (a dependency id that does not exist — legacy rows), `cycle: <path>`
	 * (the dependency graph can never reach `done`), otherwise `waiting` (a real
	 * dependency that is simply not finished). `undefined` for a task that is not blocked.
	 */
	blockedReason(taskId: string): string | undefined {
		const row = this.#db.get<{ status: TaskStatus }>("SELECT status FROM tasks WHERE id=?", taskId);
		if (row === null || row.status !== "blocked") return undefined;
		const deps = this.#deps(taskId);
		const missing = deps.filter((dep) => this.#db.get<{ id: string }>("SELECT id FROM tasks WHERE id=?", dep) === null);
		if (missing.length > 0) return `missing: ${missing.join(", ")}`;
		const edges = this.#edges();
		for (const dep of deps) {
			const cycle = findCycle(edges, dep);
			if (cycle !== undefined) return `cycle: ${cycle.join(" -> ")}`;
		}
		return "waiting";
	}

	listTasks(filter: { status?: TaskStatus | TaskStatus[]; capability?: string; limit?: number; agent?: string } = {}): SwarmTask[] {
		const clauses: string[] = [];
		const params: string[] = [];
		const statuses = filter.status === undefined ? [] : Array.isArray(filter.status) ? filter.status : [filter.status];
		if (statuses.length > 0) {
			clauses.push(`status IN (${statuses.map(() => "?").join(",")})`);
			params.push(...statuses);
		}
		if (filter.agent) {
			clauses.push("(claimed_by = ? OR reviewer = ?)");
			params.push(filter.agent, filter.agent);
		}
		const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
		const rows = this.#db.all<TaskRow>(`SELECT * FROM tasks ${where} ORDER BY priority DESC, created_at ASC LIMIT ?`, ...params, filter.limit ?? 100);
		const tasks = rows.map((row) => toTask(row, this.#deps(row.id)));
		return filter.capability
			? tasks.filter((t) => t.requiredCapabilities.length === 0 || t.requiredCapabilities.includes(filter.capability as string))
			: tasks;
	}

	/**
	 * Completed tasks, newest completion first. For a `done` task `updated_at` *is* the
	 * completion time, so the oldest entry doubles as the start of a window that provably
	 * covers this many completions — what the summary's throughput line pairs its count with.
	 */
	recentDoneTasks(limit = 50): SwarmTask[] {
		return this.#db
			.all<TaskRow>("SELECT * FROM tasks WHERE status='done' ORDER BY updated_at DESC LIMIT ?", limit)
			.map((row) => toTask(row, this.#deps(row.id)));
	}

	#reclaimExpiredLocked(now: number): string[] {
		const expired = this.#db.all<{ id: string; claimed_by: string | null }>(
			"SELECT id, claimed_by FROM tasks WHERE status='claimed' AND lease_until IS NOT NULL AND lease_until < ?",
			now,
		);
		for (const row of expired) {
			this.#db.run(
				"UPDATE tasks SET status='ready', claimed_by=NULL, claimed_at=NULL, lease_until=NULL, updated_at=? WHERE id=?",
				now,
				row.id,
			);
			this.#log("task.reclaim", row.claimed_by ?? undefined, row.id, { reason: "lease-expired" });
		}
		const staleReviews = this.#db.all<{ id: string; reviewer: string | null }>(
			"SELECT id, reviewer FROM tasks WHERE status='review' AND review_lease_until IS NOT NULL AND review_lease_until < ?",
			now,
		);
		for (const row of staleReviews) {
			this.#db.run("UPDATE tasks SET reviewer=NULL, review_lease_until=NULL WHERE id=?", row.id);
			this.#log("review.release", row.reviewer ?? undefined, row.id, { reason: "lease-expired" });
		}
		return expired.map((r) => r.id);
	}

	/** Promote blocked tasks whose dependencies all completed. Returns promoted ids. */
	#promoteLocked(now: number): string[] {
		const blocked = this.#db.all<{ id: string }>("SELECT id FROM tasks WHERE status='blocked'");
		const promoted: string[] = [];
		for (const row of blocked) {
			if (this.unresolvedDependencies(row.id).length === 0) {
				this.#db.run("UPDATE tasks SET status='ready', updated_at=? WHERE id=?", now, row.id);
				promoted.push(row.id);
			}
		}
		return promoted;
	}

	/**
	 * Housekeeping: expire leases, stale reservations, stale agents, promote unblocked work, and settle
	 * every vote round whose bound has passed. Vote settlement rides THIS clock on purpose: the beat
	 * already pays for the sweep every `heartbeatSeconds`, so a timed-out decision is denied with no extra
	 * wake, no poll and no model call (goal-8 rule 3).
	 */
	sweep(offlineAfterSeconds = 60): { reclaimed: string[]; promoted: string[]; settledVotes: string[] } {
		const now = Date.now();
		const result = this.#db.transaction(() => {
			const reclaimed = this.#reclaimExpiredLocked(now);
			const promoted = this.#promoteLocked(now);
			this.#db.run("DELETE FROM reservations WHERE lease_until < ?", now);
			return { reclaimed, promoted };
		});
		this.markStaleAgentsOffline(offlineAfterSeconds);
		const settledVotes = this.settleVotes(offlineAfterSeconds, now).map((vote) => vote.id);
		return { ...result, settledVotes };
	}

	/**
	 * Atomic claim. Two agents racing for the same task: exactly one wins,
	 * because the row-level guard (`status='ready'`) is evaluated inside a write
	 * transaction that SQLite serializes.
	 */
	claim(taskId: string, agentId: string, leaseSeconds: number, capabilities: string[] = []): ClaimResult {
		const now = Date.now();
		return this.#db.transaction(() => {
			this.#reclaimExpiredLocked(now);
			this.#promoteLocked(now);
			const row = this.#db.get<TaskRow>("SELECT * FROM tasks WHERE id=?", taskId);
			if (row === null) return { ok: false, reason: `unknown task ${taskId}` };
			const unmet = this.unresolvedDependencies(taskId);
			if (unmet.length > 0) return { ok: false, reason: `blocked by dependencies: ${unmet.join(", ")}` };
			const required = parseList(row.required_capabilities);
			const missing = required.filter((cap) => !capabilities.includes(cap));
			if (missing.length > 0) return { ok: false, reason: `missing capabilities: ${missing.join(", ")}` };
			const updated = this.#db.run(
				`UPDATE tasks SET status='claimed', claimed_by=?, author=?, claimed_at=?, lease_until=?, updated_at=?, attempts=attempts+1
				 WHERE id=? AND status='ready'`,
				agentId,
				agentId,
				now,
				now + leaseSeconds * 1000,
				now,
				taskId,
			);
			if (updated.changes !== 1) return { ok: false, reason: `task ${taskId} is ${row.status}` };
			this.#db.run("UPDATE agents SET status='working', current_task=?, heartbeat_at=? WHERE id=?", taskId, now, agentId);
			this.#log("task.claim", agentId, taskId, { leaseSeconds });
			return { ok: true, task: this.getTask(taskId) };
		});
	}

	renew(taskId: string, agentId: string, leaseSeconds: number): boolean {
		const now = Date.now();
		const result = this.#db.run(
			"UPDATE tasks SET lease_until=?, updated_at=? WHERE id=? AND claimed_by=? AND status='claimed'",
			now + leaseSeconds * 1000,
			now,
			taskId,
			agentId,
		);
		if (result.changes === 1) this.#log("task.renew", agentId, taskId);
		return result.changes === 1;
	}

	release(taskId: string, agentId: string, reason = "released"): boolean {
		const now = Date.now();
		return this.#db.transaction(() => {
			const result = this.#db.run(
				`UPDATE tasks SET status='ready', claimed_by=NULL, claimed_at=NULL, lease_until=NULL, updated_at=?
				 WHERE id=? AND claimed_by=? AND status='claimed'`,
				now,
				taskId,
				agentId,
			);
			if (result.changes !== 1) return false;
			this.#settleAgent(agentId, now);
			this.#log("task.release", agentId, taskId, { reason });
			return true;
		});
	}

	/**
	 * Hand a STALLED hold back to the pool. Same state transition as a lease expiry (the row becomes
	 * claimable, the holder loses it) but a different cause, a different event (`task.takeover`) and a
	 * reason the board can read: the holder was alive but the work stopped moving.
	 *
	 * Only ever called by the round watchdog, which has already decided the silence is past the limit -
	 * a task with a producing holder is never taken. Returns the agent it was taken from so the caller
	 * can say so out loud, and refuses (ok: false) when the row is no longer held, so a race with the
	 * holder's own release or completion is a no-op rather than a second takeover.
	 */
	reclaimStalled(taskId: string, reason: string): { ok: boolean; previous?: string } {
		const now = Date.now();
		return this.#db.transaction(() => {
			const row = this.#db.get<TaskRow>("SELECT * FROM tasks WHERE id=?", taskId);
			if (row === null || row.status !== "claimed") return { ok: false };
			const changed = this.#db.run(
				"UPDATE tasks SET status='ready', claimed_by=NULL, claimed_at=NULL, lease_until=NULL, updated_at=? WHERE id=? AND status='claimed'",
				now,
				taskId,
			);
			if (changed.changes !== 1) return { ok: false };
			const previous = row.claimed_by ?? undefined;
			this.#log("task.takeover", previous, taskId, { reason });
			if (previous !== undefined) this.#settleAgent(previous, now);
			return { ok: true, previous };
		});
	}

	complete(
		taskId: string,
		agentId: string,
		options: { summary: string; commit?: string; files?: string[]; reviewRequired?: boolean; reviewEnabled?: boolean },
	): { ok: boolean; task?: SwarmTask; reason?: string } {
		const now = Date.now();
		return this.#db.transaction(() => {
			const row = this.#db.get<TaskRow>("SELECT * FROM tasks WHERE id=?", taskId);
			if (row === null) return { ok: false, reason: `unknown task ${taskId}` };
			if (row.status !== "claimed" || row.claimed_by !== agentId) {
				return { ok: false, reason: `task ${taskId} is ${row.status}${row.claimed_by ? ` by ${row.claimed_by}` : ""}` };
			}
			const needsReview = (options.reviewRequired ?? row.review_required === 1) && options.reviewEnabled !== false;
			this.#db.run(
				`UPDATE tasks SET status=?, result=?, commit_ref=?, files=?, claimed_by=NULL, claimed_at=NULL, lease_until=NULL,
				   review_required=?, review_status=?, reviewer=NULL, review_lease_until=NULL, updated_at=?
				 WHERE id=?`,
				needsReview ? "review" : "done",
				options.summary,
				options.commit ?? row.commit_ref,
				JSON.stringify(options.files ?? parseList(row.files)),
				needsReview ? 1 : 0,
				needsReview ? "pending" : null,
				now,
				taskId,
			);
			this.#settleAgent(agentId, now);
			const promoted = needsReview ? [] : this.#promoteLocked(now);
			this.#log("task.complete", agentId, taskId, { review: needsReview, promoted });
			return { ok: true, task: this.getTask(taskId) };
		});
	}

	/**
	 * Fail a task. With no `unroutable` option this behaves exactly as it always has: the holder, or
	 * unheld residue whose dependencies can never reach `done`.
	 */
	fail(taskId: string, agentId: string, reason: string, unroutable?: UnroutableClose): { ok: boolean; task?: SwarmTask; reason?: string } {
		const now = Date.now();
		const result = this.#db.transaction(() => {
			const row = this.#db.get<TaskRow>("SELECT * FROM tasks WHERE id=?", taskId);
			if (row === null) return { ok: false, reason: `unknown task ${taskId}` };
			const held = row.status === "claimed" && row.claimed_by === agentId;
			// A task nobody holds and that sits outside every route to `done` may still be closed:
			// that is the only exit the pool offers for permanently-blocked residue (there is no
			// delete or archive), and a `retryTask` on such a row can leave it unclaimable in `ready`.
			// Everything else belongs to its holder.
			const dead = this.deadDependencies(taskId);
			const closable =
				row.claimed_by === null && (row.status === "blocked" || row.status === "ready") && dead.length > 0;
			// The OTHER way a row can be impossible, which the residue exit cannot reach: nobody holds it,
			// every dependency is satisfied, and no agent ONLINE could claim it even if it tried. Only the
			// caller can ask for this (it names the offline window), and the guards below are what keep it
			// from ever closing work a capable agent could still take.
			const stranded = !closable && unroutable !== undefined && this.#stranded(row, taskId, unroutable, now);
			if (!held && !closable && !stranded) {
				return { ok: false, reason: `task ${taskId} is ${row.status}${row.claimed_by ? ` by ${row.claimed_by}` : ""}${this.#failHint(row, taskId, unroutable, now)}` };
			}
			this.#db.run(
				"UPDATE tasks SET status='failed', result=?, claimed_by=NULL, claimed_at=NULL, lease_until=NULL, updated_at=? WHERE id=?",
				reason,
				now,
				taskId,
			);
			// Only the holder goes idle: closing someone else's dead residue must not clear the
			// caller's own current_task.
			if (held) this.#settleAgent(agentId, now);
			this.#log("task.fail", agentId, taskId, { reason, closed: !held, deadDependencies: dead, stranded });
			return { ok: true, task: this.getTask(taskId) };
		});
		if (result.ok) this.postBoard({ type: "FAIL", agentId, taskId, content: reason, tags: ["failure"] });
		return result;
	}

	/**
	 * Whether an unheld row is unclaimable by EVERY online agent — the only case the unroutable exit
	 * may close. Every guard is a refusal: the row is unheld and actionable, it has been undisturbed
	 * for the grace window, its dependencies are all satisfied, it actually declares capabilities, and
	 * at least one agent is online while none of them holds the whole set (`claim()` needs every
	 * declared capability on the ONE agent that takes it). An empty roster is deliberately NOT enough:
	 * a pool between batches must never become a licence to close ready work.
	 */
	#stranded(row: TaskRow, taskId: string, options: UnroutableClose, now: number): boolean {
		if (row.claimed_by !== null || (row.status !== "ready" && row.status !== "blocked")) return false;
		if (now - row.updated_at < (options.graceMs ?? UNROUTABLE_GRACE_MS)) return false;
		if (this.unresolvedDependencies(taskId).length > 0) return false;
		const required = parseList(row.required_capabilities);
		if (required.length === 0) return false;
		const online = this.listAgents().filter(
			(agent) => agent.status !== "offline" && now - agent.heartbeatAt <= options.offlineAfterMs,
		);
		if (online.length === 0) return false;
		return !online.some((agent) => required.every((cap) => agent.capabilities.includes(cap)));
	}

	/**
	 * Which guard refused an unheld actionable row, so a caller is not left guessing.
	 *
	 * goal-18's U4: this used to be ONE sentence for five different guards, and the sentence it
	 * chose ("an online agent can still claim it") is TRUE BY DEFINITION for a `caps=[]` row — which
	 * is precisely the shape the unroutable exit refuses at `required.length === 0`. A reader could
	 * not tell "this row will never be closable" from "this row is not old enough yet". The ladder's
	 * guards are now named in the order `#stranded` evaluates them, so the reason is auditable
	 * instead of plausible.
	 */
	#failHint(row: TaskRow, taskId: string, unroutable?: UnroutableClose, now = Date.now()): string {
		if (row.claimed_by !== null || (row.status !== "ready" && row.status !== "blocked")) return "";
		if (unroutable === undefined) return " (nothing here can close it: no dependency of it is dead)";
		if (now - row.updated_at < (unroutable.graceMs ?? UNROUTABLE_GRACE_MS)) {
			return ` (it has not been stranded for the grace window: ${Math.max(0, Math.round((now - row.updated_at) / 1000))}s of ${Math.round((unroutable.graceMs ?? UNROUTABLE_GRACE_MS) / 1000)}s)`;
		}
		if (this.unresolvedDependencies(taskId).length > 0) return " (it still has unresolved dependencies)";
		const required = parseList(row.required_capabilities);
		if (required.length === 0) {
			return " (it declares no capability at all, so every agent can claim it: the unroutable exit is not for `caps=[]` rows — it is for a capability nobody holds)";
		}
		const online = this.listAgents().filter(
			(agent) => agent.status !== "offline" && now - agent.heartbeatAt <= unroutable.offlineAfterMs,
		);
		if (online.length === 0) {
			return " (no agent is online, and a pool between batches must never become a licence to close ready work)";
		}
		return " (an online agent holds its full capability set)";
	}

	/**
	 * Revive a `failed` or `blocked` task: the failed status is cleared and a fresh attempt
	 * recorded, so a dead end is not permanent — dependents of a failed task are promoted by the
	 * usual `sweep()` once it completes. A task whose own dependencies are still unresolved
	 * stays `blocked`: a `ready` row nobody can claim is worse than an honest `blocked` one —
	 * it counts as actionable (so it hides the stall notice and grows the roster) while `claim()`
	 * refuses it forever when the dependency is `failed`. Refuses any other status (a claimed/done
	 * task is owned by someone, or already finished).
	 *
	 * goal-17's L1: a retry now consults {@link retryGate} against the row's own failure reason
	 * before it revives anything. The measured loop this stops is in `.swarm/swarm.db`: 45 rows in
	 * `failed`, 41 of them naming one repeatable cause family (`duplicate`/`superseded`), with no
	 * gate anywhere saying "the same cause has already failed this deliverable N times". The gate's
	 * memory is the row's own `task.retry` events, so the counter persists across processes the
	 * way the spec requires, and a held retry leaves one board entry naming the family and the
	 * remedy — a stop nobody can audit is the prose-sentence failure mode `planGoal`'s `skipped`
	 * already cost this pool once.
	 */
	retryTask(taskId: string, reason?: string, agentId?: string): { ok: boolean; task?: SwarmTask; reason?: string } {
		const now = Date.now();
		const gate = this.#db.transaction(() => {
			const row = this.#db.get<TaskRow>("SELECT * FROM tasks WHERE id=?", taskId);
			if (row === null) return { ok: false, reason: `unknown task ${taskId}` } as const;
			if (row.status !== "failed" && row.status !== "blocked") {
				return { ok: false, reason: `task ${taskId} is ${row.status}, not failed or blocked` } as const;
			}
			const prior = this.#db.all<{ created_at: number; data: string }>(
				"SELECT created_at, data FROM events WHERE type='task.retry' AND task_id=? ORDER BY id",
				taskId,
			);
			const memory: RetryMemory = { familyKey: undefined, lastAt: 0, count: 0 };
			let firstSeenAt: number | undefined;
			for (const entry of prior) {
				const data = JSON.parse(entry.data) as { family?: string };
				if (data.family === undefined) continue;
				if (firstSeenAt === undefined) firstSeenAt = entry.created_at;
				memory.familyKey = data.family;
				memory.lastAt = entry.created_at;
				memory.count += 1;
			}
			const decision = retryGate({
				deliverable: deliverableKey(row.title),
				reason: row.result ?? "",
				attempt: row.attempts + 1,
				now,
				memory,
			});
			if (!decision.allow) {
				// The hold is traced twice: the event keeps the audit chain unbroken (a silent
				// refusal is what the old starvation latch was), and the board entry carries the
				// remedy. Both are written INSIDE the transaction, so a retry that writes one
				// cannot lose the other.
				this.#log("task.retry.held", agentId, taskId, { family: decision.family, rule: decision.rule, reason: decision.reason });
				const escalation = retryEscalation({ taskId, deliverable: deliverableKey(row.title), decision, firstSeenAt, now });
				this.postBoard({
					type: "DECISION",
					agentId: agentId ?? "unknown",
					taskId,
					content: escalation.content,
					tags: escalation.tags,
				});
				return { ok: false, reason: decision.reason } as const;
			}
			const claimable = this.unresolvedDependencies(taskId).length === 0;
			this.#db.run(
				`UPDATE tasks SET status=?, claimed_by=NULL, claimed_at=NULL, lease_until=NULL,
				   attempts=attempts+1, updated_at=?
				 WHERE id=?`,
				claimable ? "ready" : "blocked",
				now,
				taskId,
			);
			// The family travels with the retry event, so the NEXT retry of this row can count the
			// same cause without reading the reason again: the counter is the cause family, not the
			// row id, which is the same lesson `boardClassKey`'s `task-\d+` exclusion carries.
			this.#log("task.retry", agentId, taskId, { from: row.status, reason, claimable, family: decision.family });
			return { ok: true, task: this.getTask(taskId), reason } as const;
		});
		return gate;
	}

	// ----------------------------------------------------------------- goals

	/**
	 * Open a goal's planning round: the goal row plus the ONE planning task whose first claimer
	 * becomes the scribe. One transaction, so a goal can never exist without its planning task.
	 *
	 * goal-17's L3: before the round opens, the board's own conclusions are retrieved and INJECTED
	 * into the planning task's brief, so the coordinator that opens the round and the scribe that
	 * merges it start from what earlier rounds already settled instead of re-diagnosing it. The
	 * operator's measurement is the reason: 200 board entries mention the reviewer-capability knot
	 * across eight separate goals, and the knot was re-derived more than once. Injection, not
	 * refusal — measured on the 17 live goals, a goal-level duplicate refusal would refuse nothing
	 * (0 fingerprint collisions), so the honest shipped shape is the one the goal's own text names
	 * ("只做注入不做拒绝"). The verdict is still computed and reported, so a future surface with real
	 * collisions is one flag away from refusing.
	 */
	createGoal(input: { goal: string; agents: number; createdBy: string; deadlineMs?: number; now?: number }): {
		goal: SwarmGoal;
		planningTask: SwarmTask;
	} {
		const createdAt = input.now ?? Date.now();
		const deadlineMs = input.deadlineMs ?? GOAL_DEADLINE_MS;
		// The ledger is read BEFORE the transaction (it only reads the board), so the brief the
		// planning task carries is complete at insert time and no second write is needed.
		const ledger = this.coordinatorLedger();
		const verdict = goalDuplicateVerdict(ledger, input.goal);
		const injection = ledgerInjection(ledger, input.goal, verdict);
		return this.#db.transaction(() => {
			const next = this.#db.get<{ n: number }>("SELECT COALESCE(MAX(CAST(substr(id, 6) AS INTEGER)), 0) + 1 AS n FROM goals");
			const id = `goal-${next?.n ?? 1}`;
			// The injection is appended at THIS call site rather than added to `planningTaskBrief`'s
			// signature: `planning.ts` is another row's write domain this round, and a caller-side
			// append keeps the brief's own signature (and its tests) untouched. The empty case appends
			// nothing, so a fresh pool's brief is byte-identical to what it was.
			const brief = planningTaskBrief({ id, goal: input.goal, agents: input.agents, createdBy: input.createdBy }, deadlineMs);
			// The planning task is created first so the goal row can carry its id; the brief is built
			// from the same values the row will hold. No `reachable` set: the planning task requires
			// `["general"]`, which every roster carries, and this caller must never refuse a goal's
			// own round over a capability the operator has not configured.
			const planningTask = this.#createTaskLocked({
				title: `Plan ${id}: merge the split proposals into the task graph`,
				description: injection === "" ? brief : `${brief}\n\n${injection}`,
				priority: 10,
				createdBy: input.createdBy,
				requiredCapabilities: ["general"],
			});
			this.#db.run(
				`INSERT INTO goals (id, goal, agents, status, created_by, created_at, updated_at, deadline_at, planning_task)
				 VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
				id,
				input.goal,
				input.agents,
				input.createdBy,
				createdAt,
				createdAt,
				createdAt + deadlineMs,
				planningTask.id,
			);
			this.#log("goal.open", input.createdBy, planningTask.id, {
				goal: id,
				agents: input.agents,
				deadlineMs,
				// goal-17's L3: the counts travel with the event, so the audit trail shows what the
				// round was handed without re-reading the board.
				ledgerRows: ledger.readRows,
				ledgerClasses: ledger.classes.length,
				ledgerAnswered: ledger.answeredCount,
				ledgerDuplicate: verdict.duplicate,
			});
			return { goal: this.getGoal(id) as SwarmGoal, planningTask };
		});
	}

	/**
	 * The conclusions a new goal must be handed (goal-17's L3): the board's FAIL/DECISION classes,
	 * which are already answered and which are still open, with the kind of work each class's own
	 * goals asked for so a new goal's kind can be compared against it.
	 *
	 * Read-only and cheap on the sizes this pool actually has (361 conclusion rows at the time this
	 * was written); the caller's board is capped by {@link LEDGER_READ_LIMIT}, and the whole read is
	 * outside any write transaction so it can never hold a lock.
	 */
	coordinatorLedger(limit = LEDGER_READ_LIMIT): GoalLedger {
		const rows = this.#db
			.all<{ id: number; type: BoardType; agent_id: string; tags: string }>(
				"SELECT id, type, agent_id, tags FROM board WHERE type IN ('FAIL','DECISION') ORDER BY id DESC LIMIT ?",
				limit,
			)
			.map((row) => ({ id: row.id, type: row.type, agentId: row.agent_id, tags: parseList(row.tags) }));
		// The kind each goal asked for: the ledger needs it to compare a new goal's kind against the
		// kind that produced an existing class. Goals are few, so one pass is enough.
		const kindsByGoal = new Map<string, GoalKind>();
		for (const row of this.#db.all<{ id: string; goal: string }>("SELECT id, goal FROM goals")) {
			kindsByGoal.set(row.id, goalKind(row.goal));
		}
		return goalLedger(rows, kindsByGoal, limit);
	}

	getGoal(id: string): SwarmGoal | undefined {
		const row = this.#db.get<GoalRow>("SELECT * FROM goals WHERE id=?", id);
		return row ? toGoal(row) : undefined;
	}

	/** Goals whose planning round is still open, oldest first. */
	liveGoals(): SwarmGoal[] {
		return this.#db.all<GoalRow>("SELECT * FROM goals WHERE status='open' ORDER BY created_at, id").map(toGoal);
	}

	/** The goal a task belongs to, when that task is the goal's planning task. */
	goalForPlanningTask(taskId: string): SwarmGoal | undefined {
		const row = this.#db.get<GoalRow>("SELECT * FROM goals WHERE planning_task=?", taskId);
		return row ? toGoal(row) : undefined;
	}

	/**
	 * The split proposals of one round, oldest first. A proposal is an ordinary board entry: the
	 * `proposal` tag makes it identifiable, and the entry's task_id IS the goal's planning task, so
	 * the query scopes the round exactly (two goals cannot mix their proposals).
	 */
	listProposals(goal: SwarmGoal): Proposal[] {
		return this.searchBoard({ taskId: goal.planningTask, tags: [PROPOSAL_TAG], limit: 500 })
			.map(parseProposal)
			.filter((proposal): proposal is Proposal => proposal !== undefined)
			.sort((a, b) => a.entryId - b.entryId);
	}

	/** Post one worker's split: a board entry, so it is visible to the whole swarm, not a side table. */
	postProposal(goal: SwarmGoal, agentId: string, tasks: unknown): BlackboardEntry {
		return this.postBoard({
			type: "OBSERVATION",
			agentId,
			taskId: goal.planningTask,
			content: JSON.stringify({ goal: goal.id, tasks }, null, 2),
			tags: [PROPOSAL_TAG, goalTag(goal.id)],
		});
	}

	/**
	 * The scribe's convergence step. Exactly once by construction:
	 * - the election is `claim()` on the planning task (atomic, lease-backed); this refuses a caller
	 *   that does not hold it, so a lease expiry hands the round to the next claimer;
	 * - the whole write is ONE transaction that first re-checks the goal is still `open`, so two
	 *   scribes can never both pour a plan into the same goal;
	 * - creation is idempotent against the pool: a deliverable a live task already carries is
	 *   skipped (and reported), so a scribe that dies mid-merge cannot duplicate the rows it wrote.
	 */
	planGoal(goalId: string, agentId: string, options: { ceiling?: number; config?: SwarmConfig } = {}): PlanResult {
		const now = Date.now();
		const created: string[] = [];
		const skipped: { title: string; id: string; route?: "exact" | "spelling" }[] = [];
		// Merge key -> the task row that carries it, created or already in the pool: the DECISION's
		// fold mapping needs it after the transaction has committed.
		const idByKey = new Map<string, string>();
		let proposals = 0;
		let folded: string[] = [];
		let folds: MergeFold[] = [];
		let unresolved: { task: string; dep: string }[] = [];
		let peak = 0;
		let recommended = 0;
		// goal-14 clause 1 at the store's mint site: when the caller supplies the config, the same
		// reachability set 495ec30's merge guard uses reaches every INSERT this round makes, so a
		// merged row nobody could claim is refused instead of minted. Absent config, nothing changes.
		const reachable = options.config === undefined ? undefined : reachableCapabilities(options.config);
		let outcome: PlanResult;
		try {
			outcome = this.#db.transaction((): PlanResult => {
			const refuse = (reason: string): PlanResult => ({ ok: false, created, skipped, proposals, folded, folds, unresolved, peak, recommended, reason });
			const goal = this.getGoal(goalId);
			if (goal === undefined) return refuse(`unknown goal ${goalId}`);
			if (goal.status !== "open") return refuse(`goal ${goalId} is ${goal.status}`);
			const planning = this.getTask(goal.planningTask);
			if (planning === undefined) return refuse(`goal ${goalId} has no planning task row`);
			if (planning.status !== "claimed" || planning.claimedBy !== agentId) {
				return refuse(
					`the planning task ${goal.planningTask} is not claimed by ${agentId} - claim it first; the first claimer is the scribe`,
				);
			}
			const round = this.listProposals(goal);
			proposals = round.length;
			if (round.length < MIN_PROPOSALS) {
				return refuse(`no split proposal for ${goalId} yet; post yours with swarm_propose, or wait for the other workers`);
			}
			const merge = mergeProposals(round, reachable);
			folded = merge.folded;
			folds = merge.folds;
			unresolved = merge.unresolved;
			if (merge.tasks.length === 0) return refuse(`the ${round.length} proposal(s) for ${goalId} carry no usable task`);
			// The plan states its own size: how wide the round can run, and the agent count that
			// implies (capped by the caller's ceiling). That is the answer to "N was wrong" before
			// anyone starts working, and it is what an agent can point at when asking to rescale.
			peak = peakParallelism(merge.tasks);
			recommended = options.ceiling === undefined || options.ceiling <= 0 ? peak : Math.min(peak, options.ceiling);
			// A `failed` row is not a deliverable the pool holds: only live/finished work dedupes.
			const keys = new Map<string, string>();
			const heldShapes: { shape: DeliverableShape; id: string }[] = [];
			// goal-17's L2: the identity key's view of the same live rows, so the merge loop can ask
			// the exact route beside the spelling route it already consults. `failed` rows are
			// excluded here too, by the same rule, so a row the pool gave up on never blocks its
			// successor (task-252's A5).
			const liveRowsForDedupe: LiveRow[] = [];
			for (const task of this.listTasks({ limit: 1000 })) {
				if (task.status === "failed") continue;
				keys.set(deliverableKey(task.title), task.id);
				heldShapes.push({ shape: describeDeliverable(task.title, task.files), id: task.id });
				liveRowsForDedupe.push({ id: task.id, title: task.title, files: task.files, caps: task.requiredCapabilities, status: task.status, createdAt: task.createdAt });
			}
			for (const merged of orderForCreation(merge.tasks).ordered) {
				// The pool dedupes by the same deliverable rule the round does, so a re-takeover after a
				// scribe dies recognises work an earlier round already created under other wording. The
				// predicate is deliberately NARROWER here than in the round: an unrelated finished row
				// that merely names the same file must not swallow a new round's writer row, which is
				// how goal-11's line A lost its only writer (its files were task-112's files).
				const shape = describeDeliverable(merged.title, merged.files);
				const existing =
					keys.get(merged.key) ??
					heldShapes
						.map((held) => ({ held, skip: poolSkipReason(held.shape, shape) }))
						.find((candidate) => candidate.skip !== undefined)?.held.id;
				// goal-17's L2 / task-252's G3b: the identity key is asked HERE, before the mint, not
				// discovered from it. A refusal inside this loop throws `MintRefused` and rolls the
				// WHOLE round back, so a round carrying one duplicate row beside nine fresh ones would
				// lose all ten; the pre-check skips instead and records which ROUTE matched, so the
				// plan DECISION's existing skipped line says why. The existing `skipped` mechanism is
				// reused rather than replaced — a second skip vocabulary is the "second key" failure.
				const mergedKey = identityKeyOf(merged.title, merged.files, merged.capabilities).key;
				const duplicateRow = liveRowsForDedupe.find((row) => identityKeyOf(row.title, row.files, row.caps).key === mergedKey);
				// The contract's order is exact → spelling → class, and the route that fired is what
				// the reason names: an exact hit has the key to show, a spelling hit has the wording.
				if (duplicateRow !== undefined) {
					skipped.push({ title: merged.title, id: duplicateRow.id, route: "exact" });
					idByKey.set(merged.key, duplicateRow.id);
					continue;
				}
				if (existing !== undefined) {
					skipped.push({ title: merged.title, id: existing, route: "spelling" });
					idByKey.set(merged.key, existing);
					continue;
				}
				const dependencies = merged.dependsOn.map((key) => keys.get(key)).filter((id): id is string => id !== undefined);
				const row = this.#createTaskLocked({
					title: merged.title,
					description: mergedTaskDescription(merged, goal, agentId),
					createdBy: agentId,
					dependencies,
					requiredCapabilities: merged.capabilities,
					files: merged.files,
					reviewRequired: merged.reviewRequired,
					// goal-14 clause 1, at the store's mint site: the same reachability set 495ec30's
					// merge guard reports with reaches every INSERT this round makes.
					reachable,
				});
				if (row.status === "refused") {
					// A merge whose row nobody can claim is not a plan: refuse the whole round rather
					// than create the strand it was supposed to prevent. The transaction rolls the whole
					// round back on this throw, and the reason is already on the board (the mint
					// refusal), so the scribe's reply and the board agree.
					throw new MintRefused(row.mintRefusal ?? "the row's capability is unreachable");
				}
				keys.set(merged.key, row.id);
				idByKey.set(merged.key, row.id);
				created.push(row.id);
			}
			const summary = `${created.length} task(s) from ${round.length} proposal(s)`;
			this.#db.run(
				"UPDATE goals SET status='planned', planner=?, planned_at=?, updated_at=?, result=? WHERE id=? AND status='open'",
				agentId,
				now,
				now,
				summary,
				goalId,
			);
			this.#log("goal.planned", agentId, goal.planningTask, {
				goal: goalId,
				created: created.length,
				proposals: round.length,
				folded: folded.length,
			});
			return { ok: true, goal: this.getGoal(goalId) as SwarmGoal, created, skipped, proposals, folded, folds, unresolved, peak, recommended };
			});
		} catch (error) {
			// A refused mint inside the round is DATA, not a crash: the round is refused with the mint
			// refusal's own reason, and the transaction already rolled the whole round back. The reason
			// is on the board too (the mint refusal), so the scribe's reply and the board agree.
			if (error instanceof MintRefused) {
				return { ok: false, created: [], skipped: [], proposals, folded, folds, unresolved, peak, recommended, reason: error.message };
			}
			throw error;
		}
		// The merged split is announced AFTER the write: the DECISION is the round's public record,
		// never a correctness dependency of the plan itself.
		if (outcome.ok && outcome.goal !== undefined) {
			const lines = [
				`${outcome.goal.id} planned by ${agentId}: ${created.length} task(s) from ${proposals} proposal(s).`,
				`SIZE: peak parallelism ${peak} of ${created.length} task(s) can run at once; recommended agents ${recommended}${options.ceiling === undefined || options.ceiling <= 0 ? "" : ` (ceiling ${options.ceiling})`}. Ask for a different size with swarm_scale({ agents, reason }) if the shape changes.`,
				DEDUPE_KEY_TEXT,
				...created.map((id) => {
					const task = this.getTask(id) as SwarmTask;
					return [
						`- ${id} ${task.title}`,
						task.requiredCapabilities.length > 0 ? ` [${task.requiredCapabilities.join(", ")}]` : "",
						task.files.length > 0 ? ` files: ${task.files.join(", ")}` : "",
						task.dependencies.length > 0 ? ` after ${task.dependencies.join(", ")}` : "",
					].join("");
				}),
			];
			if (folds.length > 0) {
				lines.push(`folded ${folds.length} duplicate row(s) into ${folded.length} deliverable(s):`);
				// The audit trail: WHAT folded into WHAT, and why. "folded 2 duplicates" told the operator
				// nothing, which is exactly how goal-5's four spellings of one report stayed invisible.
				for (const fold of folds) lines.push(`  "${fold.title}" -> ${idByKey.get(fold.into) ?? fold.into} (${fold.reason})`);
			}
			if (skipped.length > 0) lines.push(`skipped (a live task already carries them): ${skipped.map((s) => `${s.title} -> ${s.id} [${s.route ?? "spelling"}]`).join(", ")}`);
			if (unresolved.length > 0) lines.push(`dropped unresolvable dependency reference(s): ${unresolved.map((d) => `${d.task} <- ${d.dep}`).join(", ")}`);
			this.postBoard({
				type: "DECISION",
				agentId,
				taskId: outcome.goal.planningTask,
				content: lines.join("\n"),
				tags: ["plan", goalTag(goalId)],
			});
		}
		return outcome;
	}

	/**
	 * The round's hard exit: an `open` goal past its deadline is closed `failed`, its unclaimed
	 * planning task is closed with it (never left behind as claimable work), and a FAIL lands on the
	 * board so both the pool and the operator see WHY nothing happened. A CLAIMED planning task is
	 * left to its holder: the goal is already failed, and `planGoal` refuses a non-open goal, so a
	 * slow scribe can only report the failure, never resurrect the round.
	 */
	closeExpiredGoals(now = Date.now()): SwarmGoal[] {
		const closed = this.#db.transaction(() => {
			const out: { goal: SwarmGoal; reason: string }[] = [];
			for (const row of this.#db.all<GoalRow>("SELECT * FROM goals WHERE status='open' AND deadline_at <= ? ORDER BY created_at, id", now)) {
				const reason = `planning round for ${row.id} hit its bound (${Math.round((now - row.created_at) / 1000)}s) with no plan; closed as failed`;
				const changed = this.#db.run(
					"UPDATE goals SET status='failed', result=?, updated_at=? WHERE id=? AND status='open'",
					reason,
					now,
					row.id,
				);
				if (changed.changes !== 1) continue;
				this.#db.run(
					`UPDATE tasks SET status='failed', result=?, claimed_by=NULL, claimed_at=NULL, lease_until=NULL, updated_at=?
					 WHERE id=? AND status IN ('ready','blocked')`,
					reason,
					now,
					row.planning_task,
				);
				this.#log("goal.fail", row.created_by, row.planning_task, { goal: row.id, reason });
				out.push({ goal: this.getGoal(row.id) as SwarmGoal, reason });
			}
			return out;
		});
		for (const { goal, reason } of closed) {
			this.postBoard({ type: "FAIL", agentId: goal.createdBy, taskId: goal.planningTask, content: reason, tags: ["failure", goalTag(goal.id)] });
		}
		return closed.map((entry) => entry.goal);
	}

	/**
	 * The round's OTHER hard exit, for a round whose scribes are gone rather than slow: the watchdog
	 * has already taken the planning task {@link MAX_SCRIBE_ATTEMPTS} times, so the round is closed
	 * `failed` with a reason that says so - explicitly, minutes before the bound would have done it
	 * silently, and with the same FAIL on the board the bound posts. A stuck round therefore never
	 * spins: it either gets a plan or it gets a reason.
	 *
	 * The planning row is closed in the SAME transaction whatever it is doing (unlike the bound, which
	 * leaves a claimed row to its holder): the holder is, by the watchdog's own finding, not producing,
	 * and leaving it claimed would keep the round unrunnable with the goal already failed.
	 */
	closeStalledGoal(goalId: string, reason: string): SwarmGoal | undefined {
		const closed = this.#db.transaction((): SwarmGoal | undefined => {
			const now = Date.now();
			const changed = this.#db.run("UPDATE goals SET status='failed', result=?, updated_at=? WHERE id=? AND status='open'", reason, now, goalId);
			if (changed.changes !== 1) return undefined;
			this.#db.run(
				`UPDATE tasks SET status='failed', result=?, claimed_by=NULL, claimed_at=NULL, lease_until=NULL, updated_at=?
				 WHERE id=? AND status IN ('ready','blocked','claimed')`,
				reason,
				now,
				this.getGoal(goalId)?.planningTask ?? "",
			);
			const goal = this.getGoal(goalId);
			if (goal === undefined) return undefined;
			this.#log("goal.fail", goal.createdBy, goal.planningTask, { goal: goalId, reason });
			return goal;
		});
		if (closed !== undefined) {
			this.postBoard({
				type: "FAIL",
				agentId: closed.createdBy,
				taskId: closed.planningTask,
				content: closed.result ?? reason,
				tags: ["failure", goalTag(closed.id)],
			});
		}
		return closed;
	}

	// --------------------------------------------------------------- scaling

	/**
	 * Record an agent's ask for a different pool size. Advisory on purpose: the row IS the audit trail
	 * (who asked, why, what the pool looked like when they asked), and the AutoController remains the
	 * only actor that ever changes the pool. The event is written in the same transaction, so the
	 * record and the trail cannot diverge.
	 */
	recordScaleRequest(input: { agentId: string; requested: number; reason: string; current: number }): ScaleRequest {
		return this.#db.transaction(() => {
			const now = Date.now();
			const inserted = this.#db.run(
				"INSERT INTO scale_requests (agent_id, reason, requested, current, created_at) VALUES (?, ?, ?, ?, ?)",
				input.agentId,
				input.reason,
				input.requested,
				input.current,
				now,
			);
			const id = Number(inserted.lastInsertRowid);
			this.#log("scale.request", input.agentId, undefined, { id, requested: input.requested, current: input.current });
			return this.#scaleRequest(id) as ScaleRequest;
		});
	}

	#scaleRequest(id: number): ScaleRequest | undefined {
		const row = this.#db.get<ScaleRow>("SELECT * FROM scale_requests WHERE id=?", id);
		return row ? toScaleRequest(row) : undefined;
	}

	/** Asks the controller has not decided yet, oldest first. */
	pendingScaleRequests(): ScaleRequest[] {
		return this.#db.all<ScaleRow>("SELECT * FROM scale_requests WHERE decided_at IS NULL ORDER BY created_at, id").map(toScaleRequest);
	}

	/** Record what the controller did about these asks, so no tick ever applies one twice. */
	decideScaleRequests(ids: number[], action: string, size: number): number {
		if (ids.length === 0) return 0;
		const changed = this.#db.run(
			`UPDATE scale_requests SET decided_at=?, decided_action=?, decided_size=? WHERE id IN (${ids.map(() => "?").join(",")}) AND decided_at IS NULL`,
			Date.now(),
			action,
			size,
			...ids,
		);
		return changed.changes;
	}

	// ----------------------------------------------------------------- votes

	/**
	 * Open a round (goal-8). The operator's policy is FROZEN onto the row, so the arithmetic a decision is
	 * judged by cannot move under it and a later config change can never flip a settled round. A `seed` —
	 * the coordinator's own goal, or an operator instruction — is terminal at once: it never voted
	 * (rule 2), which is what keeps the first task from needing a pool that does not exist yet.
	 */
	openVote(input: {
		kind: DecisionKind;
		question: string;
		payload?: Record<string, unknown>;
		openedBy: string;
		/** The policy in force. A caller may only tighten it, via `resolveVotingConfig` (rule 6). */
		policy: VotingConfig;
		seed?: boolean;
	}): SwarmVote {
		return this.#db.transaction(() => {
			const now = Date.now();
			const next = this.#db.get<{ n: number }>("SELECT COALESCE(MAX(CAST(substr(id, 6) AS INTEGER)), 0) + 1 AS n FROM votes");
			const id = `vote-${next?.n ?? 1}`;
			this.#db.run(
				`INSERT INTO votes (id, kind, question, payload, opened_by, opened_at, deadline_at, threshold, min_base, status, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				id,
				input.kind,
				input.question,
				JSON.stringify(input.payload ?? {}),
				input.openedBy,
				now,
				now + input.policy.timeoutMs,
				input.policy.threshold,
				input.policy.minBase,
				input.seed === true ? "seeded" : "open",
				now,
			);
			this.#log("vote.open", input.openedBy, undefined, {
				vote: id,
				kind: input.kind,
				question: input.question,
				threshold: input.policy.threshold,
				minBase: input.policy.minBase,
				timeoutMs: input.policy.timeoutMs,
				seeded: input.seed === true,
			});
			return this.getVote(id) as SwarmVote;
		});
	}

	/**
	 * Read one round. A round past its own deadline is DENIED the moment anybody looks at it — tick or no
	 * tick (task-197): the read finishes it through the same `#finishVote` path every other settling path
	 * uses, so the `vote_failed` event, the board entry and the opener's inbox land even when no driver beat
	 * ever runs the sweep.
	 */
	getVote(id: string, offlineAfterSeconds = 60, now = Date.now()): SwarmVote | undefined {
		this.#settleIfDue(id, offlineAfterSeconds, now);
		return this.#voteRow(id);
	}

	/** The raw row, with no due-check of its own: the read every settling path is built on (no recursion). */
	#voteRow(id: string): SwarmVote | undefined {
		const row = this.#db.get<VoteRow>("SELECT * FROM votes WHERE id=?", id);
		return row === null ? undefined : this.#toVote(row);
	}

	listVotes(filter: { status?: VoteState; limit?: number } = {}): SwarmVote[] {
		const limit = Math.max(1, Math.min(filter.limit ?? 50, 500));
		const rows =
			filter.status === undefined
				? this.#db.all<VoteRow>("SELECT * FROM votes ORDER BY opened_at DESC LIMIT ?", limit)
				: this.#db.all<VoteRow>("SELECT * FROM votes WHERE status=? ORDER BY opened_at DESC LIMIT ?", filter.status, limit);
		return rows.map((row) => this.#toVote(row));
	}

	#toVote(row: VoteRow): SwarmVote {
		return {
			id: row.id,
			kind: row.kind,
			question: row.question,
			payload: JSON.parse(row.payload) as Record<string, unknown>,
			openedBy: row.opened_by,
			openedAt: row.opened_at,
			deadlineAt: row.deadline_at,
			threshold: row.threshold,
			minBase: row.min_base,
			status: row.status,
			result: row.result ?? undefined,
			updatedAt: row.updated_at,
		};
	}

	/** The ballots cast on a round, oldest first, exactly as `decide()` wants them. */
	ballots(decisionId: string): Vote[] {
		return this.#db
			.all<{ voter: string; approve: number; created_at: number }>(
				"SELECT voter, approve, created_at FROM vote_ballots WHERE decision_id=? ORDER BY created_at, voter",
				decisionId,
			)
			.map((row) => ({ voter: row.voter, approve: row.approve === 1, at: row.created_at }));
	}

	/**
	 * Cast one ballot. One agent, one ballot is the table's primary key, so a repeat is neither a second
	 * vote nor an exception: it is reported and ignored (rule 4).
	 */
	castBallot(decisionId: string, voter: string, approve: boolean, offlineAfterSeconds = 60, now = Date.now()): { ok: boolean; reason?: string } {
		return this.#db.transaction(() => {
			// A ballot that arrives AFTER the bound does not count: the round is denied at its own deadline
			// first, so a late yes cannot pass a round that already timed out.
			this.#settleIfDue(decisionId, offlineAfterSeconds, now);
			const vote = this.#voteRow(decisionId);
			if (vote === undefined) return { ok: false, reason: `unknown vote ${decisionId}` };
			if (vote.status !== "open") return { ok: false, reason: `${decisionId} is already ${vote.status}` };
			const inserted = this.#db.run(
				"INSERT OR IGNORE INTO vote_ballots (decision_id, voter, approve, created_at) VALUES (?, ?, ?, ?)",
				decisionId,
				voter,
				approve ? 1 : 0,
				now,
			);
			if (inserted.changes !== 1) return { ok: false, reason: `${voter} already voted on ${decisionId}: one agent, one ballot` };
			this.#log("vote.ballot", voter, undefined, { vote: decisionId, kind: vote.kind, approve });
			return { ok: true };
		});
	}

	/** The round's own arithmetic, from frozen policy + live roster + ballots. No clock of its own. */
	#outcomeFor(vote: SwarmVote, offlineAfterSeconds: number, now: number): VoteOutcome {
		return decide({
			decision: {
				id: vote.id,
				kind: vote.kind,
				question: vote.question,
				openedBy: vote.openedBy,
				openedAt: vote.openedAt,
				seed: vote.status === "seeded",
			},
			votes: this.ballots(vote.id),
			agents: this.listAgents(),
			now,
			offlineAfterMs: offlineAfterSeconds * 1000,
			policy: { threshold: vote.threshold, minBase: vote.minBase, timeoutMs: vote.deadlineAt - vote.openedAt },
		});
	}

	/**
	 * A round past its own deadline is DENIED the moment anybody looks at it — tick or no tick.
	 *
	 * `deadline_at` used to be consulted only by `settleVotes`, which the driver's beat drives, so with no
	 * beat a due round stayed `open` and the `vote_failed` it promises never landed (measured on a 1s round
	 * left alone: board RESULT ADDENDUM #755). Settling on READ keeps that promise inside the mechanism;
	 * `settleVotes` stays as the mop-up for rounds nobody ever reads. Idempotent by construction:
	 * `#finishVote` only transitions a row that is still `open`.
	 */
	#settleIfDue(decisionId: string, offlineAfterSeconds: number, now: number): SwarmVote | undefined {
		const vote = this.#voteRow(decisionId);
		if (vote === undefined || vote.status !== "open" || now < vote.deadlineAt) return undefined;
		const outcome = this.#outcomeFor(vote, offlineAfterSeconds, now);
		return outcome.settled ? this.#finishVote(vote, outcome, now) : undefined;
	}

	/**
	 * Tally a round against the policy frozen on its own row, using the SAME pure rule the unit tests pin
	 * (extension/voting.ts): the store cannot drift from the arithmetic, and an offline voter drops out of
	 * the base instead of vetoing forever.
	 */
	tallyVote(decisionId: string, offlineAfterSeconds: number, now = Date.now()): { vote: SwarmVote; outcome: VoteOutcome } | undefined {
		// Reading a round enforces its bound: a due round is denied HERE, so the promise holds with no beat.
		this.#settleIfDue(decisionId, offlineAfterSeconds, now);
		const vote = this.#voteRow(decisionId);
		if (vote === undefined) return undefined;
		return { vote, outcome: this.#outcomeFor(vote, offlineAfterSeconds, now) };
	}

	/**
	 * Settle every open round whose outcome is already terminal — the bound expired, the base shrank past
	 * the approvals, or the last ballot decided it. Called from `sweep()`, which the driver's beat already
	 * runs every `heartbeatSeconds`, so a timed-out round is denied ON A SCHEDULE THE POOL ALREADY PAYS
	 * FOR: no extra wake, no poll, no model call (rule 3).
	 */
	settleVotes(offlineAfterSeconds: number, now = Date.now()): SwarmVote[] {
		const settled: SwarmVote[] = [];
		for (const row of this.#db.all<{ id: string }>("SELECT id FROM votes WHERE status='open' ORDER BY opened_at")) {
			// Deliberately NOT `tallyVote`: this is the mop-up, and it must REPORT every round it finishes.
			// The lazy read-settle inside `tallyVote` would finish the row first, leaving `#finishVote` with
			// nothing to transition and the caller with an empty list (task-197's own regression).
			const vote = this.#voteRow(row.id);
			if (vote === undefined) continue;
			const outcome = this.#outcomeFor(vote, offlineAfterSeconds, now);
			if (!outcome.settled) continue;
			const finished = this.#finishVote(vote, outcome, now);
			if (finished !== undefined) settled.push(finished);
		}
		return settled;
	}

	/** Settle ONE round (the ballot path calls this) and execute it when it passed. */
	settleVote(decisionId: string, offlineAfterSeconds: number, now = Date.now()): { vote: SwarmVote; outcome: VoteOutcome } | undefined {
		// Raw row for the same reason `settleVotes` does: a settled round must be REPORTED, not swallowed.
		const vote = this.#voteRow(decisionId);
		if (vote === undefined) return undefined;
		const outcome = this.#outcomeFor(vote, offlineAfterSeconds, now);
		if (!outcome.settled) return { vote, outcome };
		const finished = this.#finishVote(vote, outcome, now);
		return finished === undefined ? undefined : { vote: finished, outcome };
	}

	/**
	 * The ONE place a decision becomes action. `create-task` is the only kind with an executor here: the
	 * others are performed by their own path once it sees a passed round (`close-task` -> `fail`, `scale`
	 * -> the controller), so a passed round can never silently execute something nobody asked for. A failed
	 * round is NEVER silent (rule 3): the tally (for / against / absent) goes to the events, the board and
	 * the opener's inbox — the inbox entry is also what wakes the opener.
	 */
	#finishVote(vote: SwarmVote, outcome: VoteOutcome, now: number): SwarmVote | undefined {
		if (vote.status !== "open") return undefined;
		const passed = outcome.status === "passed";
		const tally = `for ${outcome.approvals.length}/${outcome.base} [${outcome.approvals.join(", ") || "-"}]; against ${outcome.rejections.length} [${outcome.rejections.join(", ") || "-"}]; absent ${outcome.absent.length} [${outcome.absent.join(", ") || "-"}]${outcome.offline.length === 0 ? "" : `; offline ${outcome.offline.length} [${outcome.offline.join(", ")}]`}`;
		// The status transition and whatever the round executes are ONE transaction: a round can never be
		// recorded as passed while the action it authorised half-happened, and the ticket it spends is
		// consumed in the same step (goal-9's high 1).
		const finished = this.#db.transaction(() => {
			const status: VoteState = passed ? "passed" : "failed";
			let result = outcome.reason;
			if (passed && vote.kind === "create-task") {
				try {
					// The payload was written by the vote tool in CreateTaskInput's own shape; a malformed one
					// fails the decision rather than creating a half-row.
					const task = this.#createTaskLocked({ ...(vote.payload as unknown as CreateTaskInput), createdBy: vote.openedBy });
					if (task.status === "refused") throw new MintRefused(task.mintRefusal ?? "the row's capability is unreachable");
					// The round spends ITSELF on the task it authorised. Without this the same 2/2 pass stayed
					// a standing permission and re-issued `swarm_task_create(..., { vote_id })` created one more
					// task per call (VERDICT §3: ONE vote, THREE tasks).
					this.#recordConsumptionLocked(vote.id, vote.kind, vote.payload, vote.openedBy, now);
					result = `${outcome.reason}; executed: created ${task.id}`;
				} catch (error) {
					// A round whose action failed is NOT passed: it is failed, and its ticket is not burned
					// (the rollback below undoes the consumption with it).
					return {
						changes: this.#db.run(
							"UPDATE votes SET status='failed', result=?, updated_at=? WHERE id=? AND status='open'",
							`${outcome.reason}; execution failed: ${error instanceof Error ? error.message : String(error)}`,
							now,
							vote.id,
						).changes,
						status: "failed" as VoteState,
						result: `${outcome.reason}; execution failed: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
			}
			return {
				changes: this.#db.run("UPDATE votes SET status=?, result=?, updated_at=? WHERE id=? AND status='open'", status, result, now, vote.id).changes,
				status,
				result,
			};
		});
		if (finished.changes !== 1) return undefined;
		const { status, result } = finished;
		this.#log(status === "passed" ? "vote.passed" : "vote.failed", vote.openedBy, undefined, {
			vote: vote.id,
			kind: vote.kind,
			question: vote.question,
			for: outcome.approvals,
			against: outcome.rejections,
			absent: outcome.absent,
			offline: outcome.offline,
			reason: outcome.reason,
		});
		const headline = `${status === "passed" ? "vote_passed" : "vote_failed"} ${vote.id} (${vote.kind}): ${vote.question}`;
		this.postBoard({
			type: status === "passed" ? "DECISION" : "FAIL",
			agentId: vote.openedBy,
			content: `${headline}\n${result}\ntally: ${tally}`,
			tags: status === "passed" ? ["vote_passed", "decision"] : ["vote_failed", "failure"],
		});
		this.sendMessage({ to: vote.openedBy, from: "main", body: `${headline}\n${result}\ntally: ${tally}` });
		return this.getVote(vote.id);
	}

	/**
	 * Run a SEEDED round's decision (rule 2): the coordinator's own goal or an operator instruction
	 * executes without a ballot, and this records what it executed so the audit row is not silent either.
	 * Only `create-task` has an executor here; the other kinds act inside their own path.
	 */
	executeSeededVote(decisionId: string): SwarmVote | undefined {
		const vote = this.getVote(decisionId);
		if (vote === undefined || vote.status !== "seeded") return undefined;
		if (vote.kind !== "create-task") return vote;
		try {
			const task = this.#createTaskLocked({ ...(vote.payload as unknown as CreateTaskInput), createdBy: vote.openedBy });
			if (task.status === "refused") throw new MintRefused(task.mintRefusal ?? "the row's capability is unreachable");
			this.#db.run("UPDATE votes SET result=?, updated_at=? WHERE id=?", `seeded: created ${task.id}`, Date.now(), vote.id);
			this.#recordConsumptionLocked(vote.id, vote.kind, vote.payload, vote.openedBy, Date.now());
			this.#log("vote.executed", vote.openedBy, undefined, { vote: vote.id, kind: vote.kind, task: task.id, seeded: true });
		} catch (error) {
			const reason = `seeded execution failed: ${error instanceof Error ? error.message : String(error)}`;
			this.#db.run("UPDATE votes SET status='failed', result=?, updated_at=? WHERE id=?", reason, Date.now(), vote.id);
			this.#log("vote.failed", vote.openedBy, undefined, { vote: vote.id, kind: vote.kind, reason, seeded: true });
		}
		return this.getVote(vote.id);
	}

	/** The one-shot marker of a round, if it was spent: who spent it, on what, and when. */
	#consumption(voteId: string): VoteConsumptionRow | undefined {
		return this.#db.get<VoteConsumptionRow>("SELECT * FROM vote_consumptions WHERE vote_id=?", voteId) ?? undefined;
	}

	/**
	 * Mark a round spent. The PRIMARY KEY is the whole mechanism: a second insert changes 0 rows, so
	 * exactly one consumer can ever win — in this process or in another one holding the same database.
	 * Called with an open transaction only, so it either lands with the action it authorises or not at all.
	 */
	#recordConsumptionLocked(voteId: string, kind: DecisionKind, payload: Record<string, unknown>, consumedBy: string, now: number): number {
		return this.#db.run(
			"INSERT OR IGNORE INTO vote_consumptions (vote_id, kind, payload, consumed_by, consumed_at) VALUES (?, ?, ?, ?, ?)",
			voteId,
			kind,
			payloadSignature(payload),
			consumedBy,
			now,
		).changes;
	}

	/**
	 * Everything that must hold before a round may act, or the ONE reason it may not. `kind` alone was the
	 * old test, and it was the hole (goal-9, VERDICT §3): a passed round stayed a standing permission for
	 * every later call of its kind. Now consent is bound to the DECISION — the frozen payload — and to a
	 * single use. Read-only: it consumes nothing, so a report can ask the same question.
	 */
	#ticketRefusal(
		kind: DecisionKind,
		voteId: string,
		payload: Record<string, unknown>,
		offlineAfterSeconds: number,
		now: number,
	): string | undefined {
		// The due-check runs first, so a round that timed out is settled here and can never be mistaken
		// for a live permission.
		this.#settleIfDue(voteId, offlineAfterSeconds, now);
		const vote = this.#voteRow(voteId);
		if (vote === undefined) return `unknown vote ${voteId}`;
		if (vote.status !== "passed") return `${voteId} is ${vote.status}, not passed: only a passed round can authorise an action`;
		if (vote.kind !== kind) return `${voteId} is a ${vote.kind} round, not ${kind}`;
		const voted = payloadSignature(vote.payload);
		const acting = payloadSignature(payload);
		if (voted !== acting) {
			return `${voteId} voted on ${voted}, this call acts on ${acting}: consent binds to the decision, not to the kind`;
		}
		const spent = this.#consumption(voteId);
		if (spent !== undefined) {
			return `${voteId} was already consumed by ${spent.consumed_by} at ${new Date(spent.consumed_at).toISOString()}: one decision, one action`;
		}
		return undefined;
	}

	/**
	 * The passed round of `kind` a gated decision point may act on, or undefined. A REPORT, never an
	 * authorisation: it is read-only, so only {@link SwarmStore.consumeVote} may actually act on a round.
	 */
	passedVote(
		kind: DecisionKind,
		voteId: string | undefined,
		options: { payload?: Record<string, unknown>; offlineAfterSeconds: number; now?: number },
	): SwarmVote | undefined {
		if (voteId === undefined) return undefined;
		const refusal = this.#ticketRefusal(kind, voteId, options.payload ?? {}, options.offlineAfterSeconds, options.now ?? Date.now());
		return refusal === undefined ? this.#voteRow(voteId) : undefined;
	}

	/**
	 * Act under a round's consent: the ticket is checked, spent and the action performed in ONE
	 * transaction, or nothing happens at all. That is the fix for goal-9's high 1 — a passed round is a
	 * one-shot ticket for exactly the payload it froze, so a replay (same payload, second use) and a
	 * payload swap (different payload, same ticket) are both refused with a reason, and there is no
	 * window between the check and the action for a second consumer to slip through.
	 *
	 * An action that THROWS rolls the transaction back, ticket included: a failed action must not burn
	 * the consent it could not use. The same is true of an action that FAILS WITHOUT THROWING, which is
	 * the shape goal-18's close-task path actually produced: `fail()` reports a refusal as a
	 * `{ ok: false, reason }` VALUE, so the transaction committed, the ticket was spent, and the row it
	 * was supposed to close stayed exactly where it was — twice (vote-15 and vote-17 both passed 5/6
	 * and neither moved task-286).
	 *
	 * `succeeded` is how a caller says what "the action worked" means for its own decision point. When
	 * the action returns a failed result the consumption is ROLLED BACK, so the round is still unspent
	 * for the next attempt — but the action's own value is returned as `{ ok: true, value }`, because
	 * the caller still needs it to report the refusal in its own words (`swarm_fail` says
	 * "fail rejected: …"). `consumed: false` tells that caller the ticket is still there.
	 */
	consumeVote<T>(input: {
		kind: DecisionKind;
		voteId: string;
		payload: Record<string, unknown>;
		consumedBy: string;
		offlineAfterSeconds: number;
		action: (vote: SwarmVote) => T;
		/** What "the action worked" means here, for an action that reports failure as a value. */
		succeeded?: (value: T) => boolean;
		now?: number;
	}): { ok: true; vote: SwarmVote; value: T; consumed: boolean } | { ok: false; reason: string } {
		const now = input.now ?? Date.now();
		return this.#db.transaction(() => {
			const refusal = this.#ticketRefusal(input.kind, input.voteId, input.payload, input.offlineAfterSeconds, now);
			if (refusal !== undefined) return { ok: false as const, reason: refusal };
			if (this.#recordConsumptionLocked(input.voteId, input.kind, input.payload, input.consumedBy, now) !== 1) {
				// Two consumers passed the same check before either spent the ticket: the database decides,
				// and the loser is told who won rather than being allowed to act twice.
				const spent = this.#consumption(input.voteId);
				return {
					ok: false as const,
					reason: `${input.voteId} was consumed by ${spent?.consumed_by ?? "another agent"} first: one decision, one action`,
				};
			}
			const vote = this.#voteRow(input.voteId);
			if (vote === undefined) return { ok: false as const, reason: `unknown vote ${input.voteId}` };
			const value = input.action(vote);
			// The action ran and reported failure as a VALUE rather than throwing. A returned refusal
			// does NOT undo work by itself: the transaction still commits, so the consumption written a
			// moment ago would stand and the round would be spent on an action that did nothing — which
			// is exactly what vote-15 and vote-17 did to task-286. The rollback is therefore EXPLICIT.
			// The action's value is still returned, so the caller reports the refusal in its own words;
			// `consumed: false` tells it the round is still unspent for the next attempt.
			if (input.succeeded !== undefined && !input.succeeded(value)) {
				this.#db.run("DELETE FROM vote_consumptions WHERE vote_id=?", input.voteId);
				return { ok: true as const, vote, value, consumed: false };
			}
			this.#log("vote.consume", input.consumedBy, undefined, {
				vote: input.voteId,
				kind: input.kind,
				payload: payloadSignature(input.payload),
			});
			return { ok: true as const, vote, value, consumed: true };
		});
	}

	// ---------------------------------------------------------------- review

	/** Atomically take the review slot for a task in `review`. */
	claimReview(taskId: string, reviewer: string, leaseSeconds: number): { ok: boolean; reason?: string } {
		const now = Date.now();
		return this.#db.transaction(() => {
			const row = this.#db.get<TaskRow>("SELECT * FROM tasks WHERE id=?", taskId);
			if (row === null) return { ok: false, reason: `unknown task ${taskId}` };
			if (row.status !== "review") return { ok: false, reason: `task ${taskId} is ${row.status}, not review` };
			if (row.author === reviewer) return { ok: false, reason: "reviewer must not be the author of the change" };
			const taken = row.reviewer !== null && row.review_lease_until !== null && row.review_lease_until > now;
			if (taken && row.reviewer !== reviewer) return { ok: false, reason: `review already held by ${row.reviewer}` };
			this.#db.run("UPDATE tasks SET reviewer=?, review_lease_until=?, updated_at=? WHERE id=?", reviewer, now + leaseSeconds * 1000, now, taskId);
			this.#db.run("UPDATE agents SET status='reviewing', current_task=?, heartbeat_at=? WHERE id=?", taskId, now, reviewer);
			this.#log("review.start", reviewer, taskId);
			return { ok: true };
		});
	}

	decide(
		taskId: string,
		reviewer: string,
		approved: boolean,
		notes: string,
	): { ok: boolean; task?: SwarmTask; reason?: string } {
		const claim = this.claimReview(taskId, reviewer, 60);
		if (!claim.ok) return { ok: false, reason: claim.reason };
		const now = Date.now();
		const result = this.#db.transaction(() => {
			const row = this.#db.get<TaskRow>("SELECT * FROM tasks WHERE id=?", taskId);
			if (row === null || row.reviewer !== reviewer) return { ok: false, reason: `review of ${taskId} is not held by ${reviewer}` };
			if (approved) {
				this.#db.run(
					`UPDATE tasks SET status='done', review_status='approved', review_notes=?, reviewer=?, review_lease_until=NULL, updated_at=?
					 WHERE id=?`,
					notes,
					reviewer,
					now,
					taskId,
				);
			} else {
				this.#db.run(
					`UPDATE tasks SET status='ready', review_status='rejected', review_notes=?, reviewer=?, review_lease_until=NULL,
					   claimed_by=NULL, claimed_at=NULL, lease_until=NULL, updated_at=?
					 WHERE id=?`,
					notes,
					reviewer,
					now,
					taskId,
				);
			}
			this.#settleAgent(reviewer, now);
			const promoted = approved ? this.#promoteLocked(now) : [];
			this.#log(approved ? "review.approve" : "review.reject", reviewer, taskId, { notes, promoted });
			return { ok: true, task: this.getTask(taskId) };
		});
		// `claimReview` stamped `reviewing` before this transaction could reject the decision, and only the
		// success path used to settle — so a refused decide left the stamp behind forever (task-176).
		if (!result.ok) this.#settleAgent(reviewer, now);
		if (result.ok) {
			this.postBoard({
				type: "REVIEW",
				agentId: reviewer,
				taskId,
				content: `${approved ? "APPROVED" : "REJECTED"}: ${notes}`,
				tags: [approved ? "approved" : "rejected"],
			});
		}
		return result;
	}

	listReviews(limit = 50): SwarmTask[] {
		return this.listTasks({ status: "review", limit });
	}

	// ---------------------------------------------------------- reservations

	acquireReservations(owner: string, patterns: string[], leaseSeconds: number, taskId?: string): { ok: boolean; conflicts: string[] } {
		const now = Date.now();
		return this.#db.transaction(() => {
			this.#db.run("DELETE FROM reservations WHERE lease_until < ?", now);
			const held = this.#db.all<ReservationRow>("SELECT * FROM reservations");
			const conflicts: string[] = [];
			for (const pattern of patterns) {
				for (const row of held) {
					if (row.owner !== owner && patternsConflict(pattern, row.pattern)) {
						conflicts.push(`${pattern} conflicts with ${row.pattern} (${row.owner})`);
					}
				}
			}
			if (conflicts.length > 0) return { ok: false, conflicts };
			for (const pattern of patterns) {
				this.#db.run("DELETE FROM reservations WHERE owner=? AND pattern=?", owner, pattern);
				this.#db.run(
					"INSERT INTO reservations (pattern, owner, task_id, lease_until, created_at) VALUES (?, ?, ?, ?, ?)",
					pattern,
					owner,
					taskId ?? null,
					now + leaseSeconds * 1000,
					now,
				);
			}
			this.#log("reservation.acquire", owner, taskId, { patterns });
			return { ok: true, conflicts: [] };
		});
	}

	releaseReservations(owner: string, patterns?: string[]): number {
		const result =
			patterns === undefined || patterns.length === 0
				? this.#db.run("DELETE FROM reservations WHERE owner=?", owner)
				: this.#db.run(`DELETE FROM reservations WHERE owner=? AND pattern IN (${patterns.map(() => "?").join(",")})`, owner, ...patterns);
		this.#log("reservation.release", owner, undefined, { count: result.changes });
		return result.changes;
	}

	listReservations(): Reservation[] {
		return this.#db.all<ReservationRow>("SELECT * FROM reservations ORDER BY created_at").map((row) => ({
			id: row.id,
			pattern: row.pattern,
			owner: row.owner,
			taskId: row.task_id ?? undefined,
			leaseUntil: row.lease_until,
			createdAt: row.created_at,
		}));
	}

	// -------------------------------------------------------------- board

	postBoard(entry: { type: BoardType; agentId: string; content: string; taskId?: string; tags?: string[]; files?: string[] }): BlackboardEntry {
		const now = Date.now();
		const result = this.#db.run(
			"INSERT INTO board (type, agent_id, task_id, content, tags, files, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			entry.type,
			entry.agentId,
			entry.taskId ?? null,
			entry.content,
			JSON.stringify(entry.tags ?? []),
			JSON.stringify(entry.files ?? []),
			now,
		);
		this.#log("board.post", entry.agentId, entry.taskId, { type: entry.type });
		return {
			id: Number(result.lastInsertRowid),
			type: entry.type,
			agentId: entry.agentId,
			taskId: entry.taskId,
			content: entry.content,
			tags: entry.tags ?? [],
			files: entry.files ?? [],
			createdAt: now,
		};
	}

	searchBoard(filter: BoardQuery = {}): BlackboardEntry[] {
		const clauses: string[] = [];
		const params: string[] = [];
		if (filter.type) {
			clauses.push("type = ?");
			params.push(filter.type);
		}
		if (filter.taskId) {
			clauses.push("task_id = ?");
			params.push(filter.taskId);
		}
		if (filter.agentId) {
			clauses.push("agent_id = ?");
			params.push(filter.agentId);
		}
		if (filter.query) {
			clauses.push("(content LIKE ? OR tags LIKE ?)");
			params.push(`%${filter.query}%`, `%${filter.query}%`);
		}
		for (const tag of filter.tags ?? []) {
			clauses.push("tags LIKE ?");
			params.push(`%${tag}%`);
		}
		const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
		return this.#db.all<BoardRow>(`SELECT * FROM board ${where} ORDER BY id DESC LIMIT ?`, ...params, filter.limit ?? 50).map((row) => ({
			id: row.id,
			type: row.type,
			agentId: row.agent_id,
			taskId: row.task_id ?? undefined,
			content: row.content,
			tags: parseList(row.tags),
			files: parseList(row.files),
			createdAt: row.created_at,
		}));
	}

	boardCounts(): Record<string, number> {
		const rows = this.#db.all<{ type: string; n: number }>("SELECT type, COUNT(*) AS n FROM board GROUP BY type");
		const out: Record<string, number> = {};
		for (const row of rows) out[row.type] = row.n;
		return out;
	}

	// ------------------------------------------------------------- messages

	sendMessage(message: { to: string; from: string; body: string; urgent?: boolean; taskId?: string }): SwarmMessage {
		const now = Date.now();
		const result = this.#db.run(
			"INSERT INTO messages (to_agent, from_agent, body, urgent, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			message.to,
			message.from,
			message.body,
			message.urgent ? 1 : 0,
			message.taskId ?? null,
			now,
		);
		this.#log("message.send", message.from, message.taskId, { to: message.to, urgent: Boolean(message.urgent) });
		return {
			id: Number(result.lastInsertRowid),
			to: message.to,
			from: message.from,
			body: message.body,
			urgent: Boolean(message.urgent),
			taskId: message.taskId,
			createdAt: now,
		};
	}

	inbox(agentId: string, limit = 50): SwarmMessage[] {
		return this.#db
			.all<MessageRow>("SELECT * FROM messages WHERE (to_agent = ? OR to_agent = '*') AND read_at IS NULL ORDER BY id LIMIT ?", agentId, limit)
			.map((row) => ({
				id: row.id,
				to: row.to_agent,
				from: row.from_agent,
				body: row.body,
				urgent: row.urgent === 1,
				taskId: row.task_id ?? undefined,
				createdAt: row.created_at,
				readAt: row.read_at ?? undefined,
			}));
	}

	markMessagesRead(agentId: string, ids: number[]): number {
		if (ids.length === 0) return 0;
		const result = this.#db.run(
			`UPDATE messages SET read_at=? WHERE id IN (${ids.map(() => "?").join(",")}) AND (to_agent=? OR to_agent='*')`,
			Date.now(),
			...ids,
			agentId,
		);
		return result.changes;
	}

	// --------------------------------------------------------------- events

	/**
	 * The events of one type, newest first, WITH their `data` — kept as the type-filtered audit reader
	 * for callers that want one kind of event only (`recentEvents` now carries `data` too, goal-9's
	 * minor ②: a vote's {for, against, absent} tally lives in its event, and the tally of a decision
	 * must be readable on the ordinary read path, not only here and on the board).
	 */
	eventsOfType(type: string, limit = 50): { id: number; agentId?: string; taskId?: string; data: Record<string, unknown>; createdAt: number }[] {
		return this.#db
			.all<{ id: number; agent_id: string | null; task_id: string | null; data: string; created_at: number }>(
				"SELECT id, agent_id, task_id, data, created_at FROM events WHERE type=? ORDER BY id DESC LIMIT ?",
				type,
				limit,
			)
			.map((row) => ({
				id: row.id,
				agentId: row.agent_id ?? undefined,
				taskId: row.task_id ?? undefined,
				data: JSON.parse(row.data) as Record<string, unknown>,
				createdAt: row.created_at,
			}));
	}

	recentEvents(limit = 30): { id: number; type: string; agentId?: string; taskId?: string; data: Record<string, unknown>; createdAt: number }[] {
		return this.#db
			.all<{ id: number; type: string; agent_id: string | null; task_id: string | null; data: string; created_at: number }>(
				"SELECT id, type, agent_id, task_id, data, created_at FROM events ORDER BY id DESC LIMIT ?",
				limit,
			)
			.map((row) => ({
				id: row.id,
				type: row.type,
				agentId: row.agent_id ?? undefined,
				taskId: row.task_id ?? undefined,
				data: JSON.parse(row.data) as Record<string, unknown>,
				createdAt: row.created_at,
			}));
	}

	// ------------------------------------------------------------- snapshot

	counts(): TaskCounts {
		const rows = this.#db.all<CountRow>("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status");
		const out: TaskCounts = { ready: 0, claimed: 0, blocked: 0, review: 0, done: 0, failed: 0 };
		for (const row of rows) out[row.status] = row.n;
		return out;
	}

	snapshot(offlineAfterSeconds: number, running: boolean): StatusSnapshot {
		this.markStaleAgentsOffline(offlineAfterSeconds);
		const counts = this.counts();
		return {
			now: Date.now(),
			running,
			agents: this.listAgents(),
			counts,
			board: this.boardCounts(),
			claimable: counts.ready,
			inFlight: this.listTasks({ status: ["claimed", "review"], limit: 50 }),
			recentDone: this.recentDoneTasks(50),
		};
	}
}
