import { describe, expect, test } from "bun:test";
import { applyPanelKey, renderPanelLines, statusLineText, type PanelModel, type PanelRow } from "../../extension/panel";

const NOW = 1_700_000_000_000;
const LEGEND = ["↑/↓ 选择代理", "Enter 切换到该代理", "r 重新加载代理列表", "s 查看代理状态", "q 退出多代理模式"];

function row(index: number, label: string, status: PanelRow["status"] = "idle", id = `agent-${index}`): PanelRow {
	return { index, id, label, status };
}

function model(rows: PanelRow[], overrides: Partial<PanelModel> = {}): PanelModel {
	return { title: "MULTI-AGENT MODE", rows, cursor: 0, now: NOW, ...overrides };
}

const THREE = [row(1, "Alice"), row(2, "Bob", "working"), row(3, "Cara", "reviewing")];

describe("applyPanelKey cursor movement", () => {
	test("down and j step toward the last row and clamp there", () => {
		let m = model(THREE);
		m = applyPanelKey(m, "down").model;
		expect(m.cursor).toBe(1);
		m = applyPanelKey(m, "j").model;
		expect(m.cursor).toBe(2);
		const res = applyPanelKey(m, "down");
		expect(res.model.cursor).toBe(2);
		expect(res.action).toEqual({ kind: "none" });
	});

	test("up and k step toward the first row and clamp there", () => {
		let m = model(THREE, { cursor: 2 });
		m = applyPanelKey(m, "up").model;
		expect(m.cursor).toBe(1);
		m = applyPanelKey(m, "k").model;
		expect(m.cursor).toBe(0);
		const res = applyPanelKey(m, "up");
		expect(res.model.cursor).toBe(0);
		expect(res.action).toEqual({ kind: "none" });
	});

	test("an empty list ignores cursor keys", () => {
		const m = model([]);
		for (const key of ["up", "down", "k", "j"]) {
			const res = applyPanelKey(m, key);
			expect(res.model.cursor).toBe(0);
			expect(res.model.rows).toEqual([]);
			expect(res.action).toEqual({ kind: "none" });
		}
	});

	test("the caller's model is never mutated", () => {
		const m = model(THREE);
		applyPanelKey(m, "down");
		expect(m.cursor).toBe(0);
	});
});

describe("applyPanelKey actions", () => {
	test("enter selects the row under the cursor", () => {
		const res = applyPanelKey(model(THREE, { cursor: 1 }), "enter");
		expect(res.action).toEqual({ kind: "select", id: "agent-2" });
		expect(res.model.cursor).toBe(1);
	});

	test("enter with no rows does nothing", () => {
		expect(applyPanelKey(model([]), "enter").action).toEqual({ kind: "none" });
	});

	test("enter with the cursor past the end does nothing", () => {
		expect(applyPanelKey(model(THREE, { cursor: 9 }), "enter").action).toEqual({ kind: "none" });
	});

	test("r, s and q map to reload, status and quit", () => {
		const m = model(THREE);
		expect(applyPanelKey(m, "r").action).toEqual({ kind: "reload" });
		expect(applyPanelKey(m, "s").action).toEqual({ kind: "status" });
		expect(applyPanelKey(m, "q").action).toEqual({ kind: "quit" });
	});

	test("an unknown key is a no-op", () => {
		const m = model(THREE);
		const res = applyPanelKey(m, "x");
		expect(res.action).toEqual({ kind: "none" });
		expect(res.model).toBe(m);
	});
});

describe("renderPanelLines", () => {
	test("the header right-aligns the agent count inside the width", () => {
		const lines = renderPanelLines(model([row(1, "Alice"), row(2, "Bob")]));
		expect(lines[0]).toBe("MULTI-AGENT MODE      2 agents");
		expect(lines[0].length).toBe(30);
	});

	test("rows carry index, label and status, and the cursor row is marked", () => {
		const lines = renderPanelLines(model(THREE));
		expect(lines[1]).toBe(">1  Alice  · idle");
		expect(lines[2]).toBe(" 2  Bob  · working");
		expect(lines[3]).toBe(" 3  Cara  · reviewing");
	});

	test("the selected agent gets a marker, with an ascii fallback", () => {
		const m = model([row(1, "Alice", "idle", "a1"), row(2, "Bob", "idle", "a2")], { cursor: 1, selected: "a1" });
		expect(renderPanelLines(m)[1]).toBe(" 1  Alice  · idle ●");
		expect(renderPanelLines(m)[2]).toBe(">2  Bob  · idle");
		expect(renderPanelLines(m, { ascii: true })[1]).toBe(" 1  Alice  · idle *");
	});

	test("a long label is truncated with an ellipsis so the line fits the width", () => {
		const lines = renderPanelLines(model([row(1, "A very long agent label")]), { width: 20 });
		expect(lines[1]).toBe(">1  A very …  · idle");
		expect(lines[1].length).toBe(20);
	});

	test("maxRows caps the rows and reports the remainder", () => {
		const many = Array.from({ length: 10 }, (_, i) => row(i + 1, `Agent ${i + 1}`));
		const lines = renderPanelLines(model(many), { maxRows: 3 });
		expect(lines.slice(1, 4).map((l) => l.slice(0, 2))).toEqual([">1", " 2", " 3"]);
		expect(lines[4]).toBe("… 7 more");
	});

	test("the default cap is 8 rows", () => {
		const many = Array.from({ length: 9 }, (_, i) => row(i + 1, `Agent ${i + 1}`));
		const lines = renderPanelLines(model(many));
		expect(lines.slice(1, 9).length).toBe(8);
		expect(lines[9]).toBe("… 1 more");
	});

	test("the legend block is appended verbatim after the rows", () => {
		const lines = renderPanelLines(model(THREE));
		expect(lines.slice(-5)).toEqual(LEGEND);
	});

	test("an empty list still renders the header and the legend", () => {
		const lines = renderPanelLines(model([]));
		expect(lines[0]).toBe("MULTI-AGENT MODE      0 agents");
		expect(lines.length).toBe(6);
	});

	test("an empty title falls back to the panel title", () => {
		expect(renderPanelLines(model([], { title: "" }))[0]).toBe("MULTI-AGENT MODE      0 agents");
	});
});

describe("statusLineText", () => {
	test("a selected label gives the selection form", () => {
		expect(statusLineText("Alice")).toBe("MULTI-AGENT MODE · Alice (selected)");
	});

	test("no selection keeps the idle form", () => {
		expect(statusLineText(undefined)).toBe("MULTI-AGENT MODE ON · idle");
	});
});
