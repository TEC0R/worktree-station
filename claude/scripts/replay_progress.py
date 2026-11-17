"""Progress bar of a headless data-agency replay, read from its `claude -p --output-format stream-json` output.

`python3 -I replay_progress.py <stream.jsonl>` prints the current bar; `--follow` prints a line each time it moves, and
exits when the run ends. Percentages follow the steps of `/data-agency:review`; for another circuit, the bar moves with
the agents launched and returned.
"""
import json
import sys
import time

LABELS = {10: "started", 20: "PR read", 40: "reviews running", 60: "reviews returned", 70: "comments checked",
          80: "quality gate", 90: "log and runs.md", 100: "delivered"}


def progress(path):
    pct, agents, done, cost = 10, {}, set(), None
    for line in open(path, encoding="utf-8"):
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if m.get("type") == "result":
            pct, cost = 100, m.get("total_cost_usd")
        if m.get("parent_tool_use_id"):
            continue
        msg = m.get("message")
        for c in (msg.get("content") if isinstance(msg, dict) else None) or []:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "tool_use":
                i = c.get("input") or {}
                cmd = str(i.get("command", ""))
                if "gh pr" in cmd:
                    pct = max(pct, 20)
                if c.get("name") in ("Agent", "Task"):
                    agents[c["id"]] = i.get("subagent_type", "")
                    pct = max(pct, 80 if "quality-gate" in agents[c["id"]] else 40)
                if "pr_comments.py" in cmd:
                    pct = max(pct, 70)
                if "runs.md" in str(i.get("file_path", "")) or "runs.md" in cmd:
                    pct = max(pct, 90)
            if c.get("type") == "tool_result" and c.get("tool_use_id") in agents:
                done.add(c["tool_use_id"])
                if len(done) == len(agents) and pct == 40:
                    pct = 60
    label = LABELS[max(p for p in LABELS if p <= pct)]
    bar = "█" * (pct // 10) + "░" * (10 - pct // 10)
    # total_cost_usd of the stream leaves out background agents: the cost to quote is the runs.md line
    return pct, f"{bar} {pct:3d} %  {label} · agents {len(done)}/{len(agents)}" + (" · cost: see runs.md" if cost else "")


def main(argv):
    path, follow = argv[0], "--follow" in argv
    last = None
    while True:
        try:
            pct, line = progress(path)
        except FileNotFoundError:
            pct, line = 0, "waiting for the run to start"
        if line != last:
            print(time.strftime("%H:%M ") + line, flush=True)
            last = line
        if not follow or pct == 100:
            return 0
        time.sleep(15)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
