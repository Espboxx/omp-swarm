import type { BlackboardEntry, SwarmAgent, SwarmMessage, SwarmTask } from "./types";
import type { StatusSnapshot } from "./store";

function age(now: number, then: number): string {
	const seconds = Math.max(0, Math.round((now - then) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	return `${Math.round(seconds / 3600)}h`;
}

function truncate(text: string, width: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

/**
 * Earliest activity a snapshot proves: the oldest agent join OR the oldest claim it carries
 * (both live as long as the database does, so they match the lifetime `done` count).
 */
function activityStart(snapshot: StatusSnapshot): number | undefined {
	const stamps = [
		...snapshot.agents.map((a) => a.joinedAt),
		...snapshot.inFlight.flatMap((t) => (t.claimedAt === undefined ? [] : [t.claimedAt])),
	];
	return stamps.length === 0 ? undefined : Math.min(...stamps);
}

/**
 * Oldest completion the snapshot carries, or `undefined` when it carries none. `updatedAt` is
 * the completion time of a done task, so the newest N completions all fall inside
 * `age(now, completionStart)` - the window the throughput count belongs to.
 */
function completionStart(snapshot: StatusSnapshot): number | undefined {
	const stamps = snapshot.recentDone.map((t) => t.updatedAt);
	return stamps.length === 0 ? undefined : Math.min(...stamps);
}

/**
 * `task-17 3m` while the agent holds a claim (the age of its lease), `-` when it is not
 * working. The age comes from the task's `claimedAt` in the snapshot, so a task whose
 * record is missing still shows its id - never a made-up age.
 */
function taskProgress(agent: SwarmAgent, inFlight: SwarmTask[], now: number): string {
	if ((agent.status !== "working" && agent.status !== "reviewing") || !agent.currentTask) return "-";
	const since = inFlight.find((t) => t.id === agent.currentTask)?.claimedAt;
	return since === undefined ? agent.currentTask : `${agent.currentTask} ${age(now, since)}`;
}

export function renderPanel(snapshot: StatusSnapshot, maxLines = 10): string[] {
	const lines: string[] = [];
	const online = snapshot.agents.filter((a) => a.status !== "offline").length;
	lines.push(`SWARM ${snapshot.running ? "running" : "stopped"} · ${snapshot.agents.length} agents (${online} online)`);
	for (const agent of snapshot.agents.slice(0, 5)) {
		lines.push(
			` ${agent.id.padEnd(12)} ${agent.status.padEnd(9)} ${agent.role.padEnd(10)} ${taskProgress(agent, snapshot.inFlight, snapshot.now)} (hb ${age(snapshot.now, agent.heartbeatAt)})`,
		);
	}
	if (snapshot.agents.length > 5) lines.push(` … ${snapshot.agents.length - 5} more`);
	const c = snapshot.counts;
	lines.push(` READY ${c.ready}  CLAIMED ${c.claimed}  REVIEW ${c.review}  BLOCKED ${c.blocked}  DONE ${c.done}  FAILED ${c.failed}`);
	const board = Object.entries(snapshot.board)
		.sort()
		.map(([type, n]) => `${type} ${n}`)
		.join("  ");
	lines.push(` BOARD ${board === "" ? "-" : board}`);
	return lines.slice(0, maxLines);
}

export function renderAgents(agents: SwarmAgent[], now: number): string {
	if (agents.length === 0) return "No agents registered. Start a swarm with /swarm start.";
	const rows = agents.map(
		(a) =>
			`${a.id.padEnd(14)} ${a.status.padEnd(10)} ${a.role.padEnd(12)} task=${(a.currentTask ?? "-").padEnd(10)} hb=${age(now, a.heartbeatAt)} caps=[${a.capabilities.join(",")}]${a.worktree ? ` wt=${a.worktree}` : ""}`,
	);
	return ["AGENT          STATUS     ROLE         TASK", ...rows].join("\n");
}

export function renderTasks(tasks: SwarmTask[], now: number): string {
	if (tasks.length === 0) return "No tasks.";
	const header = "ID       STATUS   PRI  OWNER        AGE  TITLE";
	const rows = tasks.map((t) => {
		const owner = t.claimedBy ?? t.review.reviewer ?? "-";
		const flags = [
			t.status === "claimed" && t.claimedAt !== undefined ? `att=${t.attempts} run=${age(now, t.claimedAt)}` : "",
			t.dependencies.length > 0 ? `deps=${t.dependencies.join("+")}` : "",
			t.review.required ? `review=${t.review.status ?? "pending"}` : "",
			t.requiredCapabilities.length > 0 ? `caps=${t.requiredCapabilities.join(",")}` : "",
		]
			.filter(Boolean)
			.join(" ");
		return `${t.id.padEnd(8)} ${t.status.padEnd(8)} ${String(t.priority).padEnd(4)} ${owner.padEnd(12)} ${age(now, t.updatedAt).padEnd(4)} ${truncate(t.title, 46)}${flags ? `  [${flags}]` : ""}`;
	});
	return [header, ...rows].join("\n");
}

export function renderBoard(entries: BlackboardEntry[]): string {
	if (entries.length === 0) return "Blackboard is empty.";
	return entries
		.map((e) => {
			const tags = e.tags.length > 0 ? ` #${e.tags.join(" #")}` : "";
			const task = e.taskId ? ` (${e.taskId})` : "";
			return `#${e.id} ${e.type.padEnd(11)} ${e.agentId.padEnd(12)}${task}${tags}\n    ${truncate(e.content, 160)}`;
		})
		.join("\n");
}

export function renderInbox(messages: SwarmMessage[]): string {
	if (messages.length === 0) return "No unread messages.";
	return messages
		.map((m) => `#${m.id}${m.urgent ? " URGENT" : ""} from ${m.from}${m.taskId ? ` re ${m.taskId}` : ""}: ${truncate(m.body, 200)}`)
		.join("\n");
}

export function renderTaskDetail(task: SwarmTask): string {
	const lines = [
		`${task.id}  ${task.status}  priority=${task.priority}  attempts=${task.attempts}`,
		`title: ${task.title}`,
		`created by ${task.createdBy} at ${new Date(task.createdAt).toISOString()}`,
	];
	if (task.description) lines.push(`description: ${task.description}`);
	if (task.dependencies.length > 0) lines.push(`dependencies: ${task.dependencies.join(", ")}`);
	if (task.requiredCapabilities.length > 0) lines.push(`capabilities: ${task.requiredCapabilities.join(", ")}`);
	if (task.files.length > 0) lines.push(`files: ${task.files.join(", ")}`);
	if (task.claimedBy) lines.push(`claimed by ${task.claimedBy} until ${task.leaseUntil ? new Date(task.leaseUntil).toISOString() : "?"}`);
	if (task.review.required) lines.push(`review: ${task.review.status ?? "pending"}${task.review.reviewer ? ` by ${task.review.reviewer}` : ""}`);
	if (task.review.notes) lines.push(`review notes: ${task.review.notes}`);
	if (task.result) lines.push(`result: ${task.result}`);
	if (task.commit) lines.push(`commit: ${task.commit}`);
	return lines.join("\n");
}

/**
 * `throughput done 3 in 12m`. With completions on hand the count and the window describe the
 * same period: the completions the snapshot carries, over the oldest of their completion times.
 * With none carried, it falls back to the lifetime `done` count over the earliest window the
 * snapshot proves (oldest agent join or oldest claim) - the two halves only agree when the
 * database is as old as the count. With nothing provable the line keeps the count and drops the
 * `in` clause instead of inventing a duration.
 */
export function renderSummary(snapshot: StatusSnapshot): string {
	const c = snapshot.counts;
	const lines = renderPanel(snapshot, 10);
	lines.push("", `total tasks: ready ${c.ready}, claimed ${c.claimed}, review ${c.review}, blocked ${c.blocked}, done ${c.done}, failed ${c.failed}`);
	const inFlight = snapshot.inFlight.slice(0, 5);
	if (inFlight.length > 0) {
		lines.push("in flight:");
		for (const task of inFlight) {
			const claim = task.claimedAt !== undefined ? ` claimed=${age(snapshot.now, task.claimedAt)}` : "";
			lines.push(
				` ${task.id} ${task.status} owner=${task.claimedBy ?? task.review.reviewer ?? "-"} attempts=${task.attempts} elapsed=${age(snapshot.now, task.createdAt)}${claim}`,
			);
		}
		if (snapshot.inFlight.length > inFlight.length) lines.push(` … ${snapshot.inFlight.length - inFlight.length} more`);
	}
	// The completions on hand, over the oldest of their completion times; otherwise the lifetime
	// count over the earliest window the snapshot proves.
	const completion = completionStart(snapshot);
	const start = completion ?? activityStart(snapshot);
	const done = completion === undefined ? c.done : snapshot.recentDone.length;
	lines.push(start === undefined ? `throughput done ${done}` : `throughput done ${done} in ${age(snapshot.now, start)}`);
	return lines.join("\n");
}
