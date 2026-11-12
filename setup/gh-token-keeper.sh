#!/usr/bin/env bash
# gh-token-keeper.sh — leg-scoped GitHub credential keeper (gh-1450).
#
# AI-teammate legs that run longer than ~60 min die mid-flight with
# `HTTP 401: Bad credentials (api.github.com/graphql)`: the GitHub App
# installation token minted by actions/create-github-app-token@v2 expires
# at GitHub's fixed 1-hour TTL and nothing refreshes it. Every gh call in
# the leg — the agent session and every post-agent step — 401s, and the
# graceful interrupt path dies with them (run 43172953082: no PR, no
# branch, no issue comments; the ticket silently stalled).
#
# The keeper is fix direction 1 (token refresh inside the job) + direction
# 3 (the PAT-based long-leg credential): run it as a background process at
# leg setup and it re-publishes a fresh credential every
# GH_TOKEN_KEEPER_INTERVAL_SEC (default 270s = 45 min — safely inside the
# 60-minute TTL) into:
#
#   1. the state file (gh_auth_keeper_state_file, scripts/gh-auth-refresh.sh)
#      — the consumption point for every engine glue script via
#      `gh_auth_refresh_apply`;
#   2. $GITHUB_ENV, when set — the fresh GH_TOKEN becomes the job-level
#      value for every LATER workflow step. Note the precedence rule: a
#      step that pins `env: GH_TOKEN: ${{ steps.app-token.outputs.token }}`
#      keeps the frozen step-level value — the awf flip should drop those
#      pins (or re-read the state file) to benefit from this surface.
#
# Credential resolution (GH_TOKEN_KEEPER_MODE):
#   auto (default) — re-mint the App installation token when APP_ID +
#       APP_PRIVATE_KEY (+ GITHUB_REPOSITORY) are present (same identity
#       the leg started with); fall back to SOURCE_GITHUB_TOKEN when the
#       mint fails or no App credentials exist. The PAT is the machine
#       account's long-lived credential — every git push in the leg
#       already rides it (install-source-git-credentials.sh), so it is the
#       sanctioned long-leg credential.
#   app — App re-mint only (never publishes the PAT).
#   pat — publish SOURCE_GITHUB_TOKEN only.
#
# Lifecycle:
#   bash setup/gh-token-keeper.sh start    # background me at leg setup: `... &`
#   bash setup/gh-token-keeper.sh stop     # leg teardown: exits within a poll tick
#   bash setup/gh-token-keeper.sh refresh  # one cycle (also the test seam)
#   bash setup/gh-token-keeper.sh --self-test
#
# Inert by design: with NO credential source configured the keeper warns
# once and exits 0 — short legs (<45 min) never observe it, and a wrongly
# wired start can never fail a leg. The keeper self-terminates at
# GH_TOKEN_KEEPER_MAX_LIFETIME_SEC (default 6h) even if the stop call is
# lost, and it never prints a credential (masked tail only).
#
# Requires bash + coreutils; the App path additionally needs curl, jq and
# openssl (all present on GitHub runners). Without them the keeper
# degrades to the PAT path.
set -u

KEEPER_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The state-path derivation is single-sourced in the consumer helper — the
# keeper must never invent a divergent copy of it.
# shellcheck source=../scripts/gh-auth-refresh.sh
. "${KEEPER_SELF_DIR}/../scripts/gh-auth-refresh.sh"

GH_TOKEN_KEEPER_INTERVAL_DEFAULT=270
GH_TOKEN_KEEPER_LIFETIME_DEFAULT=21600
GH_TOKEN_KEEPER_POLL_DEFAULT=5

_gh_keeper_int_or() {
    case "$1" in ''|*[!0-9]*) printf '%s' "$2" ;; *) printf '%s' "$1" ;; esac
}

# Poll slices may be fractional (test seam); integers otherwise.
_gh_keeper_poll_or() {
    case "$1" in ''|*[!.0-9]*|*.*.*) printf '%s' "$2" ;; *) printf '%s' "$1" ;; esac
}

_gh_keeper_warn() { echo "::warning::gh-token-keeper: $*" >&2; }

_gh_keeper_stop_file() {
    printf '%s.stop' "$(gh_auth_keeper_state_file)"
}

# ── App installation re-mint (RS256 JWT → installation token) ────────────

_gh_keeper_b64url() {
    openssl base64 -A 2>/dev/null | tr -- '+/' '-_' | tr -d '='
}

_gh_keeper_b64url_input() {
    printf %s "$1" | _gh_keeper_b64url
}

# PEM material arrives with literal "\n" escapes when stored as an Actions
# secret — %b turns them into real newlines; a real PEM passes through.
_gh_keeper_write_private_key() {
    printf '%b' "$APP_PRIVATE_KEY" > "$1"
}

# Mint one fresh installation token for GITHUB_REPOSITORY. Prints the
# token on success (captured — never echoed), returns non-zero on failure.
_gh_keeper_mint_app_token() {
    command -v curl >/dev/null 2>&1 || return 1
    command -v jq >/dev/null 2>&1 || return 1
    command -v openssl >/dev/null 2>&1 || return 1
    local repo="${GITHUB_REPOSITORY:-}"
    [ -n "$repo" ] || { _gh_keeper_warn 'app re-mint needs GITHUB_REPOSITORY to resolve the installation'; return 1; }

    local keyfile now iat exp header payload signing sig jwt
    keyfile="$(mktemp "${TMPDIR:-/tmp}/gh-token-keeper-key.XXXXXX")" || return 1
    chmod 600 "$keyfile"
    _gh_keeper_write_private_key "$keyfile"
    now="$(date +%s)"
    iat=$(( now - 60 ))
    exp=$(( now + 540 ))
    header="$(_gh_keeper_b64url_input '{"alg":"RS256","typ":"JWT"}')"
    payload="$(_gh_keeper_b64url_input "{\"iat\":${iat},\"exp\":${exp},\"iss\":\"${APP_ID}\"}")"
    signing="${header}.${payload}"
    sig="$(printf %s "$signing" | openssl dgst -sha256 -sign "$keyfile" -binary | _gh_keeper_b64url)" || {
        rm -f "$keyfile"; _gh_keeper_warn 'app re-mint: JWT signing failed'; return 1; }
    rm -f "$keyfile"
    jwt="${signing}.${sig}"

    local install_id token
    install_id="$(curl -fsS -m 30 \
        -H "Authorization: Bearer ${jwt}" \
        -H 'Accept: application/vnd.github+json' \
        "https://api.github.com/repos/${repo}/installation" 2>/dev/null \
        | jq -r '.id // empty' 2>/dev/null)" || {
        _gh_keeper_warn 'app re-mint: installation lookup failed'; return 1; }
    [ -n "$install_id" ] || { _gh_keeper_warn 'app re-mint: no installation for this repository'; return 1; }

    token="$(curl -fsS -m 30 \
        -H "Authorization: Bearer ${jwt}" \
        -H 'Accept: application/vnd.github+json' \
        -X POST "https://api.github.com/app/installations/${install_id}/access_tokens" \
        -d '{}' 2>/dev/null \
        | jq -r '.token // empty' 2>/dev/null)" || {
        _gh_keeper_warn 'app re-mint: access-token mint failed'; return 1; }
    [ -n "$token" ] || { _gh_keeper_warn 'app re-mint: empty access token'; return 1; }
    printf '%s' "$token"
}

_gh_keeper_masked_tail() {
    local value="$1" len
    len=${#value}
    if [ "$len" -le 8 ]; then printf '%s' '***'; else printf '***%s' "${value: -4}"; fi
}

# ── credential resolution ────────────────────────────────────────────────

_gh_keeper_app_configured() {
    [ -n "${APP_ID:-}" ] && [ -n "${APP_PRIVATE_KEY:-}" ]
}

_gh_keeper_resolve_token() {
    # sets GH_KEEPER_TOKEN + GH_KEEPER_SOURCE, or returns:
    #   0 — published a token
    #   2 — inert (no credential source configured)
    #   1 — configured but the refresh failed
    local mode="${GH_TOKEN_KEEPER_MODE:-auto}"
    GH_KEEPER_TOKEN=''
    GH_KEEPER_SOURCE=''

    case "$mode" in
      auto|app|pat) : ;;
      *)
        _gh_keeper_warn "unknown GH_TOKEN_KEEPER_MODE '${mode}' — use auto|app|pat"
        return 2
        ;;
    esac

    case "$mode" in
      auto|pat)
        if [ -n "${SOURCE_GITHUB_TOKEN:-}" ]; then
            GH_KEEPER_TOKEN="$SOURCE_GITHUB_TOKEN"
            GH_KEEPER_SOURCE='pat'
        fi
        ;;
    esac
    case "$mode" in
      auto|app)
        if _gh_keeper_app_configured; then
            local minted
            minted="$(_gh_keeper_mint_app_token)" || minted=''
            if [ -n "$minted" ]; then
                GH_KEEPER_TOKEN="$minted"
                GH_KEEPER_SOURCE='app'
            elif [ "$mode" = 'app' ]; then
                return 1
            fi
        elif [ "$mode" = 'app' ]; then
            return 2
        fi
        ;;
    esac

    if [ -n "$GH_KEEPER_TOKEN" ]; then
        return 0
    fi
    if [ -n "${SOURCE_GITHUB_TOKEN:-}" ] || _gh_keeper_app_configured; then
        return 1
    fi
    return 2
}

# ── publish ──────────────────────────────────────────────────────────────

_gh_keeper_publish() {
    local dir file tmpfile
    dir="$(gh_auth_keeper_dir)"
    mkdir -p "$dir" 2>/dev/null || true
    file="$(gh_auth_keeper_state_file)"
    tmpfile="${file}.tmp.$$"
    printf 'GH_TOKEN=%s\n' "$GH_KEEPER_TOKEN" > "$tmpfile"
    chmod 600 "$tmpfile"
    mv -f "$tmpfile" "$file"
    # GITHUB_ENV takes the fresh GH_TOKEN for every LATER step of this job.
    # Repeated appends are fine — the last value wins for the job env.
    if [ -n "${GITHUB_ENV:-}" ]; then
        printf 'GH_TOKEN=%s\n' "$GH_KEEPER_TOKEN" >> "$GITHUB_ENV" 2>/dev/null || true
    fi
    echo "::notice::gh-token-keeper: published refreshed GH_TOKEN (source: ${GH_KEEPER_SOURCE}, tail $(_gh_keeper_masked_tail "$GH_KEEPER_TOKEN")) — state file$( [ -n "${GITHUB_ENV:-}" ] && echo ' + GITHUB_ENV' ) updated"
}

# One refresh cycle. Inert → 0 (warned), failure → 1, published → 0.
keeper_refresh() {
    # gh-1450: the documented kill switch — the consumer helper no-ops under
    # GH_TOKEN_KEEPER_DISABLE=1; the producer must honor it too, or a
    # "disabled" leg still flips GH_TOKEN for every later step.
    if [ "${GH_TOKEN_KEEPER_DISABLE:-0}" = '1' ]; then
        _gh_keeper_warn 'GH_TOKEN_KEEPER_DISABLE=1 — keeper disabled, nothing published'
        return 0
    fi
    GH_KEEPER_TOKEN=''
    GH_KEEPER_SOURCE=''
    _gh_keeper_resolve_token
    local rc=$?
    if [ "$rc" -eq 2 ]; then
        _gh_keeper_warn 'no credential source (set APP_ID+APP_PRIVATE_KEY and/or SOURCE_GITHUB_TOKEN) — keeper is inert'
        return 0
    fi
    if [ "$rc" -eq 1 ]; then
        _gh_keeper_warn 'refresh failed (credential source configured but the token was not obtained) — will retry next interval'
        return 1
    fi
    _gh_keeper_publish
    return 0
}

# ── lifecycle ────────────────────────────────────────────────────────────

keeper_start() {
    local interval lifetime poll stopfile start now last
    interval="$(_gh_keeper_int_or "${GH_TOKEN_KEEPER_INTERVAL_SEC:-}" "$GH_TOKEN_KEEPER_INTERVAL_DEFAULT")"
    lifetime="$(_gh_keeper_int_or "${GH_TOKEN_KEEPER_MAX_LIFETIME_SEC:-}" "$GH_TOKEN_KEEPER_LIFETIME_DEFAULT")"
    poll="$(_gh_keeper_poll_or "${GH_TOKEN_KEEPER_POLL_SEC:-}" "$GH_TOKEN_KEEPER_POLL_DEFAULT")"
    stopfile="$(_gh_keeper_stop_file)"

    if [ -e "$stopfile" ]; then
        echo '::notice::gh-token-keeper: stop file already present — not starting'
        return 0
    fi

    # Inert keepers never occupy the background: no credential source
    # configured → warn once and leave (a wrongly wired start cannot fail
    # the leg, and short legs never observe the keeper at all).
    GH_KEEPER_TOKEN=''
    GH_KEEPER_SOURCE=''
    _gh_keeper_resolve_token
    if [ "$?" -eq 2 ]; then
        _gh_keeper_warn 'no credential source (set APP_ID+APP_PRIVATE_KEY and/or SOURCE_GITHUB_TOKEN) — keeper is inert'
        return 0
    fi

    echo "::notice::gh-token-keeper: started (interval ${interval}s, lifetime ${lifetime}s, poll ${poll}s) — gh-1450"
    keeper_refresh
    start="$(date +%s)"
    last="$start"
    while :; do
        now="$(date +%s)"
        if [ $(( now - start )) -ge "$lifetime" ]; then
            echo '::notice::gh-token-keeper: lifetime cap reached — exiting'
            return 0
        fi
        [ -e "$stopfile" ] && {
            echo '::notice::gh-token-keeper: stop file observed — exiting'
            return 0
        }
        if [ $(( now - last )) -ge "$interval" ]; then
            keeper_refresh
            last="$(date +%s)"
        fi
        sleep "$poll"
    done
}

keeper_stop() {
    mkdir -p "$(gh_auth_keeper_dir)" 2>/dev/null || true
    : > "$(_gh_keeper_stop_file)"
    echo "::notice::gh-token-keeper: stop file written ($(_gh_keeper_stop_file))"
}

usage() {
    cat <<'EOF'
Usage: gh-token-keeper.sh refresh|start|stop|--self-test

  refresh     one refresh cycle (resolve → publish state file + GITHUB_ENV)
  start       refresh now, then loop every GH_TOKEN_KEEPER_INTERVAL_SEC
              (default 270s) until the stop file or the lifetime cap
              (GH_TOKEN_KEEPER_MAX_LIFETIME_SEC, default 6h)
  stop        write the stop file — `start` exits within a poll tick
  --self-test end-to-end contract check with stubbed curl (openssl/jq real)
EOF
}

# ── --self-test ──────────────────────────────────────────────────────────
# End-to-end contract check with a stub `curl` on PATH (openssl + jq run
# for real). Covers: the RS256 JWT actually signing (the stub verifies the
# signature against a throwaway RSA keypair and the iss claim), the App
# identity winning in auto mode, the PAT fallback when the mint fails,
# pat/app modes, inert-when-unconfigured, the state-file/GITHUB_ENV
# publish pair, the stop-file and lifetime lifecycle, and the
# no-secret-leak rule. Exit 0 only when every scenario holds.
self_test() {
    local fails=0 tmp stubs out rc
    tmp="$(mktemp -d)"
    stubs="$tmp/stubs"
    mkdir -p "$stubs"

    # A throwaway RSA keypair — the stub VERIFIES the keeper's JWT with it.
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:1024 -out "$tmp/key.pem" 2>/dev/null
    openssl pkey -in "$tmp/key.pem" -pubout -out "$tmp/pub.pem" 2>/dev/null

    # curl test double: verifies the JWT (signature + iss) on the
    # installation lookup, then serves the canned installation/token
    # payloads. Appends every URL to GH_STUB_CALLS (the mint counter).
    cat > "$stubs/curl" <<STUB_EOF
#!/usr/bin/env bash
auth=""
prev=""
for a in "\$@"; do
    if [ "\$prev" = "-H" ]; then
        case "\$a" in Authorization:*) auth="\$a" ;; esac
    fi
    prev="\$a"
done
for a in "\$@"; do
    case "\$a" in https://api.github.com/*) echo "\$a" >> "\$GH_STUB_CALLS" ;; esac
done
b64d() {
    local inp="\$1"
    while [ \$(( \${#inp} % 4 )) -ne 0 ]; do inp="\${inp}="; done
    printf '%s' "\$inp" | tr -- '-_' '+/' | openssl base64 -d -A 2>/dev/null
}
verify_jwt() {
    local jwt="\$1" h p s payload sigfile
    IFS=. read -r h p s <<< "\$jwt"
    [ -n "\$h" ] && [ -n "\$p" ] && [ -n "\$s" ] || return 1
    sigfile="\$(mktemp)"
    b64d "\$s" > "\$sigfile"
    printf '%s.%s' "\$h" "\$p" | openssl dgst -sha256 -verify "\$GH_STUB_PUB" -signature "\$sigfile" >/dev/null 2>&1 || { rm -f "\$sigfile"; return 1; }
    rm -f "\$sigfile"
    payload="\$(b64d "\$p")"
    case "\$payload" in *'"iss":"'\$GH_STUB_APP_ID'"'*) : ;; *) return 1 ;; esac
    return 0
}
case "\$*" in
    *"/repos/"*"/installation"*)
        [ -n "\${GH_STUB_FAIL_INSTALL:-}" ] && exit 5
        jwt="\${auth##*Bearer }"
        verify_jwt "\$jwt" || { echo "stub: JWT verification failed" >&2; exit 6; }
        echo '{"id":42}' ;;
    *"/app/installations/42/access_tokens"*)
        printf '{"token":"%s","expires_at":"2099-01-01T00:00:00Z"}' "\${GH_STUB_MINTED:-ghs_mintedtoken123456}" ;;
    *) exit 10 ;;
esac
STUB_EOF
    chmod 755 "$stubs/curl"

    local script="$KEEPER_SELF_DIR/$(basename "${BASH_SOURCE[0]}")"

    # One keeper invocation inside a scrubbed env + the stub PATH; every
    # mutable surface lives in the sandbox.
    #   run_keeper <appcreds 0|1> <command> [extra NAME=VALUE ...]
    # App credentials ride a dedicated array — the PEM is multiline, so it
    # must stay ONE argv word (`env` accepts multiline assignments; it
    # cannot receive shell functions).
    _run_keeper() {
        local appcreds="$1" cmd="$2"; shift 2
        local -a appargs=()
        if [ "$appcreds" = "1" ]; then
            appargs=( "APP_ID=1234" "APP_PRIVATE_KEY=$(cat "$tmp/key.pem")" "GH_STUB_APP_ID=1234" )
        fi
        ( cd "$tmp" && env -u GH_TOKEN -u SOURCE_GITHUB_TOKEN -u GITHUB_RUN_ID \
            -u RUNER_TEMP -u GH_TOKEN_KEEPER_DIR -u GH_TOKEN_KEEPER_MODE \
            -u GH_TOKEN_KEEPER_INTERVAL_SEC -u GH_TOKEN_KEEPER_MAX_LIFETIME_SEC \
            -u GH_TOKEN_KEEPER_POLL_SEC -u APP_ID -u APP_PRIVATE_KEY \
            -u GITHUB_ENV -u GITHUB_REPOSITORY \
            -u GH_STUB_CALLS -u GH_STUB_PUB -u GH_STUB_APP_ID -u GH_STUB_MINTED \
            -u GH_STUB_FAIL_INSTALL \
            PATH="$stubs:$PATH" GH_TOKEN_KEEPER_DIR="$tmp" \
            GITHUB_ENV="$tmp/github_env" GITHUB_RUN_ID=4242 \
            GH_STUB_CALLS="$tmp/calls" GH_STUB_PUB="$tmp/pub.pem" \
            "${appargs[@]}" "$@" bash "$script" "$cmd" )
    }
    run_keeper() { _run_keeper "$@" >/dev/null 2>&1; echo $?; }
    run_keeper_out() { _run_keeper "$@" 2>&1; }
    # Same, but captures output (log-channel assertions).

    assert_equals() {
        if [ "$2" = "$3" ]; then echo "ok - $1"; else
            echo "self-test FAIL: $1 — got [$2]"; fails=$((fails + 1)); fi
    }
    assert_contains() {
        if [ "$2" != "${2#*"$3"}" ]; then echo "ok - $1"; else
            echo "self-test FAIL: $1"; fails=$((fails + 1)); fi
    }
    assert_not_contains() {
        if [ "$2" = "${2#*"$3"}" ]; then echo "ok - $1"; else
            echo "self-test FAIL: $1 — leaked: $3"; fails=$((fails + 1)); fi
    }

    reset_sandbox() {
        rm -f "$tmp/github_env" "$tmp/gh-token-keeper-4242.env" "$tmp/gh-token-keeper-4242.env.stop" "$tmp/calls"
    }

    # 1 — App re-mint end-to-end: auto mode prefers the minted token, the
    #     JWT really signs (RS256, verified by the stub against the
    #     throwaway keypair), and both publish surfaces carry it.
    reset_sandbox
    rc="$(run_keeper 1 refresh GITHUB_REPOSITORY=acme/widgets)"
    assert_equals "app mint refresh exits 0" "$rc" "0"
    assert_equals "state file carries the minted app token" \
        "$(sed -n 's/^GH_TOKEN=//p' "$tmp/gh-token-keeper-4242.env" 2>/dev/null)" "ghs_mintedtoken123456"
    assert_equals "GITHUB_ENV carries the minted app token" \
        "$(sed -n 's/^GH_TOKEN=//p' "$tmp/github_env" 2>/dev/null)" "ghs_mintedtoken123456"
    assert_contains "the JWT rode the installation lookup" \
        "$(cat "$tmp/calls" 2>/dev/null)" "https://api.github.com/repos/acme/widgets/installation"

    # 2 — the minted token never leaks into the log channel.
    out="$(run_keeper_out 1 refresh GITHUB_REPOSITORY=acme/widgets)"
    assert_contains "app refresh logs the publish notice" "$out" "published refreshed GH_TOKEN (source: app"
    assert_not_contains "full minted token never printed" "$out" "ghs_mintedtoken123456"

    # 3 — PAT-only (no App credentials): the PAT is the published credential.
    reset_sandbox
    rc="$(run_keeper 0 refresh SOURCE_GITHUB_TOKEN=ghp_machinepat)"
    assert_equals "PAT refresh exits 0" "$rc" "0"
    assert_equals "state file carries the PAT" \
        "$(sed -n 's/^GH_TOKEN=//p' "$tmp/gh-token-keeper-4242.env" 2>/dev/null)" "ghp_machinepat"
    out="$(run_keeper_out 0 refresh SOURCE_GITHUB_TOKEN=ghp_machinepat)"
    assert_contains "PAT publish names the source" "$out" "source: pat"
    assert_not_contains "full PAT never printed" "$out" "ghp_machinepat"

    # 4 — auto mode falls back to the PAT when the mint fails.
    reset_sandbox
    rc="$(run_keeper 1 refresh GH_STUB_FAIL_INSTALL=1 SOURCE_GITHUB_TOKEN=ghp_machinepat GITHUB_REPOSITORY=acme/widgets)"
    assert_equals "mint-failure fallback exits 0" "$rc" "0"
    assert_equals "state file carries the PAT after the mint failure" \
        "$(sed -n 's/^GH_TOKEN=//p' "$tmp/gh-token-keeper-4242.env" 2>/dev/null)" "ghp_machinepat"

    # 5 — mode=app with a failing mint and no PAT: configured-but-failed (exit 1).
    reset_sandbox
    rc="$(run_keeper 1 refresh GH_STUB_FAIL_INSTALL=1 GH_TOKEN_KEEPER_MODE=app GITHUB_REPOSITORY=acme/widgets)"
    assert_equals "app-mode mint failure exits non-zero" "$rc" "1"
    assert_equals "no state file on failure" "$(cat "$tmp/gh-token-keeper-4242.env" 2>/dev/null)" ""

    # 6 — inert: no credential source at all → exit 0, nothing published.
    reset_sandbox
    out="$(run_keeper_out 0 refresh)"
    rc=$?
    assert_equals "inert keeper exits 0" "$rc" "0"
    assert_contains "inert keeper warns" "$out" "keeper is inert"
    assert_equals "inert keeper publishes nothing" "$(cat "$tmp/gh-token-keeper-4242.env" 2>/dev/null)" ""

    # 7 — mode=app without APP_ID: inert (never silently falls back).
    reset_sandbox
    rc="$(run_keeper 0 refresh GH_TOKEN_KEEPER_MODE=app SOURCE_GITHUB_TOKEN=ghp_machinepat)"
    assert_equals "app-mode without credentials stays inert" "$rc" "0"
    assert_equals "app-mode inert publishes nothing" "$(cat "$tmp/gh-token-keeper-4242.env" 2>/dev/null)" ""

    # 8 — mode=pat publishes the PAT even with App credentials present.
    reset_sandbox
    rc="$(run_keeper 1 refresh GH_TOKEN_KEEPER_MODE=pat SOURCE_GITHUB_TOKEN=ghp_machinepat GITHUB_REPOSITORY=acme/widgets)"
    assert_equals "pat-mode refresh exits 0" "$rc" "0"
    assert_equals "pat-mode publishes the PAT (never the app mint)" \
        "$(sed -n 's/^GH_TOKEN=//p' "$tmp/gh-token-keeper-4242.env" 2>/dev/null)" "ghp_machinepat"

    # 8b — GH_TOKEN_KEEPER_DISABLE=1: the documented kill switch no-ops the
    # whole mechanism. The consumer helper honors it; the producer must too,
    # or a "disabled" leg still flips GH_TOKEN for every later step.
    reset_sandbox
    rc="$(run_keeper 0 refresh GH_TOKEN_KEEPER_DISABLE=1 SOURCE_GITHUB_TOKEN=ghp_machinepat GITHUB_REPOSITORY=acme/widgets)"
    assert_equals "disable switch exits 0" "$rc" "0"
    assert_equals "disable switch publishes nothing" "$(cat "$tmp/gh-token-keeper-4242.env" 2>/dev/null)" ""

    # 9 — start with a pre-existing stop file: exits immediately, no publish.
    reset_sandbox
    : > "$tmp/gh-token-keeper-4242.env.stop"
    rc="$(run_keeper 1 start GITHUB_REPOSITORY=acme/widgets)"
    assert_equals "pre-stopped start exits 0" "$rc" "0"
    assert_equals "pre-stopped start publishes nothing" "$(cat "$tmp/gh-token-keeper-4242.env" 2>/dev/null)" ""
    rm -f "$tmp/gh-token-keeper-4242.env.stop"

    # 10 — start refreshes immediately, then once per interval, and exits
    #      at the lifetime cap. interval=1s, lifetime=3s → ≥2 mints.
    reset_sandbox
    rc="$(run_keeper 1 start GITHUB_REPOSITORY=acme/widgets \
        GH_TOKEN_KEEPER_INTERVAL_SEC=1 GH_TOKEN_KEEPER_MAX_LIFETIME_SEC=3 \
        GH_TOKEN_KEEPER_POLL_SEC=0.2)"
    assert_equals "bounded start exits 0" "$rc" "0"
    local mints
    mints="$(grep -c '/repos/acme/widgets/installation' "$tmp/calls" 2>/dev/null || echo 0)"
    if [ "${mints:-0}" -ge 2 ]; then
        echo "ok - bounded start minted ${mints}x (immediate + per-interval)"
    else
        echo "self-test FAIL: bounded start minted only ${mints}x"; fails=$((fails + 1))
    fi
    assert_equals "bounded start left a fresh state file" \
        "$(sed -n 's/^GH_TOKEN=//p' "$tmp/gh-token-keeper-4242.env" 2>/dev/null)" "ghs_mintedtoken123456"

    # 11 — stop writes the stop file.
    reset_sandbox
    rc="$(run_keeper 0 stop)"
    assert_equals "stop exits 0" "$rc" "0"
    [ -e "$tmp/gh-token-keeper-4242.env.stop" ] && echo "ok - stop file written" \
        || { echo "self-test FAIL: stop file missing"; fails=$((fails + 1)); }

    # 12 — the state file is private (0600).
    reset_sandbox
    run_keeper 0 refresh SOURCE_GITHUB_TOKEN=ghp_machinepat >/dev/null
    local mode
    mode="$(stat -c %a "$tmp/gh-token-keeper-4242.env" 2>/dev/null || stat -f %Lp "$tmp/gh-token-keeper-4242.env" 2>/dev/null)"
    assert_equals "state file mode is 600" "$mode" "600"

    rm -rf "$tmp"
    if [ "$fails" -eq 0 ]; then
        echo "gh-token-keeper self-test: PASS"
        return 0
    fi
    echo "gh-token-keeper self-test: FAIL ($fails assertion(s) failed)"
    return 1
}

# ── entrypoint ───────────────────────────────────────────────────────────

case "${1:-}" in
    refresh)  keeper_refresh; exit $? ;;
    start)    keeper_start; exit $? ;;
    stop)     keeper_stop; exit $? ;;
    --self-test) self_test; exit $? ;;
    *)        usage >&2; exit 2 ;;
esac
