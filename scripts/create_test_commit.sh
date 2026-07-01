#!/bin/bash
# create_test_commit.sh
# Used by story_development_dynamic_repo_test.json to verify the dynamic-repo pipeline
# without running a real AI agent.
#
# Reads the target working directory from .dmtools-target-workingdir written by
# preCliDevelopmentSetupDynamicRepo.js (which parses [repo] from the ticket summary).
# This avoids duplicating the repo-resolution logic in bash.
set -euo pipefail

TARGET_FILE=".dmtools-target-workingdir"

if [ ! -f "$TARGET_FILE" ]; then
    echo "ERROR: $TARGET_FILE not found. Did preCliJSAction (preCliDevelopmentSetupDynamicRepo.js) run?" >&2
    exit 1
fi

FOUND_DIR=$(cat "$TARGET_FILE")

if [ -z "$FOUND_DIR" ] || [ ! -d "$FOUND_DIR" ]; then
    echo "ERROR: workingDir '$FOUND_DIR' from $TARGET_FILE is empty or does not exist" >&2
    exit 1
fi

FOUND_BRANCH=$(git -C "$FOUND_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
echo "✅ Target repo dir: ${FOUND_DIR} (branch: ${FOUND_BRANCH})"

TEST_FILE="${FOUND_DIR}/test-agent-$(date +%s).txt"
cat > "$TEST_FILE" <<EOF
Test file created by story_development_dynamic_repo agent test
Branch: ${FOUND_BRANCH}
Timestamp: $(date -u '+%Y-%m-%dT%H:%M:%SZ')
EOF

git -C "$FOUND_DIR" add .
git -C "$FOUND_DIR" commit -m "test: verify dynamic-repo agent MR creation [${FOUND_BRANCH}]"

echo "✅ Test commit created in ${FOUND_DIR}"
