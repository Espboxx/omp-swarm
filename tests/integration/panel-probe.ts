/**
 * task-14 probe runner — proves what UI surface the MULTI-AGENT MODE left panel
 * can be built on. Two phases, both leaving literal evidence in
 * `tests/integration/last-run-panel-probe.json`:
 *
 *  Phase 1 `rpc` — boots a real `omp --mode rpc-ui` session (the harness the
 *  repo's other integration runs use) with `panel-probe-ext.ts` loaded via `-e`,
 *  drives `/panel-probe`, and captures the `extension_ui_request` frames. This is
 *  the surface the shipped extension is integration-tested on.
 *
 *  Phase 2 `tui` — mounts the same panel component on a real TUI engine instance
 *  with a headless terminal, then (a) reads the composited frame back to show
 *  where the overlay landed and (b) feeds arrow/enter/r/s/q through the same
 *  input pipeline as terminal stdin to show whether the component receives them.
 *  This is the operator's surface (`omp` in a terminal); phase 1 proves the
 *  headless hosts cannot host it.
 *
 * Usage: bun run tests/integration/panel-probe.ts [--seconds 40]
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TUI, type Component, type OverlayOptions, type Terminal, matchesKey } from "@oh-my-pi/pi-tui";
import { PANEL_PROBE_MARK } from "./panel-probe-ext";
import { RpcClient, type RpcFrame } from "./rpc-client";

const EXTENSION = resolve(import.meta.dir, "panel-probe-ext.ts");
const OUT = join(import.meta.dir, "last-run-panel-probe.json");

interface ProbeFinding {
	name: string;
	value: unknown;
}
interface RpcPhase {
	command: string;
	cwd: string;
	reachedDone: boolean;
	frameCount: number;
	frames: Record<string, unknown>[];
	findings: ProbeFinding[];
	stderrTail: string;
}
interface LeftColumnRow {
	row: number;
	col0: string;
	restBlank: boolean;
}
interface TuiPhase {
	overlayOptions: OverlayOptions;
	terminal: { columns: number; rows: number };
	focusedOnMount: boolean;
	keyEvents: string[];
	paintedRows: number;
	leftColumn: LeftColumnRow[];
}
interface ProbeResult {
	startedAt: string;
	extension: string;
	rpc: RpcPhase;
	tui: TuiPhase;
}

const SECONDS = Number(process.argv[process.argv.indexOf("--seconds") + 1] ?? "40") || 40;

/** Phase 1: the RPC surface. Returns the frames and the extension's own findings. */
async function probeRpc(seconds: number): Promise<RpcPhase> {
	const root = resolve(import.meta.dir, "..", "..", "scratch", "panel-api", "rpc");
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "package.json"), '{\n  "name": "panel-probe-rpc",\n  "private": true\n}\n');

	const command = ["omp", "--mode", "rpc-ui", "--no-session", "-e", EXTENSION, "--no-title"];
	const client = new RpcClient(command, root);
	const findings: ProbeFinding[] = [];
	let reachedDone = false;
	const started = Date.now();
	try {
		await client.waitForReady(60_000);
		client.send({ type: "prompt", message: "/panel-probe" });
		while (!reachedDone && Date.now() - started < seconds * 1000) {
			for (const frame of client.frames) {
				if (frame.type !== "extension_ui_request" || frame.method !== "notify") continue;
				const message = typeof frame.message === "string" ? frame.message : "";
				if (!message.startsWith(PANEL_PROBE_MARK)) continue;
				let finding: ProbeFinding;
				try {
					finding = JSON.parse(message.slice(PANEL_PROBE_MARK.length)) as ProbeFinding;
				} catch {
					continue; // not a probe payload
				}
				if (!findings.some(existing => existing.name === finding.name)) findings.push(finding);
				if (finding.name === "done") reachedDone = true;
			}
			await Bun.sleep(200);
		}
	} finally {
		await client.close(5000);
	}

	const strip = (frame: RpcFrame): Record<string, unknown> => {
		const { type, id, method, message, statusKey, statusText, widgetKey, widgetLines, widgetPlacement } = frame;
		return { type, id, method, message, statusKey, statusText, widgetKey, widgetLines, widgetPlacement };
	};
	return {
		command: command.join(" "),
		cwd: root,
		reachedDone,
		frameCount: client.frames.length,
		frames: client.frames.map(strip),
		findings,
		stderrTail: client.stderr.slice(-2000),
	};
}

/**
 * Phase 2: the operator's surface — a real TUI engine over a headless terminal.
 * Exported because it is the ONLY way to prove panel key delivery: RPC has no
 * keystroke-injection command and `custom()` is a no-op there (see CONTRACT.md).
 * task-17/18 reuse this instead of hand-rolling a PTY.
 */
export async function probeTui(): Promise<TuiPhase> {
	const columns = 80;
	const rows = 24;
	const noop = (): void => {};
	// `as unknown as Terminal`: the TUI needs a structural Terminal; a real one
	// would open a PTY, which a headless probe must not do.
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

	const keyEvents: string[] = [];
	const panel: Component = {
		handleInput(data: string): void {
			keyEvents.push(
				matchesKey(data, "up") ? "up" : matchesKey(data, "down") ? "down" : matchesKey(data, "enter") ? "enter" : data,
			);
		},
		render(width: number): readonly string[] {
			// 20 rows ≈ full height of a 24-row terminal: the "near-full-height" ask.
			return Array.from({ length: 20 }, (_, row) => `| ${row}`.padEnd(width, " ").slice(0, width));
		},
	};

	const overlayOptions: OverlayOptions = { anchor: "left-center", width: 20, maxHeight: "100%", margin: 0 };
	const tui = new TUI(terminal);
	tui.showOverlay(panel, overlayOptions);
	const focusedOnMount = tui.getFocused() === panel;
	// Raw terminal bytes, exactly what a real stdin would deliver: ↓ ↓ ↑ Enter r s q.
	for (const data of ["\x1b[B", "\x1b[B", "\x1b[A", "\r", "r", "s", "q"]) tui.injectDebugInput(data);
	tui.requestRender(true);
	await Bun.sleep(150);
	const paint = tui.getDebugPaint();
	const frameLines = (paint?.lines ?? []).map(line => line.replace(/\u001b\[[0-9;]*m/g, ""));
	return {
		overlayOptions,
		terminal: { columns, rows },
		focusedOnMount,
		keyEvents,
		paintedRows: frameLines.length,
		// Column 0 of every painted row: the non-blank run is the left-anchored overlay.
		leftColumn: frameLines.map((line, row) => ({ row, col0: line.slice(0, 20), restBlank: line.slice(20).trim() === "" })),
	};
}

const result: ProbeResult = {
	startedAt: new Date().toISOString(),
	extension: EXTENSION,
	rpc: await probeRpc(SECONDS),
	tui: await probeTui(),
};
writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);

console.log(`[probe] wrote ${OUT}`);
console.log(`[probe] rpc: reachedDone=${result.rpc.reachedDone} frames=${result.rpc.frameCount} findings=${result.rpc.findings.map(f => f.name).join(", ") || "none"}`);
console.log(`[probe] tui: focusedOnMount=${result.tui.focusedOnMount} keys=${JSON.stringify(result.tui.keyEvents)} paintedRows=${result.tui.paintedRows}`);
for (const line of result.tui.leftColumn.filter(row => row.col0.trim() !== "").slice(0, 4)) {
	console.log(`[probe]   row ${line.row}: ${JSON.stringify(line.col0)}`);
}
