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
repeating, but never breaking out on its own. A subtler variant has also
been observed: the model embeds a fresh throwaway word *inside* the command
text itself on every repeat (not just the free-text label), which defeats
naive exact-match detection since every repeat's signature is technically
unique. Left unchecked, the job just burns CI minutes until someone notices
the log and cancels it by hand (CI job timeouts are typically hours, not
minutes).

What this script does
----------------------
Polls a live transcript log file, parses it into an ordered list of tool-call
"signatures" (tool type + normalized command/args — deliberately NOT
including the bullet's free-text label, since that's exactly the part the
model varies on every repeat with its ordinal counting), and checks two
things at the tail of the transcript:

1. trailing_repeat(): does the exact same signature appear >= --threshold
   times consecutively? (the classic case — byte-identical repeated calls)
2. trailing_near_repeat(): do the last >= --near-threshold calls share the
   same tool_type and token count, differing from the newest one by only a
   handful of whitespace-split tokens? (catches a model that embeds a new
   throwaway word *inside* the command on every repeat specifically to dodge
   check 1 — near-threshold is deliberately much higher than --threshold to
   avoid flagging legitimate repetitive-looking exploration such as reading
   several different files with the same templated command)

If either check fires, it sends SIGTERM to the given pid (graceful, so a
resumable CLI session/state is preserved) and writes a small JSON marker
describing what was detected (including which check fired, via
`detection_kind`), for the caller to react to (see
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


def _tokenize(signature):
    return signature.split()


def trailing_near_repeat(blocks, ignore_types=frozenset(), max_diff_tokens=3, max_diff_ratio=0.15):
    """Return (repeat_count, (tool_type, signature)) for a run of NEAR-identical
    signatures at the END of `blocks` — same tool_type, same token count, and
    differing from the newest one in at most `max(max_diff_tokens,
    round(max_diff_ratio * token_count))` whitespace-split tokens.

    This exists because trailing_repeat() (exact match) can be evaded: a model
    stuck in a loop can embed a *different* word inside the command text
    itself on every repeat (not just in the free-text label, which is already
    stripped before signature comparison) — e.g. re-running the same `git
    diff ... | python3 -c "...print('...HEXAGON...', 'hexagon')"` over and
    over with a new noun substituted in each time. The command is otherwise
    byte-identical and accomplishes nothing new, but trailing_repeat() sees a
    different signature every time and never fires.

    Deliberately conservative (small token-diff budget) to avoid flagging
    legitimate exploration, e.g. reading several different files with the same
    templated command — those differ in a whole path token but are usually
    interleaved with genuinely different follow-up actions, and callers should
    pair this with a much larger --near-threshold than the exact-match
    --threshold so only truly excessive repetition trips it.
    """
    filtered = [b for b in blocks if b[0] not in ignore_types and b[1]]
    if not filtered:
        return 0, None
    last = filtered[-1]
    last_tokens = _tokenize(last[1])
    if not last_tokens:
        return 0, None
    allowed_diff = max(max_diff_tokens, round(max_diff_ratio * len(last_tokens)))
    count = 0
    for b in reversed(filtered):
        if b[0] != last[0]:
            break
        tokens = _tokenize(b[1])
        if len(tokens) != len(last_tokens):
            break
        diff = sum(1 for x, y in zip(tokens, last_tokens) if x != y)
        if diff > allowed_diff:
            break
        count += 1
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
    parser.add_argument(
        "--near-threshold",
        type=int,
        default=int(os.environ.get("COPILOT_LOOP_GUARD_NEAR_THRESHOLD", "15")),
        help=(
            "consecutive NEAR-identical (not necessarily byte-identical) calls required to trigger "
            "trailing_near_repeat(); deliberately higher than --threshold since this check is fuzzier "
            "and more prone to false positives on legitimate repetitive-looking exploration"
        ),
    )
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
        detection_kind = "exact_duplicate"
        detection_threshold = args.threshold
        if not (signature is not None and count >= args.threshold):
            # Fall back to the fuzzy check: same tool_type/token-count, only a
            # couple of tokens differing (e.g. a model varying one embedded
            # word per repeat to dodge the exact-match check above).
            count, signature = trailing_near_repeat(blocks, ignore_types=ignore_types)
            detection_kind = "near_duplicate"
            detection_threshold = args.near_threshold
        if signature is not None and count >= detection_threshold:
            tool_type, normalized = signature
            detail = {
                "detected_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "pid": args.pid,
                "repeat_count": count,
                "threshold": detection_threshold,
                "detection_kind": detection_kind,
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
