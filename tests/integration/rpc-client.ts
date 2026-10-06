import type { Subprocess } from "bun";

export interface RpcFrame {
	type: string;
	id?: string;
	[key: string]: unknown;
}

interface Pending {
	resolve: (frame: RpcFrame) => void;
	reject: (error: Error) => void;
	timer: Timer;
}

/**
 * Minimal OMP RPC (newline-delimited JSON over stdio) client.
 * Enough to start a session, dispatch a slash command, and observe frames.
 */
export class RpcClient {
	readonly #proc: Subprocess<"pipe", "pipe", "pipe">;
	readonly #pending = new Map<string, Pending>();
	readonly #frames: RpcFrame[] = [];
	#nextId = 1;
	#stdoutBuffer = "";
	#stderr = "";
	#closed = false;

	constructor(command: string[], cwd: string) {
		this.#proc = Bun.spawn(command, { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		void this.#readStdout();
		void this.#readStderr();
	}

	get frames(): readonly RpcFrame[] {
		return this.#frames;
	}

	get stderr(): string {
		return this.#stderr;
	}

	async #readStdout(): Promise<void> {
		const decoder = new TextDecoder();
		for await (const chunk of this.#proc.stdout) {
			this.#stdoutBuffer += decoder.decode(chunk as Uint8Array, { stream: true });
			const lines = this.#stdoutBuffer.split("\n");
			this.#stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				if (line.trim() === "") continue;
				let frame: RpcFrame;
				try {
					frame = JSON.parse(line) as RpcFrame;
				} catch {
					continue;
				}
				this.#frames.push(frame);
				const pending = frame.id !== undefined ? this.#pending.get(frame.id) : undefined;
				if (pending !== undefined && (frame.type === "response" || frame.type === "prompt_result")) {
					this.#pending.delete(frame.id as string);
					clearTimeout(pending.timer);
					pending.resolve(frame);
				}
			}
		}
		this.#closed = true;
	}

	async #readStderr(): Promise<void> {
		const decoder = new TextDecoder();
		for await (const chunk of this.#proc.stderr) {
			this.#stderr += decoder.decode(chunk as Uint8Array, { stream: true });
		}
	}

	async waitForReady(timeoutMs = 60_000): Promise<void> {
		await this.waitFor((frame) => frame.type === "ready", timeoutMs, "ready frame");
	}

	send(command: Record<string, unknown>): string {
		const id = String(command.id ?? `cmd-${this.#nextId++}`);
		this.#proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		this.#proc.stdin.flush();
		return id;
	}

	request(command: Record<string, unknown>, timeoutMs = 60_000): Promise<RpcFrame> {
		const id = this.send(command);
		const { promise, resolve, reject } = Promise.withResolvers<RpcFrame>();
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new Error(`rpc request ${id} (${String(command.type)}) timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		this.#pending.set(id, { resolve, reject, timer });
		return promise;
	}

	async waitFor(predicate: (frame: RpcFrame) => boolean, timeoutMs: number, description: string): Promise<RpcFrame> {
		const deadline = Date.now() + timeoutMs;
		let index = 0;
		while (Date.now() < deadline) {
			while (index < this.#frames.length) {
				const frame = this.#frames[index++];
				if (predicate(frame)) return frame;
			}
			if (this.#closed) throw new Error(`session stdout closed while waiting for ${description}`);
			await Bun.sleep(100);
		}
		throw new Error(`timed out waiting for ${description}`);
	}

	async close(graceMs = 15_000): Promise<void> {
		try {
			this.#proc.stdin.end();
		} catch {
			// already closed
		}
		const exited = await Promise.race([this.#proc.exited, Bun.sleep(graceMs).then(() => "timeout" as const)]);
		if (exited === "timeout") this.#proc.kill();
	}
}
