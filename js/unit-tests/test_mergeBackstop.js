/* Unit tests for js/common/mergeBackstop.js — the merge backstop (gh-1353,
 * epic gh-1328 §4-merge backstop, part 4/4; gh-1370 tightened it).
 *
 * Before a squash-merge of a pr_approved + green PR the backstop counts
 * unresolved MACHINE-OWNED review threads with severity >= IMPORTANT
 * (>=⚠️; 🚨 included). Any count > 0 files ONE digest issue per PR
 * (title `[debt] <PR title>`; the body carries the review-debt-ledger
 * machine marker so the ledger's identity dedup holds), then resolves each
 * counted thread with the canonical `deferred: #<digest-issue>` tag.
 * gh-1370 (owner directive): EVERY machine-owned review thread must reach
 * terminal resolution before the merge — SUGGESTION/NIT threads resolve
 * WITHOUT a fix (the machine-parsed `wontfix` ack tag), and a failed
 * resolution HOLDS the merge (retry next tick; escalation if it keeps
 * failing). Human-authored threads are never resolved — they are listed
 * in the digest as `open (human)`.
 */
/* global suite, test, assert, loadModule, makeRequire */

// ── module loading (every hoisted require mapped — gh-823) ──────────────────

var _mods = {};
function machineAuthorMod() {
    if (!_mods.ma) _mods.ma = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
    return _mods.ma;
}
function reviewVerdictsMod() {
    if (!_mods.rv) {
        _mods.rv = loadModule('js/common/reviewVerdicts.js', makeRequire({
            './machineAuthor.js': machineAuthorMod()
        }), {});
    }
    return _mods.rv;
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
// the per-repo machineAuthor knob through it (failing closed to jobParams
// only when the load throws — the stub's job in most suites).
// `globalMods` maps engine github-bridge globals (githubBridgeIo's inputs)
// — loadModule shadows them as module vars; an unlisted name stays absent.
function mergeBackstopMod(configLoaderStub, globalMods) {
    return loadModule('js/common/mergeBackstop.js', makeRequire({
        './reviewVerdicts.js': reviewVerdictsMod(),
        './findingRegistry.js': findingRegistryMod(),
        './reviewDebtLedger.js': reviewDebtLedgerMod(),
        './reviewDispositions.js': reviewDispositionsMod(),
        './machineAuthor.js': machineAuthorMod(),
        './reviewThreadInventory.js': threadInventoryMod(),
        './mcpParse.js': mcpParseMod(),
        '../configLoader.js': configLoaderStub || { loadProjectConfig: function () { return null; } }
    }), globalMods || {});
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

/**
 * A scripted github bridge: every primitive recorded (rec.order keeps the
 * GLOBAL call order across primitives so the ticket's file-then-resolve
 * order is assertable), payloads served, failures injectable per primitive.
 * opts:
 *   threads           — GraphQL reviewThread nodes served by getThreads
 *   noThreads         — true = the threads primitive is ABSENT (capability miss)
 *   threadsThrow      — the threads read throws (fail-closed read scenario)
 *   commentsThrow     — the comments read throws (ledger-clobber scenario)
 *   createIssueThrow  — the digest filing throws (record-keeping failure)
 *   resolveFailIds    — thread ids whose resolve throws (per-thread failure)
 *   existingIssues    — open [debt] issues the search probe returns
 */
function ioFixture(opts) {
    var f = {
        threads: [],
        comments: [],
        noThreads: false,
        threadsThrow: null,
        commentsThrow: null,
        createIssueThrow: null,
        resolveFailIds: [],
        existingIssues: []
    };
    for (var k in (opts || {})) f[k] = opts[k];
    var rec = { order: [], issues: [], resolves: [], replies: [], posts: [], searches: [] };
    function mark(kind) { rec.order.push(kind); }
    var io = {
        getThreads: f.noThreads ? undefined : function () {
            mark('threads');
            if (f.threadsThrow) throw new Error(f.threadsThrow);
            return JSON.stringify({ data: { repository: { pullRequest:
                { reviewThreads: { nodes: f.threads } } } } });
        },
        getComments: function () {
            mark('comments');
            if (f.commentsThrow) throw new Error(f.commentsThrow);
            // reality: the posts ARE the PR comment stream (write-then-read
            // parity — the same read the next run's ledger base uses)
            return JSON.stringify(f.comments.concat(rec.posts.map(function (p) {
                return { body: p.body, user: { login: MACHINE } };
            })));
        },
        createComment: function (a) { mark('post'); rec.posts.push(a); return '{}'; },
        createIssue: function (a) {
            mark('issue');
            rec.issues.push(a);
            if (f.createIssueThrow) throw new Error(f.createIssueThrow);
            return JSON.stringify({ number: 500 + rec.issues.length, title: a.title });
        },
        searchIssues: function (a) {
            mark('search');
            rec.searches.push(a);
            // reality: an issue created by an earlier run IS searchable
            var items = f.existingIssues.concat(rec.issues.map(function (x, i) {
                return { number: 500 + i + 1, title: x.title, body: x.body };
            }));
            return JSON.stringify({ items: items });
        },
        resolveThread: function (a) {
            mark('resolve');
            if (f.resolveFailIds.indexOf(String(a.threadId)) !== -1) throw new Error('422 ' + a.threadId);
            rec.resolves.push(a);
            return '{}';
        },
        replyToThread: function (a) { mark('reply'); rec.replies.push(a); return '{}'; }
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
        headSha: 'deadbeefcafe0123456789abcdef',
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
    return reviewVerdictsMod().extractMarkerJson(body,
        reviewDebtLedgerMod().MARKER_PREFIX, reviewDebtLedgerMod().MARKER_SUFFIX);
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

    test('gh-1025: the App [bot] suffix matches the bare knob entry; a different bot never matches', function () {
        var m = mergeBackstopMod();
        assert.equal(m.classifyThreads([{ threadId: 'T1', resolved: false,
            author: MACHINE + '[bot]', body: importantBody(), path: 'a.js', line: 1 }],
            ALLOW).counted.length, 1,
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
        assert.equal(d.mod.buildDigestIssue(d.parts).title, '[debt] Backstop replay PR');
    });

    test('body carries the review-debt-ledger machine marker with the counted findings', function () {
        var d = digestParts();
        var issue = d.mod.buildDigestIssue(d.parts);
        var marker = ledgerMarkerOf(issue.body);
        assert.ok(marker, 'the body opens with the dmtools:review-debt-ledger marker');
        assert.equal(marker.findings.length, 2, 'both counted threads are ledger findings');
        assert.equal(marker.findings[0].originPr, 42);
        assert.ok(marker.findings[0].id, 'the gh-1332 identity is stamped (the part 3 dedup key)');
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
        assert.contains(issue.body, '| nothing validates the merge state token |',
            'the summary cell carries no leading severity line (the ledger claim keeps the raw evidence)');
    });

    test('human threads are listed `open (human)` and never as deferred findings', function () {
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
        assert.notContains(d.mod.buildDigestIssue(d.parts).body, 'open (human)');
    });

    test('marker safety: a `-->` in a claim cannot break the ledger marker', function () {
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

    test('ledger dedup: the same finding counted twice stays ONE entry (occurrences 2)', function () {
        var m = mergeBackstopMod();
        var ctx = { prNumber: 42, nowIso: NOW, owner: OWNER, name: NAME };
        var l = m.appendCountedToLedger(null, [
            { threadId: 'A', rootCommentId: 1, severity: 'IMPORTANT', path: 'a.js', line: 1,
              claim: 'nothing validates the merge state token' },
            { threadId: 'B', rootCommentId: 2, severity: 'IMPORTANT', path: 'a.js', line: 9,
              claim: 'Nothing validates  the merge-state token!' }
        ], ctx);
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
            head: 'deadbeefcafe0123456789abcdef', verdict: 'APPROVE', blocking: 0, important: 2,
            suggestions: 0, nits: 0, digest: 0, at: '2026-11-04T10:00:00Z', source: 'pr_review.json'
        }) + reviewVerdictsMod().MARKER_SUFFIX;
        var comments = [{ body: marker, user: { login: MACHINE } }];
        var ref = m.reviewRunRefOf(comments, 'deadbeefcafe0123456789abcdef', ALLOW);
        assert.contains(ref, 'pr_review.json');
        assert.contains(ref, 'APPROVE');
        assert.contains(ref, 'deadbee');
    });

    test('no verdict record on the head: the reference degrades to unknown', function () {
        var m = mergeBackstopMod();
        var ref = m.reviewRunRefOf([{ body: 'not a marker', user: { login: MACHINE } }],
            'deadbeefcafe0123456789abcdef', ALLOW);
        assert.contains(ref, 'unknown review run');
    });

    test('the ack carries the canonical machine-parsed deferred tag (reviewDispositions.TAGS)', function () {
        var ack = mergeBackstopMod().deferredAck(512);
        assert.contains(ack, 'deferred: #512');
        assert.deepEqual(reviewDispositionsMod().parseDispositionTag(ack),
            { tag: 'deferred', value: '#512' }, 'the tag round-trips through the part-3 parser');
    });

    test('findExistingDigest reuses the open [debt] issue whose ledger marker carries this PR', function () {
        var m = mergeBackstopMod();
        var rdl = reviewDebtLedgerMod();
        var mine = rdl.buildDebtMarker(m.appendCountedToLedger(null, [
            { threadId: 'A', severity: 'IMPORTANT', path: 'a.js', claim: 'x' }
        ], { prNumber: 42, nowIso: NOW }));
        var other = rdl.buildDebtMarker(m.appendCountedToLedger(null, [
            { threadId: 'B', severity: 'IMPORTANT', path: 'b.js', claim: 'y' }
        ], { prNumber: 43, nowIso: NOW }));
        var hit = m.findExistingDigest({ items: [
            { number: 7, title: 'unrelated' },
            { number: 512, title: '[debt] Backstop replay PR', body: 'note\n' + mine },
            { number: 513, title: '[debt] other PR', body: 'note\n' + other }
        ] }, 42);
        assert.equal(hit.number, 512);
        assert.equal(hit.reused, true);
        assert.equal(m.findExistingDigest({ items: [{ number: 8, title: '[debt] no marker' }] }, 42), null);
        assert.equal(m.findExistingDigest({ items: [] }, 42), null);
    });

    test('buildDebtSearchQuery scopes the probe to open [debt] issues of the repo', function () {
        assert.equal(mergeBackstopMod().buildDebtSearchQuery('ex', 'repo'),
            'repo:ex/repo is:issue is:open in:title "[debt]"');
    });

    test('machineLoginsOf: jobParams knob wins, project config is the fallback, unconfigured is empty', function () {
        var m = mergeBackstopMod({ loadProjectConfig: function () { return { machineAuthor: 'cfg-bot' }; } });
        assert.deepEqual(m.machineLoginsOf({}), ['cfg-bot'], 'the per-repo config knob');
        assert.deepEqual(m.machineLoginsOf({ machineAuthor: 'a,b' }), ['a', 'b'], 'jobParams wins');
        var failing = mergeBackstopMod({ loadProjectConfig: function () { throw new Error('boom'); } });
        assert.deepEqual(failing.machineLoginsOf({ machineAuthor: 'a' }), ['a'],
            'a config load failure falls back to jobParams only (never throws)');
        assert.deepEqual(mergeBackstopMod().machineLoginsOf({}), [],
            'unconfigured = the empty list (fail closed)');
    });
});

// ── the orchestrator (scripted io — the acceptance replays) ──────────────────

suite('mergeBackstop — runBackstop (scripted io)', function () {
    test('AC1 backstop replay: 2 machine ⚠️ threads -> one digest, both resolved deferred #digest', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: twoMachineImportantThreads() });
        var out = run(m, f);
        assert.equal(out.counted.length, 2);
        assert.equal(f.rec.issues.length, 1, 'exactly ONE digest issue per PR');
        assert.equal(f.rec.issues[0].title, '[debt] Backstop replay PR');
        assert.equal(out.digest, 501);
        assert.equal(out.resolved, 2, 'both counted threads resolve');
        assert.equal(out.resolveFailures, 0);
        assert.equal(f.rec.resolves.length, 2);
        assert.deepEqual(f.rec.resolves[0],
            { workspace: OWNER, repository: NAME, pullRequestId: '42', threadId: 'PRT_1' },
            'the resolve rides the full github_resolve_pr_thread schema');
        assert.equal(f.rec.replies.length, 2);
        assert.equal(f.rec.replies[0].inReplyToId, '9001', 'the ack rides the root comment');
        assert.contains(f.rec.replies[0].text, 'deferred: #501');
        assert.deepEqual(reviewDispositionsMod().parseDispositionTag(f.rec.replies[0].text),
            { tag: 'deferred', value: '#501' });
        assert.equal(out.ledgerStampPosted, true, 'the refreshed ledger is stamped on the PR');
        assert.equal(f.rec.posts.length, 1, 'one ledger stamp comment');
        var marker = ledgerMarkerOf(f.rec.posts[0].body);
        assert.equal(marker.findings.length, 2, 'both findings are in the ledger');
        // ticket order: the digest issue files BEFORE the resolve loop
        assert.ok(f.rec.order.indexOf('issue') < f.rec.order.indexOf('resolve'),
            'filing precedes resolving');
    });

    test('AC1b ledger dedup across a HELD retry: the identity refreshes, one digest survives', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: twoMachineImportantThreads(), resolveFailIds: ['PRT_1'] });
        var threw = null;
        try { run(m, f); } catch (e) { threw = e; }
        assert.ok(threw, 'gh-1370: the unresolved thread HOLDS the merge');
        assert.equal(f.rec.issues.length, 1, 'the digest filed before the resolve loop');
        assert.equal(f.rec.resolves.length, 1, 'per-thread isolation: the healthy thread still resolved');
        f.fixture.resolveFailIds = []; // the transient API fault clears
        var out2 = run(m, f, defaultInput({ nowIso: '2026-11-06T12:00:00.000Z' }));
        assert.equal(out2.digestReused, true,
            'the digest from the first run exists and is reused, not re-filed');
        assert.equal(f.rec.issues.length, 1, 'still exactly ONE digest issue for the PR');
        var marker = ledgerMarkerOf(f.rec.posts[f.rec.posts.length - 1].body);
        assert.equal(marker.findings.length, 2, 'still exactly TWO findings — no duplicates');
        var refreshed = marker.findings.filter(function (x) { return x.originThread === 'PRT_1'; })[0];
        assert.equal(refreshed.occurrences, 2, 'the repeated finding refreshed its entry');
    });

    test('AC2 clean replay: no >=⚠️ machine threads → no digest; the open SUGGESTION resolves with an ack (gh-1370)', function () {
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
        assert.equal(f.rec.resolves.length, 1, 'the open machine thread resolves (gh-1370 ack path)');
        assert.equal(out.ackResolved, 1);
        assert.equal(f.rec.posts.length, 0, 'no ledger stamp');
        assert.equal(f.rec.order.indexOf('issue'), -1);
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
        assert.equal(ledgerMarkerOf(body).findings.length, 1,
            'the human thread never enters the ledger');
    });

    test('digest reuse: an open [debt] issue already carrying this PR is reused, not re-filed', function () {
        var m = mergeBackstopMod();
        var marker = reviewDebtLedgerMod().buildDebtMarker(
            m.appendCountedToLedger(null, [
                { threadId: 'OLD', severity: 'IMPORTANT', path: 'a.js',
                  claim: 'nothing validates the merge state token' }
            ], { prNumber: 42, nowIso: '2026-11-01T00:00:00.000Z' }));
        var f = ioFixture({ threads: twoMachineImportantThreads(),
            existingIssues: [{ number: 512, title: '[debt] Backstop replay PR', body: 'x\n' + marker }] });
        var out = run(m, f);
        assert.equal(f.rec.issues.length, 0, 'no second digest issue');
        assert.equal(out.digest, 512);
        assert.equal(out.digestReused, true);
        assert.equal(out.resolved, 2);
        assert.contains(f.rec.replies[0].text, 'deferred: #512',
            'the acks point at the existing digest');
    });

    test('record-keeping failure: a digest filing failure THROWS — merge deferred, nothing resolves', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: twoMachineImportantThreads(), createIssueThrow: '422' });
        var threw = false;
        try { run(m, f); } catch (e) { threw = true; }
        assert.equal(threw, true, 'never silently merge with open >=⚠️ threads and no digest');
        assert.equal(f.rec.resolves.length, 0, 'no thread closes without its digest');
    });

    test('record-keeping failure: a broken threads read throws (fail-closed read — no blind merges)', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threadsThrow: '502' });
        var threw = false;
        try { run(m, f); } catch (e) { threw = true; }
        assert.equal(threw, true,
            'blindness was the #1319 pathology — a broken read never reads as clean');
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
        var f = ioFixture({ noThreads: true });
        var out = run(m, f);
        assert.equal(out.skipped, 'no-thread-primitive');
        assert.equal(out.counted.length, 0);
        assert.equal(f.rec.issues.length, 0);
    });

    test('gh-1370: a resolve failure is per-thread (the rest still resolve) and HOLDS the merge', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: twoMachineImportantThreads(), resolveFailIds: ['PRT_1'] });
        var threw = null;
        try { run(m, f); } catch (e) { threw = e; }
        assert.ok(threw, 'an unresolved machine thread never merges');
        assert.contains(threw.message, 'merge HELD');
        assert.contains(threw.message, 'policy violation');
        assert.equal(f.rec.resolves.length, 1, 'per-thread isolation: the healthy thread resolved');
        assert.equal(f.rec.replies.length, 1, 'no ack behind a failed resolve (gh-828 round 3)');
        assert.equal(f.rec.issues.length, 1, 'the digest still files and records everyone');
    });

    test('gh-1370: an ack failure after a successful resolve HOLDS the merge (the ack tag is part of the resolution)', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: twoMachineImportantThreads() });
        f.io.replyToThread = function (a) { f.rec.replies.push(a); throw new Error('boom'); };
        var threw = null;
        try { run(m, f); } catch (e) { threw = e; }
        assert.ok(threw, 'the resolution step failed (no machine ack tag landed) — do NOT merge');
        assert.contains(threw.message, 'ack failures 2');
        assert.equal(f.rec.resolves.length, 2, 'the resolves landed — the retry reads them terminal');
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
        var fired = m.outcomeLines(run(m, f))[0];
        assert.contains(fired, '#42');
        assert.contains(fired, '2');
        assert.contains(fired, '#501');
        var cleanOut = run(m, ioFixture({ threads: [] }));
        assert.contains(m.outcomeLines(cleanOut)[0], 'no unresolved machine-owned');
        var skipOut = run(m, ioFixture({ noThreads: true }));
        assert.contains(m.outcomeLines(skipOut)[0], 'skipped');
    });
});

// ── gh-1370: every machine-owned thread reaches terminal resolution ──────────

suite('mergeBackstop — gh-1370 terminal resolution (nits resolve-without-fix)', function () {
    function belowThread(id, body, line) {
        return ghThread({ id: id, line: line, comments: { nodes: [{
            databaseId: 8000 + line, author: { login: MACHINE + '[bot]' }, body: body }] } });
    }
    // The gh-1368 census that triggered the policy: 4 SUGGESTION + 2 NIT
    // machine threads left open through the merge.
    function sixBelowThresholdThreads() {
        return [
            belowThread('PRT_S1', suggestionBody('extract this helper'), 11),
            belowThread('PRT_S2', suggestionBody('narrow the visibility'), 22),
            belowThread('PRT_S3', suggestionBody('rename for clarity'), 33),
            belowThread('PRT_S4', suggestionBody('split the long method'), 44),
            belowThread('PRT_N1', nitBody('typo in the doc comment'), 55),
            belowThread('PRT_N2', nitBody('stale link in the comment'), 66)
        ];
    }

    test('AC1 replay: 4 SUGGESTION + 2 NIT machine threads → all six resolved (wontfix acks), zero open machine threads, merge proceeds', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: sixBelowThresholdThreads() });
        var out = run(m, f); // must NOT throw — zero open machine threads after resolution
        assert.equal(out.counted.length, 0, 'nothing >= IMPORTANT — the digest path never runs');
        assert.equal(out.ackThreads.length, 6, 'all six land in the ack bucket');
        assert.equal(out.ackResolved, 6, 'all six reach terminal resolution');
        assert.equal(f.rec.resolves.length, 6, 'zero open machine threads at merge time');
        assert.equal(f.rec.replies.length, 6, 'each resolution carries its machine ack tag');
        assert.equal(f.rec.issues.length, 0, 'nits resolve WITHOUT fixing AND without a digest issue');
        assert.equal(f.rec.posts.length, 0, 'no ledger stamp — the debt ledger is not the nit path');
        assert.equal(out.resolveFailures + out.ackResolveFailures + out.ackReplyFailures, 0);
        var ids = f.rec.resolves.map(function (r) { return r.threadId; }).sort().join(',');
        assert.equal(ids, 'PRT_N1,PRT_N2,PRT_S1,PRT_S2,PRT_S3,PRT_S4',
            'each thread resolved by its own id (a 6-item census, no single-item shortcut)');
    });

    test('the ack tag round-trips the part-3 parser: wontfix: below gating threshold — epic invariant', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: [belowThread('PRT_N1', nitBody('a nit'), 5)] });
        run(m, f);
        assert.deepEqual(reviewDispositionsMod().parseDispositionTag(f.rec.replies[0].text),
            { tag: 'wontfix', value: 'below gating threshold — epic invariant (gh-1370)' },
            'the machine ack tag is the canonical reviewDispositions disposition');
        assert.equal(f.rec.replies[0].inReplyToId, '8005', 'the ack rides the root comment');
    });

    test('classify: below-threshold machine threads carry their ids; an id-less one counts noThreadId', function () {
        var m = mergeBackstopMod();
        var cls = m.classifyThreads([
            { threadId: 'S1', resolved: false, author: MACHINE, body: suggestionBody(), path: 'a.js', line: 1 },
            { threadId: null, resolved: false, author: MACHINE, body: nitBody(), path: 'a.js', line: 2 }
        ], ALLOW);
        assert.equal(cls.ackThreads.length, 2, 'both land in the ack bucket');
        assert.equal(cls.ackThreads[0].threadId, 'S1');
        assert.equal(cls.ackThreads[1].threadId, null);
        assert.equal(cls.counts.belowSeverity, 2);
        assert.equal(cls.counts.noThreadId, 1, 'an id-less machine thread can never resolve — flagged');
    });

    test('AC2 replay: a nit resolution call failing → merge HELD; the retry converges', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: sixBelowThresholdThreads(), resolveFailIds: ['PRT_S3'] });
        var threw = null;
        try { run(m, f); } catch (e) { threw = e; }
        assert.ok(threw, 'a partial resolution holds the merge');
        assert.contains(threw.message, 'below-threshold resolve failures 1');
        assert.contains(threw.message, 'policy violation');
        assert.equal(f.rec.resolves.length, 5, 'the loop never aborts — every other thread attempted');
        assert.equal(f.rec.replies.length, 5, 'acks only behind successful resolves');
        assert.equal(f.rec.issues.length, 0, 'no digest — the failure is on the ack path');
        f.fixture.resolveFailIds = []; // the transient API fault clears
        var out2 = run(m, f);
        assert.equal(out2.ackResolved, 6, 'the retry resolves all six');
        assert.equal(f.rec.resolves.length, 11, '5 + 6 across the two ticks');
    });

    test('AC2: an ack-reply failure holds the merge; the retry reads the thread resolved (clean replay)', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: [belowThread('PRT_N1', nitBody('a nit'), 5)] });
        var replies = 0;
        f.io.replyToThread = function (a) {
            replies++;
            f.rec.replies.push(a);
            if (replies === 1) throw new Error('boom');
            return '{}';
        };
        var threw = null;
        try { run(m, f); } catch (e) { threw = e; }
        assert.ok(threw, 'the resolution step (resolve + machine ack tag) failed — do NOT merge');
        assert.contains(threw.message, 'ack-reply failures 1');
        f.fixture.threads[0].isResolved = true; // the resolve DID land — GitHub state moved on
        var out2 = run(m, f);
        assert.equal(out2.ackResolved, 0);
        assert.equal(out2.counts.resolved, 1, 'the previous resolve is terminal — no re-ack');
        assert.contains(m.outcomeLines(out2)[0], 'no unresolved machine-owned');
    });

    test('AC3 no-regression replay: one >=IMPORTANT + nits → digest+deferred for the IMPORTANT, wontfix acks for the nits', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: [
            ghThread({ id: 'PRT_1', line: 42 }),
            belowThread('PRT_S1', suggestionBody('extract'), 11),
            belowThread('PRT_N1', nitBody('typo'), 22)
        ] });
        var out = run(m, f);
        assert.equal(out.counted.length, 1, 'the IMPORTANT thread rides the digest path');
        assert.equal(out.digest, 501);
        assert.equal(out.resolved, 1);
        assert.equal(out.ackResolved, 2, 'the two below-threshold threads ack-resolved');
        assert.equal(f.rec.issues.length, 1, 'ONE digest for the >=IMPORTANT thread');
        assert.contains(f.rec.replies[0].text, 'deferred: #501',
            'the >=IMPORTANT thread keeps its canonical deferred tag');
        var wontfixReplies = f.rec.replies.filter(function (r) {
            var p = reviewDispositionsMod().parseDispositionTag(r.text);
            return p && p.tag === 'wontfix';
        });
        assert.equal(wontfixReplies.length, 2, 'the nits ride the wontfix ack path');
    });

    test('an id-less below-threshold machine thread can never resolve — the merge is HELD', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: [belowThread(null, nitBody('a nit'), 5)] });
        var threw = null;
        try { run(m, f); } catch (e) { threw = e; }
        assert.ok(threw, 'no resolve id — terminal resolution is impossible — hold');
        assert.equal(f.rec.resolves.length, 0);
    });

    test('a missing resolveThread primitive with open nits holds the merge (cannot reach terminal resolution)', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: [belowThread('PRT_N1', nitBody('a nit'), 5)] });
        delete f.io.resolveThread;
        var threw = null;
        try { run(m, f); } catch (e) { threw = e; }
        assert.ok(threw,
            'a deployment defect holds the merge and keeps failing the funnel job (the escalation surface)');
    });

    test('outcome line of the ack-only replay says what happened', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: sixBelowThresholdThreads() });
        var line = m.outcomeLines(run(m, f))[0];
        assert.contains(line, '#42');
        assert.contains(line, 'ack-resolved');
        assert.contains(line, 'wontfix');
        assert.contains(line, 'zero open machine-owned threads');
    });

    test('the counted line of a >=IMPORTANT-only replay carries no idle ack-stats fragment (gh-1370 rework)', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: [ghThread({ id: 'PRT_1', line: 42 })] });
        var out = run(m, f);
        assert.equal(out.counted.length, 1, 'the digest path ran');
        assert.equal(out.ackThreads.length, 0, 'nothing below the threshold rode the ack path');
        var line = m.outcomeLines(out)[0];
        assert.contains(line, '#501');
        assert.notContains(line, 'ack-resolved without a fix',
            'a replay with zero ack activity must not embed the idle suggestion/nit fragment');
        assert.notContains(line, 'wontfix',
            'cleanOutcomeLine keeps the pure gh-1353 wording when ackIdle — countedOutcomeLine matches it');
    });

    test('a marker-less machine thread (severity none) rides the ack path — the documented fallthrough (gh-1370 rework)', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: [belowThread('PRT_U1', 'plain prose, no marker', 7)] });
        var out = run(m, f); // must NOT throw — the ack path is the only terminal outcome for an unmarkable thread
        assert.equal(out.counts.machine, 1);
        assert.equal(out.ackThreads.length, 1, 'a marker-less machine thread lands on the ack path');
        assert.equal(out.ackThreads[0].severity, 'SUGGESTION',
            "threadSeverity 'none' → severityClassOf fallback 'SUGGESTION' (findingRegistry)");
        assert.equal(out.ackResolved, 1,
            'auto-acked: holding the merge on an unresolvable classification would never converge');
        assert.contains(f.rec.replies[0].text, 'wontfix:',
            'the ack carries the machine-parsed wontfix disposition');
        assert.equal(f.rec.issues.length, 0, 'no digest — below the gating threshold');
    });
});

// ── the merge-path wiring (runBackstopForPr + githubBridgeIo) ────────────────

suite('mergeBackstop — runProbeForPr (the shared wiring ceremony, gh-1416)', function () {
    test('ONE copy of the ceremony: builds the input, applies extra, runs, says the lines, returns the outcome', function () {
        // PR #1422 round-2 review (duplication ratchet): the verdict gate's
        // runGateForPr mirrored this module's runBackstopForPr wiring
        // line-for-line. The ceremony now lives here ONCE and both probes
        // delegate — this test pins the contract the gate rides.
        var m = mergeBackstopMod();
        var seen = {};
        var sentinel = { prNumber: 42, marked: true };
        var said = [];
        var out = m.runProbeForPr(
            function (bridges, owner, name, input) {
                seen.bridges = bridges; seen.owner = owner; seen.name = name; seen.input = input;
                return sentinel;
            },
            function (o) { return o.marked ? ['line one', 'line two'] : []; },
            { the: 'bridges' }, OWNER, NAME,
            { machineAuthor: MACHINE }, 42,
            { number: 42, headRefOid: 'deadbeefcafe0123456789abcdef' },
            function (line) { said.push(line); },
            function (input) { input.prTitle = 'The Title'; });
        assert.equal(out, sentinel, 'the outcome rides back to the caller');
        assert.equal(seen.owner, OWNER);
        assert.equal(seen.name, NAME);
        assert.equal(seen.bridges.the, 'bridges', 'the io bag passes through untouched');
        assert.equal(seen.input.prNumber, 42);
        assert.equal(seen.input.headSha, 'deadbeefcafe0123456789abcdef', 'headShaOf(pr) drives the head');
        assert.deepEqual(seen.input.logins, [MACHINE], 'the gh-728 logins chain runs');
        assert.equal(typeof seen.input.nowIso, 'string', 'the run is timestamped');
        assert.equal(seen.input.prTitle, 'The Title', 'extra adds the probe-specific keys');
        assert.deepEqual(said, ['line one', 'line two'], 'the outcome lines are said verbatim');
    });

    test('runBackstopForPr delegates to it — no second ceremony copy survives', function () {
        var m = mergeBackstopMod();
        assert.equal(typeof m.runProbeForPr, 'function', 'the ceremony is exported for the gate');
        var f = ioFixture({ threads: [] });
        var said = [];
        var out = m.runBackstopForPr(f.io, OWNER, NAME, { machineAuthor: MACHINE }, 42,
            { number: 42, title: 'T', headRefOid: 'deadbeefcafe0123456789abcdef' },
            function (line) { said.push(line); });
        assert.equal(out.prNumber, 42);
        assert.equal(said.length, 1, 'the shared say loop ran (the clean-replay line)');
        assert.contains(said[0], 'merge backstop on PR #42');
    });
});
suite('mergeBackstop — runBackstopForPr (the merge-path wiring)', function () {
    function runForPr(m, f, over) {
        var said = [];
        var out = m.runBackstopForPr(f.io, OWNER, NAME,
            over && over.job !== undefined ? over.job : { machineAuthor: MACHINE },
            42,
            (over && over.pr) || { number: 42, title: 'Backstop replay PR', headRefOid: 'deadbeefcafe0123456789abcdef' },
            function (line) { said.push(line); });
        return { out: out, said: said };
    }

    test('counted shape: the outcome lines are said and the digest files', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: twoMachineImportantThreads() });
        var r = runForPr(m, f);
        assert.equal(r.out.digest, 501);
        assert.equal(r.out.resolved, 2);
        assert.equal(r.said.length, 1, 'one observable line');
        assert.contains(r.said[0], '#42');
        assert.contains(r.said[0], '#501');
        assert.contains(f.rec.issues[0].body, 'head deadbee',
            'the head sha flowed (short form) into the review-run reference');
    });

    test('REST-shaped PR payload: the head sha rides pr.head.sha', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: twoMachineImportantThreads() });
        var r = runForPr(m, f, { pr: { number: 42, title: 'Rest PR', head: { sha: 'cafe0123456789' } } });
        assert.equal(r.out.digest, 501);
        assert.contains(f.rec.issues[0].body, 'cafe012',
            'headShaOf(pr) reads the REST shape');
    });

    test('a PR payload without head/title (or no payload at all) degrades, never throws', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: twoMachineImportantThreads() });
        var r = runForPr(m, f, { pr: { number: 42, head: {} } });
        assert.equal(r.out.digest, 501, 'the digest still files');
        assert.contains(f.rec.issues[0].body, 'PR #42', 'the title fell back to the PR number');
        assert.contains(f.rec.issues[0].body, 'head ?', 'the missing head reads as unknown, not a crash');
        var bare = runForPr(m, ioFixture({ threads: [] }), { pr: null });
        assert.equal(bare.out.counted.length, 0, 'a null PR payload is a clean replay');
    });

    test('clean shape: merge as today — one clean line, no digest', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: [] });
        var r = runForPr(m, f);
        assert.equal(r.out.counted.length, 0);
        assert.equal(r.out.digest, null);
        assert.equal(f.rec.issues.length, 0);
        assert.contains(r.said[0], 'no unresolved machine-owned');
    });

    test('an empty machine allowlist counts nothing (fail closed, merge as today)', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: twoMachineImportantThreads() });
        var r = runForPr(m, f, { job: {} });
        assert.equal(r.out.counted.length, 0, 'no logins = nothing is machine-owned');
        assert.equal(f.rec.issues.length, 0, 'no digest');
    });

    test('a record-keeping failure throws through — the caller defers the merge', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: twoMachineImportantThreads(), createIssueThrow: '422' });
        var threw = false;
        try { runForPr(m, f); } catch (e) { threw = true; }
        assert.equal(threw, true, 'never silently merge with open >=⚠️ threads and no digest');
        assert.equal(f.rec.resolves.length, 0);
    });

    test('capability miss: no threads primitive skips the backstop (merge as today)', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ noThreads: true });
        var r = runForPr(m, f);
        assert.equal(r.out.skipped, 'no-thread-primitive');
        assert.contains(r.said[0], 'skipped');
    });
});

suite('mergeBackstop — githubBridgeIo (the engine bridge enumeration)', function () {
    test('mocked bridge tools map onto the io keys', function () {
        var gt = function () { return '{}'; };
        var gc = function () { return '[]'; };
        var m = mergeBackstopMod({
            loadProjectConfig: function () { return null; }
        }, {
            github_get_pr_review_threads: gt,
            github_get_pr_comments: gc,
            github_create_comment: function () { return '{}'; },
            github_search_issues: function () { return '{}'; },
            github_create_issue: function () { return '{}'; },
            github_resolve_pr_thread: function () { return '{}'; },
            github_reply_to_pr_thread: function () { return '{}'; }
        });
        var io = m.githubBridgeIo();
        assert.equal(io.getThreads, gt, 'getThreads rides github_get_pr_review_threads');
        assert.equal(io.getComments, gc, 'getComments rides github_get_pr_comments');
        assert.equal(typeof io.createComment, 'function');
        assert.equal(typeof io.searchIssues, 'function');
        assert.equal(typeof io.createIssue, 'function');
        assert.equal(typeof io.resolveThread, 'function');
        assert.equal(typeof io.replyToThread, 'function');
    });

    test('gh-1371 finding 2: headShaOf — one wider derivation (GraphQL headRefOid, REST head.sha, bare head string)', function () {
        var m = mergeBackstopMod();
        assert.equal(m.headShaOf({ headRefOid: 'aa11' }), 'aa11', 'the GraphQL shape wins');
        assert.equal(m.headShaOf({ head: { sha: 'bb22' } }), 'bb22', 'the REST shape');
        assert.equal(m.headShaOf({ head: 'cc33' }), 'cc33', 'older bridges: a bare head string (the wider shape)');
        assert.equal(m.headShaOf({ head: {} }), null);
        assert.equal(m.headShaOf({}), null);
        assert.equal(m.headShaOf(null), null);
        var f = ioFixture({ threads: twoMachineImportantThreads() });
        m.runBackstopForPr(f.io, OWNER, NAME, { machineAuthor: MACHINE }, 42,
            { number: 42, title: 'Bare head PR', head: 'dd44ee' }, function () {});
        assert.contains(f.rec.issues[0].body, 'dd44ee',
            'runBackstopForPr rides the same derivation for a bare-head payload');
    });

    test('bridge tools absent from the runtime map null (capability miss, never a throw)', function () {
        // Every slot absent: the FALSE side of all seven typeof guards is
        // exercised (branch coverage — the true side rides the test above).
        var m = mergeBackstopMod({
            loadProjectConfig: function () { return null; }
        }, {
            github_get_pr_review_threads: undefined,
            github_get_pr_comments: undefined,
            github_create_comment: undefined,
            github_search_issues: undefined,
            github_create_issue: undefined,
            github_resolve_pr_thread: undefined,
            github_reply_to_pr_thread: undefined
        });
        var io = m.githubBridgeIo();
        assert.equal(io.getThreads, null);
        assert.equal(io.getComments, null);
        assert.equal(io.createComment, null);
        assert.equal(io.searchIssues, null);
        assert.equal(io.createIssue, null);
        assert.equal(io.resolveThread, null);
        assert.equal(io.replyToThread, null);
    });
});

// ── gh-1371: the 6 review findings on the gh-1353 backstop ──────────────────

suite('mergeBackstop — gh-1371 review findings', function () {
    test('finding 1: ONE pr-comments read per counted run (the ledger base shares it)', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: twoMachineImportantThreads() });
        var out = run(m, f);
        var reads = f.rec.order.filter(function (k) { return k === 'comments'; }).length;
        assert.equal(reads, 1, 'read once in runBackstop, passed down to the ledger base');
        assert.equal(out.ledgerStampPosted, true, 'the single read still served the ledger append');
        var marker = ledgerMarkerOf(f.rec.posts[0].body);
        assert.equal(marker.findings.length, 2, 'the ledger append consumed that same read');
    });

    test('finding 3: a createIssue response without an issue number throws — no deferred tags against a nonexistent digest', function () {
        var m = mergeBackstopMod();
        ['{}', JSON.stringify({ message: 'Validation Failed' }), JSON.stringify({ number: 0 })]
            .forEach(function (payload) {
                var f = ioFixture({ threads: twoMachineImportantThreads() });
                f.io.createIssue = function () { return payload; };
                var threw = null;
                try { run(m, f); } catch (e) { threw = e; }
                assert.ok(threw, 'payload ' + payload + ' never passes as a digest');
                assert.contains(threw.message, 'no issue number');
                assert.equal(f.rec.resolves.length, 0, 'no thread resolves without a real digest');
                assert.equal(f.rec.replies.length, 0, 'no deferred tag points at a nonexistent digest');
            });
    });

    test('finding 4: a concurrent funnel digest wins post-create — ours is abandoned, tags converge on it', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: twoMachineImportantThreads() });
        var concurrentMarker = reviewDebtLedgerMod().buildDebtMarker(
            m.appendCountedToLedger(null, [
                { threadId: 'RACE', severity: 'IMPORTANT', path: 'a.js',
                  claim: 'nothing validates the merge state token' }
            ], { prNumber: 42, nowIso: '2026-11-05T11:00:00.000Z' }));
        var searches = 0;
        f.io.searchIssues = function () {
            searches++;
            // the pre-create probe: clean; the post-create probe: the
            // concurrent funnel's digest is now visible
            return JSON.stringify({ items: searches === 1 ? [] : [
                { number: 512, title: '[debt] Concurrent funnel', body: 'x\n' + concurrentMarker }
            ] });
        };
        var out = run(m, f);
        assert.equal(out.digest, 512, 'the deferred tags converge on the concurrent digest');
        assert.equal(out.digestReused, true);
        assert.equal(out.digestDuplicate, 501, 'our duplicate is recorded as abandoned');
        assert.contains(f.rec.replies[0].text, 'deferred: #512',
            'no thread points at the abandoned duplicate');
        assert.contains(m.outcomeLines(out)[0], '#501 abandoned',
            'the abandonment is observable in the outcome line');
    });

    test('finding 4: the post-create probe finding only our own digest keeps ours (no false dedup)', function () {
        var m = mergeBackstopMod();
        var f = ioFixture({ threads: twoMachineImportantThreads() });
        var out = run(m, f);
        assert.equal(out.digest, 501);
        assert.equal(out.digestReused, false);
        assert.equal(out.digestDuplicate, null, 'our own issue never reads as a concurrent duplicate');
        assert.contains(f.rec.replies[0].text, 'deferred: #501');
    });

    test('finding 4: findExistingDigest skips the excluded (own just-filed) number', function () {
        var m = mergeBackstopMod();
        var marker = reviewDebtLedgerMod().buildDebtMarker(
            m.appendCountedToLedger(null, [
                { threadId: 'A', severity: 'IMPORTANT', path: 'a.js', claim: 'x' }
            ], { prNumber: 42, nowIso: NOW }));
        var issues = { items: [
            { number: 501, title: '[debt] ours', body: marker },
            { number: 512, title: '[debt] theirs', body: marker }
        ] };
        assert.equal(m.findExistingDigest(issues, 42, 501).number, 512,
            'the PR\'s own just-filed duplicate is skipped');
        assert.equal(m.findExistingDigest(issues, 42).number, 501,
            'no exclusion: the first match, unchanged');
        assert.equal(m.findExistingDigest({ items: issues.items.slice(0, 1) }, 42, 501), null,
            'the only match excluded: no digest to reuse');
    });

    test('finding 5: the injected io bag is never mutated (normalized into a copy)', function () {
        var m = mergeBackstopMod();
        var getThreads = function () { return '[]'; };
        var io = { getThreads: getThreads, getComments: undefined };
        var t = m.githubTools(OWNER, NAME, io);
        assert.equal(io.getThreads, getThreads, 'present functions untouched');
        assert.equal(io.getComments, undefined, 'no null written back onto the caller\'s bag');
        assert.equal('createIssue' in io, false, 'absent keys stay absent');
        assert.equal(typeof t.listThreads, 'function',
            'the copy adapters serve the caller\'s function');
        assert.equal(t.prComments, null, 'the capability-miss null lives in the COPY, not the bag');
        var f = ioFixture({ threads: [] });
        var keysBefore = Object.keys(f.io).sort().join(',');
        run(m, f);
        assert.equal(Object.keys(f.io).sort().join(','), keysBefore,
            'runBackstop leaves the caller\'s io bag untouched');
    });

    test('finding 6: every severity tier renders a labeled cell (unmarked/NIT human threads included)', function () {
        var m = mergeBackstopMod();
        var human = m.classifyThreads([
            { threadId: 'H1', rootCommentId: 1, resolved: false, author: 'human-a',
              body: 'plain prose — no severity marker at all', path: 'a.js', line: 1 },
            { threadId: 'H2', rootCommentId: 2, resolved: false, author: 'human-b',
              body: nitBody('a human nit'), path: 'b.js', line: 2 },
            { threadId: 'H3', rootCommentId: 3, resolved: false, author: 'human-c',
              body: suggestionBody('extract this'), path: 'c.js', line: 3 }
        ], ALLOW).human;
        var counted = m.classifyThreads([
            { threadId: 'M1', rootCommentId: 4, resolved: false, author: MACHINE,
              body: importantBody(), path: 'd.js', line: 4 },
            { threadId: 'M2', rootCommentId: 5, resolved: false, author: MACHINE,
              body: blockingBody(), path: 'e.js', line: 5 }
        ], ALLOW).counted;
        var issue = m.buildDigestIssue({
            owner: OWNER, name: NAME, prNumber: 42, prTitle: 'Labels',
            counted: counted, human: human, reviewRunRef: 'ref',
            ledger: m.appendCountedToLedger(null, counted, { prNumber: 42, nowIso: NOW })
        });
        assert.contains(issue.body, '🚨 BLOCKING', 'the blocking tier is labeled');
        assert.contains(issue.body, '⚠️ IMPORTANT', 'the important tier is labeled');
        assert.contains(issue.body, '💡 SUGGESTION', 'the suggestion tier is labeled too');
        assert.notContains(issue.body, '| SUGGESTION', 'no bare unlabeled class leaks into a cell');
        assert.equal(human.length, 3, 'the three human tiers all land in the human table');
    });
});

// ── gh-1371 round 2: the rework lap (CI ratchet + race determinism) ─────────

suite('mergeBackstop — gh-1371 round 2 rework (ratchet + race determinism)', function () {
    test('CI ratchet #2 + thread 3: digestNumberOf — the string branch is covered AND positive-gated', function () {
        var m = mergeBackstopMod();
        assert.equal(m.digestNumberOf({ number: 512 }), 512, 'the numeric shape (unchanged)');
        assert.equal(m.digestNumberOf({ number: '512' }), 512,
            'the string shape the bridge envelopes carry — now COVERED (was the CRAP 8.3 hole)');
        assert.equal(m.digestNumberOf({ number: ' 512 ' }), 512, 'whitespace-padded strings parse');
        assert.equal(m.digestNumberOf({ number: 'x' }), null, 'junk strings are null (now COVERED)');
        assert.equal(m.digestNumberOf({ number: '' }), null, 'the empty string is null');
        assert.equal(m.digestNumberOf({ number: '0' }), null,
            "'0' contradicts the documented positive contract — null (was 0)");
        assert.equal(m.digestNumberOf({ number: '-3' }), null,
            "'-3' contradicts the documented positive contract — null (was -3)");
        assert.equal(m.digestNumberOf({ number: 0 }), null, 'numeric zero is null (unchanged)');
        assert.equal(m.digestNumberOf({ number: NaN }), null, 'non-finite numerics are null');
        assert.equal(m.digestNumberOf({}), null, 'no number slot is null');
        assert.equal(m.digestNumberOf(null), null, 'no payload is null');
    });

    test('thread 2: findExistingDigest picks DETERMINISTICALLY — the lowest number wins, regardless of search order', function () {
        var m = mergeBackstopMod();
        var marker = reviewDebtLedgerMod().buildDebtMarker(
            m.appendCountedToLedger(null, [
                { threadId: 'A', severity: 'IMPORTANT', path: 'a.js', claim: 'x' }
            ], { prNumber: 42, nowIso: NOW }));
        var dup = function (n) {
            return { number: n, title: '[debt] Backstop replay PR', body: 'x\n' + marker };
        };
        // the race outcome: TWO open digests carry this PR's marker (the
        // abandoned duplicate is still open — there is no close primitive).
        // GitHub issue-search order is best-match (opaque) — the pick must
        // not depend on it.
        assert.equal(m.findExistingDigest({ items: [dup(520), dup(505)] }, 42).number, 505,
            'best-match order listed the newer digest first — the lowest number still wins');
        assert.equal(m.findExistingDigest({ items: [dup(505), dup(520)] }, 42).number, 505,
            'the reversed order picks the SAME issue (deterministic tie-break)');
        assert.equal(m.findExistingDigest({ items: [dup(505), dup(520)] }, 42, 505).number, 520,
            'the exclusion still wins over the tie-break (the post-create probe skips our own filing)');
        assert.equal(m.findExistingDigest({ items: [dup(505), dup(520)] }, 42, 505).reused, true,
            'the adopted digest keeps its shape (number, title, reused)');
        assert.equal(m.findExistingDigest({ issues: [dup(520), dup(505)] }, 42).number, 505,
            'the {issues} envelope shape is handled too (full branch cover of digestIssueList)');
    });

    test('thread 2: the race echo lands in the PR ledger stamp — the sweep can see the abandoned duplicate', function () {
        var m = mergeBackstopMod();
        var concurrentMarker = reviewDebtLedgerMod().buildDebtMarker(
            m.appendCountedToLedger(null, [
                { threadId: 'RACE', severity: 'IMPORTANT', path: 'a.js',
                  claim: 'nothing validates the merge state token' }
            ], { prNumber: 42, nowIso: '2026-11-05T11:00:00.000Z' }));
        var f = ioFixture({ threads: twoMachineImportantThreads() });
        var searches = 0;
        f.io.searchIssues = function () {
            searches++;
            // pre-create probe: clean; post-create probe: the concurrent
            // funnel's digest is now visible
            return JSON.stringify({ items: searches === 1 ? [] : [
                { number: 512, title: '[debt] Concurrent funnel', body: 'x\n' + concurrentMarker }
            ] });
        };
        var out = run(m, f);
        assert.equal(out.digestDuplicate, 501, 'the race scenario from the finding-4 test');
        assert.equal(f.rec.posts.length, 1, 'still one ledger stamp comment');
        assert.contains(f.rec.posts[0].body, '#501',
            'the stamp carries the abandoned number for the part-3 sweep');
        assert.contains(f.rec.posts[0].body, 'abandoned', 'the abandonment is said, not silent');
        assert.ok(ledgerMarkerOf(f.rec.posts[0].body), 'the echo never breaks the machine marker');
        // the clean path never advertises a duplicate
        var f2 = ioFixture({ threads: twoMachineImportantThreads() });
        var out2 = run(m, f2);
        assert.equal(out2.digestDuplicate, null);
        assert.notContains(f2.rec.posts[0].body, 'abandoned',
            'no duplicate — no echo (the stamp stays clean)');
    });
});
