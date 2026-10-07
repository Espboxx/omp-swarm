/**
 * Child-process driver for the TICKET race: two OS processes try to spend ONE passed round, and exactly
 * one may act on it (goal-9). Two OS processes are the only way to observe this for real — bun:sqlite is
 * synchronous, so an in-process test can only call `consumeVote` twice in sequence, which is not a race.
 *
 * `--hold` makes the winner sit inside its transaction for that long, so the loser is guaranteed to
 * arrive while the ticket is being spent rather than after it: the assertion is then about the LOCK and
 * the primary key, not about how fast the machine happened to be.
 *
 * Usage: bun run tests/unit/helpers/vote-race-child.ts --root DIR --vote vote-1 --agent A [--start EPOCH_MS] [--hold MS]
 */
import { openDatabase, swarmPaths } from "../../../extension/db";
import { SwarmStore } from "../../../extension/store";

function arg(name: string, fallback?: string): string {
	const index = process.argv.indexOf(`--${name}`);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	if (value === undefined) {
		if (fallback === undefined) throw new Error(`missing --${name}`);
		return fallback;
	}
	return value;
}

const root = arg("root");
const voteId = arg("vote");
const agent = arg("agent");
const startAt = Number(arg("start", "0"));
const hold = Number(arg("hold", "0"));
const paths = swarmPaths(root);
const store = new SwarmStore(openDatabase(paths), paths);

const wait = startAt - Date.now();
if (wait > 0) await Bun.sleep(wait);
const began = Date.now();

// The gate the live `swarm_goal` uses: a `spawn` round for a budget of 2, spent on one goal.
const spent = store.consumeVote({
	kind: "spawn",
	voteId,
	payload: { agents: 2 },
	consumedBy: agent,
	offlineAfterSeconds: 60,
	action: () => {
		// Synchronous on purpose: the transaction must still be open while this holds, or the loser would
		// simply arrive after the commit and the race would not be tested at all.
		if (hold > 0) Bun.sleepSync(hold);
		return store.createGoal({ goal: `race ${agent}`, agents: 2, createdBy: agent });
	},
});

console.log(
	JSON.stringify({
		agent,
		ok: spent.ok,
		reason: spent.ok ? undefined : spent.reason,
		goal: spent.ok ? spent.value.goal.id : undefined,
		ms: Date.now() - began,
	}),
);
store.close();
