/**
 * omp-swarm dashboard — plain ES module. No framework, no bundler, no CDN.
 *
 * Data comes from one of two places:
 *   ?fixture=1  -> ./fixtures/snapshot.json   (offline sample; the UI is built and proven on this)
 *   otherwise   -> GET /api/snapshot          (the read-only server from task-101)
 * Liveness: EventSource("/api/events"); when the stream drops it falls back to polling.
 *
 * Invariants kept here on purpose:
 *   - every number/row comes from the snapshot; an empty collection renders a sentence, not zeros;
 *   - nothing is rendered with innerHTML — all data goes in as text nodes;
 *   - a status is never conveyed by colour alone (dot + written label);
 *   - the page is read-only: the only controls are language, tabs and "show more".
 */
import { STRINGS, LANGS } from "./strings.js";
import { breakablePath } from "./format.js";
import { votesFromSnapshot, voteBoardIds } from "./votes.js";

const SNAPSHOT_URL = "/api/snapshot";
const EVENTS_URL = "/api/events";
const FIXTURE_URL = "./fixtures/snapshot.json";
const POLL_MS = 5000;
const TIME_TICK_MS = 5000;
const FEED_ROW_CAP = 20;
const TASK_ROW_CAP = 25;
const TASK_ORDER = ["claimed", "ready", "review", "blocked", "done", "failed"];

const query = new URLSearchParams(location.search);
const state = {
	lang: pickLang(),
	fixture: query.get("fixture") === "1",
	snapshot: null,
	signature: null,
	conn: "connecting",
	retryIn: 0,
	activeTab: "board",
	showAll: { board: false, messages: false, events: false },
	showAllTasks: {},
	activeVoteTab: "live",
	showAllVotes: false,
};

function pickLang() {
	const fromUrl = query.get("lang");
	if (fromUrl && LANGS.includes(fromUrl)) return fromUrl;
	try {
		const stored = localStorage.getItem("omp-swarm.lang");
		if (stored && LANGS.includes(stored)) return stored;
	} catch {
		/* private mode: fall through to the default */
	}
	return "zh";
}

/** Translate a key, substituting {placeholders}. An unknown key shows the key — never a blank. */
function t(key, vars) {
	const table = STRINGS[state.lang] ?? STRINGS.zh;
	const raw = table[key] ?? STRINGS.zh[key] ?? key;
	if (!vars) return raw;
	return raw.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

/* ------------------------------------------------------------------ DOM */

function el(tag, props = {}, ...children) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (value === null || value === undefined || value === false) continue;
		if (key === "class") node.className = value;
		else if (key === "text") node.textContent = String(value);
		else if (key === "dataset") Object.assign(node.dataset, value);
		else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
		else node.setAttribute(key, String(value));
	}
	append(node, children);
	return node;
}

function append(node, children) {
	for (const child of children.flat(Infinity)) {
		if (child === null || child === undefined || child === false) continue;
		node.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
}

function clear(node) {
	while (node.firstChild) node.removeChild(node.firstChild);
}

function badge(label, statusClass, extraClass = "") {
	return el(
		"span",
		{ class: `badge ${statusClass} ${extraClass}`.trim() },
		el("span", { class: "dot", "aria-hidden": "true" }),
		label,
	);
}

const statusLabel = (status) => {
	const key = `status.${status}`;
	const label = t(key);
	return label === key ? status : label;
};

/* ----------------------------------------------------------------- time */

/** "3m ago"-style label for an elapsed duration. */
function agoLabel(ms) {
	if (ms === null || ms === undefined || Number.isNaN(ms)) return t("value.none");
	const a = Math.max(0, ms);
	if (a < 5000) return t("time.justNow");
	if (a < 60_000) return t("time.agoS", { n: Math.floor(a / 1000) });
	if (a < 3_600_000) return t("time.agoM", { n: Math.floor(a / 60_000) });
	if (a < 86_400_000) return t("time.agoH", { n: Math.floor(a / 3_600_000) });
	return t("time.agoD", { n: Math.floor(a / 86_400_000) });
}

/** "in 4m" / "expired" label for a deadline relative to the snapshot's own clock. */
function untilLabel(deadlineMs, nowMs) {
	if (deadlineMs === null || deadlineMs === undefined) return t("value.none");
	const left = deadlineMs - nowMs;
	if (left <= 0) return t("time.expired");
	if (left < 60_000) return t("time.inS", { n: Math.ceil(left / 1000) });
	if (left < 3_600_000) return t("time.inM", { n: Math.floor(left / 60_000) });
	return t("time.inH", { n: Math.floor(left / 3_600_000) });
}

function stamp(ms) {
	if (!ms) return t("value.none");
	const date = new Date(ms);
	const pad = (n) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Time labels carry the value they were rendered from, so the ticker can re-derive them as the
 * page's own clock moves without rebuilding the DOM (a rebuild would steal keyboard focus).
 */
function timeAgo(ms) {
	const elapsed = Math.max(0, ms ?? 0);
	return el("span", { class: "age", dataset: { timeAgo: String(elapsed) } }, agoLabel(elapsed));
}

function timeUntil(deadlineMs, nowMs) {
	if (deadlineMs === null || deadlineMs === undefined) return document.createTextNode(t("value.none"));
	return el(
		"span",
		{ class: "age", dataset: { timeUntil: String(deadlineMs), base: String(nowMs) } },
		untilLabel(deadlineMs, nowMs),
	);
}

function refreshTimes() {
	const snapshot = state.snapshot;
	if (!snapshot || document.hidden) return;
	const drift = Date.now() - (state.receivedAt ?? Date.now());
	for (const node of document.querySelectorAll("[data-time-ago]")) {
		node.textContent = agoLabel(Number(node.dataset.timeAgo) + drift);
	}
	for (const node of document.querySelectorAll("[data-time-until]")) {
		node.textContent = untilLabel(Number(node.dataset.timeUntil), Number(node.dataset.base) + drift);
	}
}

/* --------------------------------------------------------------- layout */

const dom = {};

function buildShell() {
	document.title = t("app.title");
	document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
	clear(document.body);

	dom.connIndicator = el("span", { class: "conn", role: "status", "aria-live": "polite" });

	dom.langToggle = el("button", {
		class: "lang-toggle",
		id: "lang-toggle",
		type: "button",
		title: t("lang.switchLabel"),
		"aria-label": t("lang.switchLabel"),
		onclick: () => {
			state.lang = state.lang === "zh" ? "en" : "zh";
			try {
				localStorage.setItem("omp-swarm.lang", state.lang);
			} catch {
				/* ignore */
			}
			render(state.snapshot);
		},
	}, t("lang.other"));

	dom.metaLine = el("div", { class: "meta-line" });

	const header = el(
		"header",
		{ class: "app-header" },
		el("div", { class: "brand" }, el("h1", { text: t("app.title") }), el("p", { text: t("app.subtitle") })),
		el("div", { class: "header-side" }, dom.connIndicator, dom.langToggle),
		dom.metaLine,
	);

	dom.counts = el("ul", { class: "counts-bar", "aria-label": t("counts.title") });
	dom.agentsBody = el("div", { class: "agent-grid" });
	dom.agentsNote = el("span", { class: "panel-note" });
	dom.tasksBody = el("div", {});
	dom.reservations = el("div", {});
	dom.feedBody = el("div", {});
	dom.progressBody = el("div", {});
	dom.votesBody = el("div", {});
	dom.votesNote = el("span", { class: "panel-note" });

	dom.tabs = el("div", { class: "tablist", role: "tablist", "aria-label": t("collab.title") });
	dom.tabButtons = {};
	for (const tab of ["board", "messages", "events"]) {
		const button = el("button", {
			class: "tab",
			type: "button",
			role: "tab",
			id: `tab-${tab}`,
			"aria-controls": "panel-feed",
			"aria-selected": state.activeTab === tab ? "true" : "false",
			tabindex: state.activeTab === tab ? "0" : "-1",
			onclick: () => selectTab(tab),
			onkeydown: (event) => onTabKey(event, tab),
		}, t(`collab.tab.${tab}`));
		dom.tabButtons[tab] = button;
		dom.tabs.append(button);
	}

	dom.voteTabs = el("div", { class: "vote-tablist", role: "tablist", "aria-label": t("votes.title") });
	dom.voteTabButtons = {};
	for (const tab of ["live", "recent"]) {
		const button = el("button", {
			class: "tab",
			type: "button",
			role: "tab",
			id: `vote-tab-${tab}`,
			"aria-controls": "panel-votes",
			"aria-selected": state.activeVoteTab === tab ? "true" : "false",
			tabindex: state.activeVoteTab === tab ? "0" : "-1",
			onclick: () => selectVoteTab(tab),
			onkeydown: (event) => onVoteTabKey(event, tab),
		}, t(`votes.tab.${tab}`));
		dom.voteTabButtons[tab] = button;
		dom.voteTabs.append(button);
	}

	const main = el(
		"main",
		{ id: "main" },
		dom.counts,
		panel(t("progress.title"), null, dom.progressBody),
		panel(t("agents.title"), dom.agentsNote, dom.agentsBody),
		panel(t("tasks.title"), null, dom.tasksBody, dom.reservations),
		panel(t("votes.title"), dom.votesNote, dom.voteTabs, dom.votesBody),
		panel(t("collab.title"), null, dom.tabs, dom.feedBody),
		el("p", { class: "footer-note", text: t("app.subtitle") }),
	);
	dom.main = main;

	document.body.append(
		el("a", { class: "skip-link", href: "#main", text: t("app.skipToContent") }),
		header,
		main,
	);
	dom.header = header;
}

function panel(title, note, ...bodies) {
	const heading = el("h2", { text: title });
	const head = el("div", { class: "panel-head" }, heading, note ?? null);
	const section = el("section", { class: "panel", "aria-label": title }, head);
	append(section, bodies);
	return section;
}

function selectTab(tab) {
	state.activeTab = tab;
	for (const [name, button] of Object.entries(dom.tabButtons)) {
		button.setAttribute("aria-selected", name === tab ? "true" : "false");
		button.setAttribute("tabindex", name === tab ? "0" : "-1");
	}
	renderFeeds(state.snapshot);
}

function onTabKey(event, tab) {
	const order = ["board", "messages", "events"];
	const index = order.indexOf(tab);
	let next = null;
	if (event.key === "ArrowRight") next = order[(index + 1) % order.length];
	else if (event.key === "ArrowLeft") next = order[(index - 1 + order.length) % order.length];
	else if (event.key === "Home") next = order[0];
	else if (event.key === "End") next = order[order.length - 1];
	if (!next) return;
	event.preventDefault();
	selectTab(next);
	dom.tabButtons[next].focus();
}

function selectVoteTab(tab) {
	state.activeVoteTab = tab;
	state.showAllVotes = false;
	for (const [name, button] of Object.entries(dom.voteTabButtons)) {
		button.setAttribute("aria-selected", name === tab ? "true" : "false");
		button.setAttribute("tabindex", name === tab ? "0" : "-1");
	}
	renderVotes(state.snapshot);
}

function onVoteTabKey(event, tab) {
	const order = ["live", "recent"];
	const index = order.indexOf(tab);
	let next = null;
	if (event.key === "ArrowRight") next = order[(index + 1) % order.length];
	else if (event.key === "ArrowLeft") next = order[(index - 1 + order.length) % order.length];
	else if (event.key === "Home") next = order[0];
	else if (event.key === "End") next = order[order.length - 1];
	if (!next) return;
	event.preventDefault();
	selectVoteTab(next);
	dom.voteTabButtons[next].focus();
}

/* --------------------------------------------------------------- render */

function render(snapshot) {
	if (!snapshot) return;
	// A live update can land while a keyboard user is mid-navigation. Every control carries a stable
	// id, so the element that had focus can be put back after the rebuild.
	const focusedId = document.activeElement instanceof HTMLElement ? document.activeElement.id : "";
	buildShell();
	renderMeta(snapshot);
	renderConnection();
	renderCounts(snapshot);
	renderProgress(snapshot);
	renderAgents(snapshot);
	renderTasks(snapshot);
	renderReservations(snapshot);
	renderVotes(snapshot);
	renderFeeds(snapshot);
	if (focusedId) document.getElementById(focusedId)?.focus();
}

function renderConnection() {
	const conn = dom.connIndicator;
	conn.className = `conn conn-${state.conn}`;
	const label = t(`conn.${state.conn}`);
	clear(conn);
	conn.append(
		el("span", { class: "conn-dot", "aria-hidden": "true" }),
		`${t("conn.label")}: ${label}${state.retryIn > 0 ? ` (${t("app.retryIn", { s: state.retryIn })})` : ""}`,
	);
}

function renderMeta(snapshot) {
	clear(dom.metaLine);
	const root = snapshot.swarmRoot
		? el("span", {}, `${t("app.root")}: `, el("span", { class: "mono", text: snapshot.swarmRoot }))
		: null;
	append(dom.metaLine, [
		root,
		el("span", { text: `${t("app.updatedAt")}: ${stamp(snapshot.now)}` }),
		state.fixture ? el("span", { text: t("app.fixtureNote") }) : null,
		state.lastError ? el("span", { class: "lease-soon", text: `${t("app.loadFailed")}: ${state.lastError}` }) : null,
	]);
}

function renderCounts(snapshot) {
	clear(dom.counts);
	const counts = snapshot.counts ?? {};
	for (const key of ["ready", "claimed", "review", "blocked", "done", "failed", "total"]) {
		const value = typeof counts[key] === "number" ? counts[key] : null;
		dom.counts.append(
			el(
				"li",
				{ class: `count-chip status-${key}` },
				el("span", { class: "n", text: value === null ? t("value.none") : String(value) }),
				el("span", { class: "k", text: t(`status.${key}`) }),
			),
		);
	}
}

function renderProgress(snapshot) {
	clear(dom.progressBody);
	const tasks = snapshot.tasks ?? [];
	const counts = snapshot.counts ?? {};
	if (tasks.length === 0) {
		dom.progressBody.append(el("p", { class: "empty", text: t("progress.none") }));
		return;
	}
	const done = counts.done ?? tasks.filter((task) => task.status === "done").length;
	const failed = counts.failed ?? tasks.filter((task) => task.status === "failed").length;
	const blocked = counts.blocked ?? 0;
	const total = counts.total ?? tasks.length;
	const open = total - done - failed;
	const segments = [
		["done", done],
		["failed", failed],
		["review", counts.review ?? 0],
		["claimed", counts.claimed ?? 0],
		["blocked", blocked],
		["ready", counts.ready ?? 0],
	];
	dom.progressBody.append(
		el(
			"div",
			{ class: "progress-numbers" },
			el("span", { class: "progress-big", text: t("progress.overall", { done, total }) }),
			el("span", { class: "muted", text: t("progress.split", { done, failed, blocked, open }) }),
		),
		el(
			"div",
			{ class: "progress-bar", role: "img", "aria-label": `${t("progress.barLabel")}: ${t("progress.split", { done, failed, blocked, open })}` },
			segments.map(([name, value]) =>
				value > 0 ? el("span", { class: `seg-${name}`, style: `width:${(value / total) * 100}%` }) : null,
			),
		),
		el(
			"div",
			{ class: "legend" },
			segments
				.filter(([, value]) => value > 0)
				.map(([name, value]) =>
					el("span", {}, el("span", { class: `swatch seg-${name}`, "aria-hidden": "true" }), `${t(`status.${name}`)} ${value}`),
				),
		),
	);
}

function renderAgents(snapshot) {
	const agents = snapshot.agents ?? [];
	clear(dom.agentsBody);
	const online = agents.filter((agent) => agent.status !== "offline").length;
	dom.agentsNote.textContent = t("agents.count", { n: agents.length, online });
	if (agents.length === 0) {
		dom.agentsBody.append(el("p", { class: "empty", text: t("agents.empty") }));
		return;
	}
	for (const agent of agents) {
		const current = agent.currentTask ? el("span", { class: "mono", text: agent.currentTask }) : t("agents.none");
		dom.agentsBody.append(
			el(
				"article",
				{ class: `agent-card status-${agent.status}`, "aria-label": `${agent.id} — ${statusLabel(agent.status)}` },
				el(
					"div",
					{ class: "agent-top" },
					el("span", { class: "agent-name", text: agent.id }),
					el(
						"span",
						{ class: "chips" },
						agent.isMain ? badge(t("agents.main"), "status-main") : null,
						badge(statusLabel(agent.status), `status-${agent.status}`),
					),
				),
				el(
					"dl",
					{ class: "kv" },
					el("dt", { text: t("agents.role") }), el("dd", { text: agent.role ?? t("value.none") }),
					el("dt", { text: t("agents.currentTask") }), el("dd", {}, current),
					el("dt", { text: t("agents.heartbeat") }),
					el("dd", {}, timeAgo(agent.heartbeatAgeMs)),
					el("dt", { text: t("agents.lease") }),
					el(
						"dd",
						{ class: agent.leaseUntilMs && agent.leaseUntilMs - (snapshot.now ?? 0) < 60_000 ? "lease-soon" : "" },
						timeUntil(agent.leaseUntilMs, snapshot.now ?? 0),
					),
					el("dt", { text: t("agents.capabilities") }),
					el("dd", { class: "chips" }, (agent.capabilities ?? []).map((cap) => el("span", { class: "chip", text: cap }))),
					agent.worktree ? el("dt", { text: t("agents.worktree") }) : null,
					// The path may break ONLY at its separators (`breakablePath` inserts a zero-width space
					// after each one), and the raw value stays reachable on hover — it is lossless otherwise.
					agent.worktree
						? el("dd", { class: "mono path", text: breakablePath(agent.worktree), title: agent.worktree })
						: null,
				),
			),
		);
	}
}

function reviewBadge(task) {
	if (!task.reviewRequired && !task.reviewStatus) return null;
	const status = task.reviewStatus ?? "pending";
	const key = `tasks.review${status.charAt(0).toUpperCase()}${status.slice(1)}`;
	const label = t(key);
	return el("span", { class: "tag", text: `${t("tasks.reviewStatus")}: ${label === key ? status : label}` });
}

function taskRow(task) {
	const meta = [];
	// The meta is a set of SLOTS, not one sentence: the owner carries the chip weight the status badge has
	// (and the age is emphasised) so "who owns what / how stale" is scannable, while the long fields take
	// their own line. Every field is still printed — this is presentation, not removal.
	meta.push(el("span", { class: "meta-owner" }, el("b", { text: `${t("tasks.owner")}:` }), task.claimedBy ?? t("tasks.unowned")));
	if (typeof task.attempts === "number") meta.push(el("span", {}, el("b", { text: t("tasks.attempts", { n: task.attempts }) })));
	if (typeof task.ageMs === "number") meta.push(el("span", { class: "meta-age" }, el("b", { text: `${t("tasks.age")}:` }), timeAgo(task.ageMs)));
	if (typeof task.priority === "number" && task.priority > 0)
		meta.push(el("span", {}, el("b", { text: t("tasks.priority", { n: task.priority }) })));
	if ((task.dependencies ?? []).length > 0)
		meta.push(
			el("span", { class: "meta-wide" }, el("b", { text: `${t("tasks.deps")}:` }), el("span", { class: "mono", text: task.dependencies.join(", ") })),
		);
	if ((task.files ?? []).length > 0)
		meta.push(
			el("span", { class: "meta-wide" }, el("b", { text: `${t("tasks.files")}:` }), el("span", { class: "mono", text: task.files.join(", ") })),
		);

	return el(
		"article",
		{ class: `task-row status-${task.status}` },
		el(
			"div",
			{ class: "task-line" },
			el("span", { class: "task-id", text: task.id }),
			badge(statusLabel(task.status), `status-${task.status}`),
			el("span", { class: "task-title", text: task.title }),
			reviewBadge(task),
		),
		el("div", { class: "task-meta" }, meta),
		task.blockedReason
			? el("p", { class: "reason" }, el("b", { text: `${t("tasks.blockedReason")}: ` }), task.blockedReason)
			: null,
		task.result ? el("p", { class: "result-line" }, el("b", { text: `${t("tasks.result")}: ` }), task.result) : null,
		task.commit ? el("p", { class: "result-line mono", text: `${t("tasks.commit")}: ${task.commit}` }) : null,
	);
}

/**
 * One status group. `total` is the AUTHORITATIVE count for that status (`snapshot.counts`), which can
 * exceed the rows on hand: the server caps `tasks` (TASK_LIMIT), so counting the rows here made a group
 * header read "已认领 20" beside a "40 已认领" chip once a pool passed the cap. The rows stay capped (the
 * page must not render unbounded lists) — the header now tells the truth and `truncated` says the rest.
 */
function taskGroup(status, tasks, collapsed, total) {
	const showAll = state.showAllTasks[status] === true;
	const shown = showAll ? tasks : tasks.slice(0, TASK_ROW_CAP);
	const body = el("div", {}, shown.map((task) => taskRow(task)));
	const more =
		tasks.length > TASK_ROW_CAP && !showAll
			? el("button", {
					class: "show-more",
					id: `more-${status}`,
					type: "button",
					text: t("collab.showMore", { n: tasks.length - TASK_ROW_CAP }),
					onclick: () => {
						state.showAllTasks[status] = true;
						renderTasks(state.snapshot);
					},
				})
			: null;
	const truncated =
		total > tasks.length
			? el("p", { class: "group-note", text: t("tasks.showingOf", { shown: tasks.length, total }) })
			: null;
	if (collapsed) {
		return el(
			"details",
			{ class: "collapsed-group" },
			el("summary", { text: `${statusLabel(status)} (${total})` }),
			body,
			truncated,
			more,
		);
	}
	return el(
		"div",
		{ class: "task-group" },
		el("div", { class: "task-group-head" }, el("h3", { text: statusLabel(status) }), badge(String(total), `status-${status}`)),
		body,
		truncated,
		more,
	);
}

function renderTasks(snapshot) {
	const tasks = snapshot.tasks ?? [];
	const counts = snapshot.counts ?? {};
	clear(dom.tasksBody);
	if (tasks.length === 0 && (counts.total ?? 0) === 0) {
		dom.tasksBody.append(el("p", { class: "empty", text: t("tasks.empty") }));
		return;
	}
	for (const status of TASK_ORDER) {
		const group = tasks.filter((task) => task.status === status);
		// The chip's number is the truth and the rows may be a subset of it — including an EMPTY subset
		// for a status whose rows all fell past the server's cap, which must still be shown, not skipped.
		const total = typeof counts[status] === "number" ? counts[status] : group.length;
		if (group.length === 0 && total === 0) continue;
		dom.tasksBody.append(taskGroup(status, group, status === "done" || status === "failed", total));
	}
}

function renderReservations(snapshot) {
	clear(dom.reservations);
	const reservations = snapshot.reservations ?? [];
	if (reservations.length === 0) {
		dom.reservations.append(el("p", { class: "empty", text: t("res.empty") }));
		return;
	}
	dom.reservations.append(
		el("div", { class: "task-group-head" }, el("h3", { text: t("res.title") }), badge(String(reservations.length), "status-claimed")),
		el(
			"ul",
			{ class: "feed" },
			reservations.map((reservation) =>
				el(
					"li",
					{ class: "feed-item" },
					el(
						"div",
						{ class: "feed-head" },
						el("span", { class: "mono", text: reservation.path }),
						el("span", { text: reservation.agentId ?? t("value.none") }),
						el("span", { text: reservation.taskId ?? t("value.none") }),
						el("span", { text: `${t("res.until")} ` }, timeUntil(reservation.leaseUntilMs, snapshot.now ?? 0)),
					),
				),
			),
		),
	);
}

/* --------------------------------------------------------------- votes */

/** The kind label, or the raw kind when the page has no translation for it (never a blank). */
function voteKindLabel(kind) {
	if (kind === null || kind === "") return t("value.none");
	const key = `votes.kind.${kind}`;
	const label = t(key);
	return label === key ? kind : label;
}

/** One tally row: the count and the names behind it. A zero row prints the count, never a fake name. */
function tallyRow(label, ids, note) {
	const names = ids.length > 0 ? ids.join(", ") : note;
	return el(
		"span",
		{},
		el("span", { class: "n", text: String(ids.length) }),
		label,
		el("span", { class: "who" }, names),
	);
}

function voteRound(round, snapshotNow) {
	const statusClass = `status-${round.status}`;
	const meta = [];
	meta.push(el("span", {}, el("b", { text: `${t("votes.roundKind")}:` }), voteKindLabel(round.kind)));
	if (round.id !== null) meta.push(el("span", { class: "mono", text: round.id }));
	if (round.openedBy !== null) meta.push(el("span", {}, el("b", { text: `${t("votes.roundOpenedBy")}:` }), round.openedBy));
	meta.push(el("span", {}, el("b", { text: `${t("votes.roundOpenedAt")}:` }), timeAgo(Math.max(0, (snapshotNow ?? 0) - round.openedAtMs))));
	// The deadline is the round's own `openedAt + timeoutMs`: a published `timeoutMs` yields a real
	// countdown, and an unpublished one prints "not published" — never a guessed time.
	if (round.deadlineMs === null) {
		meta.push(el("span", {}, el("b", { text: `${t("votes.roundDeadline")}:` }), t("votes.roundDeadlineUnknown")));
	} else {
		meta.push(el("span", {}, el("b", { text: `${t("votes.roundDeadline")}:` }), timeUntil(round.deadlineMs, snapshotNow ?? 0)));
	}

	const parts = [
		el(
			"div",
			{ class: "vote-line" },
			badge(t(`votes.status.${round.status}`), statusClass),
			el("span", { class: "vote-question", text: round.question === "" ? t("value.none") : round.question }),
		),
		el("div", { class: "vote-meta" }, meta),
	];

	if (round.status === "pending") {
		// An open round's ballots are NOT on this read-only path: `castBallot` writes the voter into the
		// event row's `agent_id`, and the frozen v1 snapshot contract ships only `{createdAtMs, type,
		// content}`. The panel says so instead of inventing a voter, a count or a "still missing" list.
		parts.push(el("p", { class: "vote-gap" }, el("b", { text: `${t("votes.ballots")}: ` }), t("votes.ballotsUnavailable")));
		parts.push(
			el(
				"div",
				{ class: "vote-meta" },
				el("span", { class: "muted", text: round.threshold === null ? t("votes.neededUnknown") : t("votes.thresholdNote", { value: round.threshold }) }),
			),
		);
		return el("article", { class: `vote-round ${statusClass}`, "aria-label": `${t(`votes.status.${round.status}`)}: ${round.question}` }, parts);
	}

	// A SETTLED round publishes its whole tally inside its terminal event: who voted which way, who was
	// absent, and the one-line reason. Those are read verbatim, so the panel shows the same numbers the
	// board entry and the event log carry — nothing recomputed, nothing extrapolated.
	const tally = el(
		"div",
		{ class: "vote-tally" },
		tallyRow(t("votes.for"), round.for, t("value.none")),
		tallyRow(t("votes.against"), round.against, t("value.none")),
		tallyRow(t("votes.absent"), round.absent, t("value.none")),
		round.offline.length > 0 ? tallyRow(t("votes.offline"), round.offline, t("value.none")) : null,
	);
	const required =
		round.base !== null && round.needed !== null
			? el("span", { class: "muted", text: t("votes.needed", { need: round.needed, base: round.base }) })
			: el("span", { class: "muted", text: t("votes.neededUnknown") });
	parts.push(tally, el("div", { class: "vote-meta" }, required));
	if (round.reason !== null && round.reason !== "") {
		parts.push(el("p", { class: "reason" }, el("b", { text: `${t("votes.reason")}: ` }), round.reason));
	}
	if (round.boardId !== null) parts.push(el("p", { class: "group-note", text: t("votes.boardRef", { id: round.boardId }) }));

	return el("article", { class: `vote-round ${statusClass}`, "aria-label": `${t(`votes.status.${round.status}`)}: ${round.question}` }, parts);
}

function renderVotes(snapshot) {
	clear(dom.votesBody);
	if (snapshot === null) return;
	const now = snapshot.now ?? 0;
	const rounds = votesFromSnapshot(snapshot);
	const boardIds = voteBoardIds(snapshot);
	for (const round of rounds) {
		if (round.id !== null && boardIds.has(round.id)) round.boardId = boardIds.get(round.id) ?? null;
	}
	const open = rounds.filter((round) => round.status === "pending");
	const settled = rounds.filter((round) => round.status !== "pending");
	dom.votesNote.textContent = t("votes.note", { open: open.length, settled: settled.length });

	if (rounds.length === 0) {
		dom.votesBody.append(el("p", { class: "empty", text: t("votes.empty.all") }));
		return;
	}

	const shown = state.showAllVotes ? rounds : rounds.slice(0, FEED_ROW_CAP);
	const more =
		rounds.length > FEED_ROW_CAP && !state.showAllVotes
			? el("button", {
					class: "show-more",
					id: "more-votes",
					type: "button",
					text: t("votes.showMore", { n: rounds.length - FEED_ROW_CAP }),
					onclick: () => {
						state.showAllVotes = true;
						renderVotes(state.snapshot);
					},
				})
			: null;
	const less =
		state.showAllVotes && rounds.length > FEED_ROW_CAP
			? el("button", {
					class: "show-more",
					id: "less-votes",
					type: "button",
					text: t("votes.showLess"),
					onclick: () => {
						state.showAllVotes = false;
						renderVotes(state.snapshot);
					},
				})
			: null;

	const liveRows = shown.filter((round) => round.status === "pending").map((round) => voteRound(round, now));
	const recentRows = shown.filter((round) => round.status !== "pending").map((round) => voteRound(round, now));
	if (state.activeVoteTab === "live") {
		dom.votesBody.setAttribute("id", "panel-votes");
		dom.votesBody.setAttribute("role", "tabpanel");
		dom.votesBody.setAttribute("aria-labelledby", "vote-tab-live");
		dom.votesBody.setAttribute("tabindex", "0");
		// The open tab shows the rounds still in progress; their countdowns are the live evidence.
		if (open.length === 0) {
			dom.votesBody.append(el("p", { class: "empty", text: t("votes.empty.live") }));
			return;
		}
		dom.votesBody.append(...liveRows, more, less);
		return;
	}

	dom.votesBody.setAttribute("id", "panel-votes");
	dom.votesBody.setAttribute("role", "tabpanel");
	dom.votesBody.setAttribute("aria-labelledby", "vote-tab-recent");
	dom.votesBody.setAttribute("tabindex", "0");
	// The settled tab shows only finished rounds: the published tally and its reason, newest first.
	if (settled.length === 0) {
		dom.votesBody.append(el("p", { class: "empty", text: t("votes.empty.recent") }));
		return;
	}
	dom.votesBody.append(...recentRows, more, less);
}

function feedList(items, renderItem, tab) {
	const showAll = state.showAll[tab] === true;
	const shown = showAll ? items : items.slice(0, FEED_ROW_CAP);
	const list = el("ul", { class: "feed" }, shown.map(renderItem));
	const more =
		items.length > FEED_ROW_CAP && !showAll
			? el("button", {
					class: "show-more",
					id: `more-${tab}`,
					type: "button",
					text: t("collab.showMore", { n: items.length - FEED_ROW_CAP }),
					onclick: () => {
						state.showAll[tab] = true;
						renderFeeds(state.snapshot);
					},
				})
			: null;
	const less =
		showAll && items.length > FEED_ROW_CAP
			? el("button", {
					class: "show-more",
					id: `less-${tab}`,
					type: "button",
					text: t("collab.showLess"),
					onclick: () => {
						state.showAll[tab] = false;
						renderFeeds(state.snapshot);
					},
				})
			: null;
	return el("div", {}, list, more, less);
}

function renderFeeds(snapshot) {
	clear(dom.feedBody);
	const tab = state.activeTab;
	dom.feedBody.setAttribute("id", "panel-feed");
	dom.feedBody.setAttribute("role", "tabpanel");
	dom.feedBody.setAttribute("aria-labelledby", `tab-${tab}`);
	dom.feedBody.setAttribute("tabindex", "0");

	if (tab === "board") {
		// The payload is NEWEST-first: this order is what makes the visible window (FEED_ROW_CAP) the
		// newest rows, with "show more" walking backwards into history. Reversing here showed the OLDEST
		// cap-sized slice instead, so the collaboration the operator opens the page to watch needed clicks.
		const board = snapshot.board ?? [];
		if (board.length === 0) {
			dom.feedBody.append(el("p", { class: "empty", text: t("collab.empty.board") }));
			return;
		}
		dom.feedBody.append(
			feedList(
				board,
				(entry) =>
					el(
						"li",
						{ class: `feed-item type-${entry.type}` },
						el(
							"div",
							{ class: "feed-head" },
							el("span", { class: "feed-type", text: entry.type }),
							el("span", { text: entry.author ?? t("value.none") }),
							entry.taskId ? el("span", { class: "mono", text: entry.taskId }) : null,
							timeAgo((snapshot.now ?? 0) - entry.createdAtMs),
							el("span", { class: "mono", text: `#${entry.id}` }),
						),
						el("p", { class: "feed-body", text: entry.content }),
					),
				tab,
			),
		);
		return;
	}

	if (tab === "messages") {
		const messages = snapshot.messages ?? [];
		if (messages.length === 0) {
			dom.feedBody.append(el("p", { class: "empty", text: t("collab.empty.messages") }));
			return;
		}
		dom.feedBody.append(
			feedList(
				messages,
				(message) =>
					el(
						"li",
						{ class: `feed-item ${message.urgent ? "is-urgent" : ""} ${message.read === false ? "is-unread" : ""}`.trim() },
						el(
							"div",
							{ class: "feed-head" },
							el("span", { class: "feed-type", text: `${message.from} → ${message.to === "all" ? t("collab.all") : message.to}` }),
							message.urgent ? el("span", { class: "tag urgent", text: t("collab.urgent") }) : null,
							el("span", { class: "tag", text: message.read === false ? t("collab.unread") : t("collab.read") }),
							message.taskId ? el("span", { class: "mono", text: message.taskId }) : null,
							timeAgo((snapshot.now ?? 0) - message.createdAtMs),
						),
						el("p", { class: "feed-body", text: message.content }),
					),
				tab,
			),
		);
		return;
	}

	const events = snapshot.events ?? [];
	if (events.length === 0) {
		dom.feedBody.append(el("p", { class: "empty", text: t("collab.empty.events") }));
		return;
	}
	dom.feedBody.append(
		feedList(
			events,
			(event) =>
				el(
					"li",
					{ class: "feed-item" },
					el(
						"div",
						{ class: "feed-head" },
						el("span", { class: "feed-type", text: event.type }),
						timeAgo((snapshot.now ?? 0) - event.createdAtMs),
					),
					el("p", { class: "feed-body", text: event.content }),
				),
			tab,
		),
	);
}

/* ---------------------------------------------------------------- data */

/**
 * Cheap change detector. It deliberately ignores `now` and the *AgeMs fields, which the server
 * recomputes on every poll: without that, every tick would repaint and steal keyboard focus.
 */
function signature(snapshot) {
	return JSON.stringify([
		snapshot.counts,
		(snapshot.agents ?? []).map((a) => [a.id, a.status, a.role, a.currentTask, a.isMain, a.capabilities, a.worktree]),
		(snapshot.tasks ?? []).map((task) => [
			task.id,
			task.status,
			task.claimedBy,
			task.attempts,
			task.reviewStatus,
			task.updatedAtMs,
			task.priority,
			task.result,
			task.commit,
		]),
		(snapshot.board ?? []).map((entry) => entry.id),
		(snapshot.messages ?? []).map((message) => [message.id, message.read]),
		(snapshot.events ?? []).map((event) => [event.createdAtMs, event.type]),
		(snapshot.reservations ?? []).map((reservation) => [reservation.path, reservation.agentId, reservation.leaseUntilMs]),
		// The vote rounds are derived from the events feed, so a new ballot must repaint the panel: the
		// countdowns and the "still missing" list move with every one.
		(snapshot.events ?? [])
			.filter((event) => typeof event.type === "string" && event.type.startsWith("vote."))
			.map((event) => [event.createdAtMs, event.type, event.content]),
	]);
}

function apply(snapshot) {
	state.lastError = null;
	const next = signature(snapshot);
	state.snapshot = snapshot;
	state.receivedAt = Date.now();
	if (next !== state.signature) {
		state.signature = next;
		render(snapshot);
	} else {
		renderMeta(snapshot);
		renderConnection();
	}
}

function setConn(mode, retryIn = 0) {
	state.conn = mode;
	state.retryIn = retryIn;
	renderConnection();
}

async function refresh() {
	try {
		const url = state.fixture ? FIXTURE_URL : SNAPSHOT_URL;
		const response = await fetch(url, { cache: "no-store" });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		apply(await response.json());
		return true;
	} catch (error) {
		state.lastError = error instanceof Error ? error.message : String(error);
		return false;
	}
}

function startPolling() {
	if (state.pollTimer) return;
	state.pollTimer = setInterval(async () => {
		if (document.hidden) return;
		const ok = await refresh();
		if (!ok) setConn("disconnected", Math.round(POLL_MS / 1000));
		else if (state.conn !== "polling") setConn("polling");
	}, POLL_MS);
}

function startStream() {
	try {
		state.source = new EventSource(EVENTS_URL);
	} catch {
		setConn("polling");
		startPolling();
		return;
	}
	state.source.addEventListener("open", () => {
		if (state.pollTimer) {
			clearInterval(state.pollTimer);
			state.pollTimer = null;
		}
		setConn("live");
	});
	state.source.addEventListener("snapshot", () => {
		void refresh().then((ok) => {
			if (!ok) setConn("disconnected");
		});
	});
	state.source.addEventListener("error", () => {
		// The stream is gone (or never existed): keep the page honest and fall back to polling.
		try {
			state.source?.close();
		} catch {
			/* ignore */
		}
		state.source = null;
		setConn("polling");
		startPolling();
	});
}

async function boot() {
	// Paint something honest before the first byte arrives: an empty page reads as a broken page.
	buildShell();
	append(dom.feedBody, [el("p", { class: "empty", text: t("app.loading") })]);
	const ok = await refresh();
	if (!ok) renderEmptyShell();
	startClock();
	if (state.fixture) {
		setConn(ok ? "fixture" : "disconnected");
		return;
	}
	setConn(ok ? "connecting" : "disconnected", ok ? 0 : Math.round(POLL_MS / 1000));
	startStream();
}

/** Ages must keep moving between snapshots; this touches only the time labels. */
function startClock() {
	if (state.clock) return;
	state.clock = setInterval(refreshTimes, TIME_TICK_MS);
}

function renderEmptyShell() {
	state.snapshot = {
		now: Date.now(),
		swarmRoot: null,
		counts: {},
		agents: [],
		tasks: [],
		board: [],
		messages: [],
		events: [],
		reservations: [],
	};
	render(state.snapshot);
}

void boot();
