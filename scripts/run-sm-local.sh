#!/usr/bin/env bash
# Convenience wrapper to run the SM (Scrum Master) agent (agents/sm.json) with
# forceLocalTeammate:true, without having to remember to keep the run log
# outside the repo's working tree.
#
# Why this exists: run-teammate-local.sh (invoked per-ticket by smAgent.js when
# a rule has `localTeammate: true`) REFUSES to run if the repo's working tree
# is dirty. It's easy to accidentally break this by redirecting `dmtools run`'s
# own stdout/stderr log INTO the repo directory (e.g. `> sm_run.log` while cd'd
# into the repo) — that untracked file alone is enough to trip the dirty-tree
# guard and fail every ticket. This script always resolves the log path to a
# sibling directory next to the repo root, never inside it.
#
# Usage:
#   run-sm-local.sh [--repo-dir PATH] [--log-dir PATH] [-- extra dmtools run args]
#
# Examples:
#   agents/scripts/run-sm-local.sh
#   agents/scripts/run-sm-local.sh --repo-dir /home/ubuntu/repo
#   agents/scripts/run-sm-local.sh -- --ciRunUrl "https://example/run/1"
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

REPO_DIR="${DEFAULT_REPO_DIR}"
LOG_DIR=""
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-dir)
      REPO_DIR="$2"
      shift 2
      ;;
    --log-dir)
      LOG_DIR="$2"
      shift 2
      ;;
    --)
      shift
      EXTRA_ARGS+=("$@")
      break
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

REPO_DIR="$(cd "${REPO_DIR}" && pwd)"

# Default log dir: a sibling of the repo dir (NEVER inside it), e.g.
# /home/ubuntu/repo -> /home/ubuntu/dmtools-run-logs
if [[ -z "${LOG_DIR}" ]]; then
  LOG_DIR="$(dirname "${REPO_DIR}")/dmtools-run-logs"
fi
mkdir -p "${LOG_DIR}"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_FILE="${LOG_DIR}/sm_run_${TIMESTAMP}.log"

DMTOOLS_BIN="${DMTOOLS_BIN:-dmtools}"

echo "Repo dir : ${REPO_DIR}"
echo "Log file : ${LOG_FILE}  (outside the repo — safe to leave untracked)"

cd "${REPO_DIR}"
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  echo "ERROR: ${REPO_DIR} has a dirty working tree — refusing to start (SM's" >&2
  echo "per-ticket local-teammate runs would fail the same way). Run 'git status'" >&2
  echo "in ${REPO_DIR} and clean it up first." >&2
  exit 1
fi

nohup "${DMTOOLS_BIN}" run agents/sm.json "{\"params\":{\"jobParams\":{\"forceLocalTeammate\":true}}}" "${EXTRA_ARGS[@]}" \
  > "${LOG_FILE}" 2>&1 &
SM_PID=$!

echo "Started SM (PID ${SM_PID}). Tail it with:"
echo "  tail -f ${LOG_FILE}"
