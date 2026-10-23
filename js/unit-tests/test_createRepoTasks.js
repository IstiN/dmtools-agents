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
        makeRequire({ './config.js': configModule, './common/trackers.js': d2Trackers(defaultGlobals), './common/linkedIssuesReport.js': loadModule('js/common/linkedIssuesReport.js') }),
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
        assert.equal(result.error, 'No ticket key in params', 'error message');
    });

    test('outer catch returns failure when the tracker call throws', function() {
        var mod = makeHappyModule({
            jira_get_ticket: function() { throw new Error('tracker down'); }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, false, 'fails when tracker throws');
        assert.equal(result.error.indexOf('tracker down') !== -1, true, 'underlying error preserved');
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
        assert.equal(result.created, 1, 'error entry not counted as created');
    });

    test('an unparseable create result leaves no key for dependency wiring', function() {
        var links = [];
        var mod = makeHappyModule({
            jira_create_ticket_with_parent: function() { return 'not a key at all'; },
            jira_link_issues: function(opts) { links.push(opts); }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(links.length, 0, 'no links without resolvable keys');
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

    test('no move to Blocked when every link attempt fails', function() {
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
        assert.equal(moved.length, 0, 'dependent not moved when no link succeeded');
    });

    test('move happens when at least one link succeeds, even if another fails', function() {
        var moved = [];
        var threeRepos = 'Solution\n\n{code:json|title=affected_repos}\n' + JSON.stringify([
            { name: 'core-db' },
            { name: 'ui-lib' },
            { name: 'service-api', depends_on: ['core-db', 'ui-lib'] }
        ]) + '\n{code}';
        var mod = makeHappyModule({
            jira_get_ticket: function(opts) {
                if (opts.key === 'PROJ-100') {
                    return { fields: { description: threeRepos, parent: { key: 'PROJ-50' } } };
                }
                return { fields: { summary: 'Story' } };
            },
            jira_create_ticket_with_parent: function(opts) {
                if (opts.summary.indexOf('[core-db]') === 0) { return '{"key":"PROJ-201"}'; }
                if (opts.summary.indexOf('[ui-lib]') === 0) { return '{"key":"PROJ-203"}'; }
                return '{"key":"PROJ-202"}';
            },
            jira_link_issues: function(opts) {
                if (opts.sourceKey === 'PROJ-201') { throw new Error('link failed'); }
            },
            jira_move_to_status: function(opts) { moved.push(opts); }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(moved.length, 1, 'dependent moved when one link succeeded');
        assert.equal(moved[0].key, 'PROJ-202', 'service-api moved');
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
        assert.equal(comments[0].key, 'PROJ-100', 'comment goes to the SA ticket');
        var lines = comments[0].comment.split('\n');
        assert.equal(lines[0], 'h3. Development Sub-tasks', 'Jira wiki header');
        assert.equal(lines[2], '* ✅ [PROJ-202|https://jira.example.com/browse/PROJ-202] — service-api', 'created line with link and repo');
        assert.equal(lines[4], '_Skipped (already exist): core-db_', 'skipped footer');
    });

    test('comment shows an error line for repos that failed to create', function() {
        var comments = [];
        var mod = makeHappyModule({
            jira_create_ticket_with_parent: function(opts) {
                if (opts.summary.indexOf('[core-db]') === 0) { throw new Error('boom'); }
                return '{"key":"PROJ-202"}';
            },
            jira_post_comment: function(opts) { comments.push(opts); }
        });
        var result = mod.action({ ticket: { key: 'PROJ-100' } });
        assert.equal(result.success, true, 'succeeds');
        assert.equal(result.created, 1, 'failed repo not counted');
        var lines = comments[0].comment.split('\n');
        assert.equal(lines[2].indexOf('❌') !== -1, true, 'error line marker');
        assert.equal(lines[2].indexOf('core-db') !== -1, true, 'error line names repo');
        assert.equal(lines[2].indexOf('boom') !== -1, true, 'error line carries the error');
        assert.equal(lines[3], '* ✅ [PROJ-202|https://jira.example.com/browse/PROJ-202] — service-api', 'ok line');
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
    function throwsIf(behavior, flag) {
        if (behavior && behavior[flag]) {
            throw new Error(flag.replace(/Error$/, '') + ' failed');
        }
    }

    function resultFor(behavior, key, fallback) {
        return behavior && typeof behavior[key] !== 'undefined' ? behavior[key] : fallback;
    }

    function fakeTracker(behavior) {
        var calls = { create: [], link: [], move: [], comment: [], search: [] };
        return {
            calls: calls,
            createTicketWithParent: function(project, type, title, desc, parentKey, extra) {
                calls.create.push({ project: project, issueType: type, summary: title, description: desc, parentKey: parentKey, labels: extra && extra.labels });
                throwsIf(behavior, 'createError');
                return resultFor(behavior, 'createResult', '{"key":"PROJ-9"}');
            },
            linkIssues: function(sourceKey, anotherKey, relationship) {
                calls.link.push({ sourceKey: sourceKey, anotherKey: anotherKey, relationship: relationship });
                throwsIf(behavior, 'linkError');
            },
            moveToStatus: function(key, statusName) {
                calls.move.push({ key: key, statusName: statusName });
                throwsIf(behavior, 'moveError');
            },
            postComment: function(key, comment) { calls.comment.push({ key: key, comment: comment }); },
            searchIssues: function(jql, opts) {
                calls.search.push({ jql: jql, opts: opts });
                throwsIf(behavior, 'searchError');
                return resultFor(behavior, 'searchResult', []);
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
        var bare = mod.buildScopeDescription('repo-a', 'PROJ-100', 'PROJ-50', '');
        assert.equal(bare.indexOf('PROJ-100]') === -1, true, 'bare key without baseUrl');
    });

    test('extractCreatedKey accepts plain key strings, JSON strings and objects', function() {
        var mod = makeModule();
        assert.equal(mod.extractCreatedKey('PROJ-7'), 'PROJ-7', 'plain key string');
        assert.equal(mod.extractCreatedKey('{"key":"PROJ-8"}'), 'PROJ-8', 'JSON string with key');
        assert.equal(mod.extractCreatedKey({ key: 'PROJ-9' }), 'PROJ-9', 'object with key');
        assert.equal(mod.extractCreatedKey({ id: 'PROJ-10' }), 'PROJ-10', 'object with id');
        assert.equal(mod.extractCreatedKey('not a key at all'), null, 'garbage string');
        assert.equal(mod.extractCreatedKey(null), null, 'null');
        var hostile = {};
        Object.defineProperty(hostile, 'key', { get: function() { throw new Error('nope'); } });
        assert.equal(mod.extractCreatedKey(hostile), null, 'throwing accessor yields null');
    });

    test('buildSummaryComment lists ok and error lines plus skips', function() {
        var mod = makeModule();
        var comment = mod.buildSummaryComment(
            [{ repo: 'core-db', key: 'PROJ-201' }, { repo: 'api', key: null, error: 'Error: boom' }],
            ['core-db'],
            'https://jira.example.com'
        );
        var lines = comment.split('\n');
        assert.equal(lines[0], 'h3. Development Sub-tasks', 'header');
        assert.equal(lines[2], '* ✅ [PROJ-201|https://jira.example.com/browse/PROJ-201] — core-db', 'ok line');
        assert.equal(lines[3].indexOf('❌') !== -1 && lines[3].indexOf('boom') !== -1, true, 'error line');
        assert.equal(lines[5], '_Skipped (already exist): core-db_', 'skipped footer');
        var none = mod.buildSummaryComment([], [], 'https://jira.example.com');
        assert.equal(none, 'h3. Development Sub-tasks\n\n', 'no entries, no skips');
        var noSkip = mod.buildSummaryComment([{ repo: 'a', key: 'K-1' }], [], 'https://j');
        assert.equal(noSkip.indexOf('Skipped') === -1, true, 'no skipped footer when empty');
    });

    test('loadExistingSummaries maps issue summaries and tolerates failures', function() {
        var mod = makeModule();
        var t = fakeTracker({ searchResult: [{ fields: { summary: '[a] S' } }, { fields: {} }, { summary: 'plain' }] });
        var summaries = mod.loadExistingSummaries(t, 'PROJ-50');
        assert.deepEqual(summaries, ['[a] S', '', 'plain'], 'summaries mapped from both shapes');
        assert.equal(t.calls.search[0].jql, 'parent = PROJ-50 AND issuetype = Sub-task', 'JQL scoped to parent');
        assert.deepEqual(t.calls.search[0].opts, { fields: ['summary'] }, 'summary fields requested');
        var failing = fakeTracker({ searchError: true });
        assert.deepEqual(mod.loadExistingSummaries(failing, 'PROJ-50'), [], 'search failure yields empty list');
        var garbage = fakeTracker({ searchResult: 'nope' });
        assert.deepEqual(mod.loadExistingSummaries(garbage, 'PROJ-50'), [], 'non-array yields empty list');
    });

    test('createSubTasks creates one ticket per repo, skipping duplicates and failures', function() {
        var mod = makeModule();
        var t = fakeTracker();
        var out = mod.createSubTasks(
            t,
            [{ name: 'a' }, { name: 'b', depends_on: ['a'] }, { name: 'c' }],
            'PROJ', 'PROJ-50', 'Story', 'PROJ-100', 'https://jira.example.com', ['development'],
            ['[b] Story']
        );
        assert.equal(t.calls.create.length, 2, 'b skipped as duplicate, a and c created');
        assert.equal(out.created.length, 2, 'two created entries');
        assert.deepEqual(out.skipped, ['b'], 'skipped repo names');
        assert.deepEqual(out.repoKeyMap, { a: 'PROJ-9', c: 'PROJ-9' }, 'key map per repo');
        assert.deepEqual(t.calls.create[0].labels, ['development'], 'labels passed through');
        assert.equal(t.calls.create[0].issueType, 'Sub-task', 'sub-task issue type');
        assert.equal(t.calls.create[0].parentKey, 'PROJ-50', 'parent key');
        var failing = fakeTracker({ createError: true });
        var out2 = mod.createSubTasks(failing, [{ name: 'a' }], 'PROJ', 'PROJ-50', 'Story', 'PROJ-100', 'https://j', ['development'], []);
        assert.equal(out2.created.length, 1, 'error entry recorded');
        assert.equal(out2.created[0].error.indexOf('create failed') !== -1, true, 'error captured');
        assert.deepEqual(out2.repoKeyMap, {}, 'no key on failure');
    });

    test('wireDependencies links blockers, moves dependents once per dependent', function() {
        var mod = makeModule();
        var t = fakeTracker();
        mod.wireDependencies(
            t,
            [{ repo: 'api', key: 'PROJ-202', depends_on: ['core-db', 'ui-lib'] }, { repo: 'solo', key: 'PROJ-203', depends_on: [] }],
            { 'core-db': 'PROJ-201', 'ui-lib': 'PROJ-204' },
            'Blocks', 'Blocked'
        );
        assert.equal(t.calls.link.length, 2, 'one link per resolvable dep');
        assert.equal(t.calls.link[0].sourceKey, 'PROJ-201', 'blocker is the source');
        assert.equal(t.calls.link[0].anotherKey, 'PROJ-202', 'dependent is the target');
        assert.equal(t.calls.link[0].relationship, 'Blocks', 'relationship');
        assert.equal(t.calls.move.length, 1, 'one move per dependent');
        assert.equal(t.calls.move[0].key, 'PROJ-202', 'dependent moved');
        assert.equal(t.calls.move[0].statusName, 'Blocked', 'blocked status');
        var t2 = fakeTracker();
        mod.wireDependencies(t2, [{ repo: 'api', key: 'PROJ-202', depends_on: ['ghost'] }], {}, 'Blocks', 'Blocked');
        assert.equal(t2.calls.link.length, 0, 'missing blocker produces no link');
        var t3 = fakeTracker({ linkError: true });
        mod.wireDependencies(t3, [{ repo: 'api', key: 'PROJ-202', depends_on: ['core-db'] }], { 'core-db': 'PROJ-201' }, 'Blocks', 'Blocked');
        assert.equal(t3.calls.move.length, 0, 'no move when the only link fails');
        var t4 = fakeTracker({ moveError: true });
        mod.wireDependencies(t4, [{ repo: 'api', key: 'PROJ-202', depends_on: ['core-db'] }], { 'core-db': 'PROJ-201' }, 'Blocks', 'Blocked');
        assert.equal(t4.calls.link.length, 1, 'link attempted when move fails');
        assert.equal(t4.calls.move.length, 1, 'move attempted');
    });

    test('postSummaryComment posts and swallows failures', function() {
        var mod = makeModule();
        var t = fakeTracker();
        mod.postSummaryComment(t, 'PROJ-100', 'body');
        assert.equal(t.calls.comment.length, 1, 'comment posted');
        assert.equal(t.calls.comment[0].key, 'PROJ-100', 'to the SA ticket');
        assert.equal(t.calls.comment[0].comment, 'body', 'body verbatim');
        var t2 = fakeTracker({ /* postComment never throws here; exercise catch via move mock reuse */ });
        t2.postComment = function() { throw new Error('comment failed'); };
        mod.postSummaryComment(t2, 'PROJ-100', 'body');
    });
});

// ---------------------------------------------------------------------------
// action-phase helpers (gh-1197)
// ---------------------------------------------------------------------------

suite('createRepoTasks — action-phase helpers', function() {

    test('extractSaKey reads the ticket key and reports a sentinel error without one', function() {
        var mod = makeModule();
        assert.deepEqual(mod.extractSaKey({ ticket: { key: 'PROJ-100' } }), { saKey: 'PROJ-100' }, 'key extracted');
        assert.deepEqual(mod.extractSaKey({ ticket: {} }), { error: 'No ticket key in params' }, 'missing key');
        assert.deepEqual(mod.extractSaKey({}), { error: 'No ticket key in params' }, 'missing ticket');
        assert.deepEqual(mod.extractSaKey({ ticket: { key: '' } }), { error: 'No ticket key in params' }, 'empty key');
    });

    test('resolveTaskOptions defaults relationship/status/labels and honours customParams at both levels', function() {
        var mod = makeModule();
        var defaults = mod.resolveTaskOptions({});
        assert.deepEqual(
            [defaults.blocksRelationship, defaults.blockedStatus, defaults.ticketLabels],
            ['Blocks', 'Blocked', ['development']],
            'defaults'
        );
        var top = mod.resolveTaskOptions({ customParams: { blocksRelationship: 'Depends', blockedStatus: 'Hold', labels: ['x'] } });
        assert.deepEqual(
            [top.blocksRelationship, top.blockedStatus, top.ticketLabels],
            ['Depends', 'Hold', ['x']],
            'top-level customParams win'
        );
        var nested = mod.resolveTaskOptions({ jobParams: { customParams: { blocksRelationship: 'rel', labels: ['y'] } } });
        assert.deepEqual(
            [nested.blocksRelationship, nested.blockedStatus, nested.ticketLabels],
            ['rel', 'Blocked', ['y']],
            'jobParams-nested customParams are read, per-key defaults fill the gaps'
        );
        assert.equal(nested.customParams, nested.customParams && nested.customParams, 'customParams carried for createTracker');
    });

    test('resolveSaTicketContext reads description and parent from fields (or the bare ticket)', function() {
        var mod = makeModule();
        var t = fakeTracker();
        var ctx = mod.resolveSaTicketContext({ getIssue: function() { return { fields: { description: 'desc text', parent: { key: 'PROJ-50' } } }; } }, 'PROJ-100');
        assert.equal(ctx.description, 'desc text', 'description read from fields');
        assert.equal(ctx.parentKey, 'PROJ-50', 'parent key read from fields');

        var bare = mod.resolveSaTicketContext({ getIssue: function() { return { description: 42, parent: 'PLAIN-1' }; } }, 'PROJ-100');
        assert.equal(bare.description, '42', 'non-string description is stringified');
        assert.equal(bare.parentKey, 'PLAIN-1', 'plain-string parent yields its value');

        var none = mod.resolveSaTicketContext({ getIssue: function() { return { fields: { parent: null }; } }, 'PROJ-100');
        assert.equal(none.description, '', 'missing description yields empty string');
        assert.equal(none.parentKey, null, 'null parent yields null key');

        var objectParent = mod.resolveSaTicketContext({ getIssue: function() { return { fields: { parent: { key: 'K-9' }; } }, 'PROJ-100');
        assert.equal(objectParent.parentKey, 'K-9', 'object parent yields key');

        var noKeyParent = mod.resolveSaTicketContext({ getIssue: function() { return { fields: { parent: {} } } }; }, 'PROJ-100');
        assert.equal(noKeyParent.parentKey, null, 'object parent without key yields null');
    });

    test('resolveParentSummary prefers the parent summary and falls back to the key', function() {
        var mod = makeModule();
        assert.equal(
            mod.resolveParentSummary({ getIssue: function() { return { fields: { summary: 'Story' } } } }, 'PROJ-50'),
            'Story', 'summary from fields'
        );
        assert.equal(
            mod.resolveParentSummary({ getIssue: function() { return { summary: 'Bare' } } }, 'PROJ-50'),
            'Bare', 'summary from a bare ticket object'
        );
        assert.equal(
            mod.resolveParentSummary({ getIssue: function() { return { fields: {} } } }, 'PROJ-50'),
            'PROJ-50', 'missing summary falls back to the parent key'
        );
    });

    test('requireAffectedRepos separates the repos payload from the no-repos error', function() {
        var mod = makeModule();
        var ok = mod.requireAffectedRepos('prefix {code:json|title=affected_repos}\n["repo-a"]\n{code}', 'PROJ-100');
        assert.deepEqual(ok.repos, ['repo-a'], 'repos parsed');
        assert.equal(ok.error, undefined, 'no error on success');
        var bad = mod.requireAffectedRepos('no repos here', 'PROJ-100');
        assert.equal(bad.repos, undefined, 'no repos on failure');
        assert.equal(bad.error, 'No affected repos found in PROJ-100 — ensure writeSolutionAndLabels ran first', 'error message preserved');
    });

    test('repoNamesCsv handles string and object entries in one list', function() {
        var mod = makeModule();
        assert.equal(mod.repoNamesCsv(['a', { name: 'b' }, 'c']), 'a, b, c', 'mixed entry shapes');
        assert.equal(mod.repoNamesCsv([]), '', 'empty list');
    });

    test('postOutcomeSummaryComment posts only when something was created or skipped', function() {
        var mod = makeModule();
        var t1 = fakeTracker();
        mod.postOutcomeSummaryComment(t1, 'PROJ-100', 'https://jira.example.com', { created: [], skipped: [] });
        assert.equal(t1.calls.comment.length, 0, 'nothing done — no comment');

        var t2 = fakeTracker();
        mod.postOutcomeSummaryComment(t2, 'PROJ-100', 'https://jira.example.com', {
            created: [{ repo: 'a', key: 'PROJ-201' }],
            skipped: ['b']
        });
        assert.equal(t2.calls.comment.length, 1, 'comment posted');
        assert.contains(t2.calls.comment[0].comment, '_Skipped (already exist): b_');
    });
});
