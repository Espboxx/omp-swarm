import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_CONFIG, type RoleConfig, type SwarmConfig } from "./types";

export interface WorkerSpec {
	name: string;
	role: string;
	capabilities: string[];
	index: number;
}

const CALLSIGN_ADJECTIVES = ["Swift", "Calm", "Bright", "Vivid", "Rapid", "Lunar", "Cedar", "Amber", "Quiet", "Solar"];
const CALLSIGN_NOUNS = ["Tiger", "Falcon", "River", "Quartz", "Harbor", "Nova", "Pine", "Raven", "Lynx", "Delta"];

function isRole(value: unknown): value is RoleConfig {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { name?: unknown; count?: unknown };
	return typeof candidate.name === "string" && typeof candidate.count === "number";
}

export function loadSwarmConfig(configFile: string): SwarmConfig {
	if (!existsSync(configFile)) return { ...DEFAULT_CONFIG };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configFile, "utf8"));
	} catch (error) {
		throw new Error(`invalid swarm config at ${configFile}: ${String(error)}`);
	}
	if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_CONFIG };
	const raw = parsed as Partial<SwarmConfig>;
	const roles = Array.isArray(raw.roles) ? raw.roles.filter(isRole) : [];
	return {
		workers: typeof raw.workers === "number" && raw.workers > 0 ? Math.floor(raw.workers) : DEFAULT_CONFIG.workers,
		leaseSeconds: typeof raw.leaseSeconds === "number" && raw.leaseSeconds > 0 ? raw.leaseSeconds : DEFAULT_CONFIG.leaseSeconds,
		heartbeatSeconds:
			typeof raw.heartbeatSeconds === "number" && raw.heartbeatSeconds > 0 ? raw.heartbeatSeconds : DEFAULT_CONFIG.heartbeatSeconds,
		offlineAfterSeconds:
			typeof raw.offlineAfterSeconds === "number" && raw.offlineAfterSeconds > 0 ? raw.offlineAfterSeconds : DEFAULT_CONFIG.offlineAfterSeconds,
		idleTickSeconds: typeof raw.idleTickSeconds === "number" && raw.idleTickSeconds > 0 ? raw.idleTickSeconds : DEFAULT_CONFIG.idleTickSeconds,
		review: typeof raw.review === "boolean" ? raw.review : DEFAULT_CONFIG.review,
		auto: typeof raw.auto === "boolean" ? raw.auto : DEFAULT_CONFIG.auto,
		worktrees: typeof raw.worktrees === "boolean" ? raw.worktrees : DEFAULT_CONFIG.worktrees,
		model: typeof raw.model === "string" ? raw.model : undefined,
		thinkingLevel: typeof raw.thinkingLevel === "string" ? raw.thinkingLevel : undefined,
		roles: roles.length > 0 ? roles : DEFAULT_CONFIG.roles,
		tools: Array.isArray(raw.tools) && raw.tools.length > 0 ? raw.tools.filter((t): t is string => typeof t === "string") : DEFAULT_CONFIG.tools,
	};
}

/** Persist the multi-agent mode flag without touching any other key in the file. */
export function saveSwarmAuto(configFile: string, auto: boolean): void {
	const raw = existsSync(configFile) ? (JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>) : {};
	mkdirSync(dirname(configFile), { recursive: true });
	writeFileSync(configFile, `${JSON.stringify({ ...raw, auto }, null, 2)}\n`, "utf8");
}

/** Expand the configured role counts into concrete worker identities. */
export function expandWorkers(config: SwarmConfig, count = config.workers, roles?: RoleConfig[]): WorkerSpec[] {
	const specs: WorkerSpec[] = [];
	const roster = roles && roles.length > 0 ? roles : config.roles.length > 0 ? config.roles : DEFAULT_CONFIG.roles;
	let seed = 0;
	for (const role of roster) {
		for (let i = 0; i < role.count && specs.length < count; i++) {
			const name = `${CALLSIGN_ADJECTIVES[seed % CALLSIGN_ADJECTIVES.length]}${CALLSIGN_NOUNS[Math.floor(seed / CALLSIGN_ADJECTIVES.length) % CALLSIGN_NOUNS.length]}`;
			seed++;
			specs.push({ name, role: role.name, capabilities: role.capabilities ?? [role.name], index: specs.length });
		}
	}
	while (specs.length < count) {
		const name = `${CALLSIGN_ADJECTIVES[seed % CALLSIGN_ADJECTIVES.length]}${CALLSIGN_NOUNS[Math.floor(seed / CALLSIGN_ADJECTIVES.length) % CALLSIGN_NOUNS.length]}`;
		seed++;
		specs.push({ name, role: "general", capabilities: ["general"], index: specs.length });
	}
	return specs;
}
