#!/usr/bin/env bash
# Configure a stable, cacheable fa session for AI Teammate runs.
#
# fa resumes named sessions natively (--session <name> --session-root <dir>
# resumes when the name exists, creates it otherwise), so a deterministic
# name per repo:key:group is all it takes — no post-run directory rewrite
# (that's the kimi-specific hack in kimi-session.sh).
#
# Usage:
#   fa-session.sh env
#   fa-session.sh info
#
# Inputs:
#   AI_TEAMMATE_CONFIG_FILE       e.g. agents/story_development.json
#   AI_TEAMMATE_CONCURRENCY_KEY   workflow concurrency key (usually ticket key)
#   AI_TEAMMATE_DISPLAY_KEY       user-visible ticket key, preferred when set
#   GITHUB_WORKSPACE              workspace root
#
# Outputs:
#   FA_SESSION_NAME                stable session name derived from repo/key/group
#   FA_SESSION_ROOT                isolated session root (fa --session-root)
#   FA_SESSION_CACHE_PATH          path for CI cache restore/save
#   FA_SESSION_CACHE_KEY           immutable cache key for this run
#   FA_SESSION_CACHE_RESTORE_KEY   prefix for previous runs of the same stream
set -eu

# NOTE: deliberately does NOT set a global SCRIPT_DIR — this file is sourced
# from scripts/providers/fa.sh mid-run-agent.sh execution, where clobbering
# the caller's SCRIPT_DIR would break subsequent sourcing.
FA_SESSION_SETUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${FA_SESSION_SETUP_DIR}/_common.sh"

_slug() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//; s/-{2,}/-/g'
}

_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | awk '{print $1}'
  else
    printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
  fi
}

_config_slug() {
  local config="${AI_TEAMMATE_CONFIG_FILE:-${CONFIG_FILE:-}}"
  config="${config##*/}"
  config="${config%.json}"
  _slug "${config:-unknown}"
}

_session_group_for_config() {
  local config="$1"
  case "${config}" in
    story_development|bug_development|pr_rework)
      echo "dev-write"
      ;;
    pr_review)
      echo "dev-review"
      ;;
    test_case_automation|pr_test_automation_rework)
      echo "test-write"
      ;;
    pr_test_automation_review)
      echo "test-review"
      ;;
    *)
      echo "${config}"
      ;;
  esac
}

exclude_fa_session_from_git() {
  local workspace="$1"
  local git_dir

  git_dir="$(git -C "${workspace}" rev-parse --git-dir 2>/dev/null || true)"
  if [ -z "${git_dir}" ]; then
    return 0
  fi

  mkdir -p "${git_dir}/info"
  touch "${git_dir}/info/exclude"

  grep -qxF ".dmtools/fa-sessions/" "${git_dir}/info/exclude" 2>/dev/null \
    || echo ".dmtools/fa-sessions/" >> "${git_dir}/info/exclude"
  grep -qxF ".dmtools/fa-sessions/**" "${git_dir}/info/exclude" 2>/dev/null \
    || echo ".dmtools/fa-sessions/**" >> "${git_dir}/info/exclude"
}

configure_fa_session() {
  local workspace="${GITHUB_WORKSPACE:-${PWD}}"
  local repo="${GITHUB_REPOSITORY:-$(basename "${workspace}")}"
  local config="$(_config_slug)"
  local group="$(_session_group_for_config "${config}")"
  local key="${AI_TEAMMATE_DISPLAY_KEY:-${DISPLAY_KEY:-}}"

  if [ -z "${key}" ]; then
    key="${AI_TEAMMATE_CONCURRENCY_KEY:-${CONCURRENCY_KEY:-}}"
  fi
  if [ -z "${key}" ]; then
    key="$(git -C "${workspace}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo local)"
  fi

  local repo_slug="$(_slug "${repo}")"
  local key_slug="$(_slug "${key}")"
  local group_slug="$(_slug "${group}")"
  local session_seed="${repo_slug}:${key_slug}:${group_slug}"
  # Short hash suffix keeps the name unique without UUID noise; fa accepts
  # arbitrary session names, it just needs them filesystem-safe.
  local session_hash="$(_sha256 "${session_seed}")"
  local session_name="fa-${repo_slug}-${key_slug}-${group_slug}-${session_hash:0:8}"
  local session_root="${workspace}/.dmtools/fa-sessions/${repo_slug}/${key_slug}/${group_slug}"
  local cache_prefix="fa-session-${repo_slug}-${key_slug}-${group_slug}-"
  local cache_version="${FA_SESSION_CACHE_VERSION:-v1}"
  local cache_run_id="${GITHUB_RUN_ID:-local}"

  mkdir -p "${session_root}"
  exclude_fa_session_from_git "${workspace}"

  export_var "FA_SESSION_NAME" "${session_name}"
  export_var "FA_SESSION_ROOT" "${session_root}"
  export_var "FA_SESSION_CACHE_PATH" "${session_root}"
  export_var "FA_SESSION_CACHE_RESTORE_KEY" "${cache_prefix}${cache_version}-"
  export_var "FA_SESSION_CACHE_KEY" "${cache_prefix}${cache_version}-${cache_run_id}"
}

MODE="${1:-env}"
case "${MODE}" in
  env|restore|save|info)
    configure_fa_session
    echo "⚡ fa session: name=${FA_SESSION_NAME}"
    echo "📦 fa session cache: key=${FA_SESSION_CACHE_KEY} path=${FA_SESSION_CACHE_PATH}"
    ;;
  *)
    echo "Usage: fa-session.sh env|restore|save|info" >&2
    exit 1
    ;;
esac
