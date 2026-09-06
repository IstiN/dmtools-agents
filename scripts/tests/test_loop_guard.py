#!/usr/bin/env python3
"""Unit tests for scripts/loop_guard.py.

These tests use only synthetic/generic transcript fragments — no
project-specific paths, ticket references, or company code — per this
repo's public-content policy.
"""
import os
import sys
import unittest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
SCRIPTS_DIR = os.path.dirname(TESTS_DIR)
sys.path.insert(0, SCRIPTS_DIR)

import loop_guard  # noqa: E402


class ParseBlocksTests(unittest.TestCase):
    def test_parses_shell_block_signature_ignoring_label(self):
        text = (
            "● Check something interesting (shell)\n"
            "  │ echo hello\n"
            "  └ 1 line\n"
        )
        blocks = loop_guard.parse_blocks(text)
        self.assertEqual(blocks, [("shell", "echo hello")])

    def test_different_ordinal_labels_do_not_affect_signature(self):
        text = (
            "● Retry the command again (shell)\n"
            "  │ echo hello\n"
            "  └ 1 line\n"
            "● Retry the command a third time (shell)\n"
            "  │ echo hello\n"
            "  └ 1 line\n"
        )
        blocks = loop_guard.parse_blocks(text)
        self.assertEqual(blocks, [("shell", "echo hello"), ("shell", "echo hello")])

    def test_in_flight_slash_glyph_parsed_same_as_completed_bullet(self):
        text = "/ Running something (shell)\n  │ echo hello\n"
        blocks = loop_guard.parse_blocks(text)
        self.assertEqual(blocks, [("shell", "echo hello")])

    def test_multiline_detail_is_joined_and_whitespace_collapsed(self):
        text = (
            "● Read something (read)\n"
            "  │ some/wrapped/path/that/spans/two/rendered\n"
            "  │ /lines/because/it/is/long.java\n"
            "  └ 33 lines read\n"
        )
        blocks = loop_guard.parse_blocks(text)
        self.assertEqual(len(blocks), 1)
        self.assertEqual(
            blocks[0][1],
            "some/wrapped/path/that/spans/two/rendered /lines/because/it/is/long.java",
        )

    def test_block_without_parenthesized_type_is_unknown(self):
        text = "● Do something with no type suffix\n  │ echo hello\n"
        blocks = loop_guard.parse_blocks(text)
        self.assertEqual(blocks, [("unknown", "echo hello")])


class TrailingRepeatTests(unittest.TestCase):
    def test_no_blocks_returns_zero(self):
        count, sig = loop_guard.trailing_repeat([])
        self.assertEqual(count, 0)
        self.assertIsNone(sig)

    def test_counts_consecutive_trailing_repeats_only(self):
        blocks = [("shell", "cmd A"), ("shell", "cmd B"), ("shell", "cmd B"), ("shell", "cmd B")]
        count, sig = loop_guard.trailing_repeat(blocks)
        self.assertEqual(count, 3)
        self.assertEqual(sig, ("shell", "cmd B"))

    def test_a_different_block_in_between_resets_the_run(self):
        blocks = [("shell", "cmd B"), ("shell", "cmd B"), ("shell", "cmd C"), ("shell", "cmd B")]
        count, sig = loop_guard.trailing_repeat(blocks)
        self.assertEqual(count, 1)
        self.assertEqual(sig, ("shell", "cmd B"))

    def test_empty_signature_blocks_never_count_as_a_repeat(self):
        blocks = [("unknown", ""), ("unknown", "")]
        count, sig = loop_guard.trailing_repeat(blocks)
        self.assertEqual(count, 0)
        self.assertIsNone(sig)

    def test_ignore_types_excludes_matching_blocks_from_consideration(self):
        blocks = [
            ("shell", "cmd B"),
            ("wait", "polling long-running command"),
            ("wait", "polling long-running command"),
            ("shell", "cmd B"),
        ]
        # Without ignoring "wait", the trailing run would be broken by the
        # "shell"/"cmd B" at position -1 alone (count=1) since "wait" blocks
        # sit at the tail... but filtering "wait" out first should reveal the
        # true consecutive "cmd B" "shell" run underneath.
        count, sig = loop_guard.trailing_repeat(blocks, ignore_types=frozenset({"wait"}))
        self.assertEqual(count, 2)
        self.assertEqual(sig, ("shell", "cmd B"))


class TrailingNearRepeatTests(unittest.TestCase):
    def test_identical_signatures_also_count_as_near_repeats(self):
        blocks = [("shell", "cmd B"), ("shell", "cmd B"), ("shell", "cmd B")]
        count, sig = loop_guard.trailing_near_repeat(blocks)
        self.assertEqual(count, 3)
        self.assertEqual(sig, ("shell", "cmd B"))

    def test_single_varying_token_still_counts_as_a_near_repeat(self):
        # Some coding-agent CLIs have been observed embedding a different
        # throwaway word inside the command text on every repeat (not just
        # the free-text label already stripped from the signature) as a way
        # to dodge exact-match detection. trailing_repeat() would see 4
        # distinct signatures and never fire; trailing_near_repeat() must
        # still catch this.
        blocks = [
            ("shell", "git diff -- Foo.java | python3 -c \"print('hexagon')\""),
            ("shell", "git diff -- Foo.java | python3 -c \"print('octagon')\""),
            ("shell", "git diff -- Foo.java | python3 -c \"print('sphere')\""),
            ("shell", "git diff -- Foo.java | python3 -c \"print('cube')\""),
        ]
        exact_count, _ = loop_guard.trailing_repeat(blocks)
        self.assertEqual(exact_count, 1, "exact match must NOT see these as repeats")
        near_count, sig = loop_guard.trailing_near_repeat(blocks)
        self.assertEqual(near_count, 4)
        self.assertEqual(sig[0], "shell")

    def test_different_token_count_breaks_the_near_repeat_run(self):
        blocks = [
            ("shell", "git diff -- Foo.java | wc -l"),
            ("shell", "git diff -- Foo.java | wc -l"),
            ("shell", "git diff -- Foo.java --stat | wc -l"),  # extra token
        ]
        count, sig = loop_guard.trailing_near_repeat(blocks)
        self.assertEqual(count, 1)
        self.assertEqual(sig, ("shell", "git diff -- Foo.java --stat | wc -l"))

    def test_too_many_differing_tokens_breaks_the_run(self):
        # Legitimate exploration: reading several genuinely different files
        # with a templated command should NOT be treated as one giant repeat
        # once more than the small allowed token-diff budget is exceeded.
        blocks = [
            ("shell", "cat a.java | grep foo | head -20"),
            ("shell", "cat b.java | grep bar | head -50"),  # 3 tokens differ
        ]
        count, sig = loop_guard.trailing_near_repeat(blocks, max_diff_tokens=2)
        self.assertEqual(count, 1)

    def test_a_genuinely_different_tool_type_breaks_the_run(self):
        blocks = [
            ("shell", "git diff -- Foo.java | python3 -c \"print('hexagon')\""),
            ("grep", "git diff -- Foo.java | python3 -c \"print('octagon')\""),
        ]
        count, sig = loop_guard.trailing_near_repeat(blocks)
        self.assertEqual(count, 1)

    def test_empty_signature_returns_zero(self):
        count, sig = loop_guard.trailing_near_repeat([("unknown", "")])
        self.assertEqual(count, 0)
        self.assertIsNone(sig)

    def test_no_blocks_returns_zero(self):
        count, sig = loop_guard.trailing_near_repeat([])
        self.assertEqual(count, 0)
        self.assertIsNone(sig)


if __name__ == "__main__":
    unittest.main()
