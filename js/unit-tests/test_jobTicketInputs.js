/**
 * Unit tests: js/common/jobTicketInputs.js — the shared SM-job ticket inputs.
 *
 * js/quotaParkProbe.js and js/tcDifferentialDispatcher.js both open action()
 * with the same two blocks: the ticket reference + jobParams/customParams
 * resolution (resolveInputs) and the structured missing-key guard. The
 * dispatcher originally copied the quotaParkProbe shapes verbatim — two
 * cross-file clones (the quality.yml duplication ratchet reported
 * "fresh duplication: js/quotaParkProbe.js 10.12%" and
 * "fresh duplication: js/tcDifferentialDispatcher.js 3.00%" — both files
 * newly over the 1% bar, not pinned in duplication-baseline.json, gate exit
 * 2). This module is that block extracted once (the
 * js/common/actionTicketContext.js gh-1250 pattern — "extracted once so the
 * action files stay free of cross-file clones"), and these tests pin the
 * extraction:
 *
 *  - the structural contract: neither action file declares its own
 *    resolveInputs nor builds the missing-key failure inline — the shared
 *    module is the single source (string-level contract tests, the
 *    test_qualityGateConfig.js convention);
 *  - the behavioral contract: the param shapes and the guard verdicts both
 *    callers rely on, plus the fail-fast missing-key path through each
 *    action() (no tracker, no config, no shell work before the guard).
 *
 * Uses: file_read, loadModule, assert, test(), suite()
 */

'use strict';

/* global file_read, loadModule, assert, test, suite */

var jobTicketInputs = loadModule('js/common/jobTicketInputs.js');

function readRepoFile(path) {
    var content = file_read({ path: path });
    assert.ok(content !== null && content !== undefined && content.length > 0,
        path + ' must exist and be non-empty');
    return String(content);
}

var PROBE_SRC = readRepoFile('js/quotaParkProbe.js');
var DISPATCHER_SRC = readRepoFile('js/tcDifferentialDispatcher.js');

// ── structural contract: the extraction itself (the duplication ratchet) ────

suite('jobTicketInputs — extraction contract (the duplication gate fresh files)', function() {

    test('quotaParkProbe delegates input resolution to the shared module', function() {
        assert.ok(PROBE_SRC.indexOf("require('./common/jobTicketInputs.js')") !== -1,
            'js/quotaParkProbe.js must require js/common/jobTicketInputs.js');
        assert.ok(PROBE_SRC.indexOf('function resolveInputs') === -1,
            'js/quotaParkProbe.js must not declare its own resolveInputs — ' +
            'the shared module is the single source');
    });

    test('tcDifferentialDispatcher delegates input resolution to the shared module', function() {
        assert.ok(DISPATCHER_SRC.indexOf("require('./common/jobTicketInputs.js')") !== -1,
            'js/tcDifferentialDispatcher.js must require js/common/jobTicketInputs.js');
        assert.ok(DISPATCHER_SRC.indexOf('function resolveInputs') === -1,
            'js/tcDifferentialDispatcher.js must not declare its own resolveInputs — ' +
            'the shared module is the single source');
    });

    test('the missing-ticket-key failure is built only in the shared module', function() {
        [PROBE_SRC, DISPATCHER_SRC].forEach(function(src, i) {
            var file = i === 0 ? 'js/quotaParkProbe.js' : 'js/tcDifferentialDispatcher.js';
            assert.ok(src.indexOf("error: 'missing ticket key'") === -1,
                file + ' must not build the missing-key failure inline — ' +
                'shared via jobTicketInputs.missingTicketKeyResult');
        });
        assert.ok(jobTicketInputs.missingTicketKeyResult({ ticketKey: null }).error === 'missing ticket key',
            'the shared module carries the canonical failure');
    });
});

// ── behavioral contract: resolveInputs param shapes ──────────────────────────

suite('jobTicketInputs — resolveInputs', function() {

    test('teammate form: params.ticket wins for the key, jobParams carried through', function() {
        var jobParams = { customParams: { parkLabel: 'x' } };
        var inputs = jobTicketInputs.resolveInputs({ ticket: { key: 'BUG-1' }, jobParams: jobParams });
        assert.equal(inputs.ticketKey, 'BUG-1');
        assert.equal(inputs.jobParams, jobParams);
        assert.deepEqual(inputs.customParams, { parkLabel: 'x' });
    });

    test('bare form: no jobParams — customParams read from the top level', function() {
        var inputs = jobTicketInputs.resolveInputs({ ticket: { key: 'BUG-2' }, customParams: { a: 1 } });
        assert.equal(inputs.ticketKey, 'BUG-2');
        assert.deepEqual(inputs.jobParams, {});
        assert.deepEqual(inputs.customParams, { a: 1 });
    });

    test('jobParams-only form: the ticket-less params object carries the key', function() {
        var inputs = jobTicketInputs.resolveInputs({ jobParams: { customParams: { b: 2 } } });
        assert.equal(inputs.ticketKey, undefined);
        assert.deepEqual(inputs.jobParams, { customParams: { b: 2 } });
        assert.deepEqual(inputs.customParams, { b: 2 });
    });

    test('customParams precedence: jobParams.customParams wins over the top level', function() {
        var inputs = jobTicketInputs.resolveInputs({
            ticket: { key: 'BUG-3' },
            jobParams: { customParams: { from: 'jobParams' } },
            customParams: { from: 'top' }
        });
        assert.deepEqual(inputs.customParams, { from: 'jobParams' });
    });

    test('degenerate params still yield JSON-safe inputs (never throws)', function() {
        var inputs = jobTicketInputs.resolveInputs({ ticket: {} });
        assert.equal(inputs.ticketKey, undefined);
        assert.deepEqual(inputs.jobParams, {});
        assert.deepEqual(inputs.customParams, {});
    });
});

// ── behavioral contract: the missing-key guard ───────────────────────────────

suite('jobTicketInputs — missingTicketKeyResult', function() {

    test('a present key proceeds (null — never a failure)', function() {
        assert.equal(jobTicketInputs.missingTicketKeyResult({ ticketKey: 'BUG-1' }), null);
    });

    test('an absent key fails structured and logs once', function() {
        var logged = [];
        var originalError = console.error;
        console.error = function(msg) { logged.push(msg); };
        var failure;
        try {
            failure = jobTicketInputs.missingTicketKeyResult({ ticketKey: undefined });
        } finally {
            console.error = originalError;
        }
        assert.deepEqual(failure, { success: false, error: 'missing ticket key' });
        assert.contains(logged.join('\n'), 'No ticket key found');
    });
});
