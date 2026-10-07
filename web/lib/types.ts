/**
 * The frozen v1 wire contract of the swarm web dashboard (board DECISION #372).
 *
 * These names are shared verbatim with the frontend (`web/assets/**`): the backend must not
 * rename or drop a field, and every timestamp is an absolute ms epoch or carries a `*Ms`
 * suffix. An absent scalar is `null`, never `undefined` — `JSON.stringify` would silently drop
 * an `undefined` and the frontend would have to guess whether a field is missing or empty.
 *
 * Nothing here imports `extension/**`: the dashboard is a standalone read-only process, and
 * the extension's store opens (and migrates) a read-write connection.
 */

/** Task status buckets, mirroring `SWARM`'s own counting. `total` is the SQL truth, not their sum. */
export interface SnapshotCounts {
	ready: number;
	claimed: number;
	review: number;
	blocked: number;
	done: number;
	failed: number;
	total: number;
}

export interface SnapshotAgent {
	id: string;
	role: string;
	status: string;
	currentTask: string | null;
	capabilities: string[];
	worktree: string | null;
	/** `now - heartbeat_at`. A number of ms: formatting is the frontend's job. */
	heartbeatAgeMs: number;
	/** Latest lease this agent holds (a claimed task's lease, or a review lease); `null` if none. */
	leaseUntilMs: number | null;
	isMain: boolean;
}

export interface SnapshotTask {
	id: string;
	title: string;
	status: string;
	priority: number;
	claimedBy: string | null;
	attempts: number;
	createdAtMs: number;
	updatedAtMs: number;
	claimedAtMs: number | null;
	leaseUntilMs: number | null;
	/** `now - createdAtMs`: how long the task has existed. Claim elapsed time is `now - claimedAtMs`. */
	ageMs: number;
	dependencies: string[];
	/** Why a `blocked` task cannot be claimed (`missing: …` / `cycle: …` / `waiting`); `null` otherwise. */
	blockedReason: string | null;
	requiredCapabilities: string[];
	files: string[];
	reviewRequired: boolean;
	reviewStatus: string | null;
	result: string | null;
	commit: string | null;
}

export interface SnapshotBoardEntry {
	id: number;
	type: string;
	taskId: string | null;
	/** The agent that posted it (`board.agent_id`). */
	author: string;
	createdAtMs: number;
	content: string;
}

export interface SnapshotMessage {
	id: number;
	from: string;
	to: string;
	taskId: string | null;
	urgent: boolean;
	createdAtMs: number;
	read: boolean;
	content: string;
}

export interface SnapshotReservation {
	/** The reserved pattern, e.g. `src/auth/**` or `src/parser.ts` (the `reservations.pattern` column). */
	path: string;
	agentId: string;
	taskId: string | null;
	leaseUntilMs: number;
}

export interface SnapshotEvent {
	createdAtMs: number;
	type: string;
	/** The event's `data` payload, verbatim JSON text. */
	content: string;
}

export interface Snapshot {
	now: number;
	swarmRoot: string;
	counts: SnapshotCounts;
	agents: SnapshotAgent[];
	tasks: SnapshotTask[];
	board: SnapshotBoardEntry[];
	messages: SnapshotMessage[];
	reservations: SnapshotReservation[];
	events: SnapshotEvent[];
	feed: { limit: number };
}

export interface Health {
	ok: true;
	dbPath: string;
	dbMtimeMs: number | null;
	readOnly: true;
	/** Open `/api/events` streams. */
	clients: number;
	startedAtMs: number;
}

/** The compact payload of an `event: snapshot` SSE frame (`/api/events`). */
export interface SnapshotSummary {
	now: number;
	counts: SnapshotCounts;
	/** Changes whenever the swarm moved; the client refetches `/api/snapshot` on a new hash. */
	hash: string;
}
