/**
 * goal-17's L3: the coordinator's takeover ledger.
 *
 * WHAT THIS FILE IS FOR. Every goal this pool opens starts from nothing. The board already carries
 * hundreds of FAIL/DECISION conclusions across 17 goals — 76 of 162 distinct classes already answered
 * by a DECISION at the time this was written — and a new goal's planning round reads NONE of it. The
 * operator's observation is the measured cost: 200 board entries mention the reviewer-capability
 * knot, spread over eight separate goals (goal-5, 6, 11, 12, 13, 14, 15, 16), and the knot was
 * re-diagnosed from scratch more than once because nothing handed the next coordinator what the last
 * one already knew.
 *
 * This module is the pure half of the fix, and it is pure on purpose (no db, no clock, no I/O), the
 * division `board.ts` and `failure-gate.ts` already use, so the rule can be tested without a pool.
 * It IMPORTS `boardClassKey` and `boardClasses` from `board.ts` rather than restating them: one key,
 * one reader, which is the rule goal-15's contract states and the reason this file carries no second
 * copy of the class filter. It answers four questions:
 *
 *   1. {@link goalLedger} — the conclusions a NEW goal must be handed at open: which classes the
 *      board already carries, which are already answered by a DECISION, and which are still open.
 *   2. {@link goalFingerprint} — the identity of WHAT a goal is about, built from the goal's own
 *      named artifacts and kind of work, NOT from a hash of its text (see the note below).
 *   3. {@link ledgerInjection} — the text injected into the goal's planning task, so the coordinator
 *      that opens the round and the scribe that merges it read the same conclusions.
 *   4. {@link goalDuplicateVerdict} — the answer to "has this goal already been worked?", in the
 *      shape `boardDuplicateVerdict` uses, so a caller that handles one handles the other.
 *
 * WHY A FINGERPRINT AND NOT TEXT SIMILARITY. task-252's contract and `board.ts`'s header both record
 * the same trap: a content hash is a different key per phrasing and dedupes nothing, while a keyword
 * `LIKE` collapses unrelated rows. The fingerprint therefore reads the goal's NAMED ARTIFACTS (the
 * paths and files it quotes) plus its KIND of work, and deliberately refuses to compare free prose.
 *
 * MEASURED ON THE 17 LIVE GOALS, and this is the finding rather than a defect: 0 exact-duplicate goal
 * texts, 0 pairs at >=0.6 word overlap, and 0 kind+artifact fingerprint collisions. A goal-level
 * duplicate REFUSAL would refuse nothing today, because this pool's goals are legitimately different
 * work that happens to touch the same knot — the knot's eight goals each named different artifacts.
 * So the shipped shape is what the goal's own text sanctions for exactly this case
 * ("例如只做注入不做拒绝"): the ledger INJECTS what is already known, reports the honest verdict either
 * way, and the refusal is off by default behind {@link LEDGER_REFUSE_DUPLICATES}.
 */

import { boardClassKey, boardClasses } from "./board";

/** The one class a goal's artifacts already carry, as the injection must report it. */
export interface LedgerClass {
	/** The class key, exactly `boardClassKey` spells it. */
	key: string;
	/** Every board entry id that carries this class, oldest first — the history a reader must see. */
	entryIds: number[];
	/** How many entries the class already has (1 for the first occurrence). */
	count: number;
	/** Whether a DECISION already answered this class. */
	answered: boolean;
	/** The newest entry of the class, which is what a remedy answer reads. */
	latestId: number;
}

/** One board entry as the ledger reads it: the three fields `boardClassKey` and `boardClasses` need. */
export interface LedgerEntry {
	id: number;
	type: string;
	agentId: string;
	tags?: string[];
}

/** A goal's class as the fingerprint compares it: the class plus every kind its goals named. */
export interface GoalClass extends LedgerClass {
	/** Every kind of work this class's own goals named, deduped — what a new goal would repeat. */
	kinds: GoalKind[];
}

/** What a new goal is handed at open: the conclusions that already exist. */
export interface GoalLedger {
	/** Distinct classes among the board's conclusions, newest first. */
	classes: GoalClass[];
	/** How many conclusion rows were read to build it. */
	readRows: number;
	/** How many of those rows named no class (a content-only entry cannot be indexed). */
	unclassifiableRows: number;
	/** Classes already answered by a DECISION — the ones that must not be re-diagnosed. */
	answeredCount: number;
	/** Classes still open (a FAIL with no DECISION) — the dead ends worth naming. */
	openCount: number;
}

/**
 * Whether a goal whose class already has an answer should be REFUSED at open, or merely told.
 *
 * OFF by default, and the measurement in the header is why: 0 of 17 live goals collide under the
 * fingerprint, so a refusal gate has nothing to refuse today, and the goal's own text sanctions the
 * inject-only shape when the full version is not justified by the surface. An operator who wants the
 * gate flips it explicitly; the verdict is reported either way.
 */
export const LEDGER_REFUSE_DUPLICATES = false;

/**
 * How many conclusion rows the ledger reads by default. 500 covers this pool's own 361 rows with
 * room to grow, and the limit is a parameter so a caller with a different board is not capped.
 */
export const LEDGER_READ_LIMIT = 500;

/** The kinds of work a goal can ask for: `describeDeliverable`'s vocabulary, minus `refactor`/`remove` (a goal's text names these too rarely to key on). */
export type GoalKind = "verify" | "fix" | "document" | "diagnose" | "other";

/** The words that name each kind, English and Chinese, in the order they are read. */
const KIND_WORDS: ReadonlyArray<readonly [GoalKind, readonly string[]]> = [
	["verify", ["verify", "verification", "re-verify", "reverification", "audit", "复核", "核实", "验证"]],
	["fix", ["fix", "repair", "broken", "修", "修复", "闭环"]],
	["document", ["document", "write", "spec", "报告", "文档", "固化", "回答"]],
	["diagnose", ["diagnose", "diagnosis", "measure", "why", "诊断", "测量"]],
];

/** The kind of work a goal asks for, from the vocabulary above; `other` when it names none. */
export function goalKind(goal: string): GoalKind {
	const text = goal.toLowerCase();
	for (const [kind, words] of KIND_WORDS) {
		if (words.some((word) => text.includes(word))) return kind;
	}
	return "other";
}

/**
 * The artifacts a goal names, reduced to comparable form: backticked text, file paths with an
 * extension, and the repo-relative paths the goal quotes.
 *
 * Deliberately NOT a word list. A word list is the keyword `LIKE` that collapses unrelated rows: this
 * pool's own goals repeat words (9 of 17 say "token" or "burn", 5 name the reviewer knot) while doing
 * genuinely different work, which is exactly why the fingerprint has nothing to refuse them with.
 */
export function goalArtifacts(goal: string): string[] {
	const text = goal.toLowerCase();
	const found = new Set<string>();
	const add = (value: string): void => {
		// The repo-relative prefix is stripped so `omp-swarm/extension/store.ts` and
		// `extension/store.ts` are ONE artifact, not two: two spellings of one name must fold, which
		// is the reduction `planning.ts`'s own `canonicalArtifact` applies and this module reuses.
		const trimmed = value.trim().replace(/^omp-swarm\//, "").replace(/\/+$/, "");
		if (trimmed.length > 0 && trimmed.length <= 120) found.add(trimmed);
	};
	for (const match of text.matchAll(/`([^`]+)`/g)) add(match[1] ?? "");
	for (const match of text.matchAll(/[\w./-]+\.(?:md|ts|tsx|json|yml|yaml|db)\b/g)) add(match[0] ?? "");
	for (const match of text.matchAll(/(?:extension|tests|scratch|omp-swarm)\/[\w./*-]+/g)) add(match[0] ?? "");
	return [...found].sort();
}

/**
 * The identity of WHAT a goal is about: its kind plus its named artifacts, joined with the unit
 * separator the contract uses (`\x1f`), so a goal naming an artifact containing the separator cannot
 * forge a boundary. Empty when the goal names no artifact — a goal with nothing to key on can never
 * be called a duplicate of another one, and the caller must not pretend otherwise.
 */
export function goalFingerprint(goal: string): string {
	const artifacts = goalArtifacts(goal);
	if (artifacts.length === 0) return "";
	return [goalKind(goal), ...artifacts].join("\x1f");
}

/**
 * The conclusions a new goal must be handed, from the board entries it is given.
 *
 * Uses `boardClasses`'s index rather than re-deriving it — one key, one reader — and adds the two
 * counts the injection needs: how many classes are already answered (so a goal does not re-diagnose a
 * settled knot) and how many are still open (so the dead ends a goal would walk into are named). The
 * kinds each class's own goals named come from the caller: the store has the goal rows, this module
 * only compares them.
 */
export function goalLedger(entries: ReadonlyArray<LedgerEntry>, kindsByGoal = new Map<string, GoalKind>(), limit = LEDGER_READ_LIMIT): GoalLedger {
	const conclusions = entries.filter((entry) => entry.type === "FAIL" || entry.type === "DECISION");
	const read = conclusions.slice(0, Math.max(0, limit));
	// `answered` is derived from `boardClasses`'s own `types` list rather than stored beside it: the
	// index is the one reader of the class, and a second answer flag would be a second opinion.
	const classes: GoalClass[] = boardClasses(read).map((entry) => ({
		key: entry.key,
		entryIds: entry.entryIds,
		count: entry.count,
		answered: entry.types.includes("DECISION"),
		latestId: entry.latestId,
		kinds: kindsOf(entry.key, kindsByGoal),
	}));
	const answered = classes.filter((entry) => entry.answered).length;
	return {
		classes,
		readRows: read.length,
		unclassifiableRows: read.filter((entry) => boardClassKey(entry) === "").length,
		answeredCount: answered,
		openCount: classes.length - answered,
	};
}

/**
 * The kinds a class's own goals named. A class carries `goal:<id>` tags (the `goalTag()` spelling the
 * pool uses) and the caller supplies the kind each of those goals asked for, so a new goal's kind can
 * be compared against the kind of the work that already produced this class. A tag that names no goal
 * contributes nothing, and a class with no kind can never be called a duplicate — an unkinded class
 * must not be the reason a new goal is refused.
 */
function kindsOf(classKey: string, kindsByGoal: ReadonlyMap<string, GoalKind>): GoalKind[] {
	if (kindsByGoal.size === 0) return [];
	const kinds = new Set<GoalKind>();
	for (const tag of classKey.split(",")) {
		// Both spellings are read: the pool writes `goal:goal-1` through `goalTag()`, and a tag that
		// names the goal row directly (`goal-1`) is the same goal. Stripping the prefix and taking the
		// remainder verbatim handles both, and never invents an id.
		const goalId = tag.startsWith("goal:") ? tag.slice("goal:".length) : tag;
		const kind = kindsByGoal.get(goalId);
		if (kind !== undefined) kinds.add(kind);
	}
	return [...kinds].sort();
}

/** The answer to "has this goal already been worked?", in the shape `boardDuplicateVerdict` uses. */
export interface GoalDuplicateVerdict {
	/** Whether this goal already has an owner among the board's answered classes. */
	duplicate: boolean;
	/** The class key that matched, or `undefined` when nothing matched. */
	key?: string;
	/** Every entry id that carries the matching class — never just a count. */
	priorEntryIds: number[];
	/** One line naming the prior class and its entries. */
	reason: string;
	/** What the caller should do instead — always present when `duplicate` is true. */
	remedy: string;
}

/**
 * Has this goal already been worked? YES only when the goal names artifacts AND one of them is
 * carried by a class the board already ANSWERED with the same kind of work — the strictest reading of
 * "open goal 按指纹去重", because a goal that merely touches a settled artifact is usually NEW work on
 * known ground (measured: 0 of 17 live goals collide even on kind+artifacts, and the knot spans eight
 * goals precisely because each was new work).
 *
 * The artifact route deliberately does not attempt to equate two spellings of one artifact
 * (`advisory-wakeups/**` vs `advisory-wake/`): that is the merge's own `sameArtifact` route, and a
 * second name-matcher here would be the second convention this module exists to avoid.
 */
export function goalDuplicateVerdict(ledger: GoalLedger, goal: string): GoalDuplicateVerdict {
	const artifacts = goalArtifacts(goal);
	if (artifacts.length === 0) {
		return {
			duplicate: false,
			priorEntryIds: [],
			reason: "this goal names no artifact, so it has no fingerprint to match on — a text comparison would be the keyword trap",
			remedy: "",
		};
	}
	const kind = goalKind(goal);
	const matches = ledger.classes.filter((entry) => entry.answered && entry.kinds.includes(kind) && entry.kinds.length > 0 && artifactsOverlap(entry, artifacts));
	if (matches.length === 0) {
		return {
			duplicate: false,
			priorEntryIds: [],
			reason: `no answered class carries the artifacts ${JSON.stringify(artifacts)} with kind "${kind}"`,
			remedy: "",
		};
	}
	const best = matches[0] as GoalClass;
	return {
		duplicate: true,
		key: best.key,
		priorEntryIds: best.entryIds,
		reason: `goal class ${JSON.stringify(best.key)} is already carried by ${best.count} board entr${best.count === 1 ? "y" : "ies"} (${best.entryIds.join(", ")}) and already answered by a DECISION`,
		remedy: "read those entries before opening this round, or extend the goal so it names work the prior round did not — re-opening the same goal re-diagnoses a settled knot",
	};
}

/**
 * Whether a class's own key overlaps the goal's artifacts. The class key is a sorted tag list, and a
 * goal's artifact can appear as a tag (`extension/store.ts`), so the comparison is a containment test
 * over the key's own tags rather than a similarity score.
 */
function artifactsOverlap(entry: GoalClass, artifacts: readonly string[]): boolean {
	const tags = new Set(entry.key.split(","));
	return artifacts.some((artifact) => tags.has(artifact));
}

/**
 * The text injected into the goal's planning task: the conclusions a new round must not re-derive.
 *
 * It is a REMINDER, never a gate, exactly as `guard.ts` frames its own notice — the scribe reads it and
 * decides. Empty when the board carries nothing to say, so a fresh pool gets an unchanged brief rather
 * than a section of zeros.
 *
 * WHY THE CLASSES ARE RANKED (goal-18's U2 measurement). The sections used to take the classes in
 * `boardClasses`'s own order — newest first — which on a live board means the newest few
 * conclusions about THIS round's planning dominate the list and the knots an older goal actually
 * raised are never shown: measured over the live pool, the injected list led with
 * `goal:goal-18,plan` (an artifact of the round being opened) while 25 of the 77 answered classes say
 * `plan`/`merge` and 18 of them `dedupe`/`duplicate` — none of which a goal about a specific source
 * file can use. So each class is scored on how many of the goal's OWN artifacts it carries (the same
 * overlap the duplicate verdict uses — one notion of "relevant", not two), and the ties are broken by
 * the class's own recency, which preserves the old ordering exactly when nothing overlaps. A goal
 * naming no artifact ranks on recency alone, so its brief is unchanged.
 */
export function ledgerInjection(ledger: GoalLedger, goal: string, verdict: GoalDuplicateVerdict): string {
	if (ledger.classes.length === 0) return "";
	const artifacts = goalArtifacts(goal);
	const lines = [
		"COORDINATOR LEDGER (goal-17 L3): the board already carries conclusions from earlier rounds. Read them before re-diagnosing anything.",
		`${ledger.readRows} conclusion row(s) read, ${ledger.classes.length} distinct class(es): ${ledger.answeredCount} already answered by a DECISION, ${ledger.openCount} still open.`,
	];
	if (verdict.duplicate) {
		lines.push("");
		lines.push(`DUPLICATE WARNING: ${verdict.reason}.`);
		lines.push(`REMEDY: ${verdict.remedy}`);
		lines.push(
			LEDGER_REFUSE_DUPLICATES
				? "The ledger is configured to REFUSE this goal (LEDGER_REFUSE_DUPLICATES); it is not opened."
				: "This is an injection, not a refusal: the goal opens either way, and this round decides what to do with it.",
		);
	}
	const answered = rankForGoal(ledger.classes.filter((entry) => entry.answered), artifacts).slice(0, 8);
	if (answered.length > 0) {
		lines.push("");
		lines.push("Already answered (read before re-deriving):");
		for (const entry of answered) {
			lines.push(`- ${entry.key} — ${entry.count} entry(ies) (${entry.entryIds.join(", ")}), newest DECISION #${entry.latestId}`);
		}
	}
	const open = rankForGoal(ledger.classes.filter((entry) => !entry.answered), artifacts).slice(0, 5);
	if (open.length > 0) {
		lines.push("");
		lines.push("Still open (dead ends earlier rounds met):");
		for (const entry of open) lines.push(`- ${entry.key} — ${entry.count} entry(ies) (${entry.entryIds.join(", ")})`);
	}
	return lines.join("\n");
}

/**
 * The classes most worth handing this goal, most-relevant first: the classes carrying the most of the
 * goal's own artifacts, then the newest. A class carrying none of them all scores 0, so the order
 * degrades to the index's own newest-first order byte for byte — a goal naming no artifact therefore
 * gets exactly the brief it got before this ranking existed.
 *
 * Sorting a copy rather than the ledger's own array: `goalLedger`'s output is shared with the verdict
 * and with `createGoal`'s event counts, and a reordered list would make them read a different order.
 */
function rankForGoal(classes: readonly GoalClass[], artifacts: readonly string[]): GoalClass[] {
	if (artifacts.length === 0) return [...classes];
	const wanted = new Set(artifacts);
	return [...classes]
		.map((entry, at) => ({ entry, at, score: entry.key.split(",").filter((tag) => wanted.has(tag)).length }))
		.sort((a, b) => b.score - a.score || a.at - b.at)
		.map((row) => row.entry);
}
