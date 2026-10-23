/**
 * Unit tests for js/common/aiResponseParser.js
 *
 * Characterization tests (gh-1191): pin the current behaviour of
 * parseQuestionsResponse / buildSummary / buildDescription so the CRAP
 * refactor (helper extraction) cannot change it.
 */

function loadAiResponseParser() {
    return loadModule(
        'js/common/aiResponseParser.js',
        makeRequire({ '../config.js': configModule }),
        {}
    );
}

suite('aiResponseParser.parseQuestionsResponse', function () {

    test('passes a JSON array through untouched', function () {
        var mod = loadAiResponseParser();
        var arr = [{ summary: 'Q1' }, { summary: 'Q2', priority: 'High' }];
        var parsed = mod.parseQuestionsResponse(arr);
        assert.equal(parsed, arr, 'the same array object is returned');
        assert.equal(parsed.length, 2);
    });

    test('parses a JSON string into an array', function () {
        var mod = loadAiResponseParser();
        var parsed = mod.parseQuestionsResponse('[{"summary":"Clarify X"},{"summary":"Clarify Y"}]');
        assert.equal(parsed.length, 2);
        assert.equal(parsed[0].summary, 'Clarify X');
        assert.equal(parsed[1].summary, 'Clarify Y');
    });

    test('parses a formatted (multi-line) JSON string', function () {
        var mod = loadAiResponseParser();
        var parsed = mod.parseQuestionsResponse('[\n  { "summary": "Q" }\n]');
        assert.equal(parsed.length, 1);
        assert.equal(parsed[0].summary, 'Q');
    });

    test('returns [] on invalid JSON string', function () {
        var errors = [];
        var origError = console.error;
        console.error = function () { errors.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            var mod = loadAiResponseParser();
            var parsed = mod.parseQuestionsResponse('not json at all {');
            assert.deepEqual(parsed, [], 'invalid JSON degrades to an empty array');
        } finally {
            console.error = origError;
        }
        assert.ok(errors.length > 0, 'the parse failure is announced on console.error');
        assert.ok(errors.some(function (e) { return e.indexOf('Invalid JSON from AI') !== -1; }));
    });

    test('returns [] on a JSON string that parses to a non-array', function () {
        var mod = loadAiResponseParser();
        assert.deepEqual(mod.parseQuestionsResponse('{"summary":"not an array"}'), []);
        assert.deepEqual(mod.parseQuestionsResponse('42'), []);
        assert.deepEqual(mod.parseQuestionsResponse('"a string"'), []);
        assert.deepEqual(mod.parseQuestionsResponse('null'), []);
    });

    test('returns [] on non-array non-string input (object, number, null, undefined, boolean)', function () {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function () { warns.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            var mod = loadAiResponseParser();
            assert.deepEqual(mod.parseQuestionsResponse({ summary: 'nope' }), []);
            assert.deepEqual(mod.parseQuestionsResponse(42), []);
            assert.deepEqual(mod.parseQuestionsResponse(null), []);
            assert.deepEqual(mod.parseQuestionsResponse(undefined), []);
            assert.deepEqual(mod.parseQuestionsResponse(true), []);
        } finally {
            console.warn = origWarn;
        }
        assert.equal(warns.length, 5, 'each non-array input is announced once');
        assert.ok(warns.every(function (w) { return w.indexOf('AI response is not an array') !== -1; }));
    });

    test('a string parsing to an object (not array) never hits the non-array warn branch twice', function () {
        // 'null' string → JSON.parse → null → the array check fails → [] with a warn.
        var warns = [];
        var origWarn = console.warn;
        console.warn = function () { warns.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            var mod = loadAiResponseParser();
            assert.deepEqual(mod.parseQuestionsResponse('null'), []);
        } finally {
            console.warn = origWarn;
        }
        assert.equal(warns.length, 1);
        assert.ok(warns[0].indexOf('object') !== -1, 'warn names the typeof of the parsed value');
    });

    test('multi-element array with mixed shapes passes through (loop invariant: order preserved)', function () {
        var mod = loadAiResponseParser();
        var arr = [
            { summary: 'Q1', priority: 'High', description: 'd1', answer: 'a1' },
            { summary: 'Q2' },
            { summary: 'Q3', description: 'd3' }
        ];
        var parsed = mod.parseQuestionsResponse(arr);
        assert.equal(parsed.length, 3);
        assert.equal(parsed[0].summary, 'Q1');
        assert.equal(parsed[1].summary, 'Q2');
        assert.equal(parsed[2].summary, 'Q3');
        assert.equal(parsed[0].answer, 'a1');
    });
});

suite('aiResponseParser.buildSummary', function () {

    test('returns the summary untouched when within the limit', function () {
        var mod = loadAiResponseParser();
        assert.equal(mod.buildSummary('Clarify the auth flow', 0), 'Clarify the auth flow');
    });

    test('falls back to numbered follow-up text when summary is missing or empty', function () {
        var mod = loadAiResponseParser();
        assert.equal(mod.buildSummary(null, 0), 'Follow-up question #1');
        assert.equal(mod.buildSummary(undefined, 2), 'Follow-up question #3');
        assert.equal(mod.buildSummary('', 4), 'Follow-up question #5');
    });

    test('truncates an over-limit summary with an ellipsis (multi-length sweep)', function () {
        var mod = loadAiResponseParser();
        var limit = configModule.SUMMARY_MAX_LENGTH;
        var ok = '';
        for (var i = 0; i < limit; i++) ok += 'a';
        assert.equal(mod.buildSummary(ok, 0), ok, 'exactly at the limit: untouched');

        var over = ok + 'bbb';
        var truncated = mod.buildSummary(over, 0);
        assert.equal(truncated.length, limit, 'truncated result respects the limit');
        assert.equal(truncated.slice(-3), '...', 'ellipsis marks the truncation');
        assert.equal(truncated, ok.slice(0, limit - 3) + '...');
    });

    test('several long summaries each truncate independently (2+ items)', function () {
        var mod = loadAiResponseParser();
        var long1 = new Array(configModule.SUMMARY_MAX_LENGTH + 5).join('x');
        var long2 = new Array(configModule.SUMMARY_MAX_LENGTH + 40).join('y');
        var s1 = mod.buildSummary(long1, 0);
        var s2 = mod.buildSummary(long2, 1);
        assert.equal(s1.length, configModule.SUMMARY_MAX_LENGTH);
        assert.equal(s2.length, configModule.SUMMARY_MAX_LENGTH);
        assert.ok(s1.indexOf('xxx...') === s1.length - 6, 'first summary truncated on x');
        assert.ok(s2.indexOf('yyy...') === s2.length - 6, 'second summary truncated on y');
    });
});

suite('aiResponseParser.buildDescription', function () {

    test('returns the question description when present', function () {
        var mod = loadAiResponseParser();
        assert.equal(mod.buildDescription({ description: 'h2. Details' }), 'h2. Details');
    });

    test('falls back to the template hint when description is missing or empty', function () {
        var mod = loadAiResponseParser();
        assert.equal(mod.buildDescription({}), 'Follow template from instructions.');
        assert.equal(mod.buildDescription({ description: '' }), 'Follow template from instructions.');
        assert.equal(mod.buildDescription({ description: null }), 'Follow template from instructions.');
    });
});

suite('aiResponseParser.tryParseJson', function () {

    test('valid JSON → { ok: true, value }', function () {
        var mod = loadAiResponseParser();
        assert.deepEqual(mod.tryParseJson('[1,2]'), { ok: true, value: [1, 2] });
        assert.deepEqual(mod.tryParseJson('null'), { ok: true, value: null });
        assert.deepEqual(mod.tryParseJson('42'), { ok: true, value: 42 });
    });

    test('invalid JSON → { ok: false, value: null } with a console.error', function () {
        var errors = [];
        var origError = console.error;
        console.error = function () { errors.push(Array.prototype.slice.call(arguments).join(' ')); };
        try {
            var mod = loadAiResponseParser();
            assert.deepEqual(mod.tryParseJson('{{{'), { ok: false, value: null });
        } finally {
            console.error = origError;
        }
        assert.ok(errors.some(function (e) { return e.indexOf('Invalid JSON from AI') !== -1; }));
    });
});
