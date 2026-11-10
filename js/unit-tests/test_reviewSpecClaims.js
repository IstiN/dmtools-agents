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
 *     collapses REQUEST_CHANGES to APPROVE when no cited blocking remains;
 *   - gh-1334: an uncited claim is verified against the ticket text before
 *     demotion — a verifiably-present requirement keeps BLOCKING force and
 *     gets the citation auto-appended; every demotion carries provenance.
 *
 * Uses: test(), suite(), assert — pure module, no dmtools globals.
 */
/* global suite, test, assert, loadModule, makeRequire */

function loadSpecClaims() {
    return loadModule('js/common/reviewSpecClaims.js', makeRequire({
        './findingRegistry.js': loadModule('js/common/findingRegistry.js', makeRequire({
            './machineAuthor.js': machineAuthorReal(),
            './reviewVerdicts.js': reviewVerdictsReal()
        }))
    }), {});
}

suite('reviewSpecClaims — detection (gh-1053)', function () {
    var rsc = loadSpecClaims();

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
    var rsc = loadSpecClaims();

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
        assert.equal(down.split('dmtools:demoted-from-BLOCKING')[0].indexOf('BLOCKING'), -1,
            'BLOCKING word demoted (outside the machine provenance marker)');
        assert.ok(down.indexOf('IMPORTANT') !== -1, 'IMPORTANT word present');
        assert.ok(down.indexOf('unverified external-spec claim') !== -1, 'downgrade note references the rule');
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
    var rsc = loadSpecClaims();

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

// ── gh-1334: verify the claim against the ticket before demoting ────────────

suite('reviewSpecClaims — matchClaimInTicket (gh-1334)', function () {
    var rsc = loadSpecClaims();

    // ticket.md fixture — line 3 carries the 401 requirement (the ticket's
    // own repro shape: an uncited TRUE claim that today gets demoted).
    var TICKET_MD = [
        '# Login service requirements',
        '',
        'Invalid login attempts must return HTTP 401 with a structured error body.',
        'Session tokens expire after 30 minutes of inactivity.',
        'The legacy proxy answers 503 while the upstream redeploys.',
        ''
    ].join('\n');

    test('AC1: an uncited TRUE claim matches the ticket line that carries the requirement', function () {
        var claim = 'According to the ticket, invalid login must return 401.';
        var m = rsc.matchClaimInTicket(claim, TICKET_MD);
        assert.equal(m.outcome, 'yes', 'requirement verifiably present');
        assert.equal(m.line, 3, 'matched the 401 requirement line');
        assert.equal(m.citation, 'ticket.md:3', 'citation points at the matched location');
    });

    test('AC4: paraphrase matched via the status-code anchor + requirement-word overlap', function () {
        var claim = 'unauthorized access must be rejected with 401';
        var m = rsc.matchClaimInTicket(claim, TICKET_MD);
        assert.equal(m.outcome, 'yes', 'anchor-based paraphrase recognition');
        assert.equal(m.citation, 'ticket.md:3');
    });

    test('AC2: a claim the ticket does not make is confidently absent', function () {
        var claim = 'According to the ticket, audit logs must be retained for 7 years.';
        var m = rsc.matchClaimInTicket(claim, TICKET_MD);
        assert.equal(m.outcome, 'no', 'no anchor and no requirement-word overlap anywhere');
        assert.equal(m.line, null);
        assert.equal(m.citation, null);
    });

    test('anchor present in the ticket but not attached to the requirement → inconclusive', function () {
        var ticket = [
            '# Billing API',
            '',
            'The health probe answers HTTP 401 when unauthenticated.',
            'Invoices are generated nightly at 02:00.',
            ''
        ].join('\n');
        var claim = 'According to the ticket, login failures are reported with status 401 and an audit event.';
        var m = rsc.matchClaimInTicket(claim, ticket);
        assert.equal(m.outcome, 'inconclusive',
            '401 exists in the ticket but never with this requirement — not decidable mechanically');
    });

    test('paraphrase outside anchor coverage → inconclusive (never auto-escalate)', function () {
        var claim = 'the spec says retries are expected';
        var m = rsc.matchClaimInTicket(claim, TICKET_MD);
        assert.equal(m.outcome, 'inconclusive', 'thin claim, no anchors — cannot decide');
    });

    test('unavailable ticket text → inconclusive (never demote harder than today)', function () {
        var claim = 'According to the ticket, invalid login must return 401.';
        assert.equal(rsc.matchClaimInTicket(claim, null).outcome, 'inconclusive', 'null text');
        assert.equal(rsc.matchClaimInTicket(claim, '').outcome, 'inconclusive', 'empty text');
        assert.equal(rsc.matchClaimInTicket(claim, '   \n  ').outcome, 'inconclusive', 'blank text');
    });

    test('the citation names the file the text came from', function () {
        var m = rsc.matchClaimInTicket('According to the ticket, invalid login must return 401.', TICKET_MD,
            { ticketFile: 'request.md' });
        assert.equal(m.citation, 'request.md:3');
    });

    test('empty claim → inconclusive without crashing', function () {
        assert.equal(rsc.matchClaimInTicket('', TICKET_MD).outcome, 'inconclusive');
        assert.equal(rsc.matchClaimInTicket(null, TICKET_MD).outcome, 'inconclusive');
    });
});

// gh-1334 best-line selection — the mechanical match scans every ticket line
// and must pick ONE citation. Selection contract (pinned before the CRAP
// refactor split the scan into helpers — the helpers must keep these exact
// outcomes): the strongest anchor wins over a stronger word overlap; among
// equal anchor counts the higher requirement-word overlap wins; a weaker
// later line never displaces the incumbent.
suite('reviewSpecClaims — matchClaimInTicket best-line selection (gh-1334)', function () {
    var rsc = loadSpecClaims();

    test('the anchored line wins over a later, stronger pure-overlap line', function () {
        var ticket = [
            '# Requirements',
            '',
            'Invalid login attempts must return HTTP 401 with a structured error body.',
            'Invalid login must return a structured error body too.',
            ''
        ].join('\n');
        var m = rsc.matchClaimInTicket('invalid login must return a structured error body', ticket);
        assert.equal(m.outcome, 'yes');
        assert.equal(m.line, 3, 'anchor 401 outranks the later near-identical anchor-free line');
        assert.equal(m.citation, 'ticket.md:3');
    });

    test('equal anchor counts → the higher requirement-word overlap wins (later line)', function () {
        var ticket = [
            '# Requirements',
            '',
            'Unauthorized requests get HTTP 401 back from the service.',
            'Unauthorized login requests must receive HTTP 401 responses.',
            ''
        ].join('\n');
        var m = rsc.matchClaimInTicket('unauthorized login requests must receive http 401', ticket);
        assert.equal(m.outcome, 'yes');
        assert.equal(m.line, 4, 'line 4 mirrors the claim more closely at equal anchor count');
        assert.equal(m.citation, 'ticket.md:4');
    });

    test('equal anchor counts, later line with lower overlap → the incumbent stays', function () {
        var ticket = [
            '# Requirements',
            '',
            'Invalid login attempts must return HTTP 401 with a structured error body.',
            'Invalid login must return 401 and a structured error body immediately.',
            ''
        ].join('\n');
        var m = rsc.matchClaimInTicket('invalid login must return 401 with a structured error body', ticket);
        assert.equal(m.outcome, 'yes');
        assert.equal(m.line, 3, 'the later same-anchor line overlaps less — first match kept');
        assert.equal(m.citation, 'ticket.md:3');
    });

    test('near-identical requirement text matches without any anchor in the ticket', function () {
        var ticket = [
            '# Requirements',
            '',
            'Invalid login attempts must return a structured error body.',
            ''
        ].join('\n');
        var m = rsc.matchClaimInTicket('invalid login must return a structured error body', ticket);
        assert.equal(m.outcome, 'yes', 'word-overlap match needs no status-code anchor');
        assert.equal(m.line, 3);
        assert.equal(m.citation, 'ticket.md:3');
    });

    test('anchor in the claim but nowhere in the ticket → confidently absent', function () {
        var ticket = [
            '# Requirements',
            '',
            'Every login failure is answered politely.',
            ''
        ].join('\n');
        var m = rsc.matchClaimInTicket('According to the ticket, login failures return code 401.', ticket);
        assert.equal(m.outcome, 'no', 'the 401 anchor is absent from every line — decidable');
    });

    test('anchor in a thin claim, ticket without it → confidently absent', function () {
        var ticket = [
            '# Requirements',
            '',
            'Every login failure is answered politely.',
            ''
        ].join('\n');
        var m = rsc.matchClaimInTicket('the spec says 401 required', ticket);
        assert.equal(m.outcome, 'no', 'too thin for word overlap, but the anchor decides absence');
    });
});

suite('reviewSpecClaims — demotion provenance marker (gh-1334)', function () {
    var rsc = loadSpecClaims();

    test('marker payload carries round (when known), reason and claimMatchedTicket in that order', function () {
        assert.equal(rsc.demotionMarker({ round: 2, claimMatchedTicket: 'no' }),
            '<!-- dmtools:demoted-from-BLOCKING {"round":2,"reason":"missing-citation","claimMatchedTicket":"no"} -->');
    });

    test('round is omitted when unknown; claimMatchedTicket defaults to inconclusive', function () {
        assert.equal(rsc.demotionMarker(undefined),
            '<!-- dmtools:demoted-from-BLOCKING {"reason":"missing-citation","claimMatchedTicket":"inconclusive"} -->');
        assert.equal(rsc.demotionMarker({}),
            '<!-- dmtools:demoted-from-BLOCKING {"reason":"missing-citation","claimMatchedTicket":"inconclusive"} -->');
    });

    test('downgradeBody appends the machine marker after the confirm note', function () {
        var down = rsc.downgradeBody('🚨 BLOCKING: the spec says X is forbidden.', { claimMatchedTicket: 'no' });
        assert.ok(down.indexOf('dmtools:demoted-from-BLOCKING {"reason":"missing-citation","claimMatchedTicket":"no"}') !== -1,
            'marker present with claimMatchedTicket no');
        assert.ok(/confirm/i.test(down), 'confirm note still present');
        assert.equal(down.indexOf('\uD83D\uDEA8'), -1, '🚨 still removed');
        assert.ok(down.indexOf('dmtools:demoted-from-BLOCKING') > down.indexOf('regains blocking force'),
            'marker comes after the note');
    });

    test('default downgradeBody (no provenance) stamps the inconclusive marker', function () {
        var down = rsc.downgradeBody('🚨 BLOCKING: the spec says X.');
        assert.ok(down.indexOf('"claimMatchedTicket":"inconclusive"') !== -1);
    });
});

suite('reviewSpecClaims — classifyFindingSeverity with ticket verification (gh-1334)', function () {
    var rsc = loadSpecClaims();

    var TICKET_MD = [
        '# Login service requirements',
        '',
        'Invalid login attempts must return HTTP 401 with a structured error body.',
        ''
    ].join('\n');

    var TRUE_CLAIM = '🚨 BLOCKING: According to the ticket, invalid login must return 401.';
    var FALSE_CLAIM = '🚨 BLOCKING: According to the ticket, audit logs must be retained for 7 years.';

    test('AC1: requirement present in the ticket → keeps BLOCKING with the verified citation', function () {
        var result = rsc.classifyFindingSeverity(TRUE_CLAIM, 'BLOCKING', { ticketText: TICKET_MD });
        assert.equal(result.severity, 'blocking', 'no demotion for a verifiably true claim');
        assert.ok(result.blocking);
        assert.ok(!result.downgraded);
        assert.ok(result.claimVerified, 'verification outcome exposed');
        assert.equal(result.citation, 'ticket.md:3');
    });

    test('AC2: claim absent from the ticket → demoted with claimMatchedTicket no', function () {
        var result = rsc.classifyFindingSeverity(FALSE_CLAIM, 'BLOCKING', { ticketText: TICKET_MD });
        assert.equal(result.severity, 'important');
        assert.ok(!result.blocking);
        assert.ok(result.downgraded);
        assert.equal(result.claimMatchedTicket, 'no');
    });

    test('no ticket text → demoted as today with claimMatchedTicket inconclusive', function () {
        var result = rsc.classifyFindingSeverity(TRUE_CLAIM, 'BLOCKING', {});
        assert.ok(result.downgraded);
        assert.equal(result.claimMatchedTicket, 'inconclusive');
    });

    test('AC3: a cited claim never consults the ticket and stays BLOCKING', function () {
        var cited = '🚨 BLOCKING: the ticket requires a 401 (ticket.md:99-nothing-like-this) — the PR omits it.';
        var result = rsc.classifyFindingSeverity(cited, 'BLOCKING', { ticketText: '' });
        assert.equal(result.severity, 'blocking');
        assert.ok(!result.downgraded);
        assert.ok(!result.claimVerified, 'no verification ran — citation already present');
    });
});

suite('reviewSpecClaims — sanitizeReviewData with ticket verification (gh-1334)', function () {
    var rsc = loadSpecClaims();

    var TICKET_MD = [
        '# Login service requirements',
        '',
        'Invalid login attempts must return HTTP 401 with a structured error body.',
        ''
    ].join('\n');

    test('AC1/AC6: verified claim keeps BLOCKING, census untouched, citation auto-appended', function () {
        var review = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 1, important: 0, suggestions: 0 },
            inlineComments: [
                { path: 'src/auth.js', line: 12, severity: 'BLOCKING',
                  body: '🚨 BLOCKING: According to the ticket, invalid login must return 401.' }
            ]
        };
        var result = rsc.sanitizeReviewData(review, null, { ticketText: TICKET_MD });
        assert.equal(result.downgrades, 0, 'no demotion for a verifiably true claim');
        assert.equal(result.census, 0, 'keep-BLOCKING leaves the census untouched');
        assert.equal(review.inlineComments[0].severity, 'BLOCKING', 'severity field unchanged');
        assert.ok(review.inlineComments[0].body.indexOf('ticket.md:3') !== -1, 'citation auto-appended');
        assert.equal(review.issueCounts.blocking, 1, 'blocking census intact');
        assert.equal(review.recommendation, 'REQUEST_CHANGES', 'verdict stands');
        assert.equal(result.citations.length, 1, 'citation recorded');
        assert.equal(result.citations[0].citation, 'ticket.md:3');
        assert.equal(result.citations[0].path, 'src/auth.js');
        assert.deepEqual(result.demotions, [], 'nothing demoted');
    });

    test('AC2: claim absent from ticket → demoted, provenance stamped on body, entry and result', function () {
        var review = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 1, important: 0, suggestions: 0 },
            inlineComments: [
                { path: 'src/env.js', line: 1, severity: 'BLOCKING',
                  body: '🚨 BLOCKING: According to the ticket, audit logs must be retained for 7 years.' }
            ]
        };
        var result = rsc.sanitizeReviewData(review, null, { ticketText: TICKET_MD });
        assert.equal(result.downgrades, 1);
        assert.equal(review.issueCounts.blocking, 0, 'demotion still drains the census');
        assert.equal(review.recommendation, 'APPROVE');
        assert.ok(review.inlineComments[0].body.indexOf(
            'dmtools:demoted-from-BLOCKING {"reason":"missing-citation","claimMatchedTicket":"no"}') !== -1,
            'machine-parsed marker on the posted thread');
        assert.deepEqual(review.inlineComments[0].demotion,
            { reason: 'missing-citation', claimMatchedTicket: 'no' },
            'registry callers read the provenance off the entry');
        assert.deepEqual(result.demotions, [
            { path: 'src/env.js', line: 1, claimMatchedTicket: 'no', reason: 'missing-citation' }
        ]);
    });

    test('no ticket text → demotion stamps claimMatchedTicket inconclusive', function () {
        var review = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 1, important: 0, suggestions: 0 },
            inlineComments: [
                { path: 'src/a.js', line: 3, severity: 'BLOCKING', body: 'the spec says X is forbidden.' }
            ]
        };
        var result = rsc.sanitizeReviewData(review, null);
        assert.equal(result.downgrades, 1);
        assert.equal(result.demotions[0].claimMatchedTicket, 'inconclusive');
        assert.ok(review.inlineComments[0].body.indexOf('"claimMatchedTicket":"inconclusive"') !== -1);
    });

    test('AC6 both directions: verified + demoted findings in one review', function () {
        var review = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 2, important: 0, suggestions: 0 },
            inlineComments: [
                { path: 'src/auth.js', line: 12, severity: 'BLOCKING',
                  body: '🚨 BLOCKING: According to the ticket, invalid login must return 401.' },
                { path: 'src/env.js', line: 4, severity: 'BLOCKING',
                  body: '🚨 BLOCKING: According to the ticket, audit logs must be retained for 7 years.' }
            ]
        };
        var result = rsc.sanitizeReviewData(review, null, { ticketText: TICKET_MD });
        assert.equal(result.downgrades, 1, 'only the absent claim demoted');
        assert.equal(review.issueCounts.blocking, 1, 'verified finding holds the census');
        assert.equal(review.issueCounts.important, 1);
        assert.equal(review.recommendation, 'REQUEST_CHANGES', 'a real (verified) blocker remains');
        assert.equal(result.demotions.length, 1);
        assert.equal(result.citations.length, 1);
    });

    test('comment-file reference with a verified claim → rewrite carries the citation, census untouched', function () {
        var files = {
            'outputs/pr_review_comments/v.md':
                '🚨 BLOCKING: According to the ticket, invalid login must return 401.'
        };
        var review = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 1, important: 0, suggestions: 0 },
            inlineComments: [
                { path: 'src/auth.js', line: 9, comment: 'outputs/pr_review_comments/v.md' }
            ]
        };
        var result = rsc.sanitizeReviewData(review, function (p) { return files[p] || ''; },
            { ticketText: TICKET_MD });
        assert.equal(result.downgrades, 0);
        assert.equal(result.census, 0);
        assert.equal(result.rewrites.length, 1, 'file rewrite planned');
        assert.ok(result.rewrites[0].content.indexOf('ticket.md:3') !== -1, 'citation in the rewritten file');
        assert.ok(result.rewrites[0].content.indexOf('\uD83D\uDEA8') === 0, 'blocking marker preserved');
        assert.equal(review.recommendation, 'REQUEST_CHANGES');
        assert.equal(result.citations.length, 1);
    });

    test('opts.round flows into the demotion marker payload', function () {
        var review = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 1, important: 0, suggestions: 0 },
            inlineComments: [
                { path: 'src/a.js', line: 1, severity: 'BLOCKING', body: 'the spec says X is forbidden.' }
            ]
        };
        rsc.sanitizeReviewData(review, null, { round: 3 });
        assert.ok(review.inlineComments[0].body.indexOf(
            'dmtools:demoted-from-BLOCKING {"round":3,"reason":"missing-citation"') !== -1);
    });
});

// gh-1334 rework — the overlap coefficient divides by min(claimWords,
// lineWords), so a 1–2-word ticket line (markdown heading, bullet) whose few
// content words all appear in the claim scores 1.0 ≥ TICKET_WORD_MATCH_MIN_
// OVERLAP and claimLineMatch confirmed it WITHOUT any anchor: a claim the
// ticket never make was kept BLOCKING with a fabricated "requirement
// verified" citation pointing at a heading. A line must itself be
// requirement-shaped (≥ TICKET_MIN_CLAIM_WORDS content words) to confirm a
// claim on words alone; anchored matches keep the low bar — the anchor is
// claim-specific evidence, not shared prose.
suite('reviewSpecClaims — short ticket lines never confirm anchor-free claim (gh-1334 rework)', function () {
    var rsc = loadSpecClaims();

    var HEADING_TICKET = [
        '# Payment service',
        '## Error handling',
        'Retries use exponential backoff with a 5 second cap.',
        ''
    ].join('\n');

    test('a 2-word heading never confirms anchor-free claim — confidently absent', function () {
        var claim = 'According to the ticket, error handling must redact card numbers from every log line.';
        var m = rsc.matchClaimInTicket(claim, HEADING_TICKET);
        assert.equal(m.outcome, 'no', 'the 2-word heading is not requirement-shaped — decidable');
        assert.equal(m.line, null, 'no citation line minted');
        assert.equal(m.citation, null);
    });

    test('a 2-word bullet never confirms anchor-free claim', function () {
        var ticket = [
            '# Checkout hardening',
            '',
            '- idempotency keys',
            ''
        ].join('\n');
        var m = rsc.matchClaimInTicket(
            'According to the ticket, idempotency keys must rotate daily and be stored hashed.', ticket);
        assert.equal(m.outcome, 'no', 'a bare bullet confirms nothing on words alone');
        assert.equal(m.line, null);
        assert.equal(m.citation, null);
    });

    test('sanitizeReviewData demotes the false claim instead of minting a heading citation', function () {
        var review = {
            recommendation: 'REQUEST_CHANGES',
            issueCounts: { blocking: 1, important: 0, suggestions: 0 },
            inlineComments: [
                { path: 'src/payment.js', line: 42, severity: 'BLOCKING',
                  body: '\uD83D\uDEA8 BLOCKING: According to the ticket, error handling must redact ' +
                        'card numbers from every log line.' }
            ]
        };
        var result = rsc.sanitizeReviewData(review, null, { ticketText: HEADING_TICKET });
        assert.equal(result.downgrades, 1, 'the false claim is demoted');
        assert.equal(result.citations.length, 0, 'no citation minted from a 2-word heading');
        assert.equal(result.demotions[0].claimMatchedTicket, 'no');
        assert.equal(review.inlineComments[0].severity, 'IMPORTANT');
        assert.ok(review.inlineComments[0].body.indexOf('requirement verified') === -1,
            'no "requirement verified" note appended');
        assert.ok(review.inlineComments[0].body.indexOf('dmtools:demoted-from-BLOCKING') !== -1,
            'the demotion provenance marker is stamped');
        assert.equal(review.issueCounts.blocking, 0, 'the census moves — this BLOCKING was not real');
        assert.equal(review.issueCounts.important, 1);
        assert.equal(review.recommendation, 'APPROVE', 'no cited BLOCKING remains after the demotion');
    });

    test('requirement-shaped lines still confirm anchor-free claims (the floor does not over-demote)', function () {
        var ticket = [
            '# Requirements',
            '',
            'Invalid login attempts must return a structured error body.',
            ''
        ].join('\n');
        var m = rsc.matchClaimInTicket('invalid login must return a structured error body', ticket);
        assert.equal(m.outcome, 'yes', 'a 7-content-word requirement line is requirement-shaped');
        assert.equal(m.citation, 'ticket.md:3');
    });
});

// gh-1334 rework — the demoted verdict's machine-parsed contract: the demotion
// marker payload and the gh-1332 registry read claimMatchedTicket. 'yes' is
// unreachable on the demoted branch — a verifiable match maps to the
// keep-BLOCKING branch (claimVerified + citation) — so a demotion can only
// ever carry 'no' (confidently absent) or 'inconclusive' (thin claim, anchor
// detached, no ticket text). Pinning the contract so future consumers do not
// implement against an impossible state.
suite('reviewSpecClaims — demoted verdicts never carry claimMatchedTicket yes (gh-1334 rework)', function () {
    var rsc = loadSpecClaims();

    var ABSENT_TICKET = [
        '# Login service requirements',
        '',
        'Invalid login attempts must return HTTP 401 with a structured error body.',
        ''
    ].join('\n');

    var DETACHED_ANCHOR_TICKET = [
        '# Billing API',
        '',
        'The health probe answers HTTP 401 when unauthenticated.',
        ''
    ].join('\n');

    test('every demotion carries no|inconclusive — never yes (the mismatch space)', function () {
        var cases = [
            { want: 'no', ticket: ABSENT_TICKET,
              body: '\uD83D\uDEA8 BLOCKING: According to the ticket, audit logs must be retained for 7 years.' },
            { want: 'inconclusive', ticket: DETACHED_ANCHOR_TICKET,
              body: '\uD83D\uDEA8 BLOCKING: According to the ticket, login failures are reported ' +
                    'with status 401 and an audit event.' },
            { want: 'inconclusive', ticket: null,
              body: '\uD83D\uDEA8 BLOCKING: According to the ticket, invalid login must return 401.' }
        ];
        for (var i = 0; i < cases.length; i++) {
            var verdict = rsc.classifyFindingSeverity(cases[i].body, 'BLOCKING', { ticketText: cases[i].ticket });
            assert.equal(verdict.downgraded, true, 'case ' + i + ': demoted');
            assert.equal(verdict.claimMatchedTicket, cases[i].want, 'case ' + i + ': the mismatch outcome');
            assert.notEqual(verdict.claimMatchedTicket, 'yes', 'case ' + i + ': a demotion never claims yes');
            assert.equal(verdict.claimVerified, undefined, 'case ' + i + ': no verification on a demotion');
        }
    });

    test('yes lives only on the keep-BLOCKING branch (claimVerified + citation, no demotion stamp)', function () {
        var verdict = rsc.classifyFindingSeverity(
            '\uD83D\uDEA8 BLOCKING: According to the ticket, invalid login must return 401.',
            'BLOCKING', { ticketText: ABSENT_TICKET });
        assert.equal(verdict.claimVerified, true);
        assert.equal(verdict.citation, 'ticket.md:3');
        assert.equal(verdict.downgraded, false);
        assert.equal(verdict.claimMatchedTicket, undefined, 'no mismatch outcome on the verified branch');
    });
});
