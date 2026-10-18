/**
 * Unit tests: js/common/reviewSpecClaims.js — BLOCKING findings whose core
 * claim is an external-spec assertion must not reach the machine as blocking
 * unless they carry a verifiable citation (gh-1053).
 *
 * Live pathology being replayed: a review leg posted a 🚨 BLOCKING thread
 * claiming "the spec (ticket, Java SomePolicy) exempts only *_MAX_TOKENS and
 * *_TOKEN_LIMIT" — never having read the referenced source. The claim was
 * false; the reviewed code was behaviorally identical to the reference. The
 * machine treated the thread as real rework demand: a rework arm on a
 * validated PR, two leg dispatches, human intervention.
 *
 * Coverage:
 *   - external-spec claim detection (the assertion phrase families);
 *   - verifiable-citation detection (file:line / doc URL);
 *   - AC2/AC3: an uncited spec claim is classified NON-BLOCKING;
 *   - AC4: a spec claim WITH a citation keeps full BLOCKING force;
 *   - non-spec findings are untouched (no strictness cut);
 *   - sanitizeReviewData: rewrites bodies, rebalances issueCounts,
 *     collapses REQUEST_CHANGES to APPROVE when no cited blocking remains.
 *
 * Uses: test(), suite(), assert — pure module, no dmtools globals.
 */
/* global suite, test, assert, loadModule, makeRequire */

suite('reviewSpecClaims — detection (gh-1053)', function () {
    var rsc = loadModule('js/common/reviewSpecClaims.js', makeRequire({}), {});

    test('detects "the spec says/requires/exempts ..." assertion families', function () {
        assert.ok(rsc.isExternalSpecClaim('🚨 BLOCKING: the spec says only *_MAX_TOKENS is exempt'), 'spec says');
        assert.ok(rsc.isExternalSpecClaim('The specification requires a timeout here'), 'specification requires');
        assert.ok(rsc.isExternalSpecClaim('according to the spec this endpoint must reject'), 'according to the spec');
        assert.ok(rsc.isExternalSpecClaim('per the documentation, retries are capped at 3'), 'per the documentation');
        assert.ok(rsc.isExternalSpecClaim('the Java reference implementation uses contains-based exemptions'), 'reference implementation');
        assert.ok(rsc.isExternalSpecClaim('Java JsEnvPolicy exempts only *_TOKEN_LIMIT'), 'java <class> <verb>');
        assert.ok(rsc.isExternalSpecClaim('the official docs state the default is true'), 'official docs state');
    });

    test('ignores ordinary code-grounded findings', function () {
        assert.ok(!rsc.isExternalSpecClaim('🚨 BLOCKING: this null-check is missing, NPE on empty input'), 'plain bug');
        assert.ok(!rsc.isExternalSpecClaim('the new helper retries up to 3 times'), 'code description without spec verb');
        assert.ok(!rsc.isExternalSpecClaim(''), 'empty body');
        assert.ok(!rsc.isExternalSpecClaim(null), 'null body');
    });

    test('verifiable citation = file:line / #L anchor or trusted-host doc URL', function () {
        assert.ok(rsc.hasVerifiableCitation('see JsEnvPolicy.java:61-66 for the exemption list'), 'file:line');
        assert.ok(rsc.hasVerifiableCitation('deviation from the reference (Policy.java#L61)'), '#L line anchor');
        assert.ok(rsc.hasVerifiableCitation('see Policy.java#L61-L66'), '#L-L range anchor');
        assert.ok(rsc.hasVerifiableCitation('per https://github.com/acme/docs#retries the default is 3'), 'trusted doc URL');
        assert.ok(rsc.hasVerifiableCitation('per https://api.github.com/repos/acme/spec the default is 3'), 'subdomain of a trusted host');
        assert.ok(rsc.hasVerifiableCitation('per https://docs.internal.example.com/spec the default is 3',
            { trustedDocHosts: ['docs.internal.example.com'] }), 'deployment override wins');
        assert.ok(rsc.hasVerifiableCitation('ticket.md:12 requires a timeout'), 'markdown file:line');
        assert.ok(!rsc.hasVerifiableCitation('the spec says a timeout is required'), 'bare assertion');
        assert.ok(!rsc.hasVerifiableCitation('the file policy.java does X without any line'), 'bare filename is not a citation');
        assert.ok(!rsc.hasVerifiableCitation('per https://example.com/anything the spec is quoted'), 'untrusted host URL is not a citation');
    });

    test('isUncitedSpecClaim = spec claim AND no citation', function () {
        assert.ok(rsc.isUncitedSpecClaim('the spec says only *_MAX_TOKENS is exempt'));
        assert.ok(!rsc.isUncitedSpecClaim('the spec says X (Policy.java:61)'));
        assert.ok(!rsc.isUncitedSpecClaim('the spec says X (Policy.java#L61)'), '#L anchor counts');
        assert.ok(!rsc.isUncitedSpecClaim('the spec says X (https://github.com/acme/spec)'), 'trusted doc URL counts');
        assert.ok(rsc.isUncitedSpecClaim('the spec says X is forbidden (see https://example.com/anything)'),
            'arbitrary pasted URL does NOT count');
        assert.ok(!rsc.isUncitedSpecClaim('missing null-check causes NPE'));
    });
});

suite('reviewSpecClaims — severity classification (gh-1053 AC2/AC3/AC4)', function () {
    var rsc = loadModule('js/common/reviewSpecClaims.js', makeRequire({}), {});

    test('AC3: uncited external-spec claim is classified NON-BLOCKING even with a 🚨 marker', function () {
        var body = '🚨 BLOCKING: the spec says only *_MAX_TOKENS and *_TOKEN_LIMIT are exempt — this PR exempts more.';
        var result = rsc.classifyFindingSeverity(body, 'BLOCKING');
        assert.equal(result.severity, 'important', 'downgraded to important (non-blocking)');
        assert.ok(!result.blocking, 'no blocking force');
        assert.ok(result.downgraded, 'marked as downgraded');
    });

    test('AC3: BLOCKING via the word marker only (no severity field) is also downgraded', function () {
        var result = rsc.classifyFindingSeverity('BLOCKING: The specification requires X but the PR does Y', null);
        assert.equal(result.severity, 'important');
        assert.ok(result.downgraded);
    });

    test('AC4: spec claim WITH a file:line citation keeps full BLOCKING force', function () {
        var body = '🚨 BLOCKING: the spec requires exactly these exemptions (JsEnvPolicy.java:61-66) — the PR deviates at line 40.';
        var result = rsc.classifyFindingSeverity(body, 'BLOCKING');
        assert.equal(result.severity, 'blocking', 'stays blocking');
        assert.ok(result.blocking);
        assert.ok(!result.downgraded, 'not downgraded');
    });

    test('AC4: spec claim WITH a doc URL keeps full BLOCKING force', function () {
        var body = 'BLOCKING: per the API docs (https://github.com/acme/spec#retries) retries must be bounded — they are not.';
        var result = rsc.classifyFindingSeverity(body, 'BLOCKING');
        assert.equal(result.severity, 'blocking');
        assert.ok(!result.downgraded);
    });

    test('incidental spec mention does NOT demote a code-level defect blocker', function () {
        var body = '🚨 BLOCKING: SQL injection via raw string interpolation — user input reaches ' +
            'the DB unescaped. (Also, the spec says prepared statements are required.)';
        var result = rsc.classifyFindingSeverity(body, 'BLOCKING');
        assert.equal(result.severity, 'blocking', 'stays blocking — the spec phrase is not the core claim');
        assert.ok(result.blocking);
        assert.ok(!result.downgraded, 'not downgraded');
    });

    test('non-spec blocking findings keep full BLOCKING force (no strictness cut)', function () {
        var result = rsc.classifyFindingSeverity('🚨 BLOCKING: SQL injection — user input interpolated raw', 'BLOCKING');
        assert.equal(result.severity, 'blocking');
        assert.ok(!result.downgraded);
    });

    test('downgradeBody swaps the 🚨 marker, demotes the BLOCKING word, and appends a confirm-against-source note', function () {
        var body = '🚨 BLOCKING\nThe spec says X is forbidden.';
        var down = rsc.downgradeBody(body);
        assert.equal(down.indexOf('\uD83D\uDEA8'), -1, '🚨 marker removed');
        assert.ok(down.indexOf('\u26A0') !== -1, '⚠ marker present');
        assert.equal(down.indexOf('BLOCKING'), -1, 'BLOCKING word demoted');
        assert.ok(down.indexOf('IMPORTANT') !== -1, 'IMPORTANT word present');
        assert.ok(down.indexOf('gh-1053') !== -1, 'downgrade note references the rule');
        assert.ok(/confirm/i.test(down), 'asks the author to confirm against the source');
        assert.ok(down.indexOf('spec says') !== -1, 'original claim text preserved');
    });

    test('downgradeBody never touches "non-blocking" hyphenated prose', function () {
        var down = rsc.downgradeBody('🚨 BLOCKING: the spec says X.\nSide note: the retry path is non-blocking.');
        assert.ok(down.indexOf('non-blocking') !== -1, 'hyphenated word intact');
    });

    test('downgrade note asks to confirm against the source the finding references (not "the cited source")', function () {
        var down = rsc.downgradeBody('🚨 BLOCKING: the spec says X is forbidden.');
        assert.ok(down.indexOf('the cited source') === -1, 'no phantom-citation wording');
        assert.ok(/confirm against the source the finding references/i.test(down), 'points at the referenced source');
        assert.ok(down.indexOf('"the spec says') !== -1, 'interpolates the matched spec-claim phrase');
    });
});

suite('reviewSpecClaims — sanitizeReviewData (machine-side guard)', function () {
    var rsc = loadModule('js/common/reviewSpecClaims.js', makeRequire({}), {});

    test('review output with an uncited spec claim is classified non-blocking (AC3)', function () {
        var review = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 1, important: 0, suggestions: 0 },
            inlineComments: [
                { path: 'src/env.js', line: 10, severity: 'BLOCKING',
                  body: '🚨 BLOCKING: the spec says only *_MAX_TOKENS is exempt — this PR exempts more.' }
            ]
        };
        var result = rsc.sanitizeReviewData(review, null);
        assert.equal(result.downgrades, 1, 'one finding downgraded');
        assert.equal(review.issueCounts.blocking, 0, 'census blocking drained');
        assert.equal(review.issueCounts.important, 1, 'census important incremented');
        assert.equal(review.inlineComments[0].severity, 'IMPORTANT', 'severity field demoted');
        assert.equal(review.recommendation, 'APPROVE', 'no cited blocking remains → APPROVE');
        assert.equal(result.rewrites.length, 0, 'inline body was rewritten in place');
        assert.ok(review.inlineComments[0].body.indexOf('\u26A0') !== -1, 'posted body carries the non-blocking marker');
        assert.ok(result.notes.length > 0, 'downgrade is observable in the notes');
    });

    test('comment-file references are read, rewritten to file, and never posted verbatim', function () {
        var files = { 'outputs/pr_review_comments/f1.md': '🚨 BLOCKING: the Java policy requires contains-based matching.' };
        var review = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 1, important: 0, suggestions: 0 },
            inlineComments: [
                { path: 'src/env.js', line: 10, comment: 'outputs/pr_review_comments/f1.md' }
            ]
        };
        var result = rsc.sanitizeReviewData(review, function (p) { return files[p] || ''; });
        assert.equal(result.downgrades, 1);
        assert.equal(result.rewrites.length, 1, 'file rewrite planned');
        assert.equal(result.rewrites[0].path, 'outputs/pr_review_comments/f1.md');
        assert.ok(result.rewrites[0].content.indexOf('\u26A0') !== -1, 'rewritten file content demoted');
        assert.equal(review.recommendation, 'APPROVE');
        assert.equal(files['outputs/pr_review_comments/f1.md'].indexOf('\uD83D\uDEA8'), 0,
            'source file untouched (caller applies rewrites)');
    });

    test('a cited blocking finding keeps REQUEST_CHANGES (AC4)', function () {
        var review = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 1, important: 0, suggestions: 0 },
            inlineComments: [
                { path: 'src/env.js', line: 40, severity: 'BLOCKING',
                  body: '🚨 BLOCKING: the spec requires these exact exemptions (Policy.java:61-66) — deviation here.' }
            ]
        };
        var result = rsc.sanitizeReviewData(review, null);
        assert.equal(result.downgrades, 0);
        assert.equal(review.issueCounts.blocking, 1, 'census unchanged');
        assert.equal(review.recommendation, 'REQUEST_CHANGES', 'verdict stands');
        assert.equal(review.inlineComments[0].body.indexOf('\uD83D\uDEA8'), 0, 'body untouched');
    });

    test('mixed findings: only the uncited spec claim is downgraded, blocking stays', function () {
        var review = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 2, important: 0, suggestions: 0 },
            inlineComments: [
                { path: 'src/a.js', line: 1, severity: 'BLOCKING',
                  body: '🚨 BLOCKING: the spec says X is forbidden here.' },
                { path: 'src/b.js', line: 2, severity: 'BLOCKING',
                  body: '🚨 BLOCKING: SQL injection via raw interpolation.' }
            ]
        };
        var result = rsc.sanitizeReviewData(review, null);
        assert.equal(result.downgrades, 1);
        assert.equal(review.issueCounts.blocking, 1, 'one real blocker remains');
        assert.equal(review.issueCounts.important, 1);
        assert.equal(review.recommendation, 'REQUEST_CHANGES', 'still changes-requested');
        assert.equal(review.inlineComments[1].body.indexOf('\uD83D\uDEA8'), 0, 'real blocker untouched');
    });

    test('a real blocker with an incidental spec mention keeps REQUEST_CHANGES (no verdict collapse)', function () {
        var review = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 1, important: 0, suggestions: 0 },
            inlineComments: [
                { path: 'src/db.js', line: 7, severity: 'BLOCKING',
                  body: '🚨 BLOCKING: SQL injection via raw string interpolation — user input reaches ' +
                        'the DB unescaped. (Also, the spec says prepared statements are required.)' }
            ]
        };
        var result = rsc.sanitizeReviewData(review, null);
        assert.equal(result.downgrades, 0, 'incidental spec mention is not the core claim');
        assert.equal(review.issueCounts.blocking, 1, 'census unchanged');
        assert.equal(review.recommendation, 'REQUEST_CHANGES', 'verdict stands — a real defect is outstanding');
        assert.equal(review.inlineComments[0].body.indexOf('\uD83D\uDEA8'), 0, 'body untouched');
    });

    test('two inline entries referencing the same comment file demote it once (one census move, one rewrite)', function () {
        var files = { 'outputs/pr_review_comments/dup.md': '🚨 BLOCKING: the spec says X is forbidden.' };
        var review = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 2, important: 0, suggestions: 0 },
            inlineComments: [
                { path: 'src/a.js', line: 1, comment: 'outputs/pr_review_comments/dup.md' },
                { path: 'src/a.js', line: 9, comment: 'outputs/pr_review_comments/dup.md' }
            ]
        };
        var result = rsc.sanitizeReviewData(review, function (p) { return files[p] || ''; });
        assert.equal(result.downgrades, 2, 'both findings demoted');
        assert.equal(result.rewrites.length, 1, 'one physical comment file → one rewrite');
        assert.equal(result.census, 1, 'one census move for one physical comment');
        assert.equal(review.issueCounts.blocking, 1, 'blocking decremented once');
        assert.equal(review.issueCounts.important, 1, 'important incremented once');
        assert.equal(review.inlineComments[0].severity, 'IMPORTANT');
        assert.equal(review.inlineComments[1].severity, 'IMPORTANT');
        assert.equal(review.recommendation, 'REQUEST_CHANGES', 'second entry keeps blocking force in census');
    });

    test('a comment-file body with an incidental spec mention is not demoted', function () {
        var files = {
            'outputs/pr_review_comments/sec.md':
                '🚨 BLOCKING: SQL injection via raw interpolation. (Also, the spec says prepared statements are required.)'
        };
        var review = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 1, important: 0, suggestions: 0 },
            inlineComments: [
                { path: 'src/db.js', line: 7, comment: 'outputs/pr_review_comments/sec.md' }
            ]
        };
        var result = rsc.sanitizeReviewData(review, function (p) { return files[p] || ''; });
        assert.equal(result.downgrades, 0);
        assert.equal(result.rewrites.length, 0, 'file untouched');
        assert.equal(review.recommendation, 'REQUEST_CHANGES');
    });

    test('APPROVE and clean reviews pass through untouched', function () {
        var review = {
            recommendation: 'APPROVE',
            issueCounts: { blocking: 0, important: 1, suggestions: 2 },
            inlineComments: [
                { path: 'src/a.js', line: 1, severity: 'IMPORTANT', body: '⚠ IMPORTANT: extract a helper.' }
            ]
        };
        var result = rsc.sanitizeReviewData(review, null);
        assert.equal(result.downgrades, 0);
        assert.equal(review.recommendation, 'APPROVE');
    });

    test('null reviewData is a no-op', function () {
        var result = rsc.sanitizeReviewData(null, null);
        assert.equal(result.downgrades, 0);
        assert.deepEqual(result.rewrites, []);
    });

    test('entries with an empty body or no body/comment are tolerated (no crash, no downgrade)', function () {
        var review = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 1, important: 0, suggestions: 0 },
            inlineComments: [
                { path: 'src/a.js', line: 1, severity: 'BLOCKING', body: '' },
                { path: 'src/b.js', line: 2, severity: 'BLOCKING' }
            ]
        };
        var result = rsc.sanitizeReviewData(review, function () { return '🚨 BLOCKING: the spec says X.'; });
        assert.equal(result.downgrades, 0, 'no body to inspect — nothing demoted');
        assert.equal(review.issueCounts.blocking, 1, 'census untouched');
        assert.equal(review.recommendation, 'REQUEST_CHANGES', 'verdict untouched');
    });

    test('issueCounts missing is tolerated and created on downgrade', function () {
        var review = {
            recommendation: 'REQUEST_CHANGES',
            inlineComments: [
                { path: 'src/a.js', line: 1, severity: 'BLOCKING', body: 'the spec says X is forbidden.' }
            ]
        };
        rsc.sanitizeReviewData(review, null);
        assert.equal(review.issueCounts.blocking, 0);
        assert.equal(review.issueCounts.important, 1);
        assert.equal(review.recommendation, 'APPROVE');
    });
});
