// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Terry Cornelusse

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { Session, Worktree } from "./api";
import { claudeCommand } from "./brief";
import { claudeRunningIn } from "./running";

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
  // A restored window may bring its Claude tab back before its process has written its session
  // file: both the tabs and the live processes are checked, or openLast would open a second one.
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  if (hasClaudeTab() || claudeRunningIn(folders)) {
    return;
  }
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
const PENDING_TERMINAL_KEY = "worktreeStation.pendingClaudeTerminal";
/** Past this age, the window the request was meant for never woke up on it: dropped, not run. */
const PENDING_MAX_MS = 10 * 60_000;

interface TerminalRequest {
  workspace: string;
  session: string;
  brief: string;
  at: number;
}

let findSession: ((id: string) => Promise<Session | undefined>) | undefined;

/**
 * Window mode with a brief. The Claude Code panel only pre-fills its input with a starting prompt
 * and never sends it, so the session's window starts a terminal Claude instead, through the same
 * shared-globalState relay as markPanelWanted.
 */
export function markTerminalWanted(workspace: string, session: string, brief: string): void {
  // One entry per window: two sessions started back to back must not overwrite each other.
  const all = { ...state?.get<Record<string, TerminalRequest>>(PENDING_TERMINAL_KEY) };
  all[workspace] = { workspace, session, brief, at: Date.now() };
  void state?.update(PENDING_TERMINAL_KEY, all);
}

async function consumeTerminalRequest(): Promise<void> {
  const here = vscode.workspace.workspaceFile?.fsPath;
  const all = { ...state?.get<Record<string, TerminalRequest>>(PENDING_TERMINAL_KEY) };
  const req = here ? all[here] : undefined;
  if (!here || !req) {
    return;
  }
  delete all[here];
  await state?.update(PENDING_TERMINAL_KEY, all);
  if (Date.now() - req.at > PENDING_MAX_MS) {
    vscode.window.showWarningMessage(
      `Brief not sent: its request is older than 10 minutes (kept in ${req.brief}).`,
    );
    return;
  }
  const s = await findSession?.(req.session);
  if (!s) {
    vscode.window.showErrorMessage(`Brief not sent: no session ${req.session} (kept in ${req.brief}).`);
    return;
  }
  openForSession(s, false, req.brief);
}

/** Claude Code's editor panel; VS Code prefixes webview view types, hence the includes. */
const PANEL_VIEW_TYPE = "claudeVSCodePanel";

function hasClaudeTab(): boolean {
  return vscode.window.tabGroups.all.some((g) =>
    g.tabs.some(
      (t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes(PANEL_VIEW_TYPE),
    ),
  );
}

/**
 * One Claude per session: true, with a notice, when a Claude already runs in these folders, in
 * this window or any other. The caller then shows what exists instead of starting a second one.
 */
export function alreadyRunning(folders: string[], label: string): boolean {
  if (!claudeRunningIn(folders)) {
    return false;
  }
  vscode.window.showInformationMessage(`Claude is already running in ${label}.`);
  return true;
}

const emitter = new vscode.EventEmitter<void>();
export const onDidChangeClaude = emitter.event;

export function initClaude(
  context: vscode.ExtensionContext,
  sessionById: (id: string) => Promise<Session | undefined>,
): void {
  state = context.globalState;
  findSession = sessionById;
  void consumePanelRequest();
  void consumeTerminalRequest();
  context.subscriptions.push(
    emitter,
    // A session window already open is only focused, not reloaded: activation alone would miss
    // the request, and the brief would never be sent.
    vscode.window.onDidChangeWindowState((w) => {
      if (w.focused) {
        void consumeTerminalRequest();
      }
    }),
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

/**
 * Claude Code keeps a folder's conversations in <config>/projects/<cwd, every character other than
 * a letter or a digit replaced by "-">. A conversation there means the session was worked on
 * before: `--continue` reopens it, so Claude keeps what it learned instead of starting cold.
 */
export function hasConversation(
  cwd: string,
  configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
): boolean {
  const dir = path.join(configDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith(".jsonl"));
  } catch {
    // No folder: Claude never ran here.
    return false;
  }
}

/** Shows the Claude terminal already open on this key, hidden or not; false when there is none. */
export function reveal(key: string): boolean {
  const term = terminals.get(key);
  term?.show();
  return term !== undefined;
}

/**
 * `hidden`: the terminal is created without being shown (no window, no tab), for a Claude another
 * session talks to; `reveal` shows it when the user wants to look or answer a permission prompt.
 */
function launch(
  key: string,
  cwd: string,
  addDirs: string[],
  title: string,
  hidden = false,
  brief?: string,
): void {
  const existing = terminals.get(key);
  if (existing) {
    if (brief) {
      briefRefused(key, brief);
    } else if (!hidden) {
      existing.show();
    }
    return;
  }

  const term = vscode.window.createTerminal({
    name: PREFIX + key,
    cwd,
    iconPath: new vscode.ThemeIcon("sparkle"),
    isTransient: true,
    hideFromUser: hidden,
    env: { CLAUDE_CODE_TERMINAL_TITLE: title },
  });
  terminals.set(key, term);
  emitter.fire();

  if (!hidden) {
    term.show();
  }
  // sendText rather than a direct shellPath: we want the login shell, hence the
  // PATH, nvm and ~/.config/wts/secrets.env loaded by ~/.zshrc.
  term.sendText(
    claudeCommand({
      bin: cfg("claudePath", "claude"),
      extra: cfg<string[]>("claudeArgs", []),
      addDirs,
      hasConversation: hasConversation(cwd),
      brief,
    }),
  );
}

/**
 * A brief is never typed into a Claude that already runs: its conversation is someone else's
 * context. The refusal is loud, so that the sender does not wait on a session that never got it.
 */
export function briefRefused(label: string, brief: string): void {
  vscode.window.showErrorMessage(
    `Claude is already running in ${label}: the brief was not sent (kept in ${brief}).`,
  );
}

/**
 * One Claude for the whole session: rooted at the dbt worktree, the others as --add-dir.
 * `brief`: path of a claimed brief, sent as the first message.
 */
export function openForSession(s: Session, hidden = false, brief?: string): void {
  const live = s.worktrees.filter((w) => w.exists);
  if (live.length === 0) {
    vscode.window.showWarningMessage("This session has no worktree on disk.");
    return;
  }
  const folders = live.map((w) => w.path);
  if (brief && claudeRunningIn(folders)) {
    briefRefused(s.label, brief);
    return;
  }
  if (alreadyRunning(folders, s.label)) {
    return;
  }
  const primary = live.find((w) => w.kind === "dbt") ?? live[0];
  const others = live.filter((w) => w.path !== primary.path).map((w) => w.path);
  launch(sessionKey(s), primary.path, others, `Claude ${s.label}`, hidden, brief);
}

/** One Claude for a single worktree, with no access to the others. */
export function openForWorktree(w: Worktree): void {
  if (!w.exists) {
    vscode.window.showWarningMessage(`${w.name} does not exist on disk.`);
    return;
  }
  if (alreadyRunning([w.path], w.name)) {
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
