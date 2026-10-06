import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type * as zod from "@oh-my-pi/omptype/zod";
import { expandWorkers, type WorkerSpec } from "./config";
import { renderPanel } from "./render";
import type { SwarmStore } from "./store";
import { buildSwarmTools, SWARM_TOOL_NAMES, type SwarmIdentity } from "./tools";
import type { RoleConfig, SwarmConfig } from "./types";

type HostSdk = ExtensionAPI["pi"];
type CreateOptions = NonNullable<Parameters<HostSdk["createAgentSession"]>[0]>;
type HostThinkingLevel = CreateOptions["thinkingLevel"];

const THINKING_LEVELS: Record<NonNullable<HostThinkingLevel>, true> = {
	inherit: true,
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
	auto: true,
};

export type TimerApi = Pick<ExtensionContext, "setInterval" | "clearTimer">;

export interface SwarmDriverDeps {
	sdk: HostSdk;
	store: SwarmStore;
	config: SwarmConfig;
	/** Swarm root: repository the workers operate on and the directory holding `.swarm/`. */
	root: string;
	z: typeof zod;
	timers: TimerApi;
	exec(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
	notify(text: string, level?: "info" | "warning" | "error"): void;
	/** Called whenever the roster changes so the host can repaint its panel. */
	onPanel(): void;
	/** Called once per run when every task is terminal (done or failed) and nothing is claimable. */
	onDrained?(): void;
	/** Deliver a message to the main session (native `pi.sendMessage` path). */
	deliverToMain?(text: string, urgent: boolean): void;
}

interface WorkerRuntime {
	spec: WorkerSpec;
	session: AgentSession;
	identity: SwarmIdentity;
	worktree: string;
	turns: number;
	lastTickAt: number;
	lastError?: string;
}

const TICK_INTERVAL_MS = 3000;
const PANEL_INTERVAL_MS = 2000;
const STOP_GRACE_MS = 90_000;
const SPAWN_TIMEOUT_MS = 120_000;

/** One slot per spawned worker: a growth step extends the exact callsign sequence the pool started. */
function roleSlots(specs: WorkerSpec[]): RoleConfig[] {
	return specs.map((spec) => ({ name: spec.role, count: 1, capabilities: spec.capabilities }));
}

/** Flatten a role shape into one slot per requested worker. */
function slotsFor(roles: RoleConfig[]): RoleConfig[] {
	const slots: RoleConfig[] = [];
	for (const role of roles) {
		for (let i = 0; i < role.count; i++) slots.push({ name: role.name, count: 1, capabilities: role.capabilities });
	}
	return slots;
}

/** Bound an await so a hung worker spawn cannot stall the rest of the swarm. */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	const expiry = Symbol("timeout");
	const { promise: deadline, resolve } = Promise.withResolvers<typeof expiry>();
	const timer = setTimeout(() => resolve(expiry), ms);
	try {
		const outcome = await Promise.race([promise, deadline]);
		if (outcome === expiry) throw new Error(`${what} timed out after ${Math.round(ms / 1000)}s`);
		return outcome;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The worker constitution. Workers are peers, not a manager's hands:
 * every decision (which task, when to split, what to share) lives with the agent
 * that holds the tools, and the shared database arbitrates ownership.
 */
export function workerSystemPrompt(spec: WorkerSpec, config: SwarmConfig, root: string): string {
	return [
		`You are ${spec.name}, a peer worker in a decentralized agent swarm (role: ${spec.role}).`,
		`Swarm root: ${root}. Shared state lives in .swarm/swarm.db; the whole swarm is flat — there is no manager above you.`,
		"",
		"Loop for every turn:",
		"1. swarm_inbox — read and answer peer messages.",
		"2. board_search — check FACT/DECISION entries and, above all, FAIL entries, so you never repeat a dead end.",
		"3. If you hold a task: continue it, and call swarm_renew when the work is long.",
		"4. Otherwise swarm_tasks (status=ready) and pick the best task for your capabilities; swarm_claim it. Losing the claim race is normal — pick another.",
		"5. Before editing files that another agent might touch, swarm_reserve them. Overlap is refused; that is the point.",
		"6. Verify your work (run the tests, run the command) before swarm_complete.",
		"7. Afterwards post what you learned: FACT for verified behaviour, FAIL for dead ends, RESULT for the outcome, QUESTION when you need a peer.",
		"",
		"Rules:",
		"- Never end your turn while the swarm is running and work is claimable: use swarm_wait, then claim again.",
		"- Never touch a task another agent has claimed. If it is stuck (lease expired), it returns to the pool by itself.",
		"- If a task is too large, split it with swarm_task_create (add dependencies instead of duplicating work).",
		"- If you cannot finish, swarm_release with a reason. Never stall silently.",
		"- Post a FAIL entry every time an approach fails; that is the cheapest gift you can give the swarm.",
		"- Two agents must not edit the same file: reservations expire with your lease, so renew them while you work.",
		"- Review tasks in `review` status are not yours to approve if you wrote them; swarm_review refuses that.",
		"",
		`Your capabilities: ${spec.capabilities.join(", ")}. Lease: ${config.leaseSeconds}s, renewed by any tool call and by heartbeat.`,
	].join("\n");
}

function workerBootstrap(spec: WorkerSpec, config: SwarmConfig): string {
	return [
		`You are starting as swarm worker ${spec.name} (role ${spec.role}).`,
		"Begin now:",
		"1. swarm_status to see the shared state.",
		"2. swarm_inbox and board_search (types FAIL, DECISION) to pick up prior knowledge.",
		"3. swarm_tasks status=ready, then swarm_claim the best match for your capabilities.",
		"4. Work the task in your working directory. Verify it. swarm_complete with a summary.",
		"5. Keep going: swarm_wait when the pool is empty, then claim again. Do not stop between tasks.",
		config.review
			? "If a task you own is in review status and you are not its author, you may swarm_review it."
			: "Review is disabled for this swarm; complete tasks directly.",
	].join("\n");
}

export class SwarmDriver {
	readonly #deps: SwarmDriverDeps;
	readonly #workers = new Map<string, WorkerRuntime>();
	#started: string[] = [];
	/** Role slot per spawned worker: a growth step extends the callsign sequence where the pool left off. */
	#slots: RoleConfig[] = [];
	#running = false;
	#tickHandle: Timer | undefined;
	#heartbeatHandle: Timer | undefined;
	#panelHandle: Timer | undefined;
	#drained = false;

	constructor(deps: SwarmDriverDeps) {
		this.#deps = deps;
	}

	get running(): boolean {
		return this.#running;
	}

	/** Diagnostic trace for headless runs (`SWARM_TRACE=1 omp …`). */
	#trace(message: string): void {
		if (process.env.SWARM_TRACE !== "1") return;
		try {
			appendFileSync(join(this.#deps.store.paths.dir, "driver.log"), `${new Date().toISOString()} ${message}\n`);
		} catch {
			// tracing must never affect the swarm
		}
	}

	get workers(): { name: string; role: string; status: string; task?: string; turns: number; worktree: string }[] {
		const agents = new Map(this.#deps.store.listAgents().map((a) => [a.id, a]));
		return [...this.#workers.values()].map((worker) => ({
			name: worker.spec.name,
			role: worker.spec.role,
			status: worker.session.isStreaming ? (agents.get(worker.spec.name)?.status ?? "working") : "idle",
			task: agents.get(worker.spec.name)?.currentTask,
			turns: worker.turns,
			worktree: worker.worktree,
		}));
	}

	async start(count = this.#deps.config.workers, roles?: RoleConfig[]): Promise<string[]> {
		if (this.#running) throw new Error("swarm is already running");
		const specs = expandWorkers(this.#deps.config, count, roles);
		this.#running = true;
		this.#drained = false;
		this.#started = [];
		this.#slots = roleSlots(specs);
		// Workers come up in the background: the caller (an extension command frame)
		// must not be blocked on N session creations, and one hung spawn must not
		// delay the rest of the swarm.
		void this.#spawnAll(specs);
		this.#tickHandle = this.#deps.timers.setInterval(() => void this.#tick(), TICK_INTERVAL_MS);
		this.#heartbeatHandle = this.#deps.timers.setInterval(() => this.#beat(), this.#deps.config.heartbeatSeconds * 1000);
		this.#panelHandle = this.#deps.timers.setInterval(() => this.#deps.onPanel(), PANEL_INTERVAL_MS);
		this.#deps.onPanel();
		return specs.map((spec) => spec.name);
	}

	/**
	 * Bring up `count` additional workers into the running pool. The callsign sequence continues where
	 * the pool left off, so grown workers never collide with the ones already registered. Clamped to
	 * the configured worker budget; returns the names it will try to start.
	 */
	async addWorkers(count: number, roles?: RoleConfig[]): Promise<string[]> {
		if (!this.#running) throw new Error("swarm is not running");
		// The offset is the number of *planned* slots, not the workers registered so far: a spawn that is
		// still in flight has already consumed its callsign, and reusing it would register two sessions
		// under one name.
		const planned = this.#slots.length;
		const room = Math.max(0, this.#deps.config.workers - planned);
		const want = Math.min(count, room);
		if (want <= 0) return [];
		const slots = [...this.#slots, ...slotsFor(roles ?? [])];
		const specs = expandWorkers(this.#deps.config, planned + want, slots).slice(planned, planned + want);
		this.#slots = slots;
		this.#trace(`grow: +${specs.length} worker(s) -> ${specs.map((spec) => spec.name).join(",")}`);
		void this.#spawnAll(specs);
		this.#deps.onPanel();
		return specs.map((spec) => spec.name);
	}

	async #spawnAll(specs: WorkerSpec[]): Promise<void> {
		for (const spec of specs) {
			if (!this.#running) return;
			try {
				await withTimeout(this.#spawn(spec), SPAWN_TIMEOUT_MS, `worker ${spec.name}: session creation`);
				this.#started.push(spec.name);
				void this.#prompt(this.#workers.get(spec.name) as WorkerRuntime, workerBootstrap(spec, this.#deps.config));
			} catch (error) {
				this.#deps.notify(
					`worker ${spec.name} failed to start: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				this.#trace(`spawn ${spec.name}: failed ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		this.#trace(`spawn: finished, started=${this.#started.join(",") || "(none)"}`);
		this.#deps.onPanel();
	}

	/** Names of the workers that actually came up. */
	get started(): readonly string[] {
		return this.#started;
	}

	async #spawn(spec: WorkerSpec): Promise<void> {
		const { sdk, store, config, root, z } = this.#deps;
		this.#trace(`spawn ${spec.name}: start (worktrees=${config.worktrees})`);
		const worktree = config.worktrees ? await this.#prepareWorktree(spec) : root;
		this.#trace(`spawn ${spec.name}: worktree=${worktree}`);
		const identity: SwarmIdentity = { id: spec.name, role: spec.role, capabilities: spec.capabilities, worktree, isMain: false };
		const sessionDir = join(store.paths.sessionsDir, spec.name);
		mkdirSync(sessionDir, { recursive: true });

		const tools = buildSwarmTools({
			store,
			config,
			identity,
			z,
			wake: (to, text, urgent) => this.wake(to, text, urgent),
			onChange: () => this.#deps.onPanel(),
		});

		const thinkingLevel: HostThinkingLevel | undefined =
			config.thinkingLevel !== undefined && config.thinkingLevel in THINKING_LEVELS
				? (config.thinkingLevel as NonNullable<HostThinkingLevel>)
				: undefined;

		const { session, modelFallbackMessage } = await sdk.createAgentSession({
			cwd: worktree,
			sessionManager: sdk.SessionManager.create(worktree, sessionDir),
			agentRegistry: new sdk.AgentRegistry(),
			modelPattern: config.model,
			thinkingLevel,
			appendSystemPrompt: workerSystemPrompt(spec, config, root),
			toolNames: [...new Set([...config.tools, ...SWARM_TOOL_NAMES])],
			restrictToolNames: true,
			allowRestrictedCustomTools: true,
			customTools: tools,
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			hasUI: false,
			interactivePrompts: false,
			bindProcessState: false,
			cacheWarming: false,
		});
		if (modelFallbackMessage) this.#deps.notify(`worker ${spec.name}: ${modelFallbackMessage}`, "warning");
		this.#trace(`spawn ${spec.name}: session ready id=${session.sessionId}`);

		const runtime: WorkerRuntime = { spec, session, identity, worktree, turns: 0, lastTickAt: 0 };
		this.#workers.set(spec.name, runtime);
		session.subscribe((event) => {
			if (event.type === "agent_start") {
				runtime.turns++;
			} else if (event.type === "agent_end" && event.isTerminal !== false) {
				runtime.lastTickAt = Date.now();
			}
		});
		store.registerAgent({
			id: spec.name,
			role: spec.role,
			capabilities: spec.capabilities,
			sessionId: session.sessionId,
			worktree,
			pid: process.pid,
		});
	}

	async #prepareWorktree(spec: WorkerSpec): Promise<string> {
		const { root, exec, notify, store } = this.#deps;
		const inside = await exec("git", ["rev-parse", "--is-inside-work-tree"], root).catch(() => undefined);
		if (!inside || inside.code !== 0 || inside.stdout.trim() !== "true") {
			notify(`worker ${spec.name}: not a git repository, using the shared checkout with file reservations`, "warning");
			return root;
		}
		const path = join(store.paths.worktreesDir, spec.name);
		const branch = `swarm/${spec.name.toLowerCase()}`;
		const added = await exec("git", ["worktree", "add", "-B", branch, path, "HEAD"], root).catch((error: unknown) => ({
			code: 1,
			stdout: "",
			stderr: String(error),
		}));
		if (added.code !== 0) {
			notify(`worker ${spec.name}: worktree creation failed (${added.stderr.trim() || "unknown"}), using the shared checkout`, "warning");
			return root;
		}
		return path;
	}

	#beat(): void {
		const { store, config } = this.#deps;
		for (const worker of this.#workers.values()) {
			const agent = store.getAgent(worker.spec.name);
			store.heartbeat(worker.spec.name, agent?.status ?? "idle", undefined, config.leaseSeconds);
		}
		store.sweep(config.offlineAfterSeconds);
	}

	async #tick(): Promise<void> {
		if (!this.#running) return;
		const { store, config } = this.#deps;
		for (const worker of this.#workers.values()) {
			if (worker.session.isStreaming) continue;
			const messages = store.inbox(worker.spec.name, 5);
			const mine = store.listTasks({ status: "claimed", agent: worker.spec.name, limit: 5 });
			if (messages.length > 0 || mine.length > 0) {
				await this.#prompt(worker, this.#continuationPrompt(worker, messages.length, mine.length));
				worker.lastTickAt = Date.now();
				continue;
			}
			const ready = store
				.listTasks({ status: "ready", limit: 50 })
				.filter((t) => t.requiredCapabilities.length === 0 || t.requiredCapabilities.some((cap) => worker.identity.capabilities.includes(cap)));
			const reviews = config.review ? store.listTasks({ status: "review", limit: 20 }).filter((t) => t.claimedBy !== worker.spec.name) : [];
			if (ready.length > 0 || reviews.length > 0) {
				await this.#prompt(worker, this.#continuationPrompt(worker, 0, 0, ready.length, reviews.length));
				worker.lastTickAt = Date.now();
				continue;
			}
			const idleFor = Date.now() - worker.lastTickAt;
			if (idleFor > config.idleTickSeconds * 1000) {
				await this.#prompt(worker, this.#continuationPrompt(worker, 0, 0, 0, 0));
				worker.lastTickAt = Date.now();
			}
		}
		const counts = this.#deps.store.counts();
		if (!this.#drained && counts.ready + counts.claimed + counts.review + counts.blocked === 0 && counts.done + counts.failed > 0) {
			this.#drained = true;
			this.#trace("tick: swarm drained");
			this.#deps.onDrained?.();
		}
	}

	#continuationPrompt(worker: WorkerRuntime, messages: number, mine: number, ready = 0, reviews = 0): string {
		if (messages > 0) return `You have ${messages} unread peer message(s). swarm_inbox, act on them, then continue the loop.`;
		if (mine > 0) return `You still hold ${mine} task(s). Continue or swarm_release with a reason.`;
		if (ready > 0) return `There are ${ready} claimable task(s) matching your capabilities. swarm_tasks status=ready, then swarm_claim one.`;
		if (reviews > 0) return `There are ${reviews} task(s) waiting for review. swarm_tasks status=review and review one you did not write.`;
		return `No claimable work right now (${worker.spec.name}). swarm_wait, then look again; if nothing useful exists, post a QUESTION or create the next task yourself.`;
	}

	async #prompt(worker: WorkerRuntime, text: string): Promise<void> {
		try {
			this.#trace(`prompt ${worker.spec.name}: begin (${text.slice(0, 60)}…)`);
			await worker.session.prompt(text);
			worker.lastError = undefined;
			this.#trace(`prompt ${worker.spec.name}: settled`);
		} catch (error) {
			worker.lastError = error instanceof Error ? error.message : String(error);
			this.#trace(`prompt ${worker.spec.name}: failed ${worker.lastError}`);
			this.#deps.notify(`worker ${worker.spec.name} turn failed: ${worker.lastError}`, "warning");
		}
	}

	/** Deliver a peer message into the target session through the native prompt path. */
	wake(to: string, text: string, urgent: boolean): void {
		if (to === "main") {
			this.#deps.deliverToMain?.(text, urgent);
			return;
		}
		const worker = this.#workers.get(to);
		if (!worker) return;
		void (async () => {
			try {
				if (worker.session.isStreaming) {
					await worker.session.sendUserMessage(text, { deliverAs: urgent ? "steer" : "followUp" });
				} else {
					await worker.session.prompt(text);
				}
			} catch (error) {
				this.#deps.notify(`wake of ${to} failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		})();
	}

	panelLines(): string[] {
		const snapshot = this.#deps.store.snapshot(this.#deps.config.offlineAfterSeconds, this.#running);
		return renderPanel(snapshot, 10);
	}

	/**
	 * Make one worker behave like a crashed process: its session is torn down
	 * without releasing anything, so its claim survives only until the lease
	 * expires and the sweeper reclaims it. Used by the integration run and by an
	 * operator testing recovery.
	 */
	async simulateCrash(name: string): Promise<boolean> {
		const worker = this.#workers.get(name);
		if (!worker) return false;
		this.#workers.delete(name);
		try {
			worker.session.abort();
		} catch {
			// the session may already be idle
		}
		try {
			await worker.session.dispose();
		} catch {
			// disposal failures must not stop the simulation
		}
		this.#deps.store.setAgentStatus(name, "offline");
		this.#trace(`crash ${name}: session disposed, held work left to expire`);
		this.#deps.onPanel();
		return true;
	}

	async stop(reason = "swarm stopped"): Promise<void> {
		if (!this.#running) return;
		this.#running = false;
		for (const handle of [this.#tickHandle, this.#heartbeatHandle, this.#panelHandle]) {
			if (handle !== undefined) this.#deps.timers.clearTimer(handle);
		}
		const shutdownPrompt = `${reason}. Finish the current step: if you hold a task, swarm_release it with a reason (or swarm_complete it if it is finished and verified), post a final RESULT/OBSERVATION to the board, then stop.`;
		for (const worker of this.#workers.values()) {
			try {
				if (worker.session.isStreaming) await worker.session.sendUserMessage(shutdownPrompt, { deliverAs: "followUp" });
				else await worker.session.prompt(shutdownPrompt);
			} catch {
				// a worker that cannot take the shutdown prompt is disposed below
			}
		}
		const deadline = Date.now() + STOP_GRACE_MS;
		while (Date.now() < deadline && [...this.#workers.values()].some((w) => w.session.isStreaming)) {
			await Bun.sleep(500);
		}
		for (const worker of this.#workers.values()) {
			this.#deps.store.unregisterAgent(worker.spec.name);
			try {
				await worker.session.dispose();
			} catch (error) {
				this.#deps.notify(`dispose of ${worker.spec.name} failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		}
		this.#workers.clear();
		this.#slots = [];
		this.#deps.onPanel();
	}
}
