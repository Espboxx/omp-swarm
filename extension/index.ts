import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { matchesKey, type Component, type KeyId } from "@oh-my-pi/pi-tui";
import { AUTO_TICK_MS, AutoController } from "./auto";
import { loadSwarmConfig, expandWorkers, saveSwarmAuto } from "./config";
import { appendEventLine, openDatabase, openInMemoryDatabase, swarmPaths, type SwarmPaths } from "./db";
import { SwarmDriver, type SwarmDriverDeps, type TimerApi } from "./driver";
import { applyPanelKey, renderPanelLines, statusLineText, type PanelModel, type PanelRow, type PanelStatus } from "./panel";
import { renderAgents, renderBoard, renderSummary, renderTasks } from "./render";
import { SwarmStore } from "./store";
import { buildSwarmTools, isBoardType, isTaskStatus, type SwarmIdentity } from "./tools";
import { DEFAULT_CONFIG, type AgentStatus, type SwarmConfig } from "./types";

const MAIN_AGENT_ID = "main";
const PANEL_STATUS_KEY = "swarm";
const PANEL_WIDGET_KEY = "swarm-panel";
const PANEL_TITLE = "MULTI-AGENT MODE";
/** Columns the left panel occupies; forwarded as `overlayOptions.width`. */
const PANEL_WIDTH = 30;
/** Floor on the rendered roster so a cursor can never sit beyond the last painted row. */
const PANEL_MIN_ROWS = 8;

/** The host keys the panel answers, mapped onto the frozen reducer's names in `panel.ts`. */
const PANEL_KEYS: ReadonlyArray<readonly [KeyId, string]> = [
	["up", "up"],
	["down", "down"],
	["enter", "enter"],
	["k", "k"],
	["j", "j"],
	["r", "r"],
	["s", "s"],
	["q", "q"],
];

/** Terminal bytes -> reducer key name, or undefined when the panel does not own that key. */
export function panelKey(data: string): string | undefined {
	for (const [keyId, name] of PANEL_KEYS) if (matchesKey(data, keyId)) return name;
	return undefined;
}

export interface AgentPanelHooks {
	/** Live roster; re-read on every render so agents joining mid-mode show up. */
	rows(): PanelRow[];
	onSelect(row: PanelRow): void;
	onReload(): void;
	onStatus(): void;
	onQuit(): void;
}

/**
 * The MULTI-AGENT MODE agent list as a host component. It owns only the cursor/selection state and
 * delegates every list decision to the pure `panel.ts` module, so the host wiring stays a thin
 * adapter (`ctx.ui.custom` -> this component -> `applyPanelKey`).
 */
export function createAgentListPanel(hooks: AgentPanelHooks): Component {
	let model: PanelModel = { title: PANEL_TITLE, rows: [], cursor: 0, now: Date.now() };
	const sync = (): PanelRow[] => {
		const rows = hooks.rows();
		model = { ...model, rows, now: Date.now(), cursor: Math.max(0, Math.min(model.cursor, rows.length - 1)) };
		return rows;
	};
	return {
		render(width: number): readonly string[] {
			sync();
			return renderPanelLines(model, { width: Math.max(width, 16), maxRows: Math.max(PANEL_MIN_ROWS, model.rows.length) });
		},
		handleInput(data: string): void {
			sync();
			const key = panelKey(data);
			if (key === undefined) return;
			const { model: next, action } = applyPanelKey(model, key);
			model = next;
			switch (action.kind) {
				case "select": {
					const row = model.rows[model.cursor];
					if (row !== undefined && row.id === action.id) {
						model = { ...model, selected: row.id };
						hooks.onSelect(row);
					}
					return;
				}
				case "reload":
					hooks.onReload();
					return;
				case "status":
					hooks.onStatus();
					return;
				case "quit":
					hooks.onQuit();
					return;
				default:
					return;
			}
		},
	};
}

/** The live panel mounted in a TUI host; `selected` drives the status line. */
interface AgentPanelSession {
	selected?: { id: string; label: string };
	close(): void;
}

interface Runtime {
	root: string;
	paths: SwarmPaths;
	store: SwarmStore;
	config: SwarmConfig;
	driver?: SwarmDriver;
	auto?: AutoController;
	autoTimer?: Timer;
	panel?: AgentPanelSession;
}

/**
 * Per-root swarm runtime. Nothing touches the filesystem until a tool or a
 * command actually needs the shared database, so merely loading the extension
 * never creates `.swarm/` in unrelated projects.
 */
class SwarmRuntimes {
	readonly #runtimes = new Map<string, Runtime>();
	readonly #z: ExtensionAPI["zod"];

	constructor(z: ExtensionAPI["zod"]) {
		this.#z = z;
	}

	for(root: string): Runtime {
		const absolute = resolve(root);
		const paths = swarmPaths(absolute);
		const config = loadSwarmConfig(paths.configFile);
		const existing = this.#runtimes.get(absolute);
		if (existing) return existing;
		const runtime: Runtime = { root: absolute, paths, store: new SwarmStore(openDatabase(paths), paths), config };
		this.#runtimes.set(absolute, runtime);
		return runtime;
	}

	/** Peek without creating anything: used by the panel on session start. */
	peek(root: string): Runtime | undefined {
		return this.#runtimes.get(resolve(root));
	}

	identity(runtime: Runtime, id = MAIN_AGENT_ID): SwarmIdentity {
		return { id, role: "main", capabilities: ["general", "reviewer", "integrator"], worktree: runtime.root, isMain: true };
	}

	toolkit(runtime: Runtime, identity = this.identity(runtime), wake?: (to: string, text: string, urgent: boolean) => void) {
		return buildSwarmTools({
			store: runtime.store,
			config: runtime.config,
			identity,
			z: this.#z,
			wake,
		});
	}

	driver(runtime: Runtime, deps: Omit<SwarmDriverDeps, "store" | "config" | "root" | "z">): SwarmDriver {
		const existing = runtime.driver;
		if (existing) return existing;
		const driver = new SwarmDriver({ ...deps, store: runtime.store, config: runtime.config, root: runtime.root, z: this.#z });
		runtime.driver = driver;
		return driver;
	}

	async stopAll(): Promise<void> {
		for (const runtime of this.#runtimes.values()) {
			await runtime.driver?.stop("session shutting down");
			runtime.store.close();
		}
		this.#runtimes.clear();
	}
}

export default function swarm(pi: ExtensionAPI): void {
	const runtimes = new SwarmRuntimes(pi.zod);
	/** Newest `ExtensionContext` per root: the controller's closures outlive the hook that built them. */
	const contexts = new Map<string, ExtensionContext>();
	const controllers = new Set<AutoController>();
	const remember = (root: string, ctx: ExtensionContext): void => {
		contexts.set(resolve(root), ctx);
	};

	/**
	 * Registration only needs names, descriptions and schemas. The catalog is
	 * built against a throwaway in-memory database so that loading the extension
	 * has no side effects on disk.
	 */
	const catalogPaths = swarmPaths(join(tmpdir(), "omp-swarm-catalog"));
	const catalog = buildSwarmTools({
		store: new SwarmStore(openInMemoryDatabase(), catalogPaths),
		config: DEFAULT_CONFIG,
		identity: { id: MAIN_AGENT_ID, role: "main", capabilities: ["general"], isMain: true },
		z: pi.zod,
	});

	for (const tool of catalog) {
		pi.registerTool({
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			approval: tool.approval,
			async execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
				const runtime = runtimes.for(ctx.cwd);
				const toolkit = runtimes.toolkit(runtime, runtimes.identity(runtime), (to, text, urgent) => {
					if (runtime.driver) runtime.driver.wake(to, text, urgent);
					else pi.sendMessage({ customType: "swarm", content: `[swarm] ${to}: ${text}`, display: true }, { deliverAs: "followUp" });
				});
				const target = toolkit.find((candidate) => candidate.name === tool.name);
				if (!target) return { content: [{ type: "text", text: `tool ${tool.name} is unavailable` }] };
				// Swarm tools never read their context, so the narrower custom-tool
				// context is forwarded from the extension context as-is.
				const toolContext = ctx as unknown as Parameters<typeof target.execute>[3];
				return target.execute(toolCallId, params, onUpdate, toolContext, signal);
			},
		});
	}

	const timersFrom = (ctx: ExtensionContext): TimerApi => ({
		setInterval: (callback: Parameters<ExtensionContext["setInterval"]>[0], ms?: number) => ctx.setInterval(callback, ms),
		clearTimer: (timer: Timer) => ctx.clearTimer(timer),
	});

	const refreshPanel = (ctx: ExtensionContext, runtime: Runtime | undefined): void => {
		if (!runtime) {
			ctx.ui.setStatus(PANEL_STATUS_KEY, undefined);
			ctx.ui.setWidget(PANEL_WIDGET_KEY, []);
			return;
		}
		const snapshot = runtime.store.snapshot(runtime.config.offlineAfterSeconds, runtime.driver?.running ?? false);
		const counts = snapshot.counts;
		const legacy = runtime.driver?.running
			? `swarm ${snapshot.agents.length}a r${counts.ready} c${counts.claimed} v${counts.review} d${counts.done}`
			: undefined;
		// A selection owns the status line; otherwise the mode keeps painting its phase text.
		const selected = runtime.panel?.selected;
		ctx.ui.setStatus(PANEL_STATUS_KEY, selected ? statusLineText(selected.label) : (runtime.auto?.statusText() ?? legacy));
		ctx.ui.setWidget(PANEL_WIDGET_KEY, panelWidgetLines(ctx, runtime), { placement: "aboveEditor" });
	};

	/**
	 * What the string-array widget carries. In a TUI the overlay IS the panel, so the widget keeps
	 * the mode's own summary; every host that cannot mount a component (rpc/print - `custom()`
	 * returns undefined there) gets the panel itself as text, which is the contract's fallback.
	 */
	const panelWidgetLines = (ctx: ExtensionContext, runtime: Runtime): string[] => {
		if (!runtime.config.auto) return [...(runtime.auto?.header() ?? []), ...(runtime.driver?.panelLines() ?? [])];
		if (ctx.mode === "tui" && runtime.panel !== undefined) return [];
		return renderPanelLines(panelModel(runtime), { width: PANEL_WIDTH });
	};

	const autoFor = (runtime: Runtime, ctx: ExtensionContext): AutoController => {
		if (runtime.auto) return runtime.auto;
		remember(runtime.root, ctx);
		const latest = (): ExtensionContext => contexts.get(runtime.root) ?? ctx;
		const auto = new AutoController({
			store: runtime.store,
			config: runtime.config,
			isDriverRunning: () => runtime.driver?.running ?? false,
			workerCount: () => runtime.driver?.workers.length ?? 0,
			startSwarm: async (roles, count) => {
				const driver = ensureDriver(latest(), runtime);
				// A pool that is already up takes the delta: growth must add workers, never restart a
				// running swarm and release the work it holds.
				return driver.running ? driver.addWorkers(count, roles) : driver.start(count, roles);
			},
			stopSwarm: async (reason) => {
				await runtime.driver?.stop(reason);
			},
			isMainBusy: () => latest().isIdle() === false,
			nudgeToMain: (text) => pi.sendMessage({ customType: "swarm", content: text, display: false }, { deliverAs: "steer" }),
			notifyMain: (text) => pi.sendMessage({ customType: "swarm", content: text, display: true }, { deliverAs: "followUp" }),
			notify: (text, level) => latest().ui.notify(text, level ?? "info"),
			onChange: () => refreshPanel(latest(), runtime),
			now: () => Date.now(),
			onEvent: (type, data) =>
				appendEventLine(runtime.paths, { type, agentId: MAIN_AGENT_ID, createdAt: Date.now(), data: data ?? {} }),
		});
		runtime.auto = auto;
		controllers.add(auto);
		return auto;
	};

	const autoTimer = (runtime: Runtime, ctx: ExtensionContext): void => {
		if (runtime.autoTimer !== undefined) ctx.clearTimer(runtime.autoTimer);
		runtime.autoTimer = ctx.setInterval(() => void runtime.auto?.tick(), AUTO_TICK_MS);
	};

	const clearAutoTimer = (runtime: Runtime, ctx: ExtensionContext): void => {
		if (runtime.autoTimer === undefined) return;
		ctx.clearTimer(runtime.autoTimer);
		runtime.autoTimer = undefined;
	};

	/** Newest context for a root, so the panel's own keys can repaint and notify. */
	const panelCtx = (runtime: Runtime): ExtensionContext | undefined => contexts.get(runtime.root);

	const panelStatus = (status: AgentStatus | undefined): PanelStatus => {
		switch (status) {
			case "working":
				return "working";
			case "reviewing":
				return "reviewing";
			case "offline":
				return "offline";
			// An agent with nothing in flight (`idle`, `waiting`, `blocked`) reads as idle here.
			default:
				return "idle";
		}
	};

	/**
	 * The mode's roster: the configured planner roster first (so the panel is meaningful before the
	 * pool starts), with live agents merged in. The swarm tracks no per-agent model - `config.model`
	 * is shared by every worker - so the row label is the callsign, matching the mock's
	 * "numbered rows, name + status".
	 */
	const panelRows = (runtime: Runtime): PanelRow[] => {
		const live = new Map(runtime.store.listAgents().map((agent) => [agent.id, agent]));
		const planned = expandWorkers(runtime.config).map((spec) => spec.name);
		const known = new Set(planned);
		const ids = [...planned, ...[...live.keys()].filter((id) => !known.has(id))];
		return ids.map((id, index) => ({ index: index + 1, id, label: id, status: panelStatus(live.get(id)?.status) }));
	};

	const panelModel = (runtime: Runtime): PanelModel => ({
		title: PANEL_TITLE,
		rows: panelRows(runtime),
		cursor: 0,
		selected: runtime.panel?.selected?.id,
		now: Date.now(),
	});

	const closePanel = (runtime: Runtime): void => {
		const session = runtime.panel;
		runtime.panel = undefined;
		session?.close();
	};

	/**
	 * Enter = select the agent under the cursor. The status line shows it immediately; the model
	 * side of the switch applies only when the row names a model the host can resolve, and says so
	 * when it cannot - a selection never fails silently.
	 */
	const selectAgent = (ctx: ExtensionContext, runtime: Runtime, row: PanelRow): void => {
		if (ctx.models.resolve(row.label) !== undefined) {
			runtime.config.model = row.label;
			ctx.ui.notify(`selected ${row.label}: worker spawns now use ${row.label}`, "info");
		} else {
			ctx.ui.notify(
				`selected ${row.label}: no per-agent model to apply (workers keep ${runtime.config.model ?? "the session default model"})`,
				"warning",
			);
		}
		refreshPanel(ctx, runtime);
	};

	/** `q` in the panel: the same path `/swarm off` takes. */
	const quitFromPanel = async (runtime: Runtime): Promise<void> => {
		const ctx = panelCtx(runtime);
		if (!ctx) return;
		await disableAuto(ctx, runtime);
		ctx.ui.notify("multi-agent mode OFF (q in the agent panel)", "info");
	};

	/**
	 * Mount the agent list as a left-anchored overlay (`anchor: "left-center"`, the contract's
	 * verdict). Only the interactive TUI can run an extension-owned component, so anything else
	 * keeps the widget fallback `refreshPanel` paints.
	 */
	const openPanel = (ctx: ExtensionContext, runtime: Runtime): void => {
		if (ctx.mode !== "tui" || !ctx.hasUI || runtime.panel !== undefined) return;
		remember(runtime.root, ctx);
		const session: AgentPanelSession = { close: () => {} };
		runtime.panel = session;
		let dismiss: ((result: string | undefined) => void) | undefined;
		let closedEarly = false;
		session.close = () => {
			closedEarly = true;
			dismiss?.(undefined);
		};
		const component = createAgentListPanel({
			rows: () => panelRows(runtime),
			onSelect: (row) => {
				session.selected = { id: row.id, label: row.label };
				const target = panelCtx(runtime);
				if (target) selectAgent(target, runtime, row);
			},
			onReload: () => {
				const target = panelCtx(runtime);
				if (!target) return;
				refreshPanel(target, runtime);
				target.ui.notify(`agent list reloaded: ${panelRows(runtime).length} agent(s)`, "info");
			},
			onStatus: () => {
				panelCtx(runtime)?.ui.notify(renderAgents(runtime.store.listAgents(), Date.now()), "info");
			},
			onQuit: () => void quitFromPanel(runtime),
		});
		const pending = ctx.ui.custom<string | undefined>(
			(_tui, _theme, _keybindings, done) => {
				dismiss = done;
				// Closed before the host mounted us: settle immediately instead of waiting for a key.
				if (closedEarly) queueMicrotask(() => done(undefined));
				return component;
			},
			{ overlay: true, overlayOptions: { anchor: "left-center", width: PANEL_WIDTH, maxHeight: "100%", margin: 0 } },
		);
		const settle = (): void => {
			dismiss = undefined;
			if (runtime.panel === session) runtime.panel = undefined;
		};
		void pending.then(settle, (error) => {
			settle();
			panelCtx(runtime)?.ui.notify(`agent panel closed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		});
	};

	/** The one `/swarm off` path: the command, and the panel's `q`, both land here. */
	const disableAuto = async (ctx: ExtensionContext, runtime: Runtime): Promise<void> => {
		saveSwarmAuto(runtime.paths.configFile, false);
		runtime.config.auto = false;
		await autoFor(runtime, ctx).disable();
		clearAutoTimer(runtime, ctx);
		closePanel(runtime);
		refreshPanel(ctx, runtime);
	};

	pi.on("session_start", async (_event, ctx) => {
		remember(ctx.cwd, ctx);
		const paths = swarmPaths(resolve(ctx.cwd));
		if (!existsSync(paths.configFile)) return; // a project without a swarm gets no panel and no writes
		let runtime: Runtime;
		try {
			runtime = runtimes.for(ctx.cwd);
		} catch (error) {
			ctx.ui.notify(`swarm config unreadable: ${String(error)}`, "warning");
			return;
		}
		if (runtime.config.auto) {
			autoFor(runtime, ctx).enable();
			autoTimer(runtime, ctx);
			openPanel(ctx, runtime);
		}
		refreshPanel(ctx, runtime);
	});

	pi.on("input", (event, ctx) => {
		// Returning { handled: true } here would swallow the prompt; never do it.
		remember(ctx.cwd, ctx);
		runtimes.peek(ctx.cwd)?.auto?.noteTask(event.text);
	});

	pi.on("before_agent_start", (event, ctx) => {
		remember(ctx.cwd, ctx);
		const auto = runtimes.peek(ctx.cwd)?.auto;
		if (!auto || !auto.claimsTurn(event.prompt)) return;
		return {
			message: { customType: "swarm", content: auto.notice(), display: true },
			systemPrompt: [...event.systemPrompt, auto.policy()],
		};
	});

	pi.on("session_shutdown", async () => {
		for (const controller of controllers) controller.dispose();
		await runtimes.stopAll();
	});

	const ensureDriver = (ctx: ExtensionContext, runtime: Runtime): SwarmDriver => {
		if (runtime.driver) return runtime.driver;
		const exec = async (command: string, args: string[], cwd: string) => {
			const result = await pi.exec(command, args, { cwd });
			return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
		};
		return runtimes.driver(runtime, {
			sdk: pi.pi,
			timers: timersFrom(ctx),
			exec,
			notify: (text, level) => ctx.ui.notify(text, level ?? "info"),
			onPanel: () => refreshPanel(ctx, runtime),
			onDrained: () => runtime.auto?.noteDrained(),
			deliverToMain: (text, urgent) => pi.sendMessage({ customType: "swarm", content: text, display: true }, { deliverAs: urgent ? "steer" : "followUp" }),
		});
	};

	pi.registerCommand("swarm", {
		description: "Decentralized agent swarm: /swarm [status|on|off|start [n]|stop|agents|tasks [status]|board [type]|task <title>|message <agent> <text>|approve <id> [notes]|reject <id> <notes>|config|roles]",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const runtime = runtimes.for(ctx.cwd);
			const [sub = "status", ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const join_ = (parts: string[]) => parts.join(" ");

			switch (sub) {
				case "status": {
					const snapshot = runtime.store.snapshot(runtime.config.offlineAfterSeconds, runtime.driver?.running ?? false);
					ctx.ui.notify(
						`multi-agent mode: ${runtime.config.auto ? "ON" : "OFF"} (phase ${runtime.auto?.phase ?? "off"})\n${renderSummary(snapshot)}`,
						"info",
					);
					if (runtime.driver) {
						ctx.ui.notify(
							renderAgents(
								runtime.store.listAgents(),
								Date.now(),
							),
							"info",
						);
					}
					refreshPanel(ctx, runtime);
					return;
				}
				case "on": {
					saveSwarmAuto(runtime.paths.configFile, true); // persists the mode; also creates `.swarm/` if missing
					runtime.config.auto = true;
					autoFor(runtime, ctx).enable();
					autoTimer(runtime, ctx);
					refreshPanel(ctx, runtime);
					openPanel(ctx, runtime);
					ctx.ui.notify(
						`multi-agent mode ON in ${runtime.root}\n每一条新任务都会被拆成 swarm 任务并行执行；/swarm off 关闭。`,
						"info",
					);
					return;
				}
				case "off": {
					await disableAuto(ctx, runtime);
					ctx.ui.notify("multi-agent mode OFF; running workers were stopped", "info");
					return;
				}
				case "start": {
					const requested = rest[0] !== undefined ? Number(rest[0]) : runtime.config.workers;
					const count = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : runtime.config.workers;
					const driver = ensureDriver(ctx, runtime);
					if (driver.running) {
						ctx.ui.notify("swarm is already running; /swarm stop first", "warning");
						return;
					}
					const planned = await driver.start(count);
					refreshPanel(ctx, runtime);
					ctx.ui.notify(
						`swarm starting with ${planned.length} worker(s): ${planned.join(", ")}\nthey register within ~30s — /swarm agents to watch them join`,
						"info",
					);
					return;
				}
				case "stop": {
					if (!runtime.driver?.running) {
						ctx.ui.notify("swarm is not running", "warning");
						return;
					}
					await runtime.driver.stop("swarm stopped by the operator");
					refreshPanel(ctx, runtime);
					ctx.ui.notify("swarm stopped; tasks were released back to the pool", "info");
					return;
				}
				case "agents": {
					ctx.ui.notify(renderAgents(runtime.store.listAgents(), Date.now()), "info");
					return;
				}
				case "tasks": {
					const requested = rest[0];
					const tasks = runtime.store.listTasks({
						status: requested !== undefined && isTaskStatus(requested) ? requested : undefined,
						limit: 40,
					});
					ctx.ui.notify(renderTasks(tasks, Date.now()), "info");
					return;
				}
				case "board": {
					const requested = rest[0];
					ctx.ui.notify(
						renderBoard(runtime.store.searchBoard({ type: requested !== undefined && isBoardType(requested) ? requested : undefined, limit: 20 })),
						"info",
					);
					return;
				}
				case "task": {
					if (rest.length === 0) {
						ctx.ui.notify("usage: /swarm task <title>", "warning");
						return;
					}
					const task = runtime.store.createTask({
						title: join_(rest),
						createdBy: MAIN_AGENT_ID,
						description: "Created by the operator as a bootstrap task.",
					});
					ctx.ui.notify(`created ${task.id}: ${task.title} (${task.status})`, "info");
					refreshPanel(ctx, runtime);
					return;
				}
				case "message": {
					const [to, ...body] = rest;
					if (to === undefined || body.length === 0) {
						ctx.ui.notify("usage: /swarm message <agent|all> <text>", "warning");
						return;
					}
					runtime.store.sendMessage({ to: to === "all" ? "*" : to, from: MAIN_AGENT_ID, body: join_(body), urgent: true });
					runtime.driver?.wake(to, `[message from the operator] ${join_(body)}`, true);
					ctx.ui.notify(`sent to ${to}`, "info");
					return;
				}
				case "approve":
				case "reject": {
					const [taskId, ...notes] = rest;
					if (taskId === undefined) {
						ctx.ui.notify(`usage: /swarm ${sub} <task-id> [notes]`, "warning");
						return;
					}
					const result = runtime.store.decide(taskId, MAIN_AGENT_ID, sub === "approve", join_(notes) || "operator decision");
					ctx.ui.notify(result.ok ? `${taskId} ${sub}d` : `failed: ${result.reason}`, result.ok ? "info" : "error");
					refreshPanel(ctx, runtime);
					return;
				}
				case "config": {
					ctx.ui.notify(`${runtime.paths.configFile}\n${JSON.stringify(runtime.config, null, 2)}`, "info");
					return;
				}
				case "roles": {
					ctx.ui.notify(expandWorkers(runtime.config).map((w) => `${w.name} ${w.role} [${w.capabilities.join(",")}]`).join("\n"), "info");
					return;
				}
				default:
					ctx.ui.notify(`unknown subcommand ${sub}; see /swarm`, "warning");
			}
		},
	});
}
