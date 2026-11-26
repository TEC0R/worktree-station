// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Terry Cornelusse

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

/**
 * Board state (columns, card per session, session names) kept in a plain file,
 * shared with `wts card|name|columns` (bin/wts-state.py). A file, not globalState,
 * so that a script or an agent outside VS Code can read and change it.
 */
export interface ColumnDef {
  id: string;
  label: string;
}

export interface BoardState {
  columns: ColumnDef[];
  board: Record<string, string>;
  names: Record<string, string>;
}

const DIR = process.env.WTS_CONFIG_DIR || path.join(os.homedir(), ".config", "wts");
export const STATE_FILE = process.env.WTS_STATE_FILE || path.join(DIR, "state.json");
/** Written by the Claude Code hook claude/hooks/activity.py: what each session's Claude does now. */
export const ACTIVITY_FILE = process.env.WTS_ACTIVITY_FILE || path.join(DIR, "activity.json");

export type Activity = "working" | "waiting" | "idle";

/** Session timestamp → state. Missing or torn file: no activity shown, never an error (display only). */
export function readActivity(): Record<string, Activity> {
  try {
    const data = JSON.parse(fs.readFileSync(ACTIVITY_FILE, "utf8")) as Record<string, { state?: Activity }>;
    return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.state ?? "idle"]));
  } catch {
    return {};
  }
}

export const DEFAULT_COLUMNS: ColumnDef[] = [
  { id: "prep", label: "Preparation" },
  { id: "wip", label: "In progress" },
  { id: "uat", label: "UAT" },
];

// globalState keys used before the state file; read once by migrate().
const LEGACY_BOARD = "worktreeStation.board";
const LEGACY_NAMES = "worktreeStation.names";

/** Throws on an unreadable file: silently falling back would erase the board on the next write. */
export function read(): BoardState {
  let raw: string;
  try {
    raw = fs.readFileSync(STATE_FILE, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { columns: DEFAULT_COLUMNS, board: {}, names: {} };
    }
    throw e;
  }
  const data = JSON.parse(raw) as Partial<BoardState>;
  return {
    columns: data.columns?.length ? data.columns : DEFAULT_COLUMNS,
    board: data.board ?? {},
    names: data.names ?? {},
  };
}

/** Atomic replace, same as wts-state.py: a reader never sees half a file. */
export function write(state: BoardState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, STATE_FILE);
}

export function update(change: (s: BoardState) => void): void {
  const s = read();
  change(s);
  write(s);
}

/**
 * First run with the state file: copy the board and names kept in globalState.
 * globalState is left as is, so going back to an older extension loses nothing.
 */
export function migrate(ctx: vscode.ExtensionContext): void {
  if (fs.existsSync(STATE_FILE)) {
    return;
  }
  const board = ctx.globalState.get<Record<string, string>>(LEGACY_BOARD);
  const names = ctx.globalState.get<Record<string, string>>(LEGACY_NAMES);
  if (!board && !names) {
    return;
  }
  write({ columns: DEFAULT_COLUMNS, board: board ?? {}, names: names ?? {} });
}

/** Calls back when the board or the activity file changes, whoever wrote it (wts, an agent, a hook). */
export function watch(onChange: () => void): vscode.Disposable {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  let timer: NodeJS.Timeout | undefined;
  const watcher = fs.watch(path.dirname(STATE_FILE), (_event, file) => {
    if (file !== path.basename(STATE_FILE) && file !== path.basename(ACTIVITY_FILE)) {
      return;
    }
    // An atomic replace fires several events: refresh once.
    clearTimeout(timer);
    timer = setTimeout(onChange, 150);
  });
  return new vscode.Disposable(() => {
    clearTimeout(timer);
    watcher.close();
  });
}
