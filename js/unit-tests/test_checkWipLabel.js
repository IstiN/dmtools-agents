/**
 * Unit tests for js/checkWipLabel.js
 */

function loadCheckWipLabel(mocks) {
    mocks = mocks || {};
    return loadModule(
        'js/checkWipLabel.js',
        makeRequire({
            './configLoader.js': {
                loadProjectConfig: function() { return {}; },
                createScm: function() { return {}; }
            },
            './common/githubHelpers.js': {
                findPRForTicket: function() { return null; }
            }
        }),
        mocks
    );
}

function makeTicket(key, labels) {
    return {
        key: key,
        fields: {
            labels: labels || []
        }
    };
}

suite('checkWipLabel', function() {

    test('continues when no WIP label and no open-PR guard', function() {
        var comments = [];
        var module = loadCheckWipLabel({
            jira_post_comment: function(args) { comments.push(args); }
        });

        var result = module.action({
            ticket: makeTicket('TS-1'),
            metadata: { contextId: 'pr_review' }
        });

        assert.equal(result, true);
        assert.equal(comments.length, 0);
    });

    test('stops when WIP label is present', function() {
        var comments = [];
        var module = loadCheckWipLabel({
            jira_post_comment: function(args) { comments.push(args); }
        });

        var result = module.action({
            ticket: makeTicket('TS-1', ['pr_review_wip']),
            metadata: { contextId: 'pr_review' }
        });

        assert.equal(result, false);
        assert.ok(comments.some(function(c) { return c.comment.indexOf('WIP label') !== -1; }));
    });

    test('stops when checkOpenPR is set and no open PR exists', function() {
        var comments = [];
        var module = loadCheckWipLabel({
            jira_post_comment: function(args) { comments.push(args); }
        });

        var result = module.action({
            ticket: makeTicket('TS-1'),
            metadata: { contextId: 'pr_rework' },
            jobParams: { customParams: { checkOpenPR: true } }
        });

        assert.equal(result, false);
        assert.ok(comments.some(function(c) { return c.comment.indexOf('No open Pull Request') !== -1; }));
    });

    test('continues when checkOpenPR is set and an open PR exists', function() {
        var module = loadModule(
            'js/checkWipLabel.js',
            makeRequire({
                './configLoader.js': {
                    loadProjectConfig: function() { return {}; },
                    createScm: function() { return {}; }
                },
                './common/githubHelpers.js': {
                    findPRForTicket: function() { return { number: 42 }; }
                }
            }),
            {
                jira_post_comment: function() {}
            }
        );

        var result = module.action({
            ticket: makeTicket('TS-1'),
            metadata: { contextId: 'pr_review' },
            jobParams: { customParams: { checkOpenPR: true } }
        });

        assert.equal(result, true);
    });

    test('PR check is skipped when checkOpenPR is not set even if no PR exists', function() {
        var module = loadCheckWipLabel({
            jira_post_comment: function() {}
        });

        var result = module.action({
            ticket: makeTicket('TS-1'),
            metadata: { contextId: 'pr_review' }
        });

        assert.equal(result, true);
    });

});
