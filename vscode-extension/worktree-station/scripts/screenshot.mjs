// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Terry Cornelusse

// Renders the real dashboard HTML outside VS Code, fed with fictional data, and
// captures it with headless Chrome: the README screenshot never shows real work.
//   npm run screenshot            → ../../docs/dashboard.png
//   CHROME=/path/to/chrome npm run screenshot

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../docs/dashboard.png");
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// The dashboard module imports `vscode`, which only exists inside the editor: any
// property of this stand-in is a no-op class, enough to load the module and call html().
// The bundler copies named exports one by one, so every `vscode.X` the sources use is listed.
const names = new Set();
for (const f of readdirSync(join(here, "../src"))) {
  for (const m of readFileSync(join(here, "../src", f), "utf8").matchAll(/\bvscode\.(\w+)/g)) names.add(m[1]);
}
const stub = `
const anything = new Proxy(function () {}, {
  get: () => anything,
  apply: () => anything,
  construct: () => anything,
});
module.exports = { ${[...names].map((n) => `${n}: anything`).join(", ")} };`;

const tmp = mkdtempSync(join(tmpdir(), "wts-shot-"));
try {
  await esbuild.build({
    entryPoints: [join(here, "../src/dashboard.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: join(tmp, "dashboard.mjs"),
    logLevel: "error",
    plugins: [
      {
        name: "vscode-stub",
        setup(build) {
          build.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "stub" }));
          build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: stub, loader: "js" }));
        },
      },
    ],
  });
  const { html } = await import(pathToFileURL(join(tmp, "dashboard.mjs")).href);

  const at = (h, m) => Date.UTC(2026, 10, 25, h, m);
  const wt = (repo, kind, branch, extra = {}) => ({
    path: `/home/you/worktrees/${repo}-${branch}`,
    name: `${repo}-${branch}`,
    repo,
    kind,
    branch,
    exists: true,
    dirty: 0,
    ahead: 0,
    behind: 0,
    busy: false,
    reason: "",
    ...extra,
  });
  const session = (id, label, column, worktrees, extra = {}) => ({
    id,
    label,
    origin: id,
    column,
    loaded: false,
    busy: false,
    worktrees,
    ...extra,
  });
  const data = {
    columns: [
      { id: "to-do", label: "To Do" },
      { id: "in-progress", label: "In Progress" },
      { id: "in-review", label: "In Review" },
      { id: "stakeholder-review", label: "Stakeholder review" },
    ],
    sessions: [
      session("20261124-091500", "Churn rate excludes trial accounts", "in-progress", [
        wt("analytics", "dbt", "fix/abc-12-churn-trials", { dirty: 3, busy: true, reason: "touched less than 8 h ago" }),
        wt("bi", "lookml", "fix/abc-12-churn-trials", { ahead: 1 }),
      ], { loaded: true, busy: true, activity: "working" }),
      session("20261123-143000", "Weekly revenue export", "in-progress", [
        wt("analytics", "dbt", "feat/abc-9-weekly-export", { ahead: 2 }),
      ], { activity: "waiting" }),
      session("20261121-100000", "Billing model revamp", "to-do", [
        wt("analytics", "dbt", "wt-main-20261121-100000"),
        wt("bi", "lookml", "wt-main-20261121-100000"),
      ]),
      session("20261120-161000", "Orders dashboard: new date filter for the regional teams", "in-review", [
        wt("bi", "lookml", "feat/abc-7-orders-date-filter"),
      ]),
      session("20261119-110000", "Events backfill", "stakeholder-review", [
        wt("analytics", "dbt", "feat/abc-5-events-backfill", { behind: 4 }),
      ]),
    ],
    repos: [
      { path: "/home/you/analytics", name: "analytics", branch: "main", base: "main", dirty: 0, ahead: 0, behind: 0 },
      { path: "/home/you/bi", name: "bi", branch: "main", base: "main", dirty: 0, ahead: 0, behind: 2 },
    ],
    runs: [
      { id: "1", label: "dbt build fct_churn", cwd: "", ok: true, durationMs: 48200, finishedAt: at(9, 42) },
      { id: "2", label: "wts sync --sessions", cwd: "", ok: true, durationMs: 9100, finishedAt: at(9, 20) },
      { id: "3", label: "dbt test fct_orders", cwd: "", ok: false, durationMs: 21700, finishedAt: at(8, 55) },
    ],
    claudeMode: "terminal",
  };

  // A dark theme close to VS Code's default, the variables the webview reads.
  const theme = `<style>:root{
    --vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--vscode-font-size:13px;
    --vscode-foreground:#cccccc;--vscode-editor-background:#1f1f1f;--vscode-descriptionForeground:#9d9d9d;
    --vscode-button-background:#0078d4;--vscode-button-foreground:#ffffff;--vscode-button-hoverBackground:#026ec1;
    --vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#cccccc;
    --vscode-button-secondaryHoverBackground:#3c3c3c;--vscode-button-border:#ffffff12;
    --vscode-panel-border:#2b2b2b;--vscode-editorWidget-background:#202020;--vscode-focusBorder:#0078d4;
    --vscode-badge-background:#616161;--vscode-badge-foreground:#f8f8f8;--vscode-list-hoverBackground:#2a2d2e;
    --vscode-gitDecoration-modifiedResourceForeground:#e2c08d;--vscode-charts-blue:#3794ff;
    --vscode-charts-green:#89d185;--vscode-errorForeground:#f85149;color-scheme:dark}</style>
  <script>window.acquireVsCodeApi=()=>({postMessage(){}});
  addEventListener("load",()=>postMessage({type:"state",data:${JSON.stringify(data)}},"*"));</script>`;

  const page = html({ cspSource: "" })
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
    .replace("</head>", `${theme}</head>`);
  const file = join(tmp, "dashboard.html");
  writeFileSync(file, page);
  mkdirSync(dirname(out), { recursive: true });
  execFileSync(chrome, [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    "--window-size=1280,860",
    "--virtual-time-budget=2000",
    `--screenshot=${out}`,
    pathToFileURL(file).href,
  ], { stdio: "ignore" });
  console.log(`screenshot → ${out}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
