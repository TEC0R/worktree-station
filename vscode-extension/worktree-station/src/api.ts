// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Terry Cornelusse

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

export interface Worktree {
  path: string;
  name: string;
  exists: boolean;
  branch: string;
  base: string;
  dirty: number;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  remoteUrl: string;
  repoSlug: string;
  busy: boolean;
  reason: string;
  repo: string;
  kind: string;
  mainDir?: string;
  isMain?: boolean;
  compareUrl: string;
}

export interface Session {
  id: string;
  label: string;
  worktrees: Worktree[];
  busy: boolean;
  workspace: string;
}

export interface DbtModel {
  name: string;
  file: string;
  path: string;
  exists: boolean;
  layer: string;
}

export interface WtsConfig {
  root: string;
  worktrees: string;
  python: string;
  dbt: string;
  sqlfluff: string;
  venv: string;
  /** path = declared path (empty when $WTS_ROOT/<name>), dir = resolved path. */
  repos: { name: string; base: string; kind: string; path: string; dir: string }[];
}

const DOTFILES = process.env.DOTFILES || path.join(os.homedir(), ".dotfiles");

export function wtsPath(): string {
  const configured = vscode.workspace.getConfiguration("worktreeStation").get<string>("wtsPath");
  return configured && configured.trim() ? configured.trim() : path.join(DOTFILES, "bin", "wts");
}

function apiPath(): string {
  return path.join(DOTFILES, "bin", "wts-api.py");
}

/** The CLI is the engine: if its folder is gone, nothing else can work. */
export function installed(): boolean {
  return fs.existsSync(wtsPath()) && fs.existsSync(apiPath());
}

function run(args: string[], timeoutMs = 25_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "python3",
      [apiPath(), ...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, DOTFILES } },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr.trim() || err.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function json<T>(args: string[]): Promise<T> {
  const raw = await run(args);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`unreadable response from wts-api.py ${args.join(" ")}`);
  }
  const maybeError = parsed as { error?: string };
  if (maybeError && typeof maybeError.error === "string") {
    throw new Error(maybeError.error);
  }
  return parsed as T;
}

/**
 * Short cache: the views refresh often (focus, timer, end of a task) and each
 * call costs ~300 ms of git. The TTL makes them converge without spamming.
 */
class Cache<T> {
  private value?: T;
  private at = 0;
  private inflight?: Promise<T>;

  constructor(private readonly ttlMs: number, private readonly loader: () => Promise<T>) {}

  async get(force = false): Promise<T> {
    if (!force && this.value !== undefined && Date.now() - this.at < this.ttlMs) {
      return this.value;
    }
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = this.loader()
      .then((v) => {
        this.value = v;
        this.at = Date.now();
        return v;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  invalidate(): void {
    this.at = 0;
  }
}

const sessionsCache = new Cache(4000, () => json<{ sessions: Session[] }>(["sessions"]));
const reposCache = new Cache(4000, () => json<{ repos: Worktree[] }>(["repos"]));
const configCache = new Cache(300_000, () => json<WtsConfig>(["config"]));
const changedCaches = new Map<string, Cache<{ dir: string; base: string; models: DbtModel[] }>>();

export async function sessions(force = false): Promise<Session[]> {
  return (await sessionsCache.get(force)).sessions;
}

export async function repos(force = false): Promise<Worktree[]> {
  return (await reposCache.get(force)).repos;
}

export async function config(): Promise<WtsConfig> {
  return configCache.get();
}

export async function changed(dir: string, force = false): Promise<DbtModel[]> {
  let cache = changedCaches.get(dir);
  if (!cache) {
    cache = new Cache(4000, () =>
      json<{ dir: string; base: string; models: DbtModel[] }>(["changed", dir]),
    );
    changedCaches.set(dir, cache);
  }
  return (await cache.get(force)).models;
}

export function invalidate(): void {
  sessionsCache.invalidate();
  reposCache.invalidate();
  configCache.invalidate();
  for (const c of changedCaches.values()) {
    c.invalidate();
  }
}
