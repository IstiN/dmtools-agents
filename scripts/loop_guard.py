#!/usr/bin/env python3
"""
Loop-guard watcher for CLI coding-agent transcripts (Copilot CLI, Claude Code,
Cursor, etc. — anything that logs tool calls in the "bullet block" format
these CLIs use).

Why this exists
----------------
Real-world CI runs have observed a coding-agent CLI get stuck issuing the
SAME tool call over and over — e.g. hundreds of identical `grep` calls
returning "No matches found", or hundreds of identical shell calls
re-running the same command. The model can even self-label each repeat with
an incrementing ordinal ("again", "third time", ...) — aware it kept
repeating, but never breaking out on its own. Left unchecked, the job just
burns CI minutes until someone notices the log and cancels it by hand (CI
job timeouts are typically hours, not minutes).

What this script does
----------------------
Polls a live transcript log file, parses it into an ordered list of tool-call
"signatures" (tool type + normalized command/args — deliberately NOT
including the bullet's free-text label, since that's exactly the part the
model varies on every repeat with its ordinal counting), and checks whether
the same signature appears >= --threshold times *consecutively* at the tail
of the transcript. If so, it sends SIGTERM to the given pid (graceful, so a
resumable CLI session/state is preserved) and writes a small JSON marker
describing what was detected, for the caller to react to (see
run_copilot_once_guarded() in scripts/providers/copilot.sh, which retries on
the SAME model/session rather than switching models — a stuck model is not
assumed to be a bad model, just a model that needs an explicit nudge that
it's repeating itself).

This script has no dependency on any particular CLI's internals — only on
the common "bullet block" transcript rendering shape:

    ● <free text label, e.g. an ordinal-numbered description> (<tool-type>)
      │ <detail line 1>
      │ <detail line 2>
      └ <result summary>

(the leading glyph is "●" for a completed/rendered call or "/" for one still
in flight when the log was captured mid-stream; both are treated the same).
"""
import argparse
import json
import os
import re
import signal
import sys
import time

HEADER_GLYPHS = ("\u25cf", "/")  # "●" (completed) or "/" (in-flight snapshot)
DETAIL_RE = re.compile(r"^\s*\u2502\s?(?P<content>.*)$")  # "│ ..."
FOOTER_RE = re.compile(r"^\s*\u2514\s?(?P<summary>.*)$")  # "└ ..."
TRAILING_TYPE_RE = re.compile(r"\(([a-zA-Z][a-zA-Z0-9_-]*)\)\s*$")


def parse_blocks(text):
    """Parse a transcript into an ordered list of (tool_type, signature) tuples.

    `tool_type` is the parenthesized word at the end of the bullet's header
    line (e.g. "shell", "grep"), or "unknown" if there wasn't one. `signature`
    is the normalized, whitespace-collapsed concatenation of the block's
    "│ ..." detail lines — this is what actually distinguishes one tool call
    from another; the header's free-text label is intentionally ignored.
    """
    blocks = []
    lines = text.splitlines()
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        stripped = line.lstrip()
        if stripped[:1] in HEADER_GLYPHS:
            label = stripped[1:].strip()
            type_match = TRAILING_TYPE_RE.search(label)
            tool_type = type_match.group(1) if type_match else "unknown"
            details = []
            i += 1
            while i < n:
                detail_match = DETAIL_RE.match(lines[i])
                if detail_match:
                    details.append(detail_match.group("content").strip())
                    i += 1
                    continue
                footer_match = FOOTER_RE.match(lines[i])
                if footer_match:
                    i += 1
                break
            signature = re.sub(r"\s+", " ", " ".join(details)).strip()
            blocks.append((tool_type, signature))
            continue
        i += 1
    return blocks


def trailing_repeat(blocks, ignore_types=frozenset()):
    """Return (repeat_count, (tool_type, signature)) for the run of identical
    signatures at the END of `blocks`, skipping any block whose tool_type is
    in `ignore_types` (e.g. a "wait"/"read-output" style call that's expected
    to repeat harmlessly while a long-running shell command is polled).
    Blocks with an EMPTY signature are never counted as a repeat (nothing
    meaningful to compare — most commonly a parse artifact, not a real call).
    """
    filtered = [b for b in blocks if b[0] not in ignore_types and b[1]]
    if not filtered:
        return 0, None
    last = filtered[-1]
    count = 0
    for b in reversed(filtered):
        if b == last:
            count += 1
        else:
            break
    return count, last


def _pid_alive(pid):
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _kill_process_group(pid, sig):
    """Best-effort: signal the whole process group led by `pid` if possible
    (so a shell pipeline's children die too), falling back to just `pid`.
    """
    try:
        os.killpg(os.getpgid(pid), sig)
        return
    except (OSError, ProcessLookupError):
        pass
    try:
        os.kill(pid, sig)
    except OSError:
        pass


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log-file", required=True, help="transcript file to poll")
    parser.add_argument("--pid", required=True, type=int, help="process (group) to terminate on detection")
    parser.add_argument("--marker-file", required=True, help="path to write a JSON detection marker to")
    parser.add_argument("--threshold", type=int, default=int(os.environ.get("COPILOT_LOOP_GUARD_THRESHOLD", "5")))
    parser.add_argument("--poll-interval", type=float, default=float(os.environ.get("COPILOT_LOOP_GUARD_POLL_SECONDS", "20")))
    parser.add_argument(
        "--ignore-types",
        default=os.environ.get("COPILOT_LOOP_GUARD_IGNORE_TYPES", ""),
        help="comma-separated tool types excluded from repeat detection (e.g. types that legitimately poll)",
    )
    args = parser.parse_args(argv)

    ignore_types = frozenset(t.strip() for t in args.ignore_types.split(",") if t.strip())

    while _pid_alive(args.pid):
        time.sleep(args.poll_interval)
        if not _pid_alive(args.pid):
            break
        if not os.path.exists(args.log_file):
            continue
        try:
            with open(args.log_file, "r", errors="replace") as handle:
                text = handle.read()
        except OSError:
            continue

        blocks = parse_blocks(text)
        count, signature = trailing_repeat(blocks, ignore_types=ignore_types)
        if signature is not None and count >= args.threshold:
            tool_type, normalized = signature
            detail = {
                "detected_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "pid": args.pid,
                "repeat_count": count,
                "threshold": args.threshold,
                "tool_type": tool_type,
                "command": normalized[:2000],
            }
            try:
                with open(args.marker_file, "w", encoding="utf-8") as marker:
                    json.dump(detail, marker, indent=2)
            except OSError:
                pass
            _kill_process_group(args.pid, signal.SIGTERM)
            return 0

    return 0


if __name__ == "__main__":
    sys.exit(main())
