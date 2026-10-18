#!/usr/bin/env python3
"""SM merge guard (gh-1537 AC5) — the cheap alarm for the serialized-
validation invariant.

Invariant under watch: the SM queue (machine-sm.yml -> factory-sm) is
strictly serialized and validates the EXACT tree that merges — update
branch onto main, dispatch ci.yml on the updated head, merge only when
green. With the post-merge main CI run retired (gh-1537), nothing else
stands between a violated invariant and a red main: this guard fires on
every push to main and asserts the pushed tree was covered by a
SUCCESSFUL ci.yml run (an SM pre-merge validation). The covering run may
be of ANY event — workflow_dispatch, pull_request or push (gh-1044):
most validations in this repo arrive as pull_request-event runs (leg
push -> PR synchronize -> CI), and the invariant is tree coverage by a
green validation, not who dispatched it.

A push whose tree has no successful validation run of any event is the
#687-invariant violation the owner asked to alarm on instead of relying
on a nightly backstop: the guard files/updates one `sm-guard`-labelled
issue (dedup by comment, same convention as ci-red-report).

Canonical home: IstiN/dmtools-agentic-workflows/scripts/sm_merge_guard.py
(fetched at @main by the factory reusable workflow). This in-repo copy
exists because the canonical probe filtered `--event workflow_dispatch`
and this repo's CI validates mostly via pull_request runs (gh-1044 false
alarm gh-1033 on the #1020 merge); the factory token cannot push to the
workflows repo. Once upstream accepts any-event coverage, drop this copy
and re-point .github/workflows/sm-merge-guard.yml at the reusable
workflow.

Match semantics: TREE identity, not commit identity — the SM may land a
merge as a fast-forward (same commit SHA as the validated head) or as a
squash/merge commit (new SHA, byte-identical tree). The ticket's
invariant is literally "the tree that lands in main is byte-identical to
the validated tree", so `git rev-parse HEAD^{tree}` of the push is
compared against the tree of each recent successful dispatch run's head
(with an exact head-SHA match accepted as the fast-forward case).

Release-bot bump pushes (`chore(release):` subjects) skip the guard —
defense-in-depth: gh-1522 retired the bump flow so none land anymore, but
if one ever returns it is release-flow, gated downstream by the full
quality gate that runs on the cut v* tag BEFORE publish/binaries.

Exit codes: 0 = validated / skipped, 3 = invariant violated (alarm filed
when --alarm-issue), 1 = gh/tooling error, 2 = usage error.

Pure stdlib + gh. The decision itself (`decide`) takes pre-fetched runs
so the unit test injects fixtures via --runs-json — no network, no gh.
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

ALARM_LABEL = "sm-guard"
# Cap the per-run tree lookups: validations are fresh (minutes before the
# merge), so the matching run is always among the most recent dispatches;
# the cap bounds gh api calls per push, not correctness.
MAX_TREE_LOOKUPS = 40


def gh(*args: str, check: bool = True) -> str:
    proc = subprocess.run(["gh", *args], capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout


def fetch_validated_runs(repo: str, workflow: str,
                         window_hours: int) -> list:
    """Recent SUCCESSFUL <workflow> runs of ANY event (workflow_dispatch,
    pull_request, push), each with the tree sha of its head commit
    resolved via the commits API.

    No --event filter: the invariant is tree coverage by a green
    validation, not who dispatched it (gh-1044 — the guard false-alarmed
    on the #1020 merge because the green Quality run that covered the
    tree was a pull_request-event run, dropped by the old
    `--event workflow_dispatch` filter; most validations in this repo
    arrive as pull_request runs: leg push -> PR synchronize -> Quality)."""
    since = datetime.now(timezone.utc) - timedelta(hours=window_hours)
    out = gh("run", "list", "--repo", repo, "--workflow", workflow,
             "--json", "databaseId,headSha,conclusion,createdAt",
             "--limit", "100")
    runs = []
    for r in json.loads(out):
        if r.get("conclusion") != "success":
            continue
        created = datetime.fromisoformat(
            r["createdAt"].replace("Z", "+00:00"))
        if created < since:
            continue
        runs.append({
            "database_id": r["databaseId"],
            "head_sha": r["headSha"],
            # decide() re-checks conclusion on every run; without the
            # field every fetched run read as None != "success" and was
            # skipped — the guard alarmed on every push (gh-1568).
            "conclusion": r.get("conclusion"),
            "tree_sha": None,  # resolved below
            "created_at": r["createdAt"],
        })
    # Newest first — the match is almost always the first lookup.
    for run in runs[:MAX_TREE_LOOKUPS]:
        try:
            # The commits API nests the tree under `commit` — `.tree.sha`
            # resolves to null/empty (gh-1568: every tree match silently
            # failed and every merge-commit landing false-alarmed).
            tree = gh("api", f"repos/{repo}/commits/{run['head_sha']}",
                      "--jq", ".commit.tree.sha").strip()
            run["tree_sha"] = tree or None
        except RuntimeError as e:
            print(f"::warning::{e}", file=sys.stderr)
    return runs


def decide(subject: str, pushed_sha: str, pushed_tree: str,
           runs: list, workflow: str = "ci.yml") -> dict:
    """The pure invariant check. `runs` carry head_sha/tree_sha of
    successful dispatched validations. Returns a verdict dict."""
    if subject.startswith("chore(release):"):
        return {"verdict": "skipped",
                "reason": "release-bot bump push — the v* tag run gates it"}
    for run in runs:
        # Only successes validate — a run with NO conclusion was never
        # confirmed green, so it can never certify a push
        # (fetch_validated_runs pre-filters, but the test seam and any
        # future caller may pass mixed or incomplete run dicts — the
        # invariant holds by construction).
        if run.get("conclusion") != "success":
            continue
        if run.get("head_sha") == pushed_sha:
            return {"verdict": "ok",
                    "reason": f"exact head-SHA match: run "
                              f"{run.get('database_id')} validated the "
                              f"merged commit itself (fast-forward)"}
        if run.get("tree_sha") and run["tree_sha"] == pushed_tree:
            return {"verdict": "ok",
                    "reason": f"tree match: run {run.get('database_id')} "
                              f"validated this exact tree (squash/merge "
                              f"commit re-landed it)"}
    return {"verdict": "alarm",
            "reason": f"no successful {workflow} run of any event "
                      f"(workflow_dispatch, pull_request, push) covers "
                      f"this tree — the SM merged without (or before) a "
                      f"green validation of the exact tree"}


def alarm_issue(repo: str, pushed_sha: str, subject: str, reason: str,
                runs: list) -> None:
    """File or update the deduplicated sm-guard issue (ci-red-report
    convention: one open issue per guard, comments for repeats)."""
    links = "\n".join(
        f"- https://github.com/{repo}/actions/runs/{r.get('database_id')}"
        f" (head `{r.get('head_sha')}`"
        + (f", tree `{r['tree_sha']}`" if r.get("tree_sha") else "")
        + ")"
        for r in runs[:10])
    # An empty commit message (git commit --allow-empty-message / the Git
    # API) would crash the alarm itself on splitlines()[0] — the one path
    # where the sm-guard issue would be lost for exactly the push that
    # tripped it. Degrade to a placeholder instead.
    subject_line = (subject.splitlines()[0]
                    if subject.splitlines() else "(empty commit message)")
    body = (
        f"**Pushed SHA**: `{pushed_sha}`\n"
        f"**Subject**: {subject_line}\n\n"
        f"**Why this is an alarm** (gh-1537 AC5): the SM queue must be "
        f"strictly serialized and validate the exact tree that merges. "
        f"This push to main has no successful ci.yml validation dispatch "
        f"covering its tree.\n\n"
        f"**Guard verdict**: {reason}\n\n"
        f"Recent dispatched validation runs considered:\n"
        f"{links or '(none in the window)'}\n")
    existing = gh("issue", "list", "--repo", repo, "--state", "open",
                  "--label", ALARM_LABEL,
                  "--json", "number", "--jq", ".[0].number // empty")
    if existing.strip():
        gh("issue", "comment", existing.strip(), "--repo", repo,
           "--body", body)
        print(f"::warning::sm-guard: commented on #{existing.strip()}")
    else:
        out = gh("issue", "create", "--repo", repo,
                 "--title", f"[sm-guard] main push without validated tree: "
                            f"{pushed_sha[:12]}",
                 "--body", body, "--label", "bug", "--label", ALARM_LABEL)
        print(f"::warning::sm-guard: filed {out.strip().splitlines()[-1]}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY"))
    ap.add_argument("--sha", required=True, help="pushed head commit sha")
    ap.add_argument("--subject", default="",
                    help="pushed head commit subject (first line enough)")
    ap.add_argument("--tree", required=True,
                    help="tree sha of the pushed head (`git rev-parse "
                         "HEAD^{tree}`)")
    ap.add_argument("--runs-json",
                    help="test seam: pre-fetched validation runs "
                         "(skip the gh run list/tree lookups)")
    ap.add_argument("--workflow", default="ci.yml",
                    help="validation workflow FILE name the SM dispatches "
                         "(ci.yml, quality.yml, ...)")
    ap.add_argument("--window-hours", type=int, default=24)
    ap.add_argument("--alarm-issue", action="store_true",
                    help="file/update the sm-guard issue on violation "
                         "(needs --repo + GH_TOKEN)")
    args = ap.parse_args()

    if args.runs_json:
        with open(args.runs_json, encoding="utf-8") as f:
            runs = json.load(f)
    else:
        if not args.repo:
            print("ERROR: --repo or GITHUB_REPOSITORY required",
                  file=sys.stderr)
            return 2
        try:
            runs = fetch_validated_runs(args.repo, args.workflow,
                                        args.window_hours)
        except RuntimeError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            return 1

    verdict = decide(args.subject, args.sha, args.tree, runs,
                     args.workflow)
    print(f"sm-merge-guard: {verdict['verdict']} — {verdict['reason']}")
    if verdict["verdict"] != "alarm":
        return 0

    if args.alarm_issue:
        if not args.repo:
            print("ERROR: --alarm-issue needs --repo", file=sys.stderr)
            return 2
        try:
            alarm_issue(args.repo, args.sha, args.subject,
                        verdict["reason"], runs)
        except RuntimeError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            return 1
    else:
        print("::warning::alarm (issue filing disabled — pass "
              "--alarm-issue in the workflow)")
    return 3


if __name__ == "__main__":
    sys.exit(main())
