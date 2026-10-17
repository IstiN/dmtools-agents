#!/usr/bin/env bash
# Extracted byte-for-byte from .github/workflows/factory-teammate.yml
# @ a4cd62f (step: Run agent (fa provider via runner env overrides), body slice) — stage-2 de-bloat.
# Behavior contract: identical. Runs BACKGROUND (`... &`) from the run step, like the inline
# `( ... ) &` subshell it replaces; env block stays on the workflow step.
  # fa-trace staleness watchdog: the fa session streams EVERY turn
  # and tool call into FA_LOG_FILE, so a healthy leg touches it
  # constantly. If the file goes quiet mid-run the session is
  # brain-dead (live: dmd PR-266 legs — process alive, dmtools
  # timer ticking, fa trace silent from the first minute, step
  # in_progress forever). Without this the leg ZOMBIES: nothing
  # fails, no verdict is produced, the SM never re-queues. On
  # staleness: marker into run-output (post-actions + artifacts
  # carry it, so the failure is diagnosable, not silent), then
  # kill dmtools — its non-zero exit fails the step and the
  # standard red path takes over. FA_TRACE_STALE_MINUTES defaults
  # to 10 (healthy legs write every few seconds; ten quiet minutes
  # is unambiguous). Tunable per repo via a workflow env if a
  # provider ever proves slower.
    stale_limit="${FA_TRACE_STALE_MINUTES:-10}"
    while sleep 60; do
      [ -f "${FA_LOG_FILE}" ] || continue
      mtime="$(stat -c %Y "${FA_LOG_FILE}" 2>/dev/null || stat -f %m "${FA_LOG_FILE}" 2>/dev/null || echo 0)"
      [ "${mtime}" != "0" ] || continue
      age_min=$(( ( $(date +%s) - mtime ) / 60 ))
      if [ "${age_min}" -ge "${stale_limit}" ]; then
        {
          echo ""
          echo "🛑 FA-TRACE-STALE-WATCHDOG: no agent output for ${age_min} min" \
               "(limit ${stale_limit}) at $(date -u +%FT%TZ) — the agent session is presumed hung."
          echo "FA-TRACE-STALE-WATCHDOG=1 (diagnose via the fa-trace artifact; the leg fails and the SM red path re-queues)"
        } | tee -a "${RUN_OUTPUT}"
        echo "::error::fa-trace stale for ${age_min} min (limit ${stale_limit}) — agent session presumed hung; failing the leg"
        # Best-effort kill: dmtools first (its death non-zeros the
        # step), then the orphaned fa provider child.
        pkill -f "dmtools run" 2>/dev/null || true
        pkill -f "fa --session" 2>/dev/null || true
        exit 0
      fi
    done
