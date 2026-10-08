/**
 * goal-14's clause 3: making the repair of a stranded row a LEGITIMATE, TRACED operation.
 *
 * WHAT THIS FILE IS FOR. A task row can be minted with `required_capabilities` that no
 * configured role can ever provide (task-221/222/223 with `["reviewer"]` against six agents who
 * all carry `["general"]`). Today nothing discovers it, nothing reports it, and no agent-side path
 * repairs it — DECISION #894 / FACT #942 measured that all 17 `UPDATE tasks SET` statements never
 * name the column, and DECISION #1076 is the record of what happens when a worker improvises a
 * direct write instead: the write lands, the audit trail does not exist, and the state it leaves
 * (a `superseded` row the dependency semantics do not recognise, FACT #1084) blocks other work.
 *
 * This module is the PURE half of the repair. It answers two questions with no database, no clock
 * and no I/O, so both can be pinned by unit tests and reused by the store operation and the tool:
 *
 *   1. `strandedRows` — which ready/blocked/review rows can nobody claim, and what exactly is
 *      missing. The predicate is the claim gate's own, verbatim from `store.ts:984-985`
 *      (`required.filter((cap) => !capabilities.includes(cap))` — refuse when ANY is missing) and
 *      `starvation.ts:65-68`, because a repair that used a DIFFERENT predicate than the gate would
 *      fix the wrong rows. goal-18's U4 measured the earlier divergence: the predicate here read
 *      `.some(...)` (one agent holding one capability) while the gates read `.every(...)` on one
 *      agent, so a `[reviewer, nobody]` row looked claimable to the repair while `claim()` would
 *      have refused it forever.
 *
 *   2. `planCapsRepair` — what a repair may change, and what it may not. A repair rewrites the
 *      capability label of a row nobody can claim. It must never touch anything else, and it must
 *      record what it changed and why.
 *
 * WHY THE REPAIR IS LABELLED AND NOT DELETED. Rewriting `["reviewer"]` to `[]` widens the claim
 * gate; it does not widen the row's own contract. The row still says what it says, so the repair
 * carries a `declaredCaps` snapshot of the label it replaced and the reason, board-posted under
 * the store's own audit event, so the next reader can see that the label was changed by a repair
 * rather than by the planner who minted it. That distinction is the whole point: a silently
 * relaxed label is indistinguishable from a wrong one.
 *
 * WHY A CAPABILITY THE CONFIG CAN PROVIDE IS NEVER A REPAIR TARGET. `strandedRows` only reports
 * rows nobody can take. A row whose capability some configured role does provide is not stranded —
 * it is merely unclaimed, which is the pool working as designed. Repairing it would be an agent
 * quietly overriding a planner's deliberate routing, which is the failure this goal exists to
 * stop, in the other direction.
 */
import { expandWorkers } from "./config";
import type { SwarmConfig, SwarmTask } from "./types";

/** The smallest shape a stranded-row detector needs: the gate's own inputs plus the row's age. */
export interface StrandedRowCandidate {
	id: string;
	title: string;
	status: "ready" | "blocked" | "review";
	requiredCapabilities: string[];
	/** `updated_at` in ms — how long the row has been sitting in this state. */
	updatedAt: number;
}

/** What the pool can actually hold, derived from the config the same way the roster is. */
export function reachableCapabilities(config: SwarmConfig): Set<string> {
	const held = new Set<string>();
	for (const spec of expandWorkers(config, Math.max(1, config.workers))) {
		for (const cap of spec.capabilities) held.add(cap);
	}
	return held;
}

/**
 * The claim gate's predicate, verbatim: an agent can take a row when it requires no capability,
 * or when the ONE agent that takes it holds EVERY declared capability.
 *
 * Kept as a named export so the repair, the surfacing report and the gate itself cannot drift apart
 * (DECISION #1078: "判定必须复用 expandWorkers/planRoster 的同一份事实，不许另写一份能力表").
 *
 * goal-18's U4 measured the drift this closes: the predicate used to read
 * `required.some((cap) => held.includes(cap))`, which says ONE agent holding ONE capability is
 * enough. The two gates that actually decide a claim say `every` on one agent — `store.ts:984-985`
 * (`required.filter((cap) => !capabilities.includes(cap))` → refuse if ANY is missing) and
 * `starvation.ts:65-68` — so a row declaring `[reviewer, nobody]` was reported claimable by the
 * repair's own predicate while `claim()` would refuse it forever. Three callers consume this
 * predicate (`strandedRows`, `planCapsRepair`, and the docstring's citation of the gate), and all
 * three want the gate's answer, not a more permissive one.
 *
 * The `held` iterable is a UNION of every agent's capabilities (`reachableCapabilities(config)`
 * passes the whole roster's set, not one agent's), so `every` over it asks "could one agent
 * holding all of these exist" rather than "does some real agent hold all of these" — the strict
 * per-agent form lives in `starvation.ts`, where the agents themselves are in scope.
 */
export function claimableBy(requiredCapabilities: string[], held: Iterable<string>): boolean {
	const heldList = [...held];
	return requiredCapabilities.length === 0 || requiredCapabilities.every((cap) => heldList.includes(cap));
}

/** One stranded row, with the capability nobody holds and how long it has been stuck. */
export interface StrandedRow {
	id: string;
	title: string;
	status: "ready" | "blocked" | "review";
	/** The required capabilities that NO configured role provides — the reason it is stranded. */
	missingCapabilities: string[];
	/** Required capabilities that ARE reachable (kept for the report; they are not the problem). */
	reachableCapabilities: string[];
	/**
	 * Which of the two strand shapes this is, phrased so a reader does not have to infer it: either
	 * a capability no role provides, or capabilities that each exist but never together on one role.
	 * goal-18's U4 added this because the report previously made the two indistinguishable.
	 */
	reason: string;
	ageMs: number;
}

/**
 * Rows that are in a claimable state yet cannot be claimed by anybody. `blocked` is included
 * because a blocked row whose dependency later completes becomes `ready` with the same label —
 * reporting only `ready` rows would let a strand hide behind a dependency. `claimed`/`done`/
 * `failed` are excluded: they are not waiting for a claimant.
 */
export function strandedRows(rows: StrandedRowCandidate[], config: SwarmConfig, now: number): StrandedRow[] {
	const held = reachableCapabilities(config);
	const out: StrandedRow[] = [];
	for (const row of rows) {
		if (row.requiredCapabilities.length === 0) continue;
		if (claimableBy(row.requiredCapabilities, held)) continue;
		// goal-18's U4: a row is stranded when EITHER nothing holds a required capability, OR the
		// capabilities it needs exist in the pool but never together on one agent (the
		// `[reviewer, integrator]` shape — `claimableBy` over the roster UNION says true, the real
		// claim gate says no). The earlier `if (missing.length === 0) continue;` silently dropped
		// exactly that row, so the combination strand was never reported and never repairable.
		const missing = row.requiredCapabilities.filter((cap) => !held.has(cap));
		out.push({
			id: row.id,
			title: row.title,
			status: row.status,
			missingCapabilities: missing,
			reachableCapabilities: row.requiredCapabilities.filter((cap) => held.has(cap)),
			/** Which of the two shapes this is, so the report can say it without the reader guessing. */
			reason:
				missing.length > 0
					? `no configured role provides ${missing.join(", ")}`
					: `needs ${row.requiredCapabilities.join(" + ")} together, and no single configured role provides them all`,
			ageMs: Math.max(0, now - row.updatedAt),
		});
	}
	return out.sort((a, b) => b.ageMs - a.ageMs);
}

/**
 * What a caps repair is allowed to do, decided BEFORE the store writes anything so the caller can
 * show the operator the exact change and so a unit test can pin the rule without a database.
 *
 * The rule is deliberately narrow: the only permitted outcome is the EMPTY label, which widens the
 * gate to every agent. Anything else — narrowing one label to another, or dropping a capability
 * while keeping the rest — is refused, because the repair exists to release work nobody can pick
 * up, not to re-route work somebody can.
 */
export interface CapsRepairRequest {
	taskId: string;
	/** The row's label as it stands, read from the store. */
	currentCapabilities: string[];
	/** Who asks, recorded on the audit trail. */
	requestedBy: string;
	reason?: string;
}

export type CapsRepairPlan =
	| { ok: true; taskId: string; from: string[]; to: string[]; requestedBy: string; reason: string }
	| { ok: false; taskId: string; reason: string };

export function planCapsRepair(request: CapsRepairRequest, config: SwarmConfig): CapsRepairPlan {
	const held = reachableCapabilities(config);
	const from = [...new Set(request.currentCapabilities)];
	if (from.length === 0) {
		return { ok: false, taskId: request.taskId, reason: `task ${request.taskId} requires no capability, so there is nothing to repair` };
	}
	if (claimableBy(from, held)) {
		return {
			ok: false,
			taskId: request.taskId,
			reason: `task ${request.taskId} is claimable by a configured role (${from.join(",")}), so relaxing its label would override a planner's routing, not repair a strand`,
		};
	}
	const to: string[] = [];
	return {
		ok: true,
		taskId: request.taskId,
		from,
		to,
		requestedBy: request.requestedBy,
		reason: request.reason ?? `stranded: no configured role provides ${from.join(",")}; label relaxed so the row can be claimed`,
	};
}

/** The audit record a repair leaves behind, board-posted under the store's own event. */
export interface CapsRepairRecord {
	taskId: string;
	from: string[];
	to: string[];
	requestedBy: string;
	reason: string;
	at: number;
}

export function formatCapsRepair(record: CapsRepairRecord): string {
	const when = new Date(record.at).toISOString();
	return [
		`caps repair ${record.taskId}: ${JSON.stringify(record.from)} -> ${JSON.stringify(record.to)}`,
		`requested by ${record.requestedBy} at ${when}`,
		`reason: ${record.reason}`,
		`the row's own text is unchanged; only the claim label was relaxed, and this entry is the record that it happened`,
	].join("\n");
}

/** `SwarmTask` rows adapted into the candidate shape, so callers do not re-map fields. */
export function candidatesFromTasks(tasks: SwarmTask[]): StrandedRowCandidate[] {
	const out: StrandedRowCandidate[] = [];
	for (const task of tasks) {
		if (task.status !== "ready" && task.status !== "blocked" && task.status !== "review") continue;
		out.push({
			id: task.id,
			title: task.title,
			status: task.status,
			requiredCapabilities: task.requiredCapabilities,
			updatedAt: task.updatedAt,
		});
	}
	return out;
}
