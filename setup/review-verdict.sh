#!/usr/bin/env bash
# review-verdict.sh — pure decision logic for the ai-teammate review loop
# (gh-71: cap auto-rework rounds + make approve-with-suggestions real).
#
# The workflow step (ai-teammate.yml → "Apply the review verdict")
# is a thin wrapper around this script: gh/network calls stay there, every
# decision lives here so it can be unit-tested (test/machine_kit/).
#
# Usage:
#   review-verdict.sh decide
#       Env inputs:
#         PR_REVIEW_JSON      outputs/pr_review.json from this review run
#         PR_REVIEW_JSON_ALT  ticket-scoped variant (outputs/gh-<n>/pr_review.json)
#         RUN_OUTPUT          dmtools run output (token-grep fallback)
#         ISSUE_LABELS        space-separated issue label names
#         MAX_ROUNDS          auto-rework cap (default 2)
#       Emits one `key=value` assignment per line (eval-safe):
#         decision=approve|rework|unknown
#         source=pr_review_json|run_output|none
#         override=true|false   REQUEST_CHANGES downgraded by zero blocking
#         blocking_markers=<int> inline comments that are blocking regardless
#                               of the issueCounts counter (override gate)
#         rounds_done=<int>     completed auto-rework rounds (from labels)
#         next_round=<int>      round this rework verdict would start
#         escalate=true|false   cap reached → needs-human instead of rework
#         round_labels=<%q>     the rework-round-* labels (quoted, may be empty)
#
#   review-verdict.sh threads <graphql-response.json>
#       Renders unresolved PR review threads (GitHub GraphQL
#       reviewThreads payload) as markdown bullets for the escalation
#       comment. Empty output = nothing unresolved / no PR.
#
# Verdict resolution order (gh-71):
#   1. pr_review.json `recommendation` (or `verdict`) — authoritative; a
#      REQUEST_CHANGES with zero BLOCKING findings is downgraded to approve
#      per the review protocol (only correctness/bug findings block;
#      allowApproveWithSuggestions=true on this machine).
#   2. Token-grep of the run output — legacy fallback when no JSON was
#      written; changes/BLOCK tokens win over approve tokens.
set -euo pipefail

# Normalizes a recommendation token (stdin → stdout): APPROVED → APPROVE,
# CHANGES_REQUESTED → REQUEST_CHANGES (GitHub's native review-state spelling
# — the token-grep fallback accepts it, so the JSON path must too),
# upper-cased, empty when absent.
normalize_recommendation() {
    tr '[:lower:]' '[:upper:]' < /dev/stdin \
        | sed -e 's/^APPROVED$/APPROVE/' \
              -e 's/^CHANGES_REQUESTED$/REQUEST_CHANGES/'
}

# Reads recommendation + blocking count from one pr_review.json candidate.
# Emits "<rec>|<blocking>" or nothing when unreadable/unparseable.
read_review_json() {
    local file="$1"
    [ -n "$file" ] && [ -r "$file" ] || return 0
    local rec blocking
    rec="$(jq -r '((.recommendation // .verdict) // "")' "$file" 2>/dev/null \
        | normalize_recommendation || true)"
    [ -n "$rec" ] || return 0
    blocking="$(jq -r '.issueCounts.blocking // 0' "$file" 2>/dev/null || echo 0)"
    printf '%s|%s\n' "$rec" "$blocking"
}

# Self-consistency guard for the blocking-0 override (gh-71 review): the
# issueCounts counter is written by the same reviewer that produced the
# verdict, so a misclassified finding must not convert an explicit
# REQUEST_CHANGES into an approval. Counts inline comments that are
# blocking regardless of the counter:
#   1. a `severity` field of "BLOCKING" (the protocol's structured marker), or
#   2. a referenced comment file carrying the 🚨 marker (the protocol's
#      every-BLOCKING-comment prefix) — catches a mislabeled severity.
# Comment paths resolve repo-root-relative first (the schema's
# "outputs/pr_review_comments/…" form), then relative to the JSON's dir.
inline_blocking_markers() {
    local file="$1"
    [ -n "$file" ] && [ -r "$file" ] || { echo 0; return 0; }
    local markers
    markers="$(jq -r '
        [(.inlineComments // [])[]
        | select((.severity // "") | ascii_upcase == "BLOCKING")]
        | length' "$file" 2>/dev/null || echo 0)"
    [ "${markers:-0}" -gt 0 ] 2>/dev/null || markers=0
    local base hits=0 severity path candidate
    base="$(dirname "$file")"
    while IFS="$(printf '\t')" read -r severity path; do
        [ -n "$path" ] || continue
        for candidate in "$path" "$base/$path"; do
            if [ -r "$candidate" ] && grep -q "🚨" "$candidate" 2>/dev/null; then
                hits=$((hits + 1))
                break
            fi
        done
    done < <(jq -r '(.inlineComments // [])[] | [.severity // "", .comment // ""] | @tsv' \
        "$file" 2>/dev/null)
    echo "$((markers + hits))"
}

# Token-greps the run output (stricter tokens first). Emits the normalized
# recommendation or nothing.
read_run_output_verdict() {
    local file="$1"
    [ -n "$file" ] && [ -r "$file" ] || return 0
    local response
    response="$(jq -r '.results[0].response // .response // empty' "$file" \
        2>/dev/null || true)"
    [ -n "$response" ] || response="$(cat "$file" 2>/dev/null || true)"
    if printf '%s' "$response" \
        | grep -qE 'CHANGES[_ ]REQUESTED|REQUEST_CHANGES|\bBLOCK(ED)?\b'; then
        echo "REQUEST_CHANGES"
    elif printf '%s' "$response" | grep -qE '\bAPPROVE(D)?\b'; then
        echo "APPROVE"
    fi
}

decide() {
    local decision="unknown" source="none" override="false"
    local rec="" blocking="" review_json_file=""

    # 1) pr_review.json is authoritative.
    local pair file
    for file in "${PR_REVIEW_JSON:-}" "${PR_REVIEW_JSON_ALT:-}"; do
        pair="$(read_review_json "$file")"
        [ -n "$pair" ] || continue
        rec="${pair%%|*}"
        blocking="${pair#*|}"
        source="pr_review_json"
        review_json_file="$file"
        break
    done

    # 2) Legacy fallback: grep the run output for verdict tokens. No issue
    # counts exist here, so the blocking-0 override never applies.
    if [ -z "$rec" ]; then
        rec="$(read_run_output_verdict "${RUN_OUTPUT:-}")"
        if [ -n "$rec" ]; then
            source="run_output"
            blocking=""
        fi
    fi

    case "$rec" in
        APPROVE)
            decision="approve"
            ;;
        REQUEST_CHANGES)
            # Protocol (gh-71): CHANGES_REQUESTED only for correctness/bug
            # findings. blocking==0 → nothing correctness-level was reported,
            # so the verdict converges to approve (approve-with-suggestions).
            # A non-numeric blocking count is treated as blocking (safe side).
            # Cross-check (gh-71 review): the override additionally requires
            # the review's own inline comments to agree on zero blocking —
            # a miscounted severity must not auto-merge the PR.
            local markers
            markers="$(inline_blocking_markers "$review_json_file")"
            if [ "$source" = "pr_review_json" ] \
                && [ "${blocking:-0}" -eq 0 ] 2>/dev/null \
                && [ "${markers:-0}" -eq 0 ]; then
                decision="approve"
                override="true"
                echo "WARNING: REQUEST_CHANGES with 0 blocking findings → approve (approve-with-suggestions, gh-71)" >&2
            else
                decision="rework"
            fi
            ;;
        BLOCK)
            decision="rework"
            ;;
    esac

    # Round cap: the highest rework-round-<n> label wins.
    # MAX_ROUNDS comes from a free-text repo variable — a non-integer would
    # make the `-ge` test below error INSIDE the `if` condition (which
    # `set -e` does not trap): the condition just evaluates false and the
    # cap never fires — the unbounded loop gh-71 caps, silently. Validate
    # once and default on garbage.
    local max_rounds="${MAX_ROUNDS:-2}"
    if ! [[ "$max_rounds" =~ ^[0-9]+$ ]]; then
        echo "WARNING: MAX_ROUNDS='$max_rounds' is not a non-negative integer — defaulting to 2" >&2
        max_rounds=2
    fi
    local rounds_done=0 next_round=0 escalate="false"
    local round_labels=() label n
    for label in ${ISSUE_LABELS:-}; do
        if [[ "$label" =~ ^rework-round-([0-9]+)$ ]]; then
            n="${BASH_REMATCH[1]}"
            if [ "$n" -gt "$rounds_done" ]; then
                rounds_done="$n"
            fi
            round_labels+=("$label")
        fi
    done
    next_round="$rounds_done"
    if [ "$decision" = "rework" ]; then
        if [ "$rounds_done" -ge "$max_rounds" ]; then
            escalate="true"
        else
            next_round=$((rounds_done + 1))
        fi
    fi

    printf 'decision=%s\n' "$decision"
    printf 'source=%s\n' "$source"
    printf 'override=%s\n' "$override"
    printf 'blocking_markers=%s\n' "${markers:-0}"
    printf 'rounds_done=%s\n' "$rounds_done"
    printf 'next_round=%s\n' "$next_round"
    printf 'escalate=%s\n' "$escalate"
    printf 'round_labels=%s\n' "$(printf '%q' "${round_labels[*]:-}")"
}

# Renders unresolved review threads as markdown bullets for the escalation
# comment: `- \`path:line\` — first body line (@author)`.
threads() {
    local file="$1"
    jq -r '
        ((.data.repository.pullRequest.reviewThreads.nodes // [])[]
        | select((.isResolved // false) | not)
        | "- `\(.path):\(.line // "?")` — \(
              (.comments.nodes[0].body // "(no comment text)")
              | gsub("\r"; "")
              | split("\n")[0]
              | if length > 180 then .[0:177] + "..." else . end
            ) (@\(.comments.nodes[0].author.login // "unknown"))")
    ' "$file"
}

case "${1:-}" in
    decide)
        decide
        ;;
    threads)
        [ -n "${2:-}" ] || {
            echo "usage: review-verdict.sh threads <graphql-response.json>" >&2
            exit 64
        }
        threads "$2"
        ;;
    *)
        echo "usage: review-verdict.sh decide|threads <file>" >&2
        exit 64
        ;;
esac
