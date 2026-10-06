/**
 * Pure, host-free color primitives for the swarm widget.
 *
 * Nothing here touches `process`, the terminal, or the host: the environment and the TTY answer
 * are passed IN, so the whole module is deterministic and unit-testable. Every function either
 * emits a self-contained SGR run (prefix + reset, never a dangling escape) or returns its input
 * byte-identically, so a caller that decides color is off gets exactly the plain text the widget
 * shipped before.
 *
 * Two rules keep a row inside the widget. (1) Width is measured with the primitive the host
 * itself wraps with - `Bun.stringWidth` under the host's own options, three cells per tab - so a
 * row this module calls "fits" is a row the host will not wrap under itself. A hand-rolled width
 * table drifts on CJK, emoji and zero-width joiners, and the wrapped row then paints over the
 * composer (the defect that got the previous panel reverted by the commit whose subject is
 * `rollback: remove the agent-list panel (operator decision)`). (2) Every row
 * field goes through `sanitizeField`, so a task title cannot smuggle a clear-screen, an OSC 52
 * clipboard write or a hyperlink into the terminal: the widget path writes these bytes verbatim.
 */

/** The six states an agent row can carry; mirrors `AgentStatus` in `./types`. */
export type AgentStatus = "working" | "reviewing" | "waiting" | "blocked" | "idle" | "offline";

/** A closed SGR run: reset every attribute the module can set. */
const RESET = "\x1b[0m";

/**
 * The host's own measurement rule (`pi-tui/src/utils.ts`): `Bun.stringWidth` with ANSI counted
 * as zero and ambiguous-width East Asian characters as narrow, plus three cells for every tab
 * (`DEFAULT_TAB_WIDTH`, after `replaceTabs`). Measuring anything wider than the host does is what
 * lets a row wrap under itself, so this module uses exactly this rule and nothing else.
 */
const STRING_WIDTH = { countAnsiEscapeCodes: false, ambiguousIsNarrow: true } as const;
const TAB_WIDTH = 3;

/** Grapheme clusters: one emoji is one unit, so a clip can never cut a joiner sequence apart. */
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Escape sequences this module can meet: all of them occupy zero columns. */
const OSC = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/;
const STRING_ESCAPE = /^\x1b[PX^_][^\x1b]*(?:\x1b\\)?/;
const CSI = /^\x1b\[[0-9;?]*[ -/]*[@-~]/;
const SHORT_ESCAPE = /^\x1b[@-Z\\-_]/;

/** `\x1b]66;<meta>;<payload>` - Kitty's text-sizing span, which `Bun.stringWidth` strips to zero. */
const OSC66_SPAN = /\x1b\]66;([^;]*);([\s\S]*?)(?:\x07|\x1b\\)/g;
const OSC66_PREFIX = "\x1b]66;";

/** `\x1b_<payload>` - an APC span, zero cells wide but printable to `Bun.stringWidth`. */
const APC_SPAN = /\x1b_[\s\S]*?(?:\x07|\x1b\\)/g;
const APC_PREFIX = "\x1b_";

/**
 * Plain text for one row field: every escape sequence, every C0/C1 control character and every
 * unpaired surrogate is dropped, so a task title, an agent id or a branch name cannot carry a
 * terminal command into the widget, nor half an emoji the host's native wrap would draw wider than
 * this module measures. Everything printable - CJK, emoji, combining marks - is left alone, and a
 * field with nothing to strip is returned unchanged.
 */
export function sanitizeField(text: string): string {
	let out = "";
	let index = 0;
	while (index < text.length) {
		const code = text.codePointAt(index) ?? 0;
		if (code === 0x1b) {
			const escape = escapeAt(text, index);
			index += escape?.length ?? 1;
			continue;
		}
		// A code point in the surrogate range is an unpaired half by construction: pairs read above.
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff)) {
			index += 1;
			continue;
		}
		out += String.fromCodePoint(code);
		index += code > 0xffff ? 2 : 1;
	}
	return out;
}

/**
 * Per-agent palette - 8 slots, chosen for legibility on a DARK background and kept clear of the
 * status indices below (no cyan, no grey, and only `215`/`209`-free hues in the red/orange band).
 * 256-color cube values: 39 blue, 213 pink, 141 violet, 105 periwinkle, 84 mint, 227 lime,
 * 215 orange, 222 gold.
 */
const PALETTE: readonly number[] = [39, 213, 141, 105, 84, 227, 215, 222];

/**
 * The one neutral fallback: `idle`/`offline` read it, and so does an unknown status. It is the
 * "no signal" grey rather than a semantic color, so an unrecognised state cannot masquerade as
 * `working`.
 */
const NEUTRAL = 245;

/**
 * One semantically chosen color per status (256-color cube indices). All six are distinct:
 * `working` 40 green, `reviewing` 45 cyan, `waiting` 220 yellow, `blocked` 203 red,
 * `idle` 245 grey, `offline` 240 dark grey. The wiring task may reuse these indices verbatim.
 */
const STATUS: Record<AgentStatus, number> = {
	working: 40,
	reviewing: 45,
	waiting: 220,
	blocked: 203,
	idle: NEUTRAL,
	offline: 240,
};

/**
 * True only when color is safe to emit: an interactive TTY, `NO_COLOR` absent (or empty - a
 * present, non-empty value is the [no-color](https://no-color.org) spec's "off"), and
 * `FORCE_COLOR` not explicitly `"0"`. Piping to a file or a `NO_COLOR=1 omp` run therefore stays
 * byte-identical plain text.
 */
export function colorEnabled(env: Record<string, string | undefined>, isTTY: boolean): boolean {
	if (!isTTY) return false;
	const noColor = env.NO_COLOR;
	if (noColor !== undefined && noColor !== "") return false;
	if (env.FORCE_COLOR === "0") return false;
	return true;
}

/** The deterministic 8-slot agent palette (do not mutate: it is the shared, frozen table). */
export function agentPalette(): readonly number[] {
	return PALETTE;
}

/**
 * Distinct color per agent within ONE LIVE ROSTER: ids are walked in the order given and dealt
 * palette slots in turn, so no two agents of the same roster share a slot until the palette runs
 * out (then it wraps to slot 0). A repeated id keeps its first slot instead of consuming another
 * one. Deterministic and position-dependent by design - a plain hash of the name can hand two
 * simultaneously-live agents the same color, which is exactly what the operator asked to avoid.
 */
export function assignAgentColors(ids: readonly string[]): Map<string, number> {
	const assigned = new Map<string, number>();
	let slot = 0;
	for (const id of ids) {
		if (assigned.has(id)) continue;
		assigned.set(id, PALETTE[slot % PALETTE.length]);
		slot += 1;
	}
	return assigned;
}

/** The fixed color for a status; an unknown status reads the neutral grey instead of throwing. */
export function statusColor(status: string): number {
	return STATUS[status as AgentStatus] ?? NEUTRAL;
}

/**
 * Wrap `text` in its color's SGR plus a trailing reset. `enabled` must be literally `true` to
 * paint - anything else (undefined included) returns the input unchanged, so a caller that never
 * resolved the gate cannot leak an escape. A non-finite index degrades to the neutral grey and a
 * finite one is clamped into 0..255, so neither `NaN` nor `Infinity` can reach the string. Empty
 * text paints to empty (no pointless escape run).
 */
export function paint(text: string, color: number, opts?: { bold?: boolean; enabled?: boolean }): string {
	if (opts?.enabled !== true || text === "") return text;
	const index = Number.isFinite(color) ? Math.min(255, Math.max(0, Math.round(color))) : NEUTRAL;
	return `\x1b[38;5;${index}m${opts.bold === true ? "\x1b[1m" : ""}${text}${RESET}`;
}

/**
 * Display columns of `text`: the host's own measurement rule, so `visibleWidth(line) <= width` is
 * the claim the terminal will make (the host adds only its own two-column padding on top).
 * `Bun.stringWidth` does the UAX#11 work and strips escapes; the host adds two corrections it
 * omits - three cells per tab, and the cells an OSC 66 text-sizing span declares - and deletes APC
 * spans before measuring, because Bun counts their payload as printable. Missing any of those is
 * what let `fitColored` return a clip the host measured wider than the budget.
 *
 * NOT mirrored, deliberately: the host's Hangul Compatibility Jamo correction (U+3131..U+318E),
 * which depends on a host runtime setting and on `process.platform`. It can only make the host's
 * measure SMALLER than this one, so a clip taken with this measure stays conservative - it may
 * shorten a row carrying Compatibility Jamo by a cell or two, but it cannot overflow.
 */
export function visibleWidth(text: string): number {
	// The host removes APC spans before measuring: Bun's scanner counts their payload as printable
	// (and can swallow following visible text into the span), while the terminal draws them as none.
	const measurable = text.includes(APC_PREFIX) ? text.replace(APC_SPAN, "") : text;
	let width = Bun.stringWidth(measurable, STRING_WIDTH);
	for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 0x09) width += TAB_WIDTH;
	if (text.includes(OSC66_PREFIX)) width += osc66Width(text);
	return width;
}

/**
 * The cells every OSC 66 span in `text` occupies under the host's rule: its payload's own width
 * scaled by `s=` (1..7; outside that range the scale stays 1), or its declared `w=` width when it
 * carries one. Mirrors `pi-tui/src/utils.ts` so this module's measure IS the host's - without it a
 * span is zero cells here and three or five there, and the line wraps under itself.
 */
function osc66Width(text: string): number {
	let width = 0;
	OSC66_SPAN.lastIndex = 0;
	for (let match = OSC66_SPAN.exec(text); match !== null; match = OSC66_SPAN.exec(text)) {
		let scale = 1;
		let explicit: number | undefined;
		for (const part of match[1].split(":")) {
			if (part.indexOf("=") !== 1) continue;
			const value = Number.parseInt(part.slice(2), 10);
			if (!Number.isFinite(value)) continue;
			if (part[0] === "s") {
				if (value >= 1 && value <= 7) scale = value;
			} else if (part[0] === "w" && value > 0) {
				explicit = value;
			}
		}
		width += scale * (explicit ?? Bun.stringWidth(match[2], STRING_WIDTH));
	}
	return width;
}

/**
 * Clip to `width` VISIBLE columns, copying escapes through untouched and closing the run if the
 * clip landed inside a color. Whole clusters are kept or dropped, so a clip never splits an emoji
 * or a combining mark, and the cut is decided by the same measurement the host wraps with. A
 * string that already fits is returned byte-identically; an empty string stays empty; `width <= 0`
 * yields "". No ellipsis - callers add their own if they want one.
 *
 * A copied escape token counts zero columns here, which is right for the SGR this module emits but
 * under-counts an OSC 66 span; the self-check below re-measures the result with the host's rule and
 * hands such a case to the exact prefix search, so the walk needs no span arithmetic of its own.
 */
export function fitColored(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	let out = "";
	let used = 0;
	let index = 0;
	while (index < text.length) {
		const escape = escapeAt(text, index);
		if (escape !== undefined) {
			out += escape;
			index += escape.length;
			continue;
		}
		const cluster = nextCluster(text, index);
		const columns = cluster === "\t" ? TAB_WIDTH : Bun.stringWidth(cluster, STRING_WIDTH);
		if (used + columns > width) break;
		out += cluster;
		used += columns;
		index += cluster.length;
	}
	// An unterminated escape can swallow visible text into a run this walk treats as zero-width, so
	// the walk can be overconfident; when it is, fall back to the exact prefix search, which measures
	// every candidate with the same rule the host wraps by.
	if (visibleWidth(out) > width) out = longestFittingPrefix(text, width);
	// The clip may have stopped inside a color; close it so the next line cannot inherit it.
	return out.includes("\x1b") && !out.endsWith(RESET) ? `${out}${RESET}` : out;
}

/**
 * The longest prefix of `text` the host's own measure accepts, cutting only between tokens. Used
 * when the cluster walk disagrees with the whole-string measure (malformed escapes); escape payloads
 * make that measure non-monotone, so the binary search is followed by a step-back loop that ends on
 * a prefix which truly fits - the empty string if nothing does.
 */
function longestFittingPrefix(text: string, width: number): string {
	const tokens = inlineTokens(text);
	let low = 0;
	let high = tokens.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (visibleWidth(tokens.slice(0, mid).join("")) <= width) low = mid;
		else high = mid - 1;
	}
	let out = tokens.slice(0, low).join("");
	while (low > 0 && visibleWidth(out) > width) {
		low -= 1;
		out = tokens.slice(0, low).join("");
	}
	return out;
}

/** `text` split into whole escapes and the grapheme clusters between them. */
function inlineTokens(text: string): string[] {
	const tokens: string[] = [];
	let index = 0;
	while (index < text.length) {
		const escape = escapeAt(text, index);
		if (escape !== undefined) {
			tokens.push(escape);
			index += escape.length;
			continue;
		}
		const cluster = nextCluster(text, index);
		tokens.push(cluster);
		index += cluster.length;
	}
	return tokens;
}

/** The escape sequence starting at `at`; undefined when that ESC opens none this module knows. */
function escapeAt(text: string, at: number): string | undefined {
	if (text.charCodeAt(at) !== 0x1b) return undefined;
	const rest = text.slice(at);
	for (const pattern of [OSC, STRING_ESCAPE, CSI, SHORT_ESCAPE]) {
		const match = pattern.exec(rest);
		if (match !== null) return match[0];
	}
	return undefined;
}

/** The next grapheme cluster from `at`; escapes are never part of one. */
function nextCluster(text: string, at: number): string {
	const nextEscape = text.indexOf("\x1b", at);
	const run = nextEscape === -1 ? text.slice(at) : text.slice(at, nextEscape);
	const first = SEGMENTER.segment(run)[Symbol.iterator]().next();
	return first.done === true ? text[at] : first.value.segment;
}
