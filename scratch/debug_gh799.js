// scratch debug — not committed
var commentMarkupModule = loadModule('js/common/commentMarkup.js',
    makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }));
var mod = loadModule('js/pushReworkChanges.js', makeRequire({
    './common/gitStaging.js': {},
    './configLoader.js': { loadProjectConfig: function() { return {}; } },
    './common/scm.js': { createScm: function() { return {}; } },
    './common/submodules.js': {},
    './common/pullRequest.js': {},
    './common/githubHelpers.js': {},
    './common/feedbackLoop.js': {},
    './common/autoStart.js': {},
    './common/outputFiles.js': { readOutputFile: function() { return null; } },
    './config.js': { GIT_CONFIG: {}, STATUSES: {}, LABELS: {}, resolveStatuses: function() { return {}; } },
    './common/trackers.js': {},
    './cacheToReleases.js': {},
    './common/tokenUsageComment.js': {},
    './common/commentMarkup.js': commentMarkupModule
}), {
    file_read: function() { return null; },
    cli_execute_command: function() { return ''; }
});

var md = commentMarkupModule.forFlavor('markdown');
function ghThread(id, rootId, extra) {
    var t = { threadId: id, rootCommentId: rootId, resolved: false, path: 'src/a.dart', line: 12, body: 'Fix the null deref here' };
    return Object.assign(t, extra || {});
}
var out = mod.buildReworkCompletionComment(md, {
    ticketKey: 'PROJ-123',
    prUrl: 'https://x/1420',
    branchName: 'ai/gh-1420',
    prCommentPosted: false,
    codeChangesCommitted: true,
    liveOpenThreads: [ghThread('PRRT_1', 1), ghThread('PRRT_2', 2)],
    inputThreads: [ghThread('PRRT_1', 1), ghThread('PRRT_2', 2)],
    unaddressed: [ghThread('PRRT_2', 2)],
    verdict: null
});
console.log('==== COMMENT ====');
console.log(out);
console.log('==== END ====');
console.log('wording:', mod.selectReworkCompletionWording(2, 1, null));
