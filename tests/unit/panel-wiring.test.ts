import { describe, expect, test } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { createAgentListPanel, panelKey, type AgentPanelHooks } from "../../extension/index";
import type { PanelRow, PanelStatus } from "../../extension/panel";

const LEGEND = ["↑/↓ 选择代理", "Enter 切换到该代理", "r 重新加载代理列表", "s 查看代理状态", "q 退出多代理模式"];
const WIDTH = 30;

function row(index: number, id: string, label: string, status: PanelStatus = "idle"): PanelRow {
	return { index, id, label, status };
}

/** `handleInput` is optional on the host `Component` type; the panel always provides it. */
function press(panel: Component, data: string): void {
	if (panel.handleInput === undefined) throw new Error("panel component has no handleInput");
	panel.handleInput(data);
}

/** A host-free hook set: every callback lands in `calls` as `<name>[:<id>]`. */
function makeHooks(roster: () => PanelRow[]): { hooks: AgentPanelHooks; calls: string[] } {
	const calls: string[] = [];
	const hooks: AgentPanelHooks = {
		rows: roster,
		onSelect: (selected) => calls.push(`select:${selected.id}`),
		onReload: () => calls.push("reload"),
		onStatus: () => calls.push("status"),
		onQuit: () => calls.push("quit"),
	};
	return { hooks, calls };
}

const SWIFT = row(1, "a1", "SwiftTiger");
const CALM = row(2, "a2", "CalmTiger", "working");
const VIVID = row(3, "a3", "VividTiger", "reviewing");

describe("panelKey", () => {
	test("the arrow and enter byte sequences map to the reducer's names", () => {
		expect(panelKey("\x1b[A")).toBe("up");
		expect(panelKey("\x1b[B")).toBe("down");
		expect(panelKey("\r")).toBe("enter");
	});

	test("single-letter keys map to themselves", () => {
		for (const key of ["k", "j", "r", "s", "q"]) expect(panelKey(key)).toBe(key);
	});

	test("keys the panel does not own are dropped", () => {
		for (const data of ["x", "\x03", "\x1b[C", "\x1b", ""]) expect(panelKey(data)).toBeUndefined();
	});
});

describe("createAgentListPanel render", () => {
	test("paints the roster header, the cursor row and the legend", () => {
		const { hooks } = makeHooks(() => [SWIFT, CALM]);
		const lines = createAgentListPanel(hooks).render(WIDTH);
		expect(lines[0]).toBe("MULTI-AGENT MODE      2 agents");
		expect(lines[1]).toBe(">1  SwiftTiger  · idle");
		expect(lines[2]).toBe(" 2  CalmTiger  · working");
		expect(lines.slice(-5)).toEqual(LEGEND);
	});

	test("re-reads hooks.rows on every render", () => {
		let renders = 0;
		const { hooks } = makeHooks(() => (++renders === 1 ? [SWIFT, CALM] : [SWIFT, CALM, VIVID]));
		const panel = createAgentListPanel(hooks);
		expect(panel.render(WIDTH)[0]).toBe("MULTI-AGENT MODE      2 agents");
		expect(panel.render(WIDTH)[0]).toBe("MULTI-AGENT MODE      3 agents");
		expect(panel.render(WIDTH).slice(1, 4)).toEqual([">1  SwiftTiger  · idle", " 2  CalmTiger  · working", " 3  VividTiger  · reviewing"]);
	});

	test("an empty roster paints the header and the legend with no rows", () => {
		const { hooks } = makeHooks(() => []);
		const lines = createAgentListPanel(hooks).render(WIDTH);
		expect(lines[0]).toBe("MULTI-AGENT MODE      0 agents");
		expect(lines.length).toBe(6);
		expect(lines.some((line) => line.startsWith(">"))).toBe(false);
	});
});

describe("createAgentListPanel input", () => {
	test("a cursor key repaints the cursor", () => {
		const { hooks } = makeHooks(() => [SWIFT, CALM, VIVID]);
		const panel = createAgentListPanel(hooks);
		press(panel, "\x1b[B");
		expect(panel.render(WIDTH)[2]).toBe(">2  CalmTiger  · working");
		press(panel, "\x1b[A");
		expect(panel.render(WIDTH)[1]).toBe(">1  SwiftTiger  · idle");
		press(panel, "j");
		expect(panel.render(WIDTH)[2]).toBe(">2  CalmTiger  · working");
		press(panel, "k");
		expect(panel.render(WIDTH)[1]).toBe(">1  SwiftTiger  · idle");
	});

	test("the cursor clamps at both ends through the adapter", () => {
		const { hooks } = makeHooks(() => [SWIFT, CALM]);
		const panel = createAgentListPanel(hooks);
		for (let i = 0; i < 3; i++) press(panel, "\x1b[B");
		expect(panel.render(WIDTH)[2]).toBe(">2  CalmTiger  · working");
		for (let i = 0; i < 3; i++) press(panel, "k");
		expect(panel.render(WIDTH)[1]).toBe(">1  SwiftTiger  · idle");
	});

	test("enter fires onSelect with the row under the cursor and marks it selected", () => {
		const { hooks, calls } = makeHooks(() => [SWIFT, CALM, VIVID]);
		const panel = createAgentListPanel(hooks);
		press(panel, "\x1b[B");
		press(panel, "\r");
		expect(calls).toEqual(["select:a2"]);
		expect(panel.render(WIDTH)[2]).toBe(">2  CalmTiger  · working ●");
		expect(panel.render(WIDTH)[1]).toBe(" 1  SwiftTiger  · idle");
	});

	test("an empty roster ignores cursor keys and enter", () => {
		const { hooks, calls } = makeHooks(() => []);
		const panel = createAgentListPanel(hooks);
		for (const data of ["\x1b[A", "\x1b[B", "k", "j", "\r"]) press(panel, data);
		expect(calls).toEqual([]);
		expect(panel.render(WIDTH)[0]).toBe("MULTI-AGENT MODE      0 agents");
	});

	test("r, s and q each fire exactly their own hook", () => {
		const { hooks, calls } = makeHooks(() => [SWIFT, CALM]);
		const panel = createAgentListPanel(hooks);
		press(panel, "r");
		expect(calls).toEqual(["reload"]);
		press(panel, "s");
		expect(calls).toEqual(["reload", "status"]);
		press(panel, "q");
		expect(calls).toEqual(["reload", "status", "quit"]);
	});

	test("a key the panel does not own fires nothing", () => {
		const { hooks, calls } = makeHooks(() => [SWIFT, CALM]);
		const panel = createAgentListPanel(hooks);
		for (const data of ["x", "\x03", "\x1b[C"]) press(panel, data);
		expect(calls).toEqual([]);
		expect(panel.render(WIDTH)[1]).toBe(">1  SwiftTiger  · idle");
	});

	test("a roster that shrinks under the cursor clamps it back onto a row", () => {
		let roster = [SWIFT, CALM, VIVID];
		const { hooks, calls } = makeHooks(() => roster);
		const panel = createAgentListPanel(hooks);
		press(panel, "\x1b[B");
		press(panel, "\x1b[B");
		expect(panel.render(WIDTH)[3]).toBe(">3  VividTiger  · reviewing");
		roster = [SWIFT];
		expect(panel.render(WIDTH)[1]).toBe(">1  SwiftTiger  · idle");
		press(panel, "\r");
		expect(calls).toEqual(["select:a1"]);
	});
});
