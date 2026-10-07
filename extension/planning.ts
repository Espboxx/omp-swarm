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
import type { BlackboardEntry } from "./types";

/** How long a planning round may take before the goal is closed with a FAIL (never left to spin). */
export const GOAL_DEADLINE_MS = 600_000;
/** A scribe cannot merge an empty round: at least one proposal must exist on the board. */
export const MIN_PROPOSALS = 1;
/** The board tag every proposal carries. */
export const PROPOSAL_TAG = "proposal";

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
	"a deliverable is keyed by its TARGET ARTIFACT (the `files` it declares, else the file names in its title) plus the KIND of work (write/verify/fix/document/remove/refactor), not by its wording: identical titles always collapse, two proposals declaring the same artifact with the same kind collapse when one is a section of the other or their wording is close enough, and two WRITERS on one artifact are ALWAYS one deliverable (an artifact has one owner) so they never both become tasks. Files, capabilities and dependencies are unioned into the survivor and the longest description is kept";

/** Stable name of a deliverable: the same title in any casing/spacing is the same deliverable. */
export function deliverableKey(title: string): string {
	return title.trim().toLowerCase().replace(/\s+/g, " ").replace(/[\s.;:,!?]+$/, "");
}

/** What kind of work a deliverable is. Different kinds on one artifact are different deliverables. */
export type DeliverableIntent = "write" | "verify" | "fix" | "document" | "remove" | "refactor" | "other";

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
 * The verb families a title can open with, most specific first. The FIRST token of a title that
 * matches any family decides the kind, so "Write tests for x" is `write` (the object, not the verb
 * family of "tests"), while "Verify x" is `verify`.
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

/** How close two non-writer wordings of one artifact must be to count as the same deliverable. */
export const SAME_DELIVERABLE_SIMILARITY = 0.6;

function words(text: string): string[] {
	return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== "");
}

/** One artifact path, in the single form two proposals can be compared in. */
function canonicalArtifact(raw: string): string {
	return raw.trim().toLowerCase().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

const isAbsoluteArtifact = (path: string): boolean => path.startsWith("/") || /^[a-z]:\//.test(path);
const artifactName = (path: string): string => path.split("/").pop() ?? path;

/** Same artifact: identical paths, or an absolute and a bare path naming the same file. */
function sameArtifact(left: string, right: string): boolean {
	if (left === right) return true;
	return isAbsoluteArtifact(left) !== isAbsoluteArtifact(right) && artifactName(left) === artifactName(right);
}

function artifactsEqual(left: string[], right: string[]): boolean {
	if (left.length === 0 || left.length !== right.length) return false;
	const pool = [...right];
	for (const path of left) {
		const at = pool.findIndex((candidate) => sameArtifact(path, candidate));
		if (at < 0) return false;
		pool.splice(at, 1);
	}
	return true;
}

/** Jaccard over the significant words. An empty either side is 0: no evidence is not a match. */
function wordingSimilarity(left: string[], right: string[]): number {
	if (left.length === 0 || right.length === 0) return 0;
	const other = new Set(right);
	const shared = left.filter((word) => other.has(word)).length;
	return shared / new Set([...left, ...right]).size;
}

/**
 * Read a deliverable out of a title (and the artifact paths a proposal declared for it). Everything
 * here is pure and total: a title that names no artifact yields an empty artifact list, which the
 * matcher then refuses to pair with anything.
 */
export function describeDeliverable(title: string, files: string[] = [], deliverable = ""): DeliverableShape {
	const tokens = words(`${title} ${deliverable}`);
	let intent: DeliverableIntent = "other";
	for (const token of tokens) {
		const family = INTENT_VERBS.find(([, verbs]) => verbs.includes(token));
		if (family !== undefined) {
			intent = family[0];
			break;
		}
	}
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
 * Whether two proposal shapes are the same deliverable.
 *
 * Conservative by construction: an unknown kind (`other`) or a deliverable with no identifiable
 * artifact never matches anything, because a false merge loses work while a false split only costs
 * a duplicate task. On one artifact, two WRITERS are always one deliverable - an artifact has one
 * owner, so the reservation collisions of the live counterexample cannot happen by plan.
 */
export function isSameDeliverable(left: DeliverableShape, right: DeliverableShape): boolean {
	if (left.intent !== right.intent || left.intent === "other") return false;
	if (!artifactsEqual(left.artifacts, right.artifacts)) return false;
	if (left.intent === "write") return true;
	if (left.section !== right.section) return true;
	return wordingSimilarity(left.words, right.words) >= SAME_DELIVERABLE_SIMILARITY;
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
	return { entryId: entry.id, agentId: entry.agentId, goalId, tasks };
}

/**
 * Merge every proposal of one round into the deduped deliverable list.
 *
 * First proposal wins the title; a later one for the same deliverable only adds (files,
 * capabilities, dependencies, a longer description, review_required). "The same deliverable" is the
 * exact key when the phrasing matches and the shape rule ({@link isSameDeliverable}) when it does
 * not - so four agents writing one file in four phrasings yield one task, while two genuinely
 * different deliverables on one file (different kinds of work, or work that is not close enough)
 * stay apart. Dependency references are resolved the same way, so an agent may depend on a
 * deliverable another agent proposed under different wording; a reference to an unknown or to the
 * task's own title is dropped and reported.
 */
export function mergeProposals(proposals: Proposal[]): MergeResult {
	const order: string[] = [];
	const byKey = new Map<string, MergedTask>();
	const shapeByKey = new Map<string, DeliverableShape>();
	const rawDeps = new Map<string, string[]>();
	const folded: string[] = [];
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
			const target = byKey.has(key)
				? key
				: order.find((seen) => isSameDeliverable(shapeByKey.get(seen) as DeliverableShape, shape));
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
				shapeByKey.set(mergeKey, shape);
				order.push(mergeKey);
			} else {
				if (!folded.includes(mergeKey)) folded.push(mergeKey);
				const seen = shapeByKey.get(mergeKey) as DeliverableShape;
				// A section title must not stand for the whole artifact once the whole one is proposed.
				if (seen.section && !shape.section) {
					known.title = proposed.title;
					shapeByKey.set(mergeKey, { ...seen, section: false, words: shape.words });
				}
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
			let dep: string | undefined = exact !== "" && byKey.has(exact) ? exact : undefined;
			if (dep === undefined) {
				const wanted = describeDeliverable(raw);
				dep = order.find((seen) => isSameDeliverable(shapeByKey.get(seen) as DeliverableShape, wanted));
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
	return { tasks: order.map((key) => byKey.get(key) as MergedTask), proposals: proposals.length, folded, unresolved, empty };
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
		"4. The goal's agent count was only a starting guess: if the merged shape needs a different number of agents, ask with swarm_scale({ agents, reason }). The controller reconciles the pool on its next tick and clamps to config.workers.",
		`Bound: no plan within ${Math.round(deadlineMs / 60_000)} minute(s) of the goal closes it with a FAIL - the round never spins silently.`,
	].join("\n");
}
