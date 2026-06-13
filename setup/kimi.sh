#!/usr/bin/env bash
# Install Kimi Code CLI (kimi).
#
# Usage:
#   kimi.sh [version]
#   KIMI_VERSION=latest kimi.sh
#
# Cache path: ~/.kimi-code
# Config path: ~/.config/kimi/config.toml
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/_common.sh"

KIMI_VERSION="${1:-${KIMI_VERSION:-}}"
KIMI_INSTALL_DIR="${HOME}/.kimi-code"
KIMI_BIN_DIR="${KIMI_INSTALL_DIR}/bin"
KIMI_CONFIG_DIR="${HOME}/.kimi-code"
KIMI_CONFIG_FILE="${KIMI_CONFIG_DIR}/config.toml"

# ── Write config ──────────────────────────────────────────────────────────────
_write_config() {
  if [ -z "${KIMI_API_KEY:-}" ]; then
    echo "ℹ️  KIMI_API_KEY not set — skipping config creation"
    return 0
  fi

  mkdir -p "${KIMI_CONFIG_DIR}"

  cat > "${KIMI_CONFIG_FILE}" <<EOF
default_model = "kimi-for-coding"
default_thinking = true
default_plan_mode = false
merge_all_available_skills = true
extra_skill_dirs = []
telemetry = true

[providers.kimi-code]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = "${KIMI_API_KEY}"

[models.kimi-for-coding]
provider = "kimi-code"
model = "kimi-for-coding"
max_context_size = 262144
capabilities = ["thinking", "image_in"]
display_name = "Kimi for Coding"

[loop_control]
max_steps_per_turn = 999999999
max_retries_per_step = 3
max_ralph_iterations = -1
reserved_context_size = 50000
compaction_trigger_ratio = 0.85

[background]
max_running_tasks = 4
read_max_bytes = 30000
notification_tail_lines = 20
notification_tail_chars = 3000
wait_poll_interval_ms = 500
worker_heartbeat_interval_ms = 5000
worker_stale_after_ms = 15000
kill_grace_period_ms = 2000
keep_alive_on_exit = false
agent_task_timeout_s = 900
print_wait_ceiling_s = 3600

[services.moonshot_search]
base_url = "https://api.kimi.com/coding/v1/search"
api_key = "${KIMI_API_KEY}"

[services.moonshot_fetch]
base_url = "https://api.kimi.com/coding/v1/fetch"
api_key = "${KIMI_API_KEY}"
EOF

  echo "✅ kimi config written: ${KIMI_CONFIG_FILE}"
}

# ── Configure isolated Kimi session for AI Teammate runs ──────────────────────
_configure_session() {
  # When running inside AI Teammate, derive a stable session id per
  # repo:ticket:agent_group and isolate KIMI_CODE_HOME so the session can be
  # cached and resumed across CI runs.
  if [ -z "${AI_TEAMMATE_CONFIG_FILE:-}" ]; then
    return 0
  fi
  if [ -f "${SCRIPT_DIR}/kimi-session.sh" ]; then
    # shellcheck source=/dev/null
    source "${SCRIPT_DIR}/kimi-session.sh" env
  fi
}

echo "🌙 Kimi Code CLI"

# ── Already installed? ────────────────────────────────────────────────────────
if is_installed kimi; then
  echo "✅ kimi already installed: $(kimi --version 2>/dev/null || echo "cached")"
  _write_config
  _configure_session
  exit 0
fi

if [ -x "${KIMI_BIN_DIR}/kimi" ]; then
  register_path "${KIMI_BIN_DIR}"
  echo "✅ kimi already installed: ${KIMI_BIN_DIR}/kimi"
  _write_config
  _configure_session
  exit 0
fi

# ── Install ───────────────────────────────────────────────────────────────────
echo "📥 Installing kimi-code..."

mkdir -p "${KIMI_BIN_DIR}"

INSTALL_ENV=()
if [ -n "${KIMI_VERSION}" ]; then
  INSTALL_ENV+=(env "KIMI_VERSION=${KIMI_VERSION}")
fi
INSTALL_ENV+=(env "KIMI_NO_MODIFY_PATH=1")

"${INSTALL_ENV[@]}" bash -c 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash'

if [ -x "${KIMI_BIN_DIR}/kimi" ]; then
  register_path "${KIMI_BIN_DIR}"
  echo "✅ kimi installed: ${KIMI_BIN_DIR}/kimi"
  _write_config
  _configure_session
else
  echo "⚠️  kimi could not be installed automatically."
  echo "    Install manually: curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"
fi
