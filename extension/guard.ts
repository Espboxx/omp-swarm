/**
 * The coordinator's own hands: a behavioural NOTICE for the one escape prose cannot close.
 *
 * `SWARM_POLICY` and `SWARM_NUDGE` ask the coordinator to open a goal and let the workers execute; a
 * model can ignore both (the live counterexample: a specification-shaped prompt executed by the
 * coordinator itself, 46 turns / 68 tool calls / no goal). This module is the guard that looks at what
 * the session actually DOES: while multi-agent mode is on, no goal is open and no pool is running, a
 * MAIN session that starts a file-mutating tool is doing the workers' job, and gets told once per turn.
 *
 * It is a REMINDER, never a gate: nothing here can refuse, block or slow a tool call, and an
 * operator-driven direct edit is noise the operator may ignore. Everything is pure so the decision can
 * be unit-tested without a session (see `tests/unit/coordinator-guard.test.ts`).
 */

export interface CoordinatorEditInput {
	/** Multi-agent mode is ON for this root (`/swarm on`). */
	modeOn: boolean;
	/** The session running the tool is the MAIN session — a worker must never be told this. */
	sessionIsMain: boolean;
	/** A live goal exists: the planning round is the coordinator's job, not the files. */
	goalOpen: boolean;
	/** A pool is running: the workers are already at work. */
	poolRunning: boolean;
	/** Whether the tool call can create, change or delete a file (see {@link mutatesFiles}). */
	mutatesFiles: boolean;
	/** Whether this turn already produced the notice — the caller latches it per turn. */
	notifiedThisTurn: boolean;
}

export type CoordinatorEditDecision = "notify" | "silent";

/** `notify` only for a main-session file edit with neither a goal nor a pool to do the work. */
export function decideCoordinatorEdit(input: CoordinatorEditInput): CoordinatorEditDecision {
	if (!input.modeOn || !input.sessionIsMain) return "silent";
	if (input.goalOpen || input.poolRunning) return "silent";
	if (!input.mutatesFiles || input.notifiedThisTurn) return "silent";
	return "notify";
}

/**
 * Whether a `bash` command can change the repository. Deliberately a CONSERVATIVE list of literal
 * mutations (redirection, in-place editors, file commands, package installs, git state changes) rather
 * than an attempt to parse shell: a missed case costs one notice, a false positive costs noise in a
 * session that was only reading, so the list errs towards silence.
 */
const BASH_MUTATION = /(^|[^<])>{1,2}[^&|]|\btee\b|\bsed\s+-i\b|\brm\b|\bmv\b|\bcp\b|\bmkdir\b|\btouch\b|\btruncate\b|\bdd\b|\bchmod\b|\bSet-Content\b|\bOut-File\b|\bNew-Item\b|\bRemove-Item\b|\bCopy-Item\b|\bMove-Item\b|\bgit\s+(apply|checkout|commit|add|restore|reset|stash|clean|merge|rebase)\b|\b(npm|bun|yarn|pnpm)\s+(i|install|add|remove|uninstall)\b|\bpip\s+install\b/i;

/** Tools that write by definition; everything else is judged by its arguments (only `bash` has any). */
const WRITING_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true };

export function mutatesFiles(toolName: string, args: unknown): boolean {
	if (WRITING_TOOLS[toolName] === true) return true;
	if (toolName !== "bash") return false;
	if (args === null || typeof args !== "object" || !("command" in args)) return false;
	const command = args.command;
	return typeof command === "string" && BASH_MUTATION.test(command);
}

/** The reminder itself, on the surfaces the swarm already uses (`[swarm]` + a warning-level notice). */
export const COORDINATOR_EDIT_NOTICE =
	"[swarm] you are changing files while no goal is open: this is the workers' job - call swarm_goal({ goal, agents }) and let them split and claim it. (A reminder, not a gate: if the operator asked you to do it by hand, ignore this.)";
