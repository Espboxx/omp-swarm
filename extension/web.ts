/**
 * `/swarm web`: the dashboard as a SEPARATE CHILD PROCESS.
 *
 * The server (`web/server.ts`) is never imported or run in-process: it is spawned, so a bug in it
 * cannot block the TUI's event loop or the swarm. The parts that are pure — argument parsing, port
 * validation, the free-port scan and the URL/state text — live here so they can be unit-tested
 * without a host; the process handling sits behind {@link WebDashboard}.
 */
import { basename } from "node:path";
import type { Subprocess } from "bun";

/** The port `/swarm web` starts from; a taken one steps upward. */
export const DEFAULT_WEB_PORT = 8787;
/** How many consecutive ports to probe before giving up. */
export const PORT_SCAN_ATTEMPTS = 20;
export const MIN_PORT = 1;
export const MAX_PORT = 65_535;
/** The page is unauthenticated and shows the operator's whole swarm history, so never widen this. */
export const WEB_HOST = "127.0.0.1";
/** How long to wait for the child's `/api/health` before calling the start failed. */
const READY_TIMEOUT_MS = 4000;

export type WebAction = "start" | "stop" | "status";

export interface WebOptions {
	action: WebAction;
	port?: number;
}

export type WebParse = { ok: true; options: WebOptions } | { ok: false; error: string };

export const WEB_USAGE = "usage: /swarm web [start|stop|status] [--port N]";

export function isValidPort(value: number): boolean {
	return Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}

export function webUrl(port: number): string {
	return `http://${WEB_HOST}:${port}`;
}

/**
 * Parse the subcommand. No argument starts the dashboard — that is the "one keystroke" the operator
 * asked for — and `--port` is only meaningful for a start, so passing it to `status` is an error
 * rather than a silent no-op.
 */
export function parseWebArgs(rest: string[]): WebParse {
	let action: WebAction = "start";
	let sawAction = false;
	let port: number | undefined;
	for (let index = 0; index < rest.length; index++) {
		const token = rest[index] ?? "";
		if (token === "start" || token === "stop" || token === "status") {
			if (sawAction && action !== token) return { ok: false, error: `${WEB_USAGE} (one action at a time)` };
			action = token;
			sawAction = true;
			continue;
		}
		const inline = token.startsWith("--port=") ? token.slice("--port=".length) : undefined;
		if (token === "--port" || inline !== undefined) {
			const raw = inline ?? rest[++index];
			if (raw === undefined) return { ok: false, error: `--port needs a number. ${WEB_USAGE}` };
			const value = Number(raw);
			if (!isValidPort(value)) return { ok: false, error: `invalid port ${JSON.stringify(raw)}: ${WEB_USAGE} (1-${MAX_PORT})` };
			port = value;
			continue;
		}
		return { ok: false, error: `unknown option ${JSON.stringify(token)}. ${WEB_USAGE}` };
	}
	if (port !== undefined && action !== "start") return { ok: false, error: `--port only applies to "start". ${WEB_USAGE}` };
	return { ok: true, options: { action, port } };
}

/**
 * The first free port at or above `from`, or `undefined` when the whole scan is taken. Pure: the
 * caller supplies the probe, so the scan is unit-tested without binding anything.
 */
export function nextFreePort(from: number, isFree: (port: number) => boolean, attempts = PORT_SCAN_ATTEMPTS): number | undefined {
	const start = Math.max(MIN_PORT, from);
	const end = Math.min(MAX_PORT, start + attempts - 1);
	for (let port = start; port <= end; port++) {
		if (isFree(port)) return port;
	}
	return undefined;
}

/** Whether a port is free to bind, by actually binding it and letting go again. */
export function isPortFree(port: number): boolean {
	try {
		const probe = Bun.serve({ hostname: WEB_HOST, port, fetch: () => new Response("probe") });
		probe.stop(true);
		return true;
	} catch {
		return false;
	}
}

export interface WebState {
	pid: number;
	port: number;
	url: string;
	startedAtMs: number;
}

export type WebStart = { ok: true; state: WebState } | { ok: false; error: string };

/** The `bun` binary the dashboard runs on: the PATH one, else the running one when it *is* bun. */
export function bunBinary(): string | undefined {
	const onPath = Bun.which("bun");
	if (onPath !== null && onPath !== "") return onPath;
	return /^bun(\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : undefined;
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${url}/api/health`);
			if (response.ok) return true;
		} catch {
			// Not listening yet.
		}
		await Bun.sleep(100);
	}
	return false;
}

/** One dashboard per swarm root; `start` is idempotent and `stop` is safe to call twice. */
export class WebDashboard {
	readonly #root: string;
	readonly #serverPath: string;
	#child?: Subprocess;
	#state?: WebState;

	constructor(root: string, serverPath: string) {
		this.#root = root;
		this.#serverPath = serverPath;
	}

	get state(): WebState | undefined {
		return this.isRunning() ? this.#state : undefined;
	}

	isRunning(): boolean {
		return this.#child !== undefined && this.#child.exitCode === null;
	}

	/** Start (or reuse) the child. Reports the ACTUAL url, never the requested one. */
	async start(preferredPort?: number): Promise<WebStart> {
		const running = this.state;
		if (running !== undefined) return { ok: true, state: running };
		const binary = bunBinary();
		if (binary === undefined) {
			return { ok: false, error: "no bun binary found: the dashboard runs as its own bun process, so `bun` must be on PATH" };
		}
		const explicit = preferredPort !== undefined;
		const port = explicit ? (isPortFree(preferredPort) ? preferredPort : undefined) : nextFreePort(DEFAULT_WEB_PORT, isPortFree);
		if (port === undefined) {
			const suggestion = explicit ? nextFreePort((preferredPort ?? DEFAULT_WEB_PORT) + 1, isPortFree) : undefined;
			return {
				ok: false,
				error: explicit
					? `port ${preferredPort} is already in use${suggestion === undefined ? "" : `; try --port ${suggestion}`}`
					: `no free port in ${DEFAULT_WEB_PORT}-${DEFAULT_WEB_PORT + PORT_SCAN_ATTEMPTS - 1}`,
			};
		}
		const child = Bun.spawn({
			cmd: [binary, this.#serverPath, "--port", String(port)],
			cwd: this.#root,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		});
		this.#child = child;
		this.#state = { pid: child.pid, port, url: webUrl(port), startedAtMs: Date.now() };
		if (await waitForHealth(this.#state.url, READY_TIMEOUT_MS)) return { ok: true, state: this.#state };
		const detail = await this.#failureDetail(child);
		this.stop();
		return { ok: false, error: `the dashboard never answered ${this.#state.url}/api/health${detail === "" ? "" : `: ${detail}`}` };
	}

	/** Kill the child (and, on Windows, its tree). Returns whether anything was running. */
	stop(): boolean {
		const child = this.#child;
		const wasRunning = this.isRunning();
		this.#child = undefined;
		this.#state = undefined;
		if (child === undefined) return false;
		try {
			if (process.platform === "win32") Bun.spawnSync(["taskkill", "/PID", String(child.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
			else child.kill();
		} catch {
			// Already gone: nothing to report, the port check in `status` is the source of truth.
		}
		return wasRunning;
	}

	/** One line for `/swarm web status`: the truth about what is listening right now. */
	statusLine(): string {
		const state = this.state;
		if (state === undefined) return `dashboard: stopped (nothing of ours holds a port; /swarm web starts one)`;
		return `dashboard: running on ${state.url} (pid ${state.pid}, read-only, ${WEB_HOST} only; /swarm web stop to end it)`;
	}

	/** The last line the child wrote to stderr, for a start that failed to answer health. */
	async #failureDetail(child: Subprocess): Promise<string> {
		const stream = child.stderr;
		if (!(stream instanceof ReadableStream)) return "";
		try {
			const text = await Promise.race([new Response(stream).text(), Bun.sleep(500).then(() => "")]);
			return text.trim().split("\n").filter(Boolean).at(-1) ?? "";
		} catch {
			return "";
		}
	}
}
