/**
 * test_formalReviewCard.js — gh-1510: the compact formal-review verdict card
 * (js/common/formalReviewCard.js). Pure module: no collaborators, loaded
 * directly.
 *
 * Contract under test:
 * - the card is the branch-protection signal: verdict headline + thread
 *   census + a pointer to the full review — NEVER the general text;
 * - the pointer is honest: the comment's URL when the provider returned one,
 *   an above-comment pointer only when the comment actually posted, and NO
 *   pointer when nothing was posted (the legacy reject stub claimed
 *   "See PR comments" even when nothing existed);
 * - census tiers normalize missing/unknown to 0;
 * - the reject verdict keeps BLOCK distinct from REQUEST_CHANGES;
 * - the own-PR warn names both identities and never hedges with "?".
 */
var card = loadModule('js/common/formalReviewCard.js');

suite('formalReviewCard', function() {
    test('formalApproveBody: verdict headline + census + URL pointer', function() {
        var body = card.formalApproveBody(
            { blocking: 0, important: 0, suggestions: 1, digest: 1 },
            { posted: true, url: 'https://example.com/pull/42#issuecomment-1' });
        assert.equal(body,
            '## Automated Code Review — APPROVE\n' +
            'blocking 0 · important 0 · suggestions 1 · digest 1\n' +
            'Full review: https://example.com/pull/42#issuecomment-1');
    });

    test('card never duplicates the general text — body stays compact', function() {
        var generalText = '# Full review text\nSolid work, one suggestion open.';
        var body = card.formalApproveBody({ blocking: 0, important: 0, suggestions: 1, digest: 0 },
            { posted: true, url: 'https://example.com/c1' });
        assert.notContains(body, 'Full review text', 'the general text rides the comment only');
        assert.ok(body.length < 200, 'compact card, got: ' + body);
    });

    test('census normalizes missing/unknown tiers to 0', function() {
        var body = card.formalRejectBody('REQUEST_CHANGES', {}, { posted: false, url: null });
        assert.equal(body,
            '## Automated Code Review — REQUEST_CHANGES\n' +
            'blocking 0 · important 0 · suggestions 0 · digest 0');
    });

    test('formalRejectBody keeps BLOCK distinct from REQUEST_CHANGES', function() {
        var block = card.formalRejectBody('BLOCK', { blocking: 2 }, { posted: true, url: 'u1' });
        assert.contains(block, '## Automated Code Review — BLOCK');
        assert.contains(block, 'blocking 2 · important 0 · suggestions 0 · digest 0');
        var rc = card.formalRejectBody('REQUEST_CHANGES', { blocking: 1 }, { posted: true, url: 'u2' });
        assert.contains(rc, '## Automated Code Review — REQUEST_CHANGES');
        assert.notContains(rc, 'BLOCK\n');
    });

    test('pointer: posted without a URL degrades to the above-comment pointer', function() {
        var body = card.formalRejectBody('REQUEST_CHANGES', { blocking: 1 },
            { posted: true, url: null });
        assert.contains(body, 'Full review: see the review summary comment above');
        assert.notContains(body, 'Full review: http');
        assert.notContains(body, 'See PR comments for details');
    });

    test('pointer: nothing posted → bare card, no pointer, no "See PR comments" stub', function() {
        var approve = card.formalApproveBody({ suggestions: 1 }, { posted: false, url: null });
        assert.equal(approve,
            '## Automated Code Review — APPROVE\nblocking 0 · important 0 · suggestions 1 · digest 0');
        var reject = card.formalRejectBody('REQUEST_CHANGES', { blocking: 1 }, null);
        assert.equal(reject,
            '## Automated Code Review — REQUEST_CHANGES\nblocking 1 · important 0 · suggestions 0 · digest 0');
        assert.notContains(reject, 'See PR comments');
    });

    test('pointer: null generalPost (SCM addComment threw) is the bare card', function() {
        var body = card.formalApproveBody({}, null);
        assert.equal(body,
            '## Automated Code Review — APPROVE\nblocking 0 · important 0 · suggestions 0 · digest 0');
    });

    test('ownPrApprovalWarning: names both identities, no "?" hedge, one line', function() {
        var warn = card.ownPrApprovalWarning('ai-teammate', 'ai-teammate',
            'PR review submission failed (422): "Review Can not approve your own pull request"');
        assert.contains(warn, 'formalGithubReview: formal APPROVE rejected');
        assert.contains(warn, 'own PR');
        assert.contains(warn, '(PR author: ai-teammate, reviewer: ai-teammate)');
        assert.contains(warn, '422');
        assert.notContains(warn, 'restriction?', 'no hedged "?"');
    });

    test('ownPrApprovalWarning: missing identities degrade gracefully', function() {
        var warn = card.ownPrApprovalWarning(null, null, 'boom');
        assert.notContains(warn, 'PR author:');
        assert.notContains(warn, 'reviewer:');
        assert.contains(warn, 'Cause: boom');
        var warn2 = card.ownPrApprovalWarning('some-human', undefined, null);
        assert.contains(warn2, '(PR author: some-human)');
        assert.notContains(warn2, 'reviewer:');
        assert.contains(warn2, 'Cause: unknown');
    });
});
