// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Terry Cornelusse

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Claude Code writes one <config>/sessions/<pid>.json per running process, with its pid and cwd,
 * whatever started it (panel, terminal, another window). The file can outlive a crashed process,
 * so a pid is trusted only while the process is alive. No vscode import: tested under plain node.
 */
export interface ClaudeProcess {
  pid: number;
  cwd: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to another user.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function liveClaudes(
  configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
  isAlive: (pid: number) => boolean = pidAlive,
): ClaudeProcess[] {
  const dir = path.join(configDir, "sessions");
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    // No folder: no Claude ever ran with this config.
    return [];
  }
  const found: ClaudeProcess[] = [];
  for (const name of names) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (typeof data.pid === "number" && typeof data.cwd === "string" && isAlive(data.pid)) {
        found.push({ pid: data.pid, cwd: data.cwd });
      }
    } catch {
      // A file being written or a foreign one: skipped, not fatal.
    }
  }
  return found;
}

/** True when a live Claude has its cwd in one of these folders or below. */
export function claudeRunningIn(
  folders: string[],
  claudes: ClaudeProcess[] = liveClaudes(),
): boolean {
  const roots = folders.map((f) => path.resolve(f));
  return claudes.some(({ cwd }) => {
    const c = path.resolve(cwd);
    return roots.some((r) => c === r || c.startsWith(r + path.sep));
  });
}
