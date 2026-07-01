#!/bin/bash
# create_test_commit.sh
# Used by story_development_dynamic_repo_test.json to verify the dynamic-repo pipeline
# without running a real AI agent.
#
# After preCliDevelopmentSetupDynamicRepo.js checks out a feature branch in
# ./dependencies/{repo}/, that directory is on a non-master/develop branch.
# This script finds it, creates a test file, and commits it so that
# postDevelopTicketDynamicRepo.js can push and open a real MR.
set -euo pipefail

FOUND_DIR=""
FOUND_BRANCH=""

for dir in ./dependencies/*/; do
    if [ -d "${dir}.git" ]; then
        branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
        # Look specifically for Jira-style ticket branches: KEY-123-some-slug
        if echo "$branch" | grep -qE '^[A-Z]+-[0-9]+-'; then
            FOUND_DIR="$dir"
            FOUND_BRANCH="$branch"
            break
        fi
    fi
done

if [ -z "$FOUND_DIR" ]; then
    echo "ERROR: No feature branch found in ./dependencies/. Did preCliJSAction run correctly?" >&2
    exit 1
fi

echo "✅ Found feature branch '${FOUND_BRANCH}' in ${FOUND_DIR}"

TEST_FILE="${FOUND_DIR}test-agent-$(date +%s).txt"
cat > "$TEST_FILE" <<EOF
Test file created by story_development_dynamic_repo agent test
Branch: ${FOUND_BRANCH}
Timestamp: $(date -u '+%Y-%m-%dT%H:%M:%SZ')
EOF

git -C "$FOUND_DIR" add .
git -C "$FOUND_DIR" commit -m "test: verify dynamic-repo agent MR creation [${FOUND_BRANCH}]"

echo "✅ Test commit created in ${FOUND_DIR}"
