/* global loadModule, assert, test, suite, makeRequire */
suite('scratch debug gh-922 dedup', function () {
    var RULE_TF = { source: 'github', id: 'review-on-label-gh922',
        query: { type: 'pr', labels: ['agent:review'], draft: false },
        inputs: { pr: '{prNumber}', leg: 'review' },
        workflowRef: '{branch}', limit: 1 };
    var RULE_TR = { source: 'github', id: 'rework-on-label-gh922',
        query: { type: 'pr', labels: ['agent:rework'], draft: false },
        inputs: { pr: '{prNumber}', leg: 'rework' },
        workflowRef: '{branch}', limit: 1 };

    function tfConfig(owner, repo) {
        return { fileMap: { '../.dmtools/config.js':
            'module.exports = { repository: { owner: "' + owner + '", repo: "' + repo + '" } };' } };
    }
    function sha40(n) {
        var s = 'abc' + n;
        while (s.length < 40) s += '0';
        return s;
    }
    function tfPr(n, labels, ref) {
        return { number: n, state: 'open', draft: false, body: '',
                 head: { sha: sha40(n), ref: ref },
                 base: { sha: 'tfbase0' },
                 labels: (labels || []).map(function (l) { return { name: l }; }),
                 user: { login: 'ai-teammate' } };
    }
    var DEAD_REF = 'gone/deleted-branch';
    var NO_REF_ERR = '422: No ref found for: ' + DEAD_REF;

    test('debug: two rules, items function, same dead PR', function () {
        var deadPr = tfPr(302, ['agent:review', 'agent:rework', 'priority_blocker'], DEAD_REF);
        var sm = makeSmAgent(Object.assign(tfConfig('o', 'r'), {
            captureConsole: true,
            github: { items: function () { return [deadPr]; }, prComments: [] },
            onTrigger: function () { throw new Error(NO_REF_ERR); }
        }));
        sm.action({ jobParams: { owner: 'o', repo: 'r', machineAuthor: 'ai-teammate',
                                 rules: [RULE_TF, RULE_TR] } });
        console.log('CCAPTURED triggers: ' + sm.capturedTriggers.length);
        console.log('CCAPTURED comments: ' + JSON.stringify(sm.capturedPrComments));
        var logs = sm.capturedLogs || [];
        logs.forEach(function (l) { if (l.indexOf('trigger') !== -1 || l.indexOf('⚠') !== -1 || l.indexOf('⏭') !== -1) console.log('CLOG: ' + l); });
        assert.ok(true);
    });
});
