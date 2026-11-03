/**
 * Unit tests for js/common/findingRegistry.js (gh-1332).
 *
 * The finding-identity registry: deduplicate review findings across rounds.
 * Identity = hash(file path + normalized behavior claim + severity class) —
 * never the line number (it drifts) and never the priority alone (too
 * coarse). Matching is two-stage (the machine proposes, the reviewer
 * disposes): the default is always NEW, merging happens only on
 * near-identical claims (invariant 1) and merges can only escalate severity
 * (invariant 2). Resolved identities (fixed/withdrawn) LEAVE the dedup
 * space; candidates are drawn only from OPEN items.
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

function loadRegistry() {
    return loadModule('js/common/findingRegistry.js',
        makeRequire({ './machineAuthor.js': machineAuthorReal(), './reviewVerdicts.js': reviewVerdictsReal() }));
}

function machineComment(body) {
    return { body: body, user: { login: 'ai-teammate' } };
}

function forgeComment(body) {
    return { body: body, user: { login: 'some-random-user' } };
}

// A finding in the reviewer's structured output shape.
function finding(file, claim, severity, line) {
    return { file: file, claim: claim, severity: severity || 'IMPORTANT', line: line || 10 };
}

suite('findingRegistry.normalizeClaim / contentWords', function() {

    test('normalization is case-, whitespace- and punctuation-insensitive', function() {
        var r = loadRegistry();
        var a = r.normalizeClaim('Nothing   validates a TOKEN!');
        var b = r.normalizeClaim('nothing validates a token');
        assert.equal(a, b, 'case/punctuation/whitespace variance collapses');
    });

    test('content words drop stopwords and short tokens, stem light suffixes', function() {
        var r = loadRegistry();
        var words = r.contentWords(r.normalizeClaim('Nothing validates the token here'));
        assert.deepEqual(words, ['validat', 'token'], 'stopwords (nothing/the/here) and stems (validates→validat)');
    });

    test('punctuation-stripped claims keep word boundaries (try/catch)', function() {
        var r = loadRegistry();
        var words = r.contentWords(r.normalizeClaim('you forgot to try/catch here'));
        assert.deepEqual(words, ['forgot', 'try', 'catch'], 'slash splits into two words');
    });
});

suite('findingRegistry.claimSimilarity', function() {

    test('identical normalized claims score 1', function() {
        var r = loadRegistry();
        assert.equal(r.claimSimilarity('nothing validates a token', 'NOTHING validates a token!'), 1);
    });

    test('disjoint claims score 0', function() {
        var r = loadRegistry();
        assert.equal(r.claimSimilarity('nothing validates a token', 'sessions never expire'), 0);
    });

    test('the canonical counter-example claims stay FAR apart (gh-1332)', function() {
        // Round 1 "you forgot to try/catch here" vs round 2 "token is not
        // always passed" — same line, same severity, completely different
        // claim and fix — must never look similar.
        var r = loadRegistry();
        var sim = r.claimSimilarity('you forgot to try/catch here', 'token is not always passed');
        assert.ok(sim < 0.3, 'similarity ' + sim + ' must stay below any proposal threshold');
    });

    test('a paraphrase of the same defect scores above the default (high) proposal bar', function() {
        var r = loadRegistry();
        var sim = r.claimSimilarity('nothing validates a token', 'the token is never validated');
        assert.ok(sim >= r.CANDIDATE_THRESHOLDS.high, 'similarity ' + sim + ' must propose a candidate at high');
        assert.ok(sim < r.AUTO_MERGE_SIMILARITY, 'a paraphrase is NOT near-identical — never auto-merge');
    });

    test('empty or wordless claims score 0 (never match)', function() {
        var r = loadRegistry();
        assert.equal(r.claimSimilarity('', 'nothing validates a token'), 0);
        assert.equal(r.claimSimilarity('???', 'nothing validates a token'), 0);
    });
});

suite('findingRegistry.severity classes (the identity third component)', function() {

    test('severityClassOf maps the review marker vocabulary, unknown falls to SUGGESTION', function() {
        var r = loadRegistry();
        assert.equal(r.severityClassOf('BLOCKING'), 'BLOCKING');
        assert.equal(r.severityClassOf('important'), 'IMPORTANT');
        assert.equal(r.severityClassOf('Suggestion'), 'SUGGESTION');
        assert.equal(r.severityClassOf('critical'), 'BLOCKING');
        assert.equal(r.severityClassOf(''), 'SUGGESTION');
        assert.equal(r.severityClassOf(null), 'SUGGESTION');
    });

    test('maxSeverity escalates and NEVER de-escalates (invariant 2)', function() {
        var r = loadRegistry();
        assert.equal(r.maxSeverity('IMPORTANT', 'BLOCKING'), 'BLOCKING');
        assert.equal(r.maxSeverity('BLOCKING', 'SUGGESTION'), 'BLOCKING');
        assert.equal(r.maxSeverity('SUGGESTION', 'IMPORTANT'), 'IMPORTANT');
    });
});

suite('findingRegistry.findingIdentity — hash(file + claim + severity class)', function() {

    test('is deterministic', function() {
        var r = loadRegistry();
        assert.equal(r.findingIdentity('src/auth.ts', 'nothing validates a token', 'BLOCKING'),
            r.findingIdentity('src/auth.ts', 'Nothing validates a token!', 'BLOCKING'),
            'normalized claim → same identity');
    });

    test('the canonical counter-example yields TWO distinct identities', function() {
        var r = loadRegistry();
        var id1 = r.findingIdentity('src/auth.ts', 'you forgot to try/catch here', 'IMPORTANT');
        var id2 = r.findingIdentity('src/auth.ts', 'token is not always passed', 'IMPORTANT');
        assert.notEqual(id1, id2, 'same line, same severity, different claim → two identities');
    });

    test('severity class and file path are part of the identity', function() {
        var r = loadRegistry();
        assert.notEqual(
            r.findingIdentity('src/auth.ts', 'nothing validates a token', 'BLOCKING'),
            r.findingIdentity('src/auth.ts', 'nothing validates a token', 'SUGGESTION'),
            'severity class partitions identities');
        assert.notEqual(
            r.findingIdentity('src/auth.ts', 'nothing validates a token', 'BLOCKING'),
            r.findingIdentity('src/other.ts', 'nothing validates a token', 'BLOCKING'),
            'file path partitions identities');
    });

    test('the line number is NOT part of the identity (it drifts)', function() {
        var r = loadRegistry();
        assert.equal(
            r.findingIdentity('src/auth.ts', 'nothing validates a token', 'BLOCKING'),
            r.findingIdentity('src/auth.ts', 'nothing validates a token', 'BLOCKING', 999),
            'line drift must not mint a new identity');
    });
});

suite('findingRegistry registry basics', function() {

    test('emptyRegistry has version, next=1, no items/rounds', function() {
        var r = loadRegistry();
        var reg = r.emptyRegistry();
        assert.equal(reg.v, 1);
        assert.equal(reg.next, 1);
        assert.deepEqual(reg.items, []);
        assert.deepEqual(reg.rounds, []);
        assert.deepEqual(reg.pending, []);
    });

    test('openItems draws from OPEN statuses only — resolved identities LEAVE the dedup space', function() {
        var r = loadRegistry();
        var reg = r.emptyRegistry();
        reg.items = [
            { n: 1, status: 'open' },
            { n: 2, status: 're-introduced' },
            { n: 3, status: 'fixed' },
            { n: 4, status: 'withdrawn' }
        ];
        assert.deepEqual(r.openItems(reg).map(function(i) { return i.n; }), [1, 2],
            'fixed/withdrawn are not dedup candidates');
    });

    test('nextRoundOf counts the recorded rounds', function() {
        var r = loadRegistry();
        var reg = r.emptyRegistry();
        assert.equal(r.nextRoundOf(reg), 1);
        reg.rounds.push({ round: 1 }, { round: 2 });
        assert.equal(r.nextRoundOf(reg), 3);
    });

    test('reviewRoundLabel mirrors the rework-round-N CI label', function() {
        var r = loadRegistry();
        assert.equal(r.reviewRoundLabel(3), 'review-round-3');
    });
});

// ── Acceptance replays (gh-1332) ─────────────────────────────────────────────

suite('applyRound raise flow — new identities', function() {

    test('round 1: every finding becomes its own identity', function() {
        var r = loadRegistry();
        var out = r.applyRound(r.emptyRegistry(), {
            at: '2026-11-03T10:00:00Z',
            findings: [
                finding('src/auth.ts', 'nothing validates a token', 'BLOCKING', 45),
                finding('src/api.ts', 'retry swallows the timeout error', 'IMPORTANT', 12)
            ]
        }, r.resolveIdentityPolicy({}, null));
        assert.equal(out.registry.items.length, 2, 'two new identities');
        assert.equal(out.newIdentities.length, 2);
        assert.equal(out.registry.items[0].status, 'open');
        assert.equal(out.registry.items[0].raisedRound, 1);
        assert.equal(out.registry.rounds[0].newIdentities, 2);
        assert.equal(out.registry.next, 3);
        // F-labels are stable and sequential
        assert.deepEqual(out.registry.items.map(function(i) { return i.n; }), [1, 2]);
    });

    test('a finding without a claim is skipped, not registered', function() {
        var r = loadRegistry();
        var out = r.applyRound(r.emptyRegistry(), {
            at: '2026-11-03T10:00:00Z',
            findings: [finding('src/auth.ts', '   ', 'BLOCKING', 1), finding('src/auth.ts', 'real claim', 'IMPORTANT', 2)]
        }, r.resolveIdentityPolicy({}, null));
        assert.equal(out.registry.items.length, 1);
        assert.equal(out.skippedFindings.length, 1);
    });
});

suite('AC1 — revert replay: re-raised open findings re-introduce, never duplicate', function() {

    function round1(r) {
        var findings = [];
        var claims = [
            ['src/auth.ts', 'nothing validates a token', 'BLOCKING'],
            ['src/auth.ts', 'password policy is not enforced', 'BLOCKING'],
            ['src/api.ts', 'retry swallows the timeout error', 'IMPORTANT'],
            ['src/api.ts', 'pagination ignores the page cursor', 'IMPORTANT'],
            ['src/ui.ts', 'form submit double-fires on enter', 'IMPORTANT'],
            ['src/ui.ts', 'error banner never clears', 'SUGGESTION'],
            ['src/db.ts', 'connection pool has no max limit', 'IMPORTANT']
        ];
        claims.forEach(function(c) { findings.push(finding(c[0], c[1], c[2], 10)); });
        return r.applyRound(r.emptyRegistry(), { at: '2026-11-03T10:00:00Z', findings: findings },
            r.resolveIdentityPolicy({}, null)).registry;
    }

    test('round 2 re-raises the same 7 claims → 0 new identities, F1–F7 re-introduced', function() {
        var r = loadRegistry();
        var reg1 = round1(r);
        // the fix was reverted — round 2 sees the same defects again
        var findings = [];
        reg1.items.forEach(function(i) {
            findings.push(finding(i.file, i.claim, i.severity, 77)); // lines drifted
        });
        var out = r.applyRound(reg1, { at: '2026-11-03T12:00:00Z', findings: findings },
            r.resolveIdentityPolicy({}, null));
        assert.equal(out.newIdentities.length, 0, 'zero duplicate threads');
        assert.equal(out.autoMerged.length, 7, 'all 7 auto-merged into their open identities');
        assert.equal(out.registry.items.length, 7, 'registry stays at 7 identities');
        out.registry.items.forEach(function(item) {
            assert.equal(item.status, 're-introduced', 'F' + item.n + ' marked re-introduced');
        });
        assert.equal(out.registry.rounds[1].newIdentities, 0, 'convergence census counts 0 new');
    });

    test('re-introduced items stay in the dedup space (still open for matching)', function() {
        var r = loadRegistry();
        var reg1 = round1(r);
        var out = r.applyRound(reg1, { at: '2026-11-03T12:00:00Z',
            findings: [finding(reg1.items[0].file, reg1.items[0].claim, reg1.items[0].severity, 5)] },
            r.resolveIdentityPolicy({}, null));
        assert.deepEqual(r.openItems(out.registry).map(function(i) { return i.n; }), [1, 2, 3, 4, 5, 6, 7]);
    });
});

suite('AC2/AC4 — resolved identities leave the dedup space', function() {

    test('counter-example: fixed finding; new distinct claim same line/severity → NEW identity', function() {
        var r = loadRegistry();
        var reg1 = r.applyRound(r.emptyRegistry(), {
            at: '2026-11-03T10:00:00Z',
            findings: [finding('src/auth.ts', 'you forgot to try/catch here', 'IMPORTANT', 45)]
        }, r.resolveIdentityPolicy({}, null)).registry;

        // the reviewer verified the fix (cites the fixing hunk)
        var reg2 = r.applyRound(reg1, {
            at: '2026-11-03T11:00:00Z',
            findings: [],
            dispositions: [{ n: 1, status: 'fixed', hunk: 'src/auth.ts:40-48 — try/catch added' }]
        }, r.resolveIdentityPolicy({}, null)).registry;
        assert.equal(reg2.items[0].status, 'fixed');
        assert.equal(reg2.items[0].fixHunk, 'src/auth.ts:40-48 — try/catch added');

        // a NEW distinct finding on the same line, same severity
        var out3 = r.applyRound(reg2, {
            at: '2026-11-03T12:00:00Z',
            findings: [finding('src/auth.ts', 'token is not always passed', 'IMPORTANT', 45)]
        }, r.resolveIdentityPolicy({}, null));
        assert.equal(out3.newIdentities.length, 1, 'new identity created — never swallowed by the fixed one');
        assert.equal(out3.autoMerged.length, 0);
        assert.equal(out3.registry.items.length, 2);
        assert.equal(out3.registry.items[1].n, 2);
    });

    test('even an IDENTICAL re-raise of a fixed finding creates a new identity (AC4)', function() {
        var r = loadRegistry();
        var reg1 = r.applyRound(r.emptyRegistry(), {
            at: '2026-11-03T10:00:00Z',
            findings: [finding('src/auth.ts', 'you forgot to try/catch here', 'IMPORTANT', 45)]
        }, r.resolveIdentityPolicy({}, null)).registry;
        var reg2 = r.applyRound(reg1, { at: '2026-11-03T11:00:00Z', findings: [],
            dispositions: [{ n: 1, status: 'fixed', hunk: 'hunk cited' }] },
            r.resolveIdentityPolicy({}, null)).registry;
        var out3 = r.applyRound(reg2, { at: '2026-11-03T12:00:00Z',
            findings: [finding('src/auth.ts', 'you forgot to try/catch here', 'IMPORTANT', 45)] },
            r.resolveIdentityPolicy({}, null));
        assert.equal(out3.newIdentities.length, 1, 'resolved identities are not dedup candidates');
    });
});

suite('AC3 — paraphrase replay: candidate proposed, reviewer confirms, merged', function() {

    test('paraphrase → candidate (pending), not merged, not a new identity', function() {
        var r = loadRegistry();
        var reg1 = r.applyRound(r.emptyRegistry(), {
            at: '2026-11-03T10:00:00Z',
            findings: [finding('src/auth.ts', 'nothing validates a token', 'BLOCKING', 45)]
        }, r.resolveIdentityPolicy({}, null)).registry;
        var out2 = r.applyRound(reg1, { at: '2026-11-03T11:00:00Z',
            findings: [finding('src/auth.ts', 'the token is never validated', 'BLOCKING', 51)] },
            r.resolveIdentityPolicy({}, null));
        assert.equal(out2.registry.pending.length, 1, 'proposed as a candidate');
        assert.equal(out2.registry.pending[0].proposedFor, 1);
        assert.equal(out2.newIdentities.length, 0, 'no premature identity');
        assert.equal(out2.autoMerged.length, 0, 'merging waits for the reviewer');
        assert.equal(out2.registry.items.length, 1, 'no duplicate thread');
    });

    test('reviewer confirms next round → merged into F1 (one thread)', function() {
        var r = loadRegistry();
        var reg1 = r.applyRound(r.emptyRegistry(), {
            at: '2026-11-03T10:00:00Z',
            findings: [finding('src/auth.ts', 'nothing validates a token', 'BLOCKING', 45)]
        }, r.resolveIdentityPolicy({}, null)).registry;
        var reg2 = r.applyRound(reg1, { at: '2026-11-03T11:00:00Z',
            findings: [finding('src/auth.ts', 'the token is never validated', 'BLOCKING', 51)] },
            r.resolveIdentityPolicy({}, null)).registry;
        var out3 = r.applyRound(reg2, { at: '2026-11-03T12:00:00Z', findings: [],
            confirmations: [{ proposedFor: 1, same: true }] },
            r.resolveIdentityPolicy({}, null));
        assert.equal(out3.confirmedMerges.length, 1);
        assert.equal(out3.registry.pending.length, 0, 'candidate consumed');
        assert.equal(out3.registry.items.length, 1, 'one thread, merged');
        assert.equal(out3.registry.items[0].history.length, 2, 'merge is recorded in history');
    });

    test('unconfirmed candidates are NEW (invariant 1) — promoted next round', function() {
        var r = loadRegistry();
        var reg1 = r.applyRound(r.emptyRegistry(), {
            at: '2026-11-03T10:00:00Z',
            findings: [finding('src/auth.ts', 'nothing validates a token', 'BLOCKING', 45)]
        }, r.resolveIdentityPolicy({}, null)).registry;
        var reg2 = r.applyRound(reg1, { at: '2026-11-03T11:00:00Z',
            findings: [finding('src/auth.ts', 'the token is never validated', 'BLOCKING', 51)] },
            r.resolveIdentityPolicy({}, null)).registry;
        var out3 = r.applyRound(reg2, { at: '2026-11-03T12:00:00Z', findings: [] },
            r.resolveIdentityPolicy({}, null));
        assert.equal(out3.promoted.length, 1, 'silence means new');
        assert.equal(out3.registry.items.length, 2, 'the candidate becomes its own identity');
        assert.equal(out3.registry.pending.length, 0);
    });

    test('reviewer declines the candidate ("new") → promoted to its own identity', function() {
        var r = loadRegistry();
        var reg1 = r.applyRound(r.emptyRegistry(), {
            at: '2026-11-03T10:00:00Z',
            findings: [finding('src/auth.ts', 'nothing validates a token', 'BLOCKING', 45)]
        }, r.resolveIdentityPolicy({}, null)).registry;
        var reg2 = r.applyRound(reg1, { at: '2026-11-03T11:00:00Z',
            findings: [finding('src/auth.ts', 'the token is never validated', 'BLOCKING', 51)] },
            r.resolveIdentityPolicy({}, null)).registry;
        var out3 = r.applyRound(reg2, { at: '2026-11-03T12:00:00Z', findings: [],
            confirmations: [{ proposedFor: 1, same: false }] },
            r.resolveIdentityPolicy({}, null));
        assert.equal(out3.promoted.length, 1);
        assert.equal(out3.registry.items.length, 2);
    });

    test('confirmation keys on the proposed item n (several candidates stay distinct)', function() {
        var r = loadRegistry();
        var reg1 = r.applyRound(r.emptyRegistry(), {
            at: '2026-11-03T10:00:00Z',
            findings: [
                finding('src/auth.ts', 'nothing validates a token', 'BLOCKING', 45),
                finding('src/api.ts', 'retry swallows the timeout error', 'IMPORTANT', 12)
            ]
        }, r.resolveIdentityPolicy({}, null)).registry;
        var reg2 = r.applyRound(reg1, { at: '2026-11-03T11:00:00Z', findings: [
                finding('src/auth.ts', 'the token is never validated', 'BLOCKING', 51),
                finding('src/api.ts', 'the retry swallows every timeout error code', 'IMPORTANT', 20)
            ] }, r.resolveIdentityPolicy({}, null)).registry;
        assert.equal(reg2.pending.length, 2, 'both candidates pending');
        var out3 = r.applyRound(reg2, { at: '2026-11-03T12:00:00Z', findings: [],
            confirmations: [{ proposedFor: 1, same: true }] },
            r.resolveIdentityPolicy({}, null));
        assert.equal(out3.confirmedMerges.length, 1, 'only F1 confirmed');
        assert.equal(out3.promoted.length, 1, 'F2 candidate stays unconfirmed → new');
        assert.equal(out3.registry.items.length, 3);
    });
});

suite('AC5 — severity escalation on merge (invariant 2)', function() {

    test('a BLOCKING claim confirmed into an IMPORTANT identity raises it to BLOCKING', function() {
        var r = loadRegistry();
        var reg1 = r.applyRound(r.emptyRegistry(), {
            at: '2026-11-03T10:00:00Z',
            findings: [finding('src/auth.ts', 'nothing validates a token', 'IMPORTANT', 45)]
        }, r.resolveIdentityPolicy({}, null)).registry;
        assert.equal(reg1.items[0].severity, 'IMPORTANT');
        // same claim re-raised at a HIGHER class: cross-class matching never
        // auto-merges — the machine proposes, the reviewer confirms
        var out2 = r.applyRound(reg1, { at: '2026-11-03T11:00:00Z',
            findings: [finding('src/auth.ts', 'nothing validates a token', 'BLOCKING', 45)] },
            r.resolveIdentityPolicy({}, null));
        assert.equal(out2.autoMerged.length, 0, 'cross-class never auto-merges');
        assert.equal(out2.candidates.length, 1, 'the machine proposes');
        var out3 = r.applyRound(out2.registry, { at: '2026-11-03T12:00:00Z', findings: [],
            confirmations: [{ proposedFor: 1, same: true }] }, r.resolveIdentityPolicy({}, null));
        assert.equal(out3.confirmedMerges.length, 1);
        assert.equal(out3.registry.items[0].severity, 'BLOCKING', 'identity escalated');
        assert.equal(out3.registry.items[0].history[1].action, 'severity-escalated',
            'escalation is recorded, never silent');
        assert.equal(out3.registry.rounds[2].newIdentities, 0, 'the census gates — no new identity');
    });

    test('a SUGGESTION claim confirmed into a BLOCKING identity keeps BLOCKING', function() {
        var r = loadRegistry();
        var reg1 = r.applyRound(r.emptyRegistry(), {
            at: '2026-11-03T10:00:00Z',
            findings: [finding('src/auth.ts', 'nothing validates a token', 'BLOCKING', 45)]
        }, r.resolveIdentityPolicy({}, null)).registry;
        var reg2 = r.applyRound(reg1, { at: '2026-11-03T11:00:00Z',
            findings: [finding('src/auth.ts', 'nothing validates a token', 'SUGGESTION', 45)] },
            r.resolveIdentityPolicy({}, null)).registry;
        assert.equal(reg2.pending.length, 1, 'cross-class goes through the reviewer');
        var out3 = r.applyRound(reg2, { at: '2026-11-03T12:00:00Z', findings: [],
            confirmations: [{ proposedFor: 1, same: true }] }, r.resolveIdentityPolicy({}, null));
        assert.equal(out3.registry.items[0].severity, 'BLOCKING', 'never de-escalate');
    });

    test('a near-identical claim at a DIFFERENT severity class is a candidate, never auto-merged', function() {
        var r = loadRegistry();
        var reg1 = r.applyRound(r.emptyRegistry(), {
            at: '2026-11-03T10:00:00Z',
            findings: [finding('src/auth.ts', 'nothing validates a token', 'BLOCKING', 45)]
        }, r.resolveIdentityPolicy({}, null)).registry;
        var out2 = r.applyRound(reg1, { at: '2026-11-03T11:00:00Z',
            findings: [finding('src/auth.ts', 'nothing validates a token', 'SUGGESTION', 45)] },
            r.resolveIdentityPolicy({}, null));
        assert.equal(out2.autoMerged.length, 0, 'severity class is part of stage-1 matching');
        assert.equal(out2.candidates.length, 1);
        assert.equal(out2.newIdentities.length, 0);
    });
});

suite('lifecycle dispositions — withdrawn requires a reason (invariant 3)', function() {

    function regWithOne(r) {
        return r.applyRound(r.emptyRegistry(), {
            at: '2026-11-03T10:00:00Z',
            findings: [finding('src/auth.ts', 'nothing validates a token', 'BLOCKING', 45)]
        }, r.resolveIdentityPolicy({}, null)).registry;
    }

    test('a withdrawal without a reason is REJECTED — the item stays open', function() {
        var r = loadRegistry();
        var out = r.applyRound(regWithOne(r), { at: '2026-11-03T11:00:00Z', findings: [],
            dispositions: [{ n: 1, status: 'withdrawn' }] }, r.resolveIdentityPolicy({}, null));
        assert.equal(out.rejectedWithdrawals.length, 1, 'the attempt is reported');
        assert.equal(out.registry.items[0].status, 'open', 'silently dropping a defect is not allowed');
    });

    test('a withdrawal with a reason applies', function() {
        var r = loadRegistry();
        var out = r.applyRound(regWithOne(r), { at: '2026-11-03T11:00:00Z', findings: [],
            dispositions: [{ n: 1, status: 'withdrawn', reason: 'validation exists at src/auth.ts:50 — claim was wrong' }] },
            r.resolveIdentityPolicy({}, null));
        assert.equal(out.registry.items[0].status, 'withdrawn');
        assert.equal(out.registry.items[0].withdrawReason, 'validation exists at src/auth.ts:50 — claim was wrong');
    });

    test('a disposition for an unknown n is reported and ignored', function() {
        var r = loadRegistry();
        var out = r.applyRound(regWithOne(r), { at: '2026-11-03T11:00:00Z', findings: [],
            dispositions: [{ n: 99, status: 'fixed', hunk: 'nowhere' }] }, r.resolveIdentityPolicy({}, null));
        assert.equal(out.unknownDispositions.length, 1);
        assert.equal(out.registry.items[0].status, 'open');
    });

    test('the reviewer can mark an open item re-introduced', function() {
        var r = loadRegistry();
        var out = r.applyRound(regWithOne(r), { at: '2026-11-03T11:00:00Z', findings: [],
            dispositions: [{ n: 1, status: 're-introduced' }] }, r.resolveIdentityPolicy({}, null));
        assert.equal(out.registry.items[0].status, 're-introduced');
    });

    test('an empty round stamps nothing new — but a pending resolution round does', function() {
        var r = loadRegistry();
        var policy = r.resolveIdentityPolicy({}, null);
        assert.equal(r.applyRound(regWithOne(r), { at: '2026-11-03T11:00:00Z' }, policy), null,
            'no findings, no dispositions, no candidates → no-op');
    });
});

suite('two-stage matching scope and policy knobs', function() {

    test('same-file scope (default): an identical claim in ANOTHER file is NOT matched', function() {
        var r = loadRegistry();
        var reg1 = r.applyRound(r.emptyRegistry(), {
            at: '2026-11-03T10:00:00Z',
            findings: [finding('src/auth.ts', 'nothing validates a token', 'BLOCKING', 45)]
        }, r.resolveIdentityPolicy({}, null)).registry;
        var out2 = r.applyRound(reg1, { at: '2026-11-03T11:00:00Z',
            findings: [finding('src/api.ts', 'nothing validates a token', 'BLOCKING', 9)] },
            r.resolveIdentityPolicy({}, null));
        assert.equal(out2.autoMerged.length, 0, 'cross-file never auto-merges');
        assert.equal(out2.newIdentities.length, 1, 'same-file scope does not even propose');
    });

    test('aggressive diff scope: a cross-file near-identical claim is a CANDIDATE, never an auto-merge (AC7)', function() {
        var r = loadRegistry();
        var aggressive = r.resolveIdentityPolicy(
            { reviewPolicy: { identity: { claimSimilarityThreshold: 'aggressive', candidateScope: 'diff', candidatesPerFinding: 3 } } }, null);
        var reg1 = r.applyRound(r.emptyRegistry(), {
            at: '2026-11-03T10:00:00Z',
            findings: [finding('src/auth.ts', 'nothing validates a token', 'BLOCKING', 45)]
        }, aggressive).registry;
        var out2 = r.applyRound(reg1, { at: '2026-11-03T11:00:00Z',
            findings: [finding('src/api.ts', 'nothing validates a token', 'BLOCKING', 9)] }, aggressive);
        assert.equal(out2.autoMerged.length, 0, 'auto-merge never crosses files (invariant 1)');
        assert.equal(out2.candidates.length, 1, 'the wider scope proposes a confirmation instead');
        assert.equal(out2.registry.pending.length, 1);
    });

    test('aggressive thresholds propose MORE candidates than the default high — and auto-merge stays near-identical (AC7)', function() {
        var r = loadRegistry();
        var claims1 = [
            finding('src/a.ts', 'nothing validates a token', 'BLOCKING', 1),
            finding('src/b.ts', 'retry swallows the timeout error', 'IMPORTANT', 2)
        ];
        var policyHigh = r.resolveIdentityPolicy({}, null);
        var policyLow = r.resolveIdentityPolicy(
            { reviewPolicy: { identity: { claimSimilarityThreshold: 'aggressive' } } }, null);
        var reg1 = r.applyRound(r.emptyRegistry(), { at: '2026-11-03T10:00:00Z', findings: claims1 }, policyHigh).registry;
        var reg1b = r.applyRound(r.emptyRegistry(), { at: '2026-11-03T10:00:00Z', findings: claims1 }, policyLow).registry;
        // partial-overlap rephrases: the token pair scores high (0.83), the retry pair mid (0.62)
        var claims2 = [
            finding('src/a.ts', 'the token is never validated', 'BLOCKING', 1),
            finding('src/b.ts', 'the retry loop eats timeout errors', 'IMPORTANT', 2)
        ];
        var outHigh = r.applyRound(reg1, { at: '2026-11-03T12:00:00Z', findings: claims2 }, policyHigh);
        var outLow = r.applyRound(reg1b, { at: '2026-11-03T12:00:00Z', findings: claims2 }, policyLow);
        assert.equal(outHigh.candidates.length, 1, 'the high bar proposes only the strong paraphrase');
        assert.equal(outLow.candidates.length, 2, 'the aggressive bar proposes both');
        assert.equal(outLow.autoMerged.length, 0, 'aggressive config still never auto-merges paraphrases');
        assert.equal(outHigh.autoMerged.length, 0);
    });

    test('candidatesPerFinding ranks more than one proposal', function() {
        var r = loadRegistry();
        var policy = r.resolveIdentityPolicy(
            { reviewPolicy: { identity: { candidateScope: 'diff', candidatesPerFinding: 2 } } }, null);
        var reg1 = r.applyRound(r.emptyRegistry(), { at: '2026-11-03T10:00:00Z', findings: [
                finding('src/a.ts', 'nothing validates a token', 'BLOCKING', 1),
                finding('src/b.ts', 'the token is never validated', 'BLOCKING', 2)
            ] }, policy).registry;
        var out2 = r.applyRound(reg1, { at: '2026-11-03T11:00:00Z', findings: [
                finding('src/c.ts', 'tokens are never validated here', 'BLOCKING', 3)
            ] }, policy);
        assert.equal(out2.registry.pending.length, 2, 'both ranked candidates proposed');
        assert.ok(out2.registry.pending[0].similarity >= out2.registry.pending[1].similarity,
            'ranked by similarity');
        assert.equal(out2.autoMerged.length, 0, 'cross-file never auto-merges even at similarity 1');
    });

    test('a SUGGESTION-class re-raise of a BLOCKING claim is a candidate — never auto-merged', function() {
        var r = loadRegistry();
        var reg1 = r.applyRound(r.emptyRegistry(), {
            at: '2026-11-03T10:00:00Z',
            findings: [finding('src/auth.ts', 'nothing validates a token', 'BLOCKING', 45)]
        }, r.resolveIdentityPolicy({}, null)).registry;
        var out2 = r.applyRound(reg1, { at: '2026-11-03T11:00:00Z',
            findings: [finding('src/auth.ts', 'nothing validates a token', 'SUGGESTION', 45)] },
            r.resolveIdentityPolicy({}, null));
        assert.equal(out2.autoMerged.length, 0, 'severity class gates stage-1 matching');
        assert.equal(out2.candidates.length, 1, 'the reviewer decides');
        assert.equal(out2.newIdentities.length, 0, 'no premature duplicate thread');
    });

    test('the invariant knobs are NOT configurable (config-shaped gaming path)', function() {
        var r = loadRegistry();
        var policy = r.resolveIdentityPolicy(
            { reviewPolicy: { identity: { autoMerge: 'partial', severityOnMerge: 'de-escalate', candidateScope: 'diff' } } }, null);
        assert.equal(policy.autoMergeSimilarity, r.AUTO_MERGE_SIMILARITY,
            'auto-merge stays near-identical only');
        assert.equal(policy.severityOnMerge, 'escalate', 'severity-on-merge stays escalate');
    });
});

suite('policy resolution', function() {

    test('defaults are conservative: high threshold, same-file scope, 1 candidate', function() {
        var r = loadRegistry();
        var p = r.resolveIdentityPolicy({}, null);
        assert.equal(p.candidateThreshold, r.CANDIDATE_THRESHOLDS.high);
        assert.equal(p.candidateScope, 'same-file');
        assert.equal(p.candidatesPerFinding, 1);
    });

    test('customParams.reviewPolicy.identity wins over config, named values map, numbers clamp', function() {
        var r = loadRegistry();
        var p = r.resolveIdentityPolicy(
            { reviewPolicy: { identity: { claimSimilarityThreshold: 0.5, candidateScope: 'diff', candidatesPerFinding: 4 } } },
            { reviewPolicy: { identity: { claimSimilarityThreshold: 'aggressive' } } });
        assert.equal(p.candidateThreshold, 0.5, 'customParams wins');
        assert.equal(p.candidateScope, 'diff');
        assert.equal(p.candidatesPerFinding, 4);
        assert.equal(r.resolveIdentityPolicy({}, { reviewPolicy: { identity: { claimSimilarityThreshold: 'aggressive' } } }).candidateThreshold,
            r.CANDIDATE_THRESHOLDS.aggressive);
        // a numeric threshold may not reach the auto-merge bar (candidates only)
        assert.ok(r.resolveIdentityPolicy({}, { reviewPolicy: { identity: { claimSimilarityThreshold: 0.99 } } }).candidateThreshold <= r.AUTO_MERGE_SIMILARITY);
        assert.ok(r.resolveIdentityPolicy({}, { reviewPolicy: { identity: { claimSimilarityThreshold: 0.01 } } }).candidateThreshold >= 0.3);
    });

    test('garbage knobs fall back to defaults', function() {
        var r = loadRegistry();
        var p = r.resolveIdentityPolicy(
            { reviewPolicy: { identity: { claimSimilarityThreshold: 'yolo', candidatesPerFinding: -2 } } }, null);
        assert.equal(p.candidateThreshold, r.CANDIDATE_THRESHOLDS.high);
        assert.equal(p.candidatesPerFinding, 1);
    });
});

suite('registry marker — build/parse on PR comments (dmtools: marker family)', function() {

    test('buildRegistryComment round-trips through parse', function() {
        var r = loadRegistry();
        var policy = r.resolveIdentityPolicy({}, null);
        var reg = r.applyRound(r.emptyRegistry(), { at: '2026-11-03T10:00:00Z',
            findings: [finding('src/auth.ts', 'nothing validates a token', 'BLOCKING', 45)] }, policy).registry;
        var body = r.buildRegistryComment(reg);
        assert.ok(body.indexOf('<!-- dmtools:finding-registry ') === 0, 'house marker prefix');
        var parsed = r.parseRegistryComments([machineComment(body)]);
        assert.equal(parsed.length, 1);
        assert.equal(parsed[0].registry.items.length, 1);
        assert.equal(parsed[0].registry.items[0].claim, 'nothing validates a token');
    });

    test('the marker carries a visible human note and no raw machine jargon', function() {
        var r = loadRegistry();
        var body = r.buildRegistryComment(r.emptyRegistry());
        assert.ok(body.indexOf('\uD83E\uDD16') !== -1, 'the robot note is provider-independent');
    });

    test('machine-author allowlist gates the marker (the format is public)', function() {
        var r = loadRegistry();
        var body = r.buildRegistryComment(r.emptyRegistry());
        var allow = { authorLogins: ['ai-teammate'] };
        assert.equal(r.parseRegistryComments([machineComment(body)], allow).length, 1);
        assert.equal(r.parseRegistryComments([forgeComment(body)], allow).length, 0,
            'a forged registry from a non-machine identity is invisible');
    });

    test('latestRegistry picks the NEWEST registry comment (by embedded timestamp)', function() {
        var r = loadRegistry();
        var reg1 = r.buildRegistryComment(Object.assign(r.emptyRegistry(), { next: 1, at: '2026-11-03T10:00:00Z' }));
        var reg2 = r.buildRegistryComment(Object.assign(r.emptyRegistry(), { next: 2, at: '2026-11-03T11:00:00Z' }));
        // posted newest-last, parse order-independent
        var comments = [machineComment(reg1), machineComment(reg2)];
        assert.equal(r.latestRegistry(comments).registry.next, 2, 'newest wins');
        var reordered = [machineComment(reg2), machineComment(reg1)];
        assert.equal(r.latestRegistry(reordered).registry.next, 2, 'order comes from the payload');
    });

    test('broken payloads and non-object JSON are skipped, comments without markers ignored', function() {
        var r = loadRegistry();
        assert.equal(r.latestRegistry([{ body: 'plain human prose' }]), null);
        assert.equal(r.latestRegistry([{ body: '<!-- dmtools:finding-registry {broken -->' }]), null);
        assert.equal(r.latestRegistry([]), null);
        assert.equal(r.latestRegistry(null), null);
    });

    test('buildRegistryComment returns null for a registry without an items array', function() {
        var r = loadRegistry();
        assert.equal(r.buildRegistryComment(null), null);
        assert.equal(r.buildRegistryComment({}), null);
        assert.equal(r.buildRegistryComment({ items: 'nope' }), null);
    });
});

suite('AC6 — escalation packet: per-round new-identity counts, withdrawal reasons visible', function() {

    test('the packet carries the per-round new-identity series', function() {
        var r = loadRegistry();
        var policy = r.resolveIdentityPolicy({}, null);
        var reg1 = r.applyRound(r.emptyRegistry(), { at: '2026-11-03T10:00:00Z', findings: [
                finding('src/a.ts', 'claim one about tokens', 'BLOCKING', 1),
                finding('src/b.ts', 'claim two about retries', 'IMPORTANT', 2)
            ] }, policy).registry;
        var reg2 = r.applyRound(reg1, { at: '2026-11-03T11:00:00Z', findings: [
                finding('src/c.ts', 'claim three about caches', 'SUGGESTION', 3)
            ] }, policy).registry;
        var packet = r.buildEscalationPacket(reg2);
        assert.deepEqual(packet.rounds.map(function(x) { return x.newIdentities; }), [2, 1],
            'the owner sees 2 new → 1 new and can tell churn from instability');
        assert.deepEqual(packet.rounds.map(function(x) { return x.round; }), [1, 2]);
    });

    test('a BLOCKING withdrawal without a fixing hunk is surfaced WITH its reason (invariant 3)', function() {
        var r = loadRegistry();
        var policy = r.resolveIdentityPolicy({}, null);
        var reg = r.applyRound(r.emptyRegistry(), { at: '2026-11-03T10:00:00Z', findings: [
                finding('src/a.ts', 'claim one about tokens', 'BLOCKING', 1),
                finding('src/b.ts', 'claim two about retries', 'IMPORTANT', 2)
            ] }, policy).registry;
        var reg2 = r.applyRound(reg, { at: '2026-11-03T11:00:00Z', findings: [], dispositions: [
                { n: 1, status: 'withdrawn', reason: 'owner says this is by design' },
                { n: 2, status: 'withdrawn', reason: 'already handled elsewhere' }
            ] }, policy).registry;
        var packet = r.buildEscalationPacket(reg2);
        assert.equal(packet.blockingWithdrawals.length, 1, 'only the BLOCKING withdrawal is flagged');
        assert.equal(packet.blockingWithdrawals[0].n, 1);
        assert.equal(packet.blockingWithdrawals[0].reason, 'owner says this is by design');
    });

    test('buildEscalationPacketComment renders the packet; null when there is nothing to say', function() {
        var r = loadRegistry();
        var policy = r.resolveIdentityPolicy({}, null);
        var reg = r.applyRound(r.emptyRegistry(), { at: '2026-11-03T10:00:00Z', findings: [
                finding('src/a.ts', 'claim one about tokens', 'BLOCKING', 1)
            ] }, policy).registry;
        var body = r.buildEscalationPacketComment(reg);
        assert.ok(body.indexOf('1') !== -1, 'the new-identity count series is in the comment');
        assert.equal(r.buildEscalationPacketComment(r.emptyRegistry()), null,
            'an empty registry contributes nothing');
    });
});

suite('input-prep injection text (next round context)', function() {

    test('buildFindingsInjection carries the reviewer protocol and the open items', function() {
        var r = loadRegistry();
        var policy = r.resolveIdentityPolicy({}, null);
        var reg = r.applyRound(r.emptyRegistry(), { at: '2026-11-03T10:00:00Z', findings: [
                finding('src/auth.ts', 'nothing validates a token', 'BLOCKING', 45),
                finding('src/api.ts', 'retry swallows the timeout error', 'IMPORTANT', 12)
            ] }, policy).registry;
        var reg2 = r.applyRound(reg, { at: '2026-11-03T11:00:00Z', findings: [
                finding('src/auth.ts', 'the token is never validated', 'BLOCKING', 51)
            ] }, policy).registry;
        var md = r.buildFindingsInjection(reg2);
        assert.ok(md.indexOf('F1') !== -1, 'items carry their stable F-labels');
        assert.ok(md.indexOf('verify fixed') !== -1, 'the fixed/withdraw/re-introduced protocol');
        assert.ok(md.indexOf('withdraw') !== -1);
        assert.ok(md.indexOf('re-introduced') !== -1);
        assert.ok(md.indexOf('new evidence') !== -1, 'new claims need new evidence');
        assert.ok(md.indexOf('possibly same as F1') !== -1, 'the pending candidate is presented for confirmation');
        assert.ok(md.indexOf('src/auth.ts') !== -1);
        assert.ok(md.indexOf('findingReview') !== -1, 'the structured output contract is named');
    });

    test('no open items and no pending → null (nothing to inject)', function() {
        var r = loadRegistry();
        var reg = r.applyRound(r.emptyRegistry(), { at: '2026-11-03T10:00:00Z', findings: [
                finding('src/auth.ts', 'nothing validates a token', 'BLOCKING', 45)
            ] }, r.resolveIdentityPolicy({}, null)).registry;
        reg.items[0].status = 'fixed';
        assert.equal(r.buildFindingsInjection(reg), null);
        assert.equal(r.buildFindingsInjection(null), null);
    });
});
