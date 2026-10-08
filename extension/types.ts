/** Domain types shared by the swarm store, tools, driver, and renderers. */

/**
 * The state of a task the pool holds OR a refusal object a mint handed back.
 *
 * `"refused"` is deliberately not one of the DB-backed states ({@link TaskStatus}): it marks a task
 * object a refused mint returned (goal-14 clause 1) that was never written to the pool, so no
 * `WHERE status=?` query, no count, and no claim can ever see it. It is on this type only so a
 * caller receives ONE type from the mint.
 */
export type RowStatus = "ready" | "claimed" | "blocked" | "review" | "done" | "failed" | "refused";
/** The DB-backed subset of {@link RowStatus}: every value a `tasks.status` column can hold. */
export type TaskStatus = "ready" | "claimed" | "blocked" | "review" | "done" | "failed";

export type AgentStatus = "idle" | "working" | "reviewing" | "blocked" | "waiting" | "offline";

export type BoardType =
	| "FACT"
	| "FAIL"
	| "OBSERVATION"
	| "CLAIM"
	| "RESULT"
	| "QUESTION"
	| "REVIEW"
	| "DECISION";

export interface SwarmTask {
	id: string;
	title: string;
	description: string;
	/** `RowStatus`, not `TaskStatus`: a refused mint returns a task-shaped object with `"refused"`. */
	status: RowStatus;
	priority: number;
	createdBy: string;
	createdAt: number;
	updatedAt: number;
	claimedBy?: string;
	claimedAt?: number;
	leaseUntil?: number;
	dependencies: string[];
	requiredCapabilities: string[];
	files: string[];
	result?: string;
	commit?: string;
	review: {
		required: boolean;
		reviewer?: string;
		status?: "pending" | "approved" | "rejected";
		notes?: string;
	};
	attempts: number;
	/**
	 * goal-14 clause 1: set ONLY on a row returned by a refused mint. The row was never written to
	 * the pool; it is handed to the caller so the refusal can be reported without an exception, and
	 * `status` is `"refused"` so a writer of a generic row handler cannot mistake it for real work.
	 */
	mintRefusal?: string;
}

export interface SwarmAgent {
	id: string;
	sessionId?: string;
	role: string;
	status: AgentStatus;
	capabilities: string[];
	currentTask?: string;
	worktree?: string;
	pid?: number;
	joinedAt: number;
	heartbeatAt: number;
}

export interface BlackboardEntry {
	id: number;
	type: BoardType;
	agentId: string;
	taskId?: string;
	content: string;
	tags: string[];
	files: string[];
	createdAt: number;
}

export interface SwarmMessage {
	id: number;
	to: string;
	from: string;
	body: string;
	urgent: boolean;
	taskId?: string;
	createdAt: number;
	readAt?: number;
}

export interface Reservation {
	id: number;
	pattern: string;
	owner: string;
	taskId?: string;
	leaseUntil: number;
	createdAt: number;
}

export interface SwarmEvent {
	id: number;
	type: string;
	agentId?: string;
	taskId?: string;
	data: Record<string, unknown>;
	createdAt: number;
}

export interface TaskCounts {
	ready: number;
	claimed: number;
	blocked: number;
	review: number;
	done: number;
	failed: number;
}

/** A goal's planning round: `open` until the scribe plans it or its bound closes it as `failed`. */
export type GoalStatus = "open" | "planned" | "failed";

export interface SwarmGoal {
	id: string;
	/** The user's request, verbatim: what the workers split. */
	goal: string;
	/** The agent budget the coordinator asked for (already clamped to `config.workers`). */
	agents: number;
	status: GoalStatus;
	createdBy: string;
	createdAt: number;
	updatedAt: number;
	/** `createdAt + GOAL_DEADLINE_MS`: past this, an unplanned goal is closed with a FAIL. */
	deadlineAt: number;
	/** The goal's ONE planning task; the first agent to claim it is the scribe. */
	planningTask: string;
	/** The scribe that merged the round. */
	planner?: string;
	plannedAt?: number;
	/** The merged-split summary, or the reason the goal failed. */
	result?: string;
}

export interface PlanResult {
	ok: boolean;
	/** Present when `ok`. */
	goal?: SwarmGoal;
	/** Ids of the tasks the merge created, in creation order. */
	created: string[];
	/** Deliverables the merge left alone because the pool already holds that deliverable. */
	skipped: { title: string; id: string; /** Which route matched: the shape/spelling route or goal-17 L2's exact identity key. */ route?: "exact" | "spelling" }[];
	/** Number of proposals the round carried. */
	proposals: number;
	/** Deliverable keys more than one proposal named. */
	folded: string[];
	/** Every folded row, with the survivor it folded into and why - the DECISION's audit trail. */
	folds: MergeFold[];
	/** Dependency references that could not be resolved (dropped). */
	unresolved: { task: string; dep: string }[];
	/** The widest set of the round's deliverables that can run at the same time. */
	peak: number;
	/** The agent count that peak implies, capped by the ceiling the caller passed (0 = unknown). */
	recommended: number;
	reason?: string;
}

/** One proposal row a planning round folded into a surviving deliverable, and why the two are one. */
export interface MergeFold {
	/** The merge key of the surviving deliverable. */
	into: string;
	/** The title of the row that folded. */
	title: string;
	/** Why the two are one deliverable, in the words the board shows the operator. */
	reason: string;
}

/**
 * One agent's ask for a different pool size (`swarm_scale`). ADVISORY: it only records the ask — the
 * AutoController is the single writer of the pool size, and it reconciles the pending asks each tick.
 */
export interface ScaleRequest {
	id: number;
	agentId: string;
	/** The size the agent asked for, as it asked (before the ceiling/floor clamp). */
	requested: number;
	reason: string;
	/** The pool size when the ask was made, so the record reads as a delta later. */
	current: number;
	createdAt: number;
	decidedAt?: number;
	decidedAction?: string;
	decidedSize?: number;
}

export interface ClaimResult {
	ok: boolean;
	reason?: string;
	task?: SwarmTask;
}

export interface RoleConfig {
	name: string;
	count: number;
	capabilities?: string[];
}

/**
 * The pool-internal decisions that need a vote (goal-8). `spawn`/`stop` are the controller's roster
 * changes, so they are settled by the same store round the tools use.
 */
export type DecisionKind = "create-task" | "close-task" | "spawn" | "stop" | "scale";

/** The round's terminal states. `seeded` is the cold-start authority: it never voted (see voting.ts). */
export type VoteState = "open" | "passed" | "failed" | "seeded";

/**
 * One cluster-level decision put to the pool, with its own policy frozen at open time: the threshold
 * and the minimum base are recorded on the row, so the arithmetic a round is judged by cannot move
 * under it and a later policy change can never retroactively flip a decision.
 */
export interface SwarmVote {
	id: string;
	kind: DecisionKind;
	/** What is being decided, in one line: the board and the events read from this. */
	question: string;
	/** What the decision acts on (e.g. the task fields for `create-task`). */
	payload: Record<string, unknown>;
	openedBy: string;
	openedAt: number;
	/** `openedAt + timeoutMs`: past this the round is denied by default. */
	deadlineAt: number;
	/** The policy in force when the round opened. */
	threshold: number;
	minBase: number;
	status: VoteState;
	/** What a passed round executed, when it executed something (e.g. the created task id). */
	result?: string;
	updatedAt: number;
}

export interface SwarmConfig {
	workers: number;
	leaseSeconds: number;
	heartbeatSeconds: number;
	offlineAfterSeconds: number;
	idleTickSeconds: number;
	review: boolean;
	/** Multi-agent mode: the next user task is decomposed into swarm tasks that start on their own. */
	auto: boolean;
	/**
	 * Who splits the work. `"swarm"` (the default): the coordinator only decides how many agents a
	 * goal needs (`swarm_goal`), the workers propose the split themselves and the first to claim the
	 * goal's planning task merges it. `"coordinator"`: the pre-2026-10-07 path — the coordinator
	 * writes the whole task list with `swarm_task_create` and the workers only claim from it.
	 */
	planning: "swarm" | "coordinator";
	worktrees: boolean;
	/**
	 * Cluster-level decisions (create-task, close-task, scale) need a PASSED vote before they act; the
	 * operator can switch the constraint off here. The three numbers are the operator's POLICY and a
	 * request can only make them stricter (extension/voting.ts, rule 6): `voteThreshold` is the yes share
	 * a round must STRICTLY beat, `voteMinBase` is the smallest pool allowed to decide at all, and
	 * `voteTimeoutSeconds` is the round's bound — past it the not-yet-voted are absent and the round fails.
	 */
	voteEnabled: boolean;
	voteThreshold: number;
	voteMinBase: number;
	voteTimeoutSeconds: number;
	model?: string;
	thinkingLevel?: string;
	roles: RoleConfig[];
	tools: string[];
}

export const DEFAULT_CONFIG: SwarmConfig = {
	workers: 4,
	leaseSeconds: 300,
	heartbeatSeconds: 20,
	offlineAfterSeconds: 60,
	idleTickSeconds: 15,
	review: true,
	auto: false,
	planning: "swarm",
	worktrees: false,
	voteEnabled: true,
	voteThreshold: 0.75,
	voteMinBase: 2,
	voteTimeoutSeconds: 90,
	roles: [{ name: "general", count: 4, capabilities: ["general"] }],
	tools: ["read", "grep", "glob", "edit", "write", "bash", "ast_grep", "ast_edit", "todo"],
};
