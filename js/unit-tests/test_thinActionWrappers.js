/**
 * Unit tests: thin action wrappers that delegate to shared modules
 * (js/requireTicket.js, js/assignForReview.js,
 * js/postDevelopTicketDynamicRepo.js, js/branchNaming/issueType_naming.js).
 * They keep every production function under the CRAP gate's coverage.
 *
 * Uses: loadModule, makeRequire, assert, test(), suite()
 */

suite('requireTicket.action', function() {
    test('delegates to validateAndRequireTicket and returns true', function() {
        var seen = null;
        var mod = loadModule('js/requireTicket.js', makeRequire({
            './common/validateInputJql.js': { validateAndRequireTicket: function(p) { seen = p; } }
        }));
        var params = { inputJql: 'key = AB-1' };
        assert.equal(mod.action(params), true);
        assert.equal(seen, params);
    });
});

suite('assignForReview.action', function() {
    function load(assignFn) {
        return loadModule('js/assignForReview.js', makeRequire({
            './common/jiraHelpers.js': { assignForReview: assignFn },
            './config.js': { STATUSES: { SOLUTION_ARCHITECTURE: 'Solution Architecture' } }
        }));
    }

    test('passes key, initiator, contextId wip label and target status', function() {
        var args = null;
        var mod = load(function() { args = Array.prototype.slice.call(arguments); return { success: true }; });
        var r = mod.action({ ticket: { key: 'AB-2' }, initiator: 'u1', metadata: { contextId: 'ctx' } });
        assert.equal(r.success, true);
        assert.deepEqual(args, ['AB-2', 'u1', 'ctx_wip', 'Solution Architecture']);
    });

    test('no contextId → null wip label', function() {
        var args = null;
        var mod = load(function() { args = Array.prototype.slice.call(arguments); return true; });
        mod.action({ ticket: { key: 'AB-3' }, initiator: 'u2' });
        assert.equal(args[2], null);
    });

    test('errors are reported as {success:false}', function() {
        var mod = load(function() { throw new Error('boom'); });
        var r = mod.action({ ticket: { key: 'AB-4' } });
        assert.equal(r.success, false);
        assert.ok(String(r.error).indexOf('boom') !== -1);
    });
});

suite('postDevelopTicketDynamicRepo.action', function() {
    test('resolves the repo first, then runs develop+PR with the same params', function() {
        var order = [];
        var mod = loadModule('js/postDevelopTicketDynamicRepo.js', makeRequire({
            './resolveRepoFromTicket.js': { action: function(p) { order.push('resolve'); p.resolved = true; } },
            './developTicketAndCreatePR.js': { action: function(p) { order.push('develop:' + p.resolved); return 'ok'; } }
        }));
        assert.equal(mod.action({}), 'ok');
        assert.deepEqual(order, ['resolve', 'develop:true']);
    });
});

suite('branchNaming/issueType_naming', function() {
    var naming = loadModule('js/branchNaming/issueType_naming.js');

    test('lower-cased issue type prefix', function() {
        assert.equal(naming({ key: 'AB-5', fields: { issuetype: { name: 'Bug' } } }, 'development'), 'bug/AB-5');
    });

    test('falls back to feature when the issue type is missing', function() {
        assert.equal(naming({ key: 'AB-6', fields: {} }, 'feature'), 'feature/AB-6');
    });
});
