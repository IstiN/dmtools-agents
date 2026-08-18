#!/usr/bin/env python3

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "claude_usage.py"
SPEC = importlib.util.spec_from_file_location("claude_usage", MODULE_PATH)
claude_usage = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(claude_usage)


def result_event(model_usage, total_cost=None):
    event = {"type": "result", "modelUsage": model_usage}
    if total_cost is not None:
        event["total_cost_usd"] = total_cost
    return json.dumps(event)


class ClaudeUsageTest(unittest.TestCase):
    def test_normalizes_single_model_usage(self):
        result = claude_usage.find_last_usage_result(
            [
                json.dumps({"type": "assistant", "usage": {"input_tokens": 7}}),
                result_event(
                    {
                        "example-model": {
                            "inputTokens": 13,
                            "outputTokens": 7,
                            "cacheReadInputTokens": 31,
                            "cacheCreationInputTokens": 5,
                            "costUSD": 0.12,
                        }
                    },
                    0.109,
                ),
            ]
        )

        self.assertEqual(
            claude_usage.normalize_usage(result),
            {
                "provider": "claude-code",
                "models": ["example-model"],
                "input_other": 13,
                "input_cache_read": 31,
                "input_cache_creation": 5,
                "output": 7,
                "total_input": 49,
                "total_tokens": 56,
                "cost_usd": 0.109,
            },
        )

    def test_aggregates_multiple_models_and_falls_back_to_model_cost(self):
        result = json.loads(
            result_event(
                {
                    "model-b": {
                        "inputTokens": 4,
                        "outputTokens": 2,
                        "cacheReadInputTokens": 6,
                        "costUSD": 0.2,
                    },
                    "model-a": {
                        "inputTokens": 3,
                        "outputTokens": 1,
                        "cacheCreationInputTokens": 5,
                        "costUSD": 0.1,
                    },
                }
            )
        )

        usage = claude_usage.normalize_usage(result)

        self.assertEqual(usage["models"], ["model-a", "model-b"])
        self.assertEqual(usage["input_other"], 7)
        self.assertEqual(usage["input_cache_read"], 6)
        self.assertEqual(usage["input_cache_creation"], 5)
        self.assertEqual(usage["output"], 3)
        self.assertEqual(usage["total_tokens"], 21)
        self.assertAlmostEqual(usage["cost_usd"], 0.3)

    def test_uses_last_valid_result_and_ignores_malformed_lines(self):
        first = result_event({"old-model": {"inputTokens": 1}})
        last = result_event({"new-model": {"inputTokens": 9}})

        result = claude_usage.find_last_usage_result(
            [first, "not-json", json.dumps({"type": "result"}), last]
        )

        self.assertIn("new-model", result["modelUsage"])

    def test_missing_optional_fields_default_to_zero(self):
        result = json.loads(result_event({"example-model": {}}))

        usage = claude_usage.normalize_usage(result)

        self.assertEqual(usage["total_tokens"], 0)
        self.assertEqual(usage["cost_usd"], 0)

    def test_no_usable_result_raises(self):
        with self.assertRaises(claude_usage.UsageNotFoundError):
            claude_usage.find_last_usage_result(
                ["bad-json", json.dumps({"type": "result", "modelUsage": {}})]
            )

    def test_extract_and_write_usage_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            transcript = root / "transcript.jsonl"
            output = root / "outputs" / "story_development_usage.json"
            transcript.write_text(
                result_event({"example-model": {"inputTokens": 2, "outputTokens": 3}})
                + "\n",
                encoding="utf-8",
            )

            claude_usage.write_usage(output, claude_usage.extract_usage(transcript))

            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["total_tokens"], 5)


if __name__ == "__main__":
    unittest.main()
