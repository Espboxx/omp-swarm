/**
 * Starvation: ready work that NO online agent can claim.
 *
 * A `ready` row demanding a capability no online agent holds cannot be taken by anybody, yet
 * `counts.ready` still counts as actionable — so the stall notice never fires and the pool sits
 * silently next to work it can never pick up. That is not a stall (the rows are legitimate, they are
 * only unroutable) and growth cannot fix it: the roster is minted from the plan's own role order,
 * never from an individual row's capability string. The honest response is to report it.
 *
 * Pure and clock-injected, so the rule can be unit-tested without a pool: the caller passes the ready
 * rows, the agents and the offline window it already has.
 */
import type { SwarmAgent, SwarmTask } from "./types";

export interface UnclaimableRow {
	id: string;
	requiredCapabilities: string[];
	/** The declared capabilities no ONLINE agent holds — what a human would have to add or change. */
	missing: string[];
	/** Why this row cannot be claimed, phrased so it is true in every case (see below). */
	why: string;
}

export interface StarvationReport {
	/**
	 * Stable identity of this condition: the sorted (row id, missing capability) pairs. The controller
	 * emits one notice per distinct key, so a repeating tick is silent but a changed row set reports again.
	 */
	key: string;
	rows: UnclaimableRow[];
	/** Union of every missing capability, sorted. Empty only when no agent is online at all. */
	missing: string[];
	/** How many agents were online while this was decided (0 means "nobody is here", not "wrong caps"). */
	online: number;
}

export interface StarvationInput {
	ready: SwarmTask[];
	agents: SwarmAgent[];
	/** The caller's clock. */
	now: number;
	/** Heartbeat age past which an agent is offline for every reader (`config.offlineAfterSeconds`). */
	offlineAfterMs: number;
}

/**
 * Report the ready rows nobody online can claim, or `undefined` when the pool is fine.
 *
 * `undefined` means one of: nothing is ready; at least one ready row is claimable by an online agent
 * (which is queueing, not starvation — a BUSY capable agent is exactly that); or at least one ready
 * row declares no capabilities at all and somebody is online to take it.
 *
 * An OFFLINE agent does not count, even when it holds the capability: it is not in a position to
 * claim today, so a pool whose only reviewer has gone offline is starved and should say so.
 */
export function findStarvation(input: StarvationInput): StarvationReport | undefined {
	if (input.ready.length === 0) return undefined;
	// No agent has registered yet: the pool is still assembling (or it never came up), which the driver's
	// own start/registration path owns. Reporting starvation here would fire on every tick of the gap
	// between `startSwarm` and the first registration, which is noise, not a finding.
	if (input.agents.length === 0) return undefined;
	const online = input.agents.filter(
		(agent) => agent.status !== "offline" && agent.heartbeatAt >= input.now - input.offlineAfterMs,
	);
	const claimableByOne = (task: SwarmTask): boolean =>
		online.length > 0 &&
		(task.requiredCapabilities.length === 0 ||
			online.some((agent) => task.requiredCapabilities.every((cap) => agent.capabilities.includes(cap))));
	if (input.ready.some(claimableByOne)) return undefined;

	const rows: UnclaimableRow[] = input.ready.map((task) => {
		const missing = task.requiredCapabilities.filter((cap) => !online.some((agent) => agent.capabilities.includes(cap)));
		// Three ways a row can be unroutable, and the notice must be true in all of them: a capability
		// nobody holds, no agent online at all, or capabilities that exist in the pool but never on ONE
		// agent (claim() requires every declared capability on the single agent that takes it).
		const why =
			online.length === 0
				? "no agent is online to claim it"
				: missing.length > 0
					? `nobody online holds ${missing.join(", ")}`
					: `needs ${task.requiredCapabilities.join(" + ")} together, and no single online agent holds them all`;
		return { id: task.id, requiredCapabilities: [...task.requiredCapabilities], missing, why };
	});
	const missing = [...new Set(rows.flatMap((row) => row.missing))].sort();
	const key = rows
		.map((row) => `${row.id}:${[...row.missing].sort().join("+")}`)
		.sort()
		.join("|");
	return { key, rows, missing, online: online.length };
}
