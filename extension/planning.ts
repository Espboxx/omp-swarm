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
 * The scribe's dedupe key, in one place because the policy text, the tool descriptions and the
 * merged DECISION all have to state the same rule: two proposals that name the same deliverable
 * (same normalized title) become ONE task, with files/capabilities/dependencies unioned into it.
 */
export const DEDUPE_KEY_TEXT =
	"the dedupe key is the normalized title (lowercase, whitespace collapsed, trailing punctuation stripped): two proposals naming the same deliverable become ONE task, with files, capabilities and dependencies unioned and the longest description kept";

/** Stable name of a deliverable: the same title in any casing/spacing is the same deliverable. */
export function deliverableKey(title: string): string {
	return title.trim().toLowerCase().replace(/\s+/g, " ").replace(/[\s.;:,!?]+$/, "");
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
 * First proposal wins the title; a later one for the same key only adds (files, capabilities,
 * dependencies, a longer description, review_required). Dependency references are resolved by the
 * same key, so an agent may depend on a deliverable another agent proposed; a reference to an
 * unknown or to the task's own title is dropped and reported.
 */
export function mergeProposals(proposals: Proposal[]): MergeResult {
	const order: string[] = [];
	const byKey = new Map<string, MergedTask>();
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
			const known = byKey.get(key);
			if (known === undefined) {
				byKey.set(key, {
					key,
					title: proposed.title,
					deliverable: proposed.deliverable?.trim() || undefined,
					capabilities: [...(proposed.capabilities ?? [])],
					files: [...(proposed.files ?? [])],
					dependsOn: [],
					reviewRequired: proposed.reviewRequired === true,
					agents: [proposal.agentId],
				});
				order.push(key);
			} else {
				if (!folded.includes(key)) folded.push(key);
				const deliverable = proposed.deliverable?.trim() ?? "";
				if (deliverable.length > (known.deliverable?.length ?? 0)) known.deliverable = deliverable;
				known.capabilities = [...new Set([...known.capabilities, ...(proposed.capabilities ?? [])])];
				known.files = [...new Set([...known.files, ...(proposed.files ?? [])])];
				if (proposed.reviewRequired === true) known.reviewRequired = true;
				if (!known.agents.includes(proposal.agentId)) known.agents.push(proposal.agentId);
			}
			rawDeps.set(key, [...(rawDeps.get(key) ?? []), ...(proposed.dependsOn ?? [])]);
		}
	}
	for (const key of order) {
		const deps: string[] = [];
		for (const raw of rawDeps.get(key) ?? []) {
			const dep = deliverableKey(raw);
			// A dependency inside the same round can only be a reference to another deliverable of
			// this round; anything else (own title, a typo, a stale id) is dropped and reported.
			if (dep === "" || dep === key || !byKey.has(dep)) {
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
		`Bound: no plan within ${Math.round(deadlineMs / 60_000)} minute(s) of the goal closes it with a FAIL - the round never spins silently.`,
	].join("\n");
}
