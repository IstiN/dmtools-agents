#!/bin/bash
# create_test_commit.sh
# Used by story_development_dynamic_repo_test / gens-igt/story_development_test agents.
#
# Reads the target working directory from .dmtools-target-workingdir written by
# preCliDevelopmentSetupDynamicRepo.js (which parses [repo] from the ticket summary).
#
# Does NOT commit — instead it creates a test file (unstaged) and writes
# outputs/response.md at the project root so that postJSAction (developTicketAndCreatePR)
# detects work was done, runs git add + commit + push + gitlab_create_mr.
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

# Create test file in target repo (unstaged — postJSAction will git add + commit + push)
TEST_FILE="${FOUND_DIR}/test-agent-$(date +%s).txt"
cat > "$TEST_FILE" <<EOF
Test file created by story_development_dynamic_repo agent test
Branch: ${FOUND_BRANCH}
Timestamp: $(date -u '+%Y-%m-%dT%H:%M:%SZ')
EOF
echo "✅ Test file created: ${TEST_FILE}"

# Write response.md at project root so postJSAction (developTicketAndCreatePR)
# does not treat this as an interrupted run and proceeds with push + MR creation.
mkdir -p outputs
cat > outputs/response.md <<EOF
## Test Run

This MR was created by \`story_development_dynamic_repo_test\` to verify the dynamic-repo pipeline.

- Target repo: ${FOUND_DIR}
- Branch: ${FOUND_BRANCH}
- Timestamp: $(date -u '+%Y-%m-%dT%H:%M:%SZ')
EOF
echo "✅ outputs/response.md written — postJSAction will proceed with push + MR"

