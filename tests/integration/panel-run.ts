/**
 * task-17 runner — frame-level proof that an operator can drive the MULTI-AGENT MODE agent panel.
 *
 * The proof is split by surface, because the panel deliberately lives on two:
 *
 *  `rpc` — a real `omp --mode rpc-ui` session with the INSTALLED plugin (no `-e`, so the symlinked
 *   plugin in `~/.omp/plugins`). The overlay component cannot mount there (`RpcExtensionUIContext.
 *   custom()` returns undefined, rpc-mode.ts:1413-1416; `onTerminalInput()` is a no-op, :1348-1351;
 *   the RPC command union has no keystroke injection), and `openPanel` early-returns on
 *   `ctx.mode !== "tui"` (extension/index.ts:375). So this session proves the FALLBACK surface only:
 *   the panel paints as a `setWidget("swarm-panel")` string array and stops when the mode is off.
 *   `setWidget` frames are filtered by widgetKey — a bare `method==="setWidget"` filter also catches
 *   the `autoresearch` frames from another installed plugin.
 *
 *  `tui` — the operator's surface: the REAL `createAgentListPanel` mounted in a real TUI engine over
 *   a headless terminal, driven with raw key bytes through the real input pipeline
 *   (`TUI.injectDebugInput`), asserted from the composited paint (`TUI.getDebugPaint`). This proves
 *   the key walk: cursor movement, Enter's selection + status line, reload, status, quit.
 *
 * Usage: bun run tests/integration/panel-run.ts [--gap 8] [--seconds 40]
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TUI, type Component, type OverlayHandle, type OverlayOptions, type Terminal } from "@oh-my-pi/pi-tui";
import { createAgentListPanel, type AgentPanelHooks } from "../../extension/index";
import { renderPanelLines, statusLineText, type PanelRow } from "../../extension/panel";
import { renderAgents } from "../../extension/render";
import type { SwarmAgent } from "../../extension/types";
import { prepareProject } from "./harness";
import { RpcClient } from "./rpc-client";

const PANEL_WIDGET_KEY = "swarm-panel";
const PANEL_STATUS_KEY = "swarm";
const OUT = join(import.meta.dir, "last-run-panel.json");
const ROOT = resolve(import.meta.dir, "..", "..", "scratch", "panel-api", "run");

/** Raw terminal bytes -> reducer key name: the walk the task asks for. */
const WALK: ReadonlyArray<readonly [string, string]> = [
	["\x1b[B", "down"],
	["\x1b[B", "down"],
	["\r", "enter"],
	["r", "r"],
	["s", "s"],
	["q", "q"],
];

interface Check {
	name: string;
	ok: boolean;
	surface: "rpc" | "tui";
	detail: string;
}
interface UiCall {
	method: "setStatus" | "setWidget" | "notify";
	key: string;
	value: unknown;
}
interface TuiStep {
	key: string;
	markedRow: string | undefined;
	selectedRow: string | undefined;
	headerLine: string | undefined;
	statusValue: unknown;
	statusCalls: number;
	widgetCalls: number;
	notifyCalls: number;
	/** The last `notify` the hooks produced — the operator-visible text for `r`/`s`. */
	lastNotify: unknown;
	/** The NON-BLANK painted rows (columns 0-30), not a fixed window: the overlay is anchored
	 * `left-center`, so rows 0-3 of a 24-row terminal are always empty (task-18, REVIEW #71.1). */
	frame: string[];
}
interface PanelFrameView {
	id: string | undefined;
	method: string | undefined;
	widgetKey: string | undefined;
	widgetLines: string[] | undefined;
	statusKey: string | undefined;
	statusText: string | undefined;
	message: string | undefined;
}
interface RpcPhase {
	command: string;
	cwd: string;
	installedPlugin: boolean;
	frameCount: number;
	panelFrames: PanelFrameView[];
	onPromptId: string;
	offPromptId: string;
	stderrTail: string;
}
interface TuiPhase {
	columns: number;
	rows: number;
	overlayOptions: OverlayOptions;
	focusedOnMount: boolean;
	roster: string[];
	steps: TuiStep[];
	uiCalls: UiCall[];
}

function arg(name: string, fallback: string): string {
	const index = process.argv.indexOf(`--${name}`);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	return value ?? fallback;
}

/** Strip SGR so painted rows compare as text. */
function plain(lines: readonly string[]): string[] {
	return lines.map(line => line.replace(/\u001b\[[0-9;]*m/g, "").trimEnd());
}

/** Phase `rpc`: the fallback surface, on the installed plugin. */
async function runRpc(gapSeconds: number): Promise<RpcPhase> {
	prepareProject({ root: ROOT, workers: 2, review: false, worktrees: false });
	const command = ["omp", "--mode", "rpc-ui", "--no-session", "--no-title"];
	const client = new RpcClient(command, ROOT);
	const panelFrames: PanelFrameView[] = [];
	try {
		await client.waitForReady(60_000);
		const onPromptId = client.send({ type: "prompt", message: "/swarm on" });
		await Bun.sleep(gapSeconds * 1000);
		const offPromptId = client.send({ type: "prompt", message: "/swarm off" });
		await Bun.sleep(gapSeconds * 1000);
		for (const frame of client.frames) {
			const isPanelWidget = frame.method === "setWidget" && frame.widgetKey === PANEL_WIDGET_KEY;
			const isPanelStatus = frame.method === "setStatus" && frame.statusKey === PANEL_STATUS_KEY;
			if (!isPanelWidget && !isPanelStatus && frame.id !== onPromptId && frame.id !== offPromptId) continue;
			panelFrames.push({
				id: typeof frame.id === "string" ? frame.id : undefined,
				method: typeof frame.method === "string" ? frame.method : undefined,
				widgetKey: typeof frame.widgetKey === "string" ? frame.widgetKey : undefined,
				widgetLines: Array.isArray(frame.widgetLines)
					? frame.widgetLines.filter((line): line is string => typeof line === "string")
					: undefined,
				statusKey: typeof frame.statusKey === "string" ? frame.statusKey : undefined,
				statusText: typeof frame.statusText === "string" ? frame.statusText : undefined,
				message: typeof frame.message === "string" ? frame.message : undefined,
			});
		}
		return {
			command: command.join(" "),
			cwd: ROOT,
			installedPlugin: true,
			frameCount: client.frames.length,
			panelFrames,
			onPromptId,
			offPromptId,
			stderrTail: client.stderr.slice(-1200),
		};
	} finally {
		await client.close(5000);
	}
}

/** Phase `tui`: the operator's surface — the real component, real input pipeline, real paint. */
async function runTui(): Promise<TuiPhase> {
	const columns = 80;
	const rows = 24;
	const noop = (): void => {};
	// `as unknown as Terminal`: the TUI needs a structural Terminal; a real one opens a PTY.
	const terminal = {
		start: noop,
		stop: noop,
		drainInput: async () => {},
		write: noop,
		columns,
		rows,
		kittyProtocolActive: false,
		kittyEnableSequence: null,
		moveBy: noop,
		hideCursor: noop,
		showCursor: noop,
		clearLine: noop,
		clearFromCursor: noop,
		clearScreen: noop,
		setTitle: noop,
		setProgress: noop,
		onAppearanceChange: noop,
		appearance: "dark" as const,
	} as unknown as Terminal;

	// The mode's roster, shaped exactly as extension/index.ts:panelRows produces it.
	const roster: PanelRow[] = [
		"SwiftTiger",
		"CalmTiger",
		"BrightTiger",
		"VividTiger",
		"QuietTiger",
		"BoldTiger",
		"KeenTiger",
		"SwiftOtter",
	].map((label, i) => ({ index: i + 1, id: label, label, status: i < 3 ? "idle" : "working" }));
	const uiCalls: UiCall[] = [];
	let selected: PanelRow | undefined;
	// Mirrors refreshPanel (index.ts:227-243): a selection owns the status line, and the widget
	// carries renderPanelLines on any host that cannot mount the component (i.e. this harness).
	const refresh = (): void => {
		uiCalls.push({ method: "setStatus", key: PANEL_STATUS_KEY, value: selected ? statusLineText(selected.label) : undefined });
		uiCalls.push({
			method: "setWidget",
			key: PANEL_WIDGET_KEY,
			value: renderPanelLines({ title: "MULTI-AGENT MODE", rows: roster, cursor: 0, selected: selected?.id, now: Date.now() }, { width: 30 }),
		});
	};
	// The agent records the real status handler reads (extension/index.ts:402-404). `PanelRow`
	// carries no role/heartbeat, so the harness fills those and says so: ids and statuses are the
	// roster's, which is what `renderAgents` prints.
	const joinedAt = Date.now();
	const agents: SwarmAgent[] = roster.map((row, i) => ({
		id: row.id,
		role: i === 2 ? "reviewer" : "general",
		status: row.status,
		capabilities: ["general"],
		joinedAt,
		heartbeatAt: joinedAt,
	}));
	// The host's custom() cleanup for a finished component (extension-ui-controller.ts:1130-1145):
	// done() disposes the component, hides the overlay, restores/refocuses the editor, then repaints.
	let component: Component | undefined;
	let overlay: OverlayHandle | undefined;
	const hooks: AgentPanelHooks = {
		rows: () => roster,
		onSelect: row => {
			selected = row;
			refresh();
		},
		onReload: () => {
			refresh();
			uiCalls.push({ method: "notify", key: "", value: `agent list reloaded: ${roster.length} agent(s)` });
		},
		// The real handler is `notify(renderAgents(store.listAgents(), Date.now()))`, so this pushes
		// that renderer's own output rather than a stub (task-18, REVIEW #71.3).
		onStatus: () => uiCalls.push({ method: "notify", key: "", value: renderAgents(agents, Date.now()) }),
		onQuit: () => {
			selected = undefined;
			refresh(); // disableAuto -> refreshPanel: status cleared, widget back to the auto header
			component?.dispose?.();
			overlay?.hide();
			tui.requestRender(true);
		},
	};
	const mounted: Component = createAgentListPanel(hooks);
	component = mounted;
	const overlayOptions: OverlayOptions = { anchor: "left-center", width: 30, maxHeight: "100%", margin: 0 };
	const tui = new TUI(terminal);
	overlay = tui.showOverlay(mounted, overlayOptions);
	const focusedOnMount = tui.getFocused() === mounted;

	const snapshot = async (key: string): Promise<TuiStep> => {
		tui.requestRender(true);
		await Bun.sleep(60);
		const paint = plain(tui.getDebugPaint()?.lines ?? []).map(line => line.slice(0, 30));
		const statuses = uiCalls.filter(call => call.method === "setStatus");
		const notifies = uiCalls.filter(call => call.method === "notify");
		return {
			key,
			markedRow: paint.find(line => line.startsWith(">")),
			selectedRow: paint.find(line => line.includes("●")),
			headerLine: paint.find(line => line.includes("MULTI-AGENT MODE")),
			statusValue: statuses[statuses.length - 1]?.value,
			statusCalls: statuses.length,
			widgetCalls: uiCalls.filter(call => call.method === "setWidget").length,
			notifyCalls: notifies.length,
			lastNotify: notifies[notifies.length - 1]?.value,
			// The overlay's own rows only: `anchor: "left-center"` leaves the top of the terminal
			// blank, so a fixed slice of rows 0-3 would record four empty strings forever.
			frame: paint.filter(line => line.trim() !== ""),
		};
	};

	refresh(); // the /swarm on repaint
	const steps: TuiStep[] = [await snapshot("<mount>")];
	for (const [bytes, name] of WALK) {
		tui.injectDebugInput(bytes);
		steps.push(await snapshot(name));
	}
	return { columns, rows, overlayOptions, focusedOnMount, roster: roster.map(row => row.label), steps, uiCalls };
}

const GAP = Number(arg("gap", "8"));
const rpc = await runRpc(GAP);
const tui = await runTui();

// ---- checks: every one derived from a captured frame, labelled with the surface that proves it ----
const panelWidgets = rpc.panelFrames.filter(frame => frame.method === "setWidget");
const widgetsWithPanelText = panelWidgets.filter(frame => (frame.widgetLines ?? []).some(line => line.includes("MULTI-AGENT MODE")));
const clearedWidgets = panelWidgets.filter(frame => (frame.widgetLines ?? []).length === 0);
const statusFrames = rpc.panelFrames.filter(frame => frame.method === "setStatus");

/** Steps are appended in walk order: mount, down, down, enter, r, s, q. */
function stepAt(steps: TuiStep[], index: number, label: string): TuiStep {
	const step = steps[index];
	if (step === undefined) throw new Error(`panel-run: missing TUI step ${label} (index ${index})`);
	return step;
}

const mounted = stepAt(tui.steps, 0, "<mount>");
const afterFirstDown = stepAt(tui.steps, 1, "down#1");
const afterTwoDown = stepAt(tui.steps, 2, "down#2");
const afterEnter = stepAt(tui.steps, 3, "enter");
const afterReload = stepAt(tui.steps, 4, "r");
const afterStatus = stepAt(tui.steps, 5, "s");
const afterQuit = stepAt(tui.steps, 6, "q");
/** The operator-visible text `s` produced; narrowed once for the check below. */
const statusNotify = typeof afterStatus.lastNotify === "string" ? afterStatus.lastNotify : "";

const checks: Check[] = [
	{
		name: "(a) panel frames appear while the mode is on and stop after off",
		ok:
			widgetsWithPanelText.length > 0 &&
			clearedWidgets.length > 0 &&
			statusFrames.some(frame => frame.statusText !== undefined),
		surface: "rpc",
		detail: `${widgetsWithPanelText.length} setWidget("${PANEL_WIDGET_KEY}") frame(s) carried "MULTI-AGENT MODE"; ${clearedWidgets.length} cleared it after /swarm off; ${statusFrames.length} setStatus("${PANEL_STATUS_KEY}") frame(s), first text ${JSON.stringify(statusFrames[0]?.statusText)}`,
	},
	{
		name: "(b) the cursor moves on down (the marked row changes)",
		ok:
			mounted.markedRow !== afterFirstDown.markedRow &&
			afterFirstDown.markedRow?.startsWith(">2") === true &&
			afterTwoDown.markedRow?.startsWith(">3") === true,
		surface: "tui",
		detail: `marked row: mount ${JSON.stringify(mounted.markedRow)} -> 1x down ${JSON.stringify(afterFirstDown.markedRow)} -> 2x down ${JSON.stringify(afterTwoDown.markedRow)}`,
	},
	{
		name: "(c) enter marks the row and puts its label in the status line",
		ok:
			afterEnter.selectedRow?.includes("●") === true &&
			typeof afterEnter.statusValue === "string" &&
			afterEnter.statusValue.startsWith("MULTI-AGENT MODE · ") &&
			afterEnter.statusValue.endsWith(" (selected)"),
		surface: "tui",
		detail: `selected badge ${JSON.stringify(afterEnter.selectedRow)}; status line after Enter ${JSON.stringify(afterEnter.statusValue)}`,
	},
	{
		name: "(d) r re-emits the panel",
		ok: afterReload.widgetCalls > afterEnter.widgetCalls && afterReload.notifyCalls > afterEnter.notifyCalls,
		surface: "tui",
		detail: `setWidget calls ${afterEnter.widgetCalls} -> ${afterReload.widgetCalls}; notify calls ${afterEnter.notifyCalls} -> ${afterReload.notifyCalls}`,
	},
	{
		name: "(e) s emits the agent status the operator sees (renderAgents text, not a stub)",
		ok:
			afterStatus.notifyCalls > afterReload.notifyCalls &&
			statusNotify.startsWith("AGENT          STATUS     ROLE         TASK") &&
			statusNotify.includes("BrightTiger") &&
			statusNotify.includes("idle"),
		surface: "tui",
		detail: `notify calls ${afterReload.notifyCalls} -> ${afterStatus.notifyCalls}; the s notify is renderAgents()'s own output (the real handler is extension/index.ts:398-400): ${JSON.stringify(statusNotify.split("\n")[0])} + ${Math.max(0, statusNotify.split("\n").length - 1)} agent row(s)`,
	},
	{
		name: "(f) q clears the status line and removes the panel from the paint",
		ok:
			afterQuit.statusCalls > afterStatus.statusCalls &&
			afterQuit.statusValue === undefined &&
			afterQuit.frame.length === 0,
		surface: "tui",
		detail: `status calls ${afterStatus.statusCalls} -> ${afterQuit.statusCalls}; status line after q ${JSON.stringify(afterQuit.statusValue)}; painted rows after q ${afterQuit.frame.length} (panel=[] via the host cleanup path: dispose + overlay.hide() + refocus + requestRender)`,
	},
	{
		name: "(g) steps store the real painted panel, not the always-blank top rows",
		ok: mounted.frame.some(line => line.includes("MULTI-AGENT MODE")) && mounted.frame.some(line => line.startsWith(">1")),
		surface: "tui",
		detail: `mount frame stores ${mounted.frame.length} non-blank row(s), e.g. ${JSON.stringify(mounted.frame.find(line => line.includes("MULTI-AGENT MODE")))} and ${JSON.stringify(mounted.frame.find(line => line.startsWith(">")))}`,
	},
];

const passed = checks.filter(check => check.ok).length;
writeFileSync(
	OUT,
	`${JSON.stringify({ startedAt: new Date().toISOString(), rpc, tui, checks, summary: `${passed}/${checks.length}` }, null, 2)}\n`,
);

console.log(`[panel-run] wrote ${OUT}`);
console.log(`[panel-run] rpc: installed plugin, ${rpc.panelFrames.length} panel/status frame(s) of ${rpc.frameCount}; command: ${rpc.command}`);
for (const frame of rpc.panelFrames) console.log(`[panel-run]   rpc frame ${JSON.stringify(frame)}`);
console.log(`[panel-run] tui: focusedOnMount=${tui.focusedOnMount}`);
for (const step of tui.steps) {
	console.log(`[panel-run]   tui ${step.key.padEnd(9)} marked=${JSON.stringify(step.markedRow)} selected=${JSON.stringify(step.selectedRow)}`);
}
console.log(`[panel-run] summary: ${passed}/${checks.length} checks passed`);
for (const check of checks) console.log(`[panel-run]   ${check.ok ? "PASS" : "FAIL"} [${check.surface}] ${check.name} — ${check.detail}`);
