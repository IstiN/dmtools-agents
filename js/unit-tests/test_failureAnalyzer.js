/**
 * Unit tests for failureAnalyzer.js — gh-136, the AI failure-analyzer leg.
 *
 * The module is the pure half of the failure-analysis state machine:
 *   - the SM-config knob resolution (missing → disabled silently; malformed
 *     → hard error — AC7),
 *   - the same-signature streak math (reusing the gh-1363 normalizer — no
 *     second implementation) and the threshold-crossing rule (AC1/AC2/AC6),
 *   - the analyzer verdict marker (reviewVerdicts house pattern: a machine
 *     parseable `<!-- dmtools:failure-verdict ... -->` comment) and its
 *     machine-identity-gated parse,
 *   - the ONE park-diagnostic comment builder and its idempotency counter
 *     (AC3).
 *
 * The scripted-provider replay of the whole acceptance matrix (AC1–AC5)
 * lives in test_machineSmAgent.js — this file pins the pure contract.
 */
/* global suite, test, assert, loadModule, makeRequire */

function lfrShared() {
    if (!lfrShared.mod) lfrShared.mod = loadModule('js/common/legFailureReport.js', makeRequire({}), {});
    return lfrShared.mod;
}

function rvShared() {
    if (!rvShared.mod) rvShared.mod = loadModule('js/common/reviewVerdicts.js',
        makeRequire({ './machineAuthor.js': maShared() }), {});
    return rvShared.mod;
}

function maShared() {
    if (!maShared.mod) maShared.mod = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
    return maShared.mod;
}

function faShared() {
    if (!faShared.mod) {
        faShared.mod = loadModule('js/common/failureAnalyzer.js', makeRequire({
            './legFailureReport.js': lfrShared(),
            './reviewVerdicts.js': rvShared()
        }), {});
    }
    return faShared.mod;
}

var MARKDOWN = {
    h: function (level, text) {
        var prefix = '';
        for (var i = 0; i < level; i++) prefix += '#';
        return prefix + ' ' + text;
    },
    bold: function (text) { return '**' + text + '**'; },
    inline: function (text) { return '`' + text + '`'; },
    code: function (text) { return '```\n' + text + '\n```'; },
    link: function (text, url) { return '[' + text + '](' + url + ')'; }
};

/** One failure-notice comment body carrying the gh-1363 signature line. */
function failureBody(lfr, workflow, step, message) {
    var sig = lfr.failureSignature({ workflow: workflow, step: step, message: message });
    return lfr.buildFailureComment({
        phase: 'setup', step: step, excerpt: message, signature: sig
    }, MARKDOWN);
}

/** One machine-authored analyzer verdict comment body. */
function verdictComment(fa, record, author) {
    return { user: { login: author || 'github-actions[bot]' },
             body: fa.buildFailureVerdictComment(record) };
}

suite('failureAnalyzer config (gh-136 AC7)', function () {
    var fa = faShared();

    test('missing config disables the feature silently — no error, no behavior change', function () {
        assert.deepEqual(fa.resolveFailureAnalysisConfig(undefined), { enabled: false });
        assert.deepEqual(fa.resolveFailureAnalysisConfig(null), { enabled: false });
    });

    test('an empty block enables the feature with the documented defaults', function () {
        var cfg = fa.resolveFailureAnalysisConfig({});
        assert.equal(cfg.enabled, true);
        assert.equal(cfg.afterFailures, 4, 'the ticket default is 4');
        assert.equal(cfg.blockedLabel, 'sm:leg-blocked');
        assert.equal(cfg.backoff, 1, 'backoff defaults OFF (= no multiplier)');
    });

    test('a fully specified block normalizes verbatim', function () {
        var cfg = fa.resolveFailureAnalysisConfig({
            afterFailures: 3, blockedLabel: 'my:blocked', backoff: 2
        });
        assert.equal(cfg.enabled, true);
        assert.equal(cfg.afterFailures, 3);
        assert.equal(cfg.blockedLabel, 'my:blocked');
        assert.equal(cfg.backoff, 2);
    });

    test('malformed block shapes hard-error (SM start validation)', function () {
        assert.throws(function () { fa.resolveFailureAnalysisConfig('enabled'); });
        assert.throws(function () { fa.resolveFailureAnalysisConfig(4); });
        assert.throws(function () { fa.resolveFailureAnalysisConfig([]); });
    });

    test('malformed afterFailures hard-errors', function () {
        assert.throws(function () { fa.resolveFailureAnalysisConfig({ afterFailures: 'four' }); });
        assert.throws(function () { fa.resolveFailureAnalysisConfig({ afterFailures: 0 }); });
        assert.throws(function () { fa.resolveFailureAnalysisConfig({ afterFailures: -1 }); });
        assert.throws(function () { fa.resolveFailureAnalysisConfig({ afterFailures: 2.5 }); });
        assert.throws(function () { fa.resolveFailureAnalysisConfig({ afterFailures: NaN }); });
    });

    test('an explicit null knob means unset (JSON-friendly), taking the default', function () {
        var cfg = fa.resolveFailureAnalysisConfig({ afterFailures: null, blockedLabel: null, backoff: null });
        assert.equal(cfg.enabled, true);
        assert.equal(cfg.afterFailures, 4);
        assert.equal(cfg.blockedLabel, 'sm:leg-blocked');
        assert.equal(cfg.backoff, 1);
    });

    test('malformed blockedLabel / backoff hard-error', function () {
        assert.throws(function () { fa.resolveFailureAnalysisConfig({ blockedLabel: 42 }); });
        assert.throws(function () { fa.resolveFailureAnalysisConfig({ blockedLabel: '' });
        });
        assert.throws(function () { fa.resolveFailureAnalysisConfig({ backoff: 0 }); });
        assert.throws(function () { fa.resolveFailureAnalysisConfig({ backoff: 'slow' }); });
        assert.throws(function () { fa.resolveFailureAnalysisConfig({ backoff: -2 }); });
    });
});

suite('failureAnalyzer streak math (gh-136 AC1/AC2/AC6)', function () {
    var fa = faShared();
    var lfr = lfrShared();

    test('failureStreak counts the trailing same-signature run (multi-failure)', function () {
        var bodies = [
            failureBody(lfr, 'ai-teammate.yml', 'Development Setup', 'npm ci failed'),
            failureBody(lfr, 'ai-teammate.yml', 'Development Setup', 'npm ci failed 2026-11-04T09:00:00Z'),
            failureBody(lfr, 'ai-teammate.yml', 'Development Setup', 'npm ci failed 123456789')
        ];
        var streak = fa.failureStreak(bodies);
        assert.ok(streak, 'a streak exists');
        assert.equal(streak.count, 3, 'three identical failures — noise (timestamps, run ids) normalized away');
        assert.ok(streak.signature.indexOf('ai-teammate.yml') !== -1);
        assert.ok(streak.signature.indexOf('Development Setup') !== -1);
    });

    test('different-signature failures never merge into one streak (AC6)', function () {
        var bodies = [
            failureBody(lfr, 'ai-teammate.yml', 'Development Setup', 'npm ci failed'),
            failureBody(lfr, 'ai-teammate.yml', 'Development Setup', 'npm ci failed'),
            failureBody(lfr, 'ai-teammate.yml', 'Rework Push', 'tests red'),
            failureBody(lfr, 'ai-teammate.yml', 'Development Setup', 'npm ci failed')
        ];
        var streak = fa.failureStreak(bodies);
        assert.equal(streak.count, 1, 'the interleaved different signature breaks the streak');
        assert.ok(streak.signature.indexOf('Development Setup') !== -1);
    });

    test('failureStreak is null without failure history', function () {
        assert.equal(fa.failureStreak([]), null);
        assert.equal(fa.failureStreak(['just a human comment']), null);
        assert.equal(fa.failureStreak(null), null);
    });

    test('consumedCount: the analyzed prefix of this signature only, max wins', function () {
        var sig = 'ai-teammate.yml | Development Setup | npm ci failed';
        var other = 'ai-teammate.yml | Rework Push | tests red';
        var verdicts = [
            { signature: sig, classification: 'transient', analyzedAtCount: 4, at: '2026-11-05T10:00:00.000Z' },
            { signature: sig, classification: 'transient', analyzedAtCount: 8, at: '2026-11-05T11:00:00.000Z' },
            { signature: other, classification: 'transient', analyzedAtCount: 99, at: '2026-11-05T12:00:00.000Z' },
            { signature: sig, classification: 'transient', analyzedAtCount: null, at: '2026-11-05T13:00:00.000Z' }
        ];
        assert.equal(fa.consumedCount(verdicts, sig), 8, 'the deepest analysis of THIS signature consumes');
        assert.equal(fa.consumedCount(verdicts, other), 99);
        assert.equal(fa.consumedCount(verdicts, 'unanalyzed | s | m'), 0);
        assert.equal(fa.consumedCount([], sig), 0);
    });

    test('analysisDue: exactly the threshold crossing (AC1 + the AC5 crash latch)', function () {
        var after = 4;
        assert.equal(fa.analysisDue(1, 0, after), false, 'below the threshold: blind retry');
        assert.equal(fa.analysisDue(3, 0, after), false, 'three identical failures: no analyzer dispatch');
        assert.equal(fa.analysisDue(4, 0, after), true, 'the fourth dispatches the analyzer');
        assert.equal(fa.analysisDue(5, 0, after), false, 'past the crossing: blind retry (analyzer crashed — AC5)');
        assert.equal(fa.analysisDue(4, 4, after), false, 'already analyzed and consumed (park resume) — never re-analyze');
        assert.equal(fa.analysisDue(8, 4, after), true, 'a NEW identical streak reaches the threshold again (AC2)');
        assert.equal(fa.analysisDue(7, 4, after), false, 'the new streak is still below the threshold');
        assert.equal(fa.analysisDue(0, 0, after), false);
        assert.equal(fa.analysisDue(null, 0, after), false);
    });

    test('effectiveStreakCount never goes negative on weird markers', function () {
        assert.equal(fa.effectiveStreakCount(2, 5), 0, 'a consumed count above the streak clamps to 0');
        assert.equal(fa.effectiveStreakCount(8, 4), 4);
    });
});

suite('failureAnalyzer verdict marker (gh-136 house protocol)', function () {
    var fa = faShared();

    function record(over) {
        return Object.assign({
            signature: 'ai-teammate.yml | Development Setup | npm ci failed',
            classification: 'transient',
            confidence: 0.82,
            suspected_root_cause: 'runner network outage',
            evidence: ['npm ERR! network ECONNRESET', 'run step exited 1'],
            suggested_fix: 'retry — the outage is transient',
            analyzedAtCount: 4,
            at: '2026-11-05T10:00:00.000Z',
            source: 'failure-analyzer'
        }, over || {});
    }

    test('build → parse round-trip preserves the structured verdict', function () {
        var body = fa.buildFailureVerdictComment(record());
        assert.ok(body, 'a valid record is postable');
        assert.ok(body.indexOf('<!-- dmtools:failure-verdict ') === 0, 'the marker is the FIRST line');
        var rows = [{ user: { login: 'github-actions[bot]' }, body: body }];
        var parsed = fa.parseFailureVerdicts(rows, { authorLogins: ['github-actions[bot]', 'ai-teammate'] });
        assert.equal(parsed.length, 1);
        var v = parsed[0];
        assert.equal(v.classification, 'transient');
        assert.equal(v.confidence, 0.82);
        assert.equal(v.suspected_root_cause, 'runner network outage');
        assert.deepEqual(v.evidence, ['npm ERR! network ECONNRESET', 'run step exited 1']);
        assert.equal(v.suggested_fix, 'retry — the outage is transient');
        assert.equal(v.analyzedAtCount, 4);
        assert.equal(v.signature, 'ai-teammate.yml | Development Setup | npm ci failed');
        assert.equal(v.source, 'failure-analyzer');
    });

    test('marker-hostile free text parses without breaking out of the marker', function () {
        var body = fa.buildFailureVerdictComment(record({
            suspected_root_cause: 'the step emits --> mid-log and <!-- looks like a marker'
        }));
        var parsed = fa.parseFailureVerdicts([{ user: { login: 'ai-teammate' }, body: body }],
            { authorLogins: ['ai-teammate'] });
        assert.equal(parsed.length, 1, 'the hostile text cannot terminate the marker early');
        assert.ok(parsed[0].suspected_root_cause.length > 40, 'the free text survives (sanitized)');
        assert.equal(parsed[0].suspected_root_cause.indexOf('-->'), -1,
            'the hostile sequence is neutralized — no marker spoofing from payload text');
    });

    test('an unknown classification or a missing signature is never postable', function () {
        assert.equal(fa.buildFailureVerdictComment(record({ classification: 'broken' })), null);
        assert.equal(fa.buildFailureVerdictComment(record({ signature: '' })), null);
        assert.equal(fa.buildFailureVerdictComment(record({ signature: null })), null);
        assert.equal(fa.buildFailureVerdictComment(null), null);
    });

    test('classification admits exactly transient | deterministic-infra', function () {
        assert.deepEqual(fa.CLASSIFICATIONS, ['transient', 'deterministic-infra']);
        var body = fa.buildFailureVerdictComment(record({ classification: 'deterministic-infra' }));
        var parsed = fa.parseFailureVerdicts([{ user: { login: 'ai-teammate' }, body: body }],
            { authorLogins: ['ai-teammate'] });
        assert.equal(parsed[0].classification, 'deterministic-infra');
    });

    test('machine-identity gate: a forged marker from a foreign author is invisible', function () {
        var body = fa.buildFailureVerdictComment(record());
        var rows = [
            { user: { login: 'somehuman' }, body: body },
            { user: { login: 'github-actions[bot]' }, body: body }
        ];
        var parsed = fa.parseFailureVerdicts(rows, { authorLogins: ['github-actions[bot]'] });
        assert.equal(parsed.length, 1, 'only the machine-authored marker is trusted');
        assert.equal(parsed[0].order, 1, 'the trusted record keeps its payload position');
    });

    test('fail closed: no machine logins configured → nothing is trusted', function () {
        var body = fa.buildFailureVerdictComment(record());
        var rows = [{ user: { login: 'ai-teammate' }, body: body }];
        assert.deepEqual(fa.parseFailureVerdicts(rows, {}), []);
        assert.deepEqual(fa.parseFailureVerdicts(rows, { authorLogins: [] }), []);
        assert.deepEqual(fa.parseFailureVerdicts(rows, null), []);
    });

    test('a malformed payload (bad classification / broken JSON) is dropped, never thrown', function () {
        var rows = [
            { user: { login: 'ai-teammate' }, body: '<!-- dmtools:failure-verdict {"classification":"weird","signature":"s"} -->' },
            { user: { login: 'ai-teammate' }, body: '<!-- dmtools:failure-verdict {broken json' },
            { user: { login: 'ai-teammate' }, body: 'no marker at all' }
        ];
        assert.deepEqual(fa.parseFailureVerdicts(rows, { authorLogins: ['ai-teammate'] }), []);
    });

    test('a malformed analyzedAtCount degrades to null (no consumption discount)', function () {
        var body = fa.buildFailureVerdictComment(record({ analyzedAtCount: 'four' }));
        var parsed = fa.parseFailureVerdicts([{ user: { login: 'ai-teammate' }, body: body }],
            { authorLogins: ['ai-teammate'] });
        assert.equal(parsed.length, 1);
        assert.equal(parsed[0].analyzedAtCount, null);
    });

    test('latestVerdictForSignature: newest wins, other signatures ignored', function () {
        var sig = 's | a | m';
        var older = record({ signature: sig, classification: 'transient', at: '2026-11-05T10:00:00.000Z' });
        var newer = record({ signature: sig, classification: 'deterministic-infra', at: '2026-11-05T12:00:00.000Z' });
        var elsewhere = record({ signature: 'other | s | m', classification: 'transient', at: '2026-11-05T13:00:00.000Z' });
        var rows = [
            verdictComment(fa, older),
            verdictComment(fa, elsewhere),
            verdictComment(fa, newer)
        ];
        var parsed = fa.parseFailureVerdicts(rows, { authorLogins: ['github-actions[bot]'] });
        var latest = fa.latestVerdictForSignature(parsed, sig);
        assert.equal(latest.classification, 'deterministic-infra', 'the newest record for THIS signature wins');
        assert.equal(fa.latestVerdictForSignature(parsed, 'unanalyzed | s | m'), null);
        assert.equal(fa.latestVerdictForSignature([], sig), null);
    });
});

suite('failureAnalyzer park diagnostic (gh-136 AC3)', function () {
    var fa = faShared();

    var VERDICT = {
        signature: 'ai-teammate.yml | Development Setup | npm ci failed',
        classification: 'deterministic-infra',
        confidence: 0.9,
        suspected_root_cause: 'setup script pins a deleted registry mirror',
        evidence: ['npm ERR! 404 not-found@1.0.0', 'exit code 1'],
        suggested_fix: 'update .npmrc to the live registry',
        analyzedAtCount: 4,
        at: '2026-11-05T10:00:00.000Z'
    };

    test('the diagnostic carries root cause, evidence, suggested fix and the resume gesture', function () {
        var body = fa.parkDiagnosticComment(VERDICT, 'sm:leg-blocked', MARKDOWN);
        assert.ok(body.indexOf('<!-- dmtools:failure-block ') === 0, 'the marker is the FIRST line');
        assert.ok(body.indexOf('deterministic-infra') !== -1);
        assert.ok(body.indexOf('setup script pins a deleted registry mirror') !== -1, 'root cause named');
        assert.ok(body.indexOf('npm ERR! 404 not-found@1.0.0') !== -1, 'evidence quoted');
        assert.ok(body.indexOf('update .npmrc to the live registry') !== -1, 'suggested fix named');
        assert.ok(body.indexOf('sm:leg-blocked') !== -1, 'the resume gesture names the label');
    });

    test('countParkComments counts machine markers only — quoted text never counts', function () {
        var body = fa.parkDiagnosticComment(VERDICT, 'sm:leg-blocked', MARKDOWN);
        var bodies = [
            'a human comment mentioning failure-block freely',
            body,
            'another human comment',
            fa.parkDiagnosticComment(Object.assign({}, VERDICT, { at: '2026-11-06T10:00:00.000Z' }), 'sm:leg-blocked', MARKDOWN)
        ];
        assert.equal(fa.countParkComments(bodies), 2, 'each machine diagnostic counts');
        assert.equal(fa.countParkComments([]), 0);
        assert.equal(fa.countParkComments(null), 0);
    });

    test('the diagnostic degrades gracefully when verdict fields are absent', function () {
        var body = fa.parkDiagnosticComment({
            signature: 's | a | m', classification: 'deterministic-infra'
        }, 'sm:leg-blocked', MARKDOWN);
        assert.ok(body.indexOf('<!-- dmtools:failure-block ') === 0);
        assert.ok(body.length > 40, 'still a useful human-readable comment');
    });
});
