/**
 * Unit tests for js/common/machineAuthor.js — the single resolution point
 * for "whose login is the machine" in the #687 PR lifecycle.
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

suite('common/machineAuthor: resolveMachineAuthor (#687)', function () {

    var mod = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
    var resolve = mod.resolveMachineAuthor;

    test('jobParams override wins (factory JSON parameter)', function () {
        assert.equal(
            resolve({ machineAuthor: 'harness-bot' }, { machineAuthor: 'repo-bot' }),
            'harness-bot');
    });

    test('per-repo config knob (.dmtools/config.js) applies without jobParams', function () {
        assert.equal(resolve({}, { machineAuthor: 'repo-bot' }), 'repo-bot');
        assert.equal(resolve(null, { machineAuthor: 'repo-bot' }), 'repo-bot');
    });

    test('unconfigured -> null (guards inert, external semantics)', function () {
        assert.ok(resolve({}, {}) === null);
        assert.ok(resolve(null, null) === null);
        assert.ok(resolve({}, { machineAuthor: '' }) === null);
    });

    test('values are coerced to strings (config.js may export numbers)', function () {
        assert.equal(String(resolve({ machineAuthor: 12345 }, null)), '12345');
    });

    test('sm ctx shape works as the first argument (source path)', function () {
        // githubSource calls resolve(ctx, ctx.config) — ctx carries the
        // jobParams-injected machineAuthor field.
        var ctx = { repoInfo: { owner: 'a', repo: 'b' },
                    machineAuthor: 'injected-bot', config: { machineAuthor: 'cfg-bot' } };
        assert.equal(resolve(ctx, ctx.config), 'injected-bot');
        var bareCtx = { repoInfo: { owner: 'a', repo: 'b' }, config: { machineAuthor: 'cfg-bot' } };
        assert.equal(resolve(bareCtx, bareCtx.config), 'cfg-bot');
    });

    test('a LIST value is returned RAW by design (gh-728) — parsing is the consumers\' job', function () {
        // resolveMachineAuthor keeps returning the raw config string so the
        // knob stays a single source of truth; machineAuthorLogins() splits
        // it (trim + drop empties) for the guards.
        assert.equal(resolve({ machineAuthor: 'ai-teammate,github-actions[bot]' }, null),
            'ai-teammate,github-actions[bot]');
    });
});

suite('common/machineAuthor: machineAuthorLogins — comma-separated list (gh-728)', function () {

    var mod = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
    var logins = mod.machineAuthorLogins;

    test('null/absent/empty -> no entries (every guard fails closed)', function () {
        assert.deepEqual(logins(null), []);
        assert.deepEqual(logins(''), []);
        assert.deepEqual(logins(undefined), []);
    });

    test('single entry parses to a one-element list (back-compat)', function () {
        assert.deepEqual(logins('ai-teammate'), ['ai-teammate']);
    });

    test('multi entry splits on commas', function () {
        assert.deepEqual(logins('ai-teammate,github-actions[bot]'),
            ['ai-teammate', 'github-actions[bot]']);
    });

    test('whitespace around entries is trimmed', function () {
        assert.deepEqual(logins('  ai-teammate ,  github-actions[bot]  '),
            ['ai-teammate', 'github-actions[bot]']);
    });

    test('empty segments are dropped', function () {
        assert.deepEqual(logins('ai-teammate,, ,github-actions[bot]'),
            ['ai-teammate', 'github-actions[bot]']);
    });

    test('non-string values are coerced (config.js may export numbers)', function () {
        assert.deepEqual(logins(12345), ['12345']);
    });
});

suite('common/machineAuthor: isMachineAuthored treats the knob as a LOGIN LIST (gh-728, live fa PR #1249)', function () {

    var mod = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
    var isMachine = mod.isMachineAuthored;
    var LIST = 'ai-teammate,github-actions[bot]';

    test('the SECOND list entry matches — github-actions[bot] rides the machine path', function () {
        assert.ok(isMachine({ author: 'github-actions[bot]' }, LIST, 'owner'));
    });

    test('the first entry still matches (single-login behavior unchanged)', function () {
        assert.ok(isMachine({ author: 'ai-teammate' }, LIST, 'owner'));
        assert.ok(isMachine({ author: 'ai-teammate' }, 'ai-teammate', 'owner'));
    });

    test('whitespace-padded entries still match (trim before compare)', function () {
        assert.ok(isMachine({ author: 'github-actions[bot]' },
            'ai-teammate,  github-actions[bot] ', 'owner'));
    });

    test('a foreign login matches NO entry (still a guest)', function () {
        assert.ok(!isMachine({ author: 'some-human' }, LIST, 'owner'));
        assert.ok(!isMachine({ pr: { author: 'vendor-bot' } }, LIST, 'owner'));
    });

    test('matching is CASE-SENSITIVE per entry (design)', function () {
        assert.ok(!isMachine({ author: 'AI-TEAMMATE' }, LIST, 'owner'));
        assert.ok(!isMachine({ author: 'Github-Actions[Bot]' }, LIST, 'owner'));
    });

    test('unconfigured (null) -> no login matches; only the release-bump carve-out can', function () {
        assert.ok(!isMachine({ author: 'github-actions[bot]' }, null, 'owner'));
        assert.ok(!isMachine({ author: 'github-actions[bot]' }, '', 'owner'));
        assert.ok(isMachine({ author: 'owner', branch: 'chore/release-v1.2.3' }, null, 'owner'),
            'release-bump carve-out is independent of the login list');
    });

    test('a list of two machine logins matches BOTH (loop/collection: 2+ items)', function () {
        assert.ok(isMachine({ author: 'ai-teammate' }, LIST, 'owner'));
        assert.ok(isMachine({ author: 'github-actions[bot]' }, LIST, 'owner'));
        assert.ok(!isMachine({ author: 'third-wheel' }, LIST, 'owner'));
    });
});

suite('common/machineAuthor: isMachineLogin — case-insensitive list membership for actor probes', function () {

    var mod = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
    var isLogin = mod.isMachineLogin;
    var LIST = 'ai-teammate,github-actions[bot]';

    test('any list entry matches case-insensitively (park probes lowercase both sides)', function () {
        assert.ok(isLogin('github-actions[bot]', LIST));
        assert.ok(isLogin('AI-TEAMMATE', LIST));
        assert.ok(isLogin('ai-teammate', 'ai-teammate'));
    });

    test('foreign/empty logins never match; unconfigured fails closed', function () {
        assert.ok(!isLogin('some-human', LIST));
        assert.ok(!isLogin('', LIST));
        assert.ok(!isLogin(null, LIST));
        assert.ok(!isLogin('ai-teammate', null));
        assert.ok(!isLogin('ai-teammate', ''));
    });
});
