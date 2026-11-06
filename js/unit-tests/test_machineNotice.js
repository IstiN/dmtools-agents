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

var forkCheckoutModule = loadModule('js/common/forkCheckout.js', makeRequire({ './validationLiveness.js': loadModule('js/common/validationLiveness.js', makeRequire({}), {}) }), {});

// ── Loader helpers ────────────────────────────────────────────────────────────

function loadMachineNotice() {
    return loadModule('js/common/machineNotice.js');
}

function loadReviewThreadInventory() {
    return loadModule(
        'js/common/reviewThreadInventory.js',
        makeRequire({ './machineNotice.js': loadMachineNotice() })
    );
}

function loadScm(mocks) {
    return scmReal(mocks || {});
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
            './machineNotice.js': loadMachineNotice(),
            './reviewThreadInventory.js': loadReviewThreadInventory(),
            './ci.js': loadModule('js/common/ci.js'),
            './ciViolations.js': loadModule('js/common/ciViolations.js'),
            './githubReviewFetch.js': githubReviewFetchReal(mocks),
        }),
        mocks || {}
    );
}

function loadPreCliReworkSetup(mocks, gitOpsStub) {
    return loadModule(
        'js/preCliReworkSetup.js',
        makeRequire({
            './configLoader.js': { loadHookFn: function() { return null; }, paramsForConfigLoad: function(p) { return p; } },
            './common/reviewPolicy.js': (function() {
                var machineAuthor = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
                var reviewVerdicts = loadModule('js/common/reviewVerdicts.js',
                    makeRequire({ './machineAuthor.js': machineAuthor }), {});
                return loadModule('js/common/reviewPolicy.js',
                    makeRequire({ './reviewVerdicts.js': reviewVerdicts }), {});
            })(),
            './common/githubHelpers.js': {
                _isScm: function() { return false; },
                buildOriginFetchCommand: function() { return 'git fetch origin'; },
                findPRForTicket: function() {},
                getPRDetails: function() {},
                fetchDiscussionsAndRawData: function() {},
                detectFailedChecks: function() {}
            },
            './forkCheckout.js': forkCheckoutModule,
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

suite('machineNotice — hidden dmtools: markers (gh-1097 naked-pr-rearm)', function() {
    test('naked-pr-rearm and other dmtools: markers classify as notices; quotes do not', function() {
        var mn = loadMachineNotice();
        assert.ok(mn.isMachineNoticeBody('<!-- dmtools:naked-pr-rearm {"pr":1} -->\n🩹 re-armed'));
        assert.ok(mn.isMachineNoticeBody('<!-- dmtools:rework-lap {} -->'));
        assert.notOk(mn.isMachineNoticeBody('please see `<!-- dmtools:naked-pr-rearm` above'));
        assert.ok(mn.isDmtoolsMarkerBody('  <!-- dmtools:x -->'));
    });
});

// ── gh-1387 comment-reduction — L1: general-comments section filter ────────
suite('buildGeneralCommentsSection drops markers AND visible notices (gh-1387 L1)', function() {
    function comment(body, login, date) {
        return { user: { login: login || 'dmtools-factory-bot' }, created_at: date || '2026-11-06T06:00:00Z', body: body };
    }
    function section(comments) {
        return githubReviewFetchReal().buildGeneralCommentsSection(comments);
    }
    test('hidden dmtools: marker comments stay out of the section', function() {
        var s = section([comment('<!-- dmtools:rework-consume {"head":"a"} -->\n🏷️ consumed')]);
        assert.equal(s, null, 'markers-only PR → no empty header');
    });
    test('visible machine notices (arm/red/conflict) drop out — gh-808 finish line', function() {
        var s = section([
            comment('🧵 Unresolved review threads — rework armed. The rework leg owns open threads.'),
            comment('🔴 red head 4d6053bfd33f56f0471fec8d4210e56a561d4d39 — red 1/3'),
            comment('⚠️ Validation CI went red on the head — merge aborted, rework re-queued.'),
            comment('⚠️ Merge conflict with main — rework re-queued.'),
            comment('🔄 zombie re-dispatch 4a02f46727ab815075aac4d0ad2cf3c35ee9675d — zombie 1/3 at 2026-11-06T08:28:21.712Z')
        ]);
        assert.equal(s, null, 'notices-only PR → null, not a header-only section');
    });
    test('review summaries and human comments survive', function() {
        var s = section([
            comment('## Automated Code Review — REQUEST_CHANGES\n**Summary**: the guard is well-built.', 'dmtools-factory-bot'),
            comment('Looks good overall — one question below.', 'human-reviewer'),
            comment('<!-- dmtools:naked-pr-rearm {"head":"a"} -->\n🩹 re-armed')
        ]);
        assert.ok(s.indexOf('## General PR Comments') === 0);
        assert.ok(s.indexOf('Automated Code Review') !== -1, 'review summary kept');
        assert.ok(s.indexOf('human-reviewer') !== -1, 'human comment kept');
        assert.ok(s.indexOf('Naked-PR reconciliation') === -1 && s.indexOf('re-armed') === -1, 'marker-led comment dropped');
    });
    test('a notice QUOTED mid-body never drops (anchored-prefix contract holds here too)', function() {
        var s = section([comment('the bot said "🧵 Unresolved review threads — rework armed." in a thread')]);
        assert.ok(s !== null && s.indexOf('the bot said') !== -1);
    });
});

// ── gh-1387 comment-reduction — L2: repeat-notice suppression helpers ──────
suite('noticeWithHead / hasSameNotice / shouldPostNotice (gh-1387 L2)', function() {
    var mn; // fresh module per test
    function commentsFrom(bodies) {
        return bodies.map(function (b) { return { body: b }; });
    }
    test('noticeWithHead appends the short head token; marker prefix line untouched', function() {
        mn = loadMachineNotice();
        var base = '🧵 Unresolved review threads — rework armed. The rework leg owns open threads.';
        var withHead = mn.noticeWithHead(base, '4d6053bfd33f56f0471fec8d4210e56a561d4d39');
        assert.ok(withHead.indexOf(base) === 0, 'first line byte-identical (classifier key)');
        assert.ok(withHead.indexOf('\n(arm head 4d6053b)') !== -1);
        assert.equal(mn.noticeWithHead(base, null), base, 'headless → unchanged');
        assert.equal(mn.noticeHeadToken(null), '');
    });
    test('shouldPostNotice: same head repeats suppressed, new head or read failure posts', function() {
        mn = loadMachineNotice();
        var base = '🧵 Unresolved review threads — rework armed. The rework leg owns open threads.';
        var first = mn.noticeWithHead(base, '85b6e8d4a2cedad6f9fa8a184d24793d01c129c4');
        var posted = commentsFrom([first]);
        assert.equal(mn.shouldPostNotice(posted, first, '85b6e8d4a2cedad6f9fa8a184d24793d01c129c4'), false,
            'same head + same first line → suppressed');
        assert.equal(mn.shouldPostNotice(posted, first, '68e0a7b61901cb37fb7fe6599a5305652aa05ff6'), true,
            'new head → posted');
        assert.equal(mn.shouldPostNotice([], first, '85b6e8d4a2cedad6f9fa8a184d24793d01c129c4'), true,
            'empty history (read failure fail-open) → posted');
        assert.equal(mn.shouldPostNotice(posted, mn.noticeWithHead(base, 'a1261c3bd879297b88e79aa5a0322987535c3c80'), 'a1261c3bd879297b88e79aa5a0322987535c3c80'), true,
            'same head but different first line (e.g. advanced red count) → posted');
    });
    test('hasSameNotice keys on first line + head token, not fuzzy text', function() {
        mn = loadMachineNotice();
        var first = mn.noticeWithHead('🧵 Unresolved review threads — rework armed. Body A.', '85b6e8d');
        assert.equal(mn.hasSameNotice(commentsFrom(['a quote of 🧵 Unresolved review threads — rework armed mid-text (arm head 85b6e8)']), first, '85b6e8d'), false,
            'mid-body mention is not an anchored match');
    });
});

// ── gh-1392 review threads 1 + 5: strict-mode prologue + headless red-gate ──
suite('githubReviewFetch strict prologue + headless red-gate marker (gh-1392 review)', function() {
    // Review thread 1: the PR put the new helpers above the 'use strict';
    // directive. A directive prologue is honored only before any statement —
    // a function declaration above it silently degrades the WHOLE module to
    // sloppy mode. Pinned structurally: no code statement may precede the
    // directive (comments/docblock are fine).
    test("'use strict'; precedes every statement in githubReviewFetch.js", function() {
        var src = file_read({ path: 'js/common/githubReviewFetch.js' });
        assert.ok(src, 'source readable');
        var idx = src.indexOf("'use strict';");
        assert.ok(idx !== -1, "the module declares 'use strict';");
        var code = src.substring(0, idx)
            .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments (module docblock)
            .replace(/\/\/[^\n]*/g, '');        // line comments
        assert.equal(code.indexOf('function '), -1,
            "a function declaration above 'use strict'; terminates the directive prologue — the whole module evaluates in sloppy mode (gh-1392 review thread 1). Move the helpers below the directive + requires.");
        assert.equal(code.indexOf('require('), -1,
            'a require call above the directive has the same prologue-terminating effect');
    });

    // Review thread 5: with no head (armNoticeHead → null) the red-gate arm
    // body leads with '🔴 Red pre-merge gate on the head…', which matched no
    // MACHINE_NOTICE_MARKERS entry — the notice passed the gh-808 filter and
    // leaked verbatim into every review/rework context build.
    test('the headless red-gate arm wording classifies as a machine notice', function() {
        var mn = loadMachineNotice();
        var body = '🔴 Red pre-merge gate on the head with no armed validation — rework armed' +
            ' (gh-917: first validation included, review or no review). The rework runner pushes a' +
            ' fix and validation re-runs on the new head (validate-fresh). After 3 red arming attempts' +
            ' on the SAME head the arm is withheld and a human is escalated (no infinite retry).';
        assert.ok(mn.isMachineNoticeBody(body),
            'no MACHINE_NOTICE_MARKERS entry matches the bare red-gate wording — it leaks into the agent-facing section (gh-1392 review thread 5)');
        var s = githubReviewFetchReal().buildGeneralCommentsSection([
            { user: { login: 'ai-teammate' }, created_at: '2026-11-06T06:00:00Z', body: body }
        ]);
        assert.equal(s, null, 'a headless red-gate arm is notices-only → the section renders null');
    });
});
