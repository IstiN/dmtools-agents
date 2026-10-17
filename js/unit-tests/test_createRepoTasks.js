function d2Trackers(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks);
}

/**
 * Unit tests for js/createRepoTasks.js
 */

function makeModule(globals) {
    var defaultGlobals = {
        java: { lang: { System: { getenv: function() { return 'https://jira.example.com'; } } } },
        jira_get_ticket: function() { return { fields: {} }; },
        jira_search_by_jql: function() { return []; },
        jira_create_ticket_with_parent: function() { return '{"key":"PROJ-2"}'; },
        jira_link_issues: function() {},
        jira_move_to_status: function() {},
        jira_post_comment: function() {}
    };
    for (var k in (globals || {})) { defaultGlobals[k] = globals[k]; }

    return loadModule(
        'js/createRepoTasks.js',
        makeRequire({ './config.js': configModule, './common/trackers.js': d2Trackers(defaultGlobals) }),
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
        { name: 'core-db', reason: 'DB migration' },
        { name: 'service-api',    reason: 'API change', depends_on: ['core-db'] }
    ]);
    var description = 'Solution text\n\n{code:json|title=affected_repos}\n' + reposJson + '\n{code}\n\n----';

    test('creates one Sub-task per repo under parent', function() {
        var created = [];
        var mod = makeModule({
            jira_get_ticket: function(opts) {
                if (opts.key === 'PROJ-100') {
                    return { fields: { description: description, parent: { key: 'PROJ-50' } } };
                }
                return { fields: { summary: 'Build example workflow' } };
            },
            jira_search_by_jql: function() { return []; },
            jira_create_ticket_with_parent: function(opts) {
                created.push(opts);
                return '{"key":"PROJ-' + (200 + created.length) + '"}';
            },
            jira_link_issues: function() {},
            jira_move_to_status: function() {},
            jira_post_comment: function() {}
        });

        var result = mod.action({ ticket: { key: 'PROJ-100' } });

        assert.equal(result.success, true, 'succeeds');
        assert.equal(created.length, 2, 'two sub-tasks created');
        assert.equal(created[0].parentKey, 'PROJ-50', 'parent is story');
        assert.equal(created[0].issueType, 'Sub-task', 'issueType is Sub-task');
        assert.equal(created[0].summary.indexOf('[core-db]') === 0, true, 'summary starts with [repo]');
        assert.equal(created[0].summary.indexOf('Build example workflow') !== -1, true, 'parent summary in subtask summary');
        assert.equal(created[0].description.indexOf('core-db') !== -1, true, 'repo name in description');
        assert.equal(created[0].description.indexOf('PROJ-100') !== -1, true, 'SA ticket link in description');
        assert.equal(created[0].description.indexOf('PROJ-50') !== -1, true, 'parent link in description');
        assert.deepEqual(created[0].labels, ['development'], 'default development label set');
    });

    test('truncates summary when the parent summary is long enough to exceed 255 chars', function() {
        var longParentSummary = 'B'.repeat(300);
        var created = [];
        var mod = makeModule({
            jira_get_ticket: function(opts) {
                if (opts.key === 'PROJ-100') {
                    return { fields: { description: description, parent: { key: 'PROJ-50' } } };
                }
                return { fields: { summary: longParentSummary } };
            },
            jira_search_by_jql: function() { return []; },
            jira_create_ticket_with_parent: function(opts) {
                created.push(opts);
                return '{"key":"PROJ-' + (200 + created.length) + '"}';
            },
            jira_post_comment: function() {}
        });

        var result = mod.action({ ticket: { key: 'PROJ-100' } });

        assert.equal(result.success, true, 'succeeds');
        assert.equal(created[0].summary.length <= 255, true, 'summary truncated to Jira limit');
        assert.equal(created[0].summary.slice(-3), '...', 'truncated summary ends with ellipsis');
    });

    test('links blocker→dependent and moves dependent to Blocked', function() {
        var links = [];
        var moved = [];
        var ticketCounter = 200;
        var mod = makeModule({
            jira_get_ticket: function(opts) {
                if (opts.key === 'PROJ-100') {
                    return { fields: { description: description, parent: { key: 'PROJ-50' } } };
                }
                return { fields: { summary: 'Build example workflow' } };
            },
            jira_search_by_jql: function() { return []; },
            jira_create_ticket_with_parent: function() {
                ticketCounter++;
                return '{"key":"PROJ-' + ticketCounter + '"}';
            },
            jira_link_issues: function(opts) { links.push(opts); },
            jira_move_to_status: function(opts) { moved.push(opts); },
            jira_post_comment: function() {}
        });

        mod.action({ ticket: { key: 'PROJ-100' } });

        // service-api depends_on core-db → core-db (PROJ-201) blocks service-api (PROJ-202)
        assert.equal(links.length, 1, 'one Blocks link created');
        assert.equal(links[0].relationship, 'Blocks', 'relationship is Blocks');
        assert.equal(links[0].sourceKey, 'PROJ-201', 'blocker is core-db ticket');
        assert.equal(links[0].anotherKey, 'PROJ-202', 'dependent is service-api ticket');
        assert.equal(moved.length, 1, 'one ticket moved to Blocked');
        assert.equal(moved[0].key, 'PROJ-202', 'service-api moved to Blocked');
        assert.equal(moved[0].statusName, 'Blocked', 'status is Blocked');
    });

    test('respects custom blocksRelationship and blockedStatus from customParams', function() {
        var links = [];
        var moved = [];
        var ticketCounter = 300;
        var mod = makeModule({
            jira_get_ticket: function(opts) {
                if (opts.key === 'PROJ-100') {
                    return { fields: { description: description, parent: { key: 'PROJ-50' } } };
                }
                return { fields: { summary: 'Story' } };
            },
            jira_search_by_jql: function() { return []; },
            jira_create_ticket_with_parent: function() {
                ticketCounter++;
                return '{"key":"PROJ-' + ticketCounter + '"}';
            },
            jira_link_issues: function(opts) { links.push(opts); },
            jira_move_to_status: function(opts) { moved.push(opts); },
            jira_post_comment: function() {}
        });

        mod.action({
            ticket: { key: 'PROJ-100' },
            customParams: { blocksRelationship: 'is blocked by', blockedStatus: 'On Hold' }
        });

        assert.equal(links.length, 1, 'one link');
        assert.equal(links[0].relationship, 'is blocked by', 'custom relationship used');
        assert.equal(moved[0].statusName, 'On Hold', 'custom blocked status used');
    });

    test('skips repos that already have a matching Sub-task', function() {
        var created = [];
        var mod = makeModule({
            jira_get_ticket: function(opts) {
                if (opts.key === 'PROJ-100') {
                    return { fields: { description: description, parent: { key: 'PROJ-50' } } };
                }
                return { fields: { summary: 'Parent story' } };
            },
            jira_search_by_jql: function() {
                return [{ fields: { summary: '[core-db] Parent story' } }]; // already exists
            },
            jira_create_ticket_with_parent: function(opts) { created.push(opts); return '{"key":"PROJ-201"}'; },
            jira_post_comment: function() {}
        });

        var result = mod.action({ ticket: { key: 'PROJ-100' } });

        assert.equal(result.success, true, 'succeeds');
        assert.equal(created.length, 1, 'only one created (core-db skipped)');
        assert.equal(result.skipped, 1, 'one skipped');
        assert.equal(created[0].summary.indexOf('[service-api]') === 0, true, 'service-api was created');
    });

    test('returns error when SA ticket has no parent', function() {
        var mod = makeModule({
            jira_get_ticket: function() {
                return { fields: { description: description, parent: null } };
            }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, false, 'fails without parent');
        assert.equal(result.error.indexOf('no parent') !== -1, true, 'error mentions parent');
    });

    test('returns error when no affected_repos block in description', function() {
        var mod = makeModule({
            jira_get_ticket: function(opts) {
                if (opts.key === 'PROJ-100') {
                    return { fields: { description: 'Just some text, no repos block', parent: { key: 'PROJ-50' } } };
                }
                return { fields: { summary: 'Parent story' } };
            }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, false, 'fails without repos block');
    });

    test('module.exports is guarded with typeof for postJSAction compatibility', function() {
        var code = file_read({ path: 'js/createRepoTasks.js' });
        var hasGuard = code.indexOf('typeof module') !== -1 && code.indexOf('module.exports') !== -1;
        assert.equal(hasGuard, true, 'module.exports must be inside typeof module guard');
    });
});

// ---------------------------------------------------------------------------
// action — branch coverage (gh-1004)
// ---------------------------------------------------------------------------

suite('createRepoTasks — action branch coverage', function() {
    var reposJson = JSON.stringify([
        { name: 'core-db', reason: 'DB migration' },
        { name: 'service-api', reason: 'API change', depends_on: ['core-db'] }
    ]);
    var description = 'Solution\n\n{code:json|title=affected_repos}\n' + reposJson + '\n{code}\n\n----';

    function makeHappyModule(overrides) {
        var base = {
            jira_get_ticket: function(opts) {
                if (opts.key === 'PROJ-100') {
                    return { fields: { description: description, parent: { key: 'PROJ-50' } } };
                }
                return { fields: { summary: 'Build example workflow' } };
            },
            jira_search_by_jql: function() { return []; },
            jira_create_ticket_with_parent: function() { return '{"key":"PROJ-201"}'; },
            jira_link_issues: function() {},
            jira_move_to_status: function() {},
            jira_post_comment: function() {}
        };
        for (var k in (overrides || {})) { base[k] = overrides[k]; }
        return makeModule(base);
    }

    test('returns error when params carry no ticket key', function() {
        var mod = makeHappyModule();
        var result = mod.action({});
        assert.equal(result.success, false, 'fails without ticket key');
        assert.equal(result.error.indexOf('no ticket key') !== -1, true, 'error mentions ticket key');
    });

    test('outer catch returns failure when the tracker call throws', function() {
        var mod = makeHappyModule({
            jira_get_ticket: function() { throw new Error('tracker down'); }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, false, 'fails when tracker throws');
        assert.equal(result.error.indexOf('createRepoTasks failed') !== -1, true, 'error is wrapped');
    });

    test('searchIssues failure is tolerated and tasks are still created', function() {
        var created = [];
        var mod = makeHappyModule({
            jira_search_by_jql: function() { throw new Error('search broken'); },
            jira_create_ticket_with_parent: function(opts) { created.push(opts); return '{"key":"PROJ-201"}'; }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds without dedupe');
        assert.equal(created.length, 2, 'both repos created');
    });

    test('non-array searchIssues result is treated as no existing sub-tasks', function() {
        var created = [];
        var mod = makeHappyModule({
            jira_search_by_jql: function() { return 'garbage'; },
            jira_create_ticket_with_parent: function(opts) { created.push(opts); return '{"key":"PROJ-201"}'; }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(created.length, 2, 'both repos created');
    });

    test('a failing create does not stop the remaining repos', function() {
        var created = [];
        var mod = makeHappyModule({
            jira_create_ticket_with_parent: function(opts) {
                if (opts.summary.indexOf('[core-db]') === 0) { throw new Error('create failed'); }
                created.push(opts);
                return '{"key":"PROJ-202"}';
            }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(created.length, 1, 'only service-api created');
        assert.equal(result.created, 1, 'one created reported');
    });

    test('an unparseable create result is not counted as created', function() {
        var mod = makeHappyModule({
            jira_create_ticket_with_parent: function() { return 'not a key at all'; }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(result.created, 0, 'nothing counted as created');
    });

    test('repo without depends_on produces no links or moves', function() {
        var links = [];
        var moved = [];
        var singleRepoDescription = 'Solution\n\n{code:json|title=affected_repos}\n' +
            JSON.stringify([{ name: 'solo-repo', reason: 'Only one' }]) + '\n{code}';
        var mod = makeHappyModule({
            jira_get_ticket: function(opts) {
                if (opts.key === 'PROJ-100') {
                    return { fields: { description: singleRepoDescription, parent: { key: 'PROJ-50' } } };
                }
                return { fields: { summary: 'Story' } };
            },
            jira_link_issues: function(opts) { links.push(opts); },
            jira_move_to_status: function(opts) { moved.push(opts); }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(links.length, 0, 'no links for repo without deps');
        assert.equal(moved.length, 0, 'no moves for repo without deps');
    });

    test('dependency on a repo that failed to create is skipped without failing', function() {
        var links = [];
        var mod = makeHappyModule({
            jira_create_ticket_with_parent: function(opts) {
                if (opts.summary.indexOf('[core-db]') === 0) { throw new Error('create failed'); }
                return '{"key":"PROJ-202"}';
            },
            jira_link_issues: function(opts) { links.push(opts); }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(links.length, 0, 'no link when blocker was not created');
    });

    test('linkIssues failure still allows the move to Blocked', function() {
        var moved = [];
        var mod = makeHappyModule({
            jira_create_ticket_with_parent: function(opts) {
                return opts.summary.indexOf('[core-db]') === 0 ? '{"key":"PROJ-201"}' : '{"key":"PROJ-202"}';
            },
            jira_link_issues: function() { throw new Error('link failed'); },
            jira_move_to_status: function(opts) { moved.push(opts); }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(moved.length, 1, 'dependent still moved to Blocked');
    });

    test('moveToStatus failure is swallowed', function() {
        var mod = makeHappyModule({
            jira_create_ticket_with_parent: function(opts) {
                return opts.summary.indexOf('[core-db]') === 0 ? '{"key":"PROJ-201"}' : '{"key":"PROJ-202"}';
            },
            jira_move_to_status: function() { throw new Error('move failed'); }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
    });

    test('postComment failure is swallowed', function() {
        var mod = makeHappyModule({
            jira_post_comment: function() { throw new Error('comment failed'); }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
    });

    test('posts the sub-task summary comment to the SA ticket', function() {
        var comments = [];
        var mod = makeHappyModule({
            jira_create_ticket_with_parent: function(opts) {
                return opts.summary.indexOf('[core-db]') === 0 ? '{"key":"PROJ-201"}' : '{"key":"PROJ-202"}';
            },
            jira_search_by_jql: function() { return [{ fields: { summary: '[core-db] Build example workflow' } }]; },
            jira_post_comment: function(opts) { comments.push(opts); }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(result.skipped, 1, 'core-db skipped as duplicate');
        assert.equal(comments.length, 1, 'one comment posted');
        assert.equal(comments[0].ticketKey, 'PROJ-100', 'comment goes to the SA ticket');
        var lines = comments[0].comment.split('\n');
        assert.equal(lines[0], 'h3. Sub-tasks status', 'Jira wiki header');
        assert.equal(lines[2], '* [PROJ-202|https://jira.example.com/browse/PROJ-202] — service-api', 'created line with link and repo');
        assert.equal(lines[4], 'Skipped (already exists): 1', 'skipped line present');
    });

    test('handles plain string repo entries', function() {
        var created = [];
        var stringDescription = 'Solution\n\n{code:json|title=affected_repos}\n' +
            JSON.stringify(['repo-a', 'repo-b']) + '\n{code}';
        var mod = makeHappyModule({
            jira_get_ticket: function(opts) {
                if (opts.key === 'PROJ-100') {
                    return { fields: { description: stringDescription, parent: { key: 'PROJ-50' } } };
                }
                return { fields: { summary: 'Story' } };
            },
            jira_create_ticket_with_parent: function(opts) { created.push(opts); return '{"key":"PROJ-201"}'; }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(created.length, 2, 'both string repos created');
        assert.equal(created[0].summary, '[repo-a] Story', 'summary built from string repo');
    });
});

// ---------------------------------------------------------------------------
// extracted helpers (gh-1004)
// ---------------------------------------------------------------------------

suite('createRepoTasks — extracted helpers', function() {
    function fakeTracker(behavior) {
        var calls = { create: [], link: [], move: [], comment: [] };
        return {
            calls: calls,
            extractProject: function() { return 'PROJ'; },
            createTicketWithParent: function(opts) {
                calls.create.push(opts);
                if (behavior && behavior.createError) { throw new Error('create failed'); }
                return behavior && typeof behavior.createResult !== 'undefined' ? behavior.createResult : '{"key":"PROJ-9"}';
            },
            linkIssues: function(opts) {
                calls.link.push(opts);
                if (behavior && behavior.linkError) { throw new Error('link failed'); }
            },
            moveToStatus: function(opts) {
                calls.move.push(opts);
                if (behavior && behavior.moveError) { throw new Error('move failed'); }
            },
            postComment: function(opts) { calls.comment.push(opts); },
            searchIssues: function(opts) {
                calls.search = opts;
                if (behavior && behavior.searchError) { throw new Error('search failed'); }
                return behavior && typeof behavior.searchResult !== 'undefined' ? behavior.searchResult : [];
            }
        };
    }

    test('decideDuplicate matches repo tag anywhere in existing summaries', function() {
        var mod = makeModule();
        assert.equal(mod.decideDuplicate(['[core-db] Story'], 'core-db'), true, 'match');
        assert.equal(mod.decideDuplicate(['[core] Story'], 'core-db'), false, 'no false positive on partial name');
        assert.equal(mod.decideDuplicate([], 'core-db'), false, 'empty list');
    });

    test('buildRepoSummary prefixes repo tag and truncates at 255 chars', function() {
        var mod = makeModule();
        assert.equal(mod.buildRepoSummary('repo-a', 'Story'), '[repo-a] Story', 'prefixed summary');
        var long = mod.buildRepoSummary('repo-a', 'B'.repeat(300));
        assert.equal(long.length, 255, 'truncated to Jira limit');
        assert.equal(long.slice(-3), '...', 'ends with ellipsis');
    });

    test('buildScopeDescription links SA and parent tickets', function() {
        var mod = makeModule();
        var desc = mod.buildScopeDescription('repo-a', 'PROJ-100', 'PROJ-50', 'https://jira.example.com');
        assert.equal(desc.indexOf('*repo-a*') !== -1, true, 'repo emphasized');
        assert.equal(desc.indexOf('[PROJ-100|https://jira.example.com/browse/PROJ-100]') !== -1, true, 'SA link');
        assert.equal(desc.indexOf('[PROJ-50|https://jira.example.com/browse/PROJ-50]') !== -1, true, 'parent link');
    });

    test('extractCreatedKey accepts plain key strings, JSON strings and objects', function() {
        var mod = makeModule();
        assert.equal(mod.extractCreatedKey('PROJ-7'), 'PROJ-7', 'plain key string');
        assert.equal(mod.extractCreatedKey('{"key":"PROJ-8"}'), 'PROJ-8', 'JSON string with key');
        assert.equal(mod.extractCreatedKey({ key: 'PROJ-9' }), 'PROJ-9', 'object with key');
        assert.equal(mod.extractCreatedKey({ id: 'PROJ-10' }), 'PROJ-10', 'object with id');
        assert.equal(mod.extractCreatedKey('not a key at all'), null, 'garbage string');
        assert.equal(mod.extractCreatedKey(null), null, 'null');
    });

    test('buildSummaryComment lists created repos and skips', function() {
        var mod = makeModule();
        var comment = mod.buildSummaryComment(
            [{ repo: 'core-db', key: 'PROJ-201' }, { repo: 'api', key: 'PROJ-202' }],
            1,
            'https://jira.example.com'
        );
        var lines = comment.split('\n');
        assert.equal(lines[0], 'h3. Sub-tasks status', 'header');
        assert.equal(lines[2], '* [PROJ-201|https://jira.example.com/browse/PROJ-201] — core-db', 'first created line');
        assert.equal(lines[4], '* [PROJ-202|https://jira.example.com/browse/PROJ-202] — api', 'second created line');
        assert.equal(lines[6], 'Skipped (already exists): 1', 'skipped section');
        var none = mod.buildSummaryComment([], 0, 'https://jira.example.com');
        assert.equal(none.split('\n')[2], '* none', 'explicit none when nothing created');
        var noSkip = mod.buildSummaryComment([{ repo: 'a', key: 'K-1' }], 0, 'https://j');
        assert.equal(noSkip.indexOf('Skipped') === -1, true, 'no skipped line when zero');
    });

    test('loadExistingSummaries maps issue summaries and tolerates failures', function() {
        var mod = makeModule();
        var t = fakeTracker({ searchResult: [{ fields: { summary: '[a] S' } }, { fields: {} }] });
        var summaries = mod.loadExistingSummaries(t, 'PROJ-50');
        assert.deepEqual(summaries, ['[a] S', ''], 'summaries mapped, missing tolerated');
        assert.equal(t.calls.search.jql.indexOf('project = PROJ') === 0, true, 'JQL scoped to parent project');
        var failing = fakeTracker({ searchError: true });
        assert.deepEqual(mod.loadExistingSummaries(failing, 'PROJ-50'), [], 'search failure yields empty list');
        var garbage = fakeTracker({ searchResult: 'nope' });
        assert.deepEqual(mod.loadExistingSummaries(garbage, 'PROJ-50'), [], 'non-array yields empty list');
    });

    test('createSubTasks creates one ticket per repo, skipping duplicates and failures', function() {
        var mod = makeModule();
        var t = fakeTracker();
        var out = mod.createSubTasks(
            t, [{ name: 'a' }, { name: 'b', depends_on: ['a'] }, { name: 'c' }],
            'PROJ-50', 'Story', 'PROJ-100', 'https://jira.example.com', ['development'],
            ['[b] Story']
        );
        assert.equal(t.calls.create.length, 2, 'b skipped as duplicate, a and c created');
        assert.equal(out.created.length, 2, 'two created entries');
        assert.equal(out.skipped, 1, 'one skipped');
        assert.deepEqual(out.repoKeyMap, { a: 'PROJ-9', c: 'PROJ-9' }, 'key map per repo');
        assert.deepEqual(t.calls.create[0].labels, ['development'], 'labels passed through');
        var failing = fakeTracker({ createError: true });
        var out2 = mod.createSubTasks(failing, [{ name: 'a' }], 'PROJ-50', 'Story', 'PROJ-100', 'https://j', ['development'], []);
        assert.equal(out2.created.length, 0, 'create failure not counted');
    });

    test('wireDependencies links blockers and moves dependents, tolerating per-dep failures', function() {
        var mod = makeModule();
        var t = fakeTracker();
        mod.wireDependencies(
            t,
            [{ repo: 'api', key: 'PROJ-202', dependsOn: ['core-db'] }, { repo: 'solo', key: 'PROJ-203', dependsOn: [] }],
            { 'core-db': 'PROJ-201' },
            'Blocks', 'Blocked'
        );
        assert.equal(t.calls.link.length, 1, 'one link for resolvable dep');
        assert.equal(t.calls.link[0].sourceKey, 'PROJ-201', 'blocker is the source');
        assert.equal(t.calls.link[0].anotherKey, 'PROJ-202', 'dependent is the target');
        assert.equal(t.calls.move.length, 1, 'one move');
        assert.equal(t.calls.move[0].statusName, 'Blocked', 'moved to blocked status');
        var t2 = fakeTracker();
        mod.wireDependencies(t2, [{ repo: 'api', key: 'PROJ-202', dependsOn: ['ghost'] }], {}, 'Blocks', 'Blocked');
        assert.equal(t2.calls.link.length, 0, 'missing blocker produces no link');
        var t3 = fakeTracker({ linkError: true });
        mod.wireDependencies(t3, [{ repo: 'api', key: 'PROJ-202', dependsOn: ['core-db'] }], { 'core-db': 'PROJ-201' }, 'Blocks', 'Blocked');
        assert.equal(t3.calls.move.length, 1, 'move still attempted when link fails');
        var t4 = fakeTracker({ moveError: true });
        mod.wireDependencies(t4, [{ repo: 'api', key: 'PROJ-202', dependsOn: ['core-db'] }], { 'core-db': 'PROJ-201' }, 'Blocks', 'Blocked');
        assert.equal(t4.calls.link.length, 1, 'link attempted when move fails');
    });
});
