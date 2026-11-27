// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Terry Cornelusse

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * A brief is the first message of a Claude started by `wts claude --brief <file>`. wts copies the
 * file to <config>/briefs/pending/<session>-<token>.md and puts only the token in the vscode://
 * link. Any web page can open such a link, but none can write into that folder: a link cannot make
 * Claude read a file of its choosing. No vscode import: tested under plain node.
 */
export function briefsDir(
  configDir = process.env.WTS_CONFIG_DIR || path.join(os.homedir(), ".config", "wts"),
): string {
  return path.join(configDir, "briefs");
}

const TOKEN = /^[0-9a-f]{32}$/;
const SESSION = /^[0-9]{8}-[0-9]{6}$/;

/**
 * Moves the pending brief to used/ and returns its new path. The move makes a token work once,
 * and the brief stays there as a record of what the session was asked.
 *
 * Throws when the session or token is malformed, or when no such brief is pending.
 */
export function claimBrief(session: string, token: string, dir = briefsDir()): string {
  if (!SESSION.test(session) || !TOKEN.test(token)) {
    throw new Error(`invalid brief token for session ${session}`);
  }
  const name = `${session}-${token}.md`;
  const used = path.join(dir, "used");
  fs.mkdirSync(used, { recursive: true, mode: 0o700 });
  const to = path.join(used, name);
  try {
    fs.renameSync(path.join(dir, "pending", name), to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`no pending brief ${name}: already used, or not written by wts`);
    }
    throw e;
  }
  return to;
}

/** Arguments that already choose which conversation Claude opens. */
const PICKS_CONVERSATION = new Set(["-c", "--continue", "-r", "--resume", "--session-id"]);

/** Single quotes for the shell: nothing is interpreted, except the quote itself. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ClaudeCommand {
  bin: string;
  /** worktreeStation.claudeArgs, passed as is. */
  extra: string[];
  addDirs: string[];
  /** The session already has a conversation (see hasConversation in claude.ts). */
  hasConversation: boolean;
  /** Path of a claimed brief, sent as the first message. */
  brief?: string;
}

/**
 * The line typed in the session terminal. `--continue` reopens the session's last conversation
 * unless claudeArgs already picks one. The brief goes last, after `--`: `--add-dir` takes every
 * word that follows it, so without the `--` the brief would be read as one more folder. It is read
 * by the shell (`$(cat …)`) so that a multi-line brief is never typed into the terminal.
 */
export function claudeCommand(c: ClaudeCommand): string {
  const resume = c.hasConversation && !c.extra.some((a) => PICKS_CONVERSATION.has(a));
  return [
    c.bin,
    ...(resume ? ["--continue"] : []),
    ...c.addDirs.flatMap((d) => ["--add-dir", shellQuote(d)]),
    ...c.extra.map(shellQuote),
    ...(c.brief ? ["--", `"$(cat ${shellQuote(c.brief)})"`] : []),
  ].join(" ");
}
