// Scratch: empirically count agent:rework removals in pushReworkChanges.action success path
var testRunner = require('./js/unit-tests/testRunner.js');

var removals = [];
var addLabels = [];

var configModule = require('./js/config.js');
var commentMarkupModule = require('./js/common/commentMarkup.js');
var gitStagingModule = require('./js/common/gitStaging.js');
var githubHelpersModule = require('./js/common/githubHelpers.js');

function makeTrackersModule(mocks) {
    return {
        createTracker: function() {
            return {
                removeLabel: function(key, label) { removals.push({ key: key, label: label }); },
                addLabel: function(key, label) { addLabels.push({ key: key, label: label }); },
                moveToStatus: function() {},
                postComment: function() {},
                assignTo: function() {},
                provider: function() { return 'jira'; }
            };
        }
    };
}

var scm = {
    listPrs: function() {
        return [{ number: 123, title: 'PROJ-123: rework fix', head: { ref: 'bug/PROJ-123' }, html_url: 'https://github.com/IstiN/dmtools-agents/pull/123' }];
    },
    getRemoteRepoInfo: function() { return { owner: 'IstiN', repo: 'dmtools-agents' }; },
    addComment: function() {},
    listReviews: function() { return []; }
};

var mocks = {
    cli_execute_command: function(args) {
        if (args.command === 'git branch --show-current') return 'bug/PROJ-123\n';
        if (args.command.indexOf('git ls-remote --heads origin') === 0) return 'abc123\trefs/heads/bug/PROJ-123\n';
        return '';
    },
    file_read: function(args) {
        var p = args && (args.path || args);
        if (p && p.indexOf('rework_setup_failed.md') !== -1) throw new Error('File does not exist');
        if (p && p.indexOf('pr_info.md') !== -1) return '**Branch**: `bug/PROJ-123` → `develop`';
        return null;
    },
    jira_post_comment: function() {},
    jira_move_to_status: function() {},
    jira_remove_label: function() {},
    jira_assign_ticket_to: function() {}
};

var mod = testRunner.loadModule(
    'js/pushReworkChanges.js',
    testRunner.makeRequire({
        './common/gitStaging.js': gitStagingModule,
        './configLoader.js': {
            loadProjectConfig: function() { return { git: { baseBranch: 'develop' }, jira: { statuses: null } }; },
            resolveInstructions: function() { return { jobParamPatch: {} }; },
            formatTemplate: function(t, v) { return t; }
        },
        './common/scm.js': { createScm: function() { return scm; } },
        './common/submodules.js': { pushManagedSubmodules: function() {} },
        './common/pullRequest.js': {
            readStagedDiffStat: function() { return 'M file.txt\n'; },
            syncBranchWithBase: function() { return { success: true, updated: false }; }
        },
        './common/githubHelpers.js': githubHelpersModule,
        './common/feedbackLoop.js': {
            runQualityGates: function() { return { success: true }; },
            runPolicyGates: function() { return { success: true }; },
            runPostPublishGates: function() { return { success: true }; },
            resumeAgent: function() { return { attempted: false }; }
        },
        './common/autoStart.js': { triggerSmIfIdle: function() {}, triggerConfiguredWorkflowForTicket: function() { return false; } },
        './common/outputFiles.js': { readOutputFile: function() { return null; } },
        './config.js': configModule,
        './common/trackers.js': makeTrackersModule(mocks),
        './cacheToReleases.js': { action: function() {} },
        './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
        './common/commentMarkup.js': commentMarkupModule
    }),
    mocks
);

var result = mod.action({
    ticket: { key: 'PROJ-123', fields: { labels: [] } },
    metadata: { contextId: 'pr_rework' },
    response: 'Fix summary long enough to be a meaningful rework completion summary.',
    customParams: { removeLabels: ['sm_story_rework_triggered', 'sm_story_review_triggered', 'agent:rework'], checkOpenPR: true }
});

console.log('RESULT:', JSON.stringify(result));
console.log('REMOVALS:', JSON.stringify(removals));
console.log('ADDLABELS:', JSON.stringify(addLabels));
