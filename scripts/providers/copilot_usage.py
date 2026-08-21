#!/usr/bin/env python3
"""Extract normalized token usage for a GitHub Copilot CLI run.

Two sources are supported, in order of preference:

1. ``$COPILOT_HOME/session-store.db`` — the Copilot CLI session store. Its
   ``assistant_usage_events`` table holds one exact row per model request
   (tokens plus billed nano AIU), which is the only lossless source.
2. The transcript footer printed by the CLI (``Tokens  ↑ 1.8m (1.7m cached,
   70.3k written) • ↓ 6.3k (1.0k reasoning)`` / ``AI Credits 58.8``). Those
   numbers are rounded to three significant digits, so results derived from
   them are flagged ``approximate``.

The output matches the provider-neutral schema consumed by the Jira token
usage comment helper (js/common/tokenUsageComment.js).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterable

STORE_FILE_NAME = "session-store.db"
NANO_AIU_PER_CREDIT = 1_000_000_000

# "Resume     copilot --resume=5970236a-c0cb-46b0-85da-db6898163d11"
_RESUME_PATTERN = re.compile(
    r"--resume[=\s]+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"
)
_NUMBER = r"[0-9][0-9.,]*\s*[kmb]?"
_TOKENS_PATTERN = re.compile(
    r"Tokens\s+[\u2191^]\s*(" + _NUMBER + r")\s*(\([^)]*\))?"
    r"(?:[^\u2193]*[\u2193v]\s*(" + _NUMBER + r")\s*(\([^)]*\))?)?",
    re.IGNORECASE,
)
_CACHED_PATTERN = re.compile(r"(" + _NUMBER + r")\s*cached", re.IGNORECASE)
_WRITTEN_PATTERN = re.compile(r"(" + _NUMBER + r")\s*written", re.IGNORECASE)
_REASONING_PATTERN = re.compile(r"(" + _NUMBER + r")\s*reasoning", re.IGNORECASE)
_CREDITS_PATTERN = re.compile(r"AI\s+Credits\s+([0-9][0-9.,]*\s*[kmb]?)", re.IGNORECASE)


class UsageNotFoundError(ValueError):
    """Raised when neither the session store nor a transcript yields usage."""


def _number(value: Any) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return value


def parse_scaled_number(raw: str | None) -> int:
    """Parse Copilot's abbreviated counters ("1.8m", "70.3k", "976")."""
    if not raw:
        return 0
    text = str(raw).strip().lower().replace(",", "").replace(" ", "")
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)([kmb])?", text)
    if not match:
        return 0
    value = float(match.group(1))
    value *= {"": 1, "k": 1_000, "m": 1_000_000, "b": 1_000_000_000}[match.group(2) or ""]
    return int(round(value))


def parse_float(raw: str | None) -> float:
    if not raw:
        return 0.0
    text = str(raw).strip().lower().replace(",", "").replace(" ", "")
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)([kmb])?", text)
    if not match:
        return 0.0
    value = float(match.group(1))
    return value * {"": 1, "k": 1_000, "m": 1_000_000, "b": 1_000_000_000}[match.group(2) or ""]


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def find_session_ids(texts: Iterable[str]) -> list[str]:
    """Collect Copilot session ids from transcripts, preserving first-seen order."""
    ordered: list[str] = []
    for text in texts:
        for match in _RESUME_PATTERN.finditer(text or ""):
            session_id = match.group(1).lower()
            if session_id not in ordered:
                ordered.append(session_id)
    return ordered


def resolve_store_path(home: str | None = None) -> Path | None:
    """Locate the Copilot session store.

    An explicit ``home`` is authoritative; otherwise fall back to
    ``$COPILOT_HOME`` and then the default ``~/.copilot`` used by local runs.
    """
    if home:
        candidates = [Path(home)]
    else:
        candidates = []
        env_home = os.environ.get("COPILOT_HOME")
        if env_home:
            candidates.append(Path(env_home))
        candidates.append(Path.home() / ".copilot")

    for candidate in candidates:
        store = candidate if candidate.name == STORE_FILE_NAME else candidate / STORE_FILE_NAME
        if store.is_file():
            return store
    return None


def _connect_readonly(store: Path) -> tuple[sqlite3.Connection, str | None]:
    """Open the store without mutating it.

    A live WAL sidecar cannot always be replayed through a read-only handle, so
    fall back to reading a private copy of the database and its sidecars. If
    the copy or the connection to it fails partway through, the temp directory
    is removed before the error propagates so failed attempts (e.g. permission
    errors, a torn copy of a database being actively written) don't leak
    directories on disk.
    """
    try:
        connection = sqlite3.connect(f"file:{store}?mode=ro", uri=True)
        connection.execute("SELECT 1 FROM assistant_usage_events LIMIT 1").fetchall()
        return connection, None
    except sqlite3.Error:
        pass

    temp_dir = tempfile.mkdtemp(prefix="copilot-usage-")
    try:
        copy = Path(temp_dir) / store.name
        shutil.copyfile(store, copy)
        for suffix in ("-wal", "-shm"):
            sidecar = Path(str(store) + suffix)
            if sidecar.exists():
                shutil.copyfile(sidecar, Path(str(copy) + suffix))
        return sqlite3.connect(f"file:{copy}?mode=ro", uri=True), temp_dir
    except Exception:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise


def max_usage_event_id(home: str | None = None) -> int:
    """Return the highest usage row id currently in the store, or 0."""
    store = resolve_store_path(home)
    if store is None:
        return 0
    connection = None
    temp_dir = None
    try:
        connection, temp_dir = _connect_readonly(store)
        row = connection.execute("SELECT MAX(id) FROM assistant_usage_events").fetchone()
    except (sqlite3.Error, OSError):
        return 0
    finally:
        if connection is not None:
            connection.close()
        if temp_dir:
            shutil.rmtree(temp_dir, ignore_errors=True)
    return int(row[0]) if row and row[0] is not None else 0


def read_store_rows(
    session_ids: list[str],
    home: str | None = None,
    since_id: int = 0,
) -> list[dict[str, Any]]:
    """Read usage rows written after since_id.

    Rows are scoped to session_ids when any were resolved. If none were (the
    CLI can crash or time out before printing its `--resume=<uuid>` line, or
    an older CLI without `--session-id` support may pick its own random
    session id that we never observe), fall back to every row newer than
    since_id so the run's exact usage still gets reported instead of silently
    dropping to nothing. That fallback only fires when since_id is a real,
    non-zero baseline — with since_id == 0 it would return the store's entire
    history rather than just this run's rows.
    """
    store = resolve_store_path(home)
    if store is None:
        return []

    if session_ids:
        placeholders = ",".join("?" for _ in session_ids)
        query = (
            "SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, "
            "reasoning_tokens, total_nano_aiu, duration_ms FROM assistant_usage_events "
            f"WHERE lower(session_id) IN ({placeholders}) AND id > ?"
        )
        params: tuple[Any, ...] = (*session_ids, since_id)
    elif since_id > 0:
        query = (
            "SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, "
            "reasoning_tokens, total_nano_aiu, duration_ms FROM assistant_usage_events "
            "WHERE id > ?"
        )
        params = (since_id,)
    else:
        return []

    connection = None
    temp_dir = None
    try:
        connection, temp_dir = _connect_readonly(store)
        connection.row_factory = sqlite3.Row
        rows = connection.execute(query, params).fetchall()
    except (sqlite3.Error, OSError):
        return []
    finally:
        if connection is not None:
            connection.close()
        if temp_dir:
            shutil.rmtree(temp_dir, ignore_errors=True)

    return [dict(row) for row in rows]


def normalize_store_rows(rows: list[dict[str, Any]], scoped: bool = True) -> dict[str, Any]:
    """Aggregate raw session-store rows into the provider-neutral schema."""
    if not rows:
        raise UsageNotFoundError("no usage rows were found in the Copilot session store")

    models: set[str] = set()
    total_input = 0
    input_cache_read = 0
    input_cache_creation = 0
    output = 0
    reasoning = 0
    nano_aiu = 0
    duration_ms = 0

    for row in rows:
        model = row.get("model")
        if model:
            models.add(str(model))
        total_input += _number(row.get("input_tokens"))
        input_cache_read += _number(row.get("cache_read_tokens"))
        input_cache_creation += _number(row.get("cache_write_tokens"))
        output += _number(row.get("output_tokens"))
        reasoning += _number(row.get("reasoning_tokens"))
        nano_aiu += _number(row.get("total_nano_aiu"))
        duration_ms += _number(row.get("duration_ms"))

    # Copilot reports input_tokens as the grand total, cached segments included.
    input_other = max(0, total_input - input_cache_read - input_cache_creation)

    usage = build_usage(
        models=sorted(models),
        usage_records=len(rows),
        input_other=input_other,
        input_cache_read=input_cache_read,
        input_cache_creation=input_cache_creation,
        output=output,
        reasoning=reasoning,
        ai_credits=nano_aiu / NANO_AIU_PER_CREDIT,
        duration_ms=duration_ms,
        source="session-store",
    )
    if not scoped:
        # No session id could be resolved for this run; these rows are every
        # new row in the store rather than rows we could tie to a specific
        # Copilot session. Flag it so a concurrently-writing process sharing
        # the same COPILOT_HOME is visible in the output instead of silently
        # blended in.
        usage["scoped"] = False
    return usage


def parse_transcript_footer(text: str) -> dict[str, Any] | None:
    """Parse the last usage footer block printed in a transcript."""
    tokens_match = None
    for tokens_match in _TOKENS_PATTERN.finditer(text or ""):
        pass
    if tokens_match is None:
        return None

    input_total = parse_scaled_number(tokens_match.group(1))
    input_detail = tokens_match.group(2) or ""
    output_total = parse_scaled_number(tokens_match.group(3))
    output_detail = tokens_match.group(4) or ""

    cached = _CACHED_PATTERN.search(input_detail)
    written = _WRITTEN_PATTERN.search(input_detail)
    reasoning = _REASONING_PATTERN.search(output_detail)

    credits_match = None
    for credits_match in _CREDITS_PATTERN.finditer(text or ""):
        pass

    return {
        "total_input": input_total,
        "input_cache_read": parse_scaled_number(cached.group(1)) if cached else 0,
        "input_cache_creation": parse_scaled_number(written.group(1)) if written else 0,
        "output": output_total,
        "reasoning": parse_scaled_number(reasoning.group(1)) if reasoning else 0,
        "ai_credits": parse_float(credits_match.group(1)) if credits_match else 0.0,
    }


def normalize_transcript_footers(transcripts: list[tuple[str, str]]) -> dict[str, Any]:
    """Aggregate footers across attempts, keeping one footer per Copilot session.

    Retries that resume the same session print a cumulative footer, so only the
    last footer of each session is counted; independent sessions are summed.
    """
    per_session: dict[str, dict[str, Any]] = {}
    for name, text in transcripts:
        footer = parse_transcript_footer(text)
        if footer is None:
            continue
        session_ids = find_session_ids([text])
        per_session[session_ids[-1] if session_ids else f"transcript:{name}"] = footer

    if not per_session:
        raise UsageNotFoundError("no Copilot usage footer was found in the transcript(s)")

    total_input = 0
    input_cache_read = 0
    input_cache_creation = 0
    output = 0
    reasoning = 0
    ai_credits = 0.0
    for footer in per_session.values():
        total_input += footer["total_input"]
        input_cache_read += footer["input_cache_read"]
        input_cache_creation += footer["input_cache_creation"]
        output += footer["output"]
        reasoning += footer["reasoning"]
        ai_credits += footer["ai_credits"]

    input_other = max(0, total_input - input_cache_read - input_cache_creation)

    usage = build_usage(
        models=[],
        usage_records=len(per_session),
        input_other=input_other,
        input_cache_read=input_cache_read,
        input_cache_creation=input_cache_creation,
        output=output,
        reasoning=reasoning,
        ai_credits=ai_credits,
        duration_ms=0,
        source="transcript-summary",
    )
    usage["approximate"] = True
    return usage


def build_usage(
    *,
    models: list[str],
    usage_records: int,
    input_other: int,
    input_cache_read: int,
    input_cache_creation: int,
    output: int,
    reasoning: int,
    ai_credits: float,
    duration_ms: int,
    source: str,
) -> dict[str, Any]:
    total_input = input_other + input_cache_read + input_cache_creation
    usage: dict[str, Any] = {
        "provider": "copilot",
        "models": models,
        "usage_records": usage_records,
        "input_other": input_other,
        "input_cache_read": input_cache_read,
        "input_cache_creation": input_cache_creation,
        "output": output,
        "reasoning": reasoning,
        "total_input": total_input,
        "total_tokens": total_input + output,
        "ai_credits": round(ai_credits, 6),
        "duration_ms": duration_ms,
        "source": source,
    }
    cost_usd = usd_cost(usage["ai_credits"])
    if cost_usd is not None:
        usage["cost_usd"] = cost_usd
    return usage


def usd_cost(ai_credits: float) -> float | None:
    """Convert AI credits to USD when COPILOT_USD_PER_CREDIT is configured."""
    raw = os.environ.get("COPILOT_USD_PER_CREDIT", "").strip()
    if not raw:
        return None
    try:
        rate = float(raw)
    except ValueError:
        return None
    if rate <= 0:
        return None
    return round(ai_credits * rate, 6)


def extract_usage(
    transcript_paths: list[Path],
    home: str | None = None,
    since_id: int = 0,
    session_ids: list[str] | None = None,
) -> dict[str, Any]:
    transcripts = [(str(path), read_text(path)) for path in transcript_paths]

    resolved = list(session_ids or [])
    for session_id in find_session_ids(text for _, text in transcripts):
        if session_id not in resolved:
            resolved.append(session_id)
    resolved = [session_id.lower() for session_id in resolved if session_id]

    rows = read_store_rows(resolved, home=home, since_id=since_id)
    if rows:
        return normalize_store_rows(rows, scoped=bool(resolved))
    return normalize_transcript_footers(transcripts)


def write_usage(output_path: Path, usage: dict[str, Any]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as output:
        json.dump(usage, output, indent=2)
        output.write("\n")


def print_usage_summary(usage: dict[str, Any], output_path: Path) -> None:
    print("=== Copilot Token Usage Summary ===")
    print(f"  Model(s):               {', '.join(usage['models']) or 'unknown'}")
    print(f"  Usage records:          {usage['usage_records']:,}")
    print(f"  Input (other):          {usage['input_other']:,}")
    print(f"  Input (cache read):     {usage['input_cache_read']:,}")
    print(f"  Input (cache creation): {usage['input_cache_creation']:,}")
    print(f"  Output:                 {usage['output']:,}")
    print(f"  Output (reasoning):     {usage['reasoning']:,}")
    print(f"  Total input:            {usage['total_input']:,}")
    print(f"  Total tokens:           {usage['total_tokens']:,}")
    print(f"  AI credits:             {usage['ai_credits']}")
    if "cost_usd" in usage:
        print(f"  Cost (USD):             {usage['cost_usd']}")
    print(f"  Source:                 {usage['source']}")
    if usage.get("approximate"):
        print("  Note:                   values are rounded by the Copilot CLI summary")
    if usage.get("scoped") is False:
        print("  Note:                   no session id was resolved; totals cover every new")
        print("                          store row since baseline, not just this run's session")
    print(f"  Written to:             {output_path}")
    print("===================================")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--transcript", type=Path, action="append", default=[])
    parser.add_argument("--output", type=Path)
    parser.add_argument("--home", default=None)
    parser.add_argument("--session-id", action="append", default=[])
    parser.add_argument("--since-id", type=int, default=0)
    parser.add_argument(
        "--baseline",
        action="store_true",
        help="print the current highest usage row id and exit",
    )
    args = parser.parse_args(argv)

    if args.baseline:
        print(max_usage_event_id(args.home))
        return 0

    if args.output is None:
        parser.error("--output is required unless --baseline is used")

    try:
        usage = extract_usage(
            args.transcript,
            home=args.home,
            since_id=args.since_id,
            session_ids=args.session_id,
        )
    except (OSError, UsageNotFoundError) as error:
        print(f"Copilot token usage unavailable: {error}", file=sys.stderr)
        return 2

    write_usage(args.output, usage)
    print_usage_summary(usage, args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
