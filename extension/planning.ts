/**
 * Swarm-side planning: the pure rules of a goal's planning round.
 *
 * The coordinator only decides HOW MANY agents a goal needs (`swarm_goal`); the workers each post
 * their own split (`swarm_propose`), the first to claim the goal's planning task becomes the
 * scribe, and `store.planGoal` — which reuses THIS module to parse, dedupe and order the proposals
 * — turns them into the real task graph exactly once.
 *
 * Everything here is pure: no database, no clock, no timers. The round's rules are therefore
 * testable without a swarm, and the store stays the only writer.
 */
import type { BlackboardEntry, MergeFold } from "./types";

/** How long a planning round may take before the goal is closed with a FAIL (never left to spin). */
export const GOAL_DEADLINE_MS = 600_000;
/** A scribe cannot merge an empty round: at least one proposal must exist on the board. */
export const MIN_PROPOSALS = 1;
/** The board tag every proposal carries. */
export const PROPOSAL_TAG = "proposal";

/**
 * How long a CLAIMED planning round may make no progress before the pool may take it over.
 *
 * A scribe's turn can outlive its hold: the driver's beat renews every held task's lease, so the
 * lease never expires while the session lives, and a session that stops producing (a hung turn, a
 * disposed session, a scribe lost mid-merge — goal-6, replays in `.swarm` event `task.claim` at +64s
 * then NOTHING until the bound at +601s) keeps the round unrunnable by anybody else. Two silent
 * minutes hand the round to the next claimer, which is why the bound is no longer the only exit.
 */
export const SCRIBE_STALL_MS = 120_000;
/**
 * How many scribes one round may burn before it is closed with an explicit FAIL: the original claim
 * (attempt 1) plus two takeovers. A round nobody can carry must die loudly, not spin to the bound.
 */
export const MAX_SCRIBE_ATTEMPTS = 3;

/** What the watchdog needs to know about one open round. All of it is on the goal's planning row. */
export interface ScribeWatchInput {
	/** The goal's planning task id, for the message the pool reads. */
	planningTask: string;
	/** The agent holding the round right now; `undefined` when the row is already claimable. */
	heldBy?: string;
	/** Claims the round has taken so far: 1 = the original scribe, each takeover adds one. */
	attempts: number;
	/** The last moment the ROUND did something deliberate: a claim, a `swarm_renew`, a new proposal. */
	lastProgressAt: number;
	/** The caller's clock. */
	now: number;
}

/** What the pool should do about an open round. Pure, so the ladder is testable without a swarm. */
export type ScribeVerdict = { action: "ok" } | { action: "reclaim"; reason: string } | { action: "fail"; reason: string };

/**
 * The scribe-lost ladder, as a pure function.
 *
 * A held round younger than {@link SCRIBE_STALL_MS} of silence is `ok`: the scribe is working, and
 * taking a round off a live worker is the one thing this rule must never do. So is a round NOBODY has
 * ever claimed (`attempts === 0`): the pool has not started it yet and the bound owns that case.
 *
 * Past a silent window the round is re-offered (`reclaim`) while it has attempts left, and closed with
 * an explicit FAIL once it has none. The FAIL also covers the round that was re-offered and then left
 * sitting: once a scribe has existed (`attempts >= 1`), a claimable round that stays claimable for a
 * whole window is a round nobody is coming back to, so it ends with a reason instead of spinning
 * silently to the bound. Both reasons are written for the board - they name the holder, the attempts
 * and the silent seconds.
 */
export function scribeVerdict(input: ScribeWatchInput): ScribeVerdict {
	const silentMs = input.now - input.lastProgressAt;
	if (silentMs < SCRIBE_STALL_MS) return { action: "ok" };
	const silentSeconds = Math.round(silentMs / 1000);
	const stall = Math.round(SCRIBE_STALL_MS / 1000);
	const exhausted = input.attempts >= MAX_SCRIBE_ATTEMPTS;
	if (input.heldBy === undefined) {
		// Nothing to take off anybody: either the pool has not started the round (its own clock is the
		// bound), or a round was re-offered and nobody picked it up - which is the silent spin the
		// operator named, so it is closed with a reason.
		if (input.attempts === 0) return { action: "ok" };
		return {
			action: "fail",
			reason: `${input.planningTask} has been claimable for ${silentSeconds}s (stall limit ${stall}s) after ${input.attempts} claim(s); the round is closed explicitly rather than left spinning to the bound`,
		};
	}
	if (exhausted) {
		return {
			action: "fail",
			reason: `the planning round for ${input.planningTask} has been taken ${input.attempts} time(s) and ${input.heldBy} made no progress for ${silentSeconds}s (stall limit ${stall}s); closed explicitly instead of waiting for the bound`,
		};
	}
	return {
		action: "reclaim",
		reason: `${input.heldBy} held ${input.planningTask} without progress for ${silentSeconds}s (stall limit ${stall}s): the round is re-offered to the pool (attempt ${input.attempts} of ${MAX_SCRIBE_ATTEMPTS})`,
	};
}

/** The tag that scopes a proposal (and any goal board entry) to one goal. Exact-match on the tag list. */
export function goalTag(goalId: string): string {
	return `goal:${goalId}`;
}

/**
 * The scribe's dedupe rule, in one place because the policy text, the tool descriptions and the
 * merged DECISION all have to state the same rule.
 *
 * A deliverable is identified by WHAT IS PRODUCED (the artifact paths a proposal declares, else the
 * file names in its title) and by the KIND of work (write / verify / fix / document / remove /
 * refactor) - never by the wording of its title. Two proposals phrasing the same deliverable
 * differently are ONE task, with files, capabilities and dependencies unioned into the survivor.
 */
export const DEDUPE_KEY_TEXT =
	"a deliverable is keyed by its TARGET ARTIFACT (the `files` it declares, else the file names in its title) plus the KIND of work (write/verify/fix/document/remove/refactor), read from the title in English or Chinese, never from the description: an artifact is normalized to one form first, so casing, separators, a trailing `/**` and the two spellings of one name (`advisory-burnrate/` vs `advisory-burn/rate-table.md`) name the same artifact; identical titles always collapse; an unknown kind (`other`) never contradicts a known one, while two KNOWN kinds that differ (a writer and a verifier of one artifact) never fold; two proposals on one artifact collapse when one is a section of the other, their wording is close enough, or one declares extra artifacts (a wording this rule reads no words out of cannot disagree either); two WRITERS on one artifact are ALWAYS one deliverable (an artifact has one owner); and two container spellings of one deliverable (a directory standing for it) may still collapse on near-identical wording when both live under one parent directory. Files, capabilities and dependencies are unioned into the survivor and the longest description is kept";

/** Stable name of a deliverable: the same title in any casing/spacing is the same deliverable. */
export function deliverableKey(title: string): string {
	return title.trim().toLowerCase().replace(/\s+/g, " ").replace(/[\s.;:,!?]+$/, "");
}

/** What kind of work a deliverable is. Different kinds on one artifact are different deliverables. */
export type DeliverableIntent = "write" | "verify" | "fix" | "document" | "remove" | "refactor" | "other";

/**
 * The kinds whose work CHANGES the artifact. Two of them on one artifact are one deliverable, whatever
 * their kinds are — an artifact has one owner. `verify` and `document` are deliberately absent: a
 * verification of a thing is not the thing, and two of them on one artifact are not one owner.
 */
const MUTATING_KINDS: Record<DeliverableIntent, boolean> = {
	write: true,
	fix: true,
	remove: true,
	refactor: true,
	verify: false,
	document: false,
	other: false,
};

/**
 * How a deliverable is recognised across phrasings: its kind, its target artifacts, the significant
 * words of its wording, and whether it names a PART of the artifact rather than the whole of it.
 */
export interface DeliverableShape {
	intent: DeliverableIntent;
	artifacts: string[];
	words: string[];
	section: boolean;
}

/**
 * The verb families a title can open with, most specific first. The title's LEADING token decides the
 * kind, and only it: a title states its kind in its first word ("Fix …", "Verify …", "Document …",
 * "Remove …"), while anything matched later in the line is describing the OBJECT. Reading every token
 * let a noun or an incidental verb decide the kind instead, which is how the goal-9 round was merged:
 * "Non-author adversarial re-verification …" read as `write` off the noun `author`, "Wire every
 * remaining decision point … and check identity …" read as `verify` off `check`, and "Plan … the split
 * proposals …" read as `refactor` off the noun `split`. A title whose leading word states no kind
 * states none, and `other` contradicts nothing.
 */
const INTENT_VERBS: ReadonlyArray<readonly [DeliverableIntent, readonly string[]]> = [
	["verify", ["verify", "verifies", "validate", "validates", "check", "checks", "confirm", "confirms", "audit", "review", "assert", "ensure", "inspect"]],
	["fix", ["fix", "fixes", "repair", "correct", "corrects", "patch", "resolve", "resolves"]],
	["remove", ["delete", "delete", "removes", "remove", "drop", "purge"]],
	["refactor", ["refactor", "rename", "move", "extract", "split", "simplify"]],
	["document", ["document", "documents", "describe", "describes"]],
	[
		"write",
		["write", "writes", "create", "creates", "author", "authors", "implement", "implements", "add", "adds", "append", "appends", "produce", "produces", "generate", "generates", "build", "builds", "make", "makes", "draft", "drafts", "scaffold"],
	],
];

/**
 * The same verb families in Chinese, matched as SUBSTRINGS because {@link words} keeps no CJK token:
 * a Chinese title would otherwise be `other` to every rule, and the kind gate that refuses a fix and
 * a verification of one artifact cannot refuse what it cannot read. Only words that state the kind on
 * their own belong here - a row titled 量化/实测/普查 stays `other` and keeps pairing with its English
 * twin, which is what the live cross-language pairs need.
 */
const CHINESE_INTENT_VERBS: ReadonlyArray<readonly [DeliverableIntent, readonly string[]]> = [
	["verify", ["验证", "核验", "校验", "复核", "审计", "审查", "检查"]],
	["fix", ["修复", "修正", "修补"]],
	["remove", ["删除", "移除"]],
	["refactor", ["重构", "重命名"]],
	["document", ["文档化"]],
	["write", ["实现", "编写", "撰写", "创建", "新增", "添加"]],
];

/** The kind a Chinese title states, or undefined: the family whose word appears earliest wins. */
function chineseIntent(title: string): DeliverableIntent | undefined {
	let intent: DeliverableIntent | undefined;
	let earliest = Number.POSITIVE_INFINITY;
	for (const [family, verbs] of CHINESE_INTENT_VERBS) {
		for (const verb of verbs) {
			const at = title.indexOf(verb);
			if (at >= 0 && at < earliest) {
				earliest = at;
				intent = family;
			}
		}
	}
	return intent;
}

/** A title that names a PART of an artifact is a fragment of it, not a deliverable of its own. */
const SECTION_WORDS: Record<string, true> = {
	section: true,
	sections: true,
	subsection: true,
	subsections: true,
	chapter: true,
	chapters: true,
};

/** Words that carry no deliverable identity; dropping them is what survives a rephrasing. */
const STOPWORDS: Record<string, true> = {
	a: true, an: true, and: true, the: true, to: true, of: true, in: true, on: true, at: true, by: true, for: true, from: true,
	into: true, with: true, as: true, is: true, are: true, be: true, been: true, it: true, its: true, this: true, that: true,
	these: true, those: true, has: true, have: true, had: true, do: true, does: true, each: true, one: true, all: true,
	any: true, then: true, than: true, so: true, but: true, or: true, if: true, when: true, not: true, no: true, up: true,
	out: true, about: true, per: true, via: true,
};

/**
 * A file-name-ish token inside a title, used only when a proposal declares no `files`. The final
 * segment must start with a letter, which stops a dotted number (`1.2.3`, `v2.0.0`) from being read
 * as an artifact - two write-intent proposals sharing one of those would otherwise merge and silently
 * swallow a deliverable. (See {@link looksLikeFileName} for the version whose last segment is a WORD.)
 */
const ARTIFACT_IN_TITLE = /[A-Za-z0-9_@][A-Za-z0-9_@./\\-]*\.[A-Za-z][A-Za-z0-9]{0,7}/g;

/**
 * Extensions a title-borne token must carry to count as a file name. The final segment's SHAPE cannot
 * decide it: `1.2.3` ends in a digit and `v1.0.beta` / `v2.1.alpha` end in letters, so "letters first"
 * lets a version tag through and two release-shaped writers merge into one task. A token that cannot
 * be a file name is not an artifact at all, which is the cheap direction to be wrong in: a false
 * split only costs a duplicate task, while a false merge loses a deliverable.
 */
const KNOWN_FILE_EXTENSIONS: Record<string, true> = {
	// documents + data
	md: true, markdown: true, txt: true, rst: true, adoc: true, tex: true, pdf: true, csv: true, tsv: true, log: true, lock: true,
	// source
	ts: true, tsx: true, mts: true, cts: true, js: true, jsx: true, mjs: true, cjs: true, py: true, rb: true, go: true, rs: true,
	java: true, kt: true, scala: true, c: true, h: true, cc: true, cpp: true, hpp: true, cs: true, php: true, swift: true,
	lua: true, pl: true, r: true, sql: true, sh: true, bash: true, zsh: true, ps1: true, bat: true, cmd: true,
	// config + markup
	json: true, jsonc: true, json5: true, yml: true, yaml: true, toml: true, ini: true, cfg: true, conf: true, env: true,
	html: true, htm: true, css: true, scss: true, sass: true, less: true, xml: true, svg: true, vue: true, svelte: true, astro: true,
	// assets
	png: true, jpg: true, jpeg: true, gif: true, webp: true, ico: true, mp3: true, mp4: true, wav: true, webm: true, zip: true, tar: true, gz: true,
};

/**
 * Whether a token found in a title can be a FILE NAME. A path-shaped token (it carries a separator)
 * always can, whatever its extension; a bare token must end in one we know. This is what keeps
 * `v1.0.beta` and `v2.1.alpha` from becoming shared "artifacts" while `NOTES.md`, `src/parser.ts` and
 * `main.go` stay one.
 */
function looksLikeFileName(token: string): boolean {
	if (/[/\\]/.test(token)) return true;
	const dot = token.lastIndexOf(".");
	return dot >= 0 && KNOWN_FILE_EXTENSIONS[token.slice(dot + 1).toLowerCase()] === true;
}

/** How much of the SHORTER wording two phrasings of one artifact must share to be one deliverable. */
export const SAME_DELIVERABLE_SIMILARITY = 0.6;

/**
 * A FILE pins a deliverable: two non-writers that name the same file are one deliverable only when
 * their wording agrees. A CONTAINER is a scope, not a deliverable - naming it already says "the work
 * lives here" - so a shared directory pairs on less agreeing wording.
 */
export const SAME_DELIVERABLE_CONTAINER_SIMILARITY = 0.5;

/**
 * How much of the SHORTER wording an artifact-insufficient pair must share. A container (a directory
 * standing for a deliverable) and an unknown kind are the two cases where the artifact alone cannot
 * decide, so the wording has to carry the pair almost entirely by itself. This is the bar the live
 * counterexample needs: `advisory-observability/` and `advisory-status/` share 8 of the shorter
 * side's 9 words while the closest false pair shares 6 of 9.
 */
export const SAME_DELIVERABLE_OVERLAP = 0.8;

/** A name token has to be this long before a prefix/compound match counts as a shared word. */
const NAME_TOKEN_MIN = 4;

function words(text: string): string[] {
	return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== "");
}

/** One artifact path, in the single form two proposals can be compared in. */
function canonicalArtifact(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/\\/g, "/")
		.replace(/^\.\/+/, "")
		.replace(/\/+/g, "/")
		.replace(/\/\*\*$/, "")
		.replace(/\/+$/, "");
}

const isAbsoluteArtifact = (path: string): boolean => path.startsWith("/") || /^[a-z]:\//.test(path);
const artifactName = (path: string): string => path.split("/").pop() ?? path;
const artifactSegments = (path: string): string[] => path.split("/").filter((segment) => segment !== "");

/**
 * Whether an artifact is a CONTAINER - a directory standing for the deliverable (`scratch/burnrate/`,
 * `.../burnrate/**`) rather than a file. The name is what says so: a file's last segment carries an
 * extension. A file with no extension is read as a container, which only widens the one fallback that
 * needs near-identical wording anyway, so the cheap direction to be wrong in is the safe one.
 */
function isContainerArtifact(path: string): boolean {
	const last = artifactName(path);
	const dot = last.lastIndexOf(".");
	return dot <= 0;
}

/**
 * Same artifact: the identical path, one path being the tail of the other (`omp-swarm/src/a.ts` and
 * `src/a.ts` are one file seen from two roots), an absolute and a bare path naming the same file, or
 * two names that only spell the same thing differently (see {@link namesShareAToken}).
 */
function sameArtifact(left: string, right: string): boolean {
	if (left === right) return true;
	if (artifactName(left) === artifactName(right) && isAbsoluteArtifact(left) !== isAbsoluteArtifact(right)) return true;
	const [shorter, longer] =
		artifactSegments(left).length <= artifactSegments(right).length ? [artifactSegments(left), artifactSegments(right)] : [artifactSegments(right), artifactSegments(left)];
	if (shorter.length < 2 || shorter.length > longer.length) return false;
	const tail = longer.slice(longer.length - shorter.length);
	return shorter.every((segment, at) => segment === tail[at]);
}

/** The words of an artifact's own name - its last segment with the extension removed. */
function nameTokens(path: string): string[] {
	const last = artifactName(path);
	const dot = last.lastIndexOf(".");
	return words(dot > 0 ? last.slice(0, dot) : last);
}

/** Two name words are the same one when they are equal, or one spells the other out (`burn` in `burnrate`). */
function relatedNameTokens(left: string, right: string): boolean {
	if (left === right) return true;
	if (left.length < NAME_TOKEN_MIN || right.length < NAME_TOKEN_MIN) return false;
	return left.startsWith(right) || right.startsWith(left) || left.includes(right) || right.includes(left);
}

/**
 * Two artifact names that share a word once their common HEAD is dropped: `advisory-burnrate` and
 * `advisory-status` are told apart by `burnrate` vs `status`, while the `advisory-` both spell is the
 * theme of the directory, not the deliverable. Equal names overlap entirely but are not the same
 * spelling; {@link sameArtifact} already decides those.
 */
function namesShareAToken(left: string, right: string): boolean {
	const a = nameTokens(left);
	const b = nameTokens(right);
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
	const rest = [a.slice(head), b.slice(head)];
	if (rest[0].length === 0 || rest[1].length === 0) return false;
	return rest[0].some((word) => rest[1].some((other) => relatedNameTokens(word, other)));
}

/**
 * Words that say a path is EVIDENCE WORKSPACE - a scratch tree or a verification directory that HOLDS
 * the proof about a deliverable - rather than the deliverable itself: `scratch/goal9-verify/tool-layer/`.
 */
const EVIDENCE_WORKSPACE_WORDS: Record<string, true> = {
	scratch: true,
	tmp: true,
	temp: true,
	verify: true,
	verification: true,
	evidence: true,
};

/**
 * Whether an artifact lives in evidence space. Only a DIRECTORY segment states it: `src/verify.ts` is a
 * file whose name happens to say verify, while `scratch/goal9-verify/tool-layer/` is a tree that holds
 * evidence about something else. A marker in the path's final segment counts only when that segment is a
 * container, because a container IS the directory it names.
 */
function isEvidenceWorkspace(path: string): boolean {
	const segments = artifactSegments(path);
	const last = segments.length - 1;
	return segments.some(
		(segment, at) => (at !== last || isContainerArtifact(path)) && words(segment).some((word) => EVIDENCE_WORKSPACE_WORDS[word] === true),
	);
}

/**
 * Two artifacts on OPPOSITE sides of the evidence boundary are never ONE ARTIFACT by name. Evidence
 * space carries a deliverable's names inside it without being that deliverable (`tool-layer` beside
 * `tools.ts`), and pairing the two off a shared generic word is what let a verification absorb the very
 * deliverable it was verifying — the wiring row vanished into "Verify goal-9 A" and the verifier's files
 * grew to include the source it must stay independent of (D2). An identical path, or one being the tail
 * of the other, is untouched: only the NAME route crosses that boundary.
 */
function crossesEvidenceBoundary(left: string, right: string): boolean {
	return isEvidenceWorkspace(left) !== isEvidenceWorkspace(right);
}

/**
 * The first artifact two sets share as a FILE - the same path, the same path seen from two roots
 * (`omp-swarm/src/a.ts` and `src/a.ts`), or an absolute and a bare path naming it. Deliberately NOT the
 * name route: two rows that would edit one FILE collide, while two names that merely sound alike do not.
 */
function sharedArtifact(left: string[], right: string[]): string | undefined {
	for (const a of left) {
		for (const b of right) {
			if (sameArtifact(a, b)) return a === b ? a : `${a} ~ ${b}`;
		}
	}
	return undefined;
}

/** How two artifact SETS matched: the paths that line up, and what that match is worth as evidence. */
interface ArtifactMatch {
	/** The matched paths, `written ~ spelled` when the two sides named one artifact differently. */
	detail: string;
	/** True when at least one pair matched by NAME rather than by path - evidence in its own right. */
	spelled: boolean;
	/** True when every matched artifact is a container (a directory standing for the deliverable). */
	container: boolean;
}

/**
 * Two artifact SETS name one deliverable: the smaller side matches into the larger, each artifact
 * with its own counterpart. A narrower declaration folds into a wider one (`brake/` into
 * `brake/ + .swarm/config.json`) because the union keeps every declared file and the extra artifacts
 * are reported in the reason - the difference is visible, never lost.
 *
 * The spelling evidence is looked for across the WHOLE cross product, not only in the pairs the
 * coverage rule used: a stored row's `files` is the union of every spelling that folded into it, so
 * the pair that proves the two declarations name one artifact need not be the pair that covered the
 * narrower side - and demanding the wording agree on top of it would undo the merge the row records.
 */
function artifactsRelation(left: string[], right: string[]): ArtifactMatch | undefined {
	const [fewer, more] = left.length <= right.length ? [left, right] : [right, left];
	if (fewer.length === 0) return undefined;
	const pool = [...more];
	const matched: string[] = [];
	let written = false;
	for (const path of fewer) {
		const at = pool.findIndex(
			(candidate) =>
				sameArtifact(path, candidate) ||
				(artifactName(path) !== artifactName(candidate) && !crossesEvidenceBoundary(path, candidate) && namesShareAToken(path, candidate)),
		);
		if (at < 0) return undefined;
		const hit = pool[at] as string;
		if (path !== hit) {
			written = true;
			matched.push(`${path} ~ ${hit}`);
		} else {
			matched.push(path);
		}
		pool.splice(at, 1);
	}
	const spelled = written || left.some((a) => right.some((b) => artifactName(a) !== artifactName(b) && !crossesEvidenceBoundary(a, b) && namesShareAToken(a, b)));
	return {
		detail: pool.length > 0 ? `${matched.join(", ")} (+${pool.join(", ")})` : matched.join(", "),
		spelled,
		container: fewer.every(isContainerArtifact),
	};
}

/**
 * How much of the SHORTER side's wording the other carries. Jaccard punishes a long English
 * description against a short Chinese one for being long, which is exactly the pair a language-blind
 * rule has to keep: this asks whether the smaller wording is contained in the larger.
 */
function wordingOverlap(left: string[], right: string[]): number {
	if (left.length === 0 || right.length === 0) return 0;
	const other = new Set(right);
	const shared = new Set(left.filter((word) => other.has(word))).size;
	return shared / Math.min(new Set(left).size, new Set(right).size);
}

const percent = (value: number): string => `${Math.round(value * 100)}%`;

/**
 * Read a deliverable out of a title (and the artifact paths a proposal declared for it). Everything
 * here is pure and total: a title that names no artifact yields an empty artifact list, which the
 * matcher then refuses to pair with anything.
 *
 * The KIND comes from the title alone. The description is prose - it lists evidence, files and side
 * notes - and letting a verb buried in it classify the work makes one deliverable `verify` in one
 * proposal and `write` in the next, which is a false split no rule can see through.
 */
export function describeDeliverable(title: string, files: string[] = [], deliverable = ""): DeliverableShape {
	const tokens = words(`${title} ${deliverable}`);
	// The kind comes from the title's leading token, and only from it (see INTENT_VERBS). A title that
	// opens with no known verb is `other`: the merge rules then treat it as contradicting nothing.
	const leading = words(title)[0];
	const family = leading === undefined ? undefined : INTENT_VERBS.find(([, verbs]) => verbs.includes(leading));
	const intent: DeliverableIntent = family?.[0] ?? chineseIntent(title) ?? "other";
	const declared = files.map(canonicalArtifact).filter((path) => path !== "");
	const fromTitle = (title.match(ARTIFACT_IN_TITLE) ?? []).filter(looksLikeFileName);
	const artifacts = [...new Set((declared.length > 0 ? declared : fromTitle.map(canonicalArtifact)).filter((path) => path !== ""))].sort();
	const artifactWords = new Set(words(artifacts.join(" ")));
	const verbs = new Set(INTENT_VERBS.flatMap(([, family]) => family));
	return {
		intent,
		artifacts,
		words: [...new Set(tokens.filter((token) => STOPWORDS[token] !== true && !artifactWords.has(token) && !verbs.has(token)))].sort(),
		section: tokens.some((token) => SECTION_WORDS[token] === true),
	};
}

/**
 * Why two proposal shapes are the same deliverable, or `undefined` when they are two. The pairing
 * carries its reason because the plan's DECISION has to show the operator WHAT folded into what, and
 * this is the only place that knows.
 *
 * The direction of every doubtful case is the same: a false split costs one visible duplicate task
 * while a false merge loses a deliverable silently, so an unknown kind and a bare directory only
 * pair on evidence that is nearly unambiguous.
 */
export function sameDeliverableReason(left: DeliverableShape, right: DeliverableShape): string | undefined {
	// ONE ARTIFACT HAS ONE OWNER, and the test is INTERSECTION: two rows that would both MUTATE one file
	// are one deliverable, whatever their kinds are and whatever else each of them declares. Both editing
	// that file is the collision the rule exists to prevent, and the extra files are not lost - the union
	// keeps every one and the fold is recorded with its reason. Firing on the literal `write` alone, and
	// only on the coverage relation below (which demands that every file of the smaller side match), is why
	// the goal-9 round still minted THREE writers on extension/store.ts: those rows share that one file and
	// nothing else (D1).
	//
	// THIS CLAUSE SITS ABOVE THE KIND GUARD ON PURPOSE. The guard below refuses two KNOWN kinds that differ;
	// a `fix` and a `refactor` on one file are exactly that, so with the guard first they never reached this
	// clause and the round kept two writers for one artifact - the same defect one level up (task-212's own
	// acceptance, measured: "the owner clause must cover every mutating kind").
	if (MUTATING_KINDS[left.intent] && MUTATING_KINDS[right.intent]) {
		const shared = sharedArtifact(left.artifacts, right.artifacts);
		if (shared !== undefined) return `one artifact has one owner: ${shared}`;
	}
	// Two KNOWN kinds that differ are two deliverables; an unknown kind contradicts nothing.
	if (left.intent !== right.intent && left.intent !== "other" && right.intent !== "other") return undefined;
	const artifact = artifactsRelation(left.artifacts, right.artifacts);
	if (artifact !== undefined) {
		// An UNKNOWN kind never pairs with a VERIFICATION on a SOURCE artifact. The unknown side may be a
		// writer whose verb the classifier does not know (`Wire ...` reads as `other`), and folding it into
		// a verification - or the verification into it - is the one merge this rule must never make: a
		// verifier that owns the source it verifies is no longer an independent verification (D2). The
		// direction of doubt is the rule's usual one: a visible duplicate row beats a swallowed deliverable.
		// EVIDENCE artifacts are exempt ON PURPOSE: two verifications of one deliverable declare their own
		// reports, and a recognized one pairing with an unrecognized spelling of itself is exactly what the
		// recorded goal-5 round needs to stay at five deliverables (pinned by that round's own tests).
		const sharesSourceArtifact = left.artifacts.some((a) =>
			right.artifacts.some((b) => sameArtifact(a, b) && !isEvidenceWorkspace(a) && !isEvidenceWorkspace(b)),
		);
		const otherVsVerification =
			(left.intent === "other" && (right.intent === "verify" || right.intent === "document")) ||
			(right.intent === "other" && (left.intent === "verify" || left.intent === "document"));
		if (otherVsVerification && sharesSourceArtifact) return undefined;
		// A `write` still claims the artifact from an unknown-kind twin, which is what pairs a Chinese row
		// with its English one; everything else on one artifact is decided by the evidence below.
		if (left.intent === "write" || right.intent === "write") return `one artifact has one owner: ${artifact.detail}`;
		// The two sides named one artifact under two spellings (`advisory-wakeups` and
		// `advisory-burn/wake-sources.md` share the compound `wake`): that correspondence is the
		// evidence, and demanding the wording agree on top of it is what kept the live pairs apart.
		if (artifact.spelled) return `two spellings of one artifact: ${artifact.detail}`;
		if (left.section !== right.section) return `one is a section of the other: ${artifact.detail}`;
		// On one artifact only the wording separates two kinds of work, and what separates them is
		// whether the SHORTER wording is contained in the other - never how long either one is, which
		// is what a Jaccard score reads as "different" the moment a terse title meets a long one.
		const bar = artifact.container ? SAME_DELIVERABLE_CONTAINER_SIMILARITY : SAME_DELIVERABLE_SIMILARITY;
		const overlap = wordingOverlap(left.words, right.words);
		if (overlap >= bar) return `the same artifact and ${percent(overlap)} of the shorter wording: ${artifact.detail}`;
		// A wording the tokenizer reads no words out of at all (a Chinese title against an English one)
		// cannot DISAGREE with the other - there is nothing to disagree with - so on the identical
		// spelling of one artifact it is no obstacle either.
		if (!artifact.spelled && (left.words.length === 0 || right.words.length === 0)) {
			return `the same artifact, one side carries no readable wording: ${artifact.detail}`;
		}
		return undefined;
	}
	// Neither artifact matched. A container - a directory standing for the deliverable - is the one
	// spelling whose own name cannot carry the identity, so two of them may still be one deliverable
	// when their wording is the same all but in length AND they are two names in ONE scope: a rename
	// inside a directory is a spelling, while `src/` and `omp-swarm/tests/` are two different places.
	if (containerOnly(left.artifacts) && containerOnly(right.artifacts) && sameContainerScope(left.artifacts, right.artifacts)) {
		const overlap = wordingOverlap(left.words, right.words);
		if (overlap >= SAME_DELIVERABLE_OVERLAP) return `two spellings of one container and ${percent(overlap)} of the shorter wording`;
	}
	return undefined;
}

/** The directory an artifact lives in (empty for a path with no parent). */
function parentDirectory(path: string): string {
	const at = path.lastIndexOf("/");
	return at < 0 ? "" : path.slice(0, at);
}

/** Whether every container involved lives under ONE parent directory: two names, one scope. */
function sameContainerScope(left: string[], right: string[]): boolean {
	return new Set([...left, ...right].map(parentDirectory)).size === 1;
}

/** Whether every artifact a deliverable declares is a container (an empty list is not one). */
function containerOnly(artifacts: string[]): boolean {
	return artifacts.length > 0 && artifacts.every(isContainerArtifact);
}

/** Whether two proposal shapes are the same deliverable (see {@link sameDeliverableReason}). */
export function isSameDeliverable(left: DeliverableShape, right: DeliverableShape): boolean {
	return sameDeliverableReason(left, right) !== undefined;
}

export interface ProposedTask {
	title: string;
	deliverable?: string;
	capabilities?: string[];
	files?: string[];
	/** Titles of OTHER proposed tasks this one waits for (`swarm_task_create` dependencies). */
	dependsOn?: string[];
	reviewRequired?: boolean;
}

/** One agent's split proposal, as it travelled over the board. */
export interface Proposal {
	entryId: number;
	agentId: string;
	goalId: string;
	tasks: ProposedTask[];
	/**
	 * When the proposal landed. The round watchdog reads it as PROGRESS: a new split is the round
	 * moving, so it resets the stall clock exactly the way a `swarm_renew` does.
	 */
	createdAt: number;
}

/** A deduped deliverable, ready to become a task row. `deps` are keys of other merged tasks. */
export interface MergedTask {
	key: string;
	title: string;
	deliverable?: string;
	capabilities: string[];
	files: string[];
	dependsOn: string[];
	reviewRequired: boolean;
	/** Every agent whose proposal contributed to this deliverable, in proposal order. */
	agents: string[];
}

export interface MergeDep {
	task: string;
	dep: string;
}

export interface MergeResult {
	tasks: MergedTask[];
	proposals: number;
	/** Keys that more than one proposal named (the duplicates the merge folded in). */
	folded: string[];
	/** Every folded row, with the survivor and the reason - the DECISION's audit trail. */
	folds: MergeFold[];
	/** Dependency references that could not be resolved and were dropped (self/unknown title). */
	unresolved: MergeDep[];
	/** Proposals that carried no usable task at all. */
	empty: number;
}

/** Trim, drop empties, dedupe. Absent or malformed input is an empty list, never a throw. */
function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (trimmed !== "" && !out.includes(trimmed)) out.push(trimmed);
	}
	return out;
}

/** One proposed task from untrusted JSON. A blank title makes it unusable, so it is dropped. */
export function parseProposedTask(value: unknown): ProposedTask | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const title = typeof record.title === "string" ? record.title.trim() : "";
	if (title === "") return undefined;
	return {
		title,
		deliverable: typeof record.deliverable === "string" && record.deliverable.trim() !== "" ? record.deliverable : undefined,
		capabilities: stringList(record.capabilities),
		files: stringList(record.files),
		dependsOn: stringList(record.depends_on),
		reviewRequired: record.review_required === true,
	};
}

/**
 * A board entry -> a proposal, or undefined when the entry is not one. The entry must carry the
 * `proposal` tag (that is what makes it identifiable on a board that also holds FACTs and FAILs)
 * and JSON content: either `{ goal, tasks: [...] }` or a bare task array. The goal id comes from
 * the JSON when present, otherwise from the `goal:<id>` tag.
 */
export function parseProposal(entry: BlackboardEntry): Proposal | undefined {
	if (!entry.tags.includes(PROPOSAL_TAG)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(entry.content);
	} catch {
		return undefined;
	}
	const record =
		typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	const rawTasks = Array.isArray(parsed) ? parsed : record !== undefined && Array.isArray(record.tasks) ? record.tasks : undefined;
	if (rawTasks === undefined) return undefined;
	const tasks = rawTasks.map(parseProposedTask).filter((task): task is ProposedTask => task !== undefined);
	if (tasks.length === 0) return undefined;
	const fromJson = record !== undefined && typeof record.goal === "string" ? record.goal.trim() : "";
	const goalId = fromJson !== "" ? fromJson : (entry.tags.find((tag) => tag.startsWith("goal:"))?.slice(5) ?? "");
	return { entryId: entry.id, agentId: entry.agentId, goalId, tasks, createdAt: entry.createdAt };
}

/**
 * The reason a shape is one of the spellings already seen for a deliverable, or `undefined`. A merged
 * deliverable keeps EVERY declaration that named it: matching against the first one alone would split
 * whatever arrived naming the spelling that folded in second.
 */
function matchingSpelling(spellings: DeliverableShape[] | undefined, shape: DeliverableShape): string | undefined {
	for (const spelling of spellings ?? []) {
		const reason = sameDeliverableReason(spelling, shape);
		if (reason !== undefined) return reason;
	}
	return undefined;
}

/**
 * Merge every proposal of one round into the deduped deliverable list.
 *
 * First proposal wins the title; a later one for the same deliverable only adds (files,
 * capabilities, dependencies, a longer description, review_required). "The same deliverable" is the
 * exact key when the phrasing matches and the shape rule ({@link sameDeliverableReason}) when it does
 * not - so four agents writing one file in four phrasings yield one task, while two genuinely
 * different deliverables on one file (different kinds of work, or work that is not close enough)
 * stay apart. Every row that folds is recorded with its survivor and the reason
 * ({@link MergeFold}), which is what the plan's DECISION prints. Dependency references are resolved
 * against the same spellings, so an agent may depend on a deliverable another agent proposed under
 * different wording; a reference to an unknown or to the task's own title is dropped and reported,
 * never turned into a row of its own.
 */
export function mergeProposals(proposals: Proposal[]): MergeResult {
	const order: string[] = [];
	const byKey = new Map<string, MergedTask>();
	const spellingsByKey = new Map<string, DeliverableShape[]>();
	// Every key any proposal used -> the surviving key it belongs to. A dependency that names a row
	// this round folded must resolve THROUGH that row to its survivor, or the edge is dead on arrival.
	const survivorByKey = new Map<string, string>();
	const rawDeps = new Map<string, string[]>();
	const folds: MergeFold[] = [];
	const unresolved: MergeDep[] = [];
	let empty = 0;
	for (const proposal of proposals) {
		if (proposal.tasks.length === 0) {
			empty += 1;
			continue;
		}
		for (const proposed of proposal.tasks) {
			const key = deliverableKey(proposed.title);
			if (key === "") {
				empty += 1;
				continue;
			}
			const shape = describeDeliverable(proposed.title, proposed.files ?? [], proposed.deliverable ?? "");
			let target: string | undefined;
			let reason = "the identical title";
			if (byKey.has(key)) {
				target = key;
			} else if (survivorByKey.has(key)) {
				// The identical title of a row this round already folded: same deliverable, same survivor.
				target = survivorByKey.get(key);
			} else {
				for (const seen of order) {
					const why = matchingSpelling(spellingsByKey.get(seen), shape);
					if (why !== undefined) {
						target = seen;
						reason = why;
						break;
					}
				}
			}
			const mergeKey = target ?? key;
			const known = byKey.get(mergeKey);
			if (known === undefined) {
				byKey.set(mergeKey, {
					key: mergeKey,
					title: proposed.title,
					deliverable: proposed.deliverable?.trim() || undefined,
					capabilities: [...(proposed.capabilities ?? [])],
					files: [...(proposed.files ?? [])],
					dependsOn: [],
					reviewRequired: proposed.reviewRequired === true,
					agents: [proposal.agentId],
				});
				spellingsByKey.set(mergeKey, [shape]);
				survivorByKey.set(mergeKey, mergeKey);
				order.push(mergeKey);
			} else {
				folds.push({ into: mergeKey, title: proposed.title, reason });
				survivorByKey.set(key, mergeKey);
				(spellingsByKey.get(mergeKey) as DeliverableShape[]).push(shape);
				// A section title must not stand for the whole artifact once the whole one is proposed.
				if (describeDeliverable(known.title, known.files).section && !shape.section) known.title = proposed.title;
				const deliverable = proposed.deliverable?.trim() ?? "";
				if (deliverable.length > (known.deliverable?.length ?? 0)) known.deliverable = deliverable;
				known.capabilities = [...new Set([...known.capabilities, ...(proposed.capabilities ?? [])])];
				known.files = [...new Set([...known.files, ...(proposed.files ?? [])])];
				if (proposed.reviewRequired === true) known.reviewRequired = true;
				if (!known.agents.includes(proposal.agentId)) known.agents.push(proposal.agentId);
			}
			rawDeps.set(mergeKey, [...(rawDeps.get(mergeKey) ?? []), ...(proposed.dependsOn ?? [])]);
		}
	}
	for (const key of order) {
		const deps: string[] = [];
		for (const raw of rawDeps.get(key) ?? []) {
			const exact = deliverableKey(raw);
			// A reference that names a row this round folded resolves to that row's SURVIVOR: the work
			// is one deliverable, and an edge onto the spelling that lost is how goal-5's residue hung.
			let dep: string | undefined = exact === "" ? undefined : survivorByKey.get(exact);
			if (dep === undefined) {
				const wanted = describeDeliverable(raw);
				dep = order.find((seen) => matchingSpelling(spellingsByKey.get(seen), wanted) !== undefined);
			}
			// A dependency inside the same round can only be a reference to another deliverable of
			// this round; anything else (own title, a typo, a stale id) is dropped and reported.
			if (dep === undefined || dep === key) {
				unresolved.push({ task: key, dep: raw });
				continue;
			}
			if (!deps.includes(dep)) deps.push(dep);
		}
		(byKey.get(key) as MergedTask).dependsOn = deps;
	}
	return {
		tasks: order.map((key) => byKey.get(key) as MergedTask),
		proposals: proposals.length,
		folded: [...new Set(folds.map((fold) => fold.into))],
		folds,
		unresolved,
		empty,
	};
}

/**
 * Creation order for the merged round: a task may only be created after every deliverable it
 * depends on exists (`store.createTask` refuses an unknown dependency id). Kahn, stable in
 * proposal order; when nothing is ready the first remaining task is forced in with its unplaced
 * edges recorded as deferred, so even a cyclic proposal round still terminates with a real graph.
 */
export function orderForCreation(tasks: MergedTask[]): { ordered: MergedTask[]; deferred: MergeDep[] } {
	const placed = new Set<string>();
	const ordered: MergedTask[] = [];
	const deferred: MergeDep[] = [];
	const remaining = [...tasks];
	while (remaining.length > 0) {
		const ready = remaining.filter((task) => task.dependsOn.every((dep) => placed.has(dep)));
		const take = ready.length > 0 ? ready : [remaining[0] as MergedTask];
		for (const task of take) {
			if (!ready.includes(task)) {
				for (const dep of task.dependsOn) if (!placed.has(dep)) deferred.push({ task: task.key, dep });
			}
			ordered.push(task);
			placed.add(task.key);
			remaining.splice(remaining.indexOf(task), 1);
		}
	}
	return { ordered, deferred };
}

/**
 * The widest set of the round's deliverables that can run at the same time: the round's peak
 * parallelism, as a wave simulation over the dependency graph. Tasks left un-waved (a forced,
 * reported edge — a cycle) can only run once a wave has finished, so they add one worker, and a
 * round that is entirely cyclic is one worker wide because creation drops the edges that cannot
 * resolve to an already-created task.
 */
export function peakParallelism(tasks: MergedTask[]): number {
	const done = new Set<string>();
	let peak = 0;
	let remaining = [...tasks];
	while (remaining.length > 0) {
		const wave = remaining.filter((task) => task.dependsOn.every((dep) => done.has(dep)));
		if (wave.length === 0) break;
		peak = Math.max(peak, wave.length);
		for (const task of wave) done.add(task.key);
		remaining = remaining.filter((task) => !wave.includes(task));
	}
	if (peak === 0) return tasks.length > 0 ? 1 : 0;
	return remaining.length > 0 ? peak + 1 : peak;
}

/** The brief the goal's single planning task carries: what the round is, who does what, the bound. */
export function planningTaskBrief(goal: { id: string; goal: string; agents: number; createdBy: string }, deadlineMs = GOAL_DEADLINE_MS): string {
	return [
		`GOAL ${goal.id} (${goal.agents} agent(s), opened by ${goal.createdBy}): ${goal.goal}`,
		"",
		"This is the goal's ONLY planning task, and the first agent to claim it is the SCRIBE.",
		"Round:",
		`1. Every worker posts its OWN split of the goal with swarm_propose (a board entry tagged "${PROPOSAL_TAG}" + "${goalTag(goal.id)}" that points at this task).`,
		"2. The scribe calls swarm_plan: it parses every proposal, dedupes them and creates the real task graph.",
		`   Dedupe: ${DEDUPE_KEY_TEXT}.`,
		"3. swarm_plan posts the merged split as a DECISION and marks the goal planned; the pool then claims the real tasks.",
		"4. The goal's agent count was only a starting guess: if the merged shape needs a different number of agents, ask with swarm_scale({ agents, reason }) — a regular agent needs a passed `scale` round for that SIZE first (the pool's size is a cluster-level decision), then re-issues the call with vote_id. The controller reconciles the pool on its next tick and clamps to config.workers.",
		`Bound: no plan within ${Math.round(deadlineMs / 60_000)} minute(s) of the goal closes it with a FAIL - the round never spins silently.`,
	].join("\n");
}
