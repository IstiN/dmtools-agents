function prTrackersWith(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks);
}
function prCommentMarkup() {
    return loadModule('js/common/commentMarkup.js',
        makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }));
}
var record = { comments: [], gitOps: [], ghCalls: [], parentCalls: [], configCalls: [] };
var ghDefaults = {
    findPRForTicket: function(scm, ticketKey, options) { return { number: 42, title: 't', head: { ref: 'ai/TS-42', sha: 'abc123def' } }; },
    getPRDetails: function(scm, prNumber) {
        return { number: 42, html_url: 'https://example.com/pull/42', head: { ref: 'ai/TS-42', sha: 'abc123def' }, base: { ref: 'main' }, changed_files: 3 };
    },
    fetchDiscussionsAndRawData: function() { return { markdown: '# PR Discussion History', rawThreads: [{ index: 1, body: 'x' }] }; },
    detectFailedChecks: function() { return []; }
};
var gitOpsDefaults = {
    checkoutPRBranch: function(branchName, workingDir, baseBranch) {
        record.gitOps.push({ fn: 'checkoutPRBranch', branchName: branchName });
        throw new Error('local changes');
    },
    getPRDiff: function(baseBranch, headBranch, workingDir) {
        record.gitOps.push({ fn: 'getPRDiff', baseBranch: baseBranch, headBranch: headBranch, workingDir: workingDir });
        return 'diff --git a/x b/x';
    },
    writePRContext: function(inputFolder, prDetails, diff, markdown, rawThreads) {
        record.gitOps.push({ fn: 'writePRContext', inputFolder: inputFolder });
    }
};
var globalMocks = { jira_post_comment: function() {} };
var module = loadModule('js/preparePRForReview.js', makeRequire({
    './configLoader.js': {
        loadProjectConfig: function() { return { repository: { owner: 'acme', repo: 'widget' }, workingDir: '/w' }; },
        createScm: function() { return { getRemoteRepoInfo: function() { return { owner: 'acme', repo: 'widget' }; } }; }
    },
    './common/githubHelpers.js': ghDefaults,
    './common/gitOps.js': gitOpsDefaults,
    './common/commentMarkup.js': prCommentMarkup(),
    './fetchParentContextToInput.js': { action: function() {} },
    './common/trackers.js': prTrackersWith(globalMocks)
}), globalMocks);
var result = module.action({ inputFolderPath: 'input/TS-42', jobParams: {} });
console.log('RESULT:', JSON.stringify(result));
console.log('GITOPS:', JSON.stringify(record.gitOps));
