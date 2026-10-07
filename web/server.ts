#!/usr/bin/env bun
/**
 * The swarm dashboard's transport half: a standalone, read-only Bun server over `.swarm/swarm.db`.
 *
 *   bun run web/server.ts [--db <path>] [--port 8787] [--feed-limit 100] [--offline-after 60]
 *
 * GET /api/snapshot  the frozen Snapshot JSON (board DECISION #372)
 * GET /api/health    liveness + the DB file's mtime (the frontend's staleness probe)
 * GET /api/events    SSE; polls the DB at 1 Hz, emits `event: snapshot` only on change
 * everything else    404 for an unknown path, 405 for a non-GET method — there is no write route
 *
 * It binds 127.0.0.1 ONLY and never hardcodes an address: the page is unauthenticated and shows
 * the operator's whole swarm history, so a LAN binding would hand it to the network. The
 * database is opened `readonly: true` (see `lib/readonly.ts`), so even a bug cannot write.
 */
import { statSync, readFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { openReadonlyDb, type ReadonlyDatabase } from "./lib/readonly";
import { resolveAssetTarget } from "./lib/assets";
import { buildSnapshot, buildSummary, DEFAULT_FEED_LIMIT } from "./snapshot";
import type { Health, SnapshotSummary } from "./lib/types";

const HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_OFFLINE_AFTER_SECONDS = 60;
const DEFAULT_BUSY_TIMEOUT_MS = 5000;
/** How often the SSE stream re-reads the DB looking for a change. */
const DB_POLL_MS = 1000;
/** SSE keepalive comment cadence, per the contract. */
const KEEPALIVE_MS = 15_000;
/** Bun caps this at 255s; the 15s keepalive keeps the stream from idling out regardless. */
const IDLE_TIMEOUT_SECONDS = 255;

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
};

export interface ServerOptions {
	/** Path to `swarm.db`. The dashboard opens it read-only and never creates it. */
	dbPath: string;
	port?: number;
	/** Rows per newest-first feed (board / messages / events). */
	feedLimit?: number;
	/** Overrides the value read from `<root>/.swarm/config.json`; default 60, as the extension's. */
	offlineAfterSeconds?: number;
	assetsDir?: string;
	busyTimeoutMs?: number;
	/** Injected clock, so tests can pin `now`-derived ages. */
	now?: () => number;
	/** Suppress the startup banner (tests run many servers; the runner's output stays readable). */
	quiet?: boolean;
}

export interface RunningServer {
	readonly hostname: string;
	readonly port: number;
	readonly dbPath: string;
	readonly swarmRoot: string;
	stop(): void;
}

/** `http://127.0.0.1:8787`. */
function jsonResponse(payload: unknown): Response {
	return new Response(JSON.stringify(payload), {
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});
}

function textResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
	return new Response(`${body}\n`, {
		status,
		headers: { "content-type": "text/plain; charset=utf-8", ...headers },
	});
}

/** `<root>/.swarm/swarm.db` → `<root>`; anything else → the containing directory. */
function swarmRootOf(dbPath: string): string {
	const dir = resolve(dbPath, "..");
	return dir.endsWith(`${sep}.swarm`) ? resolve(dir, "..") : dir;
}

/** The extension reads this from `<root>/.swarm/config.json`; mirror it so the two never disagree. */
function configOfflineAfterSeconds(swarmRoot: string): number | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(swarmRoot, ".swarm", "config.json"), "utf8"));
		if (parsed !== null && typeof parsed === "object" && "offlineAfterSeconds" in parsed) {
			const value = parsed.offlineAfterSeconds;
			if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
		}
	} catch {
		// No config file, or an unreadable one: the default is the right fallback either way.
	}
	return undefined;
}

export function createServer(options: ServerOptions): RunningServer {
	const dbPath = resolve(options.dbPath);
	const swarmRoot = swarmRootOf(dbPath);
	const feedLimit = Math.max(0, Math.floor(options.feedLimit ?? DEFAULT_FEED_LIMIT));
	const offlineAfterSeconds =
		options.offlineAfterSeconds ?? configOfflineAfterSeconds(swarmRoot) ?? DEFAULT_OFFLINE_AFTER_SECONDS;
	const now = options.now ?? Date.now;
	const startedAtMs = now();
	const assetsDir = resolve(options.assetsDir ?? join(import.meta.dir, "assets"));

	let db: ReadonlyDatabase;
	try {
		db = openReadonlyDb(dbPath, options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
	} catch (error) {
		throw new Error(`cannot open ${dbPath} read-only: ${error instanceof Error ? error.message : String(error)}`);
	}

	let clients = 0;
	let stopped = false;

	const health = (): Health => {
		let dbMtimeMs: number | null = null;
		try {
			dbMtimeMs = statSync(dbPath).mtimeMs;
		} catch {
			// The DB was moved out from under us; `null` is the honest answer and the frontend's cue.
		}
		return { ok: true, dbPath, dbMtimeMs, readOnly: true, clients, startedAtMs };
	};

	async function serveAsset(pathname: string): Promise<Response> {
		const resolved = resolveAssetTarget(assetsDir, pathname);
		if (!resolved.ok) return textResponse(resolved.status, resolved.message);
		const file = Bun.file(resolved.target);
		if (!(await file.exists())) {
			return textResponse(404, `not found: ${pathname} (assets root: ${assetsDir})`);
		}
		return new Response(file, {
			headers: {
				"content-type": CONTENT_TYPES[extname(resolved.target).toLowerCase()] ?? "application/octet-stream",
				// No caching surprises while the frontend is being built, per the contract.
				"cache-control": "no-cache",
			},
		});
	}

	function eventsResponse(): Response {
		clients += 1;
		let cleanup: (() => void) | undefined;
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				let closed = false;
				let lastHash = "";
				let ticker: Timer | undefined;
				let heartbeat: Timer | undefined;
				const send = (chunk: string) => {
					if (closed) return;
					try {
						controller.enqueue(encoder.encode(chunk));
					} catch {
						cleanup?.();
					}
				};
				const tick = () => {
					let summary: SnapshotSummary;
					try {
						summary = buildSummary(db, now());
					} catch (error) {
						// A transient read failure must not kill a subscriber; the next tick retries.
						console.error(`[swarm-web] snapshot poll failed: ${error instanceof Error ? error.message : String(error)}`);
						return;
					}
					if (summary.hash === lastHash) return;
					lastHash = summary.hash;
					send(`event: snapshot\ndata: ${JSON.stringify(summary)}\n\n`);
				};
				cleanup = () => {
					if (closed) return;
					closed = true;
					clients -= 1;
					clearInterval(ticker);
					clearInterval(heartbeat);
					try {
						controller.close();
					} catch {
						// Already closed by the consumer.
					}
				};
				tick();
				ticker = setInterval(tick, DB_POLL_MS);
				heartbeat = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS);
			},
			cancel() {
				cleanup?.();
			},
		});
		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
			},
		});
	}

	const server = Bun.serve({
		hostname: HOSTNAME,
		port: options.port ?? DEFAULT_PORT,
		idleTimeout: IDLE_TIMEOUT_SECONDS,
		async fetch(request: Request): Promise<Response> {
			const url = new URL(request.url);
			const path = url.pathname;
			if (request.method !== "GET") {
				return textResponse(405, `${request.method} is not supported: this server is read-only`, { allow: "GET" });
			}
			try {
				switch (path) {
					case "/api/snapshot":
						return jsonResponse(buildSnapshot(db, { now: now(), swarmRoot, feedLimit, offlineAfterSeconds }));
					case "/api/health":
						return jsonResponse(health());
					case "/api/events":
						return eventsResponse();
					default:
						if (path.startsWith("/api/")) {
							return textResponse(404, `no such endpoint: ${path} (GET /api/snapshot | /api/health | /api/events)`);
						}
						return await serveAsset(path);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`[swarm-web] ${path} failed: ${message}`);
				return textResponse(500, `internal error: ${message}`);
			}
		},
	});

	// `Server.port` is optional in the types (a unix-socket server has none); a TCP bind always has one.
	const boundPort = server.port ?? options.port ?? DEFAULT_PORT;
	if (!options.quiet) {
		console.log(`[swarm-web] listening on http://${HOSTNAME}:${boundPort} (db ${dbPath}, read-only, feed ${feedLimit})`);
	}

	return {
		hostname: HOSTNAME,
		port: boundPort,
		dbPath,
		swarmRoot,
		stop(): void {
			if (stopped) return;
			stopped = true;
			server.stop(true);
			db.close();
		},
	};
}

export interface CliOptions {
	dbPath: string;
	port: number;
	feedLimit: number;
	offlineAfterSeconds?: number;
}

export const USAGE = `Usage: bun run web/server.ts [options]

  --db <path>            swarm database (default: ./.swarm/swarm.db)
  --port <number>        listen port on 127.0.0.1 (default: ${DEFAULT_PORT})
  --feed-limit <number>  rows per newest-first feed (default: ${DEFAULT_FEED_LIMIT})
  --offline-after <secs> heartbeat age that makes an agent offline (default: .swarm/config.json, else ${DEFAULT_OFFLINE_AFTER_SECONDS})
  --help                 this text

The server is read-only and binds 127.0.0.1 only.`;

/** Parse argv; a string return is the error message (never `process.exit` in library code). */
export function parseArgs(argv: string[]): CliOptions | string {
	const options: CliOptions = { dbPath: join(process.cwd(), ".swarm", "swarm.db"), port: DEFAULT_PORT, feedLimit: DEFAULT_FEED_LIMIT };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		const eq = arg.indexOf("=");
		const flag = eq === -1 ? arg : arg.slice(0, eq);
		const inline = eq === -1 ? undefined : arg.slice(eq + 1);
		const takeValue = (): string | undefined => {
			if (inline !== undefined) return inline;
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) return undefined;
			i += 1;
			return next;
		};
		const numeric = (value: string | undefined, name: string, min: number): number | string => {
			const parsed = Number(value);
			if (value === undefined || !Number.isFinite(parsed) || parsed < min) return `${name} needs a number >= ${min}, got ${JSON.stringify(value)}`;
			return Math.floor(parsed);
		};
		switch (flag) {
			case "--help":
			case "-h":
				return USAGE;
			case "--db": {
				const value = takeValue();
				if (value === undefined || value === "") return "--db needs a path";
				options.dbPath = value;
				break;
			}
			case "--port": {
				const value = numeric(takeValue(), "--port", 0);
				if (typeof value === "string") return value;
				options.port = value;
				break;
			}
			case "--feed-limit": {
				const value = numeric(takeValue(), "--feed-limit", 0);
				if (typeof value === "string") return value;
				options.feedLimit = value;
				break;
			}
			case "--offline-after": {
				const value = numeric(takeValue(), "--offline-after", 1);
				if (typeof value === "string") return value;
				options.offlineAfterSeconds = value;
				break;
			}
			default:
				return `unknown argument: ${arg}`;
		}
	}
	return options;
}

if (import.meta.main) {
	const parsed = parseArgs(process.argv.slice(2));
	if (typeof parsed === "string") {
		console.error(parsed.includes("\n") ? parsed : `${parsed}\n\n${USAGE}`);
		process.exit(parsed.includes("\n") ? 0 : 2);
	}
	let running: RunningServer;
	try {
		running = createServer({
			dbPath: parsed.dbPath,
			port: parsed.port,
			feedLimit: parsed.feedLimit,
			offlineAfterSeconds: parsed.offlineAfterSeconds,
		});
	} catch (error) {
		console.error(`[swarm-web] ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
	const shutdown = () => {
		running.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}
