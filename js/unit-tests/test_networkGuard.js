/**
 * Unit tests must never reach a real service (dm.ai#635 follow-up).
 * testRunner.js replaces every network-backed integration tool with a throwing stub;
 * this pins that behaviour so a future test cannot silently go back to issuing real
 * api.github.com / atlassian.net requests (~100 per run before the guard).
 */
suite('network guard — unit tests never call real services', function () {

    function throwsGuard(fn) {
        try { fn(); } catch (e) { return String(e && e.message || e).indexOf('network guard') !== -1; }
        return false;
    }

    test('unmocked github_* tool throws instead of calling the network', function () {
        assert.ok(throwsGuard(function () {
            github_list_prs({ workspace: 'a', repository: 'b', state: 'open' });
        }), 'github_list_prs must be stubbed');
    });

    test('unmocked confluence_* and jira_* tools are stubbed too', function () {
        assert.ok(throwsGuard(function () { confluence_content_by_id({ contentId: '1' }); }));
        assert.ok(throwsGuard(function () { jira_get_ticket('T-1'); }));
    });

    test('file_* tools stay real (tests read fixtures through them)', function () {
        assert.ok(typeof file_read({ path: 'js/config.js' }) === 'string');
    });

    test('a test-local mock still wins over the guard', function () {
        var mod = loadModule('js/common/setupCommands.js', null, {
            cli_execute_command: function () { return 'mocked'; }
        });
        assert.equal(mod.runSetupCommands({ setupCommands: ['x'] }, '.').results[0].output, 'mocked');
    });
});
