// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Terry Cornelusse

import * as vscode from "vscode";
import * as api from "./api";
import { RunRecord, runs } from "./run";
import { RepoNode, SessionNode, WorktreeNode } from "./trees";

const VIEW_TYPE = "worktreeStation.dashboard";
const BOARD_KEY = "worktreeStation.board";
const NAMES_KEY = "worktreeStation.names";

export type Column = "prep" | "wip" | "uat";
const COLUMNS: Column[] = ["prep", "wip", "uat"];

/**
 * Column set by hand, shared across windows through globalState. A session
 * missing from the table is in Preparation: that is where a session is born, and
 * git state cannot tell where it stands in the workflow.
 */
function assignments(): Record<string, Column> {
  return ctx?.globalState.get<Record<string, Column>>(BOARD_KEY, {}) ?? {};
}

async function assign(id: string, column: Column): Promise<void> {
  if (!ctx || !id) {
    return;
  }
  const next = { ...assignments(), [id]: column };
  await ctx.globalState.update(BOARD_KEY, next);
}

/**
 * Name given by hand. The timestamp stays the session's identity; the name only
 * makes it readable — "billing revamp" says what 20260918-101010 hides.
 */
function names(): Record<string, string> {
  return ctx?.globalState.get<Record<string, string>>(NAMES_KEY, {}) ?? {};
}

async function rename(id: string, label: string): Promise<void> {
  const s = (await api.sessions()).find((x) => x.id === id);
  if (!ctx || !s) {
    return;
  }
  const current = names()[id] ?? "";
  const answer = await vscode.window.showInputBox({
    title: `Rename ${label}`,
    prompt: "Clear the field to restore the original name",
    value: current,
    placeHolder: s.label,
  });
  if (answer === undefined) {
    return;
  }
  const next = { ...names() };
  const trimmed = answer.trim();
  if (trimmed) {
    next[id] = trimmed;
  } else {
    delete next[id];
  }
  await ctx.globalState.update(NAMES_KEY, next);
}

/** Forget sessions that are gone, otherwise the tables grow with every deletion. */
async function prune(alive: Set<string>): Promise<void> {
  if (!ctx) {
    return;
  }
  for (const key of [BOARD_KEY, NAMES_KEY]) {
    const current = ctx.globalState.get<Record<string, string>>(key, {}) ?? {};
    const kept = Object.fromEntries(Object.entries(current).filter(([id]) => alive.has(id)));
    if (Object.keys(kept).length !== Object.keys(current).length) {
      await ctx.globalState.update(key, kept);
    }
  }
}


let panel: vscode.WebviewPanel | undefined;
let ctx: vscode.ExtensionContext | undefined;

// ── Data sent to the webview ──────────────────────────────────────────────────

interface Payload {
  sessions: {
    id: string;
    label: string;
    /** Original name, offered as-is when renaming. */
    origin: string;
    loaded: boolean;
    busy: boolean;
    column: Column;
    worktrees: {
      path: string;
      name: string;
      repo: string;
      kind: string;
      branch: string;
      exists: boolean;
      dirty: number;
      ahead: number;
      behind: number;
      busy: boolean;
      reason: string;
    }[];
  }[];
  repos: { path: string; name: string; branch: string; base: string; dirty: number; ahead: number; behind: number }[];
  runs: RunRecord[];
  claudeMode: string;
}

function loadedPaths(): Set<string> {
  return new Set((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
}

async function collect(): Promise<Payload> {
  const [sessionList, repoList] = await Promise.all([api.sessions(), api.repos()]);
  const open = loadedPaths();
  await prune(new Set(sessionList.map((s) => s.id).filter(Boolean)));
  const manual = assignments();
  const named = names();

  return {
    sessions: sessionList.map((s) => ({
      id: s.id,
      label: named[s.id] ?? s.label,
      origin: s.label,
      column: manual[s.id] ?? "prep",
      loaded: s.worktrees.some((w) => open.has(w.path)),
      busy: s.busy,
      worktrees: s.worktrees.map((w) => ({
        path: w.path,
        name: w.name,
        repo: w.repo,
        kind: w.kind,
        branch: w.branch,
        exists: w.exists,
        dirty: w.dirty,
        ahead: w.ahead,
        behind: w.behind,
        busy: w.busy,
        reason: w.reason,
      })),
    })),
    repos: repoList.map((r) => ({
      path: r.path,
      name: r.name,
      branch: r.branch,
      base: r.base,
      dirty: r.dirty,
      ahead: r.ahead,
      behind: r.behind,
    })),
    runs: runs().slice(0, 12),
    claudeMode: vscode.workspace.getConfiguration("worktreeStation").get<string>("claudeMode") ?? "terminal",
  };
}

// ── Panel lifecycle ───────────────────────────────────────────────────────────

export function initDashboard(context: vscode.ExtensionContext): void {
  ctx = context;
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(restored: vscode.WebviewPanel) {
        adopt(restored);
        await refreshDashboard();
      },
    }),
  );
}

export function dashboardIsOpen(): boolean {
  return panel !== undefined;
}

export async function openDashboard(beside = false): Promise<void> {
  if (panel) {
    panel.reveal(panel.viewColumn, false);
    await refreshDashboard();
    return;
  }
  const column = beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
  adopt(
    vscode.window.createWebviewPanel(VIEW_TYPE, "Worktree Station", column, {
      enableScripts: true,
      // The panel keeps its state when switching tabs: otherwise every return
      // triggers a full collection and loses the scroll position.
      retainContextWhenHidden: true,
    }),
  );
  await refreshDashboard();
}

function adopt(p: vscode.WebviewPanel): void {
  panel?.dispose();
  panel = p;
  p.webview.options = { enableScripts: true };
  if (ctx) {
    p.iconPath = vscode.Uri.joinPath(ctx.extensionUri, "media", "station.svg");
  }
  p.webview.html = html(p.webview);
  p.onDidDispose(() => {
    if (panel === p) {
      panel = undefined;
    }
  });
  p.webview.onDidReceiveMessage((m) => {
    handle(m).catch((e) =>
      vscode.window.showErrorMessage(`Worktree Station: ${e instanceof Error ? e.message : String(e)}`),
    );
  });
}

/** Recollect and push the state. Costs nothing when no panel is open. */
export async function refreshDashboard(): Promise<void> {
  if (!panel) {
    return;
  }
  const data = await collect();
  panel.webview.postMessage({ type: "state", data });
}

// ── Actions ───────────────────────────────────────────────────────────────────

interface Msg {
  cmd?: string;
  id?: string;
  arg?: string;
  /** Target column of a card move. */
  dir?: string;
  /** Displayed name, used as the rename box title. */
  label?: string;
}

async function handle(msg: Msg): Promise<void> {
  if (!msg || typeof msg.cmd !== "string") {
    return;
  }
  if (msg.cmd === "ready" || msg.cmd === "refresh") {
    if (msg.cmd === "refresh") {
      api.invalidate();
    }
    await refreshDashboard();
    return;
  }
  if (msg.cmd === "move") {
    const column = msg.dir as Column;
    if (msg.arg && COLUMNS.includes(column)) {
      await assign(msg.arg, column);
      await refreshDashboard();
    }
    return;
  }
  if (msg.cmd === "rename") {
    if (msg.arg) {
      await rename(msg.arg, msg.label || msg.arg);
      await refreshDashboard();
    }
    return;
  }
  if (msg.cmd === "terminal") {
    await openTerminal(msg.arg ?? "");
    return;
  }
  const id = msg.id;
  if (!id || !id.startsWith("worktreeStation.")) {
    return;
  }
  switch (msg.cmd) {
    case "plain":
      await vscode.commands.executeCommand(id);
      return;
    case "session": {
      const s = (await api.sessions()).find((x) => x.id === msg.arg);
      if (s) {
        const open = loadedPaths();
        await vscode.commands.executeCommand(
          id,
          new SessionNode(s, s.worktrees.some((w) => open.has(w.path))),
        );
      }
      return;
    }
    case "worktree": {
      const all = await api.sessions();
      const w =
        all.flatMap((s) => s.worktrees).find((x) => x.path === msg.arg) ??
        (await api.repos()).find((x) => x.path === msg.arg);
      if (w) {
        await vscode.commands.executeCommand(id, new WorktreeNode(w));
      }
      return;
    }
    case "repo": {
      const r = (await api.repos()).find((x) => x.path === msg.arg);
      if (r) {
        await vscode.commands.executeCommand(id, new RepoNode(r));
      }
      return;
    }
  }
}

/**
 * A session holds one worktree per repo: opening "the" terminal only makes sense
 * once you say which. A single live repo answers by itself.
 */
async function openTerminal(sessionId: string): Promise<void> {
  const s = (await api.sessions()).find((x) => x.id === sessionId);
  if (!s) {
    return;
  }
  const live = s.worktrees.filter((w) => w.exists);
  if (live.length === 0) {
    vscode.window.showWarningMessage("No worktree on disk for this session.");
    return;
  }
  let target = live[0];
  if (live.length > 1) {
    const pick = await vscode.window.showQuickPick(
      live.map((w) => ({
        label: w.repo || w.name,
        description: w.branch,
        detail: w.dirty ? `${w.dirty} changed file(s)` : undefined,
        wt: w,
      })),
      { title: `Terminal · ${s.label}`, placeHolder: "Which repo?" },
    );
    if (!pick) {
      return;
    }
    target = pick.wt;
  }
  await vscode.commands.executeCommand("worktreeStation.worktree.terminal", new WorktreeNode(target));
}

// ── View ──────────────────────────────────────────────────────────────────────

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function html(webview: vscode.Webview): string {
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    padding: 20px 28px 48px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  .wrap { max-width: 1100px; margin: 0 auto; }
  header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
  h1 { font-size: 1.35em; margin: 0; font-weight: 600; }
  .bar { display: flex; gap: 8px; flex-wrap: wrap; margin: 14px 0 26px; }
  h2 {
    font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--vscode-descriptionForeground);
    margin: 30px 0 10px; font-weight: 600;
  }
  h2 button { text-transform: none; letter-spacing: normal; margin-left: 8px; padding: 2px 8px; font-size: 1.1em; }
  button {
    font-family: inherit; font-size: 0.86em; line-height: 1.1;
    padding: 5px 11px; border-radius: 4px; cursor: pointer;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.danger:hover {
    background: var(--vscode-inputValidation-errorBackground);
    border-color: var(--vscode-inputValidation-errorBorder);
  }
  .board { display: grid; grid-template-columns: repeat(3, minmax(260px, 1fr)); gap: 14px; align-items: stretch; }
  @media (max-width: 900px) { .board { grid-template-columns: 1fr; } }
  .col {
    display: flex; flex-direction: column;
    border: 1px dashed transparent; border-radius: 8px; padding: 6px;
    min-height: 140px; transition: background .12s, border-color .12s;
  }
  /* The stack takes the remaining space: the drop zone reaches the bottom. */
  .col .stack { flex: 1 1 auto; }
  .col.over { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
  .col > h4 {
    margin: 2px 4px 10px; font-size: 0.78em; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--vscode-descriptionForeground);
    display: flex; align-items: center; gap: 7px;
  }
  .col .card + .card { margin-top: 10px; }
  .card[draggable="true"] { cursor: grab; }
  .card.drag { opacity: 0.45; }
  .move { display: flex; gap: 4px; margin-left: auto; }
  .move button { padding: 1px 7px; font-size: 0.9em; line-height: 1.2; }
  .card h3 .ghost {
    background: transparent; border-color: transparent; opacity: 0.5;
    padding: 1px 4px; font-size: 0.9em; line-height: 1.2; margin-right: -2px;
  }
  .card:hover h3 .ghost { opacity: 1; }
  .card h3[data-rn] { cursor: text; }
  .col .empty { padding: 10px 6px; }
  .card {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.28));
    border-radius: 7px; padding: 14px 16px;
    background: var(--vscode-editorWidget-background, transparent);
  }
  .card.on { border-color: var(--vscode-focusBorder); }
  .card h3 { margin: 0 0 2px; font-size: 1em; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .tag {
    font-size: 0.72em; padding: 1px 7px; border-radius: 9px; font-weight: 500;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .wt { display: flex; justify-content: space-between; gap: 10px; padding: 5px 0; font-size: 0.88em; }
  .wt + .wt { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18)); }
  .wt .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wt .st { color: var(--vscode-descriptionForeground); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .dirty { color: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-charts-yellow)); }
  .ahead { color: var(--vscode-charts-blue); }
  .gone { color: var(--vscode-errorForeground); }
  .acts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.88em; }
  td { padding: 5px 8px 5px 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18)); }
  td.num { text-align: right; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .ok { color: var(--vscode-charts-green); }
  .ko { color: var(--vscode-errorForeground); }
  .empty { color: var(--vscode-descriptionForeground); font-size: 0.9em; padding: 6px 0 2px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Worktree Station</h1>
  </header>
  <div class="bar">
    <button class="primary" data-cmd="plain" data-id="worktreeStation.newSession">New session</button>
    <button data-cmd="refresh">Refresh</button>
    <button data-cmd="plain" data-id="worktreeStation.repo.syncAll">Sync repos</button>
    <button data-cmd="plain" data-id="worktreeStation.doctor">Diagnostics</button>
  </div>
  <div id="app"></div>
</div>
<script nonce="${n}">
const vscodeApi = acquireVsCodeApi();
const app = document.getElementById("app");

function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function btn(label, cmd, id, arg, cls) {
  return '<button' + (cls ? ' class="' + cls + '"' : '') +
    ' data-cmd="' + cmd + '" data-id="' + id + '"' +
    (arg ? ' data-arg="' + esc(arg) + '"' : '') +
    '>' + esc(label) + '</button>';
}

function wtLine(w) {
  let st = "";
  if (!w.exists) st = '<span class="gone">missing</span>';
  else {
    const bits = [];
    if (w.dirty) bits.push('<span class="dirty">' + w.dirty + ' changed</span>');
    if (w.ahead) bits.push('<span class="ahead">↑' + w.ahead + '</span>');
    if (w.behind) bits.push('↓' + w.behind);
    st = bits.join(" ") || "clean";
  }
  return '<div class="wt"><span class="who">' + esc(w.repo || w.name) +
    ' · <code>' + esc(w.branch) + '</code></span><span class="st">' + st + '</span></div>';
}

const COLS = [
  { id: "prep", label: "Preparation" },
  { id: "wip", label: "In progress" },
  { id: "uat", label: "UAT" },
];

function renameBtn(s) {
  if (!s.id) return "";
  return '<button draggable="false" class="ghost" data-cmd="rename" data-arg="' + esc(s.id) +
    '" data-label="' + esc(s.label) + '" title="Rename">✎</button>';
}

function moveBtns(s) {
  const i = COLS.findIndex((c) => c.id === s.column);
  let out = '<span class="move">';
  if (i > 0) out += '<button draggable="false" data-cmd="move" data-arg="' + esc(s.id) +
    '" data-dir="' + COLS[i - 1].id + '" title="To ' + COLS[i - 1].label + '">←</button>';
  if (i < COLS.length - 1) out += '<button draggable="false" data-cmd="move" data-arg="' + esc(s.id) +
    '" data-dir="' + COLS[i + 1].id + '" title="To ' + COLS[i + 1].label + '">→</button>';
  return out + "</span>";
}

let claudeMode = "terminal";

function sessionCard(s) {
  const live = s.worktrees.some((w) => w.exists);
  // The main button follows claudeMode: in terminal mode, nothing opens a window
  // unless explicitly asked.
  const acts = claudeMode === "window"
    ? [btn("Window", "session", "worktreeStation.session.openWindow", s.id, "primary")]
    : live ? [btn("✦ Claude", "session", "worktreeStation.session.claude", s.id, "primary")] : [];
  if (live) {
    acts.push(btn("Terminal", "terminal", "", s.id));
  }
  if (claudeMode !== "window") {
    acts.push(btn("Window", "session", "worktreeStation.session.openWindow", s.id));
  }
  acts.push(btn("Delete", "session", "worktreeStation.session.delete", s.id, "danger"));
  return '<div class="card' + (s.loaded ? " on" : "") + '" draggable="true" data-sid="' +
    esc(s.id) + '">' +
    "<h3" + (s.id ? ' data-rn="' + esc(s.id) + '" data-label="' + esc(s.label) +
      '" title="Double-click to rename"' : "") + ">" + renameBtn(s) +
    esc(s.label) + (s.busy ? '<span class="tag">busy</span>' : "") +
    (s.loaded ? '<span class="tag">here</span>' : "") + moveBtns(s) + '</h3>' +
    s.worktrees.map(wtLine).join("") +
    '<div class="acts">' + acts.join("") + "</div></div>";
}

function board(sessions) {
  return '<div class="board">' + COLS.map((c) => {
    const inCol = sessions.filter((s) => s.column === c.id);
    return '<div class="col" data-col="' + c.id + '"><h4>' + esc(c.label) +
      '<span class="tag">' + inCol.length + '</span></h4><div class="stack">' +
      (inCol.length ? inCol.map(sessionCard).join("")
                    : '<div class="empty">Drop a session here.</div>') +
      "</div></div>";
  }).join("") + "</div>";
}

function repoRow(r) {
  const bits = [];
  if (r.dirty) bits.push('<span class="dirty">' + r.dirty + ' changed</span>');
  if (r.ahead) bits.push('<span class="ahead">↑' + r.ahead + "</span>");
  if (r.behind) bits.push("↓" + r.behind);
  return "<tr><td>" + esc(r.name) + "</td><td><code>" + esc(r.branch) + "</code></td>" +
    '<td class="num">' + (bits.join(" ") || "clean") + "</td>" +
    '<td class="num">' + btn("Branch", "repo", "worktreeStation.repo.editBase", r.path) + " " +
    btn("Remove", "repo", "worktreeStation.repo.remove", r.path, "danger") + "</td></tr>";
}

function runRow(r) {
  const secs = (r.durationMs / 1000).toFixed(1);
  const when = new Date(r.finishedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return '<tr><td class="' + (r.ok ? "ok" : "ko") + '">' + (r.ok ? "✓" : "✗") + "</td>" +
    "<td>" + esc(r.label) + "</td>" +
    '<td class="num">' + secs + " s</td>" +
    '<td class="num">' + when + "</td></tr>";
}

function render(d) {
  claudeMode = d.claudeMode || "terminal";
  let out = "<h2>Sessions</h2>";
  out += d.sessions.length
    ? board(d.sessions)
    : '<div class="empty">No session yet — “New session” creates one.</div>';

  out += '<h2>Repos ' + btn("Add repo", "plain", "worktreeStation.repo.add") + "</h2>";
  out += d.repos.length ? "<table>" + d.repos.map(repoRow).join("") + "</table>"
                        : '<div class="empty">No repo — “Add repo” declares a clone.</div>';

  out += "<h2>Recent runs</h2>";
  out += d.runs.length ? "<table>" + d.runs.map(runRow).join("") + "</table>"
                       : '<div class="empty">Nothing yet.</div>';

  app.innerHTML = out;
}

let dragged = null;

document.addEventListener("dragstart", (e) => {
  const card = e.target instanceof Element ? e.target.closest(".card[data-sid]") : null;
  if (!card) return;
  dragged = card.dataset.sid;
  card.classList.add("drag");
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    // Firefox/Electron ignore a drag with no payload.
    e.dataTransfer.setData("text/plain", dragged);
  }
});

document.addEventListener("dragend", (e) => {
  const card = e.target instanceof Element ? e.target.closest(".card") : null;
  if (card) card.classList.remove("drag");
  document.querySelectorAll(".col.over").forEach((c) => c.classList.remove("over"));
  dragged = null;
});

document.addEventListener("dragover", (e) => {
  const col = e.target instanceof Element ? e.target.closest(".col[data-col]") : null;
  if (!col || !dragged) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  col.classList.add("over");
});

document.addEventListener("dragleave", (e) => {
  const col = e.target instanceof Element ? e.target.closest(".col[data-col]") : null;
  if (col && !col.contains(e.relatedTarget)) col.classList.remove("over");
});

document.addEventListener("drop", (e) => {
  const col = e.target instanceof Element ? e.target.closest(".col[data-col]") : null;
  const sid = dragged || (e.dataTransfer ? e.dataTransfer.getData("text/plain") : "");
  if (!col || !sid) return;
  e.preventDefault();
  col.classList.remove("over");
  vscodeApi.postMessage({ cmd: "move", arg: sid, dir: col.dataset.col });
});

document.addEventListener("click", (e) => {
  const el = e.target instanceof Element ? e.target.closest("button[data-cmd]") : null;
  if (!el) return;
  vscodeApi.postMessage({
    cmd: el.dataset.cmd,
    id: el.dataset.id,
    arg: el.dataset.arg,
    dir: el.dataset.dir,
    label: el.dataset.label,
  });
});

document.addEventListener("dblclick", (e) => {
  const h = e.target instanceof Element ? e.target.closest("h3[data-rn]") : null;
  if (!h) return;
  vscodeApi.postMessage({ cmd: "rename", arg: h.dataset.rn, label: h.dataset.label });
});

window.addEventListener("message", (e) => {
  if (e.data && e.data.type === "state") render(e.data.data);
});

vscodeApi.postMessage({ cmd: "ready" });
</script>
</body>
</html>`;
}
