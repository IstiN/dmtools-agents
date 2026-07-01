#!/usr/bin/env bash
# Common utilities shared by all setup scripts.
# Source this file — do not run it directly.

# ── OS / CI / Package manager detection ──────────────────────────────────────

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux)  echo "linux" ;;
    *)      echo "unknown" ;;
  esac
}

detect_ci() {
  if   [ -n "${BITRISE_BUILD_NUMBER:-}" ]; then echo "bitrise"
  elif [ -n "${GITHUB_ACTIONS:-}" ];       then echo "github"
  elif [ -n "${BUILD_BUILDID:-}" ];        then echo "ado"
  elif [ -n "${GITLAB_CI:-}" ];            then echo "gitlab"
  else                                          echo "local"
  fi
}

detect_package_manager() {
  if   is_installed brew;    then echo "brew"
  elif is_installed apt-get; then echo "apt"
  else                            echo "none"
  fi
}

# ── PATH / env registration ───────────────────────────────────────────────────

# Add a directory to PATH — works for the current shell AND subsequent CI steps.
register_path() {
  local dir="$1"
  # Export immediately so the rest of this script can use the binary.
  export PATH="${dir}:${PATH}"

  # Persist to a temp file so parent install.sh can accumulate all paths
  echo "${dir}" >> /tmp/_registered_paths 2>/dev/null || true

  case "$(detect_ci)" in
    bitrise)
      # envman REPLACES the variable — pass the full cumulative PATH.
      command -v envman &>/dev/null \
        && envman add --key PATH --value "${PATH}" \
        || true
      ;;
    github)
      [ -n "${GITHUB_PATH:-}" ] && echo "${dir}" >> "${GITHUB_PATH}" || true
      ;;
    gitlab)
      [ -n "${GITLAB_ENV_PATH:-}" ] && echo "export PATH=\"${dir}:\$PATH\"" >> "${GITLAB_ENV_PATH}" || true
      ;;
    ado)
      echo "##vso[task.prependpath]${dir}"
      ;;
    local) ;;  # already exported above
  esac
}

# Export an env variable so subsequent CI steps can see it.
export_var() {
  local key="$1" value="$2"
  export "${key}=${value}"

  case "$(detect_ci)" in
    bitrise)
      command -v envman &>/dev/null \
        && envman add --key "${key}" --value "${value}" \
        || true
      ;;
    github)
      [ -n "${GITHUB_ENV:-}" ] && echo "${key}=${value}" >> "${GITHUB_ENV}" || true
      ;;
    gitlab)
      [ -n "${GITLAB_ENV_PATH:-}" ] && echo "export ${key}=\"${value}\"" >> "${GITLAB_ENV_PATH}" || true
      ;;
    ado)
      echo "##vso[task.setvariable variable=${key}]${value}"
      ;;
    local) ;;
  esac
}

# ── Helpers ───────────────────────────────────────────────────────────────────

is_installed() { command -v "$1" &>/dev/null; }

# Returns "sudo" when not running as root, empty string when already root.
# Usage: $(sudo_cmd) apt-get install ...
sudo_cmd() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "sudo"
  else
    echo ""
  fi
}

section() { echo ""; echo "▶ $*"; echo ""; }

# Resolve "tool:version" argument → sets TOOL_NAME and TOOL_VERSION
parse_tool_arg() {
  local arg="$1"
  TOOL_NAME="${arg%%:*}"
  TOOL_VERSION="${arg#*:}"
  [ "${TOOL_VERSION}" = "${TOOL_NAME}" ] && TOOL_VERSION=""  # no colon → empty
}

# Auto-init or sync the CodeGraph index in the current git repository.
# If .codegraph/ already exists (restored from cache) → sync.
# If not → init non-interactively.
# Skips silently if not inside a git repository or if codegraph is not installed.
_codegraph_restore_gitignore() {
  local workspace="$1"

  if git -C "${workspace}" ls-files --error-unmatch .codegraph/.gitignore >/dev/null 2>&1; then
    git -C "${workspace}" checkout -- .codegraph/.gitignore >/dev/null 2>&1 || true
  else
    rm -f "${workspace}/.codegraph/.gitignore"
  fi
}

_codegraph_init_or_sync() {
  local workspace="${GITHUB_WORKSPACE:-${PWD}}"

  if ! command -v codegraph &>/dev/null; then
    return 0
  fi

  if ! git -C "${workspace}" rev-parse --git-dir &>/dev/null 2>&1; then
    echo "ℹ️  Not a git repository — skipping CodeGraph init"
    return 0
  fi

  if [ -d "${workspace}/.codegraph" ]; then
    echo "🔄 CodeGraph index found — syncing..."
    codegraph sync "${workspace}" 2>/dev/null || true
    _codegraph_restore_gitignore "${workspace}"
    echo "✅ CodeGraph index synced"
  else
    echo "🔨 Initializing CodeGraph index..."
    codegraph init -i "${workspace}" 2>/dev/null || true
    _codegraph_restore_gitignore "${workspace}"
    echo "✅ CodeGraph index initialized"
  fi
}

# ── Portable file hashing ─────────────────────────────────────────────────────
# macOS ships `md5` (BSD) and `shasum`, but not `md5sum`/`sha256sum`.
# Linux ships `md5sum`/`sha256sum` (GNU coreutils), usually not `md5`.
# This helper tries every common tool in order and always returns a value
# (falls back to "nokey" if the file is missing or no hashing tool exists,
# so cache keys never end with a literal empty string).
hash_file() {
  local file="$1"

  if [ ! -f "${file}" ]; then
    echo "nokey"
    return 0
  fi

  if command -v sha256sum &>/dev/null; then
    sha256sum "${file}" | cut -d' ' -f1
  elif command -v shasum &>/dev/null; then
    shasum -a 256 "${file}" | cut -d' ' -f1
  elif command -v md5sum &>/dev/null; then
    md5sum "${file}" | cut -d' ' -f1
  elif command -v md5 &>/dev/null; then
    md5 -q "${file}"
  else
    echo "nokey"
  fi
}

# Hash multiple files together (order-stable, concatenates individual hashes then hashes the result).
hash_files() {
  local combined=""
  for f in "$@"; do
    combined="${combined}$(hash_file "${f}")"
  done
  echo "${combined}" | { command -v sha256sum &>/dev/null && sha256sum | cut -d' ' -f1; } \
    || echo "${combined}" | { command -v shasum &>/dev/null && shasum -a 256 | cut -d' ' -f1; } \
    || echo "${combined}"
}
