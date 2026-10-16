#!/usr/bin/env bash
# Extracted byte-for-byte from .github/workflows/factory-teammate.yml
# @ a4cd62f (step: Quarantine poisoned fa session) — stage-2 de-bloat.
# Behavior contract: identical. Invoke with `bash -e` (the GH runner default
# shell for inline `run:`); env block stays on the workflow step.
  FA_TRACE="${GITHUB_WORKSPACE}/.dmtools/fa-trace.log"
  SESS_DIR="${GITHUB_WORKSPACE}/.dmtools/fa-sessions"
  silence_limit="${FA_TRACE_QUARANTINE_SILENCE_MINUTES:-5}"
  if [ ! -f "${FA_TRACE}" ]; then
    echo "no fa trace — cannot judge session health; leaving the session in place"
    exit 0
  fi
  mtime="$(stat -c %Y "${FA_TRACE}" 2>/dev/null || stat -f %m "${FA_TRACE}" 2>/dev/null || echo 0)"
  age_min=$(( ( $(date +%s) - mtime ) / 60 ))
  if [ "${age_min}" -lt "${silence_limit}" ]; then
    echo "fa trace was active ${age_min} min ago (< ${silence_limit}) — the session was working; keeping it for the next leg"
    exit 0
  fi
  echo "::warning::fa session poisoned: leg '${AGENT_OUTCOME}' with the trace silent for ${age_min} min (limit ${silence_limit}) — quarantining the session and deleting ${FA_SESS_BRANCH} so the next leg starts fresh"
  QUAR_DIR="${GITHUB_WORKSPACE}/.dmtools/fa-sessions-quarantine/run-${GITHUB_RUN_ID}-attempt-${GITHUB_RUN_ATTEMPT}"
  mkdir -p "$(dirname "${QUAR_DIR}")"
  if [ -d "${SESS_DIR}" ]; then
    mv "${SESS_DIR}" "${QUAR_DIR}"
    echo "→ session store moved to .dmtools/fa-sessions-quarantine/ (the persist step below will find nothing)"
  else
    echo "→ no local session store to quarantine"
  fi
  { echo ""
    echo "🧟 FA-SESSION-QUARANTINE: leg '${AGENT_OUTCOME}' with the trace silent for ${age_min} min — session quarantined, ${FA_SESS_BRANCH} deleted; the next leg starts a fresh session."
  } >> "${GITHUB_WORKSPACE}/.dmtools/run-output.txt" 2>/dev/null || true
  # The restore step reads refs/heads/fa-sess/<anchor> — drop it, or
  # the next leg restores the poison despite the local quarantine
  # (the persist step early-exits on the missing dir and never
  # overwrites the branch with anything else).
  if git push origin --delete "${FA_SESS_BRANCH}" 2>/dev/null; then
    echo "→ ${FA_SESS_BRANCH} deleted — the next leg starts a fresh session"
  else
    echo "::error::could not delete ${FA_SESS_BRANCH} — the next leg may restore the poisoned session; delete the branch manually"
  fi
