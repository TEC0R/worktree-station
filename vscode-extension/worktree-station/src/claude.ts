// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Terry Cornelusse

import * as path from "node:path";
import * as vscode from "vscode";
import { Session, Worktree } from "./api";

/**
 * The Claude Code panel is locked to workspaceFolders[0]: in multi-root, all its
 * conversations share a single root. The terminal accepts any cwd, and the IDE
 * integration is per window (one .lock per window, listing its workspaceFolders):
 * a `claude` started in a worktree of this window attaches to it. It is therefore
 * the only way to get one Claude per session in a shared window.
 */

const terminals = new Map<string, vscode.Terminal>();
let state: vscode.Memento | undefined;

const PENDING_KEY = "worktreeStation.pendingClaudePanel";
const CLAUDE_EXT = "anthropic.claude-code";
/** Honors the claudeCode.preferredLocation setting (panel or sidebar). */
const OPEN_CMD = "claude-vscode.editor.openLast";

export function claudeExtensionAvailable(): boolean {
  return vscode.extensions.getExtension(CLAUDE_EXT) !== undefined;
}

/**
 * The Claude Code panel roots its conversations at workspaceFolders[0]: for it to
 * land on the right session, the session must be alone in its window. Another
 * window cannot be driven, but globalState is shared: we drop the expected
 * workspace there, and the instance that wakes up on it opens Claude.
 */
export function markPanelWanted(workspacePath: string): void {
  void state?.update(PENDING_KEY, workspacePath);
}

async function consumePanelRequest(): Promise<void> {
  const pending = state?.get<string>(PENDING_KEY);
  if (!pending) {
    return;
  }
  const here = vscode.workspace.workspaceFile?.fsPath;
  if (here !== pending) {
    return;
  }
  await state?.update(PENDING_KEY, undefined);
  const ext = vscode.extensions.getExtension(CLAUDE_EXT);
  if (!ext) {
    return;
  }
  if (!ext.isActive) {
    await ext.activate();
  }
  try {
    await vscode.commands.executeCommand(OPEN_CMD);
  } catch {
    vscode.window.showWarningMessage(
      "Claude Code could not be opened automatically — ⌘⇧Esc opens it.",
    );
  }
}
const emitter = new vscode.EventEmitter<void>();
export const onDidChangeClaude = emitter.event;

export function initClaude(context: vscode.ExtensionContext): void {
  state = context.globalState;
  void consumePanelRequest();
  context.subscriptions.push(
    emitter,
    vscode.window.onDidCloseTerminal((t) => {
      for (const [key, term] of terminals) {
        if (term === t) {
          terminals.delete(key);
          emitter.fire();
        }
      }
    }),
  );
  // A reloaded window keeps its terminals: reattach them to their key.
  for (const t of vscode.window.terminals) {
    const key = keyFromName(t.name);
    if (key) {
      terminals.set(key, t);
    }
  }
}

const PREFIX = "Claude · ";

function keyFromName(name: string): string | undefined {
  return name.startsWith(PREFIX) ? name.slice(PREFIX.length) : undefined;
}

export function hasClaude(key: string): boolean {
  return terminals.has(key);
}

export function sessionKey(s: Session): string {
  return s.id || s.label;
}

export function worktreeKey(w: Worktree): string {
  return w.name;
}

function cfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration("worktreeStation").get<T>(key) ?? fallback;
}

/** Single quotes for the shell: nothing is interpreted, except the quote itself. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function launch(key: string, cwd: string, addDirs: string[], title: string): void {
  const existing = terminals.get(key);
  if (existing) {
    existing.show();
    return;
  }

  const term = vscode.window.createTerminal({
    name: PREFIX + key,
    cwd,
    iconPath: new vscode.ThemeIcon("sparkle"),
    isTransient: true,
    env: { CLAUDE_CODE_TERMINAL_TITLE: title },
  });
  terminals.set(key, term);
  emitter.fire();

  const bin = cfg("claudePath", "claude");
  const extra = cfg<string[]>("claudeArgs", []);
  const args = [
    ...addDirs.flatMap((d) => ["--add-dir", shellQuote(d)]),
    ...extra.map(shellQuote),
  ];
  term.show();
  // sendText rather than a direct shellPath: we want the login shell, hence the
  // PATH, nvm and ~/.config/wts/secrets.env loaded by ~/.zshrc.
  term.sendText([bin, ...args].join(" "));
}

/** One Claude for the whole session: rooted at the dbt worktree, the others as --add-dir. */
export function openForSession(s: Session): void {
  const live = s.worktrees.filter((w) => w.exists);
  if (live.length === 0) {
    vscode.window.showWarningMessage("This session has no worktree on disk.");
    return;
  }
  const primary = live.find((w) => w.kind === "dbt") ?? live[0];
  const others = live.filter((w) => w.path !== primary.path).map((w) => w.path);
  launch(sessionKey(s), primary.path, others, `Claude ${s.label}`);
}

/** One Claude for a single worktree, with no access to the others. */
export function openForWorktree(w: Worktree): void {
  if (!w.exists) {
    vscode.window.showWarningMessage(`${w.name} does not exist on disk.`);
    return;
  }
  launch(worktreeKey(w), w.path, [], `Claude ${path.basename(w.path)}`);
}

export function close(key: string): void {
  const term = terminals.get(key);
  if (!term) {
    return;
  }
  term.dispose();
  terminals.delete(key);
  emitter.fire();
}
