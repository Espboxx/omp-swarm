/**
 * Stranded rows: ready work nobody can claim, reported to the BOARD with its age and its remedy.
 *
 * `findStarvation` (./starvation) already decides WHICH rows are unroutable and the controller
 * already notices them once per distinct condition. What it does not do — and what cost this pool
 * two hours of silently idle agents on task-221/222/223 — is leave a record anybody can read after
 * the fact: the notice goes to the main session's transcript, the event goes to `events`, and
 * neither survives as a durable, queryable artefact that answers "how long has this been stuck,
 * what is missing, and what should I do about it".
 *
 * This module is that record. It is PURE: the caller hands it the stranded report the controller
 * already computed plus a store, and it posts ONE board entry per distinct stranded condition,
 * carrying for every row its id, its missing capability, its AGE, and the repair paths ranked by
 * what each one costs. Age matters because a row stuck for 137 minutes and a row stuck for 4
 * seconds are the same shape and very different problems.
 *
 * Two properties the pool's history demands, both deliberate:
 *
 * 1. ONE ENTRY PER CONDITION, NOT PER TICK. The controller ticks every 2s. The key is the
 *    stranded report's own stable identity (row ids + missing caps), so a repeating condition
 *    posts once and a CHANGED condition (a row stranded, a row rescued, a capability added) posts
 *    again. The caller passes the id of the entry it already posted for this key, and this module
 *    returns it so the caller can hold it across ticks without re-reading the board.
 * 2. THE REPAIR ADVICE IS RANKED AND EXPLICIT, including the one path that is NOT ours. Adding a
 *    role is an operator decision; the entry says so and shows the config snippet, because the
 *    alternative (an agent quietly relabelling rows) is the overreach DECISION #1076 recorded.
 */
import type { BlackboardEntry } from "./types";
import type { StarvationReport } from "./starvation";

/** One row's age in minutes, floored, so a 137-minute strand reads as 137 and not as "0 hours". */
function ageMinutes(createdAt: number, now: number): number {
	return Math.max(0, Math.floor((now - createdAt) / 60_000));
}

/** How long a row has been stranded, phrased so it reads correctly at every scale. */
function ageLabel(minutes: number): string {
	if (minutes < 1) return "under a minute";
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export interface StrandedRowRecord {
	id: string;
	title: string;
	/** The capabilities no online agent holds. */
	missing: string[];
	/** Every capability the row declares, for the "needs A + B on ONE agent" case. */
	requiredCapabilities: string[];
	/** Milliseconds since the row was created — the number the notice has always lacked. */
	ageMinutes: number;
	why: string;
}

export interface StrandedNotice {
	/** The stranded report's own stable key, carried through so the caller can dedupe by it. */
	key: string;
	rows: StrandedRowRecord[];
	missing: string[];
	online: number;
	/** The oldest strand in this condition, in minutes: the number an operator sorts by. */
	oldestMinutes: number;
	/** The board entry to post, or `undefined` when this condition was already reported. */
	entry?: { type: "OBSERVATION"; content: string; tags: string[] };
}

/**
 * The notice for a stranded condition, or `undefined` when it was already posted under this key.
 *
 * `alreadyPostedKey` is the key of the entry the caller last posted: the same condition is silent,
 * a different one reports. That keeps a 2s tick from writing the board forever while still letting
 * every CHANGE in the stranded set reach the board — the same latching the under-budget notice uses.
 */
export function strandedNotice(
	report: StarvationReport,
	agesById: Map<string, { createdAt: number; title: string }>,
	now: number,
	alreadyPostedKey: string | undefined,
): StrandedNotice | undefined {
	if (report === undefined) return undefined;
	if (alreadyPostedKey === report.key) return undefined;

	const rows: StrandedRowRecord[] = report.rows.map((row) => {
		const known = agesById.get(row.id);
		const minutes = known === undefined ? 0 : ageMinutes(known.createdAt, now);
		return {
			id: row.id,
			title: known?.title ?? "",
			missing: [...row.missing],
			requiredCapabilities: [...row.requiredCapabilities],
			ageMinutes: minutes,
			why: row.why,
		};
	});
	const oldestMinutes = rows.reduce((max, row) => Math.max(max, row.ageMinutes), 0);
	const lines = rows
		.slice()
		.sort((a, b) => b.ageMinutes - a.ageMinutes || a.id.localeCompare(b.id))
		.map((row) => {
			const name = row.title === "" ? "" : ` — ${row.title.slice(0, 72)}`;
			return `- ${row.id} (stranded ${ageLabel(row.ageMinutes)}) missing ${row.missing.length > 0 ? row.missing.join(", ") : "no single online agent holds its full set"}: ${row.why}${name}`;
		})
		.join("\n");

	const remedies = [
		"1. RE-FILE the row(s) with a capability the pool holds (e.g. `general`). Legitimate when the work does not truly need the rare capability — this is the cheapest path and it needs no one's permission but the file-owner's.",
		"2. ADD the capability to the roster: `.swarm/config.json` `roles` (e.g. `{\"name\":\"reviewer\",\"count\":1,\"capabilities\":[\"reviewer\",\"general\"]}`). Explicitly the OPERATOR's decision, not an agent's: the pool does not edit this file (DECISION #1076), and a restart is required because the config is read once at start (index.ts's Runtime cache).",
		"3. REPAIR the existing row's capability label through the audited repair operation (task-244) once it exists — never by a direct database write.",
	];
	const content = [
		`STRANDED WORK: ${rows.length} ready row(s) that no online agent can claim (oldest ${ageLabel(oldestMinutes)}, ${report.online} agent(s) online).`,
		"",
		lines,
		"",
		"Repair paths, cheapest first:",
		...remedies,
		"",
		`Capabilities missing across all rows: ${report.missing.length > 0 ? report.missing.join(", ") : "none individually — the strand is a combination no single agent holds"}.`,
	].join("\n");

	return {
		key: report.key,
		rows,
		missing: report.missing,
		online: report.online,
		oldestMinutes,
		entry: { type: "OBSERVATION", content, tags: ["stranded", "capability-gate", "needs-repair"] },
	};
}

/**
 * Post a stranded notice as a board entry, or return `undefined` when there is nothing to say.
 *
 * The store seam is injected (not imported) so the module stays pure and testable: the caller
 * passes `store.postBoard` verbatim — its parameter type and its return type are this interface's
 * two halves, so no adapter is needed at the call site.
 */
export interface StrandedBoardPost {
	type: "OBSERVATION";
	agentId: string;
	content: string;
	tags: string[];
}

export interface StrandedPostOutcome {
	/** The entry the store produced, so a caller can hold it across ticks and dedupe by id too. */
	entry: BlackboardEntry;
	notice: StrandedNotice;
}

export function postStrandedNotice(
	report: StarvationReport | undefined,
	agesById: Map<string, { createdAt: number; title: string }>,
	now: number,
	alreadyPostedKey: string | undefined,
	post: (entry: StrandedBoardPost) => BlackboardEntry,
	agentId: string,
): StrandedPostOutcome | undefined {
	const notice = report === undefined ? undefined : strandedNotice(report, agesById, now, alreadyPostedKey);
	if (notice === undefined || notice.entry === undefined) return undefined;
	const entry = post({ type: notice.entry.type, agentId, content: notice.entry.content, tags: notice.entry.tags });
	return { entry, notice };
}
