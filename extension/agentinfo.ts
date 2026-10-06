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

/** The full, untruncated row for one agent. */
export function formatRow(row: AgentInfo, opts: { now: number }): string {
	return buildRow(row, opts.now, TASK_TITLE_MAX, OPTIONAL_FIELDS);
}

/** The list, most visible agent first; `[]` reads `no agents`. */
export function renderAgentInfoRows(rows: AgentInfo[], opts: { width: number; now: number }): string[] {
	if (rows.length === 0) return ["no agents"];
	return sortAgentInfo(rows).map((row) => fitRow(row, opts));
}

/**
 * Build the row with the last `keep` optional fields present and the task title clipped to
 * `titleMax`. Fields are always joined whole, so dropping one can never leave a dangling ` · `.
 */
function buildRow(row: AgentInfo, now: number, titleMax: number, keep: number): string {
	const optionals = [
		`ctx ${contextPct(row.ctx)}`,
		`${compactTokens(row.tokens?.in ?? 0)}/${compactTokens(row.tokens?.out ?? 0)} tok`,
		compactCost(row.costUsd),
		row.branch === undefined || row.branch === "" ? "-" : row.branch,
		activityField(row, now),
	];
	const head = [`${GLYPH[row.state] ?? "-"} ${row.name}`, row.state, taskField(row, titleMax)];
	return [...head, ...optionals.slice(0, keep).filter((field) => field !== "")].join(SEP);
}

/**
 * Fit one row into `width`. Drops whole optional fields from the right (turns/age, then branch,
 * cost, tokens, ctx), then shrinks the task title, then - last resort, a name longer than the
 * terminal - hard-clips. `width <= 0` means no truncation.
 */
function fitRow(row: AgentInfo, opts: { width: number; now: number }): string {
	if (opts.width <= 0) return buildRow(row, opts.now, TASK_TITLE_MAX, OPTIONAL_FIELDS);
	let keep = OPTIONAL_FIELDS;
	let titleMax = TASK_TITLE_MAX;
	for (;;) {
		const line = buildRow(row, opts.now, titleMax, keep);
		if (line.length <= opts.width) return line;
		if (keep > 0) {
			keep -= 1;
		} else if (titleMax > 0) {
			// Every pass strips at least one char, so this terminates.
			titleMax = Math.max(0, titleMax - (line.length - opts.width));
		} else {
			// Nothing left to drop: a name longer than the terminal. Clip it and mark the loss.
			return opts.width <= 1 ? line.slice(0, Math.max(0, opts.width)) : `${line.slice(0, opts.width - 1)}…`;
		}
	}
}

function taskField(row: AgentInfo, titleMax: number): string {
	if (!row.taskId) return "no task";
	const title = row.taskTitle === undefined ? "" : clip(row.taskTitle, titleMax);
	return title === "" ? row.taskId : `${row.taskId} "${title}"`;
}

/** `7t 3m`; either half alone when the other is unknown, `` when both are. */
function activityField(row: AgentInfo, now: number): string {
	const parts: string[] = [];
	if (row.turns !== undefined) parts.push(`${row.turns}t`);
	if (row.lastActivityAt !== undefined) parts.push(compactAge(now - row.lastActivityAt));
	return parts.join(" ");
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (max <= 0 || flat === "") return "";
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
