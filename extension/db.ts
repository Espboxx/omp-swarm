import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database, type Changes, type SQLQueryBindings } from "bun:sqlite";
import type { SwarmEvent } from "./types";

/**
 * Shared swarm workspace: `.swarm/` inside the swarm root.
 * One directory holds the SQLite blackboard, the append-only event log, and
 * scratch space for worker worktrees and session files.
 */
export interface SwarmPaths {
	root: string;
	dir: string;
	dbFile: string;
	eventsFile: string;
	configFile: string;
	sessionsDir: string;
	worktreesDir: string;
}

export function swarmPaths(root: string): SwarmPaths {
	const dir = join(root, ".swarm");
	return {
		root,
		dir,
		dbFile: join(dir, "swarm.db"),
		eventsFile: join(dir, "events.jsonl"),
		configFile: join(dir, "config.json"),
		sessionsDir: join(dir, "sessions"),
		worktreesDir: join(dir, "worktrees"),
	};
}

export function ensureSwarmDirs(paths: SwarmPaths): void {
	for (const d of [paths.dir, paths.sessionsDir, paths.worktreesDir]) mkdirSync(d, { recursive: true });
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 10000;

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
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks(status, lease_until);

CREATE TABLE IF NOT EXISTS task_deps (
  task_id    TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on)
);

CREATE TABLE IF NOT EXISTS goals (
  id            TEXT PRIMARY KEY,
  goal          TEXT NOT NULL,
  agents        INTEGER NOT NULL,
  status        TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deadline_at   INTEGER NOT NULL,
  planning_task TEXT NOT NULL,
  planner       TEXT,
  planned_at    INTEGER,
  result        TEXT
);
CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);

CREATE TABLE IF NOT EXISTS scale_requests (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id       TEXT NOT NULL,
  reason         TEXT NOT NULL,
  requested      INTEGER NOT NULL,
  current        INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  decided_at     INTEGER,
  decided_action TEXT,
  decided_size   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_scale_pending ON scale_requests(decided_at, created_at);

CREATE TABLE IF NOT EXISTS reservations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern     TEXT NOT NULL,
  owner       TEXT NOT NULL,
  task_id     TEXT,
  lease_until INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resv_owner ON reservations(owner);

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
CREATE INDEX IF NOT EXISTS idx_board_type ON board(type);
CREATE INDEX IF NOT EXISTS idx_board_task ON board(task_id);

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
CREATE INDEX IF NOT EXISTS idx_msg_to ON messages(to_agent, read_at);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  agent_id   TEXT,
  task_id    TEXT,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
`;

export interface OpenOptions {
	readonly?: boolean;
}

/**
 * Thin typed facade over `bun:sqlite`. Bun's own generics put the row type on
 * `query()` and the binding tuple on the statement, which reads badly at every
 * call site; this keeps row typing on the helper instead.
 */
export class Db {
	readonly #database: Database;

	constructor(database: Database) {
		this.#database = database;
	}

	run(sql: string, ...params: SQLQueryBindings[]): Changes {
		return this.#database.prepare<Changes, SQLQueryBindings[]>(sql).run(...params);
	}

	get<T>(sql: string, ...params: SQLQueryBindings[]): T | null {
		return this.#database.query<T, SQLQueryBindings[]>(sql).get(...params);
	}

	all<T>(sql: string, ...params: SQLQueryBindings[]): T[] {
		return this.#database.query<T, SQLQueryBindings[]>(sql).all(...params);
	}

	exec(sql: string): void {
		this.#database.exec(sql);
	}

	transaction<T>(body: () => T): T {
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const result = body();
			this.#database.exec("COMMIT");
			return result;
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	close(): void {
		this.#database.close();
	}
}

/**
 * Schema-complete in-memory database. Used for metadata-only work (building a
 * tool catalog at load time) so that merely loading an extension never creates
 * files on disk.
 */
export function openInMemoryDatabase(): Db {
	const db = new Database(":memory:");
	db.exec(SCHEMA);
	return new Db(db);
}

export function openDatabase(paths: SwarmPaths, options: OpenOptions = {}): Db {
	if (!options.readonly) ensureSwarmDirs(paths);
	const db = new Database(paths.dbFile, options.readonly ? { readonly: true } : undefined);
	if (!options.readonly) db.exec(SCHEMA);
	return new Db(db);
}

/**
 * Append a structured event to `.swarm/events.jsonl`.
 * Best-effort: the event log is an audit trail, never a correctness dependency.
 */
export function appendEventLine(paths: SwarmPaths, event: Omit<SwarmEvent, "id">): void {
	try {
		appendFileSync(paths.eventsFile, `${JSON.stringify(event)}\n`);
	} catch {
		// audit trail only; never fail an operation on it
	}
}
