// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Terry Cornelusse

import { execFile } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import * as api from "./api";
import { Worktree } from "./api";
import * as claude from "./claude";
import * as dashboard from "./dashboard";
import * as repoAdmin from "./repos";
import { clearRuns, initRuns, quiet, task, terminal, withProgress } from "./run";
import * as windows from "./windows";
import {
  dbtFoldersInWorkspace,
  ModelNode,
  ModelsProvider,
  RepoNode,
  ReposProvider,
  RunsProvider,
  SessionNode,
  SessionsProvider,
  WorktreeNode,
} from "./trees";

let sessions: SessionsProvider;
let models: ModelsProvider;
let repos: ReposProvider;
let runsView: RunsProvider;
let status: vscode.StatusBarItem;

function cfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration("worktreeStation").get<T>(key) ?? fallback;
}

function fail(e: unknown): void {
  vscode.window.showErrorMessage(`Worktree Station: ${e instanceof Error ? e.message : String(e)}`);
}

async function refreshAll(force = true): Promise<void> {
  if (force) {
    api.invalidate();
  }
  sessions.refresh();
  models.refresh();
  repos.refresh();
  await Promise.all([updateStatus(), dashboard.refreshDashboard()]);
}

// ── Target resolution ─────────────────────────────────────────────────────────
/** dbt folder to act on: the active file's, otherwise the only one open. */
async function targetDbtDir(hint?: string): Promise<string | undefined> {
  if (hint) {
    return hint;
  }
  const folders = await dbtFoldersInWorkspace();
  if (folders.length === 0) {
    vscode.window.showWarningMessage("No dbt folder open in this window.");
    return undefined;
  }
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (active) {
    const match = folders.find((f) => active.startsWith(f.dir + path.sep));
    if (match) {
      return match.dir;
    }
  }
  if (folders.length === 1) {
    return folders[0].dir;
  }
  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.label, description: f.dir, dir: f.dir })),
    { title: "Which worktree?" },
  );
  return pick?.dir;
}

/** Target model: the item clicked in the tree, otherwise the active .sql file. */
async function targetModel(node?: unknown): Promise<{ name: string; dir: string } | undefined> {
  if (node instanceof ModelNode) {
    return { name: node.model.name, dir: node.dir };
  }
  const doc = vscode.window.activeTextEditor?.document;
  if (doc && doc.uri.fsPath.endsWith(".sql")) {
    const dir = await targetDbtDir();
    if (dir) {
      return { name: path.basename(doc.uri.fsPath, ".sql"), dir };
    }
    return undefined;
  }
  vscode.window.showWarningMessage("Open a .sql model, or pick one from the Worktree Station panel.");
  return undefined;
}

function worktreeOf(node: unknown): Worktree | undefined {
  if (node instanceof WorktreeNode) {
    return node.wt;
  }
  if (node instanceof RepoNode) {
    return node.repo;
  }
  return undefined;
}

// ── Workspace multi-root ──────────────────────────────────────────────────────
function openPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

/**
 * Add folders to THE current window. VS Code reloads the extension host when going
 * from a single folder to a multi-root workspace: warn first.
 */
async function addFolders(paths: string[]): Promise<void> {
  const open = new Set(openPaths());
  const toAdd = paths.filter((p) => !open.has(p));
  if (toAdd.length === 0) {
    return;
  }
  if (vscode.workspace.workspaceFile === undefined && open.size > 0) {
    const go = await vscode.window.showWarningMessage(
      "This window has a single folder open. Adding it to a session turns it into a multi-root workspace and reloads the window.",
      { modal: true },
      "Continue",
    );
    if (go !== "Continue") {
      return;
    }
  }
  const ok = vscode.workspace.updateWorkspaceFolders(
    vscode.workspace.workspaceFolders?.length ?? 0,
    null,
    ...toAdd.map((p) => ({ uri: vscode.Uri.file(p), name: path.basename(p) })),
  );
  if (!ok) {
    vscode.window.showErrorMessage("VS Code refused to add the folders to this window.");
  }
}

/**
 * VS Code forbids calling updateWorkspaceFolders again before
 * onDidChangeWorkspaceFolders has fired: remove one folder at a time and wait for
 * the event in between. From the highest index to the lowest, otherwise the
 * indexes shift under our feet.
 */
async function removeFolders(paths: string[]): Promise<void> {
  const target = new Set(paths);
  for (;;) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    let index = -1;
    for (let i = folders.length - 1; i >= 0; i--) {
      if (target.has(folders[i].uri.fsPath)) {
        index = i;
        break;
      }
    }
    if (index < 0) {
      return;
    }
    const changed = new Promise<void>((resolve) => {
      const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        sub.dispose();
        resolve();
      });
      // Safety net: if VS Code refuses the change, the event never comes.
      setTimeout(() => {
        sub.dispose();
        resolve();
      }, 3000);
    });
    if (!vscode.workspace.updateWorkspaceFolders(index, 1)) {
      vscode.window.showErrorMessage("VS Code refused to remove the folder from this window.");
      return;
    }
    await changed;
  }
}

// ── Status ────────────────────────────────────────────────────────────────────
async function updateStatus(): Promise<void> {
  try {
    const open = new Set(openPaths());
    const all = await api.sessions();
    const current = all.find((s) => s.worktrees.length > 0 && s.worktrees.every((w) => open.has(w.path)));
    if (!current) {
      status.text = "$(vm-outline) Station";
      status.tooltip = "No complete session loaded in this window";
    } else {
      const dirty = current.worktrees.reduce((n, w) => n + w.dirty, 0);
      status.text = `$(vm-active) ${current.label}${dirty ? ` $(circle-filled) ${dirty}` : ""}`;
      status.tooltip = new vscode.MarkdownString(
        [`### Session ${current.label}`, ...current.worktrees.map((w) => `**${w.repo}** \`${w.branch}\``)].join("\n\n"),
      );
    }
    status.show();
  } catch {
    status.hide();
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────
/**
 * `dbt parse` was 15 of the 17 seconds of a session creation. It no longer runs
 * by default: without a manifest, dbt Power User has no lineage nor completion,
 * but `dbt parse` (⌃⌥M) on demand brings them back when needed.
 * `worktreeStation.parseOnCreate` reruns it in the background.
 */
async function parseInBackground(folders: string[]): Promise<void> {
  if (!cfg("parseOnCreate", false)) {
    return;
  }
  for (const dir of folders) {
    const project = vscode.Uri.file(path.join(dir, "dbt_project.yml"));
    const isDbt = await vscode.workspace.fs.stat(project).then(
      () => true,
      () => false,
    );
    if (isDbt) {
      await task(`dbt parse · ${path.basename(dir)}`, ["dbt", "parse"], dir).catch(fail);
    }
  }
}

async function newSession(): Promise<void> {
  const conf = await api.config();
  const chosen = await repoAdmin.pickSessionRepos();
  if (!chosen) {
    return;
  }
  if (chosen.length === 0) {
    vscode.window.showWarningMessage("No repo declared — “Add repo” first.");
    return;
  }
  const branches: string[] = [];
  for (const [i, repo] of chosen.entries()) {
    const branch = await repoAdmin.pickBranch(repo, i + 1, chosen.length);
    if (branch === undefined) {
      return;
    }
    branches.push("--repo", `${repo.name}:${branch}`);
  }

  const out = await withProgress("Worktree Station: creating the session…", () =>
    quiet(["wt", "--no-open", "--no-parse", ...branches], conf.root, 300_000),
  ).catch((e) => {
    fail(e);
    return "";
  });
  if (!out) {
    return;
  }

  const created = out
    .split("\n")
    .filter((l) => l.startsWith("FOLDER="))
    .map((l) => l.slice(7).trim())
    .filter(Boolean);
  if (created.length === 0) {
    vscode.window.showWarningMessage("No worktree created — run `wts wt` in a terminal to see why.");
    return;
  }
  await refreshAll();
  void parseInBackground(created);
  const names = created.map((p) => path.basename(p)).join(", ");

  // Creating a session is not the same as wanting to work in it right away: by
  // default it is created and the window choice is left open.
  if (cfg<boolean>("attachOnCreate", false)) {
    await addFolders(created);
    await refreshAll();
    vscode.window.showInformationMessage(`Session ready: ${names}`);
    return;
  }

  const workspace = out
    .split("\n")
    .find((l) => l.startsWith("WORKSPACE="))
    ?.slice(10)
    .trim();

  // claudeMode decides what comes next: `terminal` keeps everything in this window,
  // `window` gives the session its own window with the Claude panel.
  const inWindow = cfg<string>("claudeMode", "terminal") === "window";
  const primary = inWindow ? (workspace ? "New window" : undefined) : "Claude terminal";
  const actions = primary ? [primary, "Load here"] : ["Load here"];
  const answer = await vscode.window.showInformationMessage(
    `Session ready: ${names}`,
    ...actions,
  );
  if (answer === "Load here") {
    await addFolders(created);
    await refreshAll();
  } else if (answer === "New window" && workspace) {
    if (claude.claudeExtensionAvailable()) {
      claude.markPanelWanted(workspace);
    }
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(workspace), {
      forceNewWindow: true,
    });
  } else if (answer === "Claude terminal") {
    const s = (await api.sessions(true)).find((x) =>
      x.worktrees.some((w) => created.includes(w.path)),
    );
    if (s) {
      claude.openForSession(s);
    } else {
      vscode.window.showWarningMessage("Session created but not found — refresh and use ✦.");
    }
  }
}

async function deleteSession(node: unknown): Promise<void> {
  if (!(node instanceof SessionNode)) {
    return;
  }
  const s = node.session;
  const paths = s.worktrees.map((w) => w.path);
  const busy = s.worktrees.filter((w) => w.busy);
  // Deleting folders under an open window leaves it pointing at nothing: first
  // list who holds them, then close afterwards.
  const elsewhere = windows.holding(paths);
  const closeSelf =
    !!vscode.workspace.workspaceFile && vscode.workspace.workspaceFile.fsPath === s.workspace;

  if (cfg("confirmDelete", true)) {
    const lines: string[] = [];
    lines.push(
      busy.length
        ? `Unfinished work detected:\n${busy.map((w) => `• ${w.repo} — ${w.reason}`).join("\n")}`
        : "None of the worktrees hold unpushed work.",
    );
    if (cfg("closeWindowOnDelete", true)) {
      const n = elsewhere.length + (closeSelf ? 1 : 0);
      if (n > 0) {
        lines.push(
          n === 1
            ? "1 window open on this session will be closed."
            : `${n} windows open on this session will be closed.`,
        );
      }
    }
    const answer = await vscode.window.showWarningMessage(
      `Delete session ${s.label} and its ${s.worktrees.length} worktrees?`,
      { modal: true, detail: lines.join("\n\n") },
      "Delete",
    );
    if (answer !== "Delete") {
      return;
    }
  }

  if (cfg("closeWindowOnDelete", true) && elsewhere.length > 0) {
    windows.requestClose(elsewhere.map((w) => w.pid));
  }
  // Current window: remove the folders only if it survives.
  if (!closeSelf) {
    await removeFolders(paths);
  }

  const conf = await api.config();
  for (const w of s.worktrees) {
    try {
      await quiet(["wt", "rm", w.path], conf.root);
    } catch (e) {
      fail(e);
    }
  }
  if (s.workspace) {
    await vscode.workspace.fs.delete(vscode.Uri.file(s.workspace)).then(
      () => undefined,
      () => undefined,
    );
  }
  await refreshAll();

  // Last: this window no longer has a valid workspace.
  if (closeSelf && cfg("closeWindowOnDelete", true)) {
    await vscode.commands.executeCommand("workbench.action.closeWindow");
  }
}

async function openPr(node: unknown): Promise<void> {
  const wt = worktreeOf(node);
  if (!wt) {
    return;
  }
  const existing = await new Promise<string>((resolve) => {
    execFile(
      "gh",
      ["pr", "view", "--json", "url", "-q", ".url"],
      { cwd: wt.path, timeout: 12_000 },
      (err, stdout) => resolve(err ? "" : stdout.trim()),
    );
  });
  const url = existing || wt.compareUrl;
  if (!url) {
    vscode.window.showWarningMessage(
      `No PR and nothing to compare for ${wt.repo}: the branch has no commit of its own.`,
    );
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

async function openConfigured(key: "lookerUrl" | "notionUrl", label: string): Promise<void> {
  const url = cfg(key, "");
  if (!url) {
    const answer = await vscode.window.showWarningMessage(
      `No ${label} URL configured.`,
      "Open settings",
    );
    if (answer) {
      await vscode.commands.executeCommand("workbench.action.openSettings", `worktreeStation.${key}`);
    }
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

async function dbtOn(sub: string, label: string, node?: unknown): Promise<void> {
  const target = await targetModel(node);
  if (!target) {
    return;
  }
  await task(`${label} · ${target.name}`, ["dbt", sub, target.name], target.dir);
}

async function buildChanged(hint?: string): Promise<void> {
  const dir = await targetDbtDir(hint);
  if (!dir) {
    return;
  }
  const list = await api.changed(dir, true);
  if (list.length === 0) {
    vscode.window.showInformationMessage("No changed model to build.");
    return;
  }
  // dbt --select accepts a space-separated union.
  await task(`dbt build · ${list.length} changed model(s)`, ["dbt", "build", list.map((m) => m.name).join(" ")], dir);
}

/**
 * One-off migration: copies the kanban, session names and run history saved under
 * the extension's former key prefix, whatever it was, then drops the old keys.
 *
 * Args:
 *   ctx: the extension context holding the globalState.
 */
function migrateLegacyState(ctx: vscode.ExtensionContext): void {
  const wanted = new Set(["board", "names", "runs"]);
  for (const legacy of ctx.globalState.keys()) {
    const [prefix, key] = legacy.split(".");
    if (prefix === "worktreeStation" || !wanted.has(key) || legacy.split(".").length !== 2) {
      continue;
    }
    if (ctx.globalState.get(`worktreeStation.${key}`) === undefined) {
      void ctx.globalState.update(`worktreeStation.${key}`, ctx.globalState.get(legacy));
    }
    void ctx.globalState.update(legacy, undefined);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  migrateLegacyState(context);
  sessions = new SessionsProvider();
  models = new ModelsProvider();
  repos = new ReposProvider();
  runsView = new RunsProvider();
  initRuns(context);
  claude.initClaude(context);
  dashboard.initDashboard(context);
  windows.initWindows(context);

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "worktreeStation.refresh";

  const reg = vscode.commands.registerCommand;
  context.subscriptions.push(
    status,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("worktreeStation.claudeMode")) {
        void dashboard.refreshDashboard();
      }
    }),
    vscode.window.registerTreeDataProvider("worktreeStationSessions", sessions),
    vscode.window.registerTreeDataProvider("worktreeStationModels", models),
    vscode.window.registerTreeDataProvider("worktreeStationRepos", repos),
    vscode.window.registerTreeDataProvider("worktreeStationRuns", runsView),

    reg("worktreeStation.refresh", () => refreshAll()),
    reg("worktreeStation.newSession", () => newSession().catch(fail)),
    reg("worktreeStation.session.load", async (n: unknown) => {
      if (n instanceof SessionNode) {
        await addFolders(n.session.worktrees.filter((w) => w.exists).map((w) => w.path));
        await refreshAll();
      }
    }),
    reg("worktreeStation.session.unload", async (n: unknown) => {
      if (n instanceof SessionNode) {
        await removeFolders(n.session.worktrees.map((w) => w.path));
        await refreshAll();
      }
    }),
    reg("worktreeStation.session.openWindow", async (n: unknown, withClaude?: boolean) => {
      if (!(n instanceof SessionNode)) {
        return;
      }
      let ws = n.session.workspace;
      const present = async (p: string) =>
        p
          ? vscode.workspace.fs.stat(vscode.Uri.file(p)).then(
              () => true,
              () => false,
            )
          : false;
      // Sessions created before the extension have no .code-workspace: regenerate it
      // rather than offering a button that does nothing.
      if (!(await present(ws))) {
        if (!n.session.id) {
          vscode.window.showWarningMessage(
            "Session without a timestamp: use “Load in this window”.",
          );
          return;
        }
        try {
          const conf = await api.config();
          const out = await quiet(["wt", "ws", n.session.id], conf.root);
          ws = out
            .split("\n")
            .find((l) => l.startsWith("WORKSPACE="))
            ?.slice(10)
            .trim() ?? "";
        } catch (e) {
          fail(e);
          return;
        }
      }
      if (!(await present(ws))) {
        vscode.window.showErrorMessage("Could not generate the workspace file.");
        return;
      }
      if (withClaude && claude.claudeExtensionAvailable()) {
        claude.markPanelWanted(ws);
      }
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(ws), {
        forceNewWindow: true,
      });
    }),
    reg("worktreeStation.session.delete", (n: unknown) => deleteSession(n).catch(fail)),
    reg("worktreeStation.session.claude", async (n: unknown) => {
      if (!(n instanceof SessionNode)) {
        return;
      }
      // Two mutually exclusive ways to get Claude on a session:
      //  - terminal: same window, cwd = the worktree, several sessions in parallel
      //  - window  : Claude panel, but its cwd is workspaceFolders[0], so the
      //              session must be alone in its window.
      if (cfg<string>("claudeMode", "terminal") === "window") {
        await vscode.commands.executeCommand("worktreeStation.session.openWindow", n, true);
        return;
      }
      claude.openForSession(n.session);
    }),
    reg("worktreeStation.session.claudePanel", async (n: unknown) => {
      if (n instanceof SessionNode) {
        await vscode.commands.executeCommand("worktreeStation.session.openWindow", n, true);
      }
    }),
    reg("worktreeStation.session.claudeClose", (n: unknown) => {
      if (n instanceof SessionNode) {
        claude.close(claude.sessionKey(n.session));
      }
    }),
    reg("worktreeStation.worktree.claude", (n: unknown) => {
      const wt = worktreeOf(n);
      if (wt) {
        claude.openForWorktree(wt);
      }
    }),
    reg("worktreeStation.claudeHere", async () => {
      // Palette / shortcut: Claude on the session of the open file.
      const dir = await targetDbtDir();
      const all = await api.sessions();
      const match = all.find((s) => s.worktrees.some((w) => w.path === dir));
      if (match) {
        claude.openForSession(match);
      } else if (dir) {
        const known = all.flatMap((s) => s.worktrees).find((w) => w.path === dir);
        if (known) {
          claude.openForWorktree(known);
        }
      }
    }),
    reg("worktreeStation.session.cleanAll", async () => {
      const conf = await api.config();
      await task("wts wt clean", ["wt", "clean"], conf.root);
    }),

    reg("worktreeStation.worktree.terminal", (n: unknown) => {
      const wt = worktreeOf(n);
      if (wt) {
        terminal(wt.name, wt.path);
      }
    }),
    reg("worktreeStation.worktree.reveal", async (n: unknown) => {
      const wt = worktreeOf(n);
      if (wt) {
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(wt.path));
      }
    }),
    reg("worktreeStation.worktree.pr", (n: unknown) => openPr(n).catch(fail)),
    reg("worktreeStation.worktree.dbtParse", async (n: unknown) => {
      const wt = worktreeOf(n);
      const dir = wt?.path ?? (await targetDbtDir());
      if (dir) {
        await task("dbt parse", ["dbt", "parse"], dir);
      }
    }),

    reg("worktreeStation.repo.add", async () => {
      if (await repoAdmin.addRepo().catch((e) => (fail(e), false))) {
        await refreshAll();
      }
    }),
    reg("worktreeStation.repo.remove", async (n: unknown) => {
      if (await repoAdmin.removeRepo(n).catch((e) => (fail(e), false))) {
        await refreshAll();
      }
    }),
    reg("worktreeStation.repo.editBase", async (n: unknown) => {
      if (await repoAdmin.editBase(n).catch((e) => (fail(e), false))) {
        await refreshAll();
      }
    }),
    reg("worktreeStation.repo.syncAll", async () => {
      const conf = await api.config();
      await task("wts sync", ["sync"], conf.root);
    }),

    reg("worktreeStation.model.build", (n: unknown) => dbtOn("build", "dbt build", n).catch(fail)),
    reg("worktreeStation.model.buildDown", (n: unknown) => dbtOn("down", "dbt build + downstream", n).catch(fail)),
    reg("worktreeStation.model.buildUp", (n: unknown) => dbtOn("up", "dbt build + upstream", n).catch(fail)),
    reg("worktreeStation.model.test", (n: unknown) => dbtOn("test", "dbt test", n).catch(fail)),
    reg("worktreeStation.model.show", (n: unknown) => dbtOn("show", "dbt show", n).catch(fail)),
    reg("worktreeStation.model.compile", (n: unknown) => dbtOn("compile", "dbt compile", n).catch(fail)),
    reg("worktreeStation.model.open", async (n: unknown) => {
      if (n instanceof ModelNode && n.model.exists) {
        await vscode.window.showTextDocument(vscode.Uri.file(n.model.path), { preview: true });
      }
    }),
    reg("worktreeStation.model.fmt", async (n: unknown) => {
      const file =
        n instanceof ModelNode ? n.model.path : vscode.window.activeTextEditor?.document.uri.fsPath;
      if (!file || !file.endsWith(".sql")) {
        vscode.window.showWarningMessage("sqlfluff: select a .sql file.");
        return;
      }
      // dbt templater: several minutes, say so before starting.
      const go = await vscode.window.showInformationMessage(
        `sqlfluff fix on ${path.basename(file)} — the dbt templater recompiles the project, expect 1 to 3 minutes.`,
        "Run",
      );
      if (go) {
        await task(`sqlfluff fix · ${path.basename(file)}`, ["fmt", file], path.dirname(file));
      }
    }),
    reg("worktreeStation.buildChanged", (hint?: unknown) =>
      buildChanged(typeof hint === "string" ? hint : undefined).catch(fail),
    ),

    reg("worktreeStation.links.looker", () => openConfigured("lookerUrl", "Looker")),
    reg("worktreeStation.links.notion", () => openConfigured("notionUrl", "Notion")),
    reg("worktreeStation.links.github", async (n: unknown) => {
      const wt = worktreeOf(n) ?? (await api.repos())[0];
      if (wt?.repoSlug) {
        await vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${wt.repoSlug}`));
      }
    }),
    reg("worktreeStation.doctor", async () => {
      const conf = await api.config();
      await task("wts doctor", ["doctor"], conf.root);
    }),
    reg("worktreeStation.runs.clear", () => clearRuns()),
    reg("worktreeStation.dashboard", () => dashboard.openDashboard().catch(fail)),
    reg("worktreeStation.dashboardBeside", () => dashboard.openDashboard(true).catch(fail)),

    vscode.workspace.onDidChangeWorkspaceFolders(() => refreshAll()),
    vscode.window.onDidChangeActiveTextEditor(() => models.refresh()),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.fsPath.endsWith(".sql") || doc.uri.fsPath.endsWith(".yml")) {
        api.invalidate();
        models.refresh();
      }
    }),
  );

  const every = cfg("autoRefreshSeconds", 60);
  if (every > 0) {
    const timer = setInterval(() => void refreshAll(), every * 1000);
    context.subscriptions.push(new vscode.Disposable(() => clearInterval(timer)));
  }

  void refreshAll();
  void autoOpenDashboard();
}

/**
 * The dashboard opens by itself, but only in a window about a known repo or
 * worktree: otherwise it would pop up in any project opened on this machine.
 */
async function autoOpenDashboard(): Promise<void> {
  if (dashboard.dashboardIsOpen()) {
    return;
  }
  // The setting used to be a boolean: an existing value must keep working.
  const raw = cfg<unknown>("dashboardOnStartup", "known");
  const mode = typeof raw === "boolean" ? (raw ? "known" : "never") : String(raw);
  if (mode === "never") {
    return;
  }
  if (mode === "always") {
    await dashboard.openDashboard();
    return;
  }

  const open = new Set((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
  if (open.size === 0) {
    return;
  }
  const known = new Set<string>();
  for (const s of await api.sessions()) {
    for (const w of s.worktrees) {
      known.add(w.path);
    }
  }
  for (const r of await api.repos()) {
    known.add(r.path);
  }
  if ([...open].some((p) => known.has(p))) {
    await dashboard.openDashboard();
  }
}

export function deactivate(): void {
  /* nothing to release: everything goes through context.subscriptions */
}
