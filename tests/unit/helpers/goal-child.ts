/**
 * Child-process driver for the scribe race: claim the goal's planning task, then merge the round.
 * Two OS processes are the only way to observe the election for real — `planGoal` is synchronous, so
 * an in-process test can only call it twice in sequence, which is not a race.
 *
 * Usage: bun run tests/unit/helpers/goal-child.ts --root DIR --goal goal-1 --agent A [--start EPOCH_MS]
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
const goalId = arg("goal");
const agent = arg("agent");
const startAt = Number(arg("start", "0"));
const paths = swarmPaths(root);
const store = new SwarmStore(openDatabase(paths), paths);

const wait = startAt - Date.now();
if (wait > 0) await Bun.sleep(wait);

const goal = store.getGoal(goalId);
if (goal === undefined) throw new Error(`unknown goal ${goalId}`);
const claim = store.claim(goal.planningTask, agent, 300, ["general"]);
const plan = claim.ok ? store.planGoal(goalId, agent) : undefined;
console.log(
	JSON.stringify({
		agent,
		claimed: claim.ok,
		planned: plan?.ok === true,
		created: plan?.created.length ?? 0,
		reason: plan?.reason ?? claim.reason,
	}),
);
store.close();
