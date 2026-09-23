// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Terry Cornelusse

import * as path from "node:path";
import * as vscode from "vscode";
import * as api from "./api";
import { DbtModel, Session, Worktree } from "./api";
import { hasClaude, onDidChangeClaude, sessionKey, worktreeKey } from "./claude";
import { onDidChangeRuns, RunRecord, runs } from "./run";

type Node = SessionNode | WorktreeNode | ModelNode | FolderNode | RepoNode | RunNode | InfoNode;

export class SessionNode {
  readonly kind = "session" as const;
  constructor(readonly session: Session, readonly loaded: boolean) {}
}
export class WorktreeNode {
  readonly kind = "worktree" as const;
  constructor(readonly wt: Worktree) {}
}
export class FolderNode {
  readonly kind = "folder" as const;
  constructor(readonly dir: string, readonly label: string) {}
}
export class ModelNode {
  readonly kind = "model" as const;
  constructor(readonly model: DbtModel, readonly dir: string) {}
}
export class RepoNode {
  readonly kind = "repo" as const;
  constructor(readonly repo: Worktree) {}
}
export class RunNode {
  readonly kind = "run" as const;
  constructor(readonly run: RunRecord) {}
}
export class InfoNode {
  readonly kind = "info" as const;
  constructor(readonly text: string, readonly icon = "info") {}
}

function loadedFolders(): Set<string> {
  return new Set((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
}

/** The dbt folders actually open: what the dbt commands operate on. */
export async function dbtFoldersInWorkspace(): Promise<{ dir: string; label: string }[]> {
  const open = vscode.workspace.workspaceFolders ?? [];
  if (open.length === 0) {
    return [];
  }
  const all = await api.sessions();
  const byPath = new Map<string, Worktree>();
  for (const s of all) {
    for (const w of s.worktrees) {
      byPath.set(w.path, w);
    }
  }
  for (const r of await api.repos()) {
    byPath.set(r.path, r);
  }
  const out: { dir: string; label: string }[] = [];
  for (const f of open) {
    const known = byPath.get(f.uri.fsPath);
    if (known ? known.kind === "dbt" : false) {
      out.push({ dir: f.uri.fsPath, label: f.name });
    }
  }
  return out;
}

function stateIcon(wt: Worktree): vscode.ThemeIcon {
  if (!wt.exists) {
    return new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
  }
  if (wt.dirty > 0) {
    return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"));
  }
  if (wt.ahead > 0) {
    return new vscode.ThemeIcon("arrow-up", new vscode.ThemeColor("gitDecoration.untrackedResourceForeground"));
  }
  if (wt.busy) {
    return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.blue"));
  }
  return new vscode.ThemeIcon("circle-outline", new vscode.ThemeColor("disabledForeground"));
}

function stateText(wt: Worktree): string {
  const bits: string[] = [];
  if (wt.branch) {
    bits.push(wt.branch);
  }
  if (wt.dirty > 0) {
    bits.push(`${wt.dirty}●`);
  }
  if (wt.ahead > 0) {
    bits.push(`↑${wt.ahead}`);
  }
  if (wt.behind > 0) {
    bits.push(`↓${wt.behind}`);
  }
  return bits.join("  ");
}

abstract class Base<T> implements vscode.TreeDataProvider<T> {
  protected readonly emitter = new vscode.EventEmitter<T | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  refresh(): void {
    this.emitter.fire(undefined);
  }
  abstract getTreeItem(e: T): vscode.TreeItem;
  abstract getChildren(e?: T): Promise<T[]>;
}

// ── Sessions ──────────────────────────────────────────────────────────────────
export class SessionsProvider extends Base<Node> {
  constructor() {
    super();
    onDidChangeClaude(() => this.refresh());
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "info") {
      const i = new vscode.TreeItem(node.text);
      i.iconPath = new vscode.ThemeIcon(node.icon);
      return i;
    }
    if (node.kind === "session") {
      const s = node.session;
      const item = new vscode.TreeItem(
        s.label,
        node.loaded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      );
      const claude = hasClaude(sessionKey(s));
      const repos = s.worktrees.map((w) => w.repo).join(" + ");
      const bits = [repos];
      if (node.loaded) {
        bits.push("open here");
      }
      if (claude) {
        bits.push("✦ Claude");
      }
      item.description = bits.join(" · ");
      item.iconPath = new vscode.ThemeIcon(
        node.loaded ? "vm-active" : s.busy ? "vm" : "vm-outline",
        node.loaded ? new vscode.ThemeColor("charts.green") : undefined,
      );
      item.contextValue =
        `session:${node.loaded ? "loaded" : "unloaded"}:${claude ? "claude" : "noclaude"}`;
      const lines = s.worktrees.map(
        (w) => `**${w.repo}** — \`${w.branch}\`  \n${w.reason}${w.behind ? ` · ${w.behind} commit(s) behind` : ""}`,
      );
      item.tooltip = new vscode.MarkdownString(
        [`### Session ${s.label}`, ...lines].join("\n\n"),
      );
      return item;
    }
    const w = (node as WorktreeNode).wt;
    const item = new vscode.TreeItem(w.repo, vscode.TreeItemCollapsibleState.None);
    const wtClaude = hasClaude(worktreeKey(w));
    item.description = stateText(w) + (wtClaude ? "  ✦" : "");
    item.iconPath = stateIcon(w);
    item.contextValue = `worktree:${w.kind}:${wtClaude ? "claude" : "noclaude"}`;
    item.resourceUri = vscode.Uri.file(w.path);
    item.tooltip = new vscode.MarkdownString(
      [
        `**${w.name}**`,
        "",
        `branch \`${w.branch}\` (base \`${w.base}\`)`,
        `${w.dirty} changed file(s) · ${w.ahead} ahead · ${w.behind} behind`,
        `_${w.reason}_`,
      ].join("  \n"),
    );
    return item;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      if (!api.installed()) {
        return [new InfoNode("wts CLI not found in ~/.dotfiles", "warning")];
      }
      try {
        const open = loadedFolders();
        const list = await api.sessions();
        return list.map(
          (s) => new SessionNode(s, s.worktrees.length > 0 && s.worktrees.every((w) => open.has(w.path))),
        );
      } catch (e) {
        return [new InfoNode(String(e instanceof Error ? e.message : e), "error")];
      }
    }
    if (node.kind === "session") {
      return node.session.worktrees.map((w) => new WorktreeNode(w));
    }
    return [];
  }
}

// ── Changed models ────────────────────────────────────────────────────────────
export class ModelsProvider extends Base<Node> {
  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "info") {
      const i = new vscode.TreeItem(node.text);
      i.iconPath = new vscode.ThemeIcon(node.icon);
      return i;
    }
    if (node.kind === "folder") {
      const i = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      i.iconPath = new vscode.ThemeIcon("root-folder");
      i.contextValue = "modelFolder";
      return i;
    }
    const m = (node as ModelNode).model;
    const item = new vscode.TreeItem(m.name, vscode.TreeItemCollapsibleState.None);
    item.description = m.layer;
    item.iconPath = new vscode.ThemeIcon("file-code");
    item.contextValue = "model";
    item.resourceUri = vscode.Uri.file(m.path);
    item.tooltip = m.file;
    item.command = {
      command: "worktreeStation.model.open",
      title: "Open",
      arguments: [node],
    };
    return item;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node?.kind === "folder") {
      return this.modelsOf(node.dir);
    }
    if (node) {
      return [];
    }
    const folders = await dbtFoldersInWorkspace();
    if (folders.length === 0) {
      return [new InfoNode("No dbt folder open in this window", "info")];
    }
    if (folders.length === 1) {
      return this.modelsOf(folders[0].dir);
    }
    return folders.map((f) => new FolderNode(f.dir, f.label));
  }

  private async modelsOf(dir: string): Promise<Node[]> {
    try {
      const models = await api.changed(dir);
      if (models.length === 0) {
        return [new InfoNode("No changed models", "check")];
      }
      return models.map((m) => new ModelNode(m, dir));
    } catch (e) {
      return [new InfoNode(String(e instanceof Error ? e.message : e), "error")];
    }
  }
}

// ── Repos ─────────────────────────────────────────────────────────────────────
export class ReposProvider extends Base<Node> {
  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "info") {
      const i = new vscode.TreeItem(node.text);
      i.iconPath = new vscode.ThemeIcon(node.icon);
      return i;
    }
    const r = (node as RepoNode).repo;
    const item = new vscode.TreeItem(r.repo, vscode.TreeItemCollapsibleState.None);
    item.description = stateText(r);
    item.iconPath = new vscode.ThemeIcon(r.kind === "dbt" ? "database" : "graph");
    item.contextValue = "repo";
    item.resourceUri = vscode.Uri.file(r.path);
    item.tooltip = new vscode.MarkdownString(
      [`**${r.path}**`, `branch \`${r.branch}\``, `${r.dirty} changed file(s)`].join("  \n"),
    );
    return item;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node) {
      return [];
    }
    if (!api.installed()) {
      return [new InfoNode("wts CLI not found in ~/.dotfiles", "warning")];
    }
    try {
      return (await api.repos()).map((r) => new RepoNode(r));
    } catch (e) {
      return [new InfoNode(String(e instanceof Error ? e.message : e), "error")];
    }
  }
}

// ── Recent runs ───────────────────────────────────────────────────────────────
export class RunsProvider extends Base<Node> {
  constructor() {
    super();
    onDidChangeRuns(() => this.refresh());
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "info") {
      const i = new vscode.TreeItem(node.text);
      i.iconPath = new vscode.ThemeIcon(node.icon);
      return i;
    }
    const r = (node as RunNode).run;
    const item = new vscode.TreeItem(r.label, vscode.TreeItemCollapsibleState.None);
    const secs = r.durationMs / 1000;
    const dur = secs < 60 ? `${secs.toFixed(0)} s` : `${Math.floor(secs / 60)} min ${Math.round(secs % 60)} s`;
    const time = new Date(r.finishedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    item.description = `${dur} · ${time}`;
    item.iconPath = new vscode.ThemeIcon(
      r.ok ? "pass" : "error",
      new vscode.ThemeColor(r.ok ? "testing.iconPassed" : "testing.iconFailed"),
    );
    item.contextValue = "run";
    item.tooltip = r.cwd ? `${r.label}\n${path.basename(r.cwd)}` : r.label;
    return item;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node) {
      return [];
    }
    const list = runs();
    if (list.length === 0) {
      return [new InfoNode("Nothing run from the panel yet", "history")];
    }
    return list.map((r) => new RunNode(r));
  }
}
