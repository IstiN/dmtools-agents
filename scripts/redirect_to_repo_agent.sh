#!/bin/bash
# redirect_to_repo_agent.sh
# Called by story_development_redirect*.json as cliCommands.
#
# Usage: redirect_to_repo_agent.sh <agent-filename>
#   agent-filename: e.g. story_development.json, story_development_test.json
#
# Reads .dmtools-target-repo and .dmtools-target-ticket written by
# resolveRepoNameToFile.js (preJSAction) and runs:
#   dmtools run "{repo}/{agent-filename}" --inputJql "key={ticket}"
set -euo pipefail

AGENT_NAME="${1:-story_development.json}"

REPO=$(cat .dmtools-target-repo 2>/dev/null || true)
TICKET=$(cat .dmtools-target-ticket 2>/dev/null || true)

if [ -z "$REPO" ]; then
    echo "ERROR: .dmtools-target-repo is empty or missing. Did preJSAction (resolveRepoNameToFile.js) run?" >&2
    exit 1
fi
if [ -z "$TICKET" ]; then
    echo "ERROR: .dmtools-target-ticket is empty or missing." >&2
    exit 1
fi

AGENT="${REPO}/${AGENT_NAME}"

if [ ! -f "$AGENT" ]; then
    echo "ERROR: Agent config not found: $AGENT" >&2
    exit 1
fi

echo "🔀 Redirecting: $TICKET → $AGENT"
dmtools run "$AGENT" --inputJql "key=${TICKET}"
