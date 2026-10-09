// Scratch debug for the gh-806 latch consult (not part of the suite)
var assert = globalThis.assert;

var HEAD = '23dacd10deadbeefcafe0123456789abcdef0123';
var SP = { channel: 'release', repo: 'a/b', asset: 'fa-state.json' };
var STATE_GET = 'gh api repos/a/b/contents/data/fa-state.json?ref=factory-data --jq .content | base64 -d';

function recentIso(msAgo) {
    return new Date(Date.now() - (msAgo || 60000)).toISOString();
}

var latch = loadModule('js/common/reworkLatch.js', makeRequire({}), {});

// 1. Does the probe command string match what smAgent builds?
var seen = [];
var probeResult = { output: JSON.stringify({ workflow_runs: [{
    status: 'in_progress', head_sha: HEAD, path: '.github/workflows/ai-teammate.yml' }] }) };

var fileReadMock = function(readOpts) {
    var p = readOpts.path;
    if (p.indexOf('.dmtools/config') !== -1) {
        if (p === '../.dmtools/config.js') {
            return 'module.exports = { repository: { owner: "a", repo: "b" } };';
        }
        return null;
    }
    try { return file_read(readOpts); } catch (e) { return null; }
};

var cliMock = function(cmdOpts) {
    seen.push(cmdOpts.command);
    if (cmdOpts.command === STATE_GET) {
        return { output: JSON.stringify({ lanes: {}, reworkInFlight:
            { ['pr-1428@' + HEAD]: { head: HEAD, at: recentIso(50 * 60 * 1000) } } }) };
    }
    if (cmdOpts.command.indexOf('/actions/runs?head_sha=' + HEAD) !== -1) return probeResult;
    return '';
};

var smMocks = {
    file_read: fileReadMock,
    cli_execute_command: cliMock,
    jira_search_by_jql: function () { return []; },
    jira_get_ticket: function (key) { return { key: key, fields: { labels: [], summary: 't' } }; },
    jira_add_label: function () {}, jira_remove_label: function () {}, jira_move_to_status: function () {},
    github_list_prs: function () { return '[]'; },
    github_list_workflow_runs: function () { return '{"workflow_runs":[]}'; },
    github_search_issues: function () { return '{"items":[]}'; },
    file_write: function () { return true; },
    github_add_labels: function (o) { seen.push('ADD_LABELS:' + JSON.stringify(o)); },
    github_remove_label: function () {},
    github_create_comment: function (o) { seen.push('COMMENT:' + String(o.body).substring(0, 40)); },
    github_get_pr: function () { return '{}'; },
    github_get_pr_comments: function () { return '[]'; },
    JSON: JSON
};

var machineAuthorModule = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
var freshConfigLoader = loadModule('js/configLoader.js',
    makeRequire({ './config.js': configModule, './common/scm.js': { createScm: function () { return {}; } } }),
    { file_read: fileReadMock });
var bec = loadModule('js/common/buildEncodedConfig.js',
    makeRequire({ '../configLoader.js': freshConfigLoader }),
    { file_read: fileReadMock, encodeURIComponent: encodeURIComponent, JSON: JSON });
var trackersForSm = loadModule('js/common/trackers.js',
    makeRequire({ '../config.js': configModule, './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }),
    smMocks);

var sm = loadModule('js/smAgent.js', makeRequire({
    './common/trackers.js': trackersForSm,
    './configLoader.js': freshConfigLoader,
    './sm/sourceResolver.js': { resolve: function () {
        return { query: function () { return [{
            key: 'pr-1428', labels: ['ai_pr_reviewed'], issueNumber: null, prNumber: 1428,
            pr: { number: 1428, state: 'OPEN', checks: 'green', mergeState: 'CLEAN', headSha: HEAD }
        }]; } };
    } },
    './common/scm.js': { createScm: function (config) { return {
        listWorkflowRuns: function () { return '{"workflow_runs":[]}'; },
        triggerWorkflow: function () {}
    }; } },
    './common/buildEncodedConfig.js': bec,
    './common/machineAuthor.js': machineAuthorModule,
    './common/reworkLatch.js': latch,
    './common/smProvider.js': { createSmProvider: function () { return { prStatus: function () { return null; } }; } },
    './factoryState.js': loadModule('js/factoryState.js',
        makeRequire({ './common/machineAuthor.js': machineAuthorModule, './common/reworkLatch.js': latch }), {})
}), smMocks);

sm.action({ jobParams: { owner: 'a', repo: 'b', machineAuthor: 'ai-teammate', rules: [{
    source: 'github', query: { type: 'pr', labels: ['ai_pr_reviewed'], threadsResolved: false, prMachineAuthor: true },
    localAction: 'arm_rework', limit: 5, id: 'rework-unresolved-threads' }, {
    source: 'github', query: { type: 'pr', labels: ['ai_pr_reviewed'], threadsResolved: false, prMachineAuthor: true },
    localAction: 'arm_rework', limit: 5, id: 'rework-unresolved-threads-2' }] } });

console.log('--- captured commands: ---');
seen.forEach(function (c) { console.log('CMD: ' + String(c).substring(0, 120)); });
