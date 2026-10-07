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
 * Whether a `bash` command can change the repository.
 *
 * A literal list of mutations, not a shell parser. Two rules keep it from firing on a session that is
 * only READING: quoted literals are stripped first (a search that merely MENTIONS a verb — `rg -n "rm
 * -rf" docs/` — is not a mutation), and the verb tests are anchored at a COMMAND POSITION (the start of
 * the command, or of a `;`/`&&`/`||`/`|`/newline-separated segment), so `grep -n rm file` stays silent.
 * A redirection is a write wherever it appears once quotes are gone (`echo hi > f`), while `2>&1`
 * plumbing is not.
 *
 * The residual is deliberate and one-sided: a mutation hidden behind a string or a script
 * (`sh -c "rm -rf x"`, `bash build.sh`) is NOT detected, so the bias is towards silence — a missed
 * mutation costs one notice that never fires, a false positive costs noise in a session that was
 * only reading.
 */
const BASH_SEPARATORS = /;|&&|\|\||\||\n/;
/** Wrappers and leading `VAR=value` assignments that may precede the command word. */
const BASH_LEADING = /^(?:(?:sudo|command|env|nohup|time)\s+|\w+=\S*\s+)+/i;
const BASH_MUTATION_VERBS = /^(?:rm|rmdir|mv|cp|mkdir|touch|truncate|dd|chmod|chown|ln|tee|patch|rename|sed\s+-i|perl\s+-i)\b/i;
const BASH_GIT = /^git\s+(?:apply|checkout|commit|add|restore|reset|stash|clean|merge|rebase|switch|rm|mv|init|pull)\b/i;
const BASH_PACKAGES = /^(?:npm|bun|yarn|pnpm)\s+(?:i|install|add|remove|uninstall|upgrade|update)\b|^pip\s+install\b/i;
const BASH_POWERSHELL = /^(?:set-content|out-file|new-item|remove-item|copy-item|move-item|rename-item|add-content|clear-content)\b/i;
/** A real redirection: `>`/`>>` that is not the plumbing of `2>&1`-style redirection (quotes are gone). */
const BASH_REDIRECT = /(^|[^<>&])>>?(?!&)/;

/** Remove quoted literals so a search PATTERN cannot be read as a command or invent a separator. */
function withoutQuotedLiterals(command: string): string {
	return command.replace(/"[^"]*"|'[^']*'/g, '""');
}

/** Whether one command segment (already split and de-quoted) mutates files. */
function segmentMutates(segment: string): boolean {
	const clean = segment.replace(BASH_LEADING, "").trim();
	if (clean === "") return false;
	if (BASH_REDIRECT.test(clean)) return true;
	return (
		BASH_MUTATION_VERBS.test(clean) || BASH_GIT.test(clean) || BASH_PACKAGES.test(clean) || BASH_POWERSHELL.test(clean)
	);
}

/** Tools that write by definition; everything else is judged by its arguments (only `bash` has any). */
const WRITING_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true };

export function mutatesFiles(toolName: string, args: unknown): boolean {
	if (WRITING_TOOLS[toolName] === true) return true;
	if (toolName !== "bash") return false;
	if (args === null || typeof args !== "object" || !("command" in args)) return false;
	const command = args.command;
	if (typeof command !== "string") return false;
	return withoutQuotedLiterals(command).split(BASH_SEPARATORS).some(segmentMutates);
}

/** The reminder itself, on the surfaces the swarm already uses (`[swarm]` + a warning-level notice). */
export const COORDINATOR_EDIT_NOTICE =
	"[swarm] you are changing files while no goal is open: this is the workers' job - call swarm_goal({ goal, agents }) and let them split and claim it. (A reminder, not a gate: if the operator asked you to do it by hand, ignore this.)";
