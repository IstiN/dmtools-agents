/**
 * Unit tests for js/common/bugBookkeeping.js — the shared "load bug
 * bookeeping" helper (gh-1329 review): both legs that consult the TC run
 * registry and the maintenance ledger (postStoryTestAutomationResults.js
 * and developBugAndCreatePR.js) go through ONE loader — one getIssue call,
 * one machine-author resolution, fail-closed without a configured identity.
 */

var machineAuthor = loadModule('js/common/machineAuthor.js', makeRequire({}));
var reviewVerdicts = loadModule('js/common/reviewVerdicts.js', makeRequire({
    './machineAuthor.js': machineAuthor
}));
var tcRunRegistry = loadModule('js/common/tcRunRegistry.js', makeRequire({
    './reviewVerdicts.js': reviewVerdicts
}));
var tcLedger = loadModule('js/common/tcMaintenanceLedger.js', makeRequire({
    './reviewVerdicts.js': reviewVerdicts
}));
var bugBookkeeping = loadModule('js/common/bugBookkeeping.js', makeRequire({
    './tcRunRegistry.js': tcRunRegistry,
    './tcMaintenanceLedger.js': tcLedger,
    './machineAuthor.js': machineAuthor
}));

var REGISTRY_MARKER = '<!-- dmtools:tc-run-registry {"v":1,"at":"2026-01-01T00:00:00.000Z","tcs":{"TS-1":{"validated":true,"lastGreenSha":"sha-a"}}} -->';
var LEDGER_MARKER = '<!-- dmtools:tc-maintenance-ledger {"v":1,"at":"2026-01-02T00:00:00.000Z","findings":[{"id":"x","tcKey":"TS-2"}]} -->';

function trackerOf(comments, counter) {
    return {
        getIssue: function(args) {
            if (counter) counter.getIssueCount++;
            return { fields: { comment: { comments: comments } } };
        }
    };
}

var PARAMS = { jobParams: { machineAuthor: 'ai-teammate' } };

suite('bugBookkeeping: the shared bug bookkeeping loader', function() {

    test('loads the trusted registry and ledger records in one getIssue call', function() {
        var counter = { getIssueCount: 0 };
        var tracker = trackerOf([
            { body: REGISTRY_MARKER, user: { login: 'ai-teammate' } },
            { body: LEDGER_MARKER, user: { login: 'ai-teammate' } }
        ], counter);
        var b = bugBookkeeping.loadBugBookkeeping(tracker, 'BUG-1', PARAMS, {});
        assert.equal(counter.getIssueCount, 1, 'the bug ticket is fetched once');
        assert.ok(b.registry.tcs && b.registry.tcs['TS-1'], 'the trusted registry record is loaded');
        assert.equal(b.ledger.findings.length, 1, 'the trusted ledger record is loaded');
    });

    test('no trusted records degrades to empty registry + ledger', function() {
        var tracker = trackerOf([{ body: REGISTRY_MARKER, user: { login: 'rando' } }]);
        var b = bugBookkeeping.loadBugBookkeeping(tracker, 'BUG-1', PARAMS, {});
        assert.deepEqual(b.registry.tcs, {});
        assert.deepEqual(b.ledger.findings, []);
    });

    test('no configured machine author trusts nothing (fail closed)', function() {
        var tracker = trackerOf([{ body: LEDGER_MARKER, user: { login: 'ai-teammate' } }]);
        var b = bugBookkeeping.loadBugBookkeeping(tracker, 'BUG-1', { jobParams: {} }, {});
        assert.deepEqual(b.ledger.findings, []);
    });

    test('a failing getIssue degrades to empty bookkeeping with a warning', function() {
        var warnings = [];
        var orig = console.warn;
        console.warn = function() { warnings.push(Array.prototype.slice.call(arguments).map(String).join(' ')); };
        var b;
        try {
            b = bugBookkeeping.loadBugBookkeeping({
                getIssue: function() { throw new Error('tracker down'); }
            }, 'BUG-1', PARAMS, {});
        } finally {
            console.warn = orig;
        }
        assert.deepEqual(b.registry.tcs, {});
        assert.deepEqual(b.ledger.findings, []);
        assert.ok(warnings.some(function(w) { return w.indexOf('bug comments') !== -1; }),
            'the read failure is logged, not swallowed');
    });

    test('machineAuthorOptsOf resolves jobParams.machineAuthor then config.machineAuthor', function() {
        assert.deepEqual(bugBookkeeping.machineAuthorOptsOf(PARAMS, {}),
            { authorLogins: ['ai-teammate'] });
        assert.deepEqual(bugBookkeeping.machineAuthorOptsOf({ jobParams: {} }, { machineAuthor: 'cfg-bot' }),
            { authorLogins: ['cfg-bot'] });
        assert.deepEqual(bugBookkeeping.machineAuthorOptsOf({}, {}), { authorLogins: [] });
    });
});
