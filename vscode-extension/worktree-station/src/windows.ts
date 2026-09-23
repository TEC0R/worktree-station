// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Terry Cornelusse

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

/**
 * Cross-window registry. VS Code cannot drive another window, so each instance
 * publishes its state in a file and watches a request file of its own. Used to
 * close the windows open on worktrees that were just deleted.
 */

const DIR = path.join(os.homedir(), ".config", "wts", "windows");
const STALE_MS = 90_000;
const BEAT_MS = 30_000;

export interface WindowInfo {
  pid: number;
  workspaceFile: string;
  folders: string[];
  updatedAt: number;
}

function selfFile(): string {
  return path.join(DIR, `${process.pid}.json`);
}

function requestFile(pid: number): string {
  return path.join(DIR, `close-${pid}.request`);
}

function publish(): void {
  const info: WindowInfo = {
    pid: process.pid,
    workspaceFile: vscode.workspace.workspaceFile?.fsPath ?? "",
    folders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    updatedAt: Date.now(),
  };
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(selfFile(), JSON.stringify(info), "utf8");
  } catch {
    /* the registry is a convenience: its failure must not break anything */
  }
}

/** Live windows other than this one. Stale entries are cleaned up. */
export function others(): WindowInfo[] {
  const out: WindowInfo[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(DIR);
  } catch {
    return out;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const full = path.join(DIR, name);
    try {
      const info = JSON.parse(fs.readFileSync(full, "utf8")) as WindowInfo;
      if (info.pid === process.pid) {
        continue;
      }
      if (now - info.updatedAt > STALE_MS) {
        fs.rmSync(full, { force: true });
        fs.rmSync(requestFile(info.pid), { force: true });
        continue;
      }
      out.push(info);
    } catch {
      fs.rmSync(full, { force: true });
    }
  }
  return out;
}

/** Windows (other than this one) that have at least one of these folders open. */
export function holding(paths: string[]): WindowInfo[] {
  const wanted = new Set(paths);
  return others().filter((w) => w.folders.some((f) => wanted.has(f)));
}

export function requestClose(pids: number[]): void {
  for (const pid of pids) {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(requestFile(pid), String(Date.now()), "utf8");
    } catch {
      /* same: convenience only */
    }
  }
}

/**
 * A worktree can disappear without going through the panel (`wts wt clean`, a
 * manual `git worktree remove`). The window would stay open on ghost folders:
 * it notices by itself and offers to close.
 */
let orphanNotified = false;

function checkOrphaned(): void {
  if (orphanNotified || !vscode.workspace.workspaceFile) {
    return;
  }
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  if (folders.length === 0) {
    return;
  }
  const alive = folders.filter((f) => fs.existsSync(f));
  if (alive.length > 0) {
    return;
  }
  orphanNotified = true;
  void vscode.window
    .showWarningMessage(
      "This session's folders were deleted. Close the window?",
      "Close",
      "Keep",
    )
    .then((answer) => {
      if (answer === "Close") {
        void vscode.commands.executeCommand("workbench.action.closeWindow");
      }
    });
}

export function initWindows(context: vscode.ExtensionContext): void {
  publish();
  checkOrphaned();

  const mine = requestFile(process.pid);
  // A request filed before we started must not close us at launch.
  try {
    fs.rmSync(mine, { force: true });
  } catch {
    /* nothing */
  }

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(DIR), `close-${process.pid}.request`),
  );
  const honour = async () => {
    try {
      fs.rmSync(mine, { force: true });
    } catch {
      /* nothing */
    }
    // closeWindow respects unsaved editors: VS Code asks first.
    await vscode.commands.executeCommand("workbench.action.closeWindow");
  };
  watcher.onDidCreate(honour);
  watcher.onDidChange(honour);

  const beat = setInterval(() => {
    publish();
    checkOrphaned();
  }, BEAT_MS);
  context.subscriptions.push(
    watcher,
    vscode.workspace.onDidChangeWorkspaceFolders(() => publish()),
    new vscode.Disposable(() => {
      clearInterval(beat);
      try {
        fs.rmSync(selfFile(), { force: true });
        fs.rmSync(mine, { force: true });
      } catch {
        /* nothing */
      }
    }),
  );
}
