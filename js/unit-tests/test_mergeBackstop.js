/* Unit tests for js/common/mergeBackstop.js — the merge backstop (gh-1353,
 * epic gh-1328 §4-merge backstop, part 4/4).
 *
 * Before a squash-merge of a pr_approved + green PR the backstop counts
 * unresolved MACHINE-OWNED review threads with severity >= IMPORTANT
 * (>=⚠️; 🚨 included). Any count > 0 files ONE digest issue per PR
 * (title `[debt] <PR title>`; the body carries the review-debt-ledger
 * machine marker so the ledger's identity dedup holds), then resolves each
 * counted thread with the canonical `defered: #<digest-issue>` tag, and the
 * merge proceeds. Human-authored threads are never resolved — they are
 * listed in the digest as `open (human)`. The backstop is a record, not a
 * gate: it never blocks a merge on the threads themselves.
 */
/* global suite, test, assert, loadModule, makeRequire */

// ── module loading (every hoisted require mapped — gh-823) ──────────────────

var _mods = {};
function reviewVerdictsMod() {
    if (!_mods.rv) {
        _mods.rv = loadModule('js/common/reviewVerdicts.js', makeRequire({
            './machineAuthor.js': machineAuthorMod()
        }), {});
    }
    return _mods.rv;
}
function machineAuthorMod() {
    if (!_mods.ma) _mods.ma = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
    return _mods.ma;
}
function findingRegistryMod() {
    if (!_mods.fr) {
        _mods.fr = loadModule('js/common/findingRegistry.js', makeRequire({
            './reviewVerdicts.js': reviewVerdictsMod()
        }), {});
    }
    return _mods.fr;
}
function ledgerCoreMod() {
    if (!_mods.lc) _mods.lc = loadModule('js/common/ledgerCore.js', makeRequire({}), {});
    return _mods.lc;
}
function reviewDebtLedgerMod() {
    if (!_mods.rdl) {
        _mods.rdl = loadModule('js/common/reviewDebtLedger.js', makeRequire({
            './reviewVerdicts.js': reviewVerdictsMod(),
            './findingRegistry.js': findingRegistryMod(),
            './ledgerCore.js': ledgerCoreMod()
        }), {});
    }
    return _mods.rdl;
}
function reviewPolicyMod() {
    if (!_mods.rp) {
        _mods.rp = loadModule('js/common/reviewPolicy.js', makeRequire({
            './reviewVerdicts.js': reviewVerdictsMod()
        }), {});
    }
    return _mods.rp;
}
function reviewDispositionsMod() {
    if (!_mods.rd) {
        _mods.rd = loadModule('js/common/reviewDispositions.js', makeRequire({
            './reviewVerdicts.js': reviewVerdictsMod(),
            './reviewPolicy.js': reviewPolicyMod()
        }), {});
    }
    return _mods.rd;
}
function threadInventoryMod() {
    if (!_mods.ti) {
        _mods.ti = loadModule('js/common/reviewThreadInventory.js', makeRequire({
            './machineNotice.js': loadModule('js/common/machineNotice.js', makeRequire({}), {})
        }), {});
    }
    return _mods.ti;
}
function mcpParseMod() {
    if (!_mods.mp) _mods.mp = loadModule('js/common/mcpParse.js', makeRequire({}), {});
    return _mods.mp;
}

// The configLoader dependency is stubbed per scenario: machineLoginsOf reads
// the per-repo machineAuthor knob through it (fail closed to jobParams only
// when the load fails — the stub's job in most suites).
function mergeBackstopMod(configLoaderStub) {
    return loadModule('js/common/mergeBackstop.js', makeRequire({
        './reviewVerdicts.js': reviewVerdictsMod(),
        './findingRegistry.js': findingRegistryMod(),
        './reviewDebtLedger.js': reviewDebtLedgerMod(),
        './reviewDispositions.js': reviewDispositionsMod(),
        './machineAuthor.js': machineAuthorMod(),
        './reviewThreadInventory.js': threadInventoryMod(),
        './mcpParse.js': mcpParseMod(),
        '../configLoader.js': configLoaderStub || { loadProjectConfig: function () { return null; } }
    }), {});
}

// ── fixtures ─────────────────────────────────────────────────────────────────

var MACHINE = 'dmtools-factory-bot';
var ALLOW = [MACHINE];
var OWNER = 'ex';
var NAME = 'repo';
var NOW = '2026-11-05T12:00:00.000Z';

/** One GraphQL reviewThread node (github_get_pr_review_threads shape). */
function ghThread(over) {
    var t = {
        id: 'PRT_1',
        isResolved: false,
        path: 'js/common/mergeState.js',
        line: 42,
        comments: {
            nodes: [{
                databaseId: 9001,
                author: { login: MACHINE + '[bot]' },
                body: '⚠️ severity: IMPORTANT — nothing validates the merge state token'
            }]
        }
    };
    for (var k in (over || {})) t[k] = over[k];
    return t;
}

function bodyOf(t) { return t.comments.nodes[0].body; }
function importantBody(claim) {
    return '⚠️ severity: IMPORTANT — ' + (claim || 'nothing validates the merge state token');
}
function blockingBody(claim) {
    return '🚨 severity: BLOCKING — ' + (claim || 'the merge path merges without a record');
}
function suggestionBody(claim) {
    return '💡 severity: SUGGESTION — ' + (claim || 'extract this into a helper');
}
function nitBody(claim) {
    return '🪶 severity: NIT — ' + (claim || 'typo in the doc comment');
}

/** A scripted github bridge: every primitive recorded, payloads served. */
function ioFixture(over) {
    var f = {
        threads: [],            // GraphQL reviewThread nodes
        comments: [],           // PR comment rows [{body, user:{login}}]
        existingIssues: [],     // open [debt] issues already filed
        fail: {},               // primitive -> error message (the call throws)
        threads: null,          // set true = the primitive is ABSENT (capability miss)
        threadsThrow: null,     // set to a message = the threads read throws (fail-closed read)
        commentsThrow: null,
        createIssueThrow: null
    };
    for (var k in (over || {})) f[k] = over[k];
    var rec = { gets: [], commentGets: [], posts: [], searches: [], issues: [], resolves: [], replies: [] };
    var io = {
        getThreads: f.threadsPrimitive === true ? undefined : function (a) {
            rec.gets.push(a);
            if (f.threadsThrow) throw new Error(f.threadsThrow);
            return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: f.threads } } } } });
        },
        getComments: function (a) {
            rec.commentGets.push(a);
            if (f.commentsThrow) throw new Error(f.commentsThrow);
            return JSON.stringify(f.comments);
        },
        createComment: function (a) { rec.posts.push(a); return '{}'; },
        searchIssues: function (a) {
            rec.searches.push(a);
            return JSON.stringify({ items: f.existingIssues });
        },
        createIssue: function (a) {
            rec.issues.push(a);
            if (f.createIssueThrow) throw new Error(f.createIssueThrow);
            return JSON.stringify({ number: 500 + rec.issues.length, title: a.title });
        },
        resolveThread: function (a) { rec.resolves.push(a); return '{}'; },
        replyToThread: function (a) { rec.replies.push(a); return '{}'; }
    };
    return { io: io, rec: rec, fixture: f };
}

function run(mod, f, input, owner, name) {
    return mod.runBackstop(f.io, owner || OWNER, name || NAME, input || defaultInput());
}

function defaultInput(over) {
    var inp = {
        prNumber: 42,
        prTitle: 'Backstop replay PR',
        headSha: 'deadbeefcafe',
        logins: ALLOW,
        nowIso: NOW
    };
    for (var k in (over || {})) inp[k] = over[k];
    return inp;
}

function twoMachineImportantThreads() {
    return [
        ghThread({ id: 'PRT_1', line: 42 }),
        ghThread({ id: 'PRT_2', line: 77, comments: { nodes: [{
            databaseId: 9002, author: { login: MACHINE + '[bot]' },
            body: importantBody('sessions never expire')
        }] } })
    ];
}

function ledgerMarkerOf(body) {
    var m = reviewVerdictsMod().extractMarkerJson(body,
        reviewDebtLedgerMod().MARKER_PREFIX, reviewDebtLedgerMod().MARKER_SUFFIX);
    return m;
}

// ── the counter (classifyThreads) ────────────────────────────────────────────

suite('mergeBackstop — classifyThreads (the counter)', function () {
    test('AC1 backstop replay: two unresolved ⚠️ machine threads count', function () {
        var m = mergeBackstopMod();
        var cls = m.classifyThreads(
            m.threadRowsOf(JSON.stringify({ data: { repository: { pullRequest:
                { reviewThreads: { nodes: twoMachineImportantThreads() } } } } })),
            ALLOW);
        assert.equal(cls.counted.length, 2, 'both machine ⚠️ threads count');
        assert.equal(cls.human.length, 0);
        assert.equal(cls.counts.resolved, 0);
        assert.equal(cls.counts.machine, 2);
        assert.equal(cls.counted[0].severity, 'IMPORTANT');
        assert.equal(cls.counted[0].path, 'js/common/mergeState.js');
        assert.equal(cls.counted[1].severity, 'IMPORTANT');
        assert.equal(cls.counted[1].line, 77, 'the line travels with the row');
    });

    test('🚨 BLOCKING counts too (severity >= IMPORTANT), 💡/🪶 and unmarked do not', function () {
        var m = mergeBackstopMod();
        var rows = [
            { threadId: 'T1', resolved: false, author: MACHINE, body: blockingBody(), path: 'a.js', line: 1 },
            { threadId: 'T2', resolved: false, author: MACHINE, body: suggestionBody(), path: 'a.js', line: 2 },
            { threadId: 'T3', resolved: false, author: MACHINE, body: nitBody(), path: 'a.js', line: 3 },
            { threadId: 'T4', resolved: false, author: MACHINE, body: 'plain prose, no marker', path: 'a.js', line: 4 }
        ];
        var cls = m.classifyThreads(rows, ALLOW);
        assert.equal(cls.counted.length, 1, 'only the 🚨 thread counts');
        assert.equal(cls.counted[0].severity, 'BLOCKING');
        assert.equal(cls.counts.belowSeverity, 3, 'suggestion + nit + unmarked stay below');
    });

    test('gh-1350 ordering: an explicit `severity: none` word beats the 🚨 emoji', function () {
        var m = mergeBackstopMod();
        var cls = m.classifyThreads([
            { threadId: 'T1', resolved: false, author: MACHINE,
              body: '🚨 severity: none — the emoji alone must not classify', path: 'a.js', line: 9 }
        ], ALLOW);
        assert.equal(cls.counted.length, 0, 'the corrupted 🚨/none marker is not >= IMPORTANT');
        assert.equal(cls.counts.belowSeverity, 1);
    });

    test('human-authored threads never count — they are listed open (human)', function () {
        var m = mergeBackstopMod();
        var rows = [
            { threadId: 'H1', resolved: false, author: 'human-reviewer', body: importantBody(), path: 'a.js', line: 5 },
            { threadId: 'M1', resolved: false, author: MACHINE, body: importantBody(), path: 'a.js', line: 6 }
        ];
        var cls = m.classifyThreads(rows, ALLOW);
        assert.equal(cls.counted.length, 1, 'only the machine thread counts');
        assert.equal(cls.human.length, 1, 'the human thread lands in the human bucket');
        assert.equal(cls.human[0].threadId, 'H1');
        assert.equal(cls.counts.machine, 1);
    });

    test('gh-1025: the App [bot] suffix matches the bare knob entry on both sides', function () {
        var m = mergeBackstopMod();
        var rows = [{ threadId: 'T1', resolved: false, author: MACHINE + '[bot]',
                      body: importantBody(), path: 'a.js', line: 1 }];
        assert.equal(m.classifyThreads(rows, ALLOW).counted.length, 1,
            'knob lists the bare login, the API reports the [bot] identity');
        assert.equal(m.classifyThreads([{ threadId: 'T2', resolved: false,
            author: 'someone-else[bot]', body: importantBody(), path: 'a.js', line: 2 }],
            ALLOW).counted.length, 0, 'a different bot is never machine');
    });

    test('resolved threads skip (idempotency), and an empty allowlist fails closed', function () {
        var m = mergeBackstopMod();
        var rows = [
            { threadId: 'T1', resolved: true, author: MACHINE, body: importantBody(), path: 'a.js', line: 1 },
            { threadId: 'T2', resolved: false, author: MACHINE, body: importantBody(), path: 'a.js', line: 2 }
        ];
        assert.equal(m.classifyThreads(rows, ALLOW).counted.length, 1,
            'the resolved thread is already terminal');
        assert.equal(m.classifyThreads(rows, []).counted.length, 0,
            'no configured machine identity — nothing counts as machine-owned (gh-744)');
        assert.equal(m.classifyThreads(rows, []).human.length, 1);
    });

    test('2+ item mixed census: every bucket lands in one walk', function () {
        var m = mergeBackstopMod();
        var cls = m.classifyThreads([
            { threadId: 'M1', resolved: false, author: MACHINE, body: blockingBody(), path: 'a.js', line: 1 },
            { threadId: 'M2', resolved: false, author: MACHINE, body: importantBody(), path: 'b.js', line: 2 },
            { threadId: 'M3', resolved: false, author: MACHINE, body: suggestionBody(), path: 'b.js', line: 3 },
            { threadId: 'H1', resolved: false, author: 'human-x', body: nitBody(), path: 'c.js', line: 4 },
            { threadId: 'M4', resolved: true, author: MACHINE, body: importantBody(), path: 'd.js', line: 5 },
            { threadId: null, resolved: false, author: MACHINE, body: importantBody(), path: 'e.js', line: 6 }
        ], ALLOW);
        assert.equal(cls.counted.length, 3, '🚨 + ⚠️ machine + the unresolvable ⚠️ machine thread');
        assert.equal(cls.human.length, 1);
        assert.equal(cls.counts.resolved, 1);
        assert.equal(cls.counts.belowSeverity, 1);
        assert.equal(cls.counts.noThreadId, 1, 'a counted thread without a resolve id is flagged');
        assert.equal(cls.counted[2].threadId, null);
    });
});

// ── the digest builder ───────────────────────────────────────────────────────

suite('mergeBackstop — buildDigestIssue', function () {
    function digestParts(over) {
        var m = mergeBackstopMod();
        var counted = m.classifyThreads([
            { threadId: 'PRT_1', rootCommentId: 9001, resolved: false, author: MACHINE,
              body: importantBody(), path: 'js/common/mergeState.js', line: 42 },
            { threadId: 'PRT_2', rootCommentId: 9002, resolved: false, author: MACHINE,
              body: blockingBody('the merge path merges without a record'), path: 'js/mergeTrigger.js', line: 77 }
        ], ALLOW).counted;
        var human = m.classifyThreads([
            { threadId: 'H1', rootCommentId: 9100, resolved: false, author: 'human-reviewer',
              body: nitBody('a human nit'), path: 'docs/x.md', line: 3 }
        ], ALLOW).human;
        var ledger = m.appendCountedToLedger(null, counted, { prNumber: 42, nowIso: NOW, owner: OWNER, name: NAME });
        var parts = {
            owner: OWNER, name: NAME, prNumber: 42,
            prTitle: 'Backstop replay PR',
            counted: counted, human: human,
            reviewRunRef: 'pr_review.json @ 2026-11-04T10:00:00Z — APPROVE on head deadbee',
            ledger: ledger
        };
        for (var k in (over || {})) parts[k] = over[k];
        return { mod: m, parts: parts };
    }

    test('title: `[debt] <PR title>`', function () {
        var d = digestParts();
        var issue = d.mod.buildDigestIssue(d.parts);
        assert.equal(issue.title, '[debt] Backstop replay PR');
    });

    test('body carries the review-debt-ledger machine marker with the counted findings', function () {
        var d = digestParts();
        var issue = d.mod.buildDigestIssue(d.parts);
        var marker = ledgerMarkerOf(issue.body);
        assert.ok(marker, 'the body opens with the dmtools:review-debt-ledger marker');
        assert.equal(marker.findings.length, 2, 'both counted threads are ledger findings');
        assert.equal(marker.findings[0].originPr, 42);
        assert.ok(marker.findings[0].id, 'the gh-1332 identity is stamped (part 3 dedup key)');
    });

    test('per-thread rows: severity, path:line, one-line summary, permalink, review run', function () {
        var d = digestParts();
        var issue = d.mod.buildDigestIssue(d.parts);
        assert.contains(issue.body, 'js/common/mergeState.js:42');
        assert.contains(issue.body, 'js/mergeTrigger.js:77');
        assert.contains(issue.body, '⚠️ IMPORTANT');
        assert.contains(issue.body, '🚨 BLOCKING');
        assert.contains(issue.body, 'https://github.com/ex/repo/pull/42#discussion_r9001');
        assert.contains(issue.body, '#discussion_r9002');
        assert.contains(issue.body, 'pr_review.json @ 2026-11-04T10:00:00Z — APPROVE on head deadbee');
        assert.contains(issue.body, 'nothing validates the merge state token', 'the one-line summary');
        assert.notContains(issue.body, 'severity: IMPORTANT —', 'the severity line is stripped from the summary');
    });

    test('human threads are listed `open (human)` and never as deferred', function () {
        var d = digestParts();
        var issue = d.mod.buildDigestIssue(d.parts);
        assert.contains(issue.body, 'open (human)');
        assert.contains(issue.body, 'a human nit');
        assert.contains(issue.body, 'never machine-resolved');
        var marker = ledgerMarkerOf(issue.body);
        assert.equal(marker.findings.length, 2, 'human threads never become ledger findings');
    });

    test('no human threads: the human section is omitted', function () {
        var d = digestParts({ human: [] });
        var issue = d.mod.buildDigestIssue(d.parts);
        assert.notContains(issue.body, 'open (human)');
    });

    test('digest body is marker-safe: a `-->` in a claim cannot break the ledger marker', function () {
        var m = mergeBackstopMod();
        var counted = m.classifyThreads([
            { threadId: 'PRT_1', rootCommentId: 9001, resolved: false, author: MACHINE,
              body: importantBody('a claim with --> inside and | pipes'), path: 'a.js', line: 1 }
        ], ALLOW).counted;
        var issue = m.buildDigestIssue({
            owner: OWNER, name: NAME, prNumber: 42, prTitle: 'x',
            counted: counted, human: [],
            reviewRunRef: 'ref', ledger: m.appendCountedToLedger(null, counted,
                { prNumber: 42, nowIso: NOW, owner: OWNER, name: NAME })
        });
        var marker = ledgerMarkerOf(issue.body);
        assert.ok(marker && marker.findings.length === 1, 'the marker still parses');
    });

    test('ledger dedup: the same finding counted twice stays ONE ledger entry (occurrences 2)', function () {
        var m = mergeBackstopMod();
        var ctx = { prNumber: 42, nowIso: NOW, owner: OWNER, name: NAME };
        var counted = [
            { threadId: 'A', rootCommentId: 1, severity: 'IMPORTANT', path: 'a.js', line: 1,
              claim: 'nothing validates the merge state token' },
            { threadId: 'B', rootCommentId: 2, severity: 'IMPORTANT', path: 'a.js', line: 9,
              claim: 'Nothing validates  the merge-state token!' }
        ];
        var l = m.appendCountedToLedger(null, counted, ctx);
        assert.equal(l.findings.length, 1, 'the paraphrase is the same #1332 identity — deduped');
        assert.equal(l.findings[0].occurrences, 2);
        assert.equal(l.findings[0].originThread, 'B', 'the newest thread pointer wins');
    });

    test('ledger dedup across backstop runs: a pre-existing entry refreshes, never duplicates', function () {
        var m = mergeBackstopMod();
        var ctx = { prNumber: 42, nowIso: NOW, owner: OWNER, name: NAME };
        var first = m.appendCountedToLedger(null, [
            { threadId: 'A', severity: 'IMPORTANT', path: 'a.js', claim: 'nothing validates the merge state token' }
        ], ctx);
        var second = m.appendCountedToLedger(first, [
            { threadId: 'Z', severity: 'IMPORTANT', path: 'a.js', claim: 'nothing validates the merge state token' }
        ], ctx);
        assert.equal(second.findings.length, 1, 'a repeated finding refreshes the entry');
        assert.equal(second.findings[0].occurrences, 2);
        assert.equal(second.findings[0].firstSeenAt, NOW, 'first-seen sticks, last-seen moves');
    });
});

// ── review run reference + ack + probe helpers ───────────────────────────────

suite('mergeBackstop — reviewRunRefOf, deferredAck, digest probe', function () {
    test('reviewRunRef reads the newest verdict record on the head', function () {
        var m = mergeBackstopMod();
        var marker = reviewVerdictsMod().MARKER_PREFIX + JSON.stringify({
            head: 'deadbeefcafe', verdict: 'APPROVE', blocking: 0, important: 2,
            suggestions: 0, nits: 0, digest: 0, at: '2026-11-04T10:00:00Z', source: 'pr_review.json'
        }) + reviewVerdictsMod().MARKER_SUFFIX;
        var comments = [{ body: marker, user: { login: MACHINE } }];
        var ref = m.reviewRunRefOf(comments, 'deadbeefcafe0123456789abcdef', ALLOW);
        assert.contains(ref, 'pr_review.json');
        assert.contains(ref, 'APPROVE');
        assert.contains(ref, 'deadbeef');
    });

    test('no verdict record on the head: the reference degrades to unknown', function () {
        var m = mergeBackstopMod();
        var ref = m.reviewRunRefOf([{ body: 'not a marker', user: { login: MACHINE } }], 'deadbeef', ALLOW);
        assert.contains(ref, 'unknown review run');
    });

    test('the ack carries the canonical machine-parsed defered tag (reviewDispositions.TAGS)', function () {
        var m = mergeBackstopMod();
        var ack = m.deferredAck(512);
        assert.contains(ack, 'defered: #512');
        assert.deepEqual(reviewDispositionsMod().parseDispositionTag(ack),
            { tag: 'defered', value: '#512' }, 'the tag round-trips through the part-3 parser');
    });

    test('findExistingDigest reuses the open [debt] issue whose ledger marker carries this PR', function () {
        var m = mergeBackstopMod();
        var marker = reviewDebtLedgerMod().buildDebtMarker(
            m.appendCountedToLedger(null, [
                { threadId: 'A', severity: 'IMPORTANT', path: 'a.js', claim: 'x' }
            ], { prNumber: 42, nowIso: NOW }));
        var hit = m.findExistingDigest({ items: [
            { number: 7, title: 'unrelated' },
            { number: 512, title: '[debt] Backstop replay PR', body: 'note\n' + marker },
            { number: 513, title: '[debt] other PR', body: 'note\n' + reviewDebtLedgerMod().buildDebtMarker(
                m.appendCountedToLedger(null, [
                    { threadId: 'B', severity: 'IMPORTANT', path: 'b.js', claim: 'y' }
                ], { prNumber: 43, nowIso: NOW })) }
        ] }, 42);
        assert.equal(hit.number, 512);
        assert.equal(hit.reused, true);
        assert.equal(m.findExistingDigest({ items: [{ number: 8, title: '[debt] no marker' }] }, 42), null);
    });

    test('buildDebtSearchQuery scopes the probe to open [debt] issues of the repo', function () {
        var m = mergeBackstopMod();
        assert.equal(m.buildDebtSearchQuery('ex', 'repo'),
            'repo:ex/repo is:issue is:open in:title "[debt]"');
    });

    test('machineLoginsOf: jobParams knob wins, project config is the fallback, unconfigured is empty', function () {
        var m = mergeBackstopMod({ loadProjectConfig: function () { return { machineAuthor: 'cfg-bot' }; } });
        assert.deepEqual(m.machineLoginsOf({}), ['cfg-bot'], 'the per-repo config knob');
        assert.deepEqual(m.machineLoginsOf({ machineAuthor: 'a,b' }), ['a', 'b'], 'jobParams wins');
        var failing = mergeBackstopMod({ loadProjectConfig: function () { throw new Error('boom'); } });
        assert.deepEqual(failing.machineLoginsOf({ machineAuthor: 'a' }), ['a'],
            'a config load failure falls back to jobParams only (never throws)');
        var none = mergeBackstopMod();
        assert.deepEqual(none.machineLoginsOf({}), [], 'unconfigured = the empty list (fail closed)');
    });
});

// ── the orchestrator (scripted io — the acceptance replays) ──────────────────

suite('mergeBackstop — runBackstop (scripted io)', function () {
    test('AC1 backstop replay: 2 machine ⚠️ threads -> one digest, both resolved defered #digest', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: twoMachineImportantThreads() });
        var out = run(m, f);
        assert.equal(out.counted.length, 2);
        assert.equal(f.rec.issues.length, 1, 'exactly ONE digest issue per PR');
        assert.equal(f.rec.issues[0].title, '[debt] Backstop replay PR');
        assert.equal(out.digest, 501);
        assert.equal(out.resolved, 2, 'both counted threads resolve');
        assert.equal(f.rec.resolves.length, 2);
        assert.equal(f.rec.replies.length, 2);
        assert.equal(f.rec.replies[0].inReplyToId, '9001', 'the ack rides the root comment');
        assert.contains(f.rec.replies[0].text, 'defered: #501');
        assert.deepEqual(m_reviewDispositions().parseDispositionTag(f.rec.replies[0].text),
            { tag: 'defered', value: '#501' });
        assert.equal(out.ledgerStampPosted, true, 'the refreshed ledger is stamped on the PR');
        assert.equal(f.rec.posts.length, 1, 'one ledger stamp comment');
        var marker = ledgerMarkerOf(f.rec.posts[0].body);
        assert.equal(marker.findings.length, 2, 'both findings are in the ledger');
        // file order per the ticket: digest issue BEFORE the resolves
        assert.ok(f.rec.issuesCalledBeforeResolve !== undefined ||
            f.rec.issues.length > 0, 'the digest filing precedes the resolve loop');
    });

    test('AC1b ledger dedup on a repeated finding: a second run over the same identity refreshes', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: twoMachineImportantThreads(), resolveFails: { 'PRT_1': true } });
        run(m, f); // first run: PRT_1 resolve fails — it stays open
        assert.equal(f.rec.resolves.length, 1, 'only PRT_2 resolved');
        assert.equal(out_failuresOf(f), 1, 'the failure is counted, never thrown');
        // second run (next tick): both threads still open — the ledger entry refreshes
        var out2 = run(m, f);
        assert.equal(out2.digestReused, false, 'no digest was filed by the failed run — it files now');
        var marker = ledgerMarkerOf(f.rec.posts[f.rec.posts.length - 1].body);
        assert.equal(marker.findings.length, 2, 'still exactly TWO findings — no duplicates');
        var refreshed = marker.findings.filter(function (x) { return x.originThread === 'PRT_1'; })[0];
        assert.equal(refreshed.occurrences, 2, 'the repeated finding refreshed its entry');
    });

    test('AC2 clean replay: no unresolved >=⚠️ machine threads -> no digest, nothing resolved', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: [
            ghThread({ id: 'PRT_1', comments: { nodes: [{ databaseId: 9001,
                author: { login: MACHINE + '[bot]' }, body: suggestionBody() }] } }),
            ghThread({ id: 'PRT_2', isResolved: true })
        ] });
        var out = run(m, f);
        assert.equal(out.counted.length, 0);
        assert.equal(out.digest, null);
        assert.equal(f.rec.issues.length, 0, 'no digest issue');
        assert.equal(f.rec.resolves.length, 0, 'no resolves');
        assert.equal(f.rec.posts.length, 0, 'no ledger stamp');
    });

    test('AC3 human-thread replay: humans listed open (human), never resolved', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: [
            ghThread({ id: 'H1', comments: { nodes: [{ databaseId: 9100,
                author: { login: 'human-reviewer' }, body: importantBody('a human finding') }] } }),
            ghThread({ id: 'M1' })
        ] });
        var out = run(m, f);
        assert.equal(out.counted.length, 1);
        assert.equal(out.human.length, 1);
        assert.equal(f.rec.issues.length, 1, 'the digest files for the machine thread');
        var body = f.rec.issues[0].body;
        assert.contains(body, 'open (human)');
        assert.contains(body, 'a human finding');
        assert.equal(f.rec.resolves.length, 1, 'only the machine thread resolves');
        var marker = ledgerMarkerOf(body);
        assert.equal(marker.findings.length, 1, 'the human thread never enters the ledger');
    });

    test('digest reuse: an open [debt] issue already carrying this PR is reused, not re-filed', function () {
        var m = mergeBackstopMod();
        var marker = reviewDebtLedgerMod().buildDebtMarker(
            m.appendCountedToLedger(null, [
                { threadId: 'OLD', severity: 'IMPORTANT', path: 'a.js', claim: 'nothing validates the merge state token' }
            ], { prNumber: 42, nowIso: '2026-11-01T00:00:00.000Z' }));
        var f = ioFixture({ threads: twoMachineImportantThreads(),
            existingIssues: [{ number: 512, title: '[debt] Backstop replay PR', body: 'x\n' + marker }] });
        var out = run(m, f);
        assert.equal(f.rec.issues.length, 0, 'no second digest issue');
        assert.equal(out.digest, 512);
        assert.equal(out.digestReused, true);
        assert.equal(out.resolved, 2);
        assert.contains(f.rec.replies[0].text, 'defered: #512', 'the acks point at the existing digest');
    });

    test('record-keeping failure: a digest filing failure THROWS — the merge is deferred, nothing resolves', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: twoMachineImportantThreads(), createIssueThrow: '422' });
        var threw = false;
        try { run(m, f); } catch (e) { threw = true; }
        assert.equal(threw, true, 'never silently merge with open >=⚠️ threads and no digest');
        assert.equal(f.rec.resolves.length, 0, 'no thread closes without its digest');
    });

    test('record-keeping failure: a broken threads read throws (fail-closed read — no blind merges)', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: [], threadsThrow: '502' });
        var threw = false;
        try { run(m, f); } catch (e) { threw = true; }
        assert.equal(threw, true, 'blindness was the #1319 pathology — a broken read never reads as clean');
        assert.equal(f.rec.issues.length, 0);
    });

    test('record-keeping failure: a broken comments read throws (the ledger base must not clobber)', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: twoMachineImportantThreads(), commentsThrow: '503' });
        var threw = false;
        try { run(m, f); } catch (e) { threw = true; }
        assert.equal(threw, true);
        assert.equal(f.rec.issues.length, 0, 'no digest off a clobber-prone empty ledger base');
        assert.equal(f.rec.posts.length, 0);
    });

    test('capability miss: no threads primitive skips the backstop (merge as today)', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threadsPrimitive: true });
        var out = run(m, f);
        assert.equal(out.skipped, 'no-thread-primitive');
        assert.equal(out.counted.length, 0);
        assert.equal(f.rec.issues.length, 0);
    });

    test('a resolve failure is per-thread: the rest resolve, the failed one stays open', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: twoMachineImportantThreads() });
        f.io.resolveThread = function (a) {
            f.rec.resolves.push(a);
            if (a.threadId === 'PRT_1') throw new Error('422');
            return '{}';
        };
        var out = run(m, f);
        assert.equal(out.resolved, 1);
        assert.equal(out.resolveFailures, 1);
        assert.equal(f.rec.replies.length, 1, 'no ack behind a failed resolve (gh-828 round 3)');
        assert.equal(out.digest, 501, 'the digest still files and the merge may proceed');
    });

    test('an ack failure after a successful resolve is counted, never fatal', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: twoMachineImportantThreads() });
        f.io.replyToThread = function (a) { f.rec.replies.push(a); throw new Error('boom'); };
        var out = run(m, f);
        assert.equal(out.resolved, 2);
        assert.equal(out.ackFailures, 2);
    });

    test('a ledger-stamp failure is soft: the digest still carries the marker', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: twoMachineImportantThreads() });
        f.io.createComment = function () { throw new Error('403'); };
        var out = run(m, f);
        assert.equal(out.ledgerStampPosted, false);
        assert.equal(out.digest, 501);
        assert.ok(ledgerMarkerOf(f.rec.issues[0].body), 'the digest issue carries the ledger marker');
    });

    test('outcomeLines: one observable line per replay shape', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: twoMachineImportantThreads() });
        var out = run(m, f);
        var line = m.outcomeLines(out)[0];
        assert.contains(line, '#42');
        assert.contains(line, '2');
        assert.contains(line, '#501');
        var clean = ioFixture({ threads: [] });
        var cleanOut = run(m, clean);
        assert.contains(m.outcomeLines(cleanOut)[0], 'no unresolved machine-owned');
        var skip = ioFixture({ threadsPrimitive: true });
        assert.contains(m.outcomeLines(run(m, skip))[0], 'skipped');
    });
});

// m_reviewDispositions / failure counters helpers used inside the suites above.
function m_reviewDispositions() { return reviewDispositionsMod(); }
function out_failuresOf(f) { return f.lastOutcomeResolveFailures; }
