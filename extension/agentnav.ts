/**
 * Pure selection model for the agent list: which entries exist, where the cursor is, which one is
 * the current target, and how one line per entry reads.
 *
 * Host-free by construction - no `ctx`, no terminal, and the colour gate arrives as a plain boolean -
 * so the arrow-key/Enter wiring can be written against a stable, testable API. The row text itself
 * belongs to `agentinfo`, which owns the fields, the placeholders and the narrowing rules; this
 * module only decides the entry order, the marker column and the paint.
 */
import { renderAgentInfoRows, sortAgentInfo } from "./agentinfo";
import type { AgentInfo } from "./agentinfo";
import { assignAgentColors, fitColored, paint, sanitizeField, statusColor } from "./color";

/** The id the main session always carries, whatever the roster calls it. */
export const MAIN_ID = "main";

/** One selectable line: the main session, or one live agent. */
export interface NavEntry {
	id: string;
	isMain: boolean;
	info?: AgentInfo;
}

/** Main has no `AgentInfo` of its own, so its row reads a synthetic label. */
const MAIN_LABEL = "main session · this terminal";

/**
 * Main FIRST, then the live agents in the existing order. Never drops main and never lists it
 * twice: an agent whose id IS the main id is folded into entry 0 (its facts are kept on that entry,
 * its line is not), and the remaining order is exactly the incoming order - the caller already
 * sorted, and a second sort here would fight it.
 */
export function navEntries(agents: readonly AgentInfo[], main: { id?: string } = {}): NavEntry[] {
	const id = main.id === undefined || main.id === "" ? MAIN_ID : main.id;
	const entries: NavEntry[] = [{ id, isMain: true }];
	for (const info of agents) {
		if (info.id === id) {
			entries[0].info = info;
			continue;
		}
		entries.push({ id: info.id, isMain: false, info });
	}
	return entries;
}

/**
 * Where the cursor lands after `delta` steps: wraps in both directions, clamps the incoming index
 * into range first (a `NaN`, a negative or a fractional index moves from the nearest valid row), and
 * answers `0` for an empty list, where there is nothing to select. A single entry always stays `0`.
 */
export function moveSelection(index: number, delta: number, count: number): number {
	const size = Number.isFinite(count) ? Math.floor(count) : 0;
	if (size <= 0) return 0;
	const start = Number.isFinite(index) ? Math.min(size - 1, Math.max(0, Math.trunc(index))) : 0;
	const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
	return ((start + step) % size + size) % size;
}

/**
 * The three-column marker: selected `>` in column 1, current target `*` in column 2, then the
 * separator. ASCII only - the widget measures and the host wraps these bytes verbatim.
 */
export function markerFor(selected: boolean, isCurrentTarget: boolean): string {
	return (selected ? ">" : " ") + (isCurrentTarget ? "*" : " ") + " ";
}

/**
 * One line per entry, in entry order, clipped to `width` VISIBLE columns: the marker, then the row
 * text. The two markers are independent - the cursor (`selectedIndex`) and the current target
 * (`currentTargetId`) can sit on different lines - and a line wider than the budget loses text, not
 * columns the host would wrap under itself.
 *
 * Colour: `color` off emits ZERO escape bytes. On, each entry's marker carries the same identity
 * colour `agentinfo` paints that row's name with (an entry with no facts takes the neutral grey), the
 * row keeps `agentinfo`'s own painting, and the SELECTED line becomes one bold run in the marker's
 * colour - a selected line is never nested, because an inner reset would end the bold run at the
 * first token. Painting only wraps text, so a coloured line measures exactly like its plain twin.
 */
export function renderNavLines(
	entries: readonly NavEntry[],
	opts: { selectedIndex: number; currentTargetId: string; width: number; color?: boolean; now?: number },
): string[] {
	const now = opts.now !== undefined && Number.isFinite(opts.now) ? opts.now : Date.now();
	const budget = opts.width !== undefined && Number.isFinite(opts.width) ? Math.max(0, Math.floor(opts.width)) : 0;
	const selectedIndex = moveSelection(opts.selectedIndex, 0, entries.length);
	const color = opts.color === true;
	// The marker's tint must be the colour `agentinfo` paints this row's NAME with, or the two would
	// disagree: agentinfo deals its palette over the roster it is handed, so the map is built from
	// exactly the ids it receives - entries that carry facts. A row without facts (main) has no
	// identity colour and takes the neutral one, which no palette slot can collide with.
	const ids = entries.flatMap((entry) => (entry.info === undefined ? [] : [entry.id]));
	const colors = color ? assignAgentColors([...new Set(ids)].sort()) : undefined;
	const neutral = statusColor("");
	// The cursor column is 3 cells wide (or narrower only when the whole budget is), so every row
	// gets the same text budget.
	const cursorRoom = Math.min(3, budget);
	const room = budget - cursorRoom;
	const rows = room > 0 ? rowsByEntry(entries, room, now, color) : undefined;
	return entries.map((entry, index) => {
		const selected = index === selectedIndex;
		const marker = fitColored(markerFor(selected, entry.id === opts.currentTargetId), budget);
		const fallback = fitColored(sanitizeField(entry.isMain ? MAIN_LABEL : entry.id), room);
		// A selected line is wrapped in ONE bold run, so it uses the plain body: a body that already
		// carries its own escapes would end that run at its first inner reset.
		const line = (rows?.get(entry) ?? [fallback, fallback]).at(color && !selected ? 1 : 0) ?? "";
		if (!color) return marker + line;
		const tint = colors?.get(entry.id) ?? neutral;
		return selected
			? paint(marker + line, tint, { enabled: true, bold: true })
			: paint(marker, tint, { enabled: true }) + line;
	});
}

/**
 * One row per entry that carries facts, keyed by the entry object itself, as `[plain, painted]`.
 *
 * The whole roster is rendered in ONE call per variant, never one call per row: `agentinfo` deals
 * its palette over the roster it is given, so a single-row call would hand every agent slot 0 and
 * paint every name the same colour - the identity colour would be lost. `sortAgentInfo` is what
 * `renderAgentInfoRows` sorts by, so the same input gives the same order in both calls and the
 * line for an entry can be picked by its own object.
 */
function rowsByEntry(entries: readonly NavEntry[], width: number, now: number, color: boolean): Map<NavEntry, string[]> {
	const infos = entries.flatMap((entry) => (entry.info === undefined ? [] : [entry.info]));
	const order = sortAgentInfo(infos);
	const plain = renderAgentInfoRows(infos, { width, now, color: false });
	const painted = color ? renderAgentInfoRows(infos, { width, now, color: true }) : plain;
	const rows = new Map<NavEntry, string[]>();
	for (const entry of entries) {
		if (entry.info === undefined) continue;
		const at = order.indexOf(entry.info);
		rows.set(entry, [plain[at] ?? "", painted[at] ?? ""]);
	}
	return rows;
}
