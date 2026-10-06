import { appendEventLine, type Db, type SwarmPaths } from "./db";
import type {
	AgentStatus,
	BlackboardEntry,
	BoardType,
	ClaimResult,
	Reservation,
	SwarmAgent,
	SwarmMessage,
	SwarmTask,
	TaskCounts,
	TaskStatus,
} from "./types";

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

	heartbeat(id: string, status?: AgentStatus, currentTask?: string | null, leaseSeconds = 300): void {
		const now = Date.now();
		const agent = this.#db.get<{ current_task: string | null }>("SELECT current_task FROM agents WHERE id=?", id);
		if (!agent) return;
		this.#db.run(
			"UPDATE agents SET heartbeat_at=?, status=COALESCE(?, status), current_task=? WHERE id=?",
			now,
			status ?? null,
			currentTask === undefined ? agent.current_task : currentTask,
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

	listAgents(): SwarmAgent[] {
		return this.#db.all<AgentRow>("SELECT * FROM agents ORDER BY joined_at").map((r) => this.#toAgent(r));
	}

	// ----------------------------------------------------------------- tasks

	createTask(input: CreateTaskInput): SwarmTask {
		const now = Date.now();
		const deps = [...new Set(input.dependencies ?? [])];
		return this.#db.transaction(() => {
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
				JSON.stringify(input.requiredCapabilities ?? []),
				JSON.stringify(input.files ?? []),
				input.reviewRequired ? 1 : 0,
			);
			for (const dep of deps) {
				this.#db.run("INSERT OR IGNORE INTO task_deps (task_id, depends_on) VALUES (?, ?)", id, dep);
			}
			this.#log("task.create", input.createdBy, id, { title: input.title, blocked });
			return this.getTask(id) as SwarmTask;
		});
	}

	#deps(taskId: string): string[] {
		return this.#db.all<{ depends_on: string }>("SELECT depends_on FROM task_deps WHERE task_id=? ORDER BY depends_on", taskId).map((r) => r.depends_on);
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

	/** Housekeeping: expire leases, stale reservations, stale agents, promote unblocked work. */
	sweep(offlineAfterSeconds = 60): { reclaimed: string[]; promoted: string[] } {
		const now = Date.now();
		const result = this.#db.transaction(() => {
			const reclaimed = this.#reclaimExpiredLocked(now);
			const promoted = this.#promoteLocked(now);
			this.#db.run("DELETE FROM reservations WHERE lease_until < ?", now);
			return { reclaimed, promoted };
		});
		this.markStaleAgentsOffline(offlineAfterSeconds);
		return result;
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
			this.#db.run("UPDATE agents SET status='idle', current_task=NULL, heartbeat_at=? WHERE id=?", now, agentId);
			this.#log("task.release", agentId, taskId, { reason });
			return true;
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
			this.#db.run("UPDATE agents SET status='idle', current_task=NULL, heartbeat_at=? WHERE id=?", now, agentId);
			const promoted = needsReview ? [] : this.#promoteLocked(now);
			this.#log("task.complete", agentId, taskId, { review: needsReview, promoted });
			return { ok: true, task: this.getTask(taskId) };
		});
	}

	fail(taskId: string, agentId: string, reason: string): { ok: boolean; task?: SwarmTask; reason?: string } {
		const now = Date.now();
		const result = this.#db.transaction(() => {
			const row = this.#db.get<TaskRow>("SELECT * FROM tasks WHERE id=?", taskId);
			if (row === null) return { ok: false, reason: `unknown task ${taskId}` };
			if (row.status !== "claimed" || row.claimed_by !== agentId) {
				return { ok: false, reason: `task ${taskId} is ${row.status}${row.claimed_by ? ` by ${row.claimed_by}` : ""}` };
			}
			this.#db.run(
				"UPDATE tasks SET status='failed', result=?, claimed_by=NULL, claimed_at=NULL, lease_until=NULL, updated_at=? WHERE id=?",
				reason,
				now,
				taskId,
			);
			this.#db.run("UPDATE agents SET status='idle', current_task=NULL, heartbeat_at=? WHERE id=?", now, agentId);
			this.#log("task.fail", agentId, taskId, { reason });
			return { ok: true, task: this.getTask(taskId) };
		});
		if (result.ok) this.postBoard({ type: "FAIL", agentId, taskId, content: reason, tags: ["failure"] });
		return result;
	}

	/**
	 * Revive a `failed` or `blocked` task: it returns to the pool as `ready` with a
	 * fresh attempt recorded, so a dead end is not permanent — dependents of a failed
	 * task are promoted by the usual `sweep()` once it completes. Refuses any other
	 * status (a claimed/done task is owned by someone, or already finished).
	 */
	retryTask(taskId: string, reason?: string, agentId?: string): { ok: boolean; task?: SwarmTask; reason?: string } {
		const now = Date.now();
		return this.#db.transaction(() => {
			const row = this.#db.get<TaskRow>("SELECT * FROM tasks WHERE id=?", taskId);
			if (row === null) return { ok: false, reason: `unknown task ${taskId}` };
			if (row.status !== "failed" && row.status !== "blocked") {
				return { ok: false, reason: `task ${taskId} is ${row.status}, not failed or blocked` };
			}
			this.#db.run(
				`UPDATE tasks SET status='ready', claimed_by=NULL, claimed_at=NULL, lease_until=NULL,
				   attempts=attempts+1, updated_at=?
				 WHERE id=?`,
				now,
				taskId,
			);
			this.#log("task.retry", agentId, taskId, { from: row.status, reason });
			return { ok: true, task: this.getTask(taskId) };
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
			this.#db.run("UPDATE agents SET status='idle', current_task=NULL, heartbeat_at=? WHERE id=?", now, reviewer);
			const promoted = approved ? this.#promoteLocked(now) : [];
			this.#log(approved ? "review.approve" : "review.reject", reviewer, taskId, { notes, promoted });
			return { ok: true, task: this.getTask(taskId) };
		});
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

	recentEvents(limit = 30): { id: number; type: string; agentId?: string; taskId?: string; createdAt: number }[] {
		return this.#db
			.all<{ id: number; type: string; agent_id: string | null; task_id: string | null; created_at: number }>(
				"SELECT id, type, agent_id, task_id, created_at FROM events ORDER BY id DESC LIMIT ?",
				limit,
			)
			.map((row) => ({
				id: row.id,
				type: row.type,
				agentId: row.agent_id ?? undefined,
				taskId: row.task_id ?? undefined,
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
