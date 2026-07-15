#!/usr/bin/env bash
# Checkout project dependencies from a repositories.json config.
# No project-specific content — all settings come from the JSON config file.
#
# Usage:
#   checkout.sh [project-key] [options]
#
# project-key is optional: if the config's .repositories has exactly one key, it is
# auto-detected. If the config file is missing entirely, or has zero repositories,
# this is a safe no-op (exit 0) — most projects never define repositories.json at all,
# so this script is safe to call unconditionally from generic setup/CI steps.
#
# Options:
#   --config        PATH  repositories.json path (default: .dmtools/repositories.json)
#   --dest          DIR   destination root dir   (default: ./dependencies)
#   --token            VAR   name of env var holding the GitHub PAT (default: GH_TOKEN)
#   --ado-token-var    VAR   name of env var holding the ADO PAT    (default: ADO_GIT_TOKEN)
#   --gitlab-token-var VAR   name of env var holding the GitLab PAT (default: GITLAB_TOKEN)
#   --host             HOST  GitHub host            (default: github.com)
#   --gitlab-host      HOST  GitLab host            (default: from GITLAB_BASE_PATH or gitlab.com)
#   --filter        STR   git clone filter       (default: blob:none  — blobless)
#   --depth         N     git clone depth (shallow clone, default: 1). Set to "" or 0
#                         for a full clone with history. Per-entry "depth" field
#                         in the JSON config overrides this for a single repo.
#
# Provider detection (per repository entry):
#   If an entry has "adoOrg" field → uses Azure DevOps clone URL
#   Else if "provider":"gitlab" OR gitlabGroup/gitlabNamespace/gitlabHost is present → GitLab clone URL
#   Otherwise → uses GitHub clone URL (existing behaviour)
#
# Config format (.dmtools/repositories.json):
#   {
#     "git": {
#       "userName":  "AI Agent",
#       "userEmail": "ai-agent@example.com"
#     },
#     "repositories": {
#       "my-project": [
#         { "repo": "org/repo-name", "branch": "main", "envVar": "MY_DIR" },
#         {
#           "repo": "ado-repo-name",
#           "adoOrg": "MyOrg", "adoProject": "MyProject",
#           "branch": "main", "envVar": "ADO_REPO_DIR"
#         },
#         {
#           "provider": "gitlab",
#           "repo": "dmtools-epamsample",
#           "gitlabGroup": "mobile",
#           "gitlabHost": "git.epam.com",
#           "branch": "main",
#           "envVar": "GITLAB_REPO_DIR"
#         }
#       ]
#     }
#   }
#
# Fields:
#   repo            (required) — "org/repo-name" for GitHub, plain name for ADO/GitLab
#   branch          (optional) — default "main"
#   envVar          (optional) — if set, exports {envVar}=<full-cloned-path> to CI
#   adoOrg          (optional) — if set, entry is treated as an ADO repository
#   adoProject      (optional) — ADO project name (required when adoOrg is set)
#   provider        (optional) — "gitlab" to force GitLab mode for the entry
#   gitlabGroup     (optional) — GitLab group/namespace when repo is plain name
#   gitlabNamespace (optional) — alias of gitlabGroup
#   gitlabHost      (optional) — host override for this entry
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

# ── Argument parsing ──────────────────────────────────────────────────────────
# project-key is an optional leading positional arg — only consumed when present
# and not itself an option flag (so `checkout.sh --dest .` works with auto-detect).
PROJECT_KEY=""
if [ $# -gt 0 ] && [[ "$1" != -* ]]; then
  PROJECT_KEY="$1"
  shift
fi
CONFIG_FILE=".dmtools/repositories.json"
DEST_ROOT="./dependencies"
TOKEN_VAR="GH_TOKEN"
ADO_TOKEN_VAR="ADO_GIT_TOKEN"
GITLAB_TOKEN_VAR="GITLAB_TOKEN"
GH_HOST="github.com"
GIT_FILTER="blob:none"
DEPTH="1"
GITLAB_HOST="${GITLAB_BASE_PATH:-gitlab.com}"
GITLAB_HOST="${GITLAB_HOST#https://}"
GITLAB_HOST="${GITLAB_HOST#http://}"
GITLAB_HOST="${GITLAB_HOST%%/*}"
if [ -z "${GITLAB_HOST}" ]; then
  GITLAB_HOST="gitlab.com"
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)        CONFIG_FILE="$2";    shift 2 ;;
    --dest)          DEST_ROOT="$2";      shift 2 ;;
    --token)            TOKEN_VAR="$2";         shift 2 ;;
    --ado-token-var)    ADO_TOKEN_VAR="$2";     shift 2 ;;
    --gitlab-token-var) GITLAB_TOKEN_VAR="$2";  shift 2 ;;
    --host)             GH_HOST="$2";           shift 2 ;;
    --gitlab-host)      GITLAB_HOST="$2";       shift 2 ;;
    --filter)           GIT_FILTER="$2";        shift 2 ;;
    --depth)             DEPTH="$2";             shift 2 ;;
    -h|--help)
      sed -n '2,/^set -/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── No config file → safe no-op (most projects never call this script) ────────
if [ ! -f "${CONFIG_FILE}" ]; then
  echo "ℹ️  No ${CONFIG_FILE} found — skipping dependency checkout (nothing to do)."
  exit 0
fi

# ── Ensure jq is available (needed for both auto-detection and the main loop) ──
if ! is_installed jq; then
  echo "📥 Installing jq..."
  case "$(detect_os)" in
    macos) brew install jq ;;
    linux) $(sudo_cmd) apt-get install -y jq -qq ;;
    *)     echo "❌ Cannot install jq on this OS" >&2; exit 1 ;;
  esac
fi

# ── Auto-detect project key when omitted ──────────────────────────────────────
if [ -z "${PROJECT_KEY}" ]; then
  KEY_COUNT="$(jq -r '.repositories | keys | length // 0' "${CONFIG_FILE}")"
  if [ "${KEY_COUNT}" -eq 0 ]; then
    echo "ℹ️  ${CONFIG_FILE} has no repositories configured — skipping dependency checkout."
    exit 0
  elif [ "${KEY_COUNT}" -eq 1 ]; then
    PROJECT_KEY="$(jq -r '.repositories | keys[0]' "${CONFIG_FILE}")"
    echo "ℹ️  No project-key given — auto-detected '${PROJECT_KEY}' (only key in ${CONFIG_FILE})"
  else
    echo "❌ ${CONFIG_FILE} has multiple project keys — pass one explicitly: checkout.sh <project-key>" >&2
    jq -r '.repositories | keys[]' "${CONFIG_FILE}" | sed 's/^/   - /' >&2
    exit 1
  fi
fi

# ── Validate project key exists in config ─────────────────────────────────────
REPO_COUNT="$(jq --arg key "${PROJECT_KEY}" '.repositories[$key] | length // 0' "${CONFIG_FILE}")"
if [ "${REPO_COUNT}" -eq 0 ]; then
  echo "⚠️  No repositories configured for key '${PROJECT_KEY}' in ${CONFIG_FILE}"
  exit 0
fi

# ── Read git identity from config ─────────────────────────────────────────────
GIT_USER_NAME="$(jq -r '.git.userName  // "AI Agent"'       "${CONFIG_FILE}")"
GIT_USER_EMAIL="$(jq -r '.git.userEmail // "ai@localhost"'  "${CONFIG_FILE}")"

# ── Resolve tokens (lazy — only fail if needed during clone) ─────────────────
GH_TOKEN="${!TOKEN_VAR:-}"
ADO_TOKEN="${!ADO_TOKEN_VAR:-}"
GITLAB_TOKEN="${!GITLAB_TOKEN_VAR:-}"

mkdir -p "${DEST_ROOT}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📦 Checkout dependencies — key: ${PROJECT_KEY}"
echo "   config: ${CONFIG_FILE}"
echo "   dest:   ${DEST_ROOT}"
echo "   git:    ${GIT_USER_NAME} <${GIT_USER_EMAIL}>"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Clone / update each repo ──────────────────────────────────────────────────
# Use temp file to avoid subshell pipeline (so export_var side-effects persist)
TMP_REPOS="$(mktemp)"
jq -c --arg key "${PROJECT_KEY}" '.repositories[$key][]' "${CONFIG_FILE}" > "${TMP_REPOS}"

while IFS= read -r entry; do
  REPO="$(    echo "${entry}" | jq -r '.repo')"
  BRANCH="$(  echo "${entry}" | jq -r '.branch     // "main"')"
  ENV_VAR="$( echo "${entry}" | jq -r '.envVar     // ""')"
  ADO_ORG="$( echo "${entry}" | jq -r '.adoOrg     // ""')"
  ADO_PROJ="$(echo "${entry}" | jq -r '.adoProject // ""')"
  PROVIDER="$(echo "${entry}" | jq -r '.provider   // ""')"
  GITLAB_GROUP="$(echo "${entry}" | jq -r '.gitlabGroup // .gitlabNamespace // ""')"
  ENTRY_GITLAB_HOST="$(echo "${entry}" | jq -r '.gitlabHost // ""')"
  ENTRY_DEPTH="$(echo "${entry}" | jq -r '.depth // ""')"

  NAME="${REPO##*/}"    # last path component (works for both "org/repo" and plain "repo")
  DEST="${DEST_ROOT}/${NAME}"

  # Effective clone depth: per-entry override wins, else the global --depth default.
  # Empty or "0" means a full (non-shallow) clone.
  EFFECTIVE_DEPTH="${ENTRY_DEPTH:-${DEPTH}}"
  DEPTH_ARGS=()
  if [ -n "${EFFECTIVE_DEPTH}" ] && [ "${EFFECTIVE_DEPTH}" != "0" ]; then
    DEPTH_ARGS=(--depth "${EFFECTIVE_DEPTH}")
  fi

  echo ""

  if [ -n "${ADO_ORG}" ]; then
    # ── Azure DevOps entry ────────────────────────────────────────────────────
    if [ -z "${ADO_TOKEN}" ]; then
      echo "❌ ADO token env var '${ADO_TOKEN_VAR}' is not set." >&2
      exit 1
    fi
    CLONE_URL="https://:${ADO_TOKEN}@dev.azure.com/${ADO_ORG}/${ADO_PROJ}/_git/${NAME}"
    DISPLAY_URL="https://dev.azure.com/${ADO_ORG}/${ADO_PROJ}/_git/${NAME}"
    echo "▶ [ADO] ${DISPLAY_URL} @ ${BRANCH} → ${DEST}"

    if [ -d "${DEST}/.git" ]; then
      git -C "${DEST}" remote set-url origin "${CLONE_URL}"
      git -C "${DEST}" fetch origin "${BRANCH}"
      git -C "${DEST}" checkout "${BRANCH}"
      git -C "${DEST}" pull origin "${BRANCH}" --ff-only 2>/dev/null || true
      echo "  ↻ updated"
    else
      git clone "${DEPTH_ARGS[@]+"${DEPTH_ARGS[@]}"}" --branch "${BRANCH}" "${CLONE_URL}" "${DEST}"
      echo "  ✅ cloned"
    fi

    # Keep token in remote URL so subsequent git push works from the agent
    git -C "${DEST}" remote set-url origin "${CLONE_URL}"

  elif [ "${PROVIDER}" = "gitlab" ] || [ -n "${GITLAB_GROUP}" ] || [ -n "${ENTRY_GITLAB_HOST}" ]; then
    # ── GitLab entry ───────────────────────────────────────────────────────────
    if [ -z "${GITLAB_TOKEN}" ]; then
      echo "❌ GitLab token env var '${GITLAB_TOKEN_VAR}' is not set." >&2
      exit 1
    fi

    CURRENT_GITLAB_HOST="${ENTRY_GITLAB_HOST:-${GITLAB_HOST}}"
    REPO_PATH="${REPO}"
    if [ "${REPO_PATH#*/}" = "${REPO_PATH}" ]; then
      if [ -z "${GITLAB_GROUP}" ]; then
        echo "❌ GitLab entry '${REPO}' requires gitlabGroup/gitlabNamespace when repo has no namespace." >&2
        exit 1
      fi
      REPO_PATH="${GITLAB_GROUP}/${REPO}"
    fi

    CLONE_URL="https://oauth2:${GITLAB_TOKEN}@${CURRENT_GITLAB_HOST}/${REPO_PATH}.git"
    DISPLAY_URL="https://${CURRENT_GITLAB_HOST}/${REPO_PATH}"
    echo "▶ [GL] ${DISPLAY_URL} @ ${BRANCH} → ${DEST}"

    if [ -d "${DEST}/.git" ]; then
      git -C "${DEST}" remote set-url origin "${CLONE_URL}"
      git -C "${DEST}" fetch --filter="${GIT_FILTER}" origin "${BRANCH}"
      git -C "${DEST}" checkout "${BRANCH}"
      git -C "${DEST}" pull origin "${BRANCH}" --ff-only 2>/dev/null || true
      echo "  ↻ updated"
    else
      git clone \
        "${DEPTH_ARGS[@]+"${DEPTH_ARGS[@]}"}" \
        --filter="${GIT_FILTER}" \
        --branch "${BRANCH}" \
        "${CLONE_URL}" \
        "${DEST}"
      echo "  ✅ cloned"
    fi

    # Keep token in remote URL so subsequent git push works from the agent
    git -C "${DEST}" remote set-url origin "${CLONE_URL}"

  else
    # ── GitHub entry (original behaviour) ────────────────────────────────────
    if [ -z "${GH_TOKEN}" ]; then
      echo "❌ GitHub token env var '${TOKEN_VAR}' is not set." >&2
      exit 1
    fi
    echo "▶ [GH] ${REPO} @ ${BRANCH} → ${DEST}"

    if [ -d "${DEST}/.git" ]; then
      git -C "${DEST}" remote set-url origin \
        "https://x-access-token:${GH_TOKEN}@${GH_HOST}/${REPO}.git"
      git -C "${DEST}" fetch --filter="${GIT_FILTER}" origin "${BRANCH}"
      git -C "${DEST}" checkout "${BRANCH}"
      echo "  ↻ updated"
    else
      git clone \
        "${DEPTH_ARGS[@]+"${DEPTH_ARGS[@]}"}" \
        --filter="${GIT_FILTER}" \
        --branch "${BRANCH}" \
        "https://x-access-token:${GH_TOKEN}@${GH_HOST}/${REPO}.git" \
        "${DEST}"
      echo "  ✅ cloned"
    fi

    # Keep token in remote URL so subsequent git push / PR creation works
    git -C "${DEST}" remote set-url origin \
      "https://x-access-token:${GH_TOKEN}@${GH_HOST}/${REPO}.git"
  fi

  # Apply git identity from config (no hardcoded values)
  git -C "${DEST}" config user.name  "${GIT_USER_NAME}"
  git -C "${DEST}" config user.email "${GIT_USER_EMAIL}"

  # Export path env var if specified in config
  if [ -n "${ENV_VAR}" ]; then
    FULL_PATH="$(cd "${DEST}" && pwd)"
    export_var "${ENV_VAR}" "${FULL_PATH}"
    echo "  📌 ${ENV_VAR}=${FULL_PATH}"
  fi

done < "${TMP_REPOS}"

rm -f "${TMP_REPOS}"

echo ""
echo "✅ All dependencies ready for '${PROJECT_KEY}'"
