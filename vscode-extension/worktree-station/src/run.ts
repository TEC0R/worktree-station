// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Terry Cornelusse

import { execFile } from "node:child_process";
import * as vscode from "vscode";
import { invalidate, wtsPath } from "./api";

export interface RunRecord {
  id: string;
  label: string;
  cwd: string;
  ok: boolean;
  durationMs: number;
  finishedAt: number;
}

const HISTORY_KEY = "worktreeStation.runs";
const HISTORY_MAX = 40;

let memento: vscode.Memento | undefined;
const started = new Map<string, number>();
const onDidChangeRunsEmitter = new vscode.EventEmitter<void>();
export const onDidChangeRuns = onDidChangeRunsEmitter.event;

export function initRuns(context: vscode.ExtensionContext): void {
  memento = context.globalState;
  context.subscriptions.push(
    onDidChangeRunsEmitter,
    vscode.tasks.onDidStartTaskProcess((e) => {
      if (e.execution.task.source === "Worktree Station") {
        started.set(e.execution.task.name, Date.now());
      }
    }),
    vscode.tasks.onDidEndTaskProcess((e) => {
      const task = e.execution.task;
      if (task.source !== "Worktree Station") {
        return;
      }
      const at = started.get(task.name) ?? Date.now();
      started.delete(task.name);
      record({
        id: `${task.name}-${at}`,
        label: task.name,
        cwd: (task.definition as { cwd?: string }).cwd ?? "",
        ok: e.exitCode === 0,
        durationMs: Date.now() - at,
        finishedAt: Date.now(),
      });
      // Git state may have moved (build, sync, parse): the cache must start over.
      invalidate();
      vscode.commands.executeCommand("worktreeStation.refresh");
    }),
  );
}

export function runs(): RunRecord[] {
  return memento?.get<RunRecord[]>(HISTORY_KEY, []) ?? [];
}

function record(entry: RunRecord): void {
  if (!memento) {
    return;
  }
  const next = [entry, ...runs()].slice(0, HISTORY_MAX);
  void memento.update(HISTORY_KEY, next);
  onDidChangeRunsEmitter.fire();
}

export function clearRuns(): void {
  void memento?.update(HISTORY_KEY, []);
  onDidChangeRunsEmitter.fire();
}

/**
 * Anything long or verbose runs as a real VS Code task: the output stays readable
 * in the Terminal panel and the user can interrupt it.
 */
export async function task(label: string, args: string[], cwd: string): Promise<void> {
  const exec = new vscode.ShellExecution(
    { value: wtsPath(), quoting: vscode.ShellQuoting.Strong },
    args.map((a) => ({ value: a, quoting: vscode.ShellQuoting.Strong })),
    { cwd },
  );
  const t = new vscode.Task(
    { type: "worktreeStation", cwd },
    vscode.TaskScope.Workspace,
    label,
    "Worktree Station",
    exec,
  );
  t.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
    focus: false,
    echo: false,
  };
  await vscode.tasks.executeTask(t);
}

/** Short commands where only success matters: no terminal, just a notification. */
export function quiet(args: string[], cwd: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(wtsPath(), args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || stdout.trim() || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function withProgress<T>(title: string, fn: () => Promise<T>): Promise<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: false },
    fn,
  );
}

export function terminal(name: string, cwd: string): void {
  const existing = vscode.window.terminals.find((t) => t.name === name);
  const term = existing ?? vscode.window.createTerminal({ name, cwd });
  term.show();
}
