/**
 * Unit tests for js/postMobileTestAutomationResultsHelpers.js — pure helpers
 * extracted from js/postMobileTestAutomationResults.js (gh-979 CRAP split).
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

function loadMobileHelpers() {
    return loadModule(
        'js/postMobileTestAutomationResultsHelpers.js',
        makeRequire({}),
        {}
    );
}

// ── Suite: parseOutcome ──────────────────────────────────────────────────────

suite('postMobileTestAutomationResultsHelpers: parseOutcome', function() {

    test('parses passed status', function() {
        var h = loadMobileHelpers();
        var outcome = h.parseOutcome({ status: 'passed' });
        assert.equal(outcome.status, 'passed');
        assert.equal(outcome.passed, true);
        assert.equal(outcome.blockedByHuman, false);
    });

    test('parses failed status case-insensitively', function() {
        var h = loadMobileHelpers();
        var outcome = h.parseOutcome({ status: 'FAILED' });
        assert.equal(outcome.status, 'failed');
        assert.equal(outcome.passed, false);
        assert.equal(outcome.blockedByHuman, false);
    });

    test('parses blocked_by_human status case-insensitively', function() {
        var h = loadMobileHelpers();
        var outcome = h.parseOutcome({ status: 'Blocked_By_Human' });
        assert.equal(outcome.status, 'blocked_by_human');
        assert.equal(outcome.passed, false);
        assert.equal(outcome.blockedByHuman, true);
    });

    test('treats missing or malformed result as empty failed outcome', function() {
        var h = loadMobileHelpers();
        var empty = h.parseOutcome(null);
        assert.equal(empty.status, '');
        assert.equal(empty.passed, false);
        assert.equal(empty.blockedByHuman, false);
        var noStatus = h.parseOutcome({});
        assert.equal(noStatus.status, '');
        assert.equal(noStatus.passed, false);
    });

});

// ── Suite: hasA11yWarnings ───────────────────────────────────────────────────

suite('postMobileTestAutomationResultsHelpers: hasA11yWarnings', function() {

    test('detects per-TC a11y warnings', function() {
        var h = loadMobileHelpers();
        var result = { results: [
            { status: 'passed' },
            { status: 'passed', a11y_warnings: ['button has no label'] }
        ] };
        assert.equal(h.hasA11yWarnings(result), true);
    });

    test('detects top-level a11y_warnings array', function() {
        var h = loadMobileHelpers();
        assert.equal(h.hasA11yWarnings({ results: [], a11y_warnings: ['contrast'] }), true);
    });

    test('returns false when no warnings anywhere', function() {
        var h = loadMobileHelpers();
        assert.equal(h.hasA11yWarnings({ results: [{ status: 'passed' }] }), false);
        assert.equal(h.hasA11yWarnings({ results: [], a11y_warnings: [] }), false);
        assert.equal(h.hasA11yWarnings({}), false);
        assert.equal(h.hasA11yWarnings(null), false);
    });

});

// ── Suite: decideLabels / decideFeatureTarget ────────────────────────────────

suite('postMobileTestAutomationResultsHelpers: config decisions', function() {

    test('decideLabels uses defaults when customParams are absent', function() {
        var h = loadMobileHelpers();
        var labels = h.decideLabels({});
        assert.equal(labels.labelPassed, 'tests_passed');
        assert.equal(labels.labelFailed, 'tests_failed');
        assert.equal(labels.testFilesPath, 'src/tests/');
    });

    test('decideLabels reads custom label names and glob', function() {
        var h = loadMobileHelpers();
        var labels = h.decideLabels({
            labels: { testsPassed: 'qa_approved', testsFailed: 'qa_rejected' },
            testFilesGlob: 'src/flows/'
        });
        assert.equal(labels.labelPassed, 'qa_approved');
        assert.equal(labels.labelFailed, 'qa_rejected');
        assert.equal(labels.testFilesPath, 'src/flows/');
    });

    test('decideFeatureTarget defaults to empty owner/repo', function() {
        var h = loadMobileHelpers();
        var target = h.decideFeatureTarget({});
        assert.equal(target.owner, '');
        assert.equal(target.repo, '');
        var custom = h.decideFeatureTarget({ featurePR: { owner: 'Org', repo: 'app' } });
        assert.equal(custom.owner, 'Org');
        assert.equal(custom.repo, 'app');
    });

    test('decideWipLabel prefers contextId over the mobile default', function() {
        var h = loadMobileHelpers();
        assert.equal(h.decideWipLabel({ contextId: 'story_123' }), 'story_123_wip');
        assert.equal(h.decideWipLabel({}), 'mobile_test_automation_wip');
        assert.equal(h.decideWipLabel(null), 'mobile_test_automation_wip');
    });

    test('decideSmTriggerLabel returns removeLabel or null', function() {
        var h = loadMobileHelpers();
        assert.equal(h.decideSmTriggerLabel({ removeLabel: 'sm_trigger' }), 'sm_trigger');
        assert.equal(h.decideSmTriggerLabel({}), null);
        assert.equal(h.decideSmTriggerLabel(null), null);
    });

});

// ── Suite: resolveFeatureSummary ─────────────────────────────────────────────

suite('postMobileTestAutomationResultsHelpers: resolveFeatureSummary', function() {

    test('returns pr_feature_update.md content without fallback', function() {
        var h = loadMobileHelpers();
        var reads = [];
        var summary = h.resolveFeatureSummary(function(path) {
            reads.push(path);
            return path === 'pr_feature_update.md' ? '## Update' : null;
        });
        assert.deepEqual(summary, { content: '## Update', fallback: false });
        assert.deepEqual(reads, ['pr_feature_update.md'], 'should not read pr_body.md when primary exists');
    });

    test('falls back to pr_body.md and flags the fallback', function() {
        var h = loadMobileHelpers();
        var reads = [];
        var summary = h.resolveFeatureSummary(function(path) {
            reads.push(path);
            return path === 'pr_body.md' ? '## Body' : null;
        });
        assert.deepEqual(summary, { content: '## Body', fallback: true });
        assert.deepEqual(reads, ['pr_feature_update.md', 'pr_body.md']);
    });

    test('returns null when neither file exists', function() {
        var h = loadMobileHelpers();
        assert.equal(h.resolveFeatureSummary(function() { return null; }), null);
    });

});

// ── Suite: verdict prefix decision ───────────────────────────────────────────

suite('postMobileTestAutomationResultsHelpers: verdict prefix', function() {

    test('needsVerdictPrefix detects existing verdict sections', function() {
        var h = loadMobileHelpers();
        assert.equal(h.needsVerdictPrefix('**Verdict**: passed'), true);
        assert.equal(h.needsVerdictPrefix('## Test Results'), true);
        assert.equal(h.needsVerdictPrefix('| Passed | count |'), true);
        assert.equal(h.needsVerdictPrefix('| Failed | count |'), true);
        assert.equal(h.needsVerdictPrefix('## Automated Test Coverage Added'), false);
        assert.equal(h.needsVerdictPrefix(''), false);
    });

    test('prependVerdictIfNeeded prepends built verdict when summary lacks one', function() {
        var h = loadMobileHelpers();
        var built = '## Verdict\n\npassed\n\n';
        var out = h.prependVerdictIfNeeded('## Coverage', { status: 'passed' }, function() { return built; });
        assert.equal(out, built + '## Coverage');
    });

    test('prependVerdictIfNeeded leaves summary untouched when verdict present', function() {
        var h = loadMobileHelpers();
        var called = false;
        var out = h.prependVerdictIfNeeded('## Test Results\nall good', { status: 'passed' }, function() {
            called = true;
            return 'X';
        });
        assert.equal(out, '## Test Results\nall good');
        assert.equal(called, false, 'verdict builder must not run when summary already has one');
    });

    test('prependVerdictIfNeeded leaves summary untouched when result is null', function() {
        var h = loadMobileHelpers();
        var out = h.prependVerdictIfNeeded('## Coverage', null, function() { return 'X'; });
        assert.equal(out, '## Coverage');
    });

});

// ── Suite: comment builders ──────────────────────────────────────────────────

suite('postMobileTestAutomationResultsHelpers: comment builders', function() {

    test('buildBlockedComment includes reason and missing setup items', function() {
        var h = loadMobileHelpers();
        var comment = h.buildBlockedComment({
            blocked_reason: 'No simulator',
            missing: [
                { name: 'APP_PATH', description: 'Built .app path' },
                { name: 'MAESTRO_DEVICE' }
            ]
        });
        assert.ok(comment.indexOf('h3. 🚫 Test Automation Blocked — Awaiting Human Setup') === 0);
        assert.ok(comment.indexOf('No simulator') !== -1);
        assert.ok(comment.indexOf('*APP_PATH*: Built .app path') !== -1);
        assert.ok(comment.indexOf('*MAESTRO_DEVICE*\n') !== -1);
        assert.ok(comment.indexOf('move this ticket back to *Backlog*') !== -1);
    });

    test('buildBlockedComment omits empty sections', function() {
        var h = loadMobileHelpers();
        var comment = h.buildBlockedComment({});
        assert.ok(comment.indexOf('h3. 🚫 Test Automation Blocked — Awaiting Human Setup') === 0);
        assert.ok(comment.indexOf('h4. Required setup') === -1, 'no missing items → no setup section');
        assert.ok(comment.indexOf('undefined') === -1, 'no undefined leakage');
    });

    test('buildMissingResultComment flags resumed runs and automation PR', function() {
        var h = loadMobileHelpers();
        var plain = h.buildMissingResultComment(false, null);
        assert.ok(plain.indexOf('h3. ⚠️ Test Automation Error') === 0);
        assert.ok(plain.indexOf('Resume was attempted') === -1);
        assert.ok(plain.indexOf('Automation PR') === -1);
        var full = h.buildMissingResultComment(true, 'https://github.com/org/repo/pull/1');
        assert.ok(full.indexOf('_Resume was attempted but also did not produce output files._') !== -1);
        assert.ok(full.indexOf('*Automation PR*: https://github.com/org/repo/pull/1') !== -1);
    });

    test('buildErrorComment wraps the error in a Jira code block', function() {
        var h = loadMobileHelpers();
        var comment = h.buildErrorComment(new Error('boom'));
        assert.equal(comment, 'h3. ❌ Test Automation Error\n\n{code}Error: boom{code}');
    });

});

// ── Suite: feature-PR label pair decision (gh-1083) ──────────────────────────

suite('postMobileTestAutomationResultsHelpers: decideFeaturePrLabels', function() {

    test('passed → adds the passed label and removes the failed one', function() {
        var h = loadMobileHelpers();
        assert.deepEqual(h.decideFeaturePrLabels(true, 'tests_passed', 'tests_failed'),
            { addLabel: 'tests_passed', removeLabel: 'tests_failed' });
    });

    test('failed → adds the failed label and removes the passed one', function() {
        var h = loadMobileHelpers();
        assert.deepEqual(h.decideFeaturePrLabels(false, 'tests_passed', 'tests_failed'),
            { addLabel: 'tests_failed', removeLabel: 'tests_passed' });
    });

    test('falsy passed (null/undefined) behaves like failed', function() {
        var h = loadMobileHelpers();
        assert.equal(h.decideFeaturePrLabels(null, 'p', 'f').addLabel, 'f');
        assert.equal(h.decideFeaturePrLabels(undefined, 'p', 'f').removeLabel, 'p');
    });

    test('custom label names flow through unchanged', function() {
        var h = loadMobileHelpers();
        assert.deepEqual(h.decideFeaturePrLabels(true, 'qa_approved', 'qa_rejected'),
            { addLabel: 'qa_approved', removeLabel: 'qa_rejected' });
    });

});

// ── Suite: gh-1189 result-count derivation ───────────────────────────────────

suite('postMobileTestAutomationResultsHelpers: result-count derivation', function() {

    test('parseMcpPrList accepts plain arrays and {data} wrappers', function() {
        var h = loadMobileHelpers();
        assert.deepEqual(h.parseMcpPrList([{ number: 1 }]), [{ number: 1 }]);
        assert.deepEqual(h.parseMcpPrList({ data: [{ number: 2 }] }), [{ number: 2 }]);
        assert.deepEqual(h.parseMcpPrList({}), []);
        assert.deepEqual(h.parseMcpPrList(null), []);
    });

    test('classifyResultStatus maps error to failed', function() {
        var h = loadMobileHelpers();
        assert.equal(h.classifyResultStatus('passed'), 'passed');
        assert.equal(h.classifyResultStatus('PASSED'), 'passed');
        assert.equal(h.classifyResultStatus('skipped'), 'skipped');
        assert.equal(h.classifyResultStatus('failed'), 'failed');
        assert.equal(h.classifyResultStatus('error'), 'failed');
        assert.equal(h.classifyResultStatus('written'), null);
        assert.equal(h.classifyResultStatus(''), null);
        assert.equal(h.classifyResultStatus(null), null);
    });

    test('countResultStatuses tallies multi-item result sets', function() {
        var h = loadMobileHelpers();
        var counts = h.countResultStatuses([
            { status: 'passed' },
            { status: 'error' },
            { status: 'failed' },
            { status: 'skipped' },
            { status: 'passed' },
            { status: 'written' }
        ]);
        assert.deepEqual(counts, { passed: 2, failed: 2, skipped: 1 });
    });

    test('countResultStatuses returns zeroes for empty input', function() {
        var h = loadMobileHelpers();
        assert.deepEqual(h.countResultStatuses([]), { passed: 0, failed: 0, skipped: 0 });
    });

    test('mergeFallbackCounts fills only the null keys', function() {
        var h = loadMobileHelpers();
        var merged = h.mergeFallbackCounts(
            { passed: 2, failed: null, skipped: null },
            { passed: 9, failed: 1, skipped: 3 });
        assert.deepEqual(merged, { passed: 2, failed: 1, skipped: 3 });
    });

    test('mergeFallbackCounts keeps all top-level numbers when present', function() {
        var h = loadMobileHelpers();
        var merged = h.mergeFallbackCounts(
            { passed: 1, failed: 2, skipped: 3 },
            { passed: 9, failed: 9, skipped: 9 });
        assert.deepEqual(merged, { passed: 1, failed: 2, skipped: 3 });
    });

    test('finalizeCounts turns nulls into zeroes', function() {
        var h = loadMobileHelpers();
        assert.deepEqual(h.finalizeCounts({ passed: 1, failed: null, skipped: null }),
            { passed: 1, failed: 0, skipped: 0 });
        assert.deepEqual(h.finalizeCounts({ passed: null, failed: null, skipped: null }),
            { passed: 0, failed: 0, skipped: 0 });
    });

    test('decideNoStagedChanges treats empty captures as no changes', function() {
        var h = loadMobileHelpers();
        assert.equal(h.decideNoStagedChanges(''), true);
        assert.equal(h.decideNoStagedChanges('   \n'), true);
        assert.equal(h.decideNoStagedChanges(null), true);
        assert.equal(h.decideNoStagedChanges(undefined), true);
        assert.equal(h.decideNoStagedChanges('2 files changed'), false);
    });

});
