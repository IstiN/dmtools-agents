/**
 * Unit tests for gh-808 — machine-notice filtering in rework thread collection.
 *
 * Bug (fa PR #1428 round 2): 9 of 13 rework replies were boilerplate answers to
 * the machine's own arming/status notices, because the discussion collectors
 * treated every conversation as a review thread with reply targeting.
 *
 * Coverage:
 *   L1 — the marker-keyed classifier (js/common/machineNotice.js):
 *        notice vs real thread vs the "reviewer quotes a notice" edge.
 *   L2 — replay of the #1428-shaped 13-comment corpus through BOTH collection
 *        paths (SCM GitHub provider — the one preCliReworkSetup actually uses —
 *        and the githubHelpers string path): exactly the 4 real threads survive,
 *        with their threadIds intact (gh-799 contract).
 *   AC3 — a notices-only PR collapses to the {"threads":[]} placeholder while
 *        review_state.md still carries the CHANGES_REQUESTED verdict summary.
 *
 * Uses: configModule, loadModule(), makeRequire(), assert, test(), suite()
 */

// ── Loader helpers ────────────────────────────────────────────────────────────

function loadMachineNotice() {
    return loadModule('js/common/machineNotice.js');
}

function loadScm(mocks) {
    return loadModule(
        'js/common/scm.js',
        makeRequire({ './machineNotice.js': loadMachineNotice() }),
        mocks || {}
    );
}

/** GitHub provider wired exactly as createScm does for a configured repo. */
function makeGithubScm(mocks) {
    return loadScm(mocks).createScm({
        scm: { provider: 'github' },
        repository: { owner: 'org', repo: 'repo' }
    });
}

function loadGithubHelpers(mocks) {
    return loadModule(
        'js/common/githubHelpers.js',
        makeRequire({
            './pullRequest.js': {
                buildOriginFetchCommand: function(refSpec) {
                    return 'git -c fetch.recurseSubmodules=no fetch origin' + (refSpec ? ' ' + refSpec : '');
                }
            },
            './gitOps.js': {
                checkoutPRBranch: function() {},
                getPRDiff: function() {},
                detectMergeConflicts: function() {},
                trimLargeTextForInput: function() {},
                writePRContext: function() {}
            },
            './machineNotice.js': loadMachineNotice()
        }),
        mocks || {}
    );
}

function loadPreCliReworkSetup(mocks, gitOpsStub) {
    return loadModule(
        'js/preCliReworkSetup.js',
        makeRequire({
            './configLoader.js': { loadHookFn: function() { return null; }, paramsForConfigLoad: function(p) { return p; } },
            './common/githubHelpers.js': {
                _isScm: function() { return false; },
                buildOriginFetchCommand: function() { return 'git fetch origin'; },
                findPRForTicket: function() {},
                getPRDetails: function() {},
                fetchDiscussionsAndRawData: function() {},
                detectFailedChecks: function() {}
            },
            './common/gitOps.js': gitOpsStub,
            './common/commentMarkup.js': loadModule('js/common/commentMarkup.js',
                makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') })),
            './fetchQuestionsToInput.js': {},
            './fetchParentContextToInput.js': {},
            './restoreFromReleases.js': {},
            './common/trackers.js': { createTracker: function() { return {}; } },
            './common/setupCommands.js': loadModule('js/common/setupCommands.js'),
            './common/baseBranchMarker.js': { writeBaseBranchMarker: function() {} },
            './config.js': { resolveStatuses: function() { return {}; } }
        }),
        mocks || {}
    );
}

// ── Fixtures — the fa PR #1428 round-2 corpus shape ───────────────────────────
// 9 machine notices (bodies are the harness's own texts) + 4 real reviewer
// threads. The filter must leave exactly the 4 real ones.

var NOTICE_BODIES = [
    // smAgent.js arm_rework notice
    '🧵 Unresolved review threads — rework armed. This machine-authored PR is reviewed ' +
        '(ai_pr_reviewed) but still has open review threads. The rework leg owns open threads: ' +
        'agent:rework is armed on this PR and the rework runner will work through the threads and push.',
    // smAgent.js parkMarker
    '🅿️ Validation red — PR parked — the current head `abc12340` failed validation and the head has ' +
        'not moved. Re-running CI on the same SHA cannot pass, so the merge window skips this PR until the head moves.',
    // smAgent.js park-clear notice
    '🅿️→▶ validation_failed cleared — the park was set on head `abc12340` but a NEW head `def56789` landed — validation proceeds.',
    // smAgent.js rcMarker (cancelled checks re-run)
    '🔁 Cancelled required checks re-run: `build`, `quality` ended CANCELLED on this head — ' +
        'CANCELLED is never a verdict: nothing failed, the re-run re-stamps the contexts and merging resumes automatically.',
    // smAgent.js conflict_rework report
    '⚠️ Merge conflict with main — the silent branch update could not merge main (conflict). (head `abc12340`)',
    // smAgent.js fail_validation report
    '⚠️ Validation CI went red on the head — merge aborted, rework re-queued.',
    // pushReworkChanges.js completion comment (GitHub h3 rendering)
    '### ✅ Rework Completed\n**Branch**: `fix/gh-1428`\n\nAI Teammate has addressed all PR review comments and pushed the fixes.',
    // pushReworkChanges.js fix summary
    '## 🔧 Rework Complete — gh-1428\n\nAll review feedback has been addressed in the thread replies above.',
    // postPRReviewComments.js review summary (h2 rendering)
    '## 🔍 Automated PR Review Completed\n\nThe review completed with 2 blocking findings.'
];

function realThreadsFixture() {
    return [
        { id: 101, graphqlId: 'PRRT_real1', path: 'js/common/scm.js', line: 42,
          author: 'alice', body: 'This helper duplicates the retry logic in scm.js — extract it.' },
        { id: 102, graphqlId: 'PRRT_real2', path: 'js/common/machineNotice.js', line: 7,
          author: 'bob', body: 'Consider naming this `threadClassifier` for consistency.' },
        { id: 103, graphqlId: 'PRRT_real3', path: 'js/common/githubHelpers.js', line: 317,
          author: 'alice', body: 'Null deref when the PR has no head sha.' },
        // The L1 edge case INSIDE the corpus: a real reviewer thread that QUOTES a notice.
        { id: 104, graphqlId: 'PRRT_real4', path: 'js/common/smAgent.js', line: 1239,
          author: 'carol',
          body: 'The loop stalled on this arming notice:\n> 🧵 Unresolved review threads — rework armed. This machine-authored PR...\nPlease filter these before the next leg.' }
    ];
}

function makeProviderConversation(id, path, body, author) {
    return {
        rootComment: {
            id: id,
            databaseId: id,
            body: body,
            user: { login: author || 'reviewer' },
            created_at: '2026-10-09T10:00:00Z'
        },
        replies: [],
        path: path || null,
        line: path ? 12 : null
    };
}

/** The full 13-conversation corpus: 9 notices first, then the 4 real threads. */
function corpusConversations() {
    var conversations = [];
    for (var i = 0; i < NOTICE_BODIES.length; i++) {
        conversations.push(makeProviderConversation(900 + i, null, NOTICE_BODIES[i], 'ai-teammate'));
    }
    realThreadsFixture().forEach(function(t) {
        conversations.push(makeProviderConversation(t.id, t.path, t.body, t.author));
    });
    return conversations;
}

function corpusGraphQLResponse() {
    return {
        data: {
            repository: {
                pullRequest: {
                    reviewThreads: {
                        nodes: realThreadsFixture().map(function(t) {
                            return {
                                id: t.graphqlId,
                                isResolved: false,
                                comments: { nodes: [{ databaseId: t.id }] }
                            };
                        })
                    }
                }
            }
        }
    };
}

// ═══ L1 — the marker-keyed classifier ═════════════════════════════════════════

suite('machineNotice.isMachineNoticeBody — marker-keyed classification (gh-808 L1)', function() {

    test('every harness notice corpus body classifies as a machine notice', function() {
        var mn = loadMachineNotice();
        for (var i = 0; i < NOTICE_BODIES.length; i++) {
            assert.ok(mn.isMachineNoticeBody(NOTICE_BODIES[i]),
                'notice #' + i + ' must classify as a machine notice');
        }
    });

    test('a notice rendered under a markdown heading prefix still matches', function() {
        var mn = loadMachineNotice();
        assert.ok(mn.isMachineNoticeBody('### ✅ Rework Completed\npushed.'),
            'h3-prefixed completion comment must match');
        assert.ok(mn.isMachineNoticeBody('## 🔍 Automated PR Review Completed\n\nfindings...'),
            'h2-prefixed review summary must match');
    });

    test('real reviewer feedback does not match any marker', function() {
        var mn = loadMachineNotice();
        realThreadsFixture().forEach(function(t) {
            assert.notOk(mn.isMachineNoticeBody(t.body),
                'real thread from ' + t.author + ' must NOT classify as a notice');
        });
    });

    test('EDGE: a reviewer comment QUOTING a notice (blockquote / mid-body) is not filtered', function() {
        var mn = loadMachineNotice();
        var quoted = 'The loop stalled on this arming notice:\n' +
            '> 🧵 Unresolved review threads — rework armed. This machine-authored PR...\n' +
            'Please filter these before the next leg.';
        assert.notOk(mn.isMachineNoticeBody(quoted),
            'a quote inside the body must not trip the anchored marker match');
        assert.notOk(mn.isMachineNoticeBody('Please note: ✅ Rework Completed messages should stop.'),
            'a mid-body mention must not trip the match');
    });

    test('empty or absent bodies are not notices', function() {
        var mn = loadMachineNotice();
        assert.notOk(mn.isMachineNoticeBody(''));
        assert.notOk(mn.isMachineNoticeBody(null));
        assert.notOk(mn.isMachineNoticeBody(undefined));
        assert.notOk(mn.isMachineNoticeBody('   \n  '));
    });

    test('isMachineNotice accepts comment objects as well as raw strings', function() {
        var mn = loadMachineNotice();
        assert.ok(mn.isMachineNotice({ body: NOTICE_BODIES[0] }));
        assert.notOk(mn.isMachineNotice({ body: 'please fix the null deref' }));
        assert.notOk(mn.isMachineNotice(null));
    });

    test('isBotAuthor flags the known informational bot accounts only', function() {
        var mn = loadMachineNotice();
        assert.ok(mn.isBotAuthor('github-actions[bot]'));
        assert.ok(mn.isBotAuthor('dependabot[bot]'));
        assert.ok(mn.isBotAuthor('something-else[bot]'));
        assert.notOk(mn.isBotAuthor('ai-teammate'),
            'the machine login is NOT a [bot] account — marker classification owns it');
        assert.notOk(mn.isBotAuthor('alice'));
        assert.notOk(mn.isBotAuthor(null));
    });
});

// ═══ L2 — corpus replay through the SCM GitHub provider (the rework path) ════

suite('scm GitHub provider.fetchDiscussions — gh-808 corpus replay (L2)', function() {

    test('AC1+AC2: the 13-comment corpus leaves exactly the 4 real threads with threadIds intact', function() {
        var scm = makeGithubScm({
            github_get_pr_conversations: function() { return corpusConversations(); },
            github_get_pr_review_threads: function() { return corpusGraphQLResponse(); },
            github_get_pr_comments: function() { return []; }
        });

        var result = scm.fetchDiscussions('1428');
        assert.ok(result.rawThreads, 'real threads exist → rawThreads must be present');
        assert.equal(result.rawThreads.threads.length, 4,
            'exactly the 4 real review threads survive the notice filter');
        assert.equal(result.rawThreads.threads.filter(function(t) { return !!t.threadId; }).length, 4,
            'every surviving thread keeps its GraphQL threadId (gh-799 contract)');

        result.rawThreads.threads.forEach(function(t) {
            assert.notOk(mn_isNoticeBody(t.body), 'no notice body may survive in rawThreads');
        });
    });

    test('AC1: zero entries whose source comment is a machine notice', function() {
        var scm = makeGithubScm({
            github_get_pr_conversations: function() { return corpusConversations(); },
            github_get_pr_review_threads: function() { return corpusGraphQLResponse(); },
            github_get_pr_comments: function() { return []; }
        });

        var result = scm.fetchDiscussions('1428');
        var noticeCount = result.rawThreads.threads.filter(function(t) {
            return NOTICE_BODIES.indexOf(t.body) !== -1;
        }).length;
        assert.equal(noticeCount, 0, 'pr_discussions_raw.json must contain zero machine-notice entries');
    });

    test('notice threads are also excluded from the markdown, real threads stay', function() {
        var scm = makeGithubScm({
            github_get_pr_conversations: function() { return corpusConversations(); },
            github_get_pr_review_threads: function() { return corpusGraphQLResponse(); },
            github_get_pr_comments: function() { return []; }
        });

        var result = scm.fetchDiscussions('1428');
        assert.contains(result.markdown, 'This helper duplicates the retry logic',
            'real blocking thread stays in the readable discussions');
        NOTICE_BODIES.forEach(function(body, i) {
            var markerLine = body.split('\n')[0];
            assert.notContains(result.markdown, markerLine,
                'notice #' + i + ' must be excluded from the markdown');
        });
        assert.contains(result.markdown, 'machine notice',
            'the exclusion summary note must state how many notices were dropped');
    });

    test('a notices-only PR collapses to rawThreads null (drives the gh-799 placeholder)', function() {
        var scm = makeGithubScm({
            github_get_pr_conversations: function() {
                return corpusConversations().filter(function(c) { return !c.path; });
            },
            github_get_pr_review_threads: function() { throw new Error('no review threads'); },
            github_get_pr_comments: function() { return []; }
        });

        var result = scm.fetchDiscussions('1428');
        assert.equal(result.rawThreads, null,
            'zero real threads → rawThreads null so ensureInputContextContract writes the placeholder');
    });
});

// ═══ L2 — corpus replay through the string path (back-compat) ═════════════════

suite('githubHelpers.fetchDiscussionsAndRawData — gh-808 corpus replay (string path)', function() {

    test('notices are dropped entirely from rawThreads (AC1), real threads keep their ids (AC2)', function() {
        var gh = loadGithubHelpers({
            github_get_pr_conversations: function() { return corpusConversations(); },
            github_get_pr_review_threads: function() { return corpusGraphQLResponse(); },
            github_get_pr_comments: function() { return []; }
        });

        var result = gh.fetchDiscussionsAndRawData('org', 'repo', '1428');
        assert.equal(result.rawThreads.threads.length, 4, 'exactly the 4 real threads survive');
        result.rawThreads.threads.forEach(function(t) {
            assert.ok(t.threadId, 'threadId preserved (gh-799 contract)');
        });
        var noticeEntries = result.rawThreads.threads.filter(function(t) {
            return NOTICE_BODIES.indexOf(t.body) !== -1;
        });
        assert.equal(noticeEntries.length, 0, 'zero machine-notice entries (AC1)');
    });

    test('existing bot classification still works alongside the notice filter', function() {
        var conversations = [
            makeProviderConversation(801, 'src/a.js', 'ci report here', 'github-actions[bot]'),
            makeProviderConversation(802, 'src/b.js', 'real blocking feedback', 'alice')
        ];
        var gh = loadGithubHelpers({
            github_get_pr_conversations: function() { return conversations; },
            github_get_pr_review_threads: function() { return { data: { repository: { pullRequest: { reviewThreads: { nodes: [
                { id: 'PRRT_bot', isResolved: false, comments: { nodes: [{ databaseId: 801 }] } },
                { id: 'PRRT_ok', isResolved: false, comments: { nodes: [{ databaseId: 802 }] } }
            ] } } } } }; },
            github_get_pr_comments: function() { return []; }
        });

        var result = gh.fetchDiscussionsAndRawData('org', 'repo', '42');
        assert.equal(result.rawThreads.threads.length, 2, 'bot entries stay flagged, not dropped');
        var bot = result.rawThreads.threads.filter(function(t) { return t.rootCommentId === 801; })[0];
        var real = result.rawThreads.threads.filter(function(t) { return t.rootCommentId === 802; })[0];
        assert.equal(bot.bot, true, '[bot] author flagged informational');
        assert.notOk(real.bot, 'human thread not flagged');
        assert.notContains(result.markdown, 'ci report here', 'bot thread excluded from markdown');
        assert.contains(result.markdown, 'real blocking feedback', 'human thread stays in markdown');
    });
});

// ═══ AC3 — empty-after-filter + CHANGES_REQUESTED ⇒ verdict summary ═══════════

suite('gh-808 AC3 — notices-only PR keeps the verdict contract', function() {

    function makeContractHarness() {
        var writes = [];
        var files = {};
        var gitOpsStub = {
            writeInputFile: function(path, content, label) {
                writes.push({ path: path, content: content });
                files[path] = content;
            },
            checkoutPRBranch: function() {},
            detectMergeConflicts: function() { return []; },
            getPRDiff: function() { return ''; },
            writePRContext: function() {}
        };
        var mod = loadPreCliReworkSetup({
            file_write: function(args) { writes.push(args); files[args.path] = args.content; },
            file_read: function(args) {
                var p = args && (args.path || args);
                if (files[p] !== undefined) return files[p];
                throw new Error('File does not exist: ' + p);
            }
        }, gitOpsStub);
        return { mod: mod, writes: writes, files: files };
    }

    test('notices-only corpus → placeholder raw file + CHANGES_REQUESTED verdict in review_state.md', function() {
        var h = makeContractHarness();
        // The provider output for a notices-only PR (post-filter shape).
        var discussionData = { markdown: null, rawThreads: null };
        var scm = {
            listReviews: function() {
                return [{ state: 'CHANGES_REQUESTED', user: { login: 'reviewer2' },
                          submitted_at: '2026-10-09T08:56:00Z', body: 'Please fix the null deref' }];
            }
        };

        h.mod.ensureInputContextContract('input/PROJ-123', scm, 7, discussionData, []);

        var raw = JSON.parse(h.files['input/PROJ-123/pr_discussions_raw.json']);
        assert.ok(raw && Array.isArray(raw.threads) && raw.threads.length === 0,
            'AC3: empty-after-filter ships the {"threads":[]} contract placeholder');

        var rs = h.files['input/PROJ-123/review_state.md'];
        assert.contains(rs, 'CHANGES_REQUESTED', 'AC3: the verdict summary is present');
        assert.contains(rs, 'reviewer2');
        assert.contains(rs, 'Please fix the null deref', 'AC3: the agent works from the verdict');
        assert.contains(rs, 'requires changes', 'AC3: blocking verdict flagged');
        assert.contains(rs, 'Open review threads at rework start: 0',
            'AC3: the open-thread inventory is honestly zero');
    });
});

// helper used inside corpus assertions (real module, loaded late)
function mn_isNoticeBody(body) {
    return loadMachineNotice().isMachineNoticeBody(body);
}
