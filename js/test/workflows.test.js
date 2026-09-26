/**
 * Unit tests for the factory-teammate.yml guard step
 * ("Decide whether this event is for the agent").
 *
 * Regression coverage for the duplicate dev/rework-leg dispatch bug:
 * event-triggered runs (issues:assigned, labeled, ...) sit QUEUED behind the
 * per-issue concurrency group and carry a github.event.issue payload that is
 * a snapshot from trigger time. A guard that trusts the payload misses labels
 * the already-running leg has since applied (status:In Development,
 * status:In Rework) and dispatches a duplicate leg (live: dmtools-dart run
 * 36252718919 for issue #257; a duplicate rework dispatch for #259).
 *
 * The guard must ALWAYS refresh labels/assignees from the GitHub API and fall
 * back to the event payload only when the API read fails.
 *
 * Runs with plain Node.js: the guard `run:` block is extracted from the
 * workflow YAML and executed in bash against a stubbed `gh` binary, so no
 * network calls or real GitHub state are touched.
 *
 *   node js/test/workflows.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'factory-teammate.yml');

// ---- extract the guard script from the workflow YAML -------------------------

function extractGuardScript() {
    const lines = fs.readFileSync(WORKFLOW, 'utf8').split('\n');
    const stepIdx = lines.findIndex(l => l.includes('Decide whether this event is for the agent'));
    assert.ok(stepIdx !== -1, 'guard step not found in factory-teammate.yml');
    const runIdx = lines.findIndex((l, i) => i > stepIdx && l.trim().startsWith('run: |'));
    assert.ok(runIdx !== -1, 'guard run block not found');
    const runIndent = lines[runIdx].length - lines[runIdx].trimStart().length;
    const body = [];
    for (let i = runIdx + 1; i < lines.length; i++) {
        const l = lines[i];
        if (l.trim() === '') { body.push(''); continue; }
        const indent = l.length - l.trimStart().length;
        if (indent <= runIndent) break;
        body.push(l.slice(runIndent + 2));
    }
    return body.join('\n') + '\n';
}

const GUARD_SCRIPT = extractGuardScript();

// ---- gh stub -----------------------------------------------------------------
// Dispatches on the `--json <fields>` argument and prints the post-`jq -q`
// value from GH_STUB_* env vars. Fields listed in GH_STUB_FAIL exit 1,
// simulating an API read failure.

const GH_STUB = `#!/usr/bin/env bash
json=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--json" ]; then json="$a"; break; fi
  prev="$a"
done
case ",\${GH_STUB_FAIL:-}," in
  *",$json,"*) echo "stub gh: forced failure for --json $json" >&2; exit 1 ;;
esac
case "$json" in
  labels)    printf '%s\\n' "\${GH_STUB_LABELS:-}" ;;
  assignees) printf '%s\\n' "\${GH_STUB_ASSIGNEES:-}" ;;
  state)     printf '%s\\n' "\${GH_STUB_STATE:-OPEN}" ;;
  title)     printf '%s\\n' "\${GH_STUB_TITLE:-A story}" ;;
  *) echo "stub gh: unexpected --json $json (args: $*)" >&2; exit 1 ;;
esac
`;

const DMTOOLS_CONFIG = `module.exports = { sm: { runners: {
    dev: 'runners/dev.json', review: 'runners/review.json', rework: 'runners/rework.json'
} } };
`;

// ---- guard runner ------------------------------------------------------------

function runGuard(opts) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
    try {
        fs.mkdirSync(path.join(dir, 'bin'));
        fs.mkdirSync(path.join(dir, '.dmtools'));
        fs.writeFileSync(path.join(dir, 'bin', 'gh'), GH_STUB, { mode: 0o755 });
        fs.writeFileSync(path.join(dir, '.dmtools', 'config.js'), DMTOOLS_CONFIG);
        fs.writeFileSync(path.join(dir, 'guard.sh'), GUARD_SCRIPT);
        const outputFile = path.join(dir, 'github_output');
        fs.writeFileSync(outputFile, '');

        const env = Object.assign({}, process.env, {
            PATH: path.join(dir, 'bin') + path.delimiter + process.env.PATH,
            NUMBER: '257',
            PR_NUMBER: '',
            LABELS: opts.payloadLabels || '',
            ASSIGNEES: opts.payloadAssignees || '',
            ACTOR: opts.actor || 'assigned',
            INPUT_LEG: opts.inputLeg || '',
            INPUT_REASON: opts.inputReason || '',
            AGENT_HANDLE: 'ai-teammate',
            GITHUB_OUTPUT: outputFile,
            GITHUB_REPOSITORY: 'owner/repo',
            GH_TOKEN: 'stub-token',
            GH_STUB_LABELS: opts.liveLabels != null ? opts.liveLabels : (opts.payloadLabels || ''),
            GH_STUB_ASSIGNEES: opts.liveAssignees != null ? opts.liveAssignees : (opts.payloadAssignees || ''),
            GH_STUB_STATE: opts.liveState || 'OPEN',
            GH_STUB_TITLE: opts.liveTitle || 'A story',
            GH_STUB_FAIL: opts.stubFail || ''
        });

        const log = execFileSync('bash', ['-e', 'guard.sh'], { cwd: dir, env, encoding: 'utf8' });
        const outputs = {};
        for (const line of fs.readFileSync(outputFile, 'utf8').split('\n')) {
            const eq = line.indexOf('=');
            if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
        }
        return { outputs, log };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ---- tiny test harness ---------------------------------------------------------

let failures = 0;
function test(name, fn) {
    try {
        fn();
        console.log('  ✅', name);
    } catch (e) {
        failures++;
        console.log('  ❌', name);
        console.log('     ' + (e && e.message ? e.message : e));
    }
}

// ---- tests ---------------------------------------------------------------------

console.log('\n── guard: event-triggered runs refresh the stale payload ──');

test('assigned event: payload lacks status:In Development, live API has it → guard skips (no duplicate dev leg)', () => {
    // Issue assigned to ai-teammate; while this run sat queued, the live dev
    // leg already started and applied status:In Development. The payload is
    // from trigger time and does NOT carry the label.
    const r = runGuard({
        actor: 'assigned',
        payloadLabels: 'enhancement',
        payloadAssignees: 'ai-teammate',
        liveLabels: 'enhancement status:In Development',
        liveAssignees: 'ai-teammate'
    });
    assert.strictEqual(r.outputs.run, 'false',
        'guard must skip — the dev leg is already running (log: ' + r.log.trim().split('\n').pop() + ')');
});

test('labeled event: payload has agent:rework without status:In Rework, live API has both → guard skips (no duplicate rework leg)', () => {
    const r = runGuard({
        actor: 'labeled',
        payloadLabels: 'agent:rework',
        liveLabels: 'agent:rework status:In Rework'
    });
    assert.strictEqual(r.outputs.run, 'false',
        'guard must skip — the rework leg is already running');
});

test('event run with genuinely fresh state still dispatches (fresh review handoff)', () => {
    const r = runGuard({
        actor: 'labeled',
        payloadLabels: 'agent:review',
        liveLabels: 'agent:review'
    });
    assert.strictEqual(r.outputs.run, 'true');
    assert.strictEqual(r.outputs.runner, 'runners/review.json');
    assert.strictEqual(r.outputs.config, 'factory-agents/pr_review.json');
    assert.strictEqual(r.outputs.kind, 'review');
});

test('event run: fresh assignment with no in-flight labels still dispatches dev', () => {
    const r = runGuard({
        actor: 'assigned',
        payloadLabels: '',
        payloadAssignees: 'ai-teammate',
        liveLabels: '',
        liveAssignees: 'ai-teammate'
    });
    assert.strictEqual(r.outputs.run, 'true');
    assert.strictEqual(r.outputs.runner, 'runners/dev.json');
    assert.strictEqual(r.outputs.kind, 'dev');
});

console.log('\n── guard: API read failure falls back to the event payload ──');

test('labels/assignees API failure → payload fallback keeps working', () => {
    const r = runGuard({
        actor: 'labeled',
        payloadLabels: 'agent:review',
        stubFail: 'labels,assignees',
        liveLabels: 'status:In Development' // unreachable — API read fails
    });
    assert.strictEqual(r.outputs.run, 'true');
    assert.strictEqual(r.outputs.runner, 'runners/review.json');
    assert.ok(r.log.includes('falling back to the (possibly stale) event payload'),
        'guard should log a fallback warning, log was: ' + r.log);
});

console.log('\n── guard: workflow_dispatch path unchanged ──');

test('explicit rework dispatch dispatches the rework runner', () => {
    const r = runGuard({
        actor: 'workflow_dispatch',
        inputLeg: 'rework',
        liveLabels: 'agent:rework status:In Rework'
    });
    assert.strictEqual(r.outputs.run, 'true');
    assert.strictEqual(r.outputs.runner, 'runners/rework.json');
    assert.strictEqual(r.outputs.config, 'factory-agents/pr_rework.json');
    assert.ok(r.log.includes('→ dispatch: leg=rework'), 'dispatch audit line missing: ' + r.log);
});

test('explicit dev dispatch on a bug dispatches the bug dev pipeline', () => {
    const r = runGuard({
        actor: 'workflow_dispatch',
        inputLeg: 'dev',
        liveLabels: 'bug',
        liveTitle: '[BUG] something is broken'
    });
    assert.strictEqual(r.outputs.run, 'true');
    assert.strictEqual(r.outputs.runner, 'runners/dev.json');
    assert.strictEqual(r.outputs.config, 'factory-agents/bug_development.json');
});

test('explicit review dispatch still refreshes from the API and dispatches review', () => {
    const r = runGuard({
        actor: 'workflow_dispatch',
        inputLeg: 'review',
        liveLabels: 'agent:review'
    });
    assert.strictEqual(r.outputs.run, 'true');
    assert.strictEqual(r.outputs.runner, 'runners/review.json');
    assert.strictEqual(r.outputs.config, 'factory-agents/pr_review.json');
});

console.log('\n── guard: terminal states ──');

test('closed issue never dispatches, even for an explicit leg', () => {
    const r = runGuard({
        actor: 'workflow_dispatch',
        inputLeg: 'dev',
        liveState: 'CLOSED'
    });
    assert.strictEqual(r.outputs.run, 'false');
});

// ---- summary -------------------------------------------------------------------

console.log('');
if (failures > 0) {
    console.log('❌ ' + failures + ' workflow guard test(s) failed');
    process.exit(1);
}
console.log('✅ All workflow guard tests passed');
