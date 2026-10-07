import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Component, KeyId } from "@oh-my-pi/pi-tui";
import { sortAgentInfo } from "./agentinfo";
import { MAIN_ID, moveSelection, navEntries, renderNavLines, type NavEntry } from "./agentnav";
import { AUTO_TICK_MS, AutoController } from "./auto";
import { colorEnabled, fitColored } from "./color";
import { loadSwarmConfig, expandWorkers, saveSwarmAuto } from "./config";
import { openDatabase, openInMemoryDatabase, swarmPaths, type SwarmPaths } from "./db";
import { SwarmDriver, type NavState, type SwarmDriverDeps, type TimerApi } from "./driver";
import { COORDINATOR_EDIT_NOTICE, decideCoordinatorEdit, mutatesFiles } from "./guard";
import {
	drainSummaryLines,
	drainSummaryTitle,
	fitSummaryLines,
	progressBar,
	progressLine,
	progressStatusLine,
	renderAgents,
	renderBoard,
	renderSummary,
	renderTasks,
	type DrainSummary,
} from "./render";
import { SwarmStore } from "./store";
import { buildSwarmTools, isBoardType, isTaskStatus, type SwarmIdentity } from "./tools";
import { DEFAULT_CONFIG, type SwarmConfig } from "./types";
import { parseWebArgs, WebDashboard } from "./web";

/** The main session's id in BOTH namespaces: the swarm's events and `agentnav`'s main row. */
const MAIN_AGENT_ID = MAIN_ID;
const PANEL_STATUS_KEY = "swarm";
const PANEL_WIDGET_KEY = "swarm-panel";
/** The progress bar is a reading aid, not a ruler: keep it short enough to sit beside the text. */
const PROGRESS_BAR_WIDTH = 20;
/** `/swarm nav`'s overlay: wide enough for a full agent row, narrow enough to leave the session visible. */
const AGENT_NAV_WIDTH = 40;
/** The picker's footer. ASCII only, and clipped to whatever inner width the overlay actually got. */
const AGENT_NAV_HINT = "up/down move | Enter target | Esc close";

/**
 * The host keys the picker answers, mapped to this feature's actions. `enter` and `escape` are here
 * only because the overlay - not `registerShortcut` - owns the keyboard: the host drops those two
 * from any extension shortcut (`pi-coding-agent/src/extensibility/extensions/runner.ts:1218-1234`).
 */
const AGENT_NAV_KEYS: ReadonlyArray<readonly [KeyId, "up" | "down" | "enter" | "close"]> = [
	["up", "up"],
	["k", "up"],
	["down", "down"],
	["j", "down"],
	["enter", "enter"],
	["escape", "close"],
	["q", "close"],
];

/** The host's `matchesKey`, or whatever a host-free caller supplies. */
export type KeyMatcher = (data: string, keyId: KeyId) => boolean;

/**
 * Resolve the host's key matcher on demand.
 *
 * `@oh-my-pi/pi-tui` is NOT a declared dependency of this package: it resolves only because the
 * `omp` binary embeds it (and because `pi-coding-agent` hoists it in this repo). A top-level
 * `import { matchesKey }` therefore makes the WHOLE extension unloadable under any loader that
 * lacks the package - `bun --no-install` on a node_modules-free tree dies with `Cannot find
 * package '@oh-my-pi/pi-tui'` - which would cost the tools, `/swarm`, the widget and this picker,
 * all for one key function. So the import is dynamic and its failure is a VALUE (`undefined`),
 * never a throw.
 */
export async function loadKeyMatcher(
	load: () => Promise<{ matchesKey: KeyMatcher }> = () => import("@oh-my-pi/pi-tui"),
): Promise<KeyMatcher | undefined> {
	try {
		return (await load()).matchesKey;
	} catch {
		return undefined;
	}
}

/**
 * Terminal bytes -> the picker's action, or undefined for a key the picker does not own. Exported
 * because it IS the documented key table (README "Agent list navigation"); the matcher is a
 * parameter so the mapping can be checked without the host module.
 */
export function agentNavKey(data: string, matcher: KeyMatcher): "up" | "down" | "enter" | "close" | undefined {
	for (const [keyId, action] of AGENT_NAV_KEYS) if (matcher(data, keyId)) return action;
	return undefined;
}

/**
 * The host's own cap on a `string[]` widget: `MAX_WIDGET_LINES = 10` in
 * `pi-coding-agent/src/modes/controllers/extension-ui-controller.ts:45`, applied at `:362` as
 * `content.slice(0, MAX_WIDGET_LINES)` plus a "... (widget truncated)" marker. Every declared line
 * after the tenth is discarded - the mode header, the run line, the progress block (or the drained
 * summary), the worker rows, the counters and the BOARD share this one budget, so a block that
 * ignores it silently eats the footer.
 */
const WIDGET_LINE_BUDGET = 10;

/** What the completion alert leaves behind, so the operator can still read it after the fact. */
interface DrainMarker {
	/** The full summary, kept in the widget above the editor. */
	lines: string[];
	/** The same headline on the status line. */
	status: string;
}

/** The status line's parts are optional by construction; drop the absent and the empty ones. */
function isText(value: string | undefined): value is string {
	return value !== undefined && value !== "";
}

/** The completion banner's payload - the host's own `TerminalNotification` shape, narrowed. */
export interface HostNotification {
	title: string;
	body: string;
	type: "completion";
	urgency: "normal";
}

/** The host's terminal singleton, as much of it as this extension uses. */
export interface HostNotifier {
	sendNotification(notification: HostNotification): void;
}

/**
 * The one-shot batch-completion alert, on the host's own "Complete" channel.
 *
 * Same optional-host-module reasoning as {@link loadKeyMatcher}: the import is dynamic, so a loader
 * without `@oh-my-pi/pi-tui` costs the loud banner and nothing else. `fallback` is called whatever
 * happens - it is the channel that must still land - and the return value says which one fired.
 */
export async function announceCompletion(
	notification: HostNotification,
	fallback: () => void,
	load: () => Promise<{ TERMINAL: HostNotifier }> = () => import("@oh-my-pi/pi-tui"),
): Promise<boolean> {
	let sent = false;
	try {
		const { TERMINAL } = await load();
		TERMINAL.sendNotification(notification);
		sent = true;
	} catch {
		// The module is absent (a loader that does not embed it) or the terminal cannot notify at
		// all; both are non-fatal here because the in-TUI alert below still goes out.
	}
	fallback();
	return sent;
}

interface Runtime {
	root: string;
	paths: SwarmPaths;
	store: SwarmStore;
	config: SwarmConfig;
	driver?: SwarmDriver;
	auto?: AutoController;
	autoTimer?: Timer;
	/** Set once a batch drained; cleared by the next actionable task or the next start. */
	drainMarker?: DrainMarker;
	/** Agent-list selection (cursor row + committed target); view state, so it never reaches the store. */
	nav: NavState;
	/** Set while `/swarm nav`'s overlay owns the keyboard, so a second one cannot mount on top. */
	navDismiss?: () => void;
	/** `/swarm web`'s child process. Owned here so shutdown can always kill it. */
	web?: WebDashboard;
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
		const runtime: Runtime = {
			root: absolute,
			paths,
			store: new SwarmStore(openDatabase(paths), paths),
			config,
			nav: { index: 0, targetId: MAIN_AGENT_ID },
		};
		this.#runtimes.set(absolute, runtime);
		return runtime;
	}

	/** Peek without creating anything: `session_start` must not write `.swarm/` on its own. */
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
			// The dashboard is a child process holding a port: an omp restart must not orphan it.
			runtime.web?.stop();
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
	/** Close handles for every open `/swarm nav` overlay, so shutdown cannot leave one mounted. */
	const navClosers = new Set<() => void>();
	/** Latched by the coordinator-edit guard: one reminder per turn, not one per tool call. */
	let coordinatorEditNotified = false;
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

	/**
	 * Whether the widget may carry SGR: an interactive TTY with `NO_COLOR` unset (or empty) and
	 * `FORCE_COLOR` not `0`. The decision lives here and nowhere else; every pure formatter receives
	 * it as a flag and none of them reads `process.env` or the TTY itself.
	 */
	const panelColor = (): boolean => colorEnabled(process.env, Boolean(process.stdout.isTTY));

	const refreshPanel = (ctx: ExtensionContext, runtime: Runtime | undefined): void => {
		if (!runtime) {
			ctx.ui.setStatus(PANEL_STATUS_KEY, undefined);
			ctx.ui.setWidget(PANEL_WIDGET_KEY, []);
			return;
		}
		const snapshot = runtime.store.snapshot(runtime.config.offlineAfterSeconds, runtime.driver?.running ?? false);
		const counts = snapshot.counts;
		// The ONE place color is decided. Every line below takes it as a flag - a pure formatter
		// never reads process.env or the TTY itself, so `NO_COLOR=1 omp` and `omp | cat` both paint
		// nothing and the bytes stay exactly what this extension emitted before colors existed.
		const color = panelColor();
		const legacy = runtime.driver?.running
			? `swarm ${snapshot.agents.length}a r${counts.ready} c${counts.claimed} v${counts.review} d${counts.done}`
			: undefined;
		// Actionable work again means the last batch's summary is history: drop the marker so the
		// status line goes back to reporting the live pool.
		if (runtime.drainMarker !== undefined && counts.ready + counts.claimed + counts.review > 0) runtime.drainMarker = undefined;
		const live = runtime.drainMarker === undefined ? progressStatus(runtime, color) : undefined;
		const status = runtime.drainMarker?.status ?? [runtime.auto?.statusText() ?? legacy, live].filter(isText).join(" · ");
		ctx.ui.setStatus(PANEL_STATUS_KEY, status === "" ? undefined : status);
		ctx.ui.setWidget(PANEL_WIDGET_KEY, panelWidgetLines(runtime, color), { placement: "aboveEditor" });
	};

	/** `SWARM 7/9 done` while the pool works; nothing once no work is actionable. */
	const progressStatus = (runtime: Runtime, color: boolean): string | undefined => {
		if (!(runtime.driver?.running ?? false)) return undefined;
		return progressStatusLine(runtime.store.counts(), { color });
	};

	/**
	 * The bar and the counts line while the pool works; the drained summary once it is over. Both
	 * answer to `room` - the widget lines left after the header, run line, rows and counters - so
	 * the block never pushes the footer past the host's cap. The bar itself stays plain: it is a
	 * reading aid, and its shape already carries the progress the color would only repeat.
	 */
	const progressWidgetLines = (runtime: Runtime, width: number, room: number, color: boolean): string[] => {
		if (runtime.drainMarker !== undefined) return fitSummaryLines(runtime.drainMarker.lines, room);
		if (!(runtime.driver?.running ?? false)) return [];
		const counts = runtime.store.counts();
		const line = progressLine(counts, { color });
		if (room >= 2) return [progressBar(counts, Math.min(PROGRESS_BAR_WIDTH, width)), line];
		return room >= 1 ? [line] : [];
	};

	/**
	 * What the string-array widget carries: the mode header, the driver's run line, the live
	 * progress (or the drained summary in its place), one rich row per worker and the counters. The
	 * progress block gets whatever the rest of the widget leaves inside `WIDGET_LINE_BUDGET`, so the
	 * footer survives the drain instead of being truncated away.
	 *
	 * Width: the host paints each line as `new Text(line, 1, 0)`, which wraps at
	 * `width - 2 * paddingX` (`pi-tui/src/components/text.ts`), so rows have to fit in the
	 * terminal width minus two columns or a row's tail wraps under itself. The terminal width
	 * follows the host's own rule (`pi-tui/src/terminal.ts`): the PTY reports nothing until its
	 * first resize, so `COLUMNS` and then 80 stand in.
	 */
	const panelWidgetLines = (runtime: Runtime, color: boolean): string[] => {
		const columns = process.stdout.columns || Number(Bun.env.COLUMNS) || 80;
		const width = Math.max(20, columns - 2);
		const headers = runtime.auto?.header() ?? [];
		const body = runtime.driver?.panelLines(width, { color, nav: runtime.nav }) ?? [];
		const room = WIDGET_LINE_BUDGET - headers.length - body.length;
		return [...headers, ...body.slice(0, 1), ...progressWidgetLines(runtime, width, room, color), ...body.slice(1)];
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
			poolIdle: () => runtime.driver?.idleWorkerCount() ?? 0,
			startSwarm: async (roles, count) => {
				const driver = ensureDriver(latest(), runtime);
				// A pool that is already up takes the delta: growth must add workers, never restart a
				// running swarm and release the work it holds.
				return driver.running ? driver.addWorkers(count, roles) : driver.start(count, roles);
			},
			shrinkSwarm: async (count) => (runtime.driver === undefined ? [] : runtime.driver.stopIdleWorkers(count)),
			stopSwarm: async (reason) => {
				await runtime.driver?.stop(reason);
			},
			isMainBusy: () => latest().isIdle() === false,
			nudgeToMain: (text) => pi.sendMessage({ customType: "swarm", content: text, display: false }, { deliverAs: "steer" }),
			notifyMain: (text) => pi.sendMessage({ customType: "swarm", content: text, display: true }, { deliverAs: "followUp" }),
			notify: (text, level) => latest().ui.notify(text, level ?? "info"),
			onChange: () => refreshPanel(latest(), runtime),
			now: () => Date.now(),
			onEvent: (type, data) => runtime.store.logEvent(type, MAIN_AGENT_ID, data ?? {}),
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

	/** The one multi-agent-mode off path: `/swarm off`. */
	const disableAuto = async (ctx: ExtensionContext, runtime: Runtime): Promise<void> => {
		saveSwarmAuto(runtime.paths.configFile, false);
		runtime.config.auto = false;
		await autoFor(runtime, ctx).disable();
		clearAutoTimer(runtime, ctx);
		refreshPanel(ctx, runtime);
	};

	/** The navigable roster: main first, then the workers in exactly the order the widget prints them. */
	const navEntriesFor = (runtime: Runtime, now: number): NavEntry[] => {
		const rows = runtime.driver === undefined ? [] : sortAgentInfo(runtime.driver.agentInfoRows(now));
		return navEntries(rows, { id: MAIN_AGENT_ID });
	};

	/**
	 * `Enter` in the picker: the row becomes the current target, which is what the widget's `*` marks
	 * and what the status line keeps in step.
	 *
	 * It does NOT switch the session pane, and the wording says so instead of implying it: this picker
	 * only moves the swarm's own marker. Switching the pane is the HOST's surface - `Alt+A` (Agent Hub)
	 * then `Enter` on a worker - and that works because workers are created as host subagents in
	 * `AgentRegistry.global()` (`extension/driver.ts`, task-83): the Hub lists them and its `Enter` calls
	 * `SessionFocusController.focusAgent(id)`, which attaches the worker's live session to the main pane.
	 */
	const commitNavTarget = (ctx: ExtensionContext, runtime: Runtime, entry: NavEntry): void => {
		runtime.nav.targetId = entry.id;
		refreshPanel(ctx, runtime);
		ctx.ui.notify(
			entry.isMain
				? "current target: the main session (this terminal)"
				: `current target: ${entry.id} - /swarm message ${entry.id} <text> reaches it. To READ and steer it in the main pane use Alt+A, then Enter on its row (Esc or double-left-arrow returns); see README "Agent list navigation".`,
			"info",
		);
	};

	/**
	 * `/swarm nav`: the agent list as a focusable overlay, where the arrow keys and Enter are ours.
	 *
	 * The overlay is the whole point, not a style choice. `registerShortcut` silently drops
	 * `enter`/`escape` (`pi-coding-agent/src/extensibility/extensions/runner.ts:1218-1234`), and the
	 * above-editor widget is never focused (`pi-tui/src/tui.ts:2781-2787`), so a component that owns
	 * focus (`ctx.ui.custom`, `extensions/types.ts:313-320`) is the only place that can see both.
	 * The selection itself lives on the runtime, so the widget's marker follows the picker live and
	 * survives a repaint, and a non-TUI host - which can run no component at all - keeps the plain
	 * roster text it has always printed.
	 */
	const openAgentNav = async (ctx: ExtensionContext, runtime: Runtime): Promise<void> => {
		if (runtime.navDismiss !== undefined) return;
		if (ctx.mode !== "tui" || !ctx.hasUI) {
			ctx.ui.notify(`${renderAgents(runtime.store.listAgents(), Date.now())}\n/swarm nav needs the interactive TUI`, "info");
			return;
		}
		let dismiss: ((result: string | undefined) => void) | undefined;
		let closedEarly = false;
		const closeNav = (): void => {
			closedEarly = true;
			dismiss?.(undefined);
		};
		const settle = (): void => {
			dismiss = undefined;
			navClosers.delete(closeNav);
			if (runtime.navDismiss === closeNav) runtime.navDismiss = undefined;
		};
		// Take the single-mount slot BEFORE the await: a second `/swarm nav` while the host module is
		// still resolving must not mount a second picker.
		runtime.navDismiss = closeNav;
		navClosers.add(closeNav);
		const matcher = await loadKeyMatcher();
		if (matcher === undefined) {
			// No key matcher, no picker: the roster still prints, and every other `/swarm` surface is
			// untouched - that is the whole point of loading the host module lazily.
			settle();
			ctx.ui.notify(
				`${renderAgents(runtime.store.listAgents(), Date.now())}\n/swarm nav needs the host key matcher (@oh-my-pi/pi-tui); this loader does not provide it`,
				"warning",
			);
			return;
		}
		const component: Component = {
			render(inner: number): readonly string[] {
				const now = Date.now();
				const budget = Math.max(16, Math.min(AGENT_NAV_WIDTH, inner));
				return [
					...renderNavLines(navEntriesFor(runtime, now), {
						selectedIndex: runtime.nav.index,
						currentTargetId: runtime.nav.targetId,
						width: budget,
						now,
						color: panelColor(),
					}),
					fitColored(AGENT_NAV_HINT, budget),
				];
			},
			handleInput(data: string): void {
				const action = agentNavKey(data, matcher);
				if (action === undefined) return;
				if (action === "close") {
					// Escape commits nothing: the cursor and the target stay exactly as they were.
					closeNav();
					return;
				}
				const entries = navEntriesFor(runtime, Date.now());
				if (action === "enter") {
					const entry = entries[moveSelection(runtime.nav.index, 0, entries.length)];
					if (entry !== undefined) commitNavTarget(ctx, runtime, entry);
					closeNav();
					return;
				}
				runtime.nav.index = moveSelection(runtime.nav.index, action === "up" ? -1 : 1, entries.length);
				refreshPanel(ctx, runtime); // the widget paints the same selection: keep the two in step
			},
		};
		void ctx.ui
			.custom<string | undefined>(
				(_tui, _theme, _keybindings, done) => {
					dismiss = done;
					// Closed before the host mounted us: settle now instead of waiting for a key.
					if (closedEarly) queueMicrotask(() => done(undefined));
					return component;
				},
				{ overlay: true, overlayOptions: { anchor: "left-center", width: AGENT_NAV_WIDTH, maxHeight: "100%", margin: 0 } },
			)
			.then(settle, (error) => {
				settle();
				ctx.ui.notify(`agent list closed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			});
	};

	pi.on("session_start", async (_event, ctx) => {
		remember(ctx.cwd, ctx);
		const paths = swarmPaths(resolve(ctx.cwd));
		if (!existsSync(paths.configFile)) return; // a project without a swarm gets no status line and no writes
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

	/**
	 * The behavioural half of "the coordinator only sizes the pool" (see `./guard`). Prose cannot stop a
	 * model from executing a specification itself — the live counterexample did 68 tool calls with no goal
	 * — so this watches what the session DOES: multi-agent mode on, no goal open, no pool running, and the
	 * MAIN session starts a file-mutating tool. It is a reminder, never a gate: it cannot refuse or delay
	 * the call, and an operator-requested edit is noise the operator can ignore.
	 */
	pi.on("tool_execution_start", (event, ctx) => {
		const runtime = runtimes.peek(ctx.cwd);
		const auto = runtime?.auto;
		if (runtime === undefined || auto === undefined || !auto.enabled) return;
		// Workers are separate sessions in this process and register their session id (driver.ts:475 ->
		// agents.session_id); the main session is never in that table, so a match identifies a worker and
		// keeps the notice off its tool calls.
		const sessionId = ctx.sessionManager.getSessionId();
		const decision = decideCoordinatorEdit({
			modeOn: true,
			sessionIsMain: !runtime.store.listAgents().some((agent) => agent.sessionId === sessionId),
			goalOpen: runtime.store.liveGoals().length > 0,
			poolRunning: runtime.driver?.running ?? false,
			mutatesFiles: mutatesFiles(event.toolName, event.args),
			notifiedThisTurn: coordinatorEditNotified,
		});
		if (decision === "notify") {
			coordinatorEditNotified = true;
			ctx.ui.notify(COORDINATOR_EDIT_NOTICE, "warning");
		}
	});

	pi.on("turn_start", () => {
		coordinatorEditNotified = false;
	});

	pi.on("session_shutdown", async () => {
		for (const close of navClosers) close();
		navClosers.clear();
		for (const controller of controllers) controller.dispose();
		await runtimes.stopAll();
	});

	/**
	 * The one-shot batch-completion alert. `onDrained` fires once per batch (the driver latches it),
	 * and this is the only consumer, so nothing here may repeat on a repaint.
	 *
	 * Prominence (per the task-38 probe): `ui.notify` is a 2.4 s toast or a single replaced status
	 * line, and its loudest legal level would be "error" for a success, so the alert goes out on the
	 * host's own completion channel (`TERMINAL.sendNotification`, the exact call the host makes for
	 * its "Complete" banner) with the headline, while the summary itself persists in the widget and
	 * on the status line. That channel is resolved lazily by {@link announceCompletion}, so a loader
	 * without the host module still gets the in-TUI notice. Multi-agent mode off has no controller to
	 * announce anything, so the full summary also lands in the transcript; with the mode on the auto
	 * controller posts its own notice, and one alert in the chat is enough.
	 */
	const alertDrained = (ctx: ExtensionContext, runtime: Runtime, summary: DrainSummary): void => {
		const width = Math.max(20, (process.stdout.columns || Number(Bun.env.COLUMNS) || 80) - 2);
		const title = drainSummaryTitle(summary);
		runtime.drainMarker = { lines: drainSummaryLines(summary, { width }), status: title };
		void announceCompletion({ title: "SWARM DONE", body: title, type: "completion", urgency: "normal" }, () => {
			// The in-TUI channel, whatever the loud one did: a loader without the host module (or a
			// terminal that cannot notify) must still leave the operator a notice.
			if (ctx.hasUI) ctx.ui.notify(title, "info");
		});
		if (runtime.auto === undefined) {
			pi.sendMessage({ customType: "swarm", content: runtime.drainMarker.lines.join("\n"), display: true }, { deliverAs: "followUp" });
		}
		refreshPanel(ctx, runtime);
	};

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
			onDrained: (summary) => {
				// The controller still has to hear about the drain: its own drain branch is what stops
				// the pool and tells the coordinator to report to the user.
				runtime.auto?.noteDrained();
				alertDrained(ctx, runtime, summary);
			},
			deliverToMain: (text, urgent) => pi.sendMessage({ customType: "swarm", content: text, display: true }, { deliverAs: urgent ? "steer" : "followUp" }),
		});
	};

	pi.registerCommand("swarm", {
		description: "Decentralized agent swarm: /swarm [status|on|off|start [n]|stop|agents|nav|tasks [status]|board [type]|task <title>|message <agent> <text>|approve <id> [notes]|reject <id> <notes>|config|roles|web [start|stop|status] [--port N]]",
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
					// A new run is a new batch: the previous summary is history.
					runtime.drainMarker = undefined;
					const planned = await driver.start(count);
					refreshPanel(ctx, runtime);
					ctx.ui.notify(
						`swarm starting with ${planned.length} worker(s): ${planned.join(", ")}\nthey register within ~30s — /swarm agents to watch them join`,
						"info",
					);
					return;
				}
				case "stop": {
					const webWasRunning = runtime.web?.stop() ?? false;
					if (!runtime.driver?.running) {
						ctx.ui.notify(webWasRunning ? "swarm is not running; the dashboard was stopped" : "swarm is not running", "warning");
						return;
					}
					await runtime.driver.stop("swarm stopped by the operator");
					refreshPanel(ctx, runtime);
					ctx.ui.notify(`swarm stopped; tasks were released back to the pool${webWasRunning ? ", and the dashboard was stopped" : ""}`, "info");
					return;
				}
				case "agents": {
					ctx.ui.notify(renderAgents(runtime.store.listAgents(), Date.now()), "info");
					return;
				}
				case "nav": {
					await openAgentNav(ctx, runtime);
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
				case "web": {
					const parsed = parseWebArgs(rest);
					if (!parsed.ok) {
						ctx.ui.notify(parsed.error, "warning");
						return;
					}
					// The server ships beside the extension and takes the root as its cwd, so it reads the
					// same `.swarm/swarm.db` the swarm does — read-only, in its own process.
					const dashboard = (runtime.web ??= new WebDashboard(runtime.root, join(import.meta.dir, "..", "web", "server.ts")));
					if (parsed.options.action === "start") {
						const started = await dashboard.start(parsed.options.port);
						ctx.ui.notify(
							started.ok
								? `dashboard: ${started.state.url} (pid ${started.state.pid}) — read-only, ${started.state.port} is bound to 127.0.0.1 only\n/swarm web stop when you are done`
								: `could not start the dashboard: ${started.error}`,
							started.ok ? "info" : "error",
						);
						return;
					}
					if (parsed.options.action === "stop") {
						ctx.ui.notify(dashboard.stop() ? "dashboard stopped; its port is free again" : "dashboard is not running", "info");
						return;
					}
					ctx.ui.notify(dashboard.statusLine(), "info");
					return;
				}
				default:
					ctx.ui.notify(`unknown subcommand ${sub}; see /swarm`, "warning");
			}
		},
	});
}
