/**
 * Pure, host-free rendering of the always-visible agent list rows.
 *
 * `AgentInfo` carries every fact a row may show; this module only turns facts into strings -
 * no I/O, no clock beyond the `now` the caller passes, no invented numbers. A missing fact
 * degrades to an explicit placeholder (`ctx --%`, `0/0 tok`, `$?`, `-`, `no task`) so a reader
 * can tell "unknown" from "zero". The row is a single ASCII line with a fixed field order, so
 * the caller (the above-editor text widget) can drop whole fields from the right when the
 * terminal is narrow - see `renderAgentInfoRows`.
 */
import type { AgentStatus } from "./types";
import { assignAgentColors, fitColored, paint, sanitizeField, statusColor, visibleWidth } from "./color";

export interface AgentInfo {
	id: string;
	name: string;
	state: AgentStatus;
	taskId?: string;
	taskTitle?: string;
	taskStatus?: string;
	branch?: string;
	turns?: number;
	lastActivityAt?: number;
	worktree?: string;
	ctx?: { used: number; total: number };
	tokens?: { in: number; out: number; cacheRead?: number };
	costUsd?: number;
}

/** Field separator; every row field is joined with exactly this. */
const SEP = " · ";

/** Working first, offline last. Ties keep the caller's order (`Array#sort` is stable). */
const STATE_RANK: Record<AgentStatus, number> = {
	working: 0,
	reviewing: 1,
	waiting: 2,
	blocked: 3,
	idle: 4,
	offline: 5,
};

/** One leading glyph per state, so the row reads at a glance before the name. */
const GLYPH: Record<AgentStatus, string> = {
	working: ">",
	reviewing: "=",
	waiting: "~",
	blocked: "x",
	idle: "-",
	offline: ".",
};

/** Optional fields, left to right; `renderAgentInfoRows` drops them from the right in this order. */
const OPTIONAL_FIELDS = 5;

/** How much of a task title the task field keeps before the title itself is clipped. */
const TASK_TITLE_MAX = 40;

const K = 1024;
const M = 1024 * 1024;
const G = 1024 * 1024 * 1024;

/** `12.1k`/`1.18M` are exact for the sample values; a whole number drops its `.0`/`.00` (`128k`). */
const TOKEN_UNITS = [
	{ div: K, digits: 1, suffix: "k" },
	{ div: M, digits: 2, suffix: "M" },
	{ div: G, digits: 2, suffix: "G" },
];

/**
 * 1024-based token compaction. `999 -> "999"`, `12345 -> "12.1k"`, `1234567 -> "1.18M"`,
 * `1024 -> "1k"`, `1048576 -> "1M"`; a non-finite or negative count reads `0`.
 */
export function compactTokens(n: number): string {
	const value = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
	if (value < K) return String(value);
	for (let i = 0; i < TOKEN_UNITS.length; i++) {
		const unit = TOKEN_UNITS[i];
		const scaled = value / unit.div;
		const text = scaled.toFixed(unit.digits);
		// `1023.97k` would print as `1024.0k`; promote it to the next unit instead.
		if (Number(text) >= K && i + 1 < TOKEN_UNITS.length) continue;
		return `${text.includes(".") ? text.replace(/\.?0+$/, "") : text}${unit.suffix}`;
	}
	return String(value);
}

/** `$0` for a true zero, `$?` when the cost is unknown, else two decimals (`$0.42`). */
export function compactCost(usd: number | undefined): string {
	if (usd === undefined || !Number.isFinite(usd)) return "$?";
	if (usd === 0) return "$0";
	return `$${usd.toFixed(2)}`;
}

/**
 * `62%` of the context window, or `--%` when the window is unknown/unusable (a wrong window
 * size is not a percentage - it is a missing fact).
 */
export function contextPct(ctx: { used: number; total: number } | undefined): string {
	if (ctx === undefined || !Number.isFinite(ctx.total) || ctx.total <= 0) return "--%";
	const used = Number.isFinite(ctx.used) ? Math.max(0, ctx.used) : 0;
	return `${Math.round((used / ctx.total) * 100)}%`;
}

/** `3m`/`2h`/`4d` since a timestamp; a future/negative span clamps to `0s`. */
export function compactAge(millis: number): string {
	const seconds = Math.max(0, Math.round(millis / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

/** Copy, most visible state first, then by name (code-unit). Equal rows keep their input order. */
export function sortAgentInfo(rows: AgentInfo[]): AgentInfo[] {
	return [...rows].sort((a, b) => {
		const rank = STATE_RANK[a.state] - STATE_RANK[b.state];
		if (rank !== 0) return rank;
		return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
	});
}

/** The full, untruncated row for one agent. `color` paints only the name and status tokens. */
export function formatRow(row: AgentInfo, opts: { now: number; color?: boolean }): string {
	const tokens = rowTokens(row, opts.now, TASK_TITLE_MAX, OPTIONAL_FIELDS);
	return renderTokens(tokens, row, opts.color === true ? assignAgentColors([row.id]).get(row.id) : undefined);
}

/**
 * The roster colour, keyed on IDENTITY, not on the line the id happens to sit on: the palette is
 * dealt over the agent ids sorted by name, while `sortAgentInfo` decides only the line order.
 * Dealing over the display order would recolour every agent whenever any one of them changed state,
 * because the display order itself is state-ranked - which defeats the point of a reminder colour.
 * A roster that gains an agent may still shift a later slot (a slot cannot be both stable and unique
 * without configuration); a state change never does.
 */
function rosterColors(rows: AgentInfo[]): Map<string, number> {
	return assignAgentColors([...new Set(rows.map((row) => row.id))].sort());
}

/** The list, most visible agent first; `[]` reads `no agents`. Colour follows the agent, not the line. */
export function renderAgentInfoRows(
	rows: AgentInfo[],
	opts: { width: number; now: number; color?: boolean },
): string[] {
	if (rows.length === 0) return ["no agents"];
	const sorted = sortAgentInfo(rows);
	const colors = opts.color === true ? rosterColors(rows) : undefined;
	return sorted.map((row) => fitRow(row, opts, colors?.get(row.id)));
}

/**
 * The row's fields, left to right: the `glyph name` head, the state, the task field, then the
 * last `keep` optional fields. Fields stay whole, so dropping one can never leave a dangling
 * ` · ` - the caller joins them with `SEP`. Every field that carries text from outside this module
 * (a task title, an id, a branch) is sanitized first: the widget path writes its bytes to the
 * terminal verbatim, so a control sequence in a title would otherwise be executed by the terminal.
 */
function rowTokens(row: AgentInfo, now: number, titleMax: number, keep: number): string[] {
	const optionals = [
		`ctx ${contextPct(row.ctx)}`,
		`${compactTokens(row.tokens?.in ?? 0)}/${compactTokens(row.tokens?.out ?? 0)} tok`,
		compactCost(row.costUsd),
		row.branch === undefined || row.branch === "" ? "-" : sanitizeField(row.branch),
		activityField(row, now),
	];
	const head = [`${GLYPH[row.state] ?? "-"} ${sanitizeField(row.name)}`, sanitizeField(row.state), taskField(row, titleMax)];
	// A field that sanitization emptied (an id that was only an escape sequence) drops out, so the
	// row can still never carry a dangling ` · `.
	return [...head, ...optionals.slice(0, keep)].filter((field) => field !== "");
}

/**
 * Join the fields into one line, painting the `glyph name` head and the state token when a
 * `nameColor` is given (the state always takes its own `statusColor`). The visible text is
 * untouched - paint only wraps it - so the line's width is the same as the plain one.
 */
function renderTokens(tokens: string[], row: AgentInfo, nameColor: number | undefined): string {
	if (nameColor === undefined) return tokens.join(SEP);
	const painted = tokens.map((token, index) => {
		if (index === 0) return paint(token, nameColor, { enabled: true });
		if (index === 1) return paint(token, statusColor(row.state), { enabled: true });
		return token;
	});
	return painted.join(SEP);
}

/**
 * Fit one row into `width`. Drops whole optional fields from the right (turns/age, then branch,
 * cost, tokens, ctx), then shrinks the task title, then - last resort, a name longer than the
 * terminal - hard-clips. `width <= 0` means no truncation. Every row is measured by VISIBLE width
 * (escapes count zero, CJK and emoji count what the terminal draws), colored or not: the host
 * wraps by that same measure, so a row measured with `.length` would wrap under itself.
 */
function fitRow(row: AgentInfo, opts: { width: number; now: number }, nameColor?: number): string {
	if (opts.width <= 0) {
		return renderTokens(rowTokens(row, opts.now, TASK_TITLE_MAX, OPTIONAL_FIELDS), row, nameColor);
	}
	let keep = OPTIONAL_FIELDS;
	let titleMax = TASK_TITLE_MAX;
	for (;;) {
		const line = renderTokens(rowTokens(row, opts.now, titleMax, keep), row, nameColor);
		const measured = visibleWidth(line);
		if (measured <= opts.width) return line;
		if (keep > 0) {
			keep -= 1;
		} else if (titleMax > 0) {
			// Every pass strips at least one char, so this terminates.
			titleMax = Math.max(0, titleMax - (measured - opts.width));
		} else {
			// Nothing left to drop: a name longer than the terminal. Clip it and mark the loss.
			return clipped(line, opts.width);
		}
	}
}

/**
 * Last-resort hard clip of a row wider than the terminal: `width` VISIBLE columns with a `…`
 * marking the loss (a single-column budget keeps the one character it can). The clip never splits
 * a grapheme cluster and never lands inside a color, so the `…` cannot inherit one.
 */
function clipped(line: string, width: number): string {
	if (width <= 1) return fitColored(line, width);
	return `${fitColored(line, width - 1)}…`;
}

function taskField(row: AgentInfo, titleMax: number): string {
	if (!row.taskId) return "no task";
	const id = sanitizeField(row.taskId);
	const title = row.taskTitle === undefined ? "" : clip(sanitizeField(row.taskTitle), titleMax);
	return title === "" ? id : `${id} "${title}"`;
}

/** `7t 3m`; either half alone when the other is unknown, `` when both are. */
function activityField(row: AgentInfo, now: number): string {
	const parts: string[] = [];
	if (row.turns !== undefined) parts.push(`${row.turns}t`);
	if (row.lastActivityAt !== undefined) parts.push(compactAge(now - row.lastActivityAt));
	return parts.join(" ");
}

/** Flattened text clipped to `max` code units, ending in `…`; never leaves half a surrogate pair. */
function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (max <= 0 || flat === "") return "";
	if (flat.length <= max) return flat;
	const cut = flat.slice(0, max - 1);
	// `slice` counts code units, so a cut can land inside a surrogate pair (an emoji split in half):
	// the host's native wrap then draws that half wider than `visibleWidth` measures it and the row
	// wraps under itself. Drop the orphaned high surrogate instead.
	return /[\uD800-\uDBFF]$/.test(cut) ? `${cut.slice(0, -1)}…` : `${cut}…`;
}
