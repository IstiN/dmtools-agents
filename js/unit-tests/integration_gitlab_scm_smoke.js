function parseJsonMaybe(raw, fallback) {
    if (raw == null) return fallback;
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw);
        } catch (e) {
            return fallback;
        }
    }
    return raw;
}

function sizeOf(value) {
    if (!value) return 0;
    if (Array.isArray(value)) return value.length;
    if (typeof value.length === 'number') return value.length;
    return 0;
}

function action(params) {
    var p = params.jobParams || params || {};
    var workspace = p.workspace || 'example-group';
    var repository = p.repository || 'example-project';
    var pullRequestId = String(p.pullRequestId || '1');
    var workflowLimit = p.workflowLimit || 5;

    var scmModule = require('../common/scm.js');
    var scm = scmModule.createScm({
        scm: { provider: 'gitlab' },
        repository: { owner: workspace, repo: repository }
    });

    var openPrs = scm.listPrs('open') || [];
    var closedPrs = scm.listPrs('closed') || [];
    var pr = scm.getPr(pullRequestId);
    var comments = scm.getPrComments(pullRequestId) || [];
    var discussions = scm.fetchDiscussions(pullRequestId) || {};
    var runsRaw = scm.listWorkflowRuns('failed', null, workflowLimit);
    var runs = parseJsonMaybe(runsRaw, { workflow_runs: [] });
    if (!runs || !runs.workflow_runs) {
        runs = { workflow_runs: [] };
    }

    var summary = {
        provider: 'gitlab',
        workspace: workspace,
        repository: repository,
        pullRequestId: pullRequestId,
        openPrCount: sizeOf(openPrs),
        closedPrCount: sizeOf(closedPrs),
        prState: pr ? (pr.state || null) : null,
        prNumber: pr ? (pr.number || pr.iid || pr.id || null) : null,
        prUrl: pr ? (pr.html_url || pr.web_url || null) : null,
        commentsCount: sizeOf(comments),
        discussionThreadsTotal: discussions.rawThreads && discussions.rawThreads.threads ? discussions.rawThreads.threads.length : 0,
        discussionMarkdownPresent: !!(discussions.markdown && discussions.markdown.length > 0),
        failedWorkflowRunsCount: runs.workflow_runs.length
    };

    if (!summary.prNumber) {
        throw new Error('SCM smoke test failed: getPr did not return PR identifier');
    }

    console.log('SCM smoke summary: ' + JSON.stringify(summary, null, 2));
    return summary;
}

