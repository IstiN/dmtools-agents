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

    test('a confirmation naming a MISSING proposedFor promotes (never merges, never crashes)', function() {
        var r = loadRegistry();
        var reg1 = r.applyRound(r.emptyRegistry(), {
            at: '2026-11-03T10:00:00Z',
            findings: [finding('src/auth.ts', 'nothing validates a token', 'BLOCKING', 45)]
        }, r.resolveIdentityPolicy({}, null)).registry;
        var reg2 = r.applyRound(reg1, { at: '2026-11-03T11:00:00Z',
            findings: [finding('src/auth.ts', 'the token is never validated', 'BLOCKING', 51)] },
            r.resolveIdentityPolicy({}, null)).registry;
        var out3 = r.applyRound(reg2, { at: '2026-11-03T12:00:00Z', findings: [],
            confirmations: [{ proposedFor: 99, same: true }] },
            r.resolveIdentityPolicy({}, null));
        assert.equal(out3.promoted.length, 1, 'a resolved/missing merge target cannot absorb the finding');
        assert.equal(out3.confirmedMerges.length, 0);
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

// ── gh-1343 rework: the marker payload is sanitization-safe ──────────────────
//
// The registry rides inside an HTML comment (`<!-- dmtools:finding-registry
// {json} -->`) whose parser cuts at the FIRST ` -->`. Reviewer-supplied free
// text (withdrawReason, fixHunk) travels in that payload, and mermaid-style
// arrows ("not a defect: A --> B is handled upstream") are pervasive in this
// repo's comment style. A raw `-->` inside a string field visually terminates
// the comment on GitHub AND makes the next round's parse fail — the round's
// registry becomes unreadable and latestRegistry silently falls back to the
// previous round, losing the reviewer's verdict.
//
// Contract: every string field entering the payload is marker-safe (the built
// body contains exactly ONE ` -->` — the real suffix), the registry still
// parses back, and the reason text stays readable for display.
suite('marker-safe payload — a --> in reviewer text cannot corrupt the registry marker', function() {

    function regWithWithdrawn(r, disposition) {
        var policy = r.resolveIdentityPolicy({}, null);
        var reg1 = r.applyRound(r.emptyRegistry(), { at: '2026-11-03T10:00:00Z',
            findings: [finding('src/auth.ts', 'nothing validates a token', 'BLOCKING', 45)] }, policy).registry;
        return r.applyRound(reg1, { at: '2026-11-03T11:00:00Z', findings: [],
            dispositions: [disposition] }, policy);
    }

    test('a withdrawReason containing --> still round-trips through the marker', function() {
        var r = loadRegistry();
        var out = regWithWithdrawn(r,
            { n: 1, status: 'withdrawn', reason: 'not a defect: A --> B is handled upstream' });
        assert.equal(out.registry.items[0].status, 'withdrawn');
        assert.contains(out.registry.items[0].withdrawReason, '-->',
            'the in-memory reason keeps the reviewer text verbatim');
        var body = r.buildRegistryComment(out.registry);
        assert.ok(body.indexOf('<!-- dmtools:finding-registry ') === 0, 'house marker prefix');
        assert.equal(body.split(' -->').length - 1, 1,
            'exactly one marker suffix — the injected --> was sanitized away');
        var parsed = r.latestRegistry([machineComment(body)]);
        assert.ok(parsed, 'the round-2 registry still parses (state cannot silently revert)');
        assert.equal(parsed.registry.items[0].status, 'withdrawn', 'the withdrawal survives');
        assert.ok(parsed.registry.items[0].withdrawReason.indexOf('A') !== -1 &&
            parsed.registry.items[0].withdrawReason.indexOf('B') !== -1,
            'the reason text is preserved for display');
        assert.ok(parsed.registry.items[0].withdrawReason.indexOf('-->') === -1,
            'no raw --> inside the parsed payload');
    });

    test('a fixHunk containing --> and <!-- cannot terminate the marker early', function() {
        var r = loadRegistry();
        var out = regWithWithdrawn(r,
            { n: 1, status: 'fixed', hunk: 'src/auth.ts:40-55 — added validateToken() <!-- guard --> upstream' });
        assert.equal(out.registry.items[0].status, 'fixed');
        var body = r.buildRegistryComment(out.registry);
        assert.equal(body.split(' -->').length - 1, 1, 'exactly one marker suffix');
        assert.equal(body.split('<!--').length - 1, 1, 'exactly one marker prefix');
        var parsed = r.latestRegistry([machineComment(body)]);
        assert.ok(parsed, 'the registry still parses');
        assert.equal(parsed.registry.items[0].status, 'fixed', 'the fixing hunk survives');
        assert.ok(parsed.registry.items[0].fixHunk.indexOf('validateToken()') !== -1,
            'the hunk text is preserved for display');
    });

    test('the escalation census renders the withdrawal reason without raw marker sequences', function() {
        var r = loadRegistry();
        var out = regWithWithdrawn(r,
            { n: 1, status: 'withdrawn', reason: 'not a defect: A --> B is handled upstream' });
        var text = r.buildEscalationPacketComment(out.registry);
        assert.ok(text.indexOf('\uD83D\uDEA8') !== -1, 'the BLOCKING withdrawal is listed');
        assert.equal(text.split('-->').length - 1, 0, 'no raw --> in the visible census');
        assert.ok(text.indexOf('A') !== -1 && text.indexOf('B') !== -1, 'the reason stays readable');
    });
});

suite('normalizePrCommentList — the one comment-shape ladder behind both wiring sites', function() {

    test('a JSON string payload parses to the comment array', function() {
        var r = loadRegistry();
        var raw = JSON.stringify([{ body: 'a' }, { body: 'b' }]);
        assert.deepEqual(r.normalizePrCommentList(raw), [{ body: 'a' }, { body: 'b' }]);
    });

    test('an already-parsed array passes through unchanged', function() {
        var r = loadRegistry();
        var raw = [{ body: 'a' }];
        assert.deepEqual(r.normalizePrCommentList(raw), [{ body: 'a' }]);
    });

    test('{comments: [...]} and {items: [...]} envelopes unwrap', function() {
        var r = loadRegistry();
        assert.deepEqual(r.normalizePrCommentList({ comments: [{ body: 'c' }] }), [{ body: 'c' }]);
        assert.deepEqual(r.normalizePrCommentList({ items: [{ body: 'i' }] }), [{ body: 'i' }]);
    });

    test('a shapeless object, null and undefined yield []', function() {
        var r = loadRegistry();
        assert.deepEqual(r.normalizePrCommentList({}), []);
        assert.deepEqual(r.normalizePrCommentList(null), []);
        assert.deepEqual(r.normalizePrCommentList(undefined), []);
    });

    test('a broken JSON string throws — the error policy stays at the call site', function() {
        var r = loadRegistry();
        assert.throws(function() { r.normalizePrCommentList('{broken'); });
    });
});

suite('stemWord suffix-rule boundaries (contentWords)', function() {

    function wordsOf(r, text) {
        return r.contentWords(r.normalizeClaim(text));
    }

    test('ies → y only above the length guard (studies → study, ties falls through)', function() {
        var r = loadRegistry();
        assert.deepEqual(wordsOf(r, 'studies show'), ['study', 'show'], 'ies rule applies');
        assert.deepEqual(wordsOf(r, 'ties bind'), ['ti', 'bind'],
            'ties (length 4) misses the ies guard and drops the es suffix first');
    });

    test('es → stripped above the length guard (boxes → box, yes stays)', function() {
        var r = loadRegistry();
        assert.deepEqual(wordsOf(r, 'boxes open'), ['box', 'open'], 'es rule applies');
        assert.deepEqual(wordsOf(r, 'yes please'), ['yes', 'please'], 'length 3 misses the es guard');
    });

    test('s → stripped above the length guard (tokens → token, is stays)', function() {
        var r = loadRegistry();
        assert.deepEqual(wordsOf(r, 'tokens expire'), ['token', 'expire'], 's rule applies');
        assert.deepEqual(wordsOf(r, 'is done'), ['done'], 'length 2 misses the s guard (and is a stopword)');
    });

    test('ing → stripped above the length guard (missing → miss, king stays)', function() {
        var r = loadRegistry();
        assert.deepEqual(wordsOf(r, 'missing validation'), ['miss', 'validation'], 'ing rule applies; tion has no rule');
        assert.deepEqual(wordsOf(r, 'king reused'), ['king', 'reus'],
            'length 4 misses the ing guard; ed rule applies to reused');
    });

    test('ed → stripped above the length guard (validated → validat, red stays)', function() {
        var r = loadRegistry();
        assert.deepEqual(wordsOf(r, 'validated tokens'), ['validat', 'token'], 'ed rule applies');
        assert.deepEqual(wordsOf(r, 'red flag'), ['red', 'flag'], 'length 3 misses the ed guard');
    });

    test('a word matching no rule passes through unchanged', function() {
        var r = loadRegistry();
        assert.deepEqual(wordsOf(r, 'retry swallows'), ['retry', 'swallow'],
            'retry has no applicable suffix rule');
    });
});

// ── gh-1334: demotion provenance in the registry ────────────────────────────
//
// The spec-claim guard (gh-1053/gh-1334) demotes uncited BLOCKING claims and
// stamps each demotion with provenance {reason, claimMatchedTicket}. The
// registry records it so a later round re-elevates the demoted finding WITH
// a citation (confirm → severity escalation) instead of raising the same
// defect as news, and the escalation packet shows the owner the demotion
// history alongside the per-round new-identity counts.

suite('gh-1334 — demotion provenance recorded on registry identities', function() {

    function demotedFinding(file, claim, severity, line, matched) {
        var f = finding(file, claim, severity, line);
        f.demotion = { reason: 'missing-citation', claimMatchedTicket: matched || 'no' };
        return f;
    }

    test('a finding carrying demotion provenance registers it on the identity', function() {
        var r = loadRegistry();
        var out = r.applyRound(r.emptyRegistry(), { at: '2026-11-03T10:00:00Z', findings: [
            demotedFinding('src/auth.ts', 'login must return 401', 'IMPORTANT', 12, 'no')
        ] }, r.resolveIdentityPolicy({}, null));
        var item = out.registry.items[0];
        assert.deepEqual(item.demotion, { reason: 'missing-citation', claimMatchedTicket: 'no' });
    });

    test('a finding without demotion leaves the identity clean', function() {
        var r = loadRegistry();
        var out = r.applyRound(r.emptyRegistry(), { at: '2026-11-03T10:00:00Z', findings: [
            finding('src/auth.ts', 'nothing validates a token', 'BLOCKING', 45)
        ] }, r.resolveIdentityPolicy({}, null));
        assert.equal(out.registry.items[0].demotion, null);
    });

    test('a demotion merged into an existing identity records it + history', function() {
        var r = loadRegistry();
        var policy = r.resolveIdentityPolicy({}, null);
        var reg1 = r.applyRound(r.emptyRegistry(), { at: '2026-11-03T10:00:00Z', findings: [
            finding('src/auth.ts', 'login must return 401', 'IMPORTANT', 12)
        ] }, policy).registry;
        var out2 = r.applyRound(reg1, { at: '2026-11-03T11:00:00Z', findings: [
            demotedFinding('src/auth.ts', 'login must return 401', 'IMPORTANT', 12, 'inconclusive')
        ] }, policy);
        assert.equal(out2.autoMerged.length, 1, 'near-identical claim auto-merges');
        var item = out2.registry.items[0];
        assert.deepEqual(item.demotion, { reason: 'missing-citation', claimMatchedTicket: 'inconclusive' });
        assert.ok(item.history.some(function(h) { return h.action === 'demotion-recorded'; }),
            'the merge history shows the demotion');
    });

    test('AC5: a cited re-raise of a demoted finding escalates it back to BLOCKING', function() {
        var r = loadRegistry();
        var policy = r.resolveIdentityPolicy({}, null);
        var reg1 = r.applyRound(r.emptyRegistry(), { at: '2026-11-03T10:00:00Z', findings: [
            demotedFinding('src/auth.ts', 'login must return 401', 'IMPORTANT', 12, 'no')
        ] }, policy).registry;
        // Round 2: the same defect re-raised WITH a citation (BLOCKING class —
        // cross-class matches can only become candidates, never auto-merge).
        var reg2 = r.applyRound(reg1, { at: '2026-11-03T11:00:00Z', findings: [
            finding('src/auth.ts', 'login must return 401 (ticket.md:3)', 'BLOCKING', 12)
        ] }, policy);
        assert.equal(reg2.candidates.length, 1, 'proposed for confirmation, not raised as new');
        var reg3 = r.applyRound(reg2.registry, { at: '2026-11-03T12:00:00Z', findings: [],
            confirmations: [{ proposedFor: 1, same: true }] }, policy);
        var item = reg3.registry.items[0];
        assert.equal(item.status, 're-introduced',
            'the later-round confirmed merge is the re-introduced transition (still open)');
        assert.equal(item.severity, 'BLOCKING', 'invariant 2: the confirmed merge escalates');
        assert.deepEqual(item.demotion, { reason: 'missing-citation', claimMatchedTicket: 'no' },
            'demotion provenance survives the re-elevation');
        assert.ok(item.history.some(function(h) { return h.action === 'severity-escalated'; }));
    });
});

suite('gh-1334 — demotions in the escalation packet and the injection', function() {

    function registryWithDemotion() {
        var r = loadRegistry();
        var f = finding('src/auth.ts', 'login must return 401', 'IMPORTANT', 12);
        f.demotion = { reason: 'missing-citation', claimMatchedTicket: 'no' };
        return {
            r: r,
            policy: r.resolveIdentityPolicy({}, null),
            reg: r.applyRound(r.emptyRegistry(), { at: '2026-11-03T10:00:00Z', findings: [f] },
                r.resolveIdentityPolicy({}, null)).registry
        };
    }

    test('the packet surfaces demoted findings with their provenance', function() {
        var ctx = registryWithDemotion();
        var packet = ctx.r.buildEscalationPacket(ctx.reg);
        assert.equal(packet.demotions.length, 1);
        var d = packet.demotions[0];
        assert.equal(d.n, 1);
        assert.equal(d.file, 'src/auth.ts');
        assert.equal(d.severity, 'IMPORTANT');
        assert.equal(d.reason, 'missing-citation');
        assert.equal(d.claimMatchedTicket, 'no');
        assert.equal(d.status, 'open');
    });

    test('a clean registry contributes no demotions to the packet', function() {
        var r = loadRegistry();
        var reg = r.applyRound(r.emptyRegistry(), { at: '2026-11-03T10:00:00Z', findings: [
            finding('src/a.ts', 'claim one about tokens', 'BLOCKING', 1)
        ] }, r.resolveIdentityPolicy({}, null)).registry;
        assert.deepEqual(r.buildEscalationPacket(reg).demotions, []);
    });

    test('buildEscalationPacketComment renders the demotion line', function() {
        var ctx = registryWithDemotion();
        var body = ctx.r.buildEscalationPacketComment(ctx.reg);
        assert.ok(body.indexOf('demoted from BLOCKING') !== -1);
        assert.ok(body.indexOf('missing-citation') !== -1);
        assert.ok(body.indexOf('claimMatchedTicket: no') !== -1);
        assert.ok(body.indexOf('F1') !== -1);
    });

    test('buildFindingsInjection tells the reviewer how to re-elevate a demoted finding', function() {
        var ctx = registryWithDemotion();
        var md = ctx.r.buildFindingsInjection(ctx.reg);
        assert.ok(md.indexOf('demoted from BLOCKING') !== -1, 'the provenance is visible');
        assert.ok(md.indexOf('citation') !== -1, 're-raise WITH a citation');
        assert.ok(md.indexOf('same as F1') !== -1, 'the confirm path is named');
    });

    test('a clean open item gets no demotion hint in the injection', function() {
        var r = loadRegistry();
        var reg = r.applyRound(r.emptyRegistry(), { at: '2026-11-03T10:00:00Z', findings: [
            finding('src/auth.ts', 'nothing validates a token', 'BLOCKING', 45)
        ] }, r.resolveIdentityPolicy({}, null)).registry;
        var md = r.buildFindingsInjection(reg);
        assert.equal(md.indexOf('demoted from BLOCKING'), -1);
    });

    test('a demoted and a clean open item side by side → exactly one demotion guidance block', function() {
        var r = loadRegistry();
        var demoted = finding('src/auth.ts', 'login must return 401', 'IMPORTANT', 12);
        demoted.demotion = { reason: 'missing-citation', claimMatchedTicket: 'no' };
        var policy = r.resolveIdentityPolicy({}, null);
        var reg = r.applyRound(r.emptyRegistry(), { at: '2026-11-03T10:00:00Z',
            findings: [demoted, finding('src/api.ts', 'retry swallows the timeout error', 'IMPORTANT', 8)] },
            policy).registry;
        var md = r.buildFindingsInjection(reg);
        assert.equal(md.split('demoted from BLOCKING').length - 1, 1, 'one guidance block only');
        assert.ok(md.indexOf('same as F1') !== -1, 'the demoted identity is named');
        assert.ok(md.indexOf('| F2 | open | IMPORTANT | src/api.ts |') !== -1,
            'the clean item stays a plain table row, no hint');
        assert.ok(md.indexOf('same as F2') === -1, 'the clean item gets no re-elevation path');
    });
});
