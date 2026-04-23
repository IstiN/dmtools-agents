#!/usr/bin/env bash
# Checkout project dependencies from a repositories.json config.
# No project-specific content — all settings come from the JSON config file.
#
# Usage:
#   checkout.sh <project-key> [options]
#
# Options:
#   --config        PATH  repositories.json path (default: .dmtools/repositories.json)
#   --dest          DIR   destination root dir   (default: ./dependencies)
#   --token         VAR   name of env var holding the GitHub PAT (default: GH_TOKEN)
#   --ado-token-var VAR   name of env var holding the ADO PAT   (default: ADO_GIT_TOKEN)
#   --host          HOST  GitHub host            (default: github.com)
#   --filter        STR   git clone filter       (default: blob:none  — blobless)
#
# Provider detection (per repository entry):
#   If an entry has "adoOrg" field → uses Azure DevOps clone URL
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
#         }
#       ]
#     }
#   }
#
# Fields:
#   repo       (required) — "org/repo-name" for GitHub, plain name for ADO
#   branch     (optional) — default "main"
#   envVar     (optional) — if set, exports {envVar}=<full-cloned-path> to CI
#   adoOrg     (optional) — if set, entry is treated as an ADO repository
#   adoProject (optional) — ADO project name (required when adoOrg is set)
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

# ── Argument parsing ──────────────────────────────────────────────────────────
PROJECT_KEY="${1:-}"
CONFIG_FILE=".dmtools/repositories.json"
DEST_ROOT="./dependencies"
TOKEN_VAR="GH_TOKEN"
ADO_TOKEN_VAR="ADO_GIT_TOKEN"
GH_HOST="github.com"
GIT_FILTER="blob:none"

shift 2>/dev/null || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)        CONFIG_FILE="$2";    shift 2 ;;
    --dest)          DEST_ROOT="$2";      shift 2 ;;
    --token)         TOKEN_VAR="$2";      shift 2 ;;
    --ado-token-var) ADO_TOKEN_VAR="$2";  shift 2 ;;
    --host)          GH_HOST="$2";        shift 2 ;;
    --filter)        GIT_FILTER="$2";     shift 2 ;;
    -h|--help)
      sed -n '2,/^set -/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ -z "${PROJECT_KEY}" ]; then
  echo "Usage: checkout.sh <project-key> [--config PATH] [--dest DIR] [--token VAR] [--ado-token-var VAR]" >&2
  exit 1
fi

# ── Validate config file ──────────────────────────────────────────────────────
if [ ! -f "${CONFIG_FILE}" ]; then
  echo "❌ Config not found: ${CONFIG_FILE}" >&2
  exit 1
fi

# ── Ensure jq is available ────────────────────────────────────────────────────
if ! is_installed jq; then
  echo "📥 Installing jq..."
  case "$(detect_os)" in
    macos) brew install jq ;;
    linux) sudo apt-get install -y jq -qq ;;
    *)     echo "❌ Cannot install jq on this OS" >&2; exit 1 ;;
  esac
fi

# ── Read git identity from config ─────────────────────────────────────────────
GIT_USER_NAME="$(jq -r '.git.userName  // "AI Agent"'       "${CONFIG_FILE}")"
GIT_USER_EMAIL="$(jq -r '.git.userEmail // "ai@localhost"'  "${CONFIG_FILE}")"

# ── Validate project key exists in config ─────────────────────────────────────
REPO_COUNT="$(jq --arg key "${PROJECT_KEY}" '.repositories[$key] | length // 0' "${CONFIG_FILE}")"
if [ "${REPO_COUNT}" -eq 0 ]; then
  echo "⚠️  No repositories configured for key '${PROJECT_KEY}' in ${CONFIG_FILE}"
  exit 0
fi

# ── Resolve tokens (lazy — only fail if needed during clone) ─────────────────
GH_TOKEN="${!TOKEN_VAR:-}"
ADO_TOKEN="${!ADO_TOKEN_VAR:-}"

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

  NAME="${REPO##*/}"    # last path component (works for both "org/repo" and plain "repo")
  DEST="${DEST_ROOT}/${NAME}"

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
      git clone --branch "${BRANCH}" "${CLONE_URL}" "${DEST}"
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
