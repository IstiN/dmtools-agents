#!/usr/bin/env bash
# Configure a stable, cacheable Kimi session for AI Teammate runs.
#
# Usage:
#   kimi-session.sh env
#   kimi-session.sh info
#
# Inputs:
#   AI_TEAMMATE_CONFIG_FILE       e.g. agents/story_development.json
#   AI_TEAMMATE_CONCURRENCY_KEY   workflow concurrency key (usually ticket key)
#   AI_TEAMMATE_DISPLAY_KEY       user-visible ticket key, preferred when set
#   GITHUB_WORKSPACE              workspace root
#
# Outputs:
#   KIMI_SESSION_ID               stable UUID derived from repo/key/group
#   KIMI_SESSION_NAME             stable human-readable session name
#   KIMI_SESSION_GROUP            logical group (dev-write, dev-review, ...)
#   KIMI_CODE_HOME                isolated Kimi home to cache for this work stream
#   KIMI_SESSION_CACHE_PATH       path for CI cache restore/save
#   KIMI_SESSION_CACHE_KEY        immutable cache key for this run
#   KIMI_SESSION_CACHE_RESTORE_KEY prefix for previous runs of the same stream
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/_common.sh"

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

_uuid_from_seed() {
  local hash="$(_sha256 "$1")"
  # Build a deterministic UUID-looking value. Kimi only requires a UUID;
  # the seed keeps the same ticket/group on the same session across CI runs.
  printf '%s-%s-5%s-a%s-%s' \
    "${hash:0:8}" \
    "${hash:8:4}" \
    "${hash:13:3}" \
    "${hash:17:3}" \
    "${hash:20:12}"
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

exclude_kimi_session_from_git() {
  local workspace="$1"
  local git_dir

  git_dir="$(git -C "${workspace}" rev-parse --git-dir 2>/dev/null || true)"
  if [ -z "${git_dir}" ]; then
    return 0
  fi

  mkdir -p "${git_dir}/info"
  touch "${git_dir}/info/exclude"

  grep -qxF ".dmtools/kimi-sessions/" "${git_dir}/info/exclude" 2>/dev/null \
    || echo ".dmtools/kimi-sessions/" >> "${git_dir}/info/exclude"
  grep -qxF ".dmtools/kimi-sessions/**" "${git_dir}/info/exclude" 2>/dev/null \
    || echo ".dmtools/kimi-sessions/**" >> "${git_dir}/info/exclude"
}

configure_kimi_session() {
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
  local session_id="$(_uuid_from_seed "${session_seed}")"
  local session_name="${repo_slug}-${key_slug}-${group_slug}"
  local session_root="${workspace}/.dmtools/kimi-sessions/${repo_slug}/${key_slug}/${group_slug}"
  local cache_prefix="kimi-session-${repo_slug}-${key_slug}-${group_slug}-"
  local cache_version="${KIMI_SESSION_CACHE_VERSION:-v1}"
  local cache_run_id="${GITHUB_RUN_ID:-local}"

  mkdir -p "${session_root}"
  exclude_kimi_session_from_git "${workspace}"

  # Carry over the Kimi config that setup/kimi.sh wrote into the default home.
  # Kimi reads config from $KIMI_CODE_HOME/config.toml, so we mirror it into
  # the isolated session home before overriding KIMI_CODE_HOME.
  local default_kimi_home="${HOME}/.kimi-code"
  if [ -f "${default_kimi_home}/config.toml" ] && [ ! -f "${session_root}/config.toml" ]; then
    cp "${default_kimi_home}/config.toml" "${session_root}/config.toml"
  fi

  export_var "KIMI_SESSION_ID" "${session_id}"
  export_var "KIMI_SESSION_NAME" "${session_name}"
  export_var "KIMI_SESSION_GROUP" "${group_slug}"
  export_var "KIMI_CODE_HOME" "${session_root}"
  export_var "KIMI_SESSION_CACHE_PATH" "${session_root}"
  export_var "KIMI_SESSION_CACHE_RESTORE_KEY" "${cache_prefix}${cache_version}-"
  export_var "KIMI_SESSION_CACHE_KEY" "${cache_prefix}${cache_version}-${cache_run_id}"
}

MODE="${1:-env}"
case "${MODE}" in
  env|restore|save|info)
    configure_kimi_session
    echo "🌙 Kimi session: group=${KIMI_SESSION_GROUP} name=${KIMI_SESSION_NAME}"
    echo "📦 Kimi session cache: key=${KIMI_SESSION_CACHE_KEY} path=${KIMI_SESSION_CACHE_PATH}"
    ;;
  *)
    echo "Usage: kimi-session.sh env|restore|save|info" >&2
    exit 1
    ;;
esac
