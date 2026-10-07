/**
 * The goal-9 planning round, verbatim: the three board proposals of task-198 (#760 CalmTiger,
 * #761 SwiftTiger, #762 BrightTiger) copied out of .swarm/swarm.db unchanged - titles, descriptions,
 * file lists, review flags and dependency edges included. A FIXTURE, not prose: it is the round that
 * minted 13 rows through the title-keyed merge, so it pins both halves of task-224 (a re-takeover
 * must still recognise the pool row that absorbed its spellings, and the merge must not mint a
 * second owner).
 */

export interface RoundTask {
	title: string;
	deliverable?: string;
	files?: string[];
	depends_on?: string[];
	capabilities?: string[];
	review_required?: boolean;
}

export interface RoundEntry {
	id: number;
	agentId: string;
	tasks: RoundTask[];
}

export const GOAL9_ENTRIES: RoundEntry[] = [
	{
		id: 760,
		agentId: "CalmTiger",
		tasks: [
			{
				title: "Fix goal-9: payload-bound one-shot vote tickets + identity-checked, gated roster growth (SINGLE WRITER)",
				deliverable: "One commit that closes both highs and both minors, with failing-first tests: (1) store.ts passedVote/voteGate binds a ticket to (kind + normalized payload digest / target id) and CONSUMES it once in the same transaction as the action it authorises — replay and payload-swap both refused, no TOCTOU window; (2) spawn/stop/scale and the goal's agents budget go through the vote gate, swarm_goal gets an identity check (who may open a goal / set N) and the exemption rule is written down; (3) minor ① an offline voter is named 'voter offline', not silently 'absent' (count by validity at ballot time); (4) minor ② the {for,against,absent} tally is visible on the normal read path (recentEvents keeps data) or is explicitly documented. ORDERING NOTE: task-197 (lazy settle on read) also holds extension/store.ts and MUST land first — take it or fold it before writing; an UNOWNED WIP in the working tree (store.ts/tools.ts/vote-store.test.ts: offline-ballot counting via offlineAfterSeconds) must be reconciled (adopt+commit or discard), never silently overwritten. Write domain: extension/** + tests/unit/** only, no new deps; suite must be green with real numbers.",
				capabilities: ["general"],
				files: ["omp-swarm/extension/store.ts","omp-swarm/extension/tools.ts","omp-swarm/extension/auto.ts","omp-swarm/extension/planning.ts","omp-swarm/tests/unit/vote-store.test.ts","omp-swarm/tests/unit/vote-gate.test.ts"],
				review_required: true,
			},
			{
				title: "Verify goal-9 A: non-author adversarial re-attempt at the tool layer (replay / payload-swap / TOCTOU concurrency)",
				deliverable: "scratch/goal9-verify/tool-layer/{VERDICT.md,adversarial.ts,run-output.json}: a NEW adversarial attempt against the fixed tree through the real tool layer (buildSwarmTools per identity, frozen archive/mkdtemp roots) trying other replay, payload-swap, race and identity paths; the required concurrency case (two executors consume the SAME ticket at once -> exactly ONE succeeds and the other gets an explicit refusal, never two successes); plus a re-check that the surviving behaviours still hold (self-vote invalid, duplicate ballot refused, cross-kind reuse refused, an offline peer cannot stall the bound, a late ballot cannot resurrect a failed round, a failed round executes nothing and posts the full tally to board+events).",
				capabilities: ["general"],
				files: ["scratch/goal9-verify/tool-layer/"],
				depends_on: ["Fix goal-9: payload-bound one-shot vote tickets + identity-checked, gated roster growth (SINGLE WRITER)"],
			},
			{
				title: "Verify goal-9 B: roster growth + vote-wait liveness in a REAL controller process",
				deliverable: "scratch/goal9-verify/roster/{REPORT.md,harness.ts,logs}: drive the REAL AutoController (not [INFERENCE] as task-196 had to) and measure: the roster cannot grow via spawn/stop/scale without a ballot; an agent cannot raise a goal's agents budget without the gate/identity check; and zero model calls happen while a round waits for votes (wiring-layer evidence, not just pure logic). Each claim carries the raw command/log line that shows it.",
				capabilities: ["general"],
				files: ["scratch/goal9-verify/roster/"],
				depends_on: ["Fix goal-9: payload-bound one-shot vote tickets + identity-checked, gated roster growth (SINGLE WRITER)"],
			},
			{
				title: "Docs goal-9: ask the coordinator for the README write domain, then document the operator-visible rule change",
				deliverable: "The operator-visible consequence of the new gates documented in the READMEs (which calls now need a vote_id, what the identity rule is, the seed exemption), after first reporting the need and getting a write domain assigned by the coordinator; if the domain is refused, the row reports that fact with the exact text to paste instead of editing. Must not restate numbers it did not measure (test counts come from the green run).",
				capabilities: ["general"],
				files: ["omp-swarm/README.md"],
				depends_on: ["Fix goal-9: payload-bound one-shot vote tickets + identity-checked, gated roster growth (SINGLE WRITER)"],
			},
		],
	},
	{
		id: 761,
		agentId: "SwiftTiger",
		tasks: [
			{
				title: "Fix vote tickets: bind each round to the payload it voted on and consume it inside the action's own transaction (extension/store.ts)",
				deliverable: "extension/store.ts: a passed round stops being a standing permission. The gate compares the round's frozen payload (votes.payload, already stored) with the normalised payload/target of THIS call and consumes the round exactly once, in the same transaction as the gated action (no TOCTOU): replay of the same ticket and payload-swap both get an explicit refusal; a concurrent second consumer loses. Because db.ts only ever runs CREATE TABLE IF NOT EXISTS (no ALTER for an existing DB), the consumption marker must be a NEW table or the existing result/status, never a new column on votes. Fold in the two secondary items on the same artifact: (a) a ballot discarded because its voter went offline is NAMED as 'voter offline' in the vote_failed reason instead of silently reading as absent; (b) the {for,against,absent} tally is visible on the normal read path (recentEvents keeps its data). Failing-then-passing repro + unit tests, including 'two consumers, exactly one wins'. NOTE: same artifact as live row task-197 (lazy settle on read; its edits are ALREADY uncommitted in the working tree at extension/store.ts:1410-1580) — fold task-197 into this row or land it first; never two writers on store.ts.",
				capabilities: ["general"],
				files: ["omp-swarm/extension/store.ts","omp-swarm/tests/unit/vote-store.test.ts","omp-swarm/extension/db.ts"],
				review_required: true,
			},
			{
				title: "Wire every remaining decision point to the round: gate the ticket in tools.ts, gate spawn/stop + the goal agents budget, and check identity on swarm_goal (extension/tools.ts + auto.ts + driver.ts)",
				deliverable: "extension/tools.ts: voteGate(kind, voteId, params) passes the call's own payload/target to the bound ticket and consumes it; call sites 314 (close-task), 345 (create-task), 504 (scale) updated; spawn/stop gain a real gate (VOTE_KINDS already lists them at tools.ts:837-838 but no call site consults them). extension/auto.ts + driver.ts: the roster growth path planRoster(tasks, config, goalAgents) (auto.ts:355/373/465) must stop being reachable with no ballot — either route it through a spawn round or write the seed-authority exemption explicitly and narrow it, and close the 'any agent raises goalAgents via swarm_goal' hole (tools.ts:380-400) with an identity check plus a written rule for who may open a goal and set N. Tests for each claimed decision point (allowed only with a bound, consumed, matching ticket; refused without), plus the negative case for a second consumer.",
				capabilities: ["general"],
				files: ["omp-swarm/extension/tools.ts","omp-swarm/extension/auto.ts","omp-swarm/extension/driver.ts","omp-swarm/tests/unit/tools.test.ts","omp-swarm/tests/unit/auto.test.ts"],
				depends_on: ["Fix vote tickets: bind each round to the payload it voted on and consume it inside the action's own transaction (extension/store.ts)"],
				review_required: true,
			},
			{
				title: "Non-author adversarial re-verification of the fixed tree: replay, payload swap, concurrent consume, identity paths, and the roster claim driven for real",
				deliverable: "A verifier who wrote neither the store fix nor the wiring attacks the FROZEN tree (git archive HEAD) through the real tool layer from an isolated mkdtemp root, on its own scripts under scratch/goal9-verify/: (1) reuse one passed round for a second create-task AND for a close-task on another agent's row; (2) swap payload under the same ticket; (3) two consumers of one ticket concurrently -> exactly one succeeds, the other gets an explicit refusal, never two successes; (4) try to reach an ungated spawn/stop/goal-agents growth by an identity path; (5) drive a real pool process to prove the roster/gate conclusion instead of inferring it from planRoster's reading. Verdict file with per-attack measured results, the surviving behaviours re-checked (self-vote, duplicate ballot, cross-kind reuse, offline peer, late ballot, failed round executes nothing), and its unverified boundary stated honestly.",
				capabilities: ["general"],
				files: ["omp-swarm/scratch/goal9-verify/VERDICT.md","omp-swarm/scratch/goal9-verify/adversarial.ts"],
				depends_on: ["Fix vote tickets: bind each round to the payload it voted on and consume it inside the action's own transaction (extension/store.ts)","Wire every remaining decision point to the round: gate the ticket in tools.ts, gate spawn/stop + the goal agents budget, and check identity on swarm_goal (extension/tools.ts + auto.ts + driver.ts)"],
				review_required: true,
			},
			{
				title: "Document the operator-visible boundary change: one decision = one one-shot round, spawn/stop included (README parity)",
				deliverable: "README(s) updated on the facts the fix changes: a cluster-level decision costs a round, the ticket is one-shot and payload-bound, spawn/stop and the goal agents budget are inside the rule, and the 2-agent pool means unanimity; plus the stale suite numbers flagged in board #735. WRITE DOMAIN: README is outside extension/** and tests/unit/**, so this row may be edited only after the coordinator grants the domain (a passed create-task round); if the grant is refused, close the row with that reason instead of editing.",
				capabilities: ["general"],
				files: ["omp-swarm/README.md","omp-swarm/extension/README.md"],
				depends_on: ["Wire every remaining decision point to the round: gate the ticket in tools.ts, gate spawn/stop + the goal agents budget, and check identity on swarm_goal (extension/tools.ts + auto.ts + driver.ts)"],
				review_required: true,
			},
		],
	},
	{
		id: 762,
		agentId: "BrightTiger",
		tasks: [
			{
				title: "Fix: a passed vote is bound to its payload and consumed once (kill ticket replay)",
				deliverable: "extension/store.ts + extension/tools.ts (+ regression tests). Consent must bind to the DECISION, not the KIND: put a normalized payload digest (kind + canonical payload / target id) on the vote row and make passedVote/voteGate require (a) status=passed, (b) kind matches, (c) THIS call's payload digest equals the voted digest, (d) the ticket is not yet consumed; consumption must happen in the SAME transaction as the action (no TOCTOU) and be one-shot. Replay of the same payload and reuse for a different payload are both refused with a clear reason. Regression test that FAILS before and PASSES after reproduces VERDICT §3 exactly: one 2/2 pass on ALPHA executes exactly one action; feeding the same vote_id to task_create twice more creates nothing; the same ticket cannot close somebody else's row. Prove the pre-existing guarantees still hold (self-vote invalid, duplicate ballot refused, cross-kind reuse refused, late ballot cannot revive).",
				capabilities: ["general"],
				files: ["omp-swarm/extension/store.ts","omp-swarm/extension/tools.ts","omp-swarm/tests/unit/vote-store.test.ts","omp-swarm/tests/unit/tools.test.ts"],
			},
			{
				title: "Fix: roster growth and the goal size budget must pass a vote; swarm_goal checks identity",
				deliverable: "extension/auto.ts + extension/tools.ts (the swarm_goal identity check) + tests. grep -n vote extension/auto.ts is 0 today and planRoster(tasks, config, goalAgents) grows the pool with no vote at all, while swarm_goal (tools.ts:380-400) validates no identity, so any agent can raise N. Route spawn/stop/roster growth and the goal agents budget through the vote gate, OR write down and implement an explicit seed-authority exemption WITH its reason - 'any agent may raise N' is not an exemption, it is the hole. Add the identity check to swarm_goal and state the rule in the tool description. Tests: with no vote the roster does not grow; an approved spawn vote does grow it; an unauthorized swarm_goal is refused. Depends on the vote-gate task because it reuses that gate and touches tools.ts.",
				capabilities: ["general"],
				files: ["omp-swarm/extension/auto.ts","omp-swarm/extension/tools.ts","omp-swarm/tests/unit/auto.test.ts","omp-swarm/tests/unit/tools.test.ts"],
				depends_on: ["Fix: a passed vote is bound to its payload and consumed once (kill ticket replay)"],
			},
			{
				title: "Fix: the tally is visible on the normal read path, and an offline voter is named, not silently dropped",
				deliverable: "extension/store.ts (recentEvents keeps data) + extension/voting.ts/store.ts (count a ballot by the voter's eligibility AT CAST TIME, or name it 'voter offline' instead of 'absent') + tests. Two defects from VERDICT §4/§5.2: recentEvents() returns {id,type,agentId,createdAt} with no data, so {for,against,absent} can only be read from the raw events table or the board; and when a voter goes offline after voting, their real yes is retroactively dropped with no reason in vote_failed. Fix or explicitly document each on the normal read path. Depends on the two fixes above (single writer on extension/**).",
				capabilities: ["general"],
				files: ["omp-swarm/extension/store.ts","omp-swarm/extension/voting.ts","omp-swarm/tests/unit/store.test.ts","omp-swarm/tests/unit/voting.test.ts"],
				depends_on: ["Fix: roster growth and the goal size budget must pass a vote; swarm_goal checks identity"],
			},
			{
				title: "Verify (non-author): adversarial re-attack on the fixed tree - replay, race, identity",
				deliverable: "scratch/goal9-verify/{VERDICT.md,adversarial.ts,run-output.json}. A NON-AUTHOR of every fix above re-runs the attacks on the frozen tree (git archive HEAD into mkdtemp, never touching .swarm) and adds the ones the previous round left untested: (1) concurrent consumption - two executors consuming the SAME ticket at once must yield exactly one success and one explicit refusal, never two successes; (2) can any replay/race/identity path still get an action through unvoted? (3) does the fix survive a payload that differs only in normalization (whitespace/order/alias)? Every remaining 'held' claim needs its own measured row; unresolved ones are reported as [INFERENCE] with why. Depends on all three fix tasks.",
				capabilities: ["general"],
				files: ["omp-swarm/scratch/goal9-verify/VERDICT.md","omp-swarm/scratch/goal9-verify/adversarial.ts","omp-swarm/scratch/goal9-verify/run-output.json"],
				depends_on: ["Fix: a passed vote is bound to its payload and consumed once (kill ticket replay)","Fix: roster growth and the goal size budget must pass a vote; swarm_goal checks identity","Fix: the tally is visible on the normal read path, and an offline voter is named, not silently dropped"],
				review_required: true,
			},
			{
				title: "Verify (non-author): drive the REAL AutoController process - roster growth and zero model calls during a wait",
				deliverable: "scratch/goal9-wiring/{EVIDENCE.md,drive-roster.ts,run-output.json}. The earlier roster verdict was [INFERENCE] because AutoController was never driven, and 'zero model calls while waiting for a vote' was only proven in pure logic. Start a real pool on an isolated root and measure, end to end: does the roster actually grow/shrink per the vote gate (spawn/stop) after the fix, and is the wake/model-call count flat while a round waits (t0 / +15s / +30s / +80s) and moves only when a ballot lands? Report the raw counts, not a narrative; anything not driven gets marked [INFERENCE] with the reason. Depends on the roster vote-gate fix; independent of the other verifier so the two can run in parallel.",
				capabilities: ["general"],
				files: ["omp-swarm/scratch/goal9-wiring/EVIDENCE.md","omp-swarm/scratch/goal9-wiring/drive-roster.ts","omp-swarm/scratch/goal9-wiring/run-output.json"],
				depends_on: ["Fix: roster growth and the goal size budget must pass a vote; swarm_goal checks identity"],
				review_required: true,
			},
		],
	},
];
