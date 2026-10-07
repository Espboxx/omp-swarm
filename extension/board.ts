/**
 * goal-15's R1: the pool has NO fingerprint memory, so the same condition is re-reported every tick.
 *
 * WHAT THIS FILE IS FOR. Two notices in this session prove the shape of the defect:
 *
 *   - `stranded.ts` laches on `report.key` — the sorted `(row id, missing caps)` pairs — which is
 *     the RIGHT identity, but it lives in the CALLER's memory: offline → online → offline regenerates
 *     the same key from a fresh direction and posts the batch again (the "13 ready task(s)" alert
 *     the operator saw three times).
 *   - `board_search` is a `LIKE` filter over content and tags. An agent asking "has this failure
 *     class already been posted" gets back every entry that MENTIONS a keyword, not the answer, so
 *     the same failure class is re-reported a third time (R6: the coordinator re-diagnosed the
 *     reviewer capability knot in four separate goals).
 *
 * This module is the DURABLE half of that memory, and it is pure: no db, no clock, no I/O. It answers
 * two questions a caller can unit-test and wire anywhere:
 *
 *   1. `boardClassKey` — the identity of WHAT an entry says, independent of who wrote it and when:
 *      the sorted class-bearing TAG set. Two entries about the same failure class share a key; two
 *      entries that merely share a keyword do not.
 *   2. `boardClasses` / `repeatedBoardClasses` / `boardDuplicateVerdict` — the index: which classes
 *      the board already carries, with the count of every prior entry, and the answer to "already
 *      reported? already remedied?" for one new entry.
 *
 * WHY A CLASS KEY IS NOT A HASH OF THE WHOLE ENTRY. The task-58/task-59/task-60 cycle posted
 * "SUPERSEDED / DUPLICATE — Same deliverable as canonical task-150" four times with different lead
 * phrasings and different row ids. A content hash is a different key for each of those and dedupes
 * none of them. A TAG-set key is the same key for all four, which is the whole point: a repeat of a
 * class must be recognisable from the class, not from the wording.
 *
 * WHAT THIS DELIBERATELY IS NOT. It is not a gate. Nothing here refuses a post, refuses a claim or
 * mints a row. It is the index that lets a CALLER refuse ("this class is already open, do not
 * re-report"), and the caller decides what refusing means — exactly the division `guard.ts` uses
 * ("It is a REMINDER, never a gate").
 */

/**
 * The tags that say what an entry IS — its TYPE or its OUTCOME — rather than what it is ABOUT, so
 * they never identify a class. Measured over this session's own board (1561 rows): `vote_failed`
 * (6 entries → 1 bare class) and `approved` (50 entries → 6 bare classes) are pure outcome labels,
 * and keying on them would collapse six genuinely different failed votes into ONE class, which is
 * the false positive this module exists to avoid.
 */
const META_TAGS: Record<string, true> = {
	fail: true,
	failure: true,
	decision: true,
	fact: true,
	result: true,
	observation: true,
	claim: true,
	question: true,
	review: true,
	approved: true,
	vote_passed: true,
	vote_failed: true,
	proposal: true,
};

/**
 * A tag is class-bearing when it is neither a meta tag nor a transient one. The three filters exist
 * because the pool's own history shows what a naive key does:
 *
 *   - a `task-<id>` tag names ONE row, so a repeat across rows (task-58 vs task-59, both "same
 *     deliverable as task-150") would read as two classes and never collapse;
 *   - a bare `iteration-N` tag names a round, not a problem, so two unrelated failures of the same
 *     round would collapse into one class;
 *   - a `goal:<id>` tag is KEPT: it scopes a class to the goal that raised it, which is the level
 *     the operator's "four goals for one knot" observation is measured at.
 */
function classBearingTag(tag: string): boolean {
	if (META_TAGS[tag] === true) return false;
	if (/^task-\d+$/.test(tag)) return false;
	if (/^iteration-\d+$/.test(tag)) return false;
	return tag.length > 1;
}

/** The class key: the sorted class-bearing tags joined by `,`, or `""` when an entry names no class. */
export function boardClassKey(entry: { tags?: string[] }): string {
	return [...new Set((entry.tags ?? []).filter(classBearingTag))].sort().join(",");
}

/** One class the board already carries, with every prior entry that belongs to it. */
export interface BoardClass {
	/** The identity: sorted class-bearing tags. Empty when the entry names no class. */
	key: string;
	/** Every entry id that carries this class, oldest first — the history a reader must see. */
	entryIds: number[];
	/** How many entries the class already has (1 for the first occurrence). */
	count: number;
	/** The newest entry of the class, which is what a remedy answer reads. */
	latestId: number;
	/** The class's entries' types, newest first, so "an OBSERVATION then a DECISION" reads. */
	types: string[];
	/** Every agent that posted this class, newest first — the swarm-level "already said" check. */
	agentIds: string[];
}

/** The index: one entry per distinct class, ordered by newest entry. */
export function boardClasses(entries: ReadonlyArray<{ id: number; type: string; agentId: string; tags?: string[] }>): BoardClass[] {
	const byKey = new Map<string, BoardClass>();
	for (const entry of entries) {
		const key = boardClassKey(entry);
		if (key === "") continue;
		const known = byKey.get(key);
		if (known === undefined) {
			byKey.set(key, { key, entryIds: [entry.id], count: 1, latestId: entry.id, types: [entry.type], agentIds: [entry.agentId] });
			continue;
		}
		known.entryIds.push(entry.id);
		known.count += 1;
		known.latestId = entry.id;
		known.types.unshift(entry.type);
		if (!known.agentIds.includes(entry.agentId)) known.agentIds.unshift(entry.agentId);
	}
	return [...byKey.values()].sort((a, b) => b.latestId - a.latestId);
}

/** The classes the board carries more than once — the repeats R1 exists to make visible. */
export function repeatedBoardClasses(entries: ReadonlyArray<{ id: number; type: string; agentId: string; tags?: string[] }>): BoardClass[] {
	return boardClasses(entries).filter((entry) => entry.count > 1);
}

/** What a caller is told about one entry it is about to post. */
export interface BoardDuplicateVerdict {
	/** The class the new entry belongs to. */
	key: string;
	/** `false` when the entry names no class (no tags): there is nothing to key on. */
	known: boolean;
	/** How many entries already carry this class, the new one NOT counted. */
	priorCount: number;
	/** The ids already carrying it, oldest first. */
	priorEntryIds: number[];
	/** `true` when at least one prior entry is a DECISION — the class has been ANSWERED. */
	remedied: boolean;
	/** The one-line reason a caller can post verbatim: why this is a repeat, or why it is not. */
	reason: string;
}

/**
 * Has this failure class already been posted, and has it been answered?
 *
 * `remedied` is the DECISION test, and it is deliberately not "the newest entry is a DECISION": a
 * class can be an OBSERVATION, then a DECISION, then another OBSERVATION (a fresh sighting), and the
 * class is still remedied because the answer exists. What a caller does with that is its own policy;
 * this only reports the state.
 */
export function boardDuplicateVerdict(
	existing: ReadonlyArray<{ id: number; type: string; agentId: string; tags?: string[] }>,
	incoming: { tags?: string[] },
): BoardDuplicateVerdict {
	const key = boardClassKey(incoming);
	if (key === "") {
		return {
			key: "",
			known: false,
			priorCount: 0,
			priorEntryIds: [],
			remedied: false,
			reason: "this entry names no class-bearing tag, so it cannot be recognised as a repeat",
		};
	}
	const prior = existing.filter((entry) => boardClassKey(entry) === key);
	if (prior.length === 0) {
		return {
			key,
			known: false,
			priorCount: 0,
			priorEntryIds: [],
			remedied: false,
			reason: `class "${key}" has no prior entry — this is the first report of it`,
		};
	}
	const remedy = prior.find((entry) => entry.type === "DECISION");
	return {
		key,
		known: true,
		priorCount: prior.length,
		priorEntryIds: prior.map((entry) => entry.id),
		remedied: remedy !== undefined,
		reason:
			remedy === undefined
				? `class "${key}" is already reported ${prior.length}x (#${prior.map((entry) => entry.id).join(", #")}) and is NOT yet answered by a DECISION`
				: `class "${key}" is already reported ${prior.length}x (#${prior.map((entry) => entry.id).join(", #")}) and answered by DECISION #${remedy.id}`,
	};
}
