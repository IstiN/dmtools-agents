#!/usr/bin/env python3

import importlib.util
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "copilot_usage.py"
SPEC = importlib.util.spec_from_file_location("copilot_usage", MODULE_PATH)
copilot_usage = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(copilot_usage)


SCHEMA = """
CREATE TABLE assistant_usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    turn_index INTEGER,
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    reasoning_tokens INTEGER,
    total_nano_aiu INTEGER,
    duration_ms INTEGER
);
"""

SESSION_A = "5970236a-c0cb-46b0-85da-db6898163d11"
SESSION_B = "ccd0fd6f-d710-4b1d-9e7b-c7d1cda8e563"

FOOTER_A = (
    "Changes    +2 -2\n"
    "AI Credits 58.8 (3m 46s)\n"
    "Tokens     \u2191 1.8m (1.7m cached, 70.3k written) \u2022 \u2193 6.3k (1.0k reasoning)\n"
    f"Resume     copilot --resume={SESSION_A}\n"
)
# Older/short runs omit the "written" segment entirely.
FOOTER_B = (
    "Changes    +32 -0\n"
    "AI Credits 12.5 (49s)\n"
    "Tokens     \u2191 449.8k (409.2k cached) \u2022 \u2193 2.2k (976 reasoning)\n"
    f"Resume     copilot --resume={SESSION_B}\n"
)


def make_store(directory, rows):
    store = Path(directory) / "session-store.db"
    connection = sqlite3.connect(store)
    try:
        connection.executescript(SCHEMA)
        connection.executemany(
            "INSERT INTO assistant_usage_events (session_id, model, input_tokens, output_tokens, "
            "cache_read_tokens, cache_write_tokens, reasoning_tokens, total_nano_aiu, duration_ms) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        connection.commit()
    finally:
        connection.close()
    return store


class SessionIdParsingTest(unittest.TestCase):
    def test_finds_resume_ids_in_order_without_duplicates(self):
        self.assertEqual(
            copilot_usage.find_session_ids([FOOTER_A + FOOTER_B, FOOTER_A]),
            [SESSION_A, SESSION_B],
        )

    def test_accepts_space_separated_resume_flag(self):
        self.assertEqual(
            copilot_usage.find_session_ids([f"copilot --resume {SESSION_A.upper()}"]),
            [SESSION_A],
        )

    def test_returns_empty_when_no_session_is_printed(self):
        self.assertEqual(copilot_usage.find_session_ids(["no session here"]), [])


class ScaledNumberTest(unittest.TestCase):
    def test_parses_suffixes_and_separators(self):
        self.assertEqual(copilot_usage.parse_scaled_number("1.8m"), 1800000)
        self.assertEqual(copilot_usage.parse_scaled_number("70.3k"), 70300)
        self.assertEqual(copilot_usage.parse_scaled_number("1,017"), 1017)
        self.assertEqual(copilot_usage.parse_scaled_number("976"), 976)

    def test_rejects_garbage(self):
        self.assertEqual(copilot_usage.parse_scaled_number("n/a"), 0)
        self.assertEqual(copilot_usage.parse_scaled_number(None), 0)


class StoreAggregationTest(unittest.TestCase):
    def test_aggregates_rows_and_derives_input_other(self):
        with tempfile.TemporaryDirectory() as home:
            make_store(
                home,
                [
                    (SESSION_A, "claude-sonnet-5", 1000, 40, 900, 60, 7, 2_000_000_000, 1200),
                    (SESSION_A, "claude-sonnet-5", 500, 10, 450, 30, 3, 500_000_000, 300),
                ],
            )

            usage = copilot_usage.extract_usage([], home=home, session_ids=[SESSION_A])

        self.assertEqual(
            usage,
            {
                "provider": "copilot",
                "models": ["claude-sonnet-5"],
                "usage_records": 2,
                "input_other": 60,
                "input_cache_read": 1350,
                "input_cache_creation": 90,
                "output": 50,
                "reasoning": 10,
                "total_input": 1500,
                "total_tokens": 1550,
                "ai_credits": 2.5,
                "duration_ms": 1500,
                "source": "session-store",
            },
        )

    def test_sorts_models_and_never_reports_negative_input_other(self):
        with tempfile.TemporaryDirectory() as home:
            make_store(
                home,
                [
                    (SESSION_A, "gpt-5-mini", 100, 5, 90, 30, 0, 0, 0),
                    (SESSION_A, "claude-sonnet-5", 10, 1, 5, 0, 0, 0, 0),
                ],
            )

            usage = copilot_usage.extract_usage([], home=home, session_ids=[SESSION_A])

        self.assertEqual(usage["models"], ["claude-sonnet-5", "gpt-5-mini"])
        self.assertEqual(usage["input_other"], 0)

    def test_since_id_excludes_rows_from_previous_runs(self):
        with tempfile.TemporaryDirectory() as home:
            make_store(
                home,
                [
                    (SESSION_A, "gpt-5-mini", 999, 999, 0, 0, 0, 9_000_000_000, 0),
                    (SESSION_A, "gpt-5-mini", 100, 20, 0, 0, 0, 1_000_000_000, 0),
                ],
            )

            usage = copilot_usage.extract_usage(
                [], home=home, since_id=1, session_ids=[SESSION_A]
            )

        self.assertEqual(usage["usage_records"], 1)
        self.assertEqual(usage["total_tokens"], 120)
        self.assertEqual(usage["ai_credits"], 1.0)

    def test_baseline_reports_highest_row_id(self):
        with tempfile.TemporaryDirectory() as home:
            self.assertEqual(copilot_usage.max_usage_event_id(home), 0)
            make_store(home, [(SESSION_A, "gpt-5-mini", 1, 1, 0, 0, 0, 0, 0)])
            self.assertEqual(copilot_usage.max_usage_event_id(home), 1)

    def test_retried_attempts_on_one_session_are_not_double_counted(self):
        with tempfile.TemporaryDirectory() as home:
            make_store(home, [(SESSION_A, "gpt-5-mini", 100, 10, 0, 0, 0, 0, 0)])
            transcript = Path(home) / "attempt.log"
            transcript.write_text(FOOTER_A + FOOTER_A, encoding="utf-8")

            usage = copilot_usage.extract_usage(
                [transcript, transcript], home=home, session_ids=[SESSION_A]
            )

        self.assertEqual(usage["usage_records"], 1)
        self.assertEqual(usage["total_tokens"], 110)

    def test_rows_for_other_sessions_are_ignored(self):
        with tempfile.TemporaryDirectory() as home:
            make_store(
                home,
                [
                    (SESSION_A, "gpt-5-mini", 100, 10, 0, 0, 0, 0, 0),
                    (SESSION_B, "gpt-5-mini", 700, 70, 0, 0, 0, 0, 0),
                ],
            )

            usage = copilot_usage.extract_usage([], home=home, session_ids=[SESSION_A])

        self.assertEqual(usage["total_tokens"], 110)


class TranscriptFallbackTest(unittest.TestCase):
    def test_parses_full_footer(self):
        self.assertEqual(
            copilot_usage.parse_transcript_footer(FOOTER_A),
            {
                "total_input": 1800000,
                "input_cache_read": 1700000,
                "input_cache_creation": 70300,
                "output": 6300,
                "reasoning": 1000,
                "ai_credits": 58.8,
            },
        )

    def test_parses_footer_without_written_segment(self):
        footer = copilot_usage.parse_transcript_footer(FOOTER_B)

        self.assertEqual(footer["input_cache_read"], 409200)
        self.assertEqual(footer["input_cache_creation"], 0)
        self.assertEqual(footer["reasoning"], 976)

    def test_returns_none_without_a_footer(self):
        self.assertIsNone(copilot_usage.parse_transcript_footer("nothing to see"))

    def test_falls_back_when_store_has_no_rows(self):
        with tempfile.TemporaryDirectory() as home:
            make_store(home, [])
            first = Path(home) / "attempt1.log"
            second = Path(home) / "attempt2.log"
            first.write_text(FOOTER_A, encoding="utf-8")
            second.write_text(FOOTER_B, encoding="utf-8")

            usage = copilot_usage.extract_usage([first, second], home=home)

        self.assertEqual(usage["source"], "transcript-summary")
        self.assertTrue(usage["approximate"])
        self.assertEqual(usage["usage_records"], 2)
        self.assertEqual(usage["total_input"], 1800000 + 449800)
        self.assertEqual(usage["input_cache_read"], 1700000 + 409200)
        self.assertEqual(usage["output"], 6300 + 2200)
        self.assertAlmostEqual(usage["ai_credits"], 71.3)

    def test_repeated_footers_for_one_session_count_once(self):
        with tempfile.TemporaryDirectory() as home:
            make_store(home, [])
            first = Path(home) / "attempt1.log"
            second = Path(home) / "attempt2.log"
            first.write_text(FOOTER_A, encoding="utf-8")
            second.write_text(FOOTER_A, encoding="utf-8")

            usage = copilot_usage.extract_usage([first, second], home=home)

        self.assertEqual(usage["usage_records"], 1)
        self.assertEqual(usage["total_input"], 1800000)

    def test_missing_usage_everywhere_raises(self):
        with tempfile.TemporaryDirectory() as home:
            make_store(home, [])
            transcript = Path(home) / "attempt.log"
            transcript.write_text("agent ran but printed no summary", encoding="utf-8")

            with self.assertRaises(copilot_usage.UsageNotFoundError):
                copilot_usage.extract_usage([transcript], home=home)


class CostTest(unittest.TestCase):
    def setUp(self):
        self._previous = os.environ.pop("COPILOT_USD_PER_CREDIT", None)
        self.addCleanup(self._restore)

    def _restore(self):
        os.environ.pop("COPILOT_USD_PER_CREDIT", None)
        if self._previous is not None:
            os.environ["COPILOT_USD_PER_CREDIT"] = self._previous

    def _usage(self):
        with tempfile.TemporaryDirectory() as home:
            make_store(home, [(SESSION_A, "gpt-5-mini", 10, 1, 0, 0, 0, 4_000_000_000, 0)])
            return copilot_usage.extract_usage([], home=home, session_ids=[SESSION_A])

    def test_cost_is_omitted_by_default(self):
        self.assertNotIn("cost_usd", self._usage())

    def test_cost_is_derived_from_configured_rate(self):
        os.environ["COPILOT_USD_PER_CREDIT"] = "0.04"

        usage = self._usage()

        self.assertEqual(usage["ai_credits"], 4.0)
        self.assertEqual(usage["cost_usd"], 0.16)

    def test_invalid_rate_is_ignored(self):
        os.environ["COPILOT_USD_PER_CREDIT"] = "not-a-number"
        self.assertNotIn("cost_usd", self._usage())

        os.environ["COPILOT_USD_PER_CREDIT"] = "0"
        self.assertNotIn("cost_usd", self._usage())


class CliTest(unittest.TestCase):
    def test_writes_usage_file_and_exits_zero(self):
        with tempfile.TemporaryDirectory() as home:
            make_store(home, [(SESSION_A, "gpt-5-mini", 30, 5, 10, 5, 1, 1_000_000_000, 9)])
            output = Path(home) / "outputs" / "story_development_usage.json"

            exit_code = copilot_usage.main(
                ["--home", home, "--session-id", SESSION_A, "--output", str(output)]
            )

            self.assertEqual(exit_code, 0)
            written = json.loads(output.read_text(encoding="utf-8"))

        self.assertEqual(written["total_tokens"], 35)
        self.assertEqual(written["provider"], "copilot")

    def test_exits_two_when_no_usage_is_available(self):
        with tempfile.TemporaryDirectory() as home:
            make_store(home, [])
            transcript = Path(home) / "attempt.log"
            transcript.write_text("no summary", encoding="utf-8")
            output = Path(home) / "outputs" / "story_development_usage.json"

            exit_code = copilot_usage.main(
                ["--home", home, "--transcript", str(transcript), "--output", str(output)]
            )

            self.assertEqual(exit_code, 2)
            self.assertFalse(output.exists())

    def test_baseline_mode_needs_no_output(self):
        with tempfile.TemporaryDirectory() as home:
            make_store(home, [(SESSION_A, "gpt-5-mini", 1, 1, 0, 0, 0, 0, 0)])

            self.assertEqual(copilot_usage.main(["--home", home, "--baseline"]), 0)


if __name__ == "__main__":
    unittest.main()
