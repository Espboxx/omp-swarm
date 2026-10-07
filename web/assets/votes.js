/**
 * The voting/tallying view's data layer: the read-only snapshot -> the rounds worth showing.
 *
 * There is NO new endpoint and no server change here: the snapshot's own feeds carry what the view shows.
 * The mechanism writes a `vote.open` / `vote.ballot` / `vote.passed` / `vote.failed` event for every round
 * and a board entry for every settled one, and the snapshot ships both.
 *
 * WHAT THE READ-ONLY INTERFACE ACTUALLY PUBLISHES — measured, not assumed (see B's report):
 *   - a round's question, kind, opener and DEADLINE: the `vote.open` event (`vote`, `kind`, `question`,
 *     `openedBy` in the DB row's `agent_id` — which the frozen contract drops, so `null` here —
 *     `timeoutMs`, `threshold`), so a countdown is real and never guessed;
 *   - the FULL TALLY of a settled round: its terminal event's own `for` / `against` / `absent` /
 *     `offline` / `reason`, plus the board entry it published;
 *   - WHO VOTED WHAT on a round still in progress: NOT PUBLISHED. `castBallot` logs the voter in
 *     `events.agent_id`, and the frozen v1 snapshot contract (`web/lib/types.ts` `SnapshotEvent`)
 *     ships only `{createdAtMs, type, content}` of that row — the voter is dropped. `vote_ballots` is
 *     a table the dashboard deliberately does not read (nothing in the contract exposes it).
 *
 * So an open round shows its question, kind and deadline and says plainly that its ballots are not on
 * this read-only path — the panel never invents a voter, a count or a missing list that the snapshot
 * does not carry. That is the gap the goal names ("report the gap instead of inventing placeholders");
 * closing it is a one-line contract change in `web/snapshot.ts`, which is outside this task's write
 * domain and therefore reported, not edited.
 */

const clampInt = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null);

/** The `data` of an event row, as object. An unreadable payload is `{}` — never a throw. */
function dataOf(content) {
	try {
		const parsed = typeof content === "string" ? JSON.parse(content) : content;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

const str = (value) => (typeof value === "string" && value.trim() !== "" ? value : null);
const idList = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);

/** Approvals required for `base` voters at `threshold` — the rule `voting.ts` states, mirrored read-only. */
function approvalsRequired(base, threshold) {
	if (base <= 0) return 0;
	return Math.floor(base * threshold) + 1;
}

/** The policy default `voting.ts` freezes onto a round, used only where a round published no threshold. */
const DEFAULT_THRESHOLD = 0.75;

/**
 * The round behind one `vote.open` event.
 *
 * The deadline is the event's own `openedAt + timeoutMs`, so a round whose `timeoutMs` was published
 * carries a real countdown and one whose was not carries `null` — the view prints "not published"
 * rather than a made-up time.
 */
function openFrom(createdAtMs, content) {
	const data = dataOf(content);
	const timeoutMs = clampInt(data.timeoutMs);
	return {
		id: str(data.vote),
		question: str(data.question) ?? "",
		kind: str(data.kind),
		openedBy: null,
		openedAtMs: createdAtMs,
		// The event's `timeoutMs` is already milliseconds (the store's own field name), so the deadline is
		// the plain sum — scaling it again is how a 90s round would read as a 25-hour one.
		deadlineMs: timeoutMs === null ? null : createdAtMs + timeoutMs,
		threshold: typeof data.threshold === "number" && Number.isFinite(data.threshold) && data.threshold > 0 ? data.threshold : null,
		base: null,
		needed: null,
		status: "pending",
		reason: null,
		for: [],
		against: [],
		absent: [],
		offline: [],
		// A settled round's tally is published inside its own terminal event. An OPEN round's ballots are
		// NOT on this read-only path (`castBallot` records the voter in `events.agent_id`, and the frozen
		// v1 contract drops it), so an open round carries `ballotsReadable: false` and the panel says so.
		ballots: [],
		ballotsReadable: false,
		boardId: null,
	};
}

/** An empty round, for a terminal event whose `vote.open` fell past the feed limit. */
function emptyRound(voteId, createdAtMs, data) {
	return {
		id: voteId,
		question: str(data.question) ?? "",
		kind: str(data.kind) ?? null,
		openedBy: str(data.openedBy),
		openedAtMs: createdAtMs,
		deadlineMs: null,
		threshold: null,
		base: null,
		needed: null,
		status: "pending",
		reason: null,
		for: [],
		against: [],
		absent: [],
		offline: [],
		ballots: [],
		ballotsReadable: false,
		boardId: null,
	};
}

/**
 * The snapshot's vote events -> the rounds the panel shows.
 *
 * Newest first, the order every other feed on the page uses. The events feed is NEWEST-first, so a
 * round's `vote.open` routinely arrives AFTER its terminal event: the open row is therefore collected
 * first and merged into whichever round it names, instead of being discarded as a duplicate.
 *
 * A round whose `vote.open` is no longer in the feed (it aged past `feed.limit`) is still shown from
 * its terminal event: the tally and the reason are what matter, and hiding a settled round because its
 * opening row fell out would be a silent gap.
 */
export function votesFromSnapshot(snapshot) {
	const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
	const order = [];
	const byId = new Map();

	// Pass 1: every `vote.open` row, keyed by the vote id it names. The feed's own order cannot be
	// relied on for this, because a terminal event is newer than the open it settles.
	const opens = new Map();
	for (const event of events) {
		if (str(event.type) !== "vote.open") continue;
		const createdAtMs = typeof event.createdAtMs === "number" ? event.createdAtMs : 0;
		const data = dataOf(event.content);
		const voteId = str(data.vote);
		if (voteId !== null && !opens.has(voteId)) opens.set(voteId, openFrom(createdAtMs, event.content));
	}

	for (const event of events) {
		const type = str(event.type);
		if (type === null || !type.startsWith("vote.")) continue;
		const createdAtMs = typeof event.createdAtMs === "number" ? event.createdAtMs : 0;
		const data = dataOf(event.content);
		const voteId = str(data.vote);

		if (type === "vote.open") {
			// An open row that names no vote id is still a round: it carries the question and the
			// deadline, which is exactly what the panel shows. Keyed by its own timestamp, because two
			// unnamed rows are two rounds.
			const key = voteId ?? `open@${createdAtMs}`;
			const open = opens.get(voteId ?? "") ?? openFrom(createdAtMs, event.content);
			if (!byId.has(key)) {
				byId.set(key, open);
				order.push(key);
			}
			continue;
		}

		const key = voteId ?? `unknown@${createdAtMs}`;
		if (!byId.has(key)) {
			// No `vote.open` in the feed (it aged past `feed.limit`), or one that never named an id: the
			// round still exists, and its terminal event is what the panel shows.
			const known = voteId === null ? undefined : opens.get(voteId);
			byId.set(key, known ?? emptyRound(voteId, createdAtMs, data));
			order.push(key);
		}
		const round = byId.get(key);

		if (type === "vote.ballot") {
			// The DB row's `agent_id` IS the voter, but the frozen v1 snapshot contract ships only the
			// event's `type`, `createdAtMs` and `content`, so the voter never reaches the page. The
			// ballot COUNT would also be a fabrication waiting to happen (`feed.limit` can hide rows), so
			// nothing is derived here at all: an open round reports that its ballots are not published.
			// The feed is newest-first, so a settled round's ballots can arrive AFTER its terminal
			// event — never let them downgrade a settled round's own published tally.
			if (round.status === "pending") {
				round.ballots = [];
				round.ballotsReadable = Array.isArray(data.ballots) && data.ballots.length > 0;
			}
			continue;
		}

		if (type === "vote.passed" || type === "vote.failed") {
			round.status = type === "vote.passed" ? "passed" : "failed";
			round.reason = str(data.reason);
			if (round.question === "" && str(data.question) !== null) round.question = str(data.question);
			if (round.kind === null && str(data.kind) !== null) round.kind = str(data.kind);
			round.for = idList(data.for);
			round.against = idList(data.against);
			round.absent = idList(data.absent);
			round.offline = idList(data.offline);
			// `needed` at the round's own threshold, from the base its terminal event published: eligible
			// + absent is exactly what `decide()` counts, so this is a reading, not a recomputation. A
			// round whose tally published nothing keeps `null` and the view says the number is not there.
			const base = round.for.length + round.against.length + round.absent.length;
			const threshold = round.threshold ?? DEFAULT_THRESHOLD;
			if (base > 0) {
				round.base = base;
				round.needed = approvalsRequired(base, threshold);
			}
			// A settled round's ballots are inside its own tally: the lists above ARE who voted what.
			round.ballotsReadable = true;
		}
	}

	return order.map((key) => byId.get(key)).reverse();
}

/** The board entry a settled round published, when the snapshot still carries it. */
export function voteBoardIds(snapshot) {
	const board = Array.isArray(snapshot?.board) ? snapshot.board : [];
	const out = new Map();
	for (const entry of board) {
		const content = typeof entry.content === "string" ? entry.content : "";
		const match = /(?:vote_passed|vote_failed)\s+(vote-\d+)/.exec(content);
		if (match !== null && typeof entry.id === "number" && !out.has(match[1])) out.set(match[1], entry.id);
	}
	return out;
}
