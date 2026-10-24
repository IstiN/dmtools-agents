/**
 * Unit tests for js/createPlannedStoriesFromOutput.js
 *
 * Tests: planned story creation, parent resolution, exact-summary reuse,
 * integrates/blockedBy links, source label guard.
 */

function loadStoryPlanAction(mocks) {
    var allMocks = Object.assign({
        jira_set_priority: function() {}
    }, mocks || {});

    return loadModule(
        'js/createPlannedStoriesFromOutput.js',
        makeRequire({
            './config.js': configModule,
            './common/jiraHelpers.js': loadModule(
                'js/common/jiraHelpers.js',
                makeRequire({ '../config.js': configModule, './trackers.js': loadModule('js/common/trackers.js', makeRequire({
                '../config.js': configModule,
                './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
            }), allMocks) }),
                allMocks
            ),
            './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({
                '../config.js': configModule,
                './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
            }), allMocks),
            './common/aiResponseParser.js': loadModule(
                'js/common/aiResponseParser.js',
                makeRequire({ '../config.js': configModule }),
                {}
            ),
            './common/linkedIssuesReport.js': loadModule('js/common/linkedIssuesReport.js')
        }),
        allMocks
    );
}

function makeParams(customStoryPlanConfig, overrides) {
    return Object.assign({
        ticket: {
            key: 'SRC-101',
            fields: {
                summary: 'Source ticket summary',
                labels: [],
                priority: { name: 'High' },
                parent: { key: 'PARENT-100' }
            }
        },
        jobParams: {
            customParams: {
                storyPlanCreation: Object.assign({
                    required: true,
                    outputFile: 'outputs/stories.json',
                    defaultParentSource: 'sourceParent',
                    skipIfLabel: 'ai_story_plan_created',
                    addLabel: 'ai_story_plan_created',
                    postSummaryComment: true,
                    summaryCommentTitle: 'Planned Stories',
                    blockedByRelationship: 'is blocked by',
                    blockedStatusName: 'Blocked',
                    projectKey: 'PROJ',
                    issueTypeName: 'Story',
                    additionalLinks: [
                        { target: 'sourceTicket', relationship: 'Relates', includeExisting: true }
                    ]
                }, customStoryPlanConfig || {})
            }
        }
    }, overrides || {});
}

suite('createPlannedStoriesFromOutput — creation flow', function() {
    test('creates planned stories, links them, and marks blocked stories', function() {
        var createCalls = [];
        var linkCalls = [];
        var statusCalls = [];
        var commentCalls = [];
        var labelCalls = [];
        var updateCalls = [];
        var blockedLink = null;

        var storiesJson = JSON.stringify([
            {
                tempId: 'mobile-story',
                type: 'Story',
                summary: 'Mobile implementation story',
                description: 'outputs/stories/mobile_story.md',
                storyPoints: 5,
                integrates: ['sf-story']
            },
            {
                tempId: 'sf-story',
                type: 'Story',
                summary: '[SF] Salesforce implementation story',
                description: 'outputs/stories/sf_story.md',
                priority: 'Medium',
                blockedBy: ['mobile-story']
            }
        ]);

        var m = loadStoryPlanAction({
            file_read: function(arg) {
                var path = typeof arg === 'string' ? arg : arg.path;
                if (path === 'outputs/stories.json') return storiesJson;
                if (path === 'outputs/stories/mobile_story.md') return 'Mobile description';
                if (path === 'outputs/stories/sf_story.md') return 'SF description';
                throw new Error('unexpected file_read: ' + path);
            },
            jira_search_by_jql: function(args) {
                if (args.jql === 'parent = PARENT-100 AND issuetype = "Story" ORDER BY created ASC') {
                    return [];
                }
                throw new Error('unexpected jql: ' + args.jql);
            },
            jira_create_ticket_with_json: function(args) {
                createCalls.push(args);
                return { key: createCalls.length === 1 ? 'PROJ-2001' : 'PROJ-2002' };
            },
            jira_update_field: function(args) {
                updateCalls.push(args);
            },
            jira_set_priority: function() {},
            jira_link_issues: function(args) {
                linkCalls.push(args);
            },
            jira_move_to_status: function(args) {
                statusCalls.push(args);
            },
            jira_post_comment: function(args) {
                commentCalls.push(args);
            },
            jira_add_label: function(args) {
                labelCalls.push(args);
            }
        });

        var result = m.action(makeParams());
        for (var i = 0; i < linkCalls.length; i++) {
            if (linkCalls[i].relationship === 'is blocked by') {
                blockedLink = linkCalls[i];
                break;
            }
        }

        assert.equal(result.success, true, 'action succeeds');
        assert.equal(createCalls.length, 2, 'two stories created');
        assert.equal(createCalls[0].project, 'PROJ', 'creation project can differ from parent project');
        assert.equal(createCalls[0].fieldsJson.issuetype.name, 'Story', 'issue type can be configured');
        assert.equal(createCalls[0].fieldsJson.parent.key, 'PARENT-100', 'mobile parent resolved from source parent');
        assert.equal(createCalls[1].fieldsJson.parent.key, 'PARENT-100', 'sf parent resolved from source parent');
        assert.equal(createCalls[0].fieldsJson.priority.name, 'High', 'mobile story inherits source priority when missing');
        assert.equal(createCalls[1].fieldsJson.priority.name, 'Medium', 'explicit story priority is preserved');
        assert.equal(updateCalls.length, 1, 'story points updated once');
        assert.equal(updateCalls[0].key, 'PROJ-2001', 'story points set on mobile story');
        assert.equal(linkCalls.length, 4, 'two source links + integrates + blocks');
        assert.ok(!!blockedLink, 'blockedBy relationship is configurable');
        assert.equal(statusCalls.length, 1, 'blocked status applied once');
        assert.equal(statusCalls[0].statusName, 'Blocked', 'blocked status is configurable');
        assert.equal(statusCalls[0].key, 'PROJ-2002', 'salesforce story moved to blocked');
        assert.equal(commentCalls.length, 1, 'summary comment posted');
        assert.equal(labelCalls.length, 1, 'source label added');
        assert.equal(labelCalls[0].label, 'ai_story_plan_created', 'correct label added');
    });
});

suite('createPlannedStoriesFromOutput — guards and edge paths (gh-1010 characterization)', function() {

    test('skips when storyPlanCreation is disabled', function() {
        var m = loadStoryPlanAction({
            file_read: function() { throw new Error('must not read files'); }
        });
        var result = m.action(makeParams({ enabled: false }));
        assert.equal(result.success, true);
        assert.equal(result.skipped, true);
        assert.equal(result.message, 'storyPlanCreation disabled');
    });

    test('fails when the source ticket key is missing', function() {
        var m = loadStoryPlanAction({});
        var result = m.action(makeParams({}, { ticket: { fields: {} } }));
        assert.equal(result.success, false);
        assert.equal(result.error, 'Missing source ticket key');
    });

    test('fails when the plan file is required but missing', function() {
        var m = loadStoryPlanAction({
            file_read: function() { return null; }
        });
        var result = m.action(makeParams({ required: true }));
        assert.equal(result.success, false);
        assert.equal(result.error, 'outputs/stories.json not found or empty');
    });

    test('skips silently when the plan file is missing and not required', function() {
        var m = loadStoryPlanAction({
            file_read: function() { return null; }
        });
        var result = m.action(makeParams({ required: false }));
        assert.equal(result.success, true);
        assert.equal(result.skipped, true);
        assert.equal(result.message, 'No story plan file found');
    });

    test('reports invalid JSON and non-array payloads as errors', function() {
        var m = loadStoryPlanAction({
            file_read: function() { return '{not json'; }
        });
        var bad = m.action(makeParams({ required: true }));
        assert.equal(bad.success, false);
        assert.contains(bad.error, 'stories.json is invalid JSON');

        var m2 = loadStoryPlanAction({
            file_read: function() { return '{"a":1}'; }
        });
        var notArray = m2.action(makeParams({ required: true }));
        assert.equal(notArray.success, false);
        assert.contains(notArray.error, 'stories.json is not an array');
    });

    test('returns an empty result when the plan contains no stories', function() {
        var m = loadStoryPlanAction({
            file_read: function() { return '[]'; }
        });
        var result = m.action(makeParams({ required: true }));
        assert.equal(result.success, true);
        assert.deepEqual(result.createdTickets, []);
        assert.equal(result.message, 'No planned stories to create');
    });

    test('records unsupported entry types and missing parents as per-entry failures', function() {
        var m = loadStoryPlanAction({
            file_read: function() {
                return JSON.stringify([
                    { type: 'Bug', summary: 'Not a story' },
                    { summary: 'Orphan story' }
                ]);
            },
            jira_search_by_jql: function() { return []; }
        });

        var result = m.action(makeParams({
            required: true,
            defaultParentSource: undefined
        }, {
            ticket: {
                key: 'SRC-101',
                fields: { summary: 'Src', labels: [] }
            }
        }));

        assert.equal(result.success, false);
        assert.equal(result.createdTickets.length, 2);
        assert.equal(result.createdTickets[0].success, false);
        assert.contains(result.createdTickets[0].error, 'Unsupported entry type');
        assert.equal(result.createdTickets[1].success, false);
        assert.contains(result.createdTickets[1].error, 'No parent key resolved');
    });

    test('records a failed story creation and keeps processing the rest', function() {
        var m = loadStoryPlanAction({
            file_read: function(arg) {
                var path = typeof arg === 'string' ? arg : arg.path;
                if (path === 'outputs/stories.json') {
                    return JSON.stringify([
                        { summary: 'Failing story' },
                        { summary: 'Good story', description: 'outputs/good.md' }
                    ]);
                }
                if (path === 'outputs/good.md') return 'Good description';
                return null;
            },
            jira_search_by_jql: function() { return []; },
            jira_create_ticket_with_json: function(args) {
                if (args.fieldsJson.summary === 'Failing story') return '';
                return { key: 'PROJ-3000' };
            },
            jira_post_comment: function() {},
            jira_add_label: function() {}
        });

        var result = m.action(makeParams({ required: true }));

        assert.equal(result.success, false);
        assert.equal(result.createdTickets.length, 2);
        assert.equal(result.createdTickets[0].success, false);
        assert.contains(result.createdTickets[0].error, 'Could not extract Jira key');
        assert.equal(result.createdTickets[1].success, true);
        assert.equal(result.createdTickets[1].key, 'PROJ-3000');
    });

    test('falls back to the summary when no description file is provided', function() {
        var createCalls = [];
        var m = loadStoryPlanAction({
            file_read: function(arg) {
                var path = typeof arg === 'string' ? arg : arg.path;
                if (path === 'outputs/stories.json') {
                    return JSON.stringify([{ summary: 'Bare story' }]);
                }
                return null;
            },
            jira_search_by_jql: function() { return []; },
            jira_create_ticket_with_json: function(args) {
                createCalls.push(args);
                return { key: 'PROJ-3001' };
            },
            jira_post_comment: function() {},
            jira_add_label: function() {}
        });

        var result = m.action(makeParams({ required: true }));

        assert.equal(result.success, true);
        assert.equal(createCalls[0].fieldsJson.description, 'Bare story');
    });

    test('honors postSummaryComment:false and missing addLabel', function() {
        var commentCalls = [];
        var labelCalls = [];
        var m = loadStoryPlanAction({
            file_read: function(arg) {
                var path = typeof arg === 'string' ? arg : arg.path;
                if (path === 'outputs/stories.json') {
                    return JSON.stringify([{ summary: 'Silent story' }]);
                }
                return null;
            },
            jira_search_by_jql: function() { return []; },
            jira_create_ticket_with_json: function() { return { key: 'PROJ-3002' }; },
            jira_post_comment: function(args) { commentCalls.push(args); },
            jira_add_label: function(args) { labelCalls.push(args); }
        });

        var result = m.action(makeParams({ required: true, postSummaryComment: false, addLabel: undefined }));

        assert.equal(result.success, true);
        assert.equal(commentCalls.length, 0);
        assert.equal(labelCalls.length, 0);
    });

    test('creates blockedBy links without moving when blockedStatusName is false', function() {
        var linkCalls = [];
        var statusCalls = [];
        var m = loadStoryPlanAction({
            file_read: function(arg) {
                var path = typeof arg === 'string' ? arg : arg.path;
                if (path === 'outputs/stories.json') {
                    return JSON.stringify([
                        { tempId: 'blocker', summary: 'Blocker story' },
                        { summary: 'Waiting story', blockedBy: ['blocker'] }
                    ]);
                }
                return null;
            },
            jira_search_by_jql: function() { return []; },
            jira_create_ticket_with_json: function(args) {
                return { key: args.fieldsJson.summary === 'Blocker story' ? 'PROJ-3003' : 'PROJ-3004' };
            },
            jira_link_issues: function(args) { linkCalls.push(args); },
            jira_move_to_status: function(args) { statusCalls.push(args); },
            jira_post_comment: function() {},
            jira_add_label: function() {}
        });

        var result = m.action(makeParams({ required: true, blockedStatusName: false }));

        assert.equal(result.success, true);
        assert.ok(linkCalls.some(function(l) { return l.relationship === 'is blocked by'; }));
        assert.equal(statusCalls.length, 0);
    });

});

suite('createPlannedStoriesFromOutput — reuse and guards', function() {
    test('reuses existing story with the same summary under the same parent', function() {
        var createCalls = [];
        var linkCalls = [];

        var storiesJson = JSON.stringify([
            {
                tempId: 'mobile-story',
                type: 'Story',
                summary: 'Mobile implementation story',
                description: 'outputs/stories/mobile_story.md'
            }
        ]);

        var m = loadStoryPlanAction({
            file_read: function(arg) {
                var path = typeof arg === 'string' ? arg : arg.path;
                if (path === 'outputs/stories.json') return storiesJson;
                if (path === 'outputs/stories/mobile_story.md') return 'Mobile description';
                throw new Error('unexpected file_read: ' + path);
            },
            jira_search_by_jql: function(args) {
                if (args.jql === 'parent = PARENT-100 AND issuetype = "Story" ORDER BY created ASC') {
                    return [{ key: 'PROJ-1999', fields: { summary: 'Mobile implementation story' } }];
                }
                throw new Error('unexpected jql: ' + args.jql);
            },
            jira_create_ticket_with_json: function(args) {
                createCalls.push(args);
                return { key: 'PROJ-2001' };
            },
            jira_link_issues: function(args) {
                linkCalls.push(args);
            },
            jira_post_comment: function() {},
            jira_add_label: function() {}
        });

        var result = m.action(makeParams());

        assert.equal(result.success, true, 'action succeeds');
        assert.equal(createCalls.length, 0, 'no duplicate ticket created');
        assert.equal(linkCalls.length, 1, 'existing story linked to source');
        assert.equal(result.createdTickets[0].key, 'PROJ-1999', 'existing ticket reused');
        assert.equal(result.createdTickets[0].existing, true, 'marked as existing');
    });

    test('skips creation when source label is already present', function() {
        var createCalls = [];
        var m = loadStoryPlanAction({
            file_read: function() {
                return JSON.stringify([]);
            },
            jira_create_ticket_with_json: function(args) {
                createCalls.push(args);
                return { key: 'PROJ-2001' };
            }
        });

        var result = m.action(makeParams({}, {
            ticket: {
                key: 'SRC-101',
                fields: {
                    summary: 'Source ticket summary',
                    labels: ['ai_story_plan_created'],
                    parent: { key: 'PARENT-100' }
                }
            }
        }));

        assert.equal(result.success, true, 'skip still succeeds');
        assert.equal(result.skipped, true, 'marked as skipped');
        assert.equal(createCalls.length, 0, 'no tickets created');
    });

    test('continues in reuse mode when source label is already present', function() {
        var createCalls = [];
        var linkCalls = [];
        var storiesJson = JSON.stringify([
            {
                tempId: 'mobile-story',
                type: 'Story',
                summary: 'Updated mobile implementation story',
                description: 'outputs/stories/mobile_story.md'
            }
        ]);

        var m = loadStoryPlanAction({
            file_read: function(arg) {
                var path = typeof arg === 'string' ? arg : arg.path;
                if (path === 'outputs/stories.json') return storiesJson;
                if (path === 'outputs/stories/mobile_story.md') return 'Updated mobile description';
                throw new Error('unexpected file_read: ' + path);
            },
            jira_search_by_jql: function(args) {
                if (args.jql === 'parent = PARENT-100 AND issuetype = "Story" ORDER BY created ASC') {
                    return [];
                }
                throw new Error('unexpected jql: ' + args.jql);
            },
            jira_create_ticket_with_json: function(args) {
                createCalls.push(args);
                return { key: 'PROJ-2001' };
            },
            jira_link_issues: function(args) {
                linkCalls.push(args);
            },
            jira_post_comment: function() {},
            jira_add_label: function() {}
        });

        var result = m.action(makeParams({ skipIfLabelMode: 'reuse' }, {
            ticket: {
                key: 'SRC-101',
                fields: {
                    summary: 'Source ticket summary',
                    labels: ['ai_story_plan_created'],
                    priority: { name: 'High' },
                    parent: { key: 'PARENT-100' }
                }
            }
        }));

        assert.equal(result.success, true, 'action succeeds');
        assert.equal(result.skipped, undefined, 'not marked as skipped');
        assert.equal(createCalls.length, 1, 'story is still created');
        assert.equal(linkCalls.length, 1, 'created story linked to source');
    });
});

// ── linkStory (gh-1228 CRAP characterization) ───────────────────────────────

suite('createPlannedStoriesFromOutput — linkStory', function() {

    function loadLinkStory() {
        var linkCalls = [];
        var tracker = {
            linkIssues: function(sourceKey, targetKey, relationship) {
                linkCalls.push({ sourceKey: sourceKey, targetKey: targetKey, relationship: relationship });
            }
        };
        var mod = loadModule(
            'js/createPlannedStoriesFromOutput.js',
            makeRequire({
                './config.js': configModule,
                './common/trackers.js': { createTracker: function() { return tracker; } },
                './common/jiraHelpers.js': loadModule(
                    'js/common/jiraHelpers.js',
                    makeRequire({ '../config.js': configModule, './trackers.js': { createTracker: function() { return tracker; } } }),
                    {}
                ),
                './common/aiResponseParser.js': loadModule('js/common/aiResponseParser.js', makeRequire({ '../config.js': configModule }), {}),
                './common/linkedIssuesReport.js': loadModule('js/common/linkedIssuesReport.js')
            }),
            {
                jira_set_priority: function() {},
                file_read: function() { return null; },
                file_write: function() {}
            }
        );
        // Bind the module-global tracker (action() creates it before any early return).
        mod.action({ ticket: { key: 'SRC-BOOT' }, jobParams: { customParams: { storyPlanCreation: { enabled: false } } } });
        return { mod: mod, linkCalls: linkCalls, tracker: tracker };
    }

    var LINK_PARAMS = {
        ticket: { key: 'SRC-101', fields: { parent: { key: 'PARENT-100' } } }
    };

    test('missing created key is a no-op', function() {
        var ctx = loadLinkStory();
        ctx.mod.linkStory(null, LINK_PARAMS, { linkToSourceRelationship: 'Relates' }, false);
        assert.equal(ctx.linkCalls.length, 0, 'no link without a created key');
    });

    test('linkToSourceRelationship links the created story to the source ticket', function() {
        var ctx = loadLinkStory();
        ctx.mod.linkStory('PROJ-1', LINK_PARAMS, { linkToSourceRelationship: 'Relates' }, false);
        assert.deepEqual(ctx.linkCalls, [{ sourceKey: 'PROJ-1', targetKey: 'SRC-101', relationship: 'Relates' }], 'source ticket linked');
    });

    test('additionalLinks are applied after the source link (multiple links, order kept)', function() {
        var ctx = loadLinkStory();
        ctx.mod.linkStory('PROJ-1', LINK_PARAMS, {
            linkToSourceRelationship: 'Relates',
            additionalLinks: [
                { targetKey: 'X-1', relationship: 'Blocks' },
                { target: 'sourceParent', relationship: 'Implements' }
            ]
        }, false);
        assert.deepEqual(ctx.linkCalls, [
            { sourceKey: 'PROJ-1', targetKey: 'SRC-101', relationship: 'Relates' },
            { sourceKey: 'PROJ-1', targetKey: 'X-1', relationship: 'Blocks' },
            { sourceKey: 'PROJ-1', targetKey: 'PARENT-100', relationship: 'Implements' }
        ], 'all three links applied in order');
    });

    test('no configuration produces no links', function() {
        var ctx = loadLinkStory();
        ctx.mod.linkStory('PROJ-1', LINK_PARAMS, {}, false);
        assert.equal(ctx.linkCalls.length, 0, 'no links without config');
    });

    test('link without a relationship is skipped', function() {
        var ctx = loadLinkStory();
        ctx.mod.linkStory('PROJ-1', LINK_PARAMS, {
            additionalLinks: [{ targetKey: 'X-1' }, { targetKey: 'X-2', relationship: 'Blocks' }]
        }, false);
        assert.deepEqual(ctx.linkCalls, [{ sourceKey: 'PROJ-1', targetKey: 'X-2', relationship: 'Blocks' }], 'relationship-less link skipped');
    });

    test('existing story skips links flagged includeExisting:false but keeps others', function() {
        var ctx = loadLinkStory();
        ctx.mod.linkStory('PROJ-1', LINK_PARAMS, {
            linkToSourceRelationship: 'Relates',
            additionalLinks: [
                { targetKey: 'X-1', relationship: 'Blocks', includeExisting: false },
                { targetKey: 'X-2', relationship: 'Blocks' }
            ]
        }, true);
        assert.deepEqual(ctx.linkCalls, [
            { sourceKey: 'PROJ-1', targetKey: 'SRC-101', relationship: 'Relates' },
            { sourceKey: 'PROJ-1', targetKey: 'X-2', relationship: 'Blocks' }
        ], 'includeExisting:false skipped on reuse, others kept');
    });

    test('includeExisting:false links ARE applied for freshly created stories', function() {
        var ctx = loadLinkStory();
        ctx.mod.linkStory('PROJ-1', LINK_PARAMS, {
            additionalLinks: [{ targetKey: 'X-1', relationship: 'Blocks', includeExisting: false }]
        }, false);
        assert.deepEqual(ctx.linkCalls, [{ sourceKey: 'PROJ-1', targetKey: 'X-1', relationship: 'Blocks' }], 'applied for new stories');
    });

    test('explicit targetKey wins over the target resolver', function() {
        var ctx = loadLinkStory();
        ctx.mod.linkStory('PROJ-1', LINK_PARAMS, {
            additionalLinks: [{ targetKey: 'EXPLICIT-1', target: 'sourceTicket', relationship: 'Relates' }]
        }, false);
        assert.deepEqual(ctx.linkCalls, [{ sourceKey: 'PROJ-1', targetKey: 'EXPLICIT-1', relationship: 'Relates' }], 'explicit targetKey used');
    });

    test('link whose target resolves to nothing is skipped', function() {
        var ctx = loadLinkStory();
        ctx.mod.linkStory('PROJ-1', LINK_PARAMS, {
            additionalLinks: [
                { target: 'unknownTarget', relationship: 'Relates' },
                { target: 'sourceParent', relationship: 'Relates' }
            ]
        }, false);
        assert.deepEqual(ctx.linkCalls, [{ sourceKey: 'PROJ-1', targetKey: 'PARENT-100', relationship: 'Relates' }], 'unresolvable target skipped, parent linked');
    });

    test('failing link does not stop the remaining links', function() {
        var ctx = loadLinkStory();
        ctx.tracker.linkIssues = function(sourceKey, targetKey) {
            if (targetKey === 'BAD-1') { throw new Error('link rejected'); }
            ctx.linkCalls.push({ sourceKey: sourceKey, targetKey: targetKey });
        };
        ctx.mod.linkStory('PROJ-1', LINK_PARAMS, {
            additionalLinks: [
                { targetKey: 'BAD-1', relationship: 'Blocks' },
                { targetKey: 'GOOD-1', relationship: 'Blocks' }
            ]
        }, false);
        assert.deepEqual(ctx.linkCalls, [{ sourceKey: 'PROJ-1', targetKey: 'GOOD-1' }], 'link after the failure still applied');
    });
});
