#!/bin/bash
# Local replica of .github/workflows/quality.yml 'crap' job (measure-only; never pushes).
# Usage: ./measure_crap.sh [report-output.txt]
set -e
RT=/tmp/crap-rt
rm -rf "$RT"
mkdir -p "$RT/cov"
cd "$(dirname "$0")"

echo ">> instrumenting tree"
/tmp/craptools/node_modules/.bin/nyc instrument --cwd . . "$RT/inst" > /dev/null
rsync -a --exclude '*.js' --exclude '.git' ./ "$RT/inst/"
(cd "$RT/inst" && git init -q && git add -A -f . > /dev/null 2>&1 || true)

echo ">> running node harness with coverage"
cd "$RT/inst"
FILES="$(node -e "console.log(require('./js/unit-tests/run_all.json').params.jobParams.testFiles.join(' '))")"
# CI runners carry no FA_* session env — unset them so env-sensitive suites see CI conditions.
env -u FA_SESSION_ROOT -u FA_SESSION_NAME -u FAH_SESSION_FILE -u FA_LOG_FILE -u FA_PROVIDER_CONFIG -u FA_PROVIDER_TYPE -u FA_PROVIDERS_QUEUE \
  node ci/run_with_coverage.js \
  "$RT/inst/js/unit-tests/node_testRunner.js" \
  "$RT/cov/coverage-final.json" $FILES > "$RT/harness.log" 2>&1
code=$?
tail -3 "$RT/harness.log"
if [ $code -ne 0 ]; then echo "!! harness FAILED ($code)"; exit $code; fi

echo ">> crap4js ratchet vs released baseline (analyzer runs on the real checkout — same as CI)"
cd "$(dirname "$0")"
/tmp/craptools/node_modules/.bin/crap4js . \
  --coverage "$RT/cov/coverage-final.json" \
  --threshold 8 \
  --baseline /tmp/base/crap-baseline.json > "$RT/crap.txt" || true
head -12 "$RT/crap.txt"
OUT=${1:-/tmp/crap-report.txt}
grep -E '^(regression|improved|new) ' "$RT/crap.txt" > "$OUT" || true
node -e "
const c = JSON.parse(require('fs').readFileSync('$RT/coverage-final.json','utf8'));
" 2>/dev/null || true
echo ">> full report: $RT/crap.txt ; delta lines: $OUT"
