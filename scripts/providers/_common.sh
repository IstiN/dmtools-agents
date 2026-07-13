#!/bin/bash
# Common helpers shared by all run-agent provider subscripts.

# Record a *_usage.json file path to outputs/token_usage_files.json so that
# post-action JavaScript can discover usage summaries without relying on fs.
record_usage_file() {
  local usage_file="$1"
  local manifest="outputs/token_usage_files.json"
  mkdir -p outputs
  python3 - "$usage_file" "$manifest" << 'PYEOF'
import json
import os
import sys

usage_file = sys.argv[1]
manifest = sys.argv[2]

entries = []
if os.path.exists(manifest):
    try:
        with open(manifest, 'r', encoding='utf-8') as f:
            entries = json.load(f)
        if not isinstance(entries, list):
            entries = []
    except Exception:
        entries = []

if usage_file not in entries:
    entries.append(usage_file)

with open(manifest, 'w', encoding='utf-8') as f:
    json.dump(entries, f, indent=2)
PYEOF
}

# Record CodeGraph command usage to .dmtools/codegraph-usage.log
record_codegraph_usage() {
  local log_file="$1"
  if [ ! -s "$log_file" ]; then
    return 0
  fi

  local matches
  matches="$(grep -E '(^|[[:space:];|&])codegraph[[:space:]]+(context|query|callees|callers|impact|node|files|sync|affected|status)([[:space:]]|$)' "$log_file" || true)"
  if [ -z "$matches" ]; then
    return 0
  fi

  mkdir -p .dmtools
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$line" >> .dmtools/codegraph-usage.log
  done <<< "$matches"
}

# Creates a timestamp marker used by rescue_misplaced_outputs() to identify
# files written *during* the upcoming CLI invocation (as opposed to files
# that already existed in some dependency checkout beforehand).
# Call this immediately before invoking the CLI provider.
start_output_rescue_marker() {
  mktemp
}

# Defense-in-depth against agent working-directory drift.
#
# Coding-agent CLIs (Claude Code, Copilot CLI, etc.) typically run their Bash
# tool as ONE persistent shell across the whole session — a `cd` in one tool
# call carries over to every later call, including the final `Write` of
# outputs/response.md (or outputs/pr_review.json, outputs/pr_review_comments/*.md,
# etc). When an agent explores a dependency checkout (`cd dependencies/<repo>
# && ...`) to read source while producing its own output, and never `cd`s
# back to the job root before writing outputs/*, those files silently land
# under dependencies/<repo>/outputs/... instead of ./outputs/. The agent's own
# tool result still reports success ("File created successfully at:
# outputs/response.md") because that path really was created — just relative
# to the wrong cwd. Left undetected, dmtools then reports "did not produce
# output file", skips the Jira field update, and posts a giant raw-log
# fallback comment that itself is too long to post — a fully silent failure
# with no usable content anywhere.
#
# This rescues ANY output file misplaced this way — not just response.md —
# by searching for other outputs/ directories created/modified since
# start_output_rescue_marker() was called, and copying their newer files up
# into the job's own ./outputs/. It never overwrites a file that's already
# correctly present at the real ./outputs/ path (that one is trusted as
# authoritative).
#
# Usage:
#   local marker; marker="$(start_output_rescue_marker)"
#   run_claude_code || exit_code=$?
#   rescue_misplaced_outputs "$marker"
#   rm -f "$marker"
rescue_misplaced_outputs() {
  local start_marker="$1"
  local root_outputs="./outputs"
  local rescued=0

  if [ -z "$start_marker" ] || [ ! -e "$start_marker" ]; then
    return 0
  fi

  local candidate_dir
  while IFS= read -r -d '' candidate_dir; do
    local misplaced_file
    while IFS= read -r -d '' misplaced_file; do
      local rel_path="${misplaced_file#"${candidate_dir}"/}"
      local dest="${root_outputs}/${rel_path}"
      if [ -e "$dest" ]; then
        echo "⚠️  Found misplaced output '${misplaced_file}' but '${dest}' already exists at the job root — leaving both, not overwriting"
        continue
      fi
      mkdir -p "$(dirname "$dest")"
      if cp -p "$misplaced_file" "$dest" 2>/dev/null; then
        echo "⚠️  Rescued misplaced output: '${misplaced_file}' -> '${dest}' (agent's shell working directory likely drifted into '${candidate_dir%/outputs}' before writing — check its final cd/pwd discipline)"
        rescued=$((rescued + 1))
      fi
    done < <(find "$candidate_dir" -type f -newer "$start_marker" -print0 2>/dev/null)
  done < <(find . -maxdepth 6 -type d -name outputs \
              -not -path "./outputs" \
              -not -path "*/.git/*" \
              -not -path "*/node_modules/*" \
              -not -path "*/vendor/*" \
              -print0 2>/dev/null)

  if [ "$rescued" -gt 0 ]; then
    echo "⚠️  Rescued ${rescued} misplaced output file(s) into ${root_outputs}/ — see warnings above."
  fi

  return 0
}
