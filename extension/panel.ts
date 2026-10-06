/**
 * Pure half of the MULTI-AGENT MODE left panel: the list model, the key reducer and the text
 * rendering. No host/UI API, no timers, no store access - the wiring task feeds it a plain
 * `PanelModel` and maps the host's key ids onto the names `applyPanelKey` expects.
 */

export type PanelStatus = "idle" | "working" | "reviewing" | "offline";

export interface PanelRow {
	index: number;
	id: string;
	label: string;
	status: PanelStatus;
}

export interface PanelModel {
	title: string;
	rows: PanelRow[];
	cursor: number;
	selected?: string;
	now: number;
}

export interface PanelOptions {
	width?: number;
	maxRows?: number;
	ascii?: boolean;
}

export type PanelAction =
	| { kind: "none" }
	| { kind: "select"; id: string }
	| { kind: "reload" }
	| { kind: "status" }
	| { kind: "quit" };

const TITLE = "MULTI-AGENT MODE";
const DEFAULT_WIDTH = 30;
const DEFAULT_MAX_ROWS = 8;
const LEGEND = ["↑/↓ 选择代理", "Enter 切换到该代理", "r 重新加载代理列表", "s 查看代理状态", "q 退出多代理模式"];

function truncate(text: string, width: number): string {
	if (width <= 0) return "";
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

/** `MULTI-AGENT MODE      8 agents` - title left, `<n> agents` flush right inside `width`. */
function headerLine(title: string, count: number, width: number): string {
	const head = title === "" ? TITLE : title;
	const tail = `${count} agents`;
	const gap = width - head.length - tail.length;
	return gap >= 1 ? `${head}${" ".repeat(gap)}${tail}` : `${head} ${tail}`;
}

/**
 * `>2  Bob  · working ●` - cursor prefix, index, label (truncated so the line fits `width`),
 * status, then the `●` selection marker (`*` when `ascii`).
 */
function rowLine(row: PanelRow, cursor: boolean, selected: boolean, width: number, ascii: boolean): string {
	const prefix = cursor ? ">" : " ";
	const index = String(row.index);
	const marker = selected ? (ascii ? " *" : " ●") : "";
	const fixed = prefix.length + index.length + 2 + 4 + row.status.length + marker.length;
	const label = truncate(row.label, Math.max(1, width - fixed));
	return `${prefix}${index}  ${label}  · ${row.status}${marker}`;
}

/** Header, the first `maxRows` rows (with a `… N more` tail when they do not fit), then the legend. */
export function renderPanelLines(model: PanelModel, options: PanelOptions = {}): string[] {
	const width = options.width ?? DEFAULT_WIDTH;
	const maxRows = Math.max(0, options.maxRows ?? DEFAULT_MAX_ROWS);
	const shown = Math.min(maxRows, model.rows.length);
	const lines = [headerLine(model.title, model.rows.length, width)];
	for (let i = 0; i < shown; i++) {
		const row = model.rows[i];
		lines.push(rowLine(row, i === model.cursor, row.id === model.selected, width, options.ascii ?? false));
	}
	if (model.rows.length > shown) lines.push(`… ${model.rows.length - shown} more`);
	lines.push(...LEGEND);
	return lines;
}

/**
 * `up`/`k` and `down`/`j` move the cursor clamped to the list (no wrap, no-op when empty);
 * `enter` selects the row under the cursor only when one exists. The returned model is a copy -
 * the caller's model is never mutated.
 */
export function applyPanelKey(model: PanelModel, key: string): { model: PanelModel; action: PanelAction } {
	const none: PanelAction = { kind: "none" };
	const last = model.rows.length - 1;
	switch (key) {
		case "up":
		case "k":
			return model.rows.length === 0 ? { model, action: none } : { model: { ...model, cursor: Math.max(0, model.cursor - 1) }, action: none };
		case "down":
		case "j":
			return model.rows.length === 0 ? { model, action: none } : { model: { ...model, cursor: Math.min(last, model.cursor + 1) }, action: none };
		case "enter": {
			const row = model.rows[model.cursor];
			return row === undefined ? { model, action: none } : { model, action: { kind: "select", id: row.id } };
		}
		case "r":
			return { model, action: { kind: "reload" } };
		case "s":
			return { model, action: { kind: "status" } };
		case "q":
			return { model, action: { kind: "quit" } };
		default:
			return { model, action: none };
	}
}

/** `MULTI-AGENT MODE · <label> (selected)`, or today's `MULTI-AGENT MODE ON · idle` with none. */
export function statusLineText(selectedLabel: string | undefined): string {
	return selectedLabel ? `${TITLE} · ${selectedLabel} (selected)` : `${TITLE} ON · idle`;
}
