/**
 * Pure reader: one `.swarm/swarm.db` → the frozen `Snapshot` JSON (board DECISION #372).
 *
 * `buildSnapshot` takes a connection and a clock and returns data — no HTTP, no timers, no
 * filesystem. That is what makes it testable against a temp DB with known rows (`tests/unit/
 * web-snapshot.test.ts`) and what keeps the server's only job to be transport.
 *
 * Two semantics are deliberately MIRRORED from `extension/store.ts` so the dashboard and the
 * TUI can never disagree about the same database:
 * - `counts` is the same `SELECT status, COUNT(*) FROM tasks GROUP BY status` grouping, with
 *   `total` taken from the SQL truth rather than summed from the six named buckets (a legacy or
 *   unknown status must not silently vanish from the total);
 * - `blockedReason` reproduces `SwarmStore.blockedReason`: `missing: …` for a dependency id that
 *   does not exist, `cycle: …` for a dependency graph that can never reach `done`, else `waiting`.
 * The one thing it cannot mirror is `markStaleAgentsOffline`, which WRITES `status='offline'`;
 * this reader has no write capability, so it computes the same effective status from the
 * heartbeat instead. Nothing here opens a read-write connection.
 */
import type { ReadonlyQuery } from "./lib/readonly";
import type { Snapshot, SnapshotAgent, SnapshotCounts, SnapshotSummary, SnapshotTask } from "./lib/types";

/** The main session's id, mirroring `extension/agentnav.ts` (`MAIN_ID`). */
const MAIN_AGENT_ID = "main";
/** Mirrors `DEFAULT_CONFIG.offlineAfterSeconds`. */
const DEFAULT_OFFLINE_AFTER_SECONDS = 60;
/** Default number of rows per newest-first feed (board / messages / events). */
export const DEFAULT_FEED_LIMIT = 100;
/**
 * Hard ceiling on the task list. The dashboard exists to show the pool at a glance and the pool
 * is bounded by the worker budget, so this is a guard against a pathological table, not a
 * pagination feature — `/api/snapshot` reports `feed.limit` for the feeds and this cap is fixed.
 */
export const TASK_LIMIT = 1000;

interface CountRow {
	status: string;
	n: number;
}

interface ChangesRow {
	tasks: number;
	tasksUpdated: number;
	agents: number;
	agentsHeartbeat: number;
	board: number;
	messages: number;
	messagesRead: number;
	events: number;
	reservations: number;
}

interface AgentRow {
	id: string;
	role: string;
	status: string;
	capabilities: string;
	current_task: string | null;
	worktree: string | null;
	joined_at: number;
	heartbeat_at: number;
}

interface TaskRow {
	id: string;
	title: string;
	status: string;
	priority: number;
	claimed_by: string | null;
	attempts: number;
	created_at: number;
	updated_at: number;
	claimed_at: number | null;
	lease_until: number | null;
	required_capabilities: string;
	files: string;
	review_required: number;
	review_status: string | null;
	result: string | null;
	commit_ref: string | null;
}

interface DepRow {
	task_id: string;
	depends_on: string;
}

interface LeaseRow {
	agent: string | null;
	until: number | null;
}

interface BoardRow {
	id: number;
	type: string;
	agent_id: string;
	task_id: string | null;
	content: string;
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
	pattern: string;
	owner: string;
	task_id: string | null;
	lease_until: number;
}

interface EventRow {
	type: string;
	data: string;
	created_at: number;
}

export interface SnapshotInput {
	/** Injected clock (ms epoch) so age math is deterministic under test. */
	now: number;
	/** The swarm root — the directory holding `.swarm/`. */
	swarmRoot: string;
	feedLimit?: number;
	offlineAfterSeconds?: number;
}

/** `store.counts()` plus the SQL truth as `total`. */
export function readCounts(db: ReadonlyQuery): SnapshotCounts {
	const buckets: Record<string, number> = {};
	let total = 0;
	for (const row of db.all<CountRow>("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status")) {
		buckets[row.status] = row.n;
		total += row.n;
	}
	return {
		ready: buckets.ready ?? 0,
		claimed: buckets.claimed ?? 0,
		review: buckets.review ?? 0,
		blocked: buckets.blocked ?? 0,
		done: buckets.done ?? 0,
		failed: buckets.failed ?? 0,
		total,
	};
}

/**
 * What moved since the last poll: counts plus the newest row of every append-only feed. One
 * query, so the 1 Hz SSE poll stays cheaper than rendering the snapshot it decides to skip.
 */
export function buildSummary(db: ReadonlyQuery, now: number): SnapshotSummary {
	const counts = readCounts(db);
	const changes = db.all<ChangesRow>(`SELECT
		(SELECT COUNT(*) FROM tasks) AS tasks,
		(SELECT COALESCE(MAX(updated_at), 0) FROM tasks) AS tasksUpdated,
		(SELECT COUNT(*) FROM agents) AS agents,
		(SELECT COALESCE(MAX(heartbeat_at), 0) FROM agents) AS agentsHeartbeat,
		(SELECT COALESCE(MAX(id), 0) FROM board) AS board,
		(SELECT COALESCE(MAX(id), 0) FROM messages) AS messages,
		(SELECT COALESCE(MAX(read_at), 0) FROM messages) AS messagesRead,
		(SELECT COALESCE(MAX(id), 0) FROM events) AS events,
		(SELECT COUNT(*) FROM reservations) AS reservations`)[0];
	return { now, counts, hash: fnv1a(JSON.stringify({ counts, changes: changes ?? null })) };
}

/** 32-bit FNV-1a. A change detector, not a security primitive — stability is all that matters. */
function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/** `store.ts`'s `parseList`: a JSON array of strings, or nothing. */
function parseList(raw: string | null): string[] {
	if (typeof raw !== "string") return [];
	try {
		const value: unknown = JSON.parse(raw);
		return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
	} catch {
		return [];
	}
}

/**
 * Depth-first walk over `task -> [dependencies]`, returning the first cycle as a closed path
 * (`[a, b, a]`) or `undefined` when the subgraph is acyclic. A verbatim port of
 * `store.ts:findCycle`, so `blockedReason` prints the same `cycle: a -> b -> a` string.
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

export function buildSnapshot(db: ReadonlyQuery, input: SnapshotInput): Snapshot {
	const now = input.now;
	const feedLimit = Math.max(0, Math.floor(input.feedLimit ?? DEFAULT_FEED_LIMIT));
	const offlineAfterSeconds = input.offlineAfterSeconds ?? DEFAULT_OFFLINE_AFTER_SECONDS;

	const taskRows = db.all<TaskRow>("SELECT * FROM tasks ORDER BY priority DESC, created_at ASC LIMIT ?", TASK_LIMIT);
	const depRows = db.all<DepRow>("SELECT task_id, depends_on FROM task_deps ORDER BY depends_on");
	const knownIds = new Set(db.all<{ id: string }>("SELECT id FROM tasks").map((row) => row.id));

	const depsOf = new Map<string, string[]>();
	const edges = new Map<string, string[]>();
	for (const row of depRows) {
		const deps = depsOf.get(row.task_id);
		if (deps === undefined) depsOf.set(row.task_id, [row.depends_on]);
		else deps.push(row.depends_on);
		const outs = edges.get(row.task_id);
		if (outs === undefined) edges.set(row.task_id, [row.depends_on]);
		else outs.push(row.depends_on);
	}

	const blockedReason = (id: string, status: string): string | null => {
		if (status !== "blocked") return null;
		const deps = depsOf.get(id) ?? [];
		const missing = deps.filter((dep) => !knownIds.has(dep));
		if (missing.length > 0) return `missing: ${missing.join(", ")}`;
		for (const dep of deps) {
			const cycle = findCycle(edges, dep);
			if (cycle !== undefined) return `cycle: ${cycle.join(" -> ")}`;
		}
		return "waiting";
	};

	// A lease lives on the task, not the agent: the latest one an agent holds, whether as claimant
	// or as reviewer. `null` means the agent holds nothing.
	const leases = new Map<string, number>();
	for (const row of db.all<LeaseRow>(`SELECT claimed_by AS agent, lease_until AS until FROM tasks
			WHERE claimed_by IS NOT NULL AND lease_until IS NOT NULL
		UNION ALL
		SELECT reviewer AS agent, review_lease_until AS until FROM tasks
			WHERE reviewer IS NOT NULL AND review_lease_until IS NOT NULL`)) {
		if (row.agent === null || row.until === null) continue;
		leases.set(row.agent, Math.max(leases.get(row.agent) ?? 0, row.until));
	}
	const staleCutoff = now - offlineAfterSeconds * 1000;

	const agents: SnapshotAgent[] = db
		.all<AgentRow>("SELECT * FROM agents ORDER BY joined_at")
		.map((row) => ({
			id: row.id,
			role: row.role,
			// Mirror `markStaleAgentsOffline` without writing: a live-looking row whose heartbeat is
			// older than the offline window is offline for every reader already.
			status: row.status !== "offline" && row.heartbeat_at < staleCutoff ? "offline" : row.status,
			currentTask: row.current_task,
			capabilities: parseList(row.capabilities),
			worktree: row.worktree,
			heartbeatAgeMs: Math.max(0, now - row.heartbeat_at),
			leaseUntilMs: leases.get(row.id) ?? null,
			isMain: row.id === MAIN_AGENT_ID || row.role === "main",
		}));

	const tasks: SnapshotTask[] = taskRows.map((row) => ({
		id: row.id,
		title: row.title,
		status: row.status,
		priority: row.priority,
		claimedBy: row.claimed_by,
		attempts: row.attempts,
		createdAtMs: row.created_at,
		updatedAtMs: row.updated_at,
		claimedAtMs: row.claimed_at,
		leaseUntilMs: row.lease_until,
		ageMs: Math.max(0, now - row.created_at),
		dependencies: depsOf.get(row.id) ?? [],
		blockedReason: blockedReason(row.id, row.status),
		requiredCapabilities: parseList(row.required_capabilities),
		files: parseList(row.files),
		reviewRequired: row.review_required === 1,
		reviewStatus: row.review_status,
		result: row.result,
		commit: row.commit_ref,
	}));

	return {
		now,
		swarmRoot: input.swarmRoot,
		counts: readCounts(db),
		agents,
		tasks,
		board: db.all<BoardRow>("SELECT * FROM board ORDER BY id DESC LIMIT ?", feedLimit).map((row) => ({
			id: row.id,
			type: row.type,
			taskId: row.task_id,
			author: row.agent_id,
			createdAtMs: row.created_at,
			content: row.content,
		})),
		messages: db.all<MessageRow>("SELECT * FROM messages ORDER BY id DESC LIMIT ?", feedLimit).map((row) => ({
			id: row.id,
			from: row.from_agent,
			to: row.to_agent,
			taskId: row.task_id,
			urgent: row.urgent === 1,
			createdAtMs: row.created_at,
			read: row.read_at !== null,
			content: row.body,
		})),
		reservations: db.all<ReservationRow>("SELECT * FROM reservations ORDER BY created_at").map((row) => ({
			path: row.pattern,
			agentId: row.owner,
			taskId: row.task_id,
			leaseUntilMs: row.lease_until,
		})),
		events: db.all<EventRow>("SELECT * FROM events ORDER BY id DESC LIMIT ?", feedLimit).map((row) => ({
			createdAtMs: row.created_at,
			type: row.type,
			content: row.data,
		})),
		feed: { limit: feedLimit },
	};
}
