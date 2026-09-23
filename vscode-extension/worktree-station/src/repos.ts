// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Terry Cornelusse

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import * as api from "./api";
import { quiet } from "./run";
import { RepoNode } from "./trees";

/**
 * Management of the session repo list. The CLI (`wts repo`) remains the only thing
 * that writes the file: the extension only asks the questions.
 */

type Entry = { name: string; base: string; kind: string };

async function wts(args: string[], timeoutMs = 30_000): Promise<string> {
  const conf = await api.config();
  const out = await quiet(["repo", ...args], conf.root, timeoutMs);
  api.invalidate();
  return out.trim();
}

const GITHUB_URL = /^(https?:\/\/|ssh:\/\/git@|git@)github\.com[:/][^/]+\/[^/]+?(\.git)?\/?$/;

/** Target repo: the clicked row, otherwise ask among the declared ones. */
async function pick(node: unknown, title: string): Promise<Entry | undefined> {
  const declared = (await api.config()).repos;
  if (node instanceof RepoNode) {
    return declared.find((r) => r.name === node.repo.repo);
  }
  const chosen = await vscode.window.showQuickPick(
    declared.map((r) => ({ label: r.name, description: `${r.base} · ${r.kind}`, entry: r })),
    { title, placeHolder: "Which repo?" },
  );
  return chosen?.entry;
}

type Source = { args: string[]; label: string; cloning: boolean };

/** GitHub link + destination folder (an existing non-empty folder = parent). */
async function fromGithub(root: string): Promise<Source | undefined> {
  const url = await vscode.window.showInputBox({
    title: "Add repo — GitHub link",
    prompt: "https://github.com/owner/repo or git@github.com:owner/repo.git",
    ignoreFocusOut: true,
    validateInput: (v) => (GITHUB_URL.test(v.trim()) ? undefined : "Not a GitHub repo link"),
  });
  if (!url) {
    return undefined;
  }
  const repo = url.trim().replace(/\/$/, "").replace(/\.git$/, "").split(/[/:]/).pop() ?? "";
  const dest = await vscode.window.showInputBox({
    title: `Add repo — where to clone ${repo}`,
    prompt: "Target folder. An existing clone of this repo is reused; an existing non-empty folder is used as parent.",
    value: path.join(root, repo),
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : "Required"),
  });
  if (!dest) {
    return undefined;
  }
  return { args: [url.trim(), "--dest", dest.trim()], label: repo, cloning: true };
}

/** Any git clone already on disk. */
async function fromFolder(root: string): Promise<Source | undefined> {
  const picked = await vscode.window.showOpenDialog({
    title: "Add repo — pick a git clone",
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(root),
    openLabel: "Add this repo",
  });
  const dir = picked?.[0]?.fsPath;
  if (!dir) {
    return undefined;
  }
  if (!fs.existsSync(path.join(dir, ".git"))) {
    vscode.window.showErrorMessage(`${dir} is not a git clone.`);
    return undefined;
  }
  return { args: [dir], label: path.basename(dir), cloning: false };
}

/** Declare a repo: GitHub link (cloned), folder on disk, or a clone already in the root. */
export async function addRepo(): Promise<boolean> {
  const conf = await api.config();
  const declared = new Set(conf.repos.map((r) => r.name));
  const nearby = fs
    .readdirSync(conf.root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !declared.has(d.name))
    .filter((d) => fs.existsSync(path.join(conf.root, d.name, ".git")))
    .map((d) => ({ label: d.name, description: path.join(conf.root, d.name), how: "nearby" as const }))
    .sort((a, b) => a.label.localeCompare(b.label));

  type Item = vscode.QuickPickItem & { how?: "github" | "folder" | "nearby" };
  const items: Item[] = [
    { label: "$(github) From a GitHub link…", detail: "Clones it (or reuses an existing clone)", how: "github" },
    { label: "$(folder-opened) From a folder on disk…", detail: "Any existing git clone", how: "folder" },
  ];
  if (nearby.length) {
    items.push({ label: `Clones in ${conf.root}`, kind: vscode.QuickPickItemKind.Separator }, ...nearby);
  }
  const chosen = await vscode.window.showQuickPick(items, {
    title: "Add a repo to sessions",
    placeHolder: "GitHub link, folder, or a clone already on disk",
  });
  if (!chosen?.how) {
    return false;
  }
  const source =
    chosen.how === "github"
      ? await fromGithub(conf.root)
      : chosen.how === "folder"
        ? await fromFolder(conf.root)
        : { args: [chosen.label], label: chosen.label, cloning: false };
  if (!source) {
    return false;
  }

  const base = await vscode.window.showInputBox({
    title: `Add ${source.label}`,
    prompt: "Default branch (leave empty to use origin/HEAD)",
    ignoreFocusOut: true,
    validateInput: (v) => (v.includes(":") ? "':' is not allowed" : undefined),
  });
  if (base === undefined) {
    return false;
  }
  // The branch is positional: it follows the source, before --dest.
  const [src, ...rest] = source.args;
  const args = ["add", src, ...(base.trim() ? [base.trim()] : []), ...rest];
  const run = () => wts(args, source.cloning ? 600_000 : 30_000);
  const out = source.cloning
    ? await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Cloning ${source.label}…` },
        run,
      )
    : await run();
  const last = out.split("\n").pop() ?? "";
  vscode.window.showInformationMessage(last.replace(/^✓\s*/, "") || `${source.label} added.`);
  return true;
}

/** Remove a repo from the list. Clone and worktrees stay on disk. */
export async function removeRepo(node: unknown): Promise<boolean> {
  const r = await pick(node, "Remove a repo from sessions");
  if (!r) {
    return false;
  }
  const answer = await vscode.window.showWarningMessage(
    `Remove ${r.name} from sessions? New sessions will no longer create a worktree for it. Nothing is deleted from disk.`,
    { modal: true },
    "Remove",
  );
  if (answer !== "Remove") {
    return false;
  }
  await wts(["rm", r.name]);
  vscode.window.showInformationMessage(`${r.name} removed from sessions.`);
  return true;
}

/** Change the branch offered by default when creating a session. */
export async function editBase(node: unknown): Promise<boolean> {
  const r = await pick(node, "Change a repo's default branch");
  if (!r) {
    return false;
  }
  const branch = await vscode.window.showInputBox({
    title: `Default branch — ${r.name}`,
    value: r.base,
    ignoreFocusOut: true,
    validateInput: (v) => (!v.trim() ? "Required" : v.includes(":") ? "':' is not allowed" : undefined),
  });
  if (branch === undefined || branch.trim() === r.base) {
    return false;
  }
  const out = await wts(["base", r.name, branch.trim()]);
  const warning = out.split("\n").find((l) => l.startsWith("~"));
  if (warning) {
    vscode.window.showWarningMessage(`${r.name}: ${warning.replace(/^~\s*/, "")}`);
  } else {
    vscode.window.showInformationMessage(`${r.name}: default branch is now ${branch.trim()}.`);
  }
  return true;
}

// ── New session: pick the repos, then the branches ───────────────────────────

type SessionRepo = { name: string; base: string; kind: string; dir: string };

/** Step 1: the session's repos. All checked by default. */
export async function pickSessionRepos(): Promise<SessionRepo[] | undefined> {
  const declared = (await api.config()).repos;
  if (declared.length <= 1) {
    return declared;
  }
  const chosen = await vscode.window.showQuickPick(
    declared.map((r) => ({
      label: r.name,
      description: `${r.kind} · default ${r.base}`,
      picked: true,
      repo: r,
    })),
    { title: "New session — repos", placeHolder: "Which repos for this session?", canPickMany: true, ignoreFocusOut: true },
  );
  if (!chosen) {
    return undefined;
  }
  if (chosen.length === 0) {
    vscode.window.showWarningMessage("Pick at least one repo.");
    return undefined;
  }
  return chosen.map((c) => c.repo);
}

function remoteBranches(dir: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", dir, "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/remotes/origin"],
      { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) =>
        resolve(
          err
            ? []
            : stdout
                .split("\n")
                .map((l) => l.trim().replace(/^origin\//, ""))
                .filter((b) => b && b !== "HEAD" && b !== "origin"),
        ),
    );
  });
}

/**
 * Step 2: a repo's branch. Remote branches, most recent first, the default one on
 * top; the list refreshes after a background fetch, and a name missing from it
 * can be typed (a branch pushed a moment ago).
 */
export function pickBranch(repo: SessionRepo, step: number, total: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { branch: string }>();
    qp.title = `New session — ${repo.name} branch`;
    qp.step = step;
    qp.totalSteps = total;
    qp.placeholder = `Remote branch to start ${repo.name} from (type to filter or enter another name)`;
    qp.ignoreFocusOut = true;
    qp.matchOnDescription = true;

    let known: string[] = [];
    const render = () => {
      const typed = qp.value.trim();
      const items = [repo.base, ...known.filter((b) => b !== repo.base)].map((b) => ({
        label: b,
        description: b === repo.base ? "default" : undefined,
        branch: b,
      }));
      if (typed && !known.includes(typed) && typed !== repo.base) {
        items.unshift({ label: `$(edit) ${typed}`, description: "not in the list — used as typed", branch: typed });
      }
      qp.items = items;
    };
    const load = async () => {
      known = await remoteBranches(repo.dir);
      render();
    };

    qp.busy = true;
    void load();
    execFile("git", ["-C", repo.dir, "fetch", "--prune", "--quiet", "origin"], { timeout: 30_000 }, () => {
      void load().finally(() => (qp.busy = false));
    });

    let done = false;
    qp.onDidChangeValue(render);
    qp.onDidAccept(() => {
      const b = qp.selectedItems[0]?.branch ?? qp.value.trim();
      if (!b || b.includes(":")) {
        return;
      }
      done = true;
      resolve(b);
      qp.hide();
    });
    qp.onDidHide(() => {
      if (!done) {
        resolve(undefined);
      }
      qp.dispose();
    });
    render();
    qp.show();
  });
}
