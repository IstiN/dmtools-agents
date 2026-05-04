/**
 * Unit tests for agents/js/createPlannedStoriesFromOutput.js
 *
 * Tests: planned story creation, parent resolution, exact-summary reuse,
 * integrates/blockedBy links, source label guard.
 */

function loadStoryPlanAction(mocks) {
    var allMocks = Object.assign({
        jira_set_priority: function() {}
    }, mocks || {});

    return loadModule(
        'agents/js/createPlannedStoriesFromOutput.js',
        makeRequire({
            './config.js': configModule,
            './common/jiraHelpers.js': loadModule(
                'agents/js/common/jiraHelpers.js',
                makeRequire({ '../config.js': configModule }),
                allMocks
            ),
            './common/aiResponseParser.js': loadModule(
                'agents/js/common/aiResponseParser.js',
                makeRequire({ '../config.js': configModule }),
                {}
            )
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
                    projectKey: 'MAPC',
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
        assert.equal(createCalls[0].project, 'MAPC', 'creation project can differ from parent project');
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
});
