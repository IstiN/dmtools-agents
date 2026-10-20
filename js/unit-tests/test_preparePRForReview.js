/**
 * Unit tests for js/preparePRForReview.js (gh-927 CRAP refactor).
 *
 * Two layers:
 *  1. Characterization tests on action() — pin the current behaviour of PR
 *     context assembly, PR-anchored (pr-N / jobParams.prNumber|pr) variants,
 *     missing-data fallbacks, failure comments, tracker/SCM call order.
 *  2. Direct tests of the extracted parse, build and resolve helpers.
 */

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

function prRecorder() {
    return { comments: [], gitOps: [], ghCalls: [], parentCalls: [], configCalls: [] };
}

function prGhMocks(opts, record) {
    return {
        findPRForTicket: function(scm, ticketKey, options) {
            record.ghCalls.push({ fn: 'findPRForTicket', ticketKey: ticketKey, options: options });
            return opts.findPRResult !== undefined ? opts.findPRResult :
                { number: 42, title: 'TS-42 change', head: { ref: 'ai/TS-42', sha: 'abc123def' } };
        },
        getPRDetails: function(scm, prNumber) {
            record.ghCalls.push({ fn: 'getPRDetails', prNumber: prNumber });
            if (opts.prDetails !== undefined) return opts.prDetails;
            // Echo the requested PR number — the real helper returns the
            // full PR object for the id it fetched.
            return {
                number: prNumber,
                html_url: 'https://example.com/pull/' + prNumber,
                head: { ref: 'ai/TS-42', sha: 'abc123def' },
                base: { ref: 'main' },
                changed_files: 3
            };
        },
        fetchDiscussionsAndRawData: function(scm, prNumber) {
            record.ghCalls.push({ fn: 'fetchDiscussionsAndRawData', prNumber: prNumber });
            return opts.discussions !== undefined ? opts.discussions :
                { markdown: '# PR Discussion History', rawThreads: [{ index: 1, body: 'x' }] };
        },
        detectFailedChecks: function(scm, headSha, inputFolder, jenkinsBasePath, diffText) {
            record.ghCalls.push({ fn: 'detectFailedChecks', headSha: headSha,
                inputFolder: inputFolder, jenkinsBasePath: jenkinsBasePath, diffText: diffText });
            return opts.failedChecks || [];
        }
    };
}

function prGitOpsMocks(opts, record) {
    return {
        checkoutPRBranch: function(branchName, workingDir, baseBranch) {
            record.gitOps.push({ fn: 'checkoutPRBranch', branchName: branchName,
                workingDir: workingDir, baseBranch: baseBranch });
            if (opts.checkoutError) throw opts.checkoutError;
        },
        getPRDiff: function(baseBranch, headBranch, workingDir) {
            record.gitOps.push({ fn: 'getPRDiff', baseBranch: baseBranch,
                headBranch: headBranch, workingDir: workingDir });
            return opts.diffText !== undefined ? opts.diffText : 'diff --git a/x b/x';
        },
        writePRContext: function(inputFolder, prDetails, diff, markdown, rawThreads) {
            record.gitOps.push({ fn: 'writePRContext', inputFolder: inputFolder,
                prNumber: prDetails && prDetails.number, diff: diff,
                markdown: markdown, rawThreads: rawThreads });
        }
    };
}

function prTrackerGlobals(record, trackerThrows) {
    var g = {
        jira_post_comment: function(a) { record.comments.push({ tool: 'jira_post_comment', args: a }); },
        jira_add_label: function(a) { record.comments.push({ tool: 'jira_add_label', args: a }); },
        ado_add_work_item_comment: function(a) { record.comments.push({ tool: 'ado_add_work_item_comment', args: a }); }
    };
    if (trackerThrows) {
        g.jira_post_comment = function() { throw new Error('tracker down'); };
    }
    return g;
}

function prConfigLoader(opts, record) {
    return {
        loadProjectConfig: function(params) {
            record.configCalls.push(params);
            if (opts.configError) throw opts.configError;
            return opts.config || {};
        },
        createScm: function() {
            return {
                getRemoteRepoInfo: function() {
                    return opts.remoteRepoInfo !== undefined ? opts.remoteRepoInfo :
                        { owner: 'acme', repo: 'widget' };
                }
            };
        }
    };
}

function prParentMock(opts, record) {
    return {
        action: function(params) {
            record.parentCalls.push(params);
            if (opts.parentError) throw opts.parentError;
        }
    };
}

/**
 * Loads js/preparePRForReview.js with injected fakes.
 * See the suites below for the opts each test uses.
 */
function prLoad(opts) {
    opts = opts || {};
    var record = opts.record || prRecorder();
    var globalMocks = prTrackerGlobals(record, opts.trackerThrows);

    var module = loadModule('js/preparePRForReview.js', makeRequire({
        './configLoader.js': prConfigLoader(opts, record),
        './common/githubHelpers.js': Object.assign(prGhMocks(opts, record), opts.gh || {}),
        './common/gitOps.js': Object.assign(prGitOpsMocks(opts, record), opts.gitOps || {}),
        './common/commentMarkup.js': prCommentMarkup(),
        './fetchParentContextToInput.js': prParentMock(opts, record),
        './common/trackers.js': prTrackersWith(globalMocks)
    }), globalMocks);

    return { module: module, record: record };
}

suite('preparePRForReview.action — happy paths', function() {

test('ticket-anchored: assembles PR context, posts review-started comment, returns result', function() {
    var rec = prRecorder();
    var loaded = prLoad({
        record: rec,
        config: { repository: { owner: 'acme', repo: 'widget' }, git: { baseBranch: 'main' } },
        failedChecks: []
    });

    var result = loaded.module.action({ inputFolderPath: 'input/TS-42', jobParams: { customParams: { trackerProvider: 'jira' } } });

    assert.deepEqual(result, {
        success: true,
        prNumber: 42,
        prUrl: 'https://example.com/pull/42',
        branchName: 'ai/TS-42',
        owner: 'acme',
        repo: 'widget'
    });
    assert.deepEqual(rec.gitOps, [
        { fn: 'checkoutPRBranch', branchName: 'ai/TS-42', workingDir: undefined, baseBranch: 'main' },
        { fn: 'getPRDiff', baseBranch: 'main', headBranch: 'ai/TS-42', workingDir: undefined },
        { fn: 'writePRContext', inputFolder: 'input/TS-42', prNumber: 42,
            diff: 'diff --git a/x b/x', markdown: '# PR Discussion History',
            rawThreads: [{ index: 1, body: 'x' }] }
    ]);
    assert.deepEqual(rec.ghCalls.map(function(c) { return c.fn; }),
        ['findPRForTicket', 'getPRDetails', 'fetchDiscussionsAndRawData', 'detectFailedChecks']);
    assert.deepEqual(rec.ghCalls[3], { fn: 'detectFailedChecks', headSha: 'abc123def',
        inputFolder: 'input/TS-42', jenkinsBasePath: undefined,
        diffText: 'diff --git a/x b/x' });
    // One tracker comment: the "review started" notice.
    assert.equal(rec.comments.length, 1);
    assert.equal(rec.comments[0].tool, 'jira_post_comment');
    assert.equal(rec.comments[0].args.key, 'TS-42');
    var comment = rec.comments[0].args.comment;
    assert.contains(comment, 'h3. 🔍 Automated PR Review Started');
    assert.contains(comment, '*Pull Request*: [PR #42|https://example.com/pull/42]');
    assert.contains(comment, '*Branch*: {code}ai/TS-42{code}');
    assert.contains(comment, '*Files Changed*: 3');
    assert.notContains(comment, 'CI checks failing');
    assert.contains(comment, '_Review results will be posted shortly..._');
    // Parent enrichment receives the original params.
    assert.equal(rec.parentCalls.length, 1);
    assert.equal(rec.parentCalls[0].inputFolderPath, 'input/TS-42');
});

test('failed CI checks are rendered as a jira panel with one line per check', function() {
    var rec = prRecorder();
    var loaded = prLoad({
        record: rec,
        config: { repository: { owner: 'acme', repo: 'widget' } },
        failedChecks: [{ name: 'build', conclusion: 'failure' }, { name: 'test', conclusion: 'timed_out' }]
    });

    var result = loaded.module.action({ inputFolderPath: 'input/TS-42', jobParams: { customParams: { trackerProvider: 'jira' } } });

    assert.equal(result.success, true);
    var comment = rec.comments[0].args.comment;
    assert.contains(comment, '*CI checks failing* — 2 check(s) did not pass');
    assert.contains(comment, '{panel:bgColor=#FFEBE6|borderColor=#DE350B}');
    assert.contains(comment, '* {code}build{code}');
    assert.contains(comment, '* {code}test{code}');
    assert.contains(comment, '{code}ci_failures.md{code} (summary) and {code}ci_failures_full.log{code} (full logs)');
});

test('pr-N anchored: no ticket lookup, no ticket comments, repo from git remote', function() {
    var rec = prRecorder();
    var loaded = prLoad({
        record: rec,
        config: {},
        remoteRepoInfo: { owner: 'octo', repo: 'app' }
    });

    var result = loaded.module.action({ inputFolderPath: 'input/pr-99', jobParams: {} });

    assert.deepEqual(result, {
        success: true,
        prNumber: 99,
        prUrl: 'https://example.com/pull/99',
        branchName: 'ai/TS-42',
        owner: 'octo',
        repo: 'app'
    });
    assert.deepEqual(rec.ghCalls.map(function(c) { return c.fn; }),
        ['getPRDetails', 'fetchDiscussionsAndRawData', 'detectFailedChecks']);
    assert.equal(rec.ghCalls[0].prNumber, 99);
    assert.equal(rec.comments.length, 0);
    assert.equal(rec.parentCalls.length, 0);
});

test('jobParams.prNumber and jobParams.pr act as PR anchors', function() {
    var loadedNumber = prLoad({ config: {} });
    var r1 = loadedNumber.module.action({ inputFolderPath: 'input/TS-77', jobParams: { prNumber: '77' } });
    assert.equal(r1.success, true);
    assert.equal(r1.prNumber, 77);
    assert.deepEqual(loadedNumber.record.ghCalls.map(function(c) { return c.fn; }),
        ['getPRDetails', 'fetchDiscussionsAndRawData', 'detectFailedChecks']);
    assert.equal(loadedNumber.record.ghCalls[0].prNumber, 77);

    var loadedPr = prLoad({ config: {} });
    var r2 = loadedPr.module.action({ inputFolderPath: 'input/TS-78', jobParams: { pr: '55' } });
    assert.equal(r2.success, true);
    assert.equal(r2.prNumber, 55);
});

test('config.prSearchFn is passed through to findPRForTicket', function() {
    var rec = prRecorder();
    var searchFn = function() { return null; };
    var loaded = prLoad({ record: rec, findPRResult: null,
        config: { repository: { owner: 'acme', repo: 'widget' }, prSearchFn: searchFn } });

    loaded.module.action({ inputFolderPath: 'input/TS-42', jobParams: { customParams: { trackerProvider: 'jira' } } });

    assert.equal(rec.ghCalls[0].fn, 'findPRForTicket');
    assert.equal(rec.ghCalls[0].options.prSearchFn, searchFn);
});

});

suite('preparePRForReview.action — failure paths', function() {

test('repository resolution failure: jira comment + false', function() {
    var rec = prRecorder();
    var loaded = prLoad({ record: rec, config: {}, remoteRepoInfo: null });

    var result = loaded.module.action({ inputFolderPath: 'input/TS-3', jobParams: {} });

    assert.equal(result, false);
    assert.equal(rec.comments.length, 1);
    assert.equal(rec.comments[0].tool, 'jira_post_comment');
    assert.equal(rec.comments[0].args.key, 'TS-3');
    assert.equal(rec.comments[0].args.comment,
        'h3. ⚠️ PR Review Setup Failed\n\nCould not determine GitHub repository from git remote\n\n_Review cancelled — no PR to review._');
});

test('repository resolution failure on a pr-N anchor still posts the setup-failed comment', function() {
    var rec = prRecorder();
    var loaded = prLoad({ record: rec, config: {}, remoteRepoInfo: null });

    var result = loaded.module.action({ inputFolderPath: 'input/pr-9', jobParams: {} });

    assert.equal(result, false);
    assert.equal(rec.comments.length, 1);
    assert.contains(rec.comments[0].args.comment, 'Could not determine GitHub repository from git remote');
});

test('repository resolution failure with ado provider uses ado comment tool', function() {
    var rec = prRecorder();
    var loaded = prLoad({ record: rec, config: {}, remoteRepoInfo: null });

    var result = loaded.module.action({ inputFolderPath: 'input/33', jobParams: { customParams: { trackerProvider: 'ado' } } });

    assert.equal(result, false);
    assert.deepEqual(rec.comments.map(function(c) { return c.tool; }), ['ado_add_work_item_comment']);
    assert.equal(rec.comments[0].args.id, '33');
});

test('no open PR found: guidance comment + false', function() {
    var rec = prRecorder();
    var loaded = prLoad({ record: rec, config: { repository: { owner: 'acme', repo: 'widget' } }, findPRResult: null });

    var result = loaded.module.action({ inputFolderPath: 'input/TS-42', jobParams: { customParams: { trackerProvider: 'jira' } } });

    assert.equal(result, false);
    assert.equal(rec.comments.length, 1);
    assert.equal(rec.comments[0].args.comment,
        'h3. ⚠️ PR Review Setup Failed\n\nCould not find an open Pull Request associated with *TS-42*.\n\n' +
        'Please ensure:\n* A PR has been created with the ticket key in the title or branch name\n' +
        '* The PR is open and accessible\n\n_Review cancelled — no PR to review._');
});

test('PR details failure: comment + false, no context files written', function() {
    var rec = prRecorder();
    var loaded = prLoad({ record: rec, config: { repository: { owner: 'acme', repo: 'widget' } }, prDetails: null });

    var result = loaded.module.action({ inputFolderPath: 'input/TS-42', jobParams: { customParams: { trackerProvider: 'jira' } } });

    assert.equal(result, false);
    assert.equal(rec.comments.length, 1);
    assert.equal(rec.comments[0].args.comment,
        'h3. ⚠️ PR Review Setup Failed\n\nCould not fetch details for PR #42.\n\n_Review cancelled._');
    assert.equal(rec.gitOps.length, 0);
});

test('PR details failure on a pr-N anchor posts nothing', function() {
    var rec = prRecorder();
    var loaded = prLoad({ record: rec, config: {}, remoteRepoInfo: { owner: 'octo', repo: 'app' }, prDetails: null });

    var result = loaded.module.action({ inputFolderPath: 'input/pr-9', jobParams: {} });

    assert.equal(result, false);
    assert.equal(rec.comments.length, 0);
});

test('setup error (config load throws): false, no comment possible (tracker not yet created)', function() {
    var rec = prRecorder();
    var loaded = prLoad({ record: rec, configError: new Error('bad config') });

    var result = loaded.module.action({ inputFolderPath: 'input/TS-42', jobParams: {} });

    assert.equal(result, false);
    assert.equal(rec.comments.length, 0);
});

test('setup error mid-flow (diff fails): error comment posted via tracker + false', function() {
    var rec = prRecorder();
    var loaded = prLoad({
        record: rec,
        config: { repository: { owner: 'acme', repo: 'widget' }, git: { baseBranch: 'main' } },
        gitOps: {
            getPRDiff: function() { throw new Error('git exploded'); }
        }
    });

    var result = loaded.module.action({ inputFolderPath: 'input/TS-42', jobParams: {} });

    assert.equal(result, false);
    assert.equal(rec.comments.length, 1);
    assert.equal(rec.comments[0].args.key, 'TS-42');
    assert.equal(rec.comments[0].args.comment,
        'h3. ❌ PR Review Setup Error\n\n{code}Error: git exploded{code}');
});

test('setup error on a pr-N anchor posts nothing', function() {
    var rec = prRecorder();
    var loaded = prLoad({ record: rec, configError: new Error('bad config') });

    var result = loaded.module.action({ inputFolderPath: 'input/pr-5', jobParams: {} });

    assert.equal(result, false);
    assert.equal(rec.comments.length, 0);
});

test('missing inputFolderPath: false, no comment (nothing to report against)', function() {
    var rec = prRecorder();
    var loaded = prLoad({ record: rec, config: {} });

    var result = loaded.module.action({ jobParams: {} });

    assert.equal(result, false);
    assert.equal(rec.comments.length, 0);
});

});

suite('preparePRForReview.action — degraded data fallbacks', function() {

test('checkout failure is non-fatal: review continues', function() {
    var rec = prRecorder();
    var loaded = prLoad({
        record: rec,
        config: { repository: { owner: 'acme', repo: 'widget' }, workingDir: '/w', git: { baseBranch: 'main' } },
        checkoutError: new Error('local changes')
    });

    var result = loaded.module.action({ inputFolderPath: 'input/TS-42', jobParams: {} });

    assert.equal(result.success, true);
    assert.equal(rec.gitOps.length, 3);
    assert.deepEqual(rec.gitOps[0], { fn: 'checkoutPRBranch', branchName: 'ai/TS-42', workingDir: '/w', baseBranch: 'main' });
    assert.deepEqual(rec.gitOps[1], { fn: 'getPRDiff', baseBranch: 'main', headBranch: 'ai/TS-42', workingDir: '/w' });
});

test('missing head branch: checkout skipped, diff head null, branch unknown in comment', function() {
    var rec = prRecorder();
    var loaded = prLoad({
        record: rec,
        config: { repository: { owner: 'acme', repo: 'widget' }, git: { baseBranch: 'dev' } },
        prDetails: { number: 42, html_url: 'https://example.com/pull/42', head: null, base: null, changed_files: 1 }
    });

    var result = loaded.module.action({ inputFolderPath: 'input/TS-42', jobParams: { customParams: { trackerProvider: 'jira' } } });

    assert.equal(result.success, true);
    assert.equal(result.branchName, null);
    assert.deepEqual(rec.gitOps[0], { fn: 'getPRDiff', baseBranch: 'dev', headBranch: null, workingDir: undefined });
    assert.ok(rec.gitOps.every(function(c) { return c.fn !== 'checkoutPRBranch'; }));
    assert.equal(rec.ghCalls[3].fn, 'detectFailedChecks');
    assert.equal(rec.ghCalls[3].headSha, null);
    var comment = rec.comments[0].args.comment;
    assert.contains(comment, '*Branch*: {code}unknown{code}');
});

test('tracker comment failure is non-fatal: review continues', function() {
    var loaded = prLoad({
        config: { repository: { owner: 'acme', repo: 'widget' } },
        trackerThrows: true
    });

    var result = loaded.module.action({ inputFolderPath: 'input/TS-42', jobParams: {} });

    assert.equal(result.success, true);
});

test('parent-context enrichment failure is non-fatal', function() {
    var rec = prRecorder();
    var loaded = prLoad({
        record: rec,
        config: { repository: { owner: 'acme', repo: 'widget' } },
        parentError: new Error('confluence down')
    });

    var result = loaded.module.action({ inputFolderPath: 'input/TS-42', jobParams: {} });

    assert.equal(result.success, true);
    assert.equal(rec.parentCalls.length, 1);
});

});

suite('preparePRForReview — extracted helpers', function() {

test('parsePrAnchor: pr-N key wins, then jobParams.prNumber, then jobParams.pr', function() {
    var m = prLoad({}).module;
    assert.equal(m.parsePrAnchor('pr-42', {}), 42);
    assert.equal(m.parsePrAnchor('TS-42', { prNumber: '7' }), 7);
    assert.equal(m.parsePrAnchor('TS-42', { pr: '8' }), 8);
    assert.equal(m.parsePrAnchor('pr-9', { prNumber: '7' }), 9);
    assert.equal(m.parsePrAnchor('TS-42', {}), null);
    assert.equal(m.parsePrAnchor('', {}), null);
    // Case-sensitive: an uppercase key is a real ticket, not a PR anchor.
    assert.equal(m.parsePrAnchor('PR-42', {}), null);
});

test('parseContext: splits input folder, derives prAnchor/noTicket, keeps params', function() {
    var m = prLoad({}).module;

    var ticketCtx = m.parseContext({ inputFolderPath: 'input/TS-42' });
    assert.equal(ticketCtx.inputFolder, 'input/TS-42');
    assert.equal(ticketCtx.ticketKey, 'TS-42');
    assert.equal(ticketCtx.prAnchor, null);
    assert.equal(ticketCtx.noTicket, false);
    // Without jobParams, jp falls back to params itself.
    assert.equal(ticketCtx.jp.inputFolderPath, 'input/TS-42');

    var prCtx = m.parseContext({ inputFolderPath: 'input/pr-12', jobParams: {} });
    assert.equal(prCtx.ticketKey, 'pr-12');
    assert.equal(prCtx.prAnchor, 12);
    assert.equal(prCtx.noTicket, true);
});

test('describeConfiguredRepository / configuredBaseBranch fallbacks', function() {
    var m = prLoad({}).module;
    assert.equal(m.describeConfiguredRepository({ repository: { owner: 'o', repo: 'r' } }), 'o/r');
    assert.equal(m.describeConfiguredRepository({ repository: { owner: 'o' } }), '(fallback to git remote)');
    assert.equal(m.describeConfiguredRepository({}), '(fallback to git remote)');
    assert.equal(m.configuredBaseBranch({ git: { baseBranch: 'dev' } }), 'dev');
    assert.equal(m.configuredBaseBranch({ git: {} }), '(not set)');
    assert.equal(m.configuredBaseBranch({}), '(not set)');
});

test('refLabel / extractHeadBranch / extractBaseBranch fallbacks', function() {
    var m = prLoad({}).module;
    assert.equal(m.refLabel({ ref: 'x' }), 'x');
    assert.equal(m.refLabel({}), '(missing)');
    assert.equal(m.refLabel(null), '(missing)');
    assert.equal(m.extractHeadBranch({ head: { ref: 'b' } }), 'b');
    assert.equal(m.extractHeadBranch({}), null);
    assert.equal(m.extractBaseBranch({ base: { ref: 'dev' } }, { git: { baseBranch: 'main' } }), 'dev');
    assert.equal(m.extractBaseBranch({}, { git: { baseBranch: 'main' } }), 'main');
});

test('buildSetupFailedComment / buildNoPrComment / buildDetailsFailureComment', function() {
    var m = prLoad({}).module;
    assert.equal(m.buildSetupFailedComment('TS-1', 'no repo'),
        'h3. ⚠️ PR Review Setup Failed\n\nno repo\n\n_Review cancelled — no PR to review._');
    var noPr = m.buildNoPrComment('TS-2');
    assert.contains(noPr, 'Could not find an open Pull Request associated with *TS-2*.');
    assert.contains(noPr, 'Please ensure:');
    assert.equal(m.buildDetailsFailureComment('TS-3', 42),
        'h3. ⚠️ PR Review Setup Failed\n\nCould not fetch details for PR #42.\n\n_Review cancelled._');
});

test('buildReviewStartedComment: clean and failing-check variants', function() {
    var m = prLoad({}).module;
    var prDetails = { number: 42, html_url: 'https://example.com/pull/42', changed_files: 3 };

    var clean = m.buildReviewStartedComment('TS-42', prDetails, 'ai/TS-42', []);
    assert.contains(clean, 'h3. 🔍 Automated PR Review Started');
    assert.notContains(clean, 'CI checks failing');

    var failing = m.buildReviewStartedComment('TS-42', prDetails, 'ai/TS-42',
        [{ name: 'lint' }, { name: 'unit' }]);
    assert.contains(failing, '*CI checks failing* — 2 check(s) did not pass');
    assert.contains(failing, '* {code}lint{code}');
    assert.contains(failing, '* {code}unit{code}');
});

test('postFailureComment: null comment posts nothing, tracker errors are swallowed', function() {
    var m = prLoad({}).module;
    var posted = [];
    m.postFailureComment({ noTicket: false, ticketKey: 'TS-1', tracker: { postComment: function(k, c) { posted.push([k, c]); } } }, null);
    assert.equal(posted.length, 0);

    m.postFailureComment({ noTicket: false, ticketKey: 'TS-1', tracker: { postComment: function(k, c) { posted.push([k, c]); } } }, 'text');
    assert.deepEqual(posted, [['TS-1', 'text']]);

    // Must not throw when the tracker itself fails.
    m.postFailureComment({ noTicket: false, ticketKey: 'TS-1', tracker: { postComment: function() { throw new Error('down'); } } }, 'text');
});

test('postSetupErrorComment: noTicket skips, tracker errors are swallowed', function() {
    var m = prLoad({}).module;
    var posted = [];
    m.postSetupErrorComment({ noTicket: true }, { inputFolderPath: 'input/pr-1' }, new Error('x'));
    assert.equal(posted.length, 0);

    m.postSetupErrorComment({ noTicket: false }, { inputFolderPath: 'input/TS-1' }, new Error('x'));
    assert.equal(posted.length, 0); // no tracker provided — swallowed, not thrown

    m.postSetupErrorComment(
        { noTicket: false, tracker: { postComment: function(k, c) { posted.push([k, c]); } } },
        { inputFolderPath: 'input/TS-1' }, new Error('x'));
    assert.equal(posted.length, 1);
    assert.equal(posted[0][0], 'TS-1');
    assert.equal(posted[0][1], 'h3. ❌ PR Review Setup Error\n\n{code}Error: x{code}');
});

test('buildSuccessResult shape', function() {
    var m = prLoad({}).module;
    assert.deepEqual(
        m.buildSuccessResult({ number: 7, html_url: 'u' }, 'br', { owner: 'o', repo: 'r' }),
        { success: true, prNumber: 7, prUrl: 'u', branchName: 'br', owner: 'o', repo: 'r' });
});

});
