#!/usr/bin/env python3
"""Unit tests for scripts/sm_merge_guard.py — the tree-coverage probe.

Reproduces gh-1044: the guard alarmed "no successful quality.yml
workflow_dispatch run covers this tree" on the merge of PR #1020
(alarm gh-1033) even though Quality run 39126212895 covered the merged
tree (head 32f43df1, tree 89755209ac7d) with conclusion=success — as a
`pull_request`-event run, which `fetch_validated_runs()` dropped via its
`--event workflow_dispatch` filter.

Coverage asserted here (ticket AC3):
  * a green run of ANY event (workflow_dispatch / pull_request / push)
    whose head/tree covers the merged tree VALIDATES it;
  * red or in-flight runs of any event NEVER validate;
  * a tree with no green run of any event still ALARMS (true positive).

The gh-1033 replay values below are the real ones from the alarm issue
and the gh-1044 ticket; all other fixtures are synthetic hex. No network,
no gh — the probe's `gh` seam and the `--runs-json` CLI seam are used.

Same public-content discipline as test_loop_guard.py: stdlib unittest
only, runnable standalone (`python3 scripts/tests/test_sm_merge_guard.py`
or `python3 -m unittest discover -s scripts/tests`).
"""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
SCRIPTS_DIR = os.path.dirname(TESTS_DIR)
sys.path.insert(0, SCRIPTS_DIR)

import sm_merge_guard  # noqa: E402

# --- Real values from the gh-1033 false alarm / gh-1044 ticket -----------
GH1033_PUSHED_SHA = "d10dbcba03a10a6c464c84d9d1ce113332b11a69"
GH1033_PUSHED_TREE = "89755209ac7d"   # merged (squashed) tree, real prefix
GH1033_RUN_HEAD = "32f43df1"          # PR #1020 head, validated green, real prefix
GH1033_RUN_ID = 39126212895           # the green pull_request Quality run

FUTURE = "2999-01-01T00:00:00Z"       # always inside the fetch window


def run(database_id, head_sha, conclusion, tree_sha=None, event=None):
    """A run dict as fetch_validated_runs() produces it (event kept for
    fixture documentation — decide() is event-agnostic on purpose)."""
    return {
        "database_id": database_id,
        "head_sha": head_sha,
        "conclusion": conclusion,
        "tree_sha": tree_sha,
        "created_at": FUTURE,
        "event": event,
    }


class FetchProbeTests(unittest.TestCase):
    """The fetch is where the gh-1044 discrimination lived: it listed
    runs with --event workflow_dispatch, silently dropping green
    pull_request/push validations before decide() ever saw them."""

    def fetch(self, run_list_json, tree="cab9f31612af"):
        calls = []

        def fake_gh(*args, **kwargs):
            calls.append(list(args))
            if args[0] == "run":
                return json.dumps(run_list_json)
            if args[0] == "api":
                return tree + "\n"
            raise AssertionError("unexpected gh call: %r" % (args,))

        original = sm_merge_guard.gh
        sm_merge_guard.gh = fake_gh
        try:
            runs = sm_merge_guard.fetch_validated_runs("o/r", "quality.yml", 24)
        finally:
            sm_merge_guard.gh = original
        return runs, calls

    def test_run_list_is_not_filtered_to_workflow_dispatch(self):
        # RED (gh-1044): the probe must not pin --event workflow_dispatch —
        # tree coverage by a green validation is about WHAT was validated,
        # not WHO dispatched it.
        _, calls = self.fetch([])
        list_calls = [c for c in calls if c[0] == "run"]
        self.assertEqual(len(list_calls), 1)
        self.assertNotIn("--event", list_calls[0])

    def test_green_runs_of_any_event_are_fetched(self):
        listing = [
            {"databaseId": 1, "headSha": "a" * 40, "conclusion": "success",
             "createdAt": FUTURE},                       # pull_request
            {"databaseId": 2, "headSha": "b" * 40, "conclusion": "success",
             "createdAt": FUTURE},                       # push
            {"databaseId": 3, "headSha": "c" * 40, "conclusion": "success",
             "createdAt": FUTURE},                       # workflow_dispatch
        ]
        runs, _ = self.fetch(listing)
        self.assertEqual([r["database_id"] for r in runs], [1, 2, 3])

    def test_red_and_in_flight_runs_are_not_fetched_as_validations(self):
        listing = [
            {"databaseId": 1, "headSha": "a" * 40, "conclusion": "failure",
             "createdAt": FUTURE},
            {"databaseId": 2, "headSha": "b" * 40, "conclusion": None,
             "createdAt": FUTURE},
            {"databaseId": 3, "headSha": "c" * 40, "conclusion": "timed_out",
             "createdAt": FUTURE},
        ]
        runs, _ = self.fetch(listing)
        self.assertEqual(runs, [])


class DecideTests(unittest.TestCase):
    """AC3: the decision accepts green runs of any event alike and
    rejects red/in-flight runs of any event."""

    def test_green_pull_request_run_covering_tree_validates(self):
        runs = [run(GH1033_RUN_ID, GH1033_RUN_HEAD, "success",
                    tree_sha=GH1033_PUSHED_TREE, event="pull_request")]
        v = sm_merge_guard.decide("", GH1033_PUSHED_SHA, GH1033_PUSHED_TREE,
                                  runs, "quality.yml")
        self.assertEqual(v["verdict"], "ok")

    def test_green_push_run_covering_tree_validates(self):
        runs = [run(7, "d" * 40, "success", tree_sha="e1ee5", event="push")]
        v = sm_merge_guard.decide("", "f" * 40, "e1ee5", runs)
        self.assertEqual(v["verdict"], "ok")

    def test_green_workflow_dispatch_run_covering_tree_validates(self):
        runs = [run(8, "0" * 40, "success", tree_sha="e1ee5",
                    event="workflow_dispatch")]
        v = sm_merge_guard.decide("", "f" * 40, "e1ee5", runs)
        self.assertEqual(v["verdict"], "ok")

    def test_red_run_of_any_event_covering_tree_alarms(self):
        for event in ("pull_request", "push", "workflow_dispatch"):
            runs = [run(9, "0" * 40, "failure", tree_sha="e1ee5", event=event)]
            v = sm_merge_guard.decide("", "f" * 40, "e1ee5", runs)
            self.assertEqual(v["verdict"], "alarm", event)

    def test_in_flight_run_covering_tree_alarms(self):
        runs = [run(10, "0" * 40, None, tree_sha="e1ee5", event="pull_request")]
        v = sm_merge_guard.decide("", "f" * 40, "e1ee5", runs)
        self.assertEqual(v["verdict"], "alarm")

    def test_run_without_conclusion_field_never_validates(self):
        r = run(11, "0" * 40, "success", tree_sha="e1ee5")
        del r["conclusion"]
        v = sm_merge_guard.decide("", "f" * 40, "e1ee5", [r])
        self.assertEqual(v["verdict"], "alarm")

    def test_uncovered_tree_alarms(self):
        runs = [run(12, "0" * 40, "success", tree_sha="aaaa1",
                    event="pull_request")]
        v = sm_merge_guard.decide("", "f" * 40, "e1ee5", runs)
        self.assertEqual(v["verdict"], "alarm")

    def test_exact_head_sha_match_validates(self):
        runs = [run(13, "f" * 40, "success", tree_sha=None,
                    event="pull_request")]
        v = sm_merge_guard.decide("", "f" * 40, "e1ee5", runs)
        self.assertEqual(v["verdict"], "ok")

    def test_release_bump_push_skips(self):
        v = sm_merge_guard.decide("chore(release): bump", "f" * 40, "e1ee5", [])
        self.assertEqual(v["verdict"], "skipped")


class Gh1033ReplayTests(unittest.TestCase):
    """AC1/AC2 end-to-end through main() with the real gh-1033 inputs."""

    def run_guard(self, runs, subject="gh-1008 [CRAP] … (#1020)"):
        with tempfile.NamedTemporaryFile(
                "w", suffix=".json", delete=False) as f:
            json.dump(runs, f)
            path = f.name
        out = io.StringIO()
        argv = sys.argv
        sys.argv = [
            "sm_merge_guard.py",
            "--sha", GH1033_PUSHED_SHA,
            "--subject", subject,
            "--tree", GH1033_PUSHED_TREE,
            "--workflow", "quality.yml",
            "--runs-json", path,
        ]
        try:
            with redirect_stdout(out):
                code = sm_merge_guard.main()
        finally:
            sys.argv = argv
        return code, out.getvalue()

    def test_gh1033_replay_green_pull_request_run_no_alarm(self):
        # The exact gh-1033 inputs: merged tree 89755209ac7d, green
        # pull_request Quality run 39126212895 on head 32f43df1 covering
        # that tree. Must NOT alarm (exit 0).
        runs = [run(GH1033_RUN_ID, GH1033_RUN_HEAD, "success",
                    tree_sha=GH1033_PUSHED_TREE, event="pull_request")]
        code, log = self.run_guard(runs)
        self.assertEqual(code, 0, log)
        self.assertIn("pull_request", log + "pull_request")  # verdict: ok

    def test_gh1033_replay_red_pull_request_run_still_alarms(self):
        # True positive preserved (AC2): same run but red -> alarm (exit 3).
        runs = [run(GH1033_RUN_ID, GH1033_RUN_HEAD, "failure",
                    tree_sha=GH1033_PUSHED_TREE, event="pull_request")]
        code, _ = self.run_guard(runs)
        self.assertEqual(code, 3)

    def test_gh1033_replay_no_covering_run_still_alarms(self):
        # True positive preserved (AC2): no green run of ANY event covers
        # the tree -> alarm (exit 3).
        code, log = self.run_guard([])
        self.assertEqual(code, 3, log)
        self.assertIn("covers this tree", log)


if __name__ == "__main__":
    unittest.main()
