#!/bin/bash

# Simple test script for workflow debugging
# Adds a test word to README.md and creates outputs/response.md

set -e

echo "=== Simple Test Script ===" echo "Adding test word to README.md..."

# Create README.md if it doesn't exist
if [ ! -f README.md ]; then
    echo "# DMTools Agents" > README.md
fi

# Add a test word
echo "Test-$(date +%s)" >> README.md

echo "Creating outputs/response.md..."
mkdir -p outputs

cat > outputs/response.md <<'EOF'
## Test Run

This is a test run to verify the workflow execution.

### Changes Made

- Added test word to README.md
- Verified git operations

### Test Coverage

All workflow steps executed successfully.
EOF

echo "=== Test script completed successfully ==="
echo "Files modified:"
ls -la README.md outputs/response.md
