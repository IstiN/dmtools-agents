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

  case "$(detect_ci)" in
    bitrise)
      # envman prepends the value; pass only the new dir so PATH doesn't balloon.
      command -v envman &>/dev/null \
        && envman add --key PATH --value "${dir}" \
        || true
      ;;
    github)
      [ -n "${GITHUB_PATH:-}" ] && echo "${dir}" >> "${GITHUB_PATH}" || true
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
    local) ;;
  esac
}

# ── Helpers ───────────────────────────────────────────────────────────────────

is_installed() { command -v "$1" &>/dev/null; }

section() { echo ""; echo "▶ $*"; echo ""; }

# Resolve "tool:version" argument → sets TOOL_NAME and TOOL_VERSION
parse_tool_arg() {
  local arg="$1"
  TOOL_NAME="${arg%%:*}"
  TOOL_VERSION="${arg#*:}"
  [ "${TOOL_VERSION}" = "${TOOL_NAME}" ] && TOOL_VERSION=""  # no colon → empty
}

