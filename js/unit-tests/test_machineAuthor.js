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
});
