/**
 * The dashboard's only door into the swarm database: a read-only `bun:sqlite` handle.
 *
 * `web/**` deliberately does NOT import `extension/**`. The extension's store is built for a
 * read-write connection — constructing it opens the DB, runs `PRAGMA journal_mode = WAL` and
 * the `CREATE TABLE IF NOT EXISTS` schema, and exposes `sweep()`/`claim()`/… that write. A
 * dashboard that imported it would hold write capability over the operator's live swarm and
 * could perturb it just by being opened. This module duplicates ~120 lines of row mapping
 * instead; that duplication is the price of isolation, and it is the smaller risk.
 */
import { Database } from "bun:sqlite";

/** Bindings this reader ever passes. Kept narrow on purpose: every query here is a literal. */
export type SqlParam = string | number | boolean | null;

/** The subset of the connection `buildSnapshot` needs, so tests can hand it any real DB. */
export interface ReadonlyQuery {
	all<T>(sql: string, ...params: SqlParam[]): T[];
}

export interface ReadonlyDatabase extends ReadonlyQuery {
	/** Absolute path of the file that was opened. */
	readonly path: string;
	close(): void;
}

/**
 * Open `path` read-only (never creates, never migrates, never writes) with a busy timeout, so a
 * concurrent swarm writer retries instead of surfacing `database is locked`.
 *
 * Read-only is enforced at the SQLite level (`SQLITE_OPEN_READONLY`), not by convention: any
 * accidental write in this process fails with `attempt to write a readonly database`.
 */
export function openReadonlyDb(path: string, busyTimeoutMs = 5000): ReadonlyDatabase {
	const db = new Database(path, { readonly: true });
	// A connection pragma, not a database write. The value is clamped to an integer, so the
	// interpolation cannot carry anything but a number.
	db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.floor(busyTimeoutMs))}`);
	return {
		path,
		all<T>(sql: string, ...params: SqlParam[]): T[] {
			return db.query<T, SqlParam[]>(sql).all(...params);
		},
		close(): void {
			db.close();
		},
	};
}
