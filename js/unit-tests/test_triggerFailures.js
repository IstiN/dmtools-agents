/**
 * Unit tests: js/common/triggerFailures.js — the gh-922 fail-open dispatch
 * vocabulary (no-ref error classification, ⚠️ trigger-failed marker math,
 * dead-head park cap).
 */
/* global loadModule, assert, test, suite, makeRequire */

suite('triggerFailures (gh-922)', function () {

    var mod = loadModule('js/common/triggerFailures.js', makeRequire({}), {});

    suite('classifyTriggerError', function () {
        test('the GitHub no-ref shape classifies no-ref (422, any phrasing)', function () {
            assert.equal(mod.classifyTriggerError(
                '422: No ref found for: fix/browser-ext-manifest-json'), 'no-ref');
            assert.equal(mod.classifyTriggerError(
                'No ref found for: refs/heads/ai/gh-922'), 'no-ref');
            assert.equal(mod.classifyTriggerError(
                'HTTP 422: no ref found for the dispatch'), 'no-ref');
            assert.equal(mod.classifyTriggerError(
                'gh: workflow run failed (422) — ref missing'), 'no-ref');
        });

        test('transient failures classify transient (never head-dead evidence)', function () {
            assert.equal(mod.classifyTriggerError('500: Internal Server Error'), 'transient');
            assert.equal(mod.classifyTriggerError('API rate limit exceeded'), 'transient');
            assert.equal(mod.classifyTriggerError('401: Bad credentials'), 'transient');
            assert.equal(mod.classifyTriggerError('404: Not Found'), 'transient',
                'a missing WORKFLOW file 404 is a deployment problem — not head-dead evidence');
            assert.equal(mod.classifyTriggerError('422: Unprocessable Entity — invalid input'), 'transient',
                'a 422 that never mentions a ref (e.g. validation failures) is not no-ref');
            assert.equal(mod.classifyTriggerError(null), 'transient');
            assert.equal(mod.classifyTriggerError(undefined), 'transient');
        });
    });

    suite('triggerFailMarks / triggerFailMarkerLine', function () {
        test('marker line round-trips through the marks parser', function () {
            var line = mod.triggerFailMarkerLine(2, 'gone/deleted-branch', 3, '2026-10-16T14:00:00Z');
            assert.ok(line.indexOf('\u26A0\uFE0F trigger-failed gone/deleted-branch') === 0,
                'the line starts with the grep-able marker prefix');
            assert.ok(line.indexOf('attempt 2/3') !== -1, 'the line carries attempt N/cap');
            var marks = mod.triggerFailMarks([line]);
            assert.equal(marks['gone/deleted-branch'], 2,
                'the parser reads back exactly what the writer wrote');
        });

        test('the highest attempt wins; other branches and garbage lines are ignored', function () {
            var marks = mod.triggerFailMarks([
                '⚠️ trigger-failed a/one — attempt 1/3 at 2026-10-16T13:00:00Z',
                '⚠️ trigger-failed a/one — attempt 2/3 at 2026-10-16T13:05:00Z',
                '⚠️ trigger-failed a/one — attempt 1/3 at 2026-10-16T13:07:00Z', // duplicate, lower
                '⚠️ trigger-failed b/two — attempt 2/3 at 2026-10-16T13:00:00Z',
                'some other bot comment mentioning trigger-failed',
                '',
                null
            ]);
            assert.equal(marks['a/one'], 2, 'duplicate markers never inflate the count');
            assert.equal(marks['b/two'], 2, 'other branches count separately');
            assert.equal(Object.keys(marks).length, 2, 'garbage lines create no entries');
        });

        test('malformed marker lines are ignored — no count entry, never a throw', function () {
            var marks = mod.triggerFailMarks([
                '⚠️ trigger-failed c/three — attempt x/y at not-a-date'
            ]);
            assert.equal(marks['c/three'], undefined,
                'an unparsable line is ignored (zombie-marker parity) — the next parseable failure is attempt 1');
        });

        test('empty / null input yields an empty map', function () {
            assert.deepEqual(mod.triggerFailMarks([]), {});
            assert.deepEqual(mod.triggerFailMarks(null), {});
            assert.deepEqual(mod.triggerFailMarks(undefined), {});
        });
    });

    suite('capOf', function () {
        test('default is 3 (the gh-922 ask: "suggest 3")', function () {
            assert.equal(mod.capOf({}), 3);
            assert.equal(mod.capOf(undefined), 3);
            assert.equal(mod.capOf({ triggerFailParkCap: undefined }), 3);
        });

        test('jobParams override, string forms included', function () {
            assert.equal(mod.capOf({ triggerFailParkCap: 5 }), 5);
            assert.equal(mod.capOf({ triggerFailParkCap: '2' }), 2);
        });

        test("'false' / 0 / negative disable the bookkeeping", function () {
            assert.equal(mod.capOf({ triggerFailParkCap: 'false' }), 0);
            assert.equal(mod.capOf({ triggerFailParkCap: false }), 0);
            assert.equal(mod.capOf({ triggerFailParkCap: 0 }), 0);
            assert.equal(mod.capOf({ triggerFailParkCap: -1 }), 0);
        });
    });
});
