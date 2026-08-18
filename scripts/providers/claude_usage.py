#!/usr/bin/env python3
"""Extract normalized token usage from a Claude Code stream-JSON transcript."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


class UsageNotFoundError(ValueError):
    """Raised when a transcript has no aggregate Claude usage result."""


def _number(value: Any) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return value


def find_last_usage_result(lines: list[str]) -> dict[str, Any]:
    """Return the last result event that contains a non-empty modelUsage map."""
    result: dict[str, Any] | None = None
    for line in lines:
        try:
            candidate = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(candidate, dict) or candidate.get("type") != "result":
            continue
        model_usage = candidate.get("modelUsage")
        if isinstance(model_usage, dict) and model_usage:
            result = candidate

    if result is None:
        raise UsageNotFoundError("no result event with modelUsage was found")
    return result


def normalize_usage(result: dict[str, Any]) -> dict[str, Any]:
    """Normalize Claude's per-model aggregate into the provider-neutral schema."""
    model_usage = result["modelUsage"]
    models = sorted(str(model) for model in model_usage)

    input_other = 0
    input_cache_read = 0
    input_cache_creation = 0
    output = 0
    model_cost = 0

    for usage in model_usage.values():
        if not isinstance(usage, dict):
            continue
        input_other += _number(usage.get("inputTokens"))
        input_cache_read += _number(usage.get("cacheReadInputTokens"))
        input_cache_creation += _number(usage.get("cacheCreationInputTokens"))
        output += _number(usage.get("outputTokens"))
        model_cost += _number(usage.get("costUSD"))

    total_input = input_other + input_cache_read + input_cache_creation
    total_tokens = total_input + output
    reported_cost = result.get("total_cost_usd")
    cost_usd = _number(reported_cost) if isinstance(reported_cost, (int, float)) else model_cost

    return {
        "provider": "claude-code",
        "models": models,
        "input_other": input_other,
        "input_cache_read": input_cache_read,
        "input_cache_creation": input_cache_creation,
        "output": output,
        "total_input": total_input,
        "total_tokens": total_tokens,
        "cost_usd": cost_usd,
    }


def extract_usage(transcript_path: Path) -> dict[str, Any]:
    with transcript_path.open("r", encoding="utf-8") as transcript:
        return normalize_usage(find_last_usage_result(list(transcript)))


def write_usage(output_path: Path, usage: dict[str, Any]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as output:
        json.dump(usage, output, indent=2)
        output.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("transcript", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    try:
        usage = extract_usage(args.transcript)
    except (OSError, UsageNotFoundError) as error:
        print(f"Claude token usage unavailable: {error}", file=sys.stderr)
        return 2

    write_usage(args.output, usage)
    print("=== Claude Code Token Usage Summary ===")
    print(f"  Model(s): {', '.join(usage['models'])}")
    print(f"  Input (other):          {usage['input_other']:,}")
    print(f"  Input (cache read):     {usage['input_cache_read']:,}")
    print(f"  Input (cache creation): {usage['input_cache_creation']:,}")
    print(f"  Output:                 {usage['output']:,}")
    print(f"  Total input:            {usage['total_input']:,}")
    print(f"  Total tokens:           {usage['total_tokens']:,}")
    print(f"  Cost (USD):             {usage['cost_usd']}")
    print(f"  Written to:             {args.output}")
    print("=======================================")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
