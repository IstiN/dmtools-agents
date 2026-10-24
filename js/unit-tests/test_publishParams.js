/**
 * Unit tests: js/factory/publishParams.js — the shared param-resolution
 * core of the factory *_publish.js JSRunner entries (gh-1248 dedup).
 */

suite('publishParams — envValue', function () {
    var pp = loadModule('js/factory/publishParams.js', makeRequire({}), {});

    test('returns the env value through the java bridge', function () {
        var fakeJava = { lang: { System: { getenv: function (name) {
            return name === 'PRESENT' ? 'yes' : null;
        } } } };
        var mod = loadModule('js/factory/publishParams.js', makeRequire({}), { java: fakeJava });
        assert.equal(mod.envValue('PRESENT'), 'yes');
        assert.equal(mod.envValue('ABSENT'), '');
    });

    test('a missing java bridge yields the empty string (QuickJS-safe)', function () {
        assert.equal(pp.envValue('ANYTHING'), '');
    });
});

suite('publishParams — makePicker', function () {
    var pp = loadModule('js/factory/publishParams.js', makeRequire({}), {});

    test('resolution order: customParams > envMap > default', function () {
        var pick = pp.makePicker({ jobParams: { customParams: { k: 'custom' } } },
            { ENV_K: 'env' });
        assert.equal(pick('k', 'ENV_K', 'dflt'), 'custom');
        assert.equal(pp.makePicker({}, { ENV_K: 'env' })('k', 'ENV_K', 'dflt'), 'env');
        assert.equal(pp.makePicker({})('k', 'ENV_K', 'dflt'), 'dflt');
    });

    test('empty-string customParams fall through to env (unchanged semantics)', function () {
        var pick = pp.makePicker({ jobParams: { customParams: { k: '' } } }, { ENV_K: 'env' });
        assert.equal(pick('k', 'ENV_K', 'dflt'), 'env');
    });

    test('null customParams values fall through to env', function () {
        var pick = pp.makePicker({ jobParams: { customParams: { k: null } } }, { ENV_K: 'env' });
        assert.equal(pick('k', 'ENV_K', 'dflt'), 'env');
    });

    test('still-unset answers the empty string, and everything is stringified', function () {
        var pick = pp.makePicker({});
        assert.equal(pick('k', 'ENV_K'), '');
        assert.equal(pp.makePicker({ jobParams: { customParams: { n: 42 } } })('n', 'ENV_N', ''), '42');
    });

    test('envMap values win over the java bridge without mutating params', function () {
        var params = { jobParams: { customParams: {} } };
        var pick = pp.makePicker(params, { ENV_K: 'mapped' });
        assert.equal(pick('k', 'ENV_K', 'dflt'), 'mapped');
        assert.deepEqual(params.jobParams.customParams, {});
    });
});

suite('publishParams — firstNonEmpty / hasJavaEnvBridge', function () {
    var pp = loadModule('js/factory/publishParams.js', makeRequire({}), {});

    test('firstNonEmpty skips undefined/null/empty and keeps falsy 0/false', function () {
        assert.equal(pp.firstNonEmpty([undefined, null, '', 'x']), 'x');
        assert.equal(pp.firstNonEmpty(['', undefined]), '');
        assert.equal(pp.firstNonEmpty([]), '');
        assert.equal(pp.firstNonEmpty([0]), 0);
        assert.equal(pp.firstNonEmpty([false, 'y']), false);
    });

    test('hasJavaEnvBridge is false without a java global (QuickJS parity)', function () {
        var noJava = loadModule('js/factory/publishParams.js', makeRequire({}), { java: undefined });
        assert.equal(noJava.hasJavaEnvBridge(), false);
        assert.equal(noJava.envValue('ANYTHING'), '');
    });

    test('pick keeps the resolution order through the extracted helper', function () {
        var pick = pp.makePicker({ jobParams: { customParams: { n: 0 } } }, { ENV_N: 'env' });
        assert.equal(pick('n', 'ENV_N', 'dflt'), '0');
        assert.equal(pp.makePicker({}, {})('missing', 'MISSING_ENV', ''), '');
    });
});
