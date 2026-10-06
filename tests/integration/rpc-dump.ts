/**
 * Diagnostic: boot OMP in RPC mode with the swarm extension and dump every frame
 * while dispatching one extension command.
 *
 * Usage: bun run tests/integration/rpc-dump.ts [--command "/swarm start 1"] [--seconds 90] [--root DIR]
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RpcClient } from "./rpc-client";

const EXTENSION = resolve(import.meta.dir, "..", "..", "extension", "index.ts");

function args(name: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < process.argv.length; i++) {
		if (process.argv[i] === `--${name}` && process.argv[i + 1] !== undefined) out.push(process.argv[i + 1] as string);
	}
	return out;
}

function arg(name: string, fallback: string): string {
	const index = process.argv.indexOf(`--${name}`);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	return value ?? fallback;
}

const has = (name: string) => process.argv.includes(`--${name}`);

const root = resolve(arg("root", join(import.meta.dir, "..", "..", "scratch", "rpcdump")));
/** Repeat `--command` to walk a sequence in one session (e.g. "/swarm on" then "/swarm off"). */
const commands = args("command");
const commandQueue = commands.length > 0 ? commands : [arg("command", "/swarm start 1")];
const commandGapMs = Number(arg("gap", "6")) * 1000;
const seconds = Number(arg("seconds", "90"));
const uiMode = has("ui");

rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
writeFileSync(join(root, "package.json"), '{\n  "name": "rpcdump",\n  "private": true\n}\n');

const modeArgs = uiMode ? ["--mode", "rpc-ui"] : ["--mode", "rpc", "--no-ui"];
const loadArgs = has("installed") ? [] : ["-e", EXTENSION];
const client = new RpcClient(["omp", ...modeArgs, "--no-session", ...loadArgs, "--no-title"], root);
console.log(`[dump] loading: ${has("installed") ? "installed plugins (no -e)" : EXTENSION}`);
const started = Date.now();
console.log(`[dump] cwd=${root} commands=${JSON.stringify(commandQueue)}`);

let seen = 0;
let readyAt: number | undefined;
const queue = [...commandQueue];
const summarize = (frame: Record<string, unknown>): string => {
	const parts = [`type=${String(frame.type)}`];
	if (frame.id !== undefined) parts.push(`id=${String(frame.id)}`);
	if (typeof frame.error === "string") parts.push(`error=${frame.error}`);
	if (typeof frame.message === "string") parts.push(`message=${frame.message.slice(0, 200)}`);
	if (typeof frame.text === "string") parts.push(`text=${frame.text.slice(0, 200)}`);
	if (typeof frame.status === "string") parts.push(`status=${frame.status}`);
	if (typeof frame.command === "string") parts.push(`command=${frame.command}`);
	if (typeof frame.method === "string") parts.push(`method=${frame.method}`);
	if (frame.method === "setStatus") parts.push(`statusText=${String(frame.statusText)}`);
	return parts.join(" ");
};

while (Date.now() - started < seconds * 1000) {
	const frames = client.frames;
	while (seen < frames.length) {
		const frame = frames[seen++] as Record<string, unknown>;
		console.log(`[frame] ${summarize(frame)}`);
		if (frame.type === "ready" && readyAt === undefined) readyAt = Date.now();
	}
	if (readyAt !== undefined && queue.length > 0 && Date.now() - readyAt >= (commandQueue.length - queue.length) * commandGapMs) {
		const next = queue.shift() as string;
		const id = client.send({ type: "prompt", message: next });
		console.log(`[dump] sent prompt ${id} (${next})`);
	}
	await Bun.sleep(200);
}

console.log(`[dump] stderr tail:\n${client.stderr.slice(-3000)}`);
await client.close(5000);
