/**
 * Probe extension for task-14 (the agent-list panel contract).
 *
 * Loaded with `-e` by `tests/integration/panel-probe.ts` into a real
 * `omp --mode rpc-ui` session. Its whole job is to try the UI surfaces the panel
 * could use and report, as `notify` frames, exactly what the host did with each
 * ask. Findings are read from the frames — the runner never trusts an opinion.
 *
 * Emitted payloads are prefixed `PANEL_PROBE::` so the runner can pick them out
 * of the ordinary notify traffic.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { Component } from "@oh-my-pi/pi-tui";

export const PANEL_PROBE_MARK = "PANEL_PROBE::";

/** Findings collected during extension load, reported once a command context exists. */
const loadFindings: Array<{ name: string; value: unknown }> = [];

function tryRegisterShortcut(pi: ExtensionAPI, key: Parameters<ExtensionAPI["registerShortcut"]>[0]): void {
	try {
		pi.registerShortcut(key, { description: `panel probe ${key}`, handler: () => {} });
		loadFindings.push({ name: `shortcut:${key}`, value: "accepted" });
	} catch (error) {
		loadFindings.push({ name: `shortcut:${key}`, value: `threw:${error instanceof Error ? error.message : String(error)}` });
	}
}

export default function panelProbe(pi: ExtensionAPI): void {
	pi.setLabel("Panel API probe");

	// Every key the panel needs except `enter` (which the runner.ts reserved list
	// drops). Registering here proves API acceptance only — delivery needs a
	// focused component or a terminal, which the command handler measures.
	for (const key of ["up", "down", "r", "s", "q", "enter"] as const) {
		tryRegisterShortcut(pi, key);
	}

	pi.registerCommand("panel-probe", {
		description: "Probe the extension UI surface for the agent-list panel",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const report = (name: string, value: unknown): void => {
				ctx.ui.notify(PANEL_PROBE_MARK + JSON.stringify({ name, value }), "info");
			};

			for (const finding of loadFindings) report(finding.name, finding.value);

			report("env", { mode: ctx.mode, hasUI: ctx.hasUI });

			// (a)+(b) Mount an extension-owned component as a left-anchored overlay
			// and count the keys it receives. In an interactive host the factory runs,
			// the component is focused, and injected keys land in `handleInput`.
			const keyEvents: string[] = [];
			let factoryCalled = false;
			let disposed = false;
			const component: Component & { dispose?(): void } = {
				handleInput(data: string): void {
					keyEvents.push(data);
				},
				render(width: number): readonly string[] {
					return ["| MULTI-AGENT MODE".padEnd(width, " ").slice(0, width)];
				},
				dispose(): void {
					disposed = true;
				},
			};

			let customResolved: unknown = "<pending>";
			const customSettled = ctx.ui
				.custom<string | undefined>(
					() => {
						factoryCalled = true;
						return component;
					},
					{ overlay: true, overlayOptions: { anchor: "left-center", width: 20, maxHeight: "100%", margin: 0 } },
				)
				.then(
					value => {
						customResolved = value === undefined ? "<undefined>" : value;
					},
					error => {
						customResolved = `rejected:${error instanceof Error ? error.message : String(error)}`;
					},
				);
			// Give a live host a beat to mount and route keys; RPC settles at once.
			await Promise.race([customSettled, Bun.sleep(750)]);
			report("custom-mount", { mode: ctx.mode, hasUI: ctx.hasUI, factoryCalled, customResolved, keyEvents, disposed });

			// The surface the shipped extension already uses: string-array widget.
			ctx.ui.setWidget(
				"panel-probe-lines",
				["MULTI-AGENT MODE   2 agents", " 1  SwiftTiger  · idle", " 2  CalmTiger  · working"],
				{ placement: "aboveEditor" },
			);
			report("setWidget-lines", { emitted: true });

			// A component-factory widget — emitted only by a host with TUI access.
			ctx.ui.setWidget("panel-probe-factory", () => component, { placement: "aboveEditor" });
			report("setWidget-factory", { emitted: true });

			// Raw terminal input — a delivery channel for r/s/q without focus.
			let inputEvents = 0;
			const offTerminalInput = ctx.ui.onTerminalInput(() => {
				inputEvents++;
				return { consume: true };
			});
			await Bun.sleep(250);
			offTerminalInput();
			report("onTerminalInput", { inputEvents });

			report("done", { keyEvents, inputEvents, factoryCalled });
		},
	});
}
