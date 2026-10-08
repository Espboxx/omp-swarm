/**
 * goal-17's L2: the identity key task-252 specifies, as one module.
 *
 * WHAT THIS FILE IS FOR. The pool recognises a duplicate row three ways, and each way is a DIFFERENT
 * function living in a DIFFERENT file: the file spelling in `tasksSharingFiles` (store.ts), the shape
 * in `poolSkipReason` (planning.ts), the tag set in `boardClassKey` (board.ts). None of them is the
 * key the operator's observation needs, and no gate anywhere asks the question "have I seen THIS work
 * before?" — which is why `SUPERSEDED / DUPLICATE — closed unexecuted` rows exist at all: the mint
 * path never refused one, because it never had a key.
 *
 * This module is that key, and it is PURE on purpose (no db, no clock, no I/O) so the rule and its
 * wiring can be tested apart, the same division `driver.ts`'s `alertGate`, `board.ts`'s
 * `boardClassKey` and `failure-gate.ts`'s `retryGate` use:
 *
 *   key = kind + "\x1f" + deliverableKey(title) + "\x1f" + sortedCanonicalFiles + "\x1f" + sortedCaps
 *
 * Every normalisation is copied from the function that already owns it — `describeDeliverable` for the
 * kind, `deliverableKey` for the deliverable, `canonicalArtifact` for the files. The key invents
 * nothing, and the ONE component that makes or breaks it is measured, not argued: over the live pool,
 * dropping the `deliverable` component collapses ~40 % of the rows into 16 false-merge groups
 * (task-252 measured 85-of-213, task-269 measured 110-of-227, this tree measures 89-of-229), while the
 * key with it merges nothing. So the deliverable stays, NORMALISED — never the raw title, because two
 * spellings of one deliverable must fold.
 *
 * WHY A READABLE JOINED STRING AND NOT sha256. The goal forbids new dependencies; Bun does ship
 * `Bun.CryptoHasher` natively, but (a) the store holds no hash anywhere, so a digest would be the
 * second key-shape in one file, and (b) the key's only job is refusal-fingerprinting, and the contract
 * requires every refusal to NAME its prior row and the route that fired — a digest prints as noise.
 * The join character is `\x1f` so no component can forge a boundary, the same discipline
 * `alertFingerprint`'s escaped-`|` join uses for the same reason.
 */

import { describeDeliverable, deliverableKey } from "./planning";

/** The join character: a unit separator, so no path, title or capability can forge a boundary. */
const FIELD_SEPARATOR = "\x1f";

/** The identity key of one deliverable, and the parts a refusal can quote. */
export interface IdentityKey {
	/** The key itself: a readable joined string, stable across processes. */
	key: string;
	/** The kind of work (`describeDeliverable`'s intent), which is what keeps a `fix` and a `verify` apart. */
	kind: string;
	/** The normalised deliverable (`deliverableKey` of the title). */
	deliverable: string;
	/** The canonical files, sorted as a set. */
	files: string[];
	/** The required capabilities, sorted and deduped. */
	caps: string[];
}

/**
 * The identity key of a deliverable. Two rows are the SAME work when their keys match, and nothing
 * else decides that: the kind is in the key (so a `fix` and a `verify` on one file are two keys), the
 * caps are in it (so a re-file that only reaches a reachable capability is a FRESH key by
 * construction — the strand's remedy can never be refused), and the files are canonicalised as a set
 * (so `x/**` and `x` and `X/` are one spelling).
 */
export function identityKeyOf(title: string, files: string[] = [], caps: string[] = []): IdentityKey {
	const shape = describeDeliverable(title, files, "");
	const canonicalFiles = [...new Set(files.map(normalizeArtifactPath).filter((path) => path !== ""))].sort();
	const canonicalCaps = [...new Set(caps.map((cap) => cap.trim()).filter((cap) => cap !== ""))].sort();
	const deliverable = deliverableKey(title);
	const key = [shape.intent, deliverable, canonicalFiles.join("|"), canonicalCaps.join(",")].join(FIELD_SEPARATOR);
	return { key, kind: shape.intent, deliverable, files: canonicalFiles, caps: canonicalCaps };
}

/**
 * One artifact path in the single form two rows can be compared in. Copied from `canonicalArtifact`
 * (planning.ts) rather than re-derived, so a spelling the merge already folds is folded here too.
 */
function normalizeArtifactPath(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/\\/g, "/")
		.replace(/^\.\/+/, "")
		.replace(/\/+/g, "/")
		.replace(/\/\*\*$/, "")
		.replace(/\/+$/, "");
}

/** Which route recognised a repeat. The three routes are the contract's, in the order a gate asks them. */
export type DuplicateRoute = "exact" | "spelling" | "class";

/**
 * The refusal a duplicate mint hands back, in the shape task-252 §5 specifies. Every refusal names
 * its prior row, leaves a trace, and is reversible — the three invariants a prose sentence cannot
 * carry.
 */
export interface DuplicateRefusal {
	/** Which route fired. */
	route: DuplicateRoute;
	/** The key that matched — printable, so a caller can quote it. */
	key: string;
	/** The prior row's id, its status and its age in minutes. A match against `failed` is never a refusal. */
	prior: { taskId: string; status: string; ageMinutes: number; title: string };
	/** One line naming the prior row and why this mint is refused. */
	reason: string;
	/** The exact change that makes this mint fresh — what the caller should do instead. */
	remedy: string;
}

/** One live row, as a gate needs to see it. `failed` rows are never offered: a match against one is not a refusal. */
export interface LiveRow {
	id: string;
	title: string;
	files: string[];
	caps: string[];
	status: string;
	/** `created_at`, for the age the escalation carries. */
	createdAt: number;
}

/** A mint refusal: the row that already holds this work, or `undefined` when the mint is fresh. */
export function duplicateRefusal(
	incoming: { title: string; files: string[]; caps: string[] },
	live: ReadonlyArray<LiveRow>,
	now: number,
): DuplicateRefusal | undefined {
	const mine = identityKeyOf(incoming.title, incoming.files, incoming.caps);
	for (const row of live) {
		if (row.status === "failed") continue;
		const theirs = identityKeyOf(row.title, row.files, row.caps);
		if (theirs.key !== mine.key) continue;
		const ageMinutes = Math.max(0, Math.floor((now - row.createdAt) / 60_000));
		return {
			route: "exact",
			key: mine.key,
			prior: { taskId: row.id, status: row.status, ageMinutes, title: row.title },
			reason: `DUPLICATE REFUSED: "${incoming.title}" is the same work as ${row.id} (${row.status}, ${ageMinutes} min old) — identity key ${mine.key}`,
			remedy: `work on ${row.id} instead, or change this row so its deliverable differs (the kind, the deliverable's scope, or its files) — the row was NOT created`,
		};
	}
	return undefined;
}
