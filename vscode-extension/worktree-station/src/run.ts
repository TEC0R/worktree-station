// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Terry Cornelusse

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

/** A Python environment a terminal can activate. */
interface PyEnv {
  label: string;
  dir: string;
}

/** Folder names treated as a local virtualenv, besides the `*_venv` / `*-venv` suffixes. */
const LOCAL_VENV_NAMES = new Set([".venv", "venv", "env"]);

function hasActivate(dir: string): boolean {
  return fs.existsSync(path.join(dir, "bin", "activate"));
}

/**
 * Virtualenvs living at the top level of a folder: `.venv`, `venv`, `env`,
 * `*_venv`, `*-venv` — any of them holding a `bin/activate`.
 *
 * @param dir Folder to scan, not recursed into.
 * @returns Absolute paths of the virtualenvs found.
 */
function localVenvs(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && (LOCAL_VENV_NAMES.has(e.name) || /[_-]venv$/.test(e.name)))
    .map((e) => path.join(dir, e.name))
    .filter(hasActivate);
}

/**
 * Pipenv virtualenvs bound to one of the given folders. Pipenv names them
 * `<folder>-<hash>` and records the project path in a `.project` file, read
 * here rather than running `pipenv --venv` (seconds per call).
 *
 * @param projects Project folders to match against `.project`.
 * @returns Absolute paths of the matching virtualenvs.
 */
function pipenvVenvs(projects: string[]): string[] {
  const home = process.env.WORKON_HOME || path.join(os.homedir(), ".local", "share", "virtualenvs");
  let names: string[];
  try {
    names = fs.readdirSync(home);
  } catch {
    return [];
  }
  const wanted = new Set(projects);
  return names
    .map((n) => path.join(home, n))
    .filter((dir) => {
      try {
        return wanted.has(fs.readFileSync(path.join(dir, ".project"), "utf8").trim()) && hasActivate(dir);
      } catch {
        return false;
      }
    });
}

/**
 * Every environment a terminal opened in `cwd` could activate, deduplicated:
 * the worktree's own venvs, its pipenv one, then the main checkout's (an
 * untracked venv is not copied into a worktree) and finally `WTS_VENV`.
 *
 * @param cwd The worktree folder.
 * @param mainDir The repo's main checkout, when the worktree is not it.
 * @param configured `WTS_VENV`, empty when unset.
 */
function pythonEnvs(cwd: string, mainDir: string | undefined, configured: string): PyEnv[] {
  const envs: PyEnv[] = [];
  const seen = new Set<string>();
  const add = (dir: string, origin: string) => {
    let real = dir;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real)) {
      return;
    }
    seen.add(real);
    envs.push({ label: `${path.basename(dir)} · ${origin}`, dir });
  };
  for (const dir of localVenvs(cwd)) {
    add(dir, "worktree");
  }
  for (const dir of pipenvVenvs([cwd])) {
    add(dir, "pipenv");
  }
  if (mainDir && mainDir !== cwd) {
    for (const dir of localVenvs(mainDir)) {
      add(dir, "main checkout");
    }
    for (const dir of pipenvVenvs([mainDir])) {
      add(dir, "pipenv, main checkout");
    }
  }
  if (configured && hasActivate(configured)) {
    add(configured, "WTS_VENV");
  }
  return envs;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Open (or reveal) a terminal in a worktree. When Python environments exist
 * for it, ask which one to activate first; each choice gets its own terminal,
 * so switching environment never reuses a shell holding the other one.
 *
 * @param name Base terminal name, the worktree's.
 * @param cwd The worktree folder.
 * @param mainDir The repo's main checkout, scanned for venvs too.
 * @param configured `WTS_VENV`, empty when unset.
 */
export async function terminal(name: string, cwd: string, mainDir?: string, configured = ""): Promise<void> {
  const envs = pythonEnvs(cwd, mainDir, configured);
  let env: PyEnv | undefined;
  if (envs.length > 0) {
    const none = { label: "$(terminal) No environment", description: "plain shell", env: undefined };
    const picked = await vscode.window.showQuickPick(
      [
        ...envs.map((e) => ({ label: `$(symbol-namespace) ${e.label}`, description: e.dir, env: e })),
        none,
      ],
      { title: `Terminal · ${name}`, placeHolder: "Which environment to activate?" },
    );
    if (!picked) {
      return;
    }
    env = picked.env;
  }
  const termName = env ? `${name} · ${path.basename(env.dir)}` : name;
  const existing = vscode.window.terminals.find((t) => t.name === termName);
  if (existing) {
    existing.show();
    return;
  }
  const term = vscode.window.createTerminal({ name: termName, cwd });
  if (env) {
    term.sendText(`source ${shellQuote(path.join(env.dir, "bin", "activate"))}`);
  }
  term.show();
}
