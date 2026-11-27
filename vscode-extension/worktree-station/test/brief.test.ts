// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Terry Cornelusse

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { claimBrief, claudeCommand } from "../src/brief.ts";

const SID = "20261127-151841";
const TOKEN = "0123456789abcdef0123456789abcdef";

function briefs(pending: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wts-briefs-"));
  fs.mkdirSync(path.join(dir, "pending"));
  for (const [name, body] of Object.entries(pending)) {
    fs.writeFileSync(path.join(dir, "pending", name), body);
  }
  return dir;
}

test("a pending brief is moved to used/ and its new path returned", () => {
  const dir = briefs({ [`${SID}-${TOKEN}.md`]: "do the thing" });
  const got = claimBrief(SID, TOKEN, dir);
  assert.equal(got, path.join(dir, "used", `${SID}-${TOKEN}.md`));
  assert.equal(fs.readFileSync(got, "utf8"), "do the thing");
  assert.equal(fs.existsSync(path.join(dir, "pending", `${SID}-${TOKEN}.md`)), false);
});

test("a token works once", () => {
  const dir = briefs({ [`${SID}-${TOKEN}.md`]: "x" });
  claimBrief(SID, TOKEN, dir);
  assert.throws(() => claimBrief(SID, TOKEN, dir), /no pending brief/);
});

test("a token bound to another session is not found", () => {
  const dir = briefs({ [`20260101-000000-${TOKEN}.md`]: "x" });
  assert.throws(() => claimBrief(SID, TOKEN, dir), /no pending brief/);
});

test("malformed tokens and sessions are refused before touching the disk", () => {
  const dir = briefs();
  for (const [sid, token] of [
    [SID, "../../etc/passwd"],
    [SID, TOKEN.toUpperCase()],
    [SID, TOKEN.slice(1)],
    ["../x", TOKEN],
    [`${SID}/..`, TOKEN],
  ]) {
    assert.throws(() => claimBrief(sid, token, dir), /invalid brief token/);
  }
  assert.equal(fs.existsSync(path.join(dir, "used")), false);
});

const base = { bin: "claude", extra: [], addDirs: [], hasConversation: false };

test("no brief, no conversation: the bare command, as before", () => {
  assert.equal(claudeCommand(base), "claude");
});

test("the brief goes last, after --, read by the shell", () => {
  assert.equal(
    claudeCommand({ ...base, brief: "/b/used/x.md" }),
    `claude -- "$(cat '/b/used/x.md')"`,
  );
});

test("--add-dir cannot swallow the brief: -- sits between them", () => {
  assert.equal(
    claudeCommand({ ...base, addDirs: ["/w/a", "/w/b"], brief: "/b.md" }),
    `claude --add-dir '/w/a' --add-dir '/w/b' -- "$(cat '/b.md')"`,
  );
});

test("a session with a conversation continues it, the brief as next message", () => {
  assert.equal(
    claudeCommand({ ...base, hasConversation: true, brief: "/b.md" }),
    `claude --continue -- "$(cat '/b.md')"`,
  );
});

test("claudeArgs that pick a conversation win over --continue", () => {
  assert.equal(
    claudeCommand({ ...base, hasConversation: true, extra: ["--resume", "abc"] }),
    `claude '--resume' 'abc'`,
  );
});

test("claudeArgs pass through untouched, no permission flag added", () => {
  const got = claudeCommand({ ...base, extra: ["--model", "opus"], brief: "/b.md" });
  assert.equal(got, `claude '--model' 'opus' -- "$(cat '/b.md')"`);
  assert.doesNotMatch(got, /permission|dangerously/);
});

test("a quote in the brief path stays inside the shell quoting", () => {
  assert.equal(
    claudeCommand({ ...base, brief: "/tmp/it's.md" }),
    `claude -- "$(cat '/tmp/it'\\''s.md')"`,
  );
});
