/** Domain types shared by the swarm store, tools, driver, and renderers. */

export type TaskStatus = "ready" | "claimed" | "blocked" | "review" | "done" | "failed";

export type AgentStatus = "idle" | "working" | "reviewing" | "blocked" | "waiting" | "offline";

export type BoardType =
	| "FACT"
	| "FAIL"
	| "OBSERVATION"
	| "CLAIM"
	| "RESULT"
	| "QUESTION"
	| "REVIEW"
	| "DECISION";

export interface SwarmTask {
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
	priority: number;
	createdBy: string;
	createdAt: number;
	updatedAt: number;
	claimedBy?: string;
	claimedAt?: number;
	leaseUntil?: number;
	dependencies: string[];
	requiredCapabilities: string[];
	files: string[];
	result?: string;
	commit?: string;
	review: {
		required: boolean;
		reviewer?: string;
		status?: "pending" | "approved" | "rejected";
		notes?: string;
	};
	attempts: number;
}

export interface SwarmAgent {
	id: string;
	sessionId?: string;
	role: string;
	status: AgentStatus;
	capabilities: string[];
	currentTask?: string;
	worktree?: string;
	pid?: number;
	joinedAt: number;
	heartbeatAt: number;
}

export interface BlackboardEntry {
	id: number;
	type: BoardType;
	agentId: string;
	taskId?: string;
	content: string;
	tags: string[];
	files: string[];
	createdAt: number;
}

export interface SwarmMessage {
	id: number;
	to: string;
	from: string;
	body: string;
	urgent: boolean;
	taskId?: string;
	createdAt: number;
	readAt?: number;
}

export interface Reservation {
	id: number;
	pattern: string;
	owner: string;
	taskId?: string;
	leaseUntil: number;
	createdAt: number;
}

export interface SwarmEvent {
	id: number;
	type: string;
	agentId?: string;
	taskId?: string;
	data: Record<string, unknown>;
	createdAt: number;
}

export interface TaskCounts {
	ready: number;
	claimed: number;
	blocked: number;
	review: number;
	done: number;
	failed: number;
}

export interface ClaimResult {
	ok: boolean;
	reason?: string;
	task?: SwarmTask;
}

export interface RoleConfig {
	name: string;
	count: number;
	capabilities?: string[];
}

export interface SwarmConfig {
	workers: number;
	leaseSeconds: number;
	heartbeatSeconds: number;
	offlineAfterSeconds: number;
	idleTickSeconds: number;
	review: boolean;
	/** Multi-agent mode: the next user task is decomposed into swarm tasks that start on their own. */
	auto: boolean;
	worktrees: boolean;
	model?: string;
	thinkingLevel?: string;
	roles: RoleConfig[];
	tools: string[];
}

export const DEFAULT_CONFIG: SwarmConfig = {
	workers: 4,
	leaseSeconds: 300,
	heartbeatSeconds: 20,
	offlineAfterSeconds: 60,
	idleTickSeconds: 15,
	review: true,
	auto: false,
	worktrees: false,
	roles: [{ name: "general", count: 4, capabilities: ["general"] }],
	tools: ["read", "grep", "glob", "edit", "write", "bash", "ast_grep", "ast_edit", "todo"],
};
