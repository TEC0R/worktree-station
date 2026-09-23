#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Terry Cornelusse
"""PostToolUse: checks the project CLAUDE.md dbt rules that a review misses
and that sqlfluff cannot see.

Non-destructive: modifies no file, returns the violations as context.
Purely local (regex + file reads): ~30 ms, unlike `sqlfluff lint`, whose dbt
templater recompiles the whole project (> 2 min).
"""
import datetime
import json
import re
import sys
from pathlib import Path

JINJA = re.compile(r"\{\{.*?\}\}|\{%.*?%\}", re.S)
RAW_TABLE = re.compile(r"\b(from|join)\s+([A-Za-z_]\w*\.){2,}\w+", re.I)
# A bare number is not enough: "1 row per opportunity" declares a grain,
# "501 rows on 2026-08-20" reports a measurement. Only the second form is flagged —
# a percentage *of* something, or a 3+ digit number next to a measure noun.
# French words stay in the patterns on purpose: comments may be written in French.
MEASURE_NOUN = (r"rows?|lignes?|duplicates?|doublons?|occurrences?|cases?|"
                r"records?|enregistrements?|runs?")
FIGURE_IN_COMMENT = re.compile(
    r"--(?![^\n]*https?://)[^\n]*?(?:"
    r"\d+(?:[.,]\d+)?\s*%\s*(?:of|de|des)\b"
    r"|(?<!year )(?<!annee )(?<!year: )\b(?!(?:19|20)\d{2}\b)\d{3,}\b[^\n]{0,30}?(?:" + MEASURE_NOUN + r")\b"
    r"|(?:" + MEASURE_NOUN + r")\b[^\n]{0,30}?(?<!year )\b(?!(?:19|20)\d{2}\b)\d{3,}\b"
    r")",
    re.I,
)
CLAUSE_HEAD = re.compile(r"^\s*(where|on)\s+\S", re.I)
CONTINUATION = re.compile(r"^\s*(and|or)\b", re.I)


def repo_root(path: Path):
    for parent in [path, *path.parents]:
        if (parent / "dbt_project.yml").is_file():
            return parent
    return None


def find_schema_entry(sql: Path) -> bool:
    """Does the model have an entry in a schema.yml of the same folder?"""
    needle = f"- name: {sql.stem}"
    for yml in sql.parent.glob("*.yml"):
        try:
            if needle in yml.read_text():
                return True
        except OSError:
            continue
    return False


def check_sql(path: Path) -> list:
    text = path.read_text(errors="replace")
    stripped = JINJA.sub(" ", text)
    lines = text.splitlines()
    out = []

    if RAW_TABLE.search(stripped):
        hit = RAW_TABLE.search(stripped).group(0)
        out.append(f"raw table `{hit.strip()}`: use {{{{ ref() }}}} or {{{{ source() }}}}")

    # Leading comment block: the contract lives in schema.yml, not in the .sql
    head = 0
    for line in lines:
        s = line.strip()
        if not s:
            continue
        if s.startswith("--"):
            head += 1
            continue
        break
    if head >= 3:
        out.append(f"{head}-line comment block at the top: "
                   "the model description belongs in schema.yml, not in the .sql")

    for i, line in enumerate(lines, 1):
        if FIGURE_IN_COMMENT.search(line):
            out.append(f"L{i}: measured figure in a comment — "
                       "it turns false on the next run, put it in the PR body")
            break

    for i, line in enumerate(lines):
        if not CLAUSE_HEAD.match(line):
            continue
        for nxt in lines[i + 1:]:
            if not nxt.strip():
                continue
            if CONTINUATION.match(nxt):
                kw = line.strip().split()[0].lower()
                out.append(f"L{i + 1}: multi-line `{kw}` — break after the keyword "
                           "and indent the contents (LT02)")
            break
        if out and out[-1].startswith(f"L{i + 1}:"):
            break

    if "/models/" in str(path) and not find_schema_entry(path):
        out.append(f"no `- name: {path.stem}` entry in a schema.yml of this folder — "
                   "model and column descriptions are mandatory (dbt-checkpoint)")
    return out


def check_yaml(path: Path) -> list:
    if path.name not in ("schema.yml", "sources.yml"):
        return []
    text = path.read_text(errors="replace")
    today = datetime.date.today().isoformat()
    out = []
    if "doc_last_updated" in text and today not in text:
        out.append("documentation changed: set `meta.doc_last_updated` to "
                   f'"{today}" on the model(s) touched')
    if re.search(r"^\s*data_tests:", text, re.M) and "owner:" not in text:
        out.append("`data_tests` without an `owner:<team>` tag "
                   "(and `source:<system>` unless the data is purely internal)")
    return out


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0

    raw = (payload.get("tool_input", {}).get("file_path")
           or payload.get("tool_response", {}).get("filePath") or "")
    if not raw:
        return 0

    path = Path(raw)
    if not path.is_file() or not repo_root(path):
        return 0

    try:
        if path.suffix == ".sql":
            findings = check_sql(path)
        elif path.suffix in (".yml", ".yaml"):
            findings = check_yaml(path)
        else:
            return 0
    except OSError:
        return 0

    if not findings:
        return 0

    body = "\n".join(f"  - {f}" for f in findings)
    print(json.dumps({
        "suppressOutput": True,
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": (
                f"dbt conventions not met in {path.name} "
                "(project CLAUDE.md rules):\n" + body +
                "\nFix before moving on. SQL style: `wts fmt " + str(path) + "`."
            ),
        },
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
