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

suite('common/machineAuthor: GitHub App [bot] suffix normalization (gh-1025)', function () {

    // Live 2026-10-18 (SM tick 39103844372): #988 added 'dmtools-factory-bot'
    // to the knob, but GitHub reports App-authored PRs as
    // 'dmtools-factory-bot[bot]'. Exact match failed → every prMachineAuthor
    // rule fail-closed: zero rework legs dispatched, zero arms landed, the
    // whole agents queue silently dead for ~8h while labels looked armed.
    var mod = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
    var isMachine = mod.isMachineAuthored;
    var isLogin = mod.isMachineLogin;

    test('configured bare login matches the API-reported [bot] author', function () {
        assert.ok(isMachine({ author: 'dmtools-factory-bot[bot]' },
            'ai-teammate,dmtools-factory-bot', 'owner'));
    });

    test('configured [bot] entry matches a bare author (both directions)', function () {
        assert.ok(isMachine({ author: 'dmtools-factory-bot' },
            'ai-teammate,dmtools-factory-bot[bot]', 'owner'));
    });

    test('exact [bot]-to-[bot] match still works (github-actions[bot] back-compat)', function () {
        assert.ok(isMachine({ author: 'github-actions[bot]' },
            'ai-teammate,github-actions[bot]', 'owner'));
    });

    test('isMachineLogin normalizes the suffix too (actor probes)', function () {
        assert.ok(isLogin('dmtools-factory-bot[bot]', 'dmtools-factory-bot'));
        assert.ok(isLogin('dmtools-factory-bot', 'dmtools-factory-bot[bot]'));
        assert.ok(isLogin('DMTOOLS-FACTORY-BOT[bot]', 'dmtools-factory-bot'));
    });

    test('a bare suffix without brackets is NOT stripped (robot != ro[bot])', function () {
        assert.ok(!isMachine({ author: 'robot' }, 'ro', 'owner'));
        assert.ok(!isMachine({ author: 'ro' }, 'robot', 'owner'));
    });

    test('a DIFFERENT bot still does not match (normalization is not a wildcard)', function () {
        assert.ok(!isMachine({ author: 'dependabot[bot]' }, 'dmtools-factory-bot', 'owner'));
        assert.ok(!isMachine({ author: 'dmtools-factory-bot2[bot]' }, 'dmtools-factory-bot', 'owner'));
        assert.ok(!isLogin('other-bot[bot]', 'dmtools-factory-bot'));
    });

    test('case-sensitivity of the bare login part is preserved in isMachineAuthored (design)', function () {
        assert.ok(!isMachine({ author: 'DMTOOLS-FACTORY-BOT[bot]' }, 'dmtools-factory-bot', 'owner'));
    });
});

suite('common/machineAuthor: degenerate [bot]-only inputs (gh-1025 review)', function () {
    var mod = loadModule('js/common/machineAuthor.js', makeRequire({}), {});

    test('isMachineAuthored never matches an empty stripped login', function () {
        assert.ok(!mod.isMachineAuthored({ author: '[bot]' }, '[bot]', 'owner'),
            "'[bot]' strips to '' — '' === '' must not match");
        assert.ok(!mod.isMachineAuthored({ author: '' }, 'ai-teammate', 'owner'));
    });

    test('loginMatchesList: [bot]-normalized membership for allowlist matchers', function () {
        var m = mod.loginMatchesList;
        assert.ok(m('dmtools-factory-bot[bot]', ['ai-teammate', 'dmtools-factory-bot']));
        assert.ok(m('dmtools-factory-bot', ['dmtools-factory-bot[bot]']));
        assert.ok(m('AI-Teammate', ['ai-teammate']), 'case-insensitive (comment-layer semantics)');
        assert.ok(!m('dependabot[bot]', ['dmtools-factory-bot']));
        assert.ok(!m('[bot]', ['[bot]']), 'degenerate empty after strip never matches');
        assert.ok(!m('', ['ai-teammate']));
        assert.ok(!m(null, ['ai-teammate']));
        assert.ok(!m('ai-teammate', []));
        assert.ok(!m('ai-teammate', null));
    });
});

// ── gh-1221 CRAP characterization: carrier-field resolution ──────────────────
// Pins the item-vs-pr carrier fallbacks (author/branch/title) the release-bump
// gate reads, so the shared field-reader extraction cannot move a decision.
suite('machineAuthor — gh-1221 release-bump carrier fields', function () {

    var mod = loadModule('js/common/machineAuthor.js', makeRequire({}), {});

    test('release-bump fields are read from the pr carrier when absent on the item', function () {
        var item = { pr: { author: 'owner', branch: 'chore/release-v1.2.3',
                           title: 'chore(release): v1.2.3' } };
        assert.equal(mod.isMachineReleaseBump(item, 'OWNER'), true,
            'pr-carrier fields count; owner match is case-insensitive');
    });

    test('the item-level author wins over the pr carrier', function () {
        var item = { author: 'someone-else', branch: 'feature/x',
                     pr: { author: 'owner', branch: 'chore/release-v2.0.0',
                           title: 'chore(release): v2.0.0' } };
        assert.equal(mod.isMachineReleaseBump(item, 'owner'), false,
            'author is read from the item first — a foreigner is never machine');
    });

    test('branch shape alone and title shape alone both qualify (either carrier)', function () {
        assert.equal(mod.isMachineReleaseBump(
            { author: 'o', branch: 'chore/release-v9', title: 'feat: x' }, 'O'), true,
            'release branch shape matches');
        assert.equal(mod.isMachineReleaseBump(
            { author: 'o', branch: 'feature/x', title: 'chore(release): v9' }, 'o'), true,
            'release title shape matches');
        assert.equal(mod.isMachineReleaseBump(
            { author: 'o', branch: 'feature/x', title: 'feat: x' }, 'o'), false,
            'no bump shape on either carrier → not machine');
    });

    test('isMachineAuthored falls back to the release-bump gate (owner carve-out intact)', function () {
        var item = { author: 'Owner', branch: 'chore/release-v1.0.0', title: '' };
        assert.equal(mod.isMachineAuthored(item, null, 'owner'), true,
            'unconfigured machineAuthor: the owner-authored bump still counts as machine');
        assert.equal(mod.isMachineAuthored({ author: 'owner', branch: 'feature/x' }, null, 'owner'), false,
            'owner-authored NON-bump stays non-machine');
    });
});
