/**
 * Unit tests for js/createRepoTasks.js
 */

function makeModule(globals) {
    var defaultGlobals = {
        java: { lang: { System: { getenv: function() { return 'https://jiraeu.epam.com'; } } } },
        jira_get_ticket: function() { return { fields: {} }; },
        jira_search_by_jql: function() { return []; },
        jira_create_ticket_with_parent: function() { return '{"key":"PROJ-2"}'; },
        jira_post_comment: function() {}
    };
    for (var k in (globals || {})) { defaultGlobals[k] = globals[k]; }

    return loadModule(
        'js/createRepoTasks.js',
        makeRequire({}),
        defaultGlobals
    );
}

// ---------------------------------------------------------------------------
// parseAffectedRepos
// ---------------------------------------------------------------------------

suite('createRepoTasks — parseAffectedRepos', function() {
    test('extracts JSON array from {code:json|title=affected_repos} block', function() {
        var mod = makeModule();
        var desc = 'Some text\n\n{code:json|title=affected_repos}\n[{"name":"repo-a"},{"name":"repo-b"}]\n{code}\n\nMore text';
        var repos = mod.parseAffectedRepos(desc);
        assert.equal(repos.length, 2, 'two repos');
        assert.equal(repos[0].name, 'repo-a', 'first repo');
        assert.equal(repos[1].name, 'repo-b', 'second repo');
    });

    test('returns empty array when marker absent', function() {
        var mod = makeModule();
        var repos = mod.parseAffectedRepos('No repos here');
        assert.equal(repos.length, 0, 'empty array');
    });

    test('returns empty array for invalid JSON', function() {
        var mod = makeModule();
        var desc = '{code:json|title=affected_repos}\nnot-json\n{code}';
        var repos = mod.parseAffectedRepos(desc);
        assert.equal(repos.length, 0, 'empty on parse error');
    });

    test('handles plain string repos', function() {
        var mod = makeModule();
        var desc = '{code:json|title=affected_repos}\n["repo-a","repo-b"]\n{code}';
        var repos = mod.parseAffectedRepos(desc);
        assert.equal(repos.length, 2, 'two string repos');
    });
});

// ---------------------------------------------------------------------------
// action — happy path
// ---------------------------------------------------------------------------

suite('createRepoTasks — action', function() {
    var reposJson = JSON.stringify([
        { name: 'gens-igt-db', reason: 'DB migration' },
        { name: 'gens-igt',    reason: 'API change', depends_on: ['gens-igt-db'] }
    ]);
    var description = 'Solution text\n\n{code:json|title=affected_repos}\n' + reposJson + '\n{code}\n\n----';

    test('creates one Sub-task per repo under parent', function() {
        var created = [];
        var mod = makeModule({
            jira_get_ticket: function(opts) {
                if (opts.key === 'GENSGENP-100') {
                    return { fields: { description: description, parent: { key: 'GENSGENP-50' } } };
                }
                return { fields: { summary: 'Build PacBio workflow' } };
            },
            jira_search_by_jql: function() { return []; },
            jira_create_ticket_with_parent: function(opts) {
                created.push(opts);
                return '{"key":"GENSGENP-' + (200 + created.length) + '"}';
            },
            jira_post_comment: function() {}
        });

        var result = mod.action({ ticket: { key: 'GENSGENP-100' } });

        assert.equal(result.success, true, 'succeeds');
        assert.equal(created.length, 2, 'two sub-tasks created');
        assert.equal(created[0].parentKey, 'GENSGENP-50', 'parent is story');
        assert.equal(created[0].issueType, 'Sub-task', 'issueType is Sub-task');
        assert.equal(created[0].summary.indexOf('[gens-igt-db]') === 0, true, 'summary starts with [repo]');
        assert.equal(created[0].summary.indexOf('Build PacBio workflow') !== -1, true, 'parent summary in subtask summary');
        assert.equal(created[0].description.indexOf('gens-igt-db') !== -1, true, 'repo name in description');
        assert.equal(created[0].description.indexOf('GENSGENP-100') !== -1, true, 'SA ticket link in description');
        assert.equal(created[0].description.indexOf('GENSGENP-50') !== -1, true, 'parent link in description');
    });

    test('skips repos that already have a matching Sub-task', function() {
        var created = [];
        var mod = makeModule({
            jira_get_ticket: function(opts) {
                if (opts.key === 'GENSGENP-100') {
                    return { fields: { description: description, parent: { key: 'GENSGENP-50' } } };
                }
                return { fields: { summary: 'Parent story' } };
            },
            jira_search_by_jql: function() {
                return [{ fields: { summary: '[gens-igt-db] Parent story' } }]; // already exists
            },
            jira_create_ticket_with_parent: function(opts) { created.push(opts); return '{"key":"GENSGENP-201"}'; },
            jira_post_comment: function() {}
        });

        var result = mod.action({ ticket: { key: 'GENSGENP-100' } });

        assert.equal(result.success, true, 'succeeds');
        assert.equal(created.length, 1, 'only one created (gens-igt-db skipped)');
        assert.equal(result.skipped, 1, 'one skipped');
        assert.equal(created[0].summary.indexOf('[gens-igt]') === 0, true, 'gens-igt was created');
    });

    test('returns error when SA ticket has no parent', function() {
        var mod = makeModule({
            jira_get_ticket: function() {
                return { fields: { description: description, parent: null } };
            }
        });
        var result = mod.action({ ticket: { key: 'GENSGENP-100' } });
        assert.equal(result.success, false, 'fails without parent');
        assert.equal(result.error.indexOf('no parent') !== -1, true, 'error mentions parent');
    });

    test('returns error when no affected_repos block in description', function() {
        var mod = makeModule({
            jira_get_ticket: function(opts) {
                if (opts.key === 'GENSGENP-100') {
                    return { fields: { description: 'Just some text, no repos block', parent: { key: 'GENSGENP-50' } } };
                }
                return { fields: { summary: 'Parent story' } };
            }
        });
        var result = mod.action({ ticket: { key: 'GENSGENP-100' } });
        assert.equal(result.success, false, 'fails without repos block');
    });

    test('module.exports is guarded with typeof for postJSAction compatibility', function() {
        var code = file_read({ path: 'js/createRepoTasks.js' });
        var hasGuard = code.indexOf('typeof module') !== -1 && code.indexOf('module.exports') !== -1;
        assert.equal(hasGuard, true, 'module.exports must be inside typeof module guard');
    });
});
