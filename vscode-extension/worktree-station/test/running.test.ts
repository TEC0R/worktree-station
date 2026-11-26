// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Terry Cornelusse

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { claudeRunningIn, liveClaudes } from "../src/running.ts";

function configWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wts-running-"));
  fs.mkdirSync(path.join(dir, "sessions"));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, "sessions", name), body);
  }
  return dir;
}

const session = ["/work/dw-staging-20260101-000000", "/work/dl-master-20260101-000000"];

test("a live Claude in a worktree of the session is found", () => {
  const dir = configWith({
    "100.json": JSON.stringify({ pid: 100, cwd: "/work/dw-staging-20260101-000000" }),
  });
  assert.equal(claudeRunningIn(session, liveClaudes(dir, () => true)), true);
});

test("a Claude in a subfolder of a worktree counts", () => {
  const dir = configWith({
    "100.json": JSON.stringify({ pid: 100, cwd: "/work/dl-master-20260101-000000/views" }),
  });
  assert.equal(claudeRunningIn(session, liveClaudes(dir, () => true)), true);
});

test("a dead pid is ignored", () => {
  const dir = configWith({
    "100.json": JSON.stringify({ pid: 100, cwd: "/work/dw-staging-20260101-000000" }),
  });
  assert.equal(claudeRunningIn(session, liveClaudes(dir, () => false)), false);
});

test("a Claude outside the session, or in a folder sharing its prefix, is ignored", () => {
  const dir = configWith({
    "100.json": JSON.stringify({ pid: 100, cwd: "/home/user" }),
    "101.json": JSON.stringify({ pid: 101, cwd: "/work/dw-staging-20260101-000000-old" }),
  });
  assert.equal(claudeRunningIn(session, liveClaudes(dir, () => true)), false);
});

test("unreadable files and a missing folder find nothing", () => {
  const dir = configWith({ "100.json": "{not json", "101.key": "x" });
  assert.deepEqual(liveClaudes(dir, () => true), []);
  assert.deepEqual(liveClaudes(path.join(dir, "absent"), () => true), []);
});
