/**
 * Test-only fixture: a throwaway `.swarm/swarm.db` with the real schema and known rows.
 *
 * `web/server.ts` and `web/snapshot.ts` never import this — they are the read-only product, and
 * this module is the one place in `web/**` that opens a WRITABLE connection. It exists so the two
 * web test files build the same database without importing `extension/**` (whose store would open
 * a read-write connection and run migrations as a side effect of being imported), and so the
 * column names `snapshot.ts` reads are stated once, next to the tests that pin them.
 *
 * The DDL below is copied from `extension/db.ts` for the seven tables the dashboard reads
 * (`agents`, `tasks`, `task_deps`, `reservations`, `board`, `messages`, `events`). `goals` is
 * not copied: nothing in the frozen v1 contract exposes a goal.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { SqlParam } from "./readonly";

/**
 * `bun:sqlite` types `Database.run`'s bindings as an array-of-arrays; `prepare(...).run(...)` is
 * the correctly-typed form for a positional call (the same form `extension/db.ts` uses).
 */
function run(db: Database, sql: string, ...params: SqlParam[]): void {
	db.prepare<null, SqlParam[]>(sql).run(...params);
}

export const FIXTURE_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  role        TEXT NOT NULL,
  status      TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  current_task TEXT,
  worktree    TEXT,
  pid         INTEGER,
  joined_at   INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  claimed_by    TEXT,
  author        TEXT,
  claimed_at    INTEGER,
  lease_until   INTEGER,
  required_capabilities TEXT NOT NULL DEFAULT '[]',
  files         TEXT NOT NULL DEFAULT '[]',
  result        TEXT,
  commit_ref    TEXT,
  review_required INTEGER NOT NULL DEFAULT 0,
  review_status TEXT,
  reviewer      TEXT,
  review_notes  TEXT,
  review_lease_until INTEGER,
  attempts      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS task_deps (
  task_id    TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on)
);

CREATE TABLE IF NOT EXISTS reservations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern     TEXT NOT NULL,
  owner       TEXT NOT NULL,
  task_id     TEXT,
  lease_until INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS board (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  task_id    TEXT,
  content    TEXT NOT NULL,
  tags       TEXT NOT NULL DEFAULT '[]',
  files      TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  to_agent   TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  body       TEXT NOT NULL,
  urgent     INTEGER NOT NULL DEFAULT 0,
  task_id    TEXT,
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  agent_id   TEXT,
  task_id    TEXT,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
`;

export interface FixtureDb {
	/** Temp swarm root; the database sits at `<root>/.swarm/swarm.db`, as in production. */
	root: string;
	path: string;
	/** Writable handle, for seeding only. */
	db: Database;
	close(): void;
}

const roots: string[] = [];

/** Create a temp root with the real schema. Call `closeFixtureDb` (or `close`) when done. */
export function makeFixtureDb(): FixtureDb {
	const root = mkdtempSync(join(tmpdir(), "swarm-web-test-"));
	roots.push(root);
	const dir = join(root, ".swarm");
	const path = join(dir, "swarm.db");
	mkdirSync(dir, { recursive: true });
	const db = new Database(path);
	db.exec(FIXTURE_SCHEMA);
	return {
		root,
		path,
		db,
		close() {
			db.close();
		},
	};
}

/** Remove every temp root this module created (call from `afterEach`). */
export function cleanupFixtureRoots(): void {
	for (const root of roots.splice(0)) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// Windows may hold the WAL handle for a moment; the OS temp dir is disposable.
		}
	}
}

export interface TaskSeed {
	id: string;
	title?: string;
	status?: string;
	priority?: number;
	createdBy?: string;
	createdAt: number;
	updatedAt?: number;
	claimedBy?: string | null;
	claimedAt?: number | null;
	leaseUntil?: number | null;
	requiredCapabilities?: string[];
	files?: string[];
	result?: string | null;
	commit?: string | null;
	reviewRequired?: boolean;
	reviewStatus?: string | null;
	reviewer?: string | null;
	reviewLeaseUntil?: number | null;
	attempts?: number;
}

export function insertTask(db: Database, seed: TaskSeed): void {
	run(db,
		`INSERT INTO tasks (id, title, description, status, priority, created_by, created_at, updated_at,
		   claimed_by, claimed_at, lease_until, required_capabilities, files, result, commit_ref,
		   review_required, review_status, reviewer, review_lease_until, attempts)
		 VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		seed.id,
		seed.title ?? seed.id,
		seed.status ?? "ready",
		seed.priority ?? 0,
		seed.createdBy ?? "main",
		seed.createdAt,
		seed.updatedAt ?? seed.createdAt,
		seed.claimedBy ?? null,
		seed.claimedAt ?? null,
		seed.leaseUntil ?? null,
		JSON.stringify(seed.requiredCapabilities ?? []),
		JSON.stringify(seed.files ?? []),
		seed.result ?? null,
		seed.commit ?? null,
		seed.reviewRequired ? 1 : 0,
		seed.reviewStatus ?? null,
		seed.reviewer ?? null,
		seed.reviewLeaseUntil ?? null,
		seed.attempts ?? 0,
	);
}

export function insertDependency(db: Database, taskId: string, dependsOn: string): void {
	run(db, "INSERT OR IGNORE INTO task_deps (task_id, depends_on) VALUES (?, ?)", taskId, dependsOn);
}

export interface AgentSeed {
	id: string;
	role?: string;
	status?: string;
	capabilities?: string[];
	currentTask?: string | null;
	worktree?: string | null;
	joinedAt: number;
	heartbeatAt: number;
}

export function insertAgent(db: Database, seed: AgentSeed): void {
	run(db,
		`INSERT INTO agents (id, session_id, role, status, capabilities, current_task, worktree, pid, joined_at, heartbeat_at)
		 VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?)`,
		seed.id,
		seed.role ?? "general",
		seed.status ?? "idle",
		JSON.stringify(seed.capabilities ?? ["general"]),
		seed.currentTask ?? null,
		seed.worktree ?? null,
		seed.joinedAt,
		seed.heartbeatAt,
	);
}

export function insertBoardEntry(
	db: Database,
	seed: { type: string; agentId: string; content: string; taskId?: string | null; createdAt: number },
): void {
	run(db,
		"INSERT INTO board (type, agent_id, task_id, content, tags, files, created_at) VALUES (?, ?, ?, ?, '[]', '[]', ?)",
		seed.type,
		seed.agentId,
		seed.taskId ?? null,
		seed.content,
		seed.createdAt,
	);
}

export function insertMessage(
	db: Database,
	seed: { to: string; from: string; body: string; urgent?: boolean; taskId?: string | null; createdAt: number; readAt?: number | null },
): void {
	run(db,
		"INSERT INTO messages (to_agent, from_agent, body, urgent, task_id, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		seed.to,
		seed.from,
		seed.body,
		seed.urgent ? 1 : 0,
		seed.taskId ?? null,
		seed.createdAt,
		seed.readAt ?? null,
	);
}

export function insertEvent(
	db: Database,
	seed: { type: string; agentId?: string | null; taskId?: string | null; data?: string; createdAt: number },
): void {
	run(db,
		"INSERT INTO events (type, agent_id, task_id, data, created_at) VALUES (?, ?, ?, ?, ?)",
		seed.type,
		seed.agentId ?? null,
		seed.taskId ?? null,
		seed.data ?? "{}",
		seed.createdAt,
	);
}

export function insertReservation(
	db: Database,
	seed: { pattern: string; owner: string; taskId?: string | null; leaseUntil: number; createdAt: number },
): void {
	run(db,
		"INSERT INTO reservations (pattern, owner, task_id, lease_until, created_at) VALUES (?, ?, ?, ?, ?)",
		seed.pattern,
		seed.owner,
		seed.taskId ?? null,
		seed.leaseUntil,
		seed.createdAt,
	);
}
