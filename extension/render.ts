import { fitColored, paint, sanitizeField, visibleWidth } from "./color";
import type { BlackboardEntry, SwarmAgent, SwarmMessage, SwarmTask, TaskCounts } from "./types";
import type { StatusSnapshot } from "./store";

function age(now: number, then: number): string {
	const seconds = Math.max(0, Math.round((now - then) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	return `${Math.round(seconds / 3600)}h`;
}

/**
 * Flattened store text, clipped to `width` columns and ending in `…`. Control sequences are
 * dropped first: a task title, a board entry or an inbox body is peer-authored text, and the host
 * writes these bytes to the terminal verbatim (task-47), so a clear-screen or an OSC 52 clipboard
 * write in a title is a terminal command, not text. The clip is measured the way the host measures
 * (`visibleWidth`/`fitColored`), so a CJK or emoji title cannot overrun the width it was given.
 */
function truncate(text: string, width: number): string {
	const flat = sanitizeField(text.replace(/\s+/g, " ").trim());
	if (width <= 0) return "";
	if (visibleWidth(flat) <= width) return flat;
	return `${fitColored(flat, width - 1)}…`;
}

/**
 * Earliest activity a snapshot proves: the oldest agent join OR the oldest claim it carries
 * (both live as long as the database does, so they match the lifetime `done` count).
 */
function activityStart(snapshot: StatusSnapshot): number | undefined {
	const stamps = [
		...snapshot.agents.map((a) => a.joinedAt),
		...snapshot.inFlight.flatMap((t) => (t.claimedAt === undefined ? [] : [t.claimedAt])),
	];
	return stamps.length === 0 ? undefined : Math.min(...stamps);
}

/**
 * Oldest completion the snapshot carries, or `undefined` when it carries none. `updatedAt` is
 * the completion time of a done task, so the newest N completions all fall inside
 * `age(now, completionStart)` - the window the throughput count belongs to.
 */
function completionStart(snapshot: StatusSnapshot): number | undefined {
	const stamps = snapshot.recentDone.map((t) => t.updatedAt);
	return stamps.length === 0 ? undefined : Math.min(...stamps);
}

/**
 * `task-17 3m` while the agent holds a claim (the age of its lease), `-` when it is not
 * working. The age comes from the task's `claimedAt` in the snapshot, so a task whose
 * record is missing still shows its id - never a made-up age.
 */
function taskProgress(agent: SwarmAgent, inFlight: SwarmTask[], now: number): string {
	if ((agent.status !== "working" && agent.status !== "reviewing") || !agent.currentTask) return "-";
	const task = sanitizeField(agent.currentTask);
	const since = inFlight.find((t) => t.id === agent.currentTask)?.claimedAt;
	return since === undefined ? task : `${task} ${age(now, since)}`;
}

/**
 * The counter line's segments, in display order, each with its reminder color. The first four
 * mirror `color.ts`'s status map verbatim (`waiting` 220, `working` 40, `reviewing` 45, `blocked`
 * 203) so a worker row and the counter beside it speak one visual language; `DONE` and `FAILED`
 * are counters rather than agent states, so they take their own ends of the success/failure
 * families (35 spring green, 196 bright red) - both distinct from every other segment.
 */
const COUNTER_SEGMENTS: ReadonlyArray<{ key: keyof TaskCounts; label: string; color: number }> = [
	{ key: "ready", label: "READY", color: 220 },
	{ key: "claimed", label: "CLAIMED", color: 40 },
	{ key: "review", label: "REVIEW", color: 45 },
	{ key: "blocked", label: "BLOCKED", color: 203 },
	{ key: "done", label: "DONE", color: 35 },
	{ key: "failed", label: "FAILED", color: 196 },
];

/** Paint `text` when color is on, byte-identical plain text when it is not. */
function tint(text: string, color: number, enabled: boolean): string {
	return enabled ? paint(text, color, { enabled: true }) : text;
}

/**
 * ` READY 2  CLAIMED 1  REVIEW 0  BLOCKED 3  DONE 6  FAILED 1`. A non-zero segment carries its
 * reminder color so `BLOCKED` and `FAILED` stand out and `DONE` reads as success; a zero counter
 * stays plain, which keeps a clean pool from turning into a rainbow. `color: false` is
 * byte-identical to the plain line this module has always emitted.
 */
function countersLine(counts: TaskCounts, color: boolean): string {
	const segments = COUNTER_SEGMENTS.map(({ key, label, color: index }) =>
		counts[key] > 0 ? tint(`${label} ${counts[key]}`, index, color) : `${label} ${counts[key]}`,
	);
	return ` ${segments.join("  ")}`;
}

export function renderPanel(snapshot: StatusSnapshot, maxLines = 10, opts: { color?: boolean } = {}): string[] {
	const lines: string[] = [];
	const online = snapshot.agents.filter((a) => a.status !== "offline").length;
	lines.push(`SWARM ${snapshot.running ? "running" : "stopped"} · ${snapshot.agents.length} agents (${online} online)`);
	for (const agent of snapshot.agents.slice(0, 5)) {
		lines.push(
			` ${sanitizeField(agent.id).padEnd(12)} ${sanitizeField(agent.status).padEnd(9)} ${sanitizeField(agent.role).padEnd(10)} ${taskProgress(agent, snapshot.inFlight, snapshot.now)} (hb ${age(snapshot.now, agent.heartbeatAt)})`,
		);
	}
	if (snapshot.agents.length > 5) lines.push(` … ${snapshot.agents.length - 5} more`);
	const c = snapshot.counts;
	lines.push(countersLine(c, opts.color === true));
	const board = Object.entries(snapshot.board)
		.sort()
		.map(([type, n]) => `${sanitizeField(type)} ${n}`)
		.join("  ");
	lines.push(` BOARD ${board === "" ? "-" : board}`);
	return lines.slice(0, maxLines);
}

export function renderAgents(agents: SwarmAgent[], now: number): string {
	if (agents.length === 0) return "No agents registered. Start a swarm with /swarm start.";
	const rows = agents.map(
		(a) =>
			`${sanitizeField(a.id).padEnd(14)} ${sanitizeField(a.status).padEnd(10)} ${sanitizeField(a.role).padEnd(12)} task=${sanitizeField(a.currentTask ?? "-").padEnd(10)} hb=${age(now, a.heartbeatAt)} caps=[${sanitizeField(a.capabilities.join(","))}]${a.worktree ? ` wt=${sanitizeField(a.worktree)}` : ""}`,
	);
	return ["AGENT          STATUS     ROLE         TASK", ...rows].join("\n");
}

export function renderTasks(tasks: SwarmTask[], now: number): string {
	if (tasks.length === 0) return "No tasks.";
	const header = "ID       STATUS   PRI  OWNER        AGE  TITLE";
	const rows = tasks.map((t) => {
		const owner = t.claimedBy ?? t.review.reviewer ?? "-";
		const flags = sanitizeField(
			[
				t.status === "claimed" && t.claimedAt !== undefined ? `att=${t.attempts} run=${age(now, t.claimedAt)}` : "",
				t.dependencies.length > 0 ? `deps=${t.dependencies.join("+")}` : "",
				t.review.required ? `review=${t.review.status ?? "pending"}` : "",
				t.requiredCapabilities.length > 0 ? `caps=${t.requiredCapabilities.join(",")}` : "",
			]
				.filter(Boolean)
				.join(" "),
		);
		return `${sanitizeField(t.id).padEnd(8)} ${sanitizeField(t.status).padEnd(8)} ${String(t.priority).padEnd(4)} ${sanitizeField(owner).padEnd(12)} ${age(now, t.updatedAt).padEnd(4)} ${truncate(t.title, 46)}${flags ? `  [${flags}]` : ""}`;
	});
	return [header, ...rows].join("\n");
}

export function renderBoard(entries: BlackboardEntry[]): string {
	if (entries.length === 0) return "Blackboard is empty.";
	return entries
		.map((e) => {
			const tags = e.tags.length > 0 ? ` #${sanitizeField(e.tags.join(" #"))}` : "";
			const task = e.taskId ? ` (${sanitizeField(e.taskId)})` : "";
			return `#${e.id} ${sanitizeField(e.type).padEnd(11)} ${sanitizeField(e.agentId).padEnd(12)}${task}${tags}\n    ${truncate(e.content, 160)}`;
		})
		.join("\n");
}

export function renderInbox(messages: SwarmMessage[]): string {
	if (messages.length === 0) return "No unread messages.";
	return messages
		.map(
			(m) =>
				`#${m.id}${m.urgent ? " URGENT" : ""} from ${sanitizeField(m.from)}${m.taskId ? ` re ${sanitizeField(m.taskId)}` : ""}: ${truncate(m.body, 200)}`,
		)
		.join("\n");
}

export function renderTaskDetail(task: SwarmTask): string {
	const lines = [
		`${sanitizeField(task.id)}  ${sanitizeField(task.status)}  priority=${task.priority}  attempts=${task.attempts}`,
		`title: ${sanitizeField(task.title)}`,
		`created by ${sanitizeField(task.createdBy)} at ${new Date(task.createdAt).toISOString()}`,
	];
	if (task.description) lines.push(`description: ${sanitizeField(task.description)}`);
	if (task.dependencies.length > 0) lines.push(`dependencies: ${sanitizeField(task.dependencies.join(", "))}`);
	if (task.requiredCapabilities.length > 0) lines.push(`capabilities: ${sanitizeField(task.requiredCapabilities.join(", "))}`);
	if (task.files.length > 0) lines.push(`files: ${sanitizeField(task.files.join(", "))}`);
	if (task.claimedBy) lines.push(`claimed by ${sanitizeField(task.claimedBy)} until ${task.leaseUntil ? new Date(task.leaseUntil).toISOString() : "?"}`);
	if (task.review.required) {
		const reviewer = task.review.reviewer ? ` by ${sanitizeField(task.review.reviewer)}` : "";
		lines.push(`review: ${sanitizeField(task.review.status ?? "pending")}${reviewer}`);
	}
	if (task.review.notes) lines.push(`review notes: ${sanitizeField(task.review.notes)}`);
	if (task.result) lines.push(`result: ${sanitizeField(task.result)}`);
	if (task.commit) lines.push(`commit: ${sanitizeField(task.commit)}`);
	return lines.join("\n");
}

/**
 * `throughput done 3 in 12m`. With completions on hand the count and the window describe the
 * same period: the completions the snapshot carries, over the oldest of their completion times.
 * With none carried, it falls back to the lifetime `done` count over the earliest window the
 * snapshot proves (oldest agent join or oldest claim) - the two halves only agree when the
 * database is as old as the count. With nothing provable the line keeps the count and drops the
 * `in` clause instead of inventing a duration.
 */
export function renderSummary(snapshot: StatusSnapshot): string {
	const c = snapshot.counts;
	const lines = renderPanel(snapshot, 10);
	lines.push("", `total tasks: ready ${c.ready}, claimed ${c.claimed}, review ${c.review}, blocked ${c.blocked}, done ${c.done}, failed ${c.failed}`);
	const inFlight = snapshot.inFlight.slice(0, 5);
	if (inFlight.length > 0) {
		lines.push("in flight:");
		for (const task of inFlight) {
			const claim = task.claimedAt !== undefined ? ` claimed=${age(snapshot.now, task.claimedAt)}` : "";
			lines.push(
				` ${sanitizeField(task.id)} ${sanitizeField(task.status)} owner=${sanitizeField(task.claimedBy ?? task.review.reviewer ?? "-")} attempts=${task.attempts} elapsed=${age(snapshot.now, task.createdAt)}${claim}`,
			);
		}
		if (snapshot.inFlight.length > inFlight.length) lines.push(` … ${snapshot.inFlight.length - inFlight.length} more`);
	}
	// The completions on hand, over the oldest of their completion times; otherwise the lifetime
	// count over the earliest window the snapshot proves.
	const completion = completionStart(snapshot);
	const start = completion ?? activityStart(snapshot);
	const done = completion === undefined ? c.done : snapshot.recentDone.length;
	lines.push(start === undefined ? `throughput done ${done}` : `throughput done ${done} in ${age(snapshot.now, start)}`);
	return lines.join("\n");
}

/* ------------------------------------------------------------------------------------------------
 * Task progress + one-shot batch-completion summary.
 *
 * Both are pure and host-free: deterministic given their inputs, no I/O, no clock of their own.
 * The denominator is the ACTIONABLE work (`ready + claimed + review + done + failed`); blocked
 * tasks are excluded because they can be permanently blocked by a dependency that will never
 * finish - counting them would leave the bar short of 100% forever - and are reported separately
 * instead. Nothing is invented: a field that is not known is omitted, never replaced by a
 * placeholder or a fabricated number.
 * ---------------------------------------------------------------------------------------------- */

export interface ProgressInput {
	counts: TaskCounts;
}

function finishedCount(counts: TaskCounts): number {
	return counts.done + counts.failed;
}

/** The work the bar can still finish: blocked is deliberately not part of it. */
function actionableCount(counts: TaskCounts): number {
	return counts.ready + counts.claimed + counts.review + counts.done + counts.failed;
}

/**
 * `██████░░░░` - full blocks for the finished share of the actionable work, light for the rest.
 * `width` is in characters. A non-positive width, or a pool with nothing actionable, renders "".
 */
export function progressBar(counts: ProgressInput["counts"], width: number): string {
	if (width <= 0) return "";
	const actionable = actionableCount(counts);
	if (actionable === 0) return "";
	const filled = Math.min(width, Math.max(0, Math.round((finishedCount(counts) / actionable) * width)));
	return "█".repeat(filled) + "░".repeat(width - filled);
}

/**
 * `TASKS 7/9 · 1 running · 1 blocked · 78%` - finished/actionable, then the non-zero segments
 * (running = claimed + review, ready, blocked) and the percentage. Nothing actionable reads as
 * `TASKS - · no tasks`; a zero segment is omitted rather than printed as `0 …`. With `{color}` the
 * segments carry the same reminder colors the counter line uses, so `blocked` stands out; the head
 * and the percentage stay plain, and `color: false` is byte-identical to today.
 */
export function progressLine(counts: ProgressInput["counts"], opts: { color?: boolean } = {}): string {
	const enabled = opts.color === true;
	const actionable = actionableCount(counts);
	if (actionable === 0) return "TASKS - · no tasks";
	const finished = finishedCount(counts);
	const running = counts.claimed + counts.review;
	const parts = [`TASKS ${finished}/${actionable}`];
	if (running > 0) parts.push(tint(`${running} running`, 40, enabled));
	if (counts.ready > 0) parts.push(tint(`${counts.ready} ready`, 220, enabled));
	if (counts.blocked > 0) parts.push(tint(`${counts.blocked} blocked`, 203, enabled));
	parts.push(`${Math.round((100 * finished) / actionable)}%`);
	return parts.join(" · ");
}

/**
 * `SWARM 7/9 done` - the live half of the status line under the composer. In flight it is plain;
 * once every actionable task is finished it reads as success (green 35) unless something failed,
 * where it takes the failure red (203). `undefined` when nothing is actionable, so a stopped pool
 * carries no counter at all. `color: false` is byte-identical to the plain form.
 *
 * NOTE (measured, task-49): the host strips SGR from extension status text before painting it -
 * `pi-tui/src/status-line/component.ts:3599` -> `chrome/shared.ts:9 sanitizeStatusText` ->
 * `overlays/extensions/display-text.ts:12 sanitizeDisplayText` -> `sanitizeText`. So the paint this
 * returns never reaches the terminal today; the operator reads the plain text, which is why the
 * strip is safe here (nothing half-painted survives). The paint is kept because it costs nothing,
 * it is what the formatter contract promises, and it becomes visible the day the host stops
 * sanitizing status text. Proven live with a throwaway probe: the same repaint carried the widget's
 * `\x1b[38;5;213m` and a plain status string.
 */
export function progressStatusLine(counts: TaskCounts, opts: { color?: boolean } = {}): string | undefined {
	const actionable = actionableCount(counts);
	if (actionable === 0) return undefined;
	const finished = finishedCount(counts);
	const text = `SWARM ${finished}/${actionable} done`;
	if (opts.color !== true || finished < actionable) return text;
	return paint(text, counts.failed > 0 ? 203 : 35, { enabled: true });
}

export interface DrainSummary {
	counts: ProgressInput["counts"];
	elapsedMs: number;
	agents: number;
	costUsd?: number;
	tasks: Array<{ id: string; title: string; status: "done" | "failed"; agent?: string; durationMs?: number; reason?: string }>;
}

/** `45s`, `12m40s`, `3m`, `1h06m` - sub-minute, then minutes (seconds dropped at the whole minute), then hours with the minutes carried. */
function compactDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	if (minutes < 60) {
		const seconds = total % 60;
		return seconds === 0 ? `${minutes}m` : `${minutes}m${String(seconds).padStart(2, "0")}s`;
	}
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Flattened text clipped to `width` VISIBLE columns, ending in `…`. A non-positive width yields "",
 * control sequences are dropped (the text is store data on its way to the terminal), and whole
 * grapheme clusters are kept or dropped, so a cut can never land inside a surrogate pair, an emoji
 * or a combining mark.
 */
function clipTo(text: string, width: number): string {
	if (width <= 0) return "";
	const flat = sanitizeField(text.replace(/\s+/g, " ").trim());
	if (visibleWidth(flat) <= width) return flat;
	if (width === 1) return "…";
	return `${fitColored(flat, width - 1)}…`;
}

/**
 * Last-resort guard: the width, no-tab and no-control-sequence invariants hold even for a
 * pathological width. The sanitizer drops every escape and every control character (tab included -
 * see `sanitizeField`), and everything left is measured on VISIBLE columns: `.length` counts escape
 * bytes and misses the column a CJK glyph occupies, which is what let a summary line wrap under
 * itself (the 8e1a468 defect).
 */
function fitLine(line: string, width: number): string {
	const safe = sanitizeField(line);
	if (width <= 0) return "";
	if (visibleWidth(safe) <= width) return safe;
	if (width === 1) return "…";
	return `${fitColored(safe, width - 1)}…`;
}

/**
 * `SWARM DONE · 9/9 tasks (7 done, 2 failed) · 3 agents · 12m40s · $0.42`. The `(… done, … failed)`
 * split drops the failed half at zero; `· $cost` is omitted entirely when the cost is unknown
 * (never `$?`); blocked tasks stay out of the denominator, as in `progressLine`.
 */
export function drainSummaryTitle(s: DrainSummary): string {
	const c = s.counts;
	const parts = [
		"SWARM DONE",
		`${finishedCount(c)}/${actionableCount(c)} tasks (${c.done} done${c.failed > 0 ? `, ${c.failed} failed` : ""})`,
		`${s.agents} agents`,
		compactDuration(s.elapsedMs),
	];
	if (s.costUsd !== undefined) parts.push(`$${s.costUsd.toFixed(2)}`);
	return parts.join(" · ");
}

/** `task-2` sorts before `task-10`: same prefix, numeric suffix decides. */
function compareTaskIds(a: string, b: string): number {
	const ma = /^(.*?)(\d+)$/.exec(a);
	const mb = /^(.*?)(\d+)$/.exec(b);
	if (ma !== null && mb !== null && ma[1] === mb[1]) return Number(ma[2]) - Number(mb[2]);
	if (a === b) return 0;
	return a < b ? -1 : 1;
}

/**
 * `  v task-30 <title> (SwiftTiger · 3m)` / `  x task-31 <title> (failed: <reason>)`. Only the
 * title is clipped to fit; a known agent/duration or failed reason is carried verbatim unless the
 * line itself cannot fit, in which case the detail text (never the id) shrinks. Unknown fields are
 * omitted - no `()`, no `undefined`, no invented duration.
 */
function drainTaskLine(task: DrainSummary["tasks"][number], width: number): string {
	const prefix = `  ${task.status === "done" ? "v" : "x"} ${sanitizeField(task.id)} `;
	const duration = task.durationMs === undefined ? undefined : compactDuration(task.durationMs);
	let detail: string;
	if (task.status === "done") {
		detail = [task.agent === undefined ? undefined : sanitizeField(task.agent), duration]
			.filter((part): part is string => part !== undefined && part !== "")
			.join(" · ");
	} else {
		const reason = task.reason === undefined ? undefined : sanitizeField(task.reason).replace(/\s+/g, " ").trim();
		detail = reason === undefined || reason === "" ? "failed" : `failed: ${reason}`;
	}
	const room = width > 0 ? width - visibleWidth(prefix) : Number.POSITIVE_INFINITY;
	if (room <= 0) return fitLine(prefix.trimEnd(), width);
	let suffix = detail === "" ? "" : ` (${detail})`;
	if (visibleWidth(suffix) > room - 1) {
		// The line cannot hold the detail and a title: shrink the detail (never the id), leaving one
		// character so the title still shows that it was clipped instead of vanishing.
		detail = clipTo(detail, room - 4);
		suffix = detail === "" ? "" : ` (${detail})`;
	}
	const titleBudget = width > 0 ? width - visibleWidth(prefix) - visibleWidth(suffix) : Number.POSITIVE_INFINITY;
	const title = titleBudget > 0 ? clipTo(task.title, titleBudget) : "";
	const head = title === "" ? prefix.trimEnd() : prefix;
	return fitLine(`${head}${title}${suffix}`, width);
}

const MAX_SUMMARY_TASKS = 8;

/** The `… +N more` tail this module emits, matched back to recover how many task lines it hides. */
const SUMMARY_TAIL = /^\s*… \+(\d+) more/;

/**
 * Fit an already-rendered summary block into `room` lines — the host keeps only the first ten
 * declared lines of a `string[]` widget and replaces the rest with "... (widget truncated)"
 * (`pi-coding-agent/.../extension-ui-controller.ts:45`, `:362`), so a block that ignores its budget
 * is silently cut and the `… +N more` tail disappears with it. The widget's other rows (mode
 * header, run line, worker rows, counters, BOARD) are the caller's to budget; this owns the block.
 *
 * The headline is always kept while anything fits, and the `… +N more` tail survives whenever two
 * lines fit: the count it reports absorbs the task lines the smaller budget hides, so the operator
 * can still tell how much is not shown. `room <= 0` returns `[]` (nothing fits); the tail is only
 * ever counted, never fabricated - a block that hid nothing keeps hiding nothing.
 */
export function fitSummaryLines(lines: readonly string[], room: number): string[] {
	const budget = Math.floor(room);
	if (budget <= 0 || lines.length === 0) return [];
	if (lines.length <= budget) return [...lines];
	const headline = lines[0] as string;
	if (budget === 1) return [headline];
	const tail = SUMMARY_TAIL.exec(lines[lines.length - 1] as string);
	const taskLines = lines.slice(1, tail === null ? undefined : -1);
	const hiddenByTail = tail === null ? 0 : Number(tail[1]);
	const total = taskLines.length + hiddenByTail;
	const visible = taskLines.slice(0, Math.max(0, budget - 2));
	return [headline, ...visible, `  … +${total - visible.length} more`];
}

/**
 * The headline, then one line per finished task (sorted by id, numeric suffix included), capped at
 * eight plus a `… +N more` tail. Every line fits `opts.width` when it is positive, and none carries
 * a tab.
 */
export function drainSummaryLines(s: DrainSummary, opts: { width: number }): string[] {
	const width = opts.width;
	const lines = [fitLine(drainSummaryTitle(s), width)];
	const ordered = [...s.tasks].sort((a, b) => compareTaskIds(a.id, b.id));
	for (const task of ordered.slice(0, MAX_SUMMARY_TASKS)) lines.push(drainTaskLine(task, width));
	if (ordered.length > MAX_SUMMARY_TASKS) lines.push(fitLine(`  … +${ordered.length - MAX_SUMMARY_TASKS} more`, width));
	return lines;
}
