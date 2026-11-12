#!/usr/bin/env bash
# gh-auth-refresh.sh — fresh-credential library for >1h AI-teammate legs (gh-1450).
#
# SOURCED library — never executed directly (the only direct invocation is
# `--self-test`). Everything gh-1450 fixed lives in two layers:
#
#   setup/gh-token-keeper.sh  (this repo, factory-setup asset) — a background
#       keeper that re-publishes a fresh credential every ~45 min into
#       GITHUB_ENV and the state file below. GitHub App installation tokens
#       (actions/create-github-app-token@v2) die at GitHub's fixed 1-hour
#       TTL; a >1h leg's gh calls — the agent session AND every post-agent
#       step — 401 with `Bad credentials (api.github.com/graphql)` and the
#       graceful interrupt path itself dies with them (run 43172953082).
#
#   THIS helper — the consumer side. The post-agent glue scripts source it
#       and call `gh_auth_refresh_apply` before their first gh call:
#
#       . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gh-auth-refresh.sh"
#       gh_auth_refresh_apply
#
# Resolution order (gh_auth_refresh_apply):
#   1. Keeper state file fresh (exists, ≤ GH_TOKEN_KEEPER_MAX_AGE_SEC old)
#      → export GH_TOKEN from it. The keeper only ever publishes credentials
#      minted within its refresh interval, so a fresh file means a valid
#      token — no probe spent.
#   2. GH_TOKEN unset → SOURCE_GITHUB_TOKEN (the machine PAT; the same
#      credential every git push in the leg already rides via the
#      install-source-git-credentials.sh helper).
#   3. GH_TOKEN set → one cheap auth probe (`gh api user`). On failure →
#      swap to SOURCE_GITHUB_TOKEN when present. This is the layer that
#      keeps the graceful degradation path alive TODAY, before any factory
#      wiring starts the keeper: an expired App token swaps to the PAT,
#      which does not ride the 1-hour installation TTL.
#
# Safety contract:
#   - No secret bytes are ever printed (the token value never reaches a log
#     line; only a masked tail does).
#   - set -u safe (callers run under `set -euo pipefail`).
#   - GH_TOKEN_KEEPER_DISABLE=1 turns the whole library into a no-op.
#   - The keeper path derivation below is the ONE canonical definition —
#     setup/gh-token-keeper.sh sources this file rather than repeating it.
set -u

GH_AUTH_REFRESH_DIR_DEFAULT() {
    if [ -n "${RUNER_TEMP:-}" ]; then printf '%s' "${RUNER_TEMP}"; else printf '/tmp'; fi
}

# The keeper's state directory (GH_TOKEN_KEEPER_DIR override for tests).
gh_auth_keeper_dir() {
    if [ -n "${GH_TOKEN_KEEPER_DIR:-}" ]; then printf '%s' "${GH_TOKEN_KEEPER_DIR}"; else GH_AUTH_REFRESH_DIR_DEFAULT; fi
}

# The state file the keeper publishes — keyed by run id so concurrent jobs
# on a shared (self-hosted) runner never clobber each other.
gh_auth_keeper_state_file() {
    printf '%s/gh-token-keeper-%s.env' "$(gh_auth_keeper_dir)" "${GITHUB_RUN_ID:-local}"
}

# File mtime as epoch seconds — GNU and BSD stat.
_gh_auth_file_mtime() {
    stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
}

# The keeper's freshest token, or empty. A file older than
# GH_TOKEN_KEEPER_MAX_AGE_SEC (default 3000 = 50 min — the keeper's
# interval is 45 min, so a file this stale means the keeper DIED mid-leg
# and its last mint may be expired) is ignored: fall through to the probe.
gh_auth_keeper_read() {
    local file
    file="$(gh_auth_keeper_state_file)"
    [ -s "$file" ] || return 0
    local max_age now mtime age
    max_age="${GH_TOKEN_KEEPER_MAX_AGE_SEC:-3000}"
    case "$max_age" in *[!0-9]*) max_age=3000 ;; esac
    now="$(date +%s)"
    mtime="$(_gh_auth_file_mtime "$file")"
    age=$(( now - mtime ))
    [ "$age" -le "$max_age" ] || return 0
    sed -n 's/^GH_TOKEN=//p' "$file" | head -n 1
}

# One cheap auth probe — 0 when gh can authenticate with the current env.
_gh_auth_probe_ok() {
    if command -v timeout >/dev/null 2>&1; then
        timeout 20 gh api user -H 'Accept: application/vnd.github+json' >/dev/null 2>&1
    else
        gh api user -H 'Accept: application/vnd.github+json' >/dev/null 2>&1
    fi
}

# Masked tail for log lines — never the full credential.
_gh_auth_masked_tail() {
    local value="$1" len
    len=${#value}
    if [ "$len" -le 8 ]; then printf '%s' '***'; else printf '***%s' "${value: -4}"; fi
}

# The one-call freshness entry (see the resolution order in the header).
gh_auth_refresh_apply() {
    [ "${GH_TOKEN_KEEPER_DISABLE:-}" = "1" ] && return 0

    # 1. Keeper-fresh token wins outright — no probe spent.
    local keeper_tok
    keeper_tok="$(gh_auth_keeper_read)"
    if [ -n "$keeper_tok" ]; then
        if [ "${GH_TOKEN:-}" != "$keeper_tok" ]; then
            export GH_TOKEN="$keeper_tok"
            echo "::notice::gh-auth-refresh: GH_TOKEN refreshed from the token keeper (leg >1h — App installation tokens expire at GitHub's fixed 1h TTL) [$( _gh_auth_masked_tail "$keeper_tok" )]"
        fi
        return 0
    fi

    # 2. GH_TOKEN unset — seed from the PAT (the long-leg credential).
    if [ -z "${GH_TOKEN:-}" ]; then
        if [ -n "${SOURCE_GITHUB_TOKEN:-}" ]; then
            export GH_TOKEN="$SOURCE_GITHUB_TOKEN"
            echo "::notice::gh-auth-refresh: GH_TOKEN unset — seeded from SOURCE_GITHUB_TOKEN"
        fi
        return 0
    fi

    # 3. Probe the current token; swap to the PAT on authentication failure.
    [ -n "${SOURCE_GITHUB_TOKEN:-}" ] || return 0
    [ "$GH_TOKEN" != "$SOURCE_GITHUB_TOKEN" ] || return 0
    if _gh_auth_probe_ok; then
        return 0
    fi
    export GH_TOKEN="$SOURCE_GITHUB_TOKEN"
    echo "::notice::gh-auth-refresh: GH_TOKEN failed its auth probe (expired GitHub App installation token?) — swapped to SOURCE_GITHUB_TOKEN (PAT; no 1h installation TTL) [$(_gh_auth_masked_tail "$GH_TOKEN")]"
}

# ── --self-test ──────────────────────────────────────────────────────────────
# Stub `gh` on PATH (gh + jq/coreutils run for real), scrubbed ambient env.
# Covers: the keeper-fresh swap, the stale-keeper fall-through, the
# probe-OK no-op, the probe-failure PAT swap, the unset seeding, the
# no-PAT honesty, the disable switch, and the no-secret-leak rule.
# Exit 0 only when every scenario holds.
self_test() {
    local fails=0 tmp stubs out rc
    tmp="$(mktemp -d)"
    stubs="$tmp/stubs"
    mkdir -p "$stubs"

    # gh test double: `gh api user` succeeds unless GH_STUB_FAIL is set.
    cat > "$stubs/gh" <<'STUB_EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "api" ] && [ "${2:-}" = "user" ]; then
    [ -n "${GH_STUB_FAIL:-}" ] && exit 42
    echo '{"login":"stub"}'
    exit 0
fi
exit 0
STUB_EOF
    chmod 755 "$stubs/gh"

    # Sourced invocation under a scrubbed env + the stub PATH. Keeper knobs
    # default; per-scenario vars come after the record file. The final
    # GH_TOKEN rides a tagged line so the value channel stays separable
    # from the library's log channel (the leak assertions scan the logs,
    # never the tagged result line).
    apply_in() {
        ( cd "$tmp" && env -u GH_TOKEN -u SOURCE_GITHUB_TOKEN -u GITHUB_RUN_ID \
            -u RUNER_TEMP -u GH_TOKEN_KEEPER_DIR -u GH_TOKEN_KEEPER_DISABLE \
            -u GH_TOKEN_KEEPER_MAX_AGE_SEC \
            PATH="$stubs:$PATH" GH_TOKEN_KEEPER_DIR="$tmp" \
            "$@" bash -c '
                . "'"$tmp"'/helper.sh"
                gh_auth_refresh_apply
                printf "__RESULT__%s\n" "${GH_TOKEN-}"
            ' ) 2>&1
    }
    # The applied GH_TOKEN (the value channel).
    result_of() { sed -n 's/^__RESULT__//p' <<< "$1" | head -n 1; }
    # The library's log channel (everything but the result line).
    logs_of() { grep -v '^__RESULT__' <<< "$1" || true; }

    assert_contains() {
        if [ "$2" != "${2#*"$3"}" ]; then echo "ok - $1"; else
            echo "self-test FAIL: $1"; fails=$((fails + 1)); fi
    }
    assert_not_contains() {
        if [ "$2" = "${2#*"$3"}" ]; then echo "ok - $1"; else
            echo "self-test FAIL: $1 — leaked: $3"; fails=$((fails + 1)); fi
    }
    assert_equals() {
        if [ "$2" = "$3" ]; then echo "ok - $1"; else
            echo "self-test FAIL: $1 — got [$2]"; fails=$((fails + 1)); fi
    }

    cp "${BASH_SOURCE[0]}" "$tmp/helper.sh"

    # 1 — keeper-fresh token wins outright (even with a failing probe env).
    printf 'GH_TOKEN=ghs_keptokenfresh\n' > "$tmp/gh-token-keeper-local.env"
    out="$(apply_in GH_TOKEN=ghs_staleapptoken GH_STUB_FAIL=1)"; rc=$?
    assert_equals "keeper-fresh swap exits 0" "$rc" "0"
    assert_equals "keeper-fresh token applied" "$(result_of "$out")" "ghs_keptokenfresh"
    assert_contains "keeper-fresh swap logs the notice" "$(logs_of "$out")" "::notice::gh-auth-refresh: GH_TOKEN refreshed from the token keeper"

    # 2 — a stale keeper file falls through to the probe path.
    printf 'GH_TOKEN=ghs_stalekeptoken\n' > "$tmp/gh-token-keeper-local.env"
    touch -d '2 hours ago' "$tmp/gh-token-keeper-local.env"
    out="$(apply_in GH_TOKEN=ghs_staleapptoken)"; rc=$?
    assert_equals "stale keeper falls through, exits 0" "$rc" "0"
    assert_equals "stale keeper ignored — probe-OK keeps GH_TOKEN" "$(result_of "$out")" "ghs_staleapptoken"

    # 3 — no keeper, probe OK → nothing changes.
    rm -f "$tmp/gh-token-keeper-local.env"
    out="$(apply_in GH_TOKEN=ghs_validapptoken)"; rc=$?
    assert_equals "probe-OK keeps GH_TOKEN" "$(result_of "$out")" "ghs_validapptoken"

    # 4 — no keeper, probe fails, PAT present → swapped to the PAT.
    out="$(apply_in GH_TOKEN=ghs_expiredapptoken SOURCE_GITHUB_TOKEN=ghp_machinepat GH_STUB_FAIL=1)"; rc=$?
    assert_equals "probe-failure swap exits 0" "$rc" "0"
    assert_equals "expired token swapped to the PAT" "$(result_of "$out")" "ghp_machinepat"
    assert_contains "swap logs the notice" "$(logs_of "$out")" "swapped to SOURCE_GITHUB_TOKEN"

    # 5 — no keeper, probe fails, no PAT → honest no-op (token unchanged).
    out="$(apply_in GH_TOKEN=ghs_expiredapptoken GH_STUB_FAIL=1)"; rc=$?
    assert_equals "no-PAT honesty exits 0" "$rc" "0"
    assert_equals "no PAT — token unchanged" "$(result_of "$out")" "ghs_expiredapptoken"

    # 6 — GH_TOKEN unset + PAT present → seeded without a probe.
    out="$(apply_in SOURCE_GITHUB_TOKEN=ghp_machinepat)"; rc=$?
    assert_equals "unset seeding exits 0" "$rc" "0"
    assert_equals "unset GH_TOKEN seeded from the PAT" "$(result_of "$out")" "ghp_machinepat"

    # 7 — GH_TOKEN unset + no PAT → stays unset (never fabricated).
    out="$(apply_in)"; rc=$?
    assert_equals "nothing to seed — empty" "$(result_of "$out")" ""

    # 8 — the disable switch is a full no-op (keeper present and fresh).
    printf 'GH_TOKEN=ghs_keptokenfresh\n' > "$tmp/gh-token-keeper-local.env"
    out="$(apply_in GH_TOKEN=ghs_staleapptoken GH_TOKEN_KEEPER_DISABLE=1)"; rc=$?
    assert_equals "disable switch keeps GH_TOKEN" "$(result_of "$out")" "ghs_staleapptoken"

    # 9 — no secret leak: the full tokens never reach the log channel.
    rm -f "$tmp/gh-token-keeper-local.env"
    out="$(apply_in GH_TOKEN=ghs_expiredapptoken0123456789 SOURCE_GITHUB_TOKEN=ghp_machinepat0123456789 GH_STUB_FAIL=1)"
    assert_not_contains "full expired token never printed" "$(logs_of "$out")" "ghs_expiredapptoken0123456789"
    assert_not_contains "full PAT never printed" "$(logs_of "$out")" "ghp_machinepat0123456789"

    # 10 — sourced-library contract: sourcing the helper must NOT flip
    #     `set -u` onto the host. The post-agent glue runs GitHub's default
    #     `bash -e`; a sourced `set -u` turns tolerated-empty vars into hard
    #     `unbound variable` step deaths on the graceful path gh-1450 fixes.
    host_flags="$( ( cd "$tmp" && bash -c '
        set -e
        . "'"$tmp"'/helper.sh"
        printf "%s" "$-"
    ' ) )"; rc=$?
    assert_equals "sourcing the helper exits 0" "$rc" "0"
    assert_not_contains "sourcing does not flip set -u onto the host" "$host_flags" "u"

    # 11 — the state dir honors RUNER_TEMP (GitHub's double-N export):
    #     without GH_TOKEN_KEEPER_DIR the state file rides the job-scoped
    #     temp dir, never /tmp — plaintext credentials must not persist on
    #     shared runners past the job's RUNNER_TEMP cleanup.
    runner_dir="$tmp/jobtemp"
    mkdir -p "$runner_dir"
    state_path="$( ( cd "$tmp" && env -u GH_TOKEN -u SOURCE_GITHUB_TOKEN -u GITHUB_RUN_ID \
        -u RUNER_TEMP -u GH_TOKEN_KEEPER_DIR -u GH_TOKEN_KEEPER_DISABLE \
        -u GH_TOKEN_KEEPER_MAX_AGE_SEC \
        PATH="$stubs:$PATH" RUNER_TEMP="$runner_dir" \
        bash -c '
            . "'"$tmp"'/helper.sh"
            gh_auth_keeper_state_file
        ' ) )"; rc=$?
    assert_equals "state-file path resolution exits 0" "$rc" "0"
    assert_equals "state file rides RUNER_TEMP (job-scoped, not /tmp)" \
        "$state_path" "$runner_dir/gh-token-keeper-local.env"

    rm -rf "$tmp"
    if [ "$fails" -eq 0 ]; then
        echo "gh-auth-refresh self-test: PASS"
        return 0
    fi
    echo "gh-auth-refresh self-test: FAIL ($fails assertion(s) failed)"
    return 1
}

# Executed directly (not sourced) → --self-test is the only entrypoint.
if [ "${BASH_SOURCE[0]:-}" != "${0:-}" ]; then
    return 0 2>/dev/null || true
fi
if [ "${1:-}" = "--self-test" ]; then
    self_test
    exit $?
fi
echo "usage: source gh-auth-refresh.sh; gh_auth_refresh_apply [--self-test]" >&2
exit 2
