#!/usr/bin/env bash
# Extracted byte-for-byte from .github/workflows/factory-teammate.yml
# @ a4cd62f (step: Collect fa crash log (uncaught errors live outside the workspace)) — stage-2 de-bloat.
# Behavior contract: identical. Invoke with `bash -e` (the GH runner default
# shell for inline `run:`); env block stays on the workflow step.
  mkdir -p .dmtools
  if [ -f "${HOME}/.fah/crash.log" ]; then
    cp "${HOME}/.fah/crash.log" .dmtools/fa-crash.log
    echo "fa crash log collected ($(wc -l < .dmtools/fa-crash.log) lines)"
  else
    echo "no fa crash log (${HOME}/.fah/crash.log absent)"
  fi
