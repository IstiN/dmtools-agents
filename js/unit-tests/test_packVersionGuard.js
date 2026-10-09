/**
 * Unit tests: the pack-release version guard (gh-812).
 *
 * Guards the gh-812 root cause (live 2026-10-09): the release builder
 * derived pack versions from versions.json on main — a ledger whose push
 * back to main is best-effort (a rejected direct push only warns). The
 * ledger never landed, so EIGHT consecutive releases (20261008-095538 →
 * 20261009-091304) all advertised sm_github: 0.1.36 while the content
 * changed underneath; 091304 republished a DIFFERENT sm_github-0.1.36.zip
 * (sha256 20352463… vs 0dc62ca4… from 075526) and version-keyed consumer
 * caches ran mixed content — every fa machine-sm tick red for ~25 min.
 *
 * The guard (ci/pack_version_guard.cjs) encodes the gh-812 contract:
 *   V1 the shipped version beats the ledger — the release history is
 *      append-only and cannot lie; versions.json can (and did).
 *   V2 an affected agent bumps from the SHIPPED base, never re-shipping a
 *      version that is already out there with other content.
 *   V3 a rebuilt-but-unbumped agent whose payload differs from what its
 *      unchanged version already shipped gets an extra patch bump —
 *      two releases with differing pack content NEVER share a version
 *      string (gh-812 AC2).
 *   V4 the payload fingerprint covers file paths + sha256 only — manifest
 *      metadata (version, sourceCommit) changes on every rebuild and must
 *      not force a bump by itself.
 *
 * Uses: loadModule(), suite(), test(), assert
 */

'use strict';

/* global loadModule, assert, test, suite */

function guard() {
    return loadModule('ci/pack_version_guard.cjs');
}

var PREV_MANIFEST = JSON.stringify({
    agent: 'sm_github',
    version: '0.1.36',
    sourceCommit: 'aaa',
    files: [
        { path: 'js/smAgent.js', sha256: 'hash-a', mode: '0644' },
        { path: 'js/common/smProvider.js', sha256: 'hash-b', mode: '0644' },
    ],
});

var SAME_PAYLOAD_MANIFEST = JSON.stringify({
    agent: 'sm_github',
    version: '0.1.37',
    sourceCommit: 'bbb',
    files: [
        { path: 'js/smAgent.js', sha256: 'hash-a', mode: '0644' },
        { path: 'js/common/smProvider.js', sha256: 'hash-b', mode: '0644' },
    ],
});

var CHANGED_PAYLOAD_MANIFEST = JSON.stringify({
    agent: 'sm_github',
    version: '0.1.37',
    sourceCommit: 'bbb',
    files: [
        { path: 'js/smAgent.js', sha256: 'hash-a2', mode: '0644' },
        { path: 'js/common/smProvider.js', sha256: 'hash-b', mode: '0644' },
        { path: 'js/common/reviewVerdicts.js', sha256: 'hash-c', mode: '0644' },
    ],
});

// ── V4: payload fingerprint ──────────────────────────────────────────────────

suite('version guard: payload fingerprint', function () {

    test('identical payloads fingerprint identically across versions and commits', function () {
        // The same files array with a different version/sourceCommit is the
        // same payload — the fingerprint must not see a difference (V4).
        assert.equal(guard().payloadFingerprint(PREV_MANIFEST),
            guard().payloadFingerprint(SAME_PAYLOAD_MANIFEST));
    });

    test('a changed file hash changes the fingerprint', function () {
        assert.ok(guard().payloadFingerprint(PREV_MANIFEST) !==
            guard().payloadFingerprint(CHANGED_PAYLOAD_MANIFEST));
    });

    test('an added file changes the fingerprint (the 075526 → 091304 diff)', function () {
        // The real incident diff was exactly this: one file added
        // (js/common/reviewVerdicts.js), everything else identical.
        assert.ok(guard().payloadFingerprint(PREV_MANIFEST) !==
            guard().payloadFingerprint(CHANGED_PAYLOAD_MANIFEST));
    });

    test('file ORDER does not change the fingerprint', function () {
        var reordered = JSON.stringify({
            files: [
                { path: 'js/common/smProvider.js', sha256: 'hash-b', mode: '0644' },
                { path: 'js/smAgent.js', sha256: 'hash-a', mode: '0644' },
            ],
        });
        assert.equal(guard().payloadFingerprint(PREV_MANIFEST),
            guard().payloadFingerprint(reordered));
    });

    test('fingerprintsDiffer: same payload false, changed payload true, missing prev false', function () {
        assert.equal(guard().fingerprintsDiffer(PREV_MANIFEST, SAME_PAYLOAD_MANIFEST), false);
        assert.equal(guard().fingerprintsDiffer(PREV_MANIFEST, CHANGED_PAYLOAD_MANIFEST), true);
        assert.equal(guard().fingerprintsDiffer(null, CHANGED_PAYLOAD_MANIFEST), false,
            'no previous artifact to compare against — never force a bump from nothing');
        assert.equal(guard().fingerprintsDiffer(PREV_MANIFEST, null), false);
    });
});

// ── V4 (gh-812 rework, review thread 5): mode is part of the fingerprint ─────

suite('version guard: payload fingerprint covers manifest mode', function () {

    test('a MODE-only difference changes the fingerprint (same bytes, different mode)', function () {
        // The launch-surface augment folds mode into the manifest (0755 for
        // verdict.sh) and zip entries CARRY the unix mode: a contract change
        // that flips an entry's mode with identical bytes produces different
        // zip bytes that must never be republished under the shipped
        // version — the mode is part of the payload.
        var modeFlipped = JSON.stringify({
            agent: 'sm_github',
            version: '0.1.36',
            sourceCommit: 'aaa',
            files: [
                { path: 'js/smAgent.js', sha256: 'hash-a', mode: '0644' },
                { path: 'js/common/smProvider.js', sha256: 'hash-b', mode: '0755' },
            ],
        });
        assert.ok(guard().payloadFingerprint(PREV_MANIFEST) !== guard().payloadFingerprint(modeFlipped),
            'a mode flip with identical bytes is a content change');
    });

    test('fingerprintsDiffer sees a mode-only difference', function () {
        var modeFlipped = JSON.stringify({
            agent: 'sm_github',
            version: '0.1.36',
            sourceCommit: 'aaa',
            files: [
                { path: 'js/smAgent.js', sha256: 'hash-a', mode: '0644' },
                { path: 'js/common/smProvider.js', sha256: 'hash-b', mode: '0755' },
            ],
        });
        assert.equal(guard().fingerprintsDiffer(PREV_MANIFEST, modeFlipped), true,
            'the drift check must re-version a mode-only payload change instead of ' +
            'republishing different zip bytes under the already-shipped version');
    });

    test('identical payloads including modes still fingerprint identically (no churn)', function () {
        assert.equal(guard().payloadFingerprint(PREV_MANIFEST),
            guard().payloadFingerprint(SAME_PAYLOAD_MANIFEST));
    });

    test('manifest entries without a mode still fingerprint (mode defaults to empty)', function () {
        // Older/non-teammate manifests carry no mode field — fingerprinting
        // must not crash and must treat absent mode as ''.
        var modeless = JSON.stringify({
            files: [{ path: 'js/smAgent.js', sha256: 'hash-a' }],
        });
        assert.ok(guard().payloadFingerprint(modeless));
        assert.equal(guard().fingerprintsDiffer(modeless, modeless), false);
    });
});

// ── V1/V2: base version resolution ───────────────────────────────────────────

suite('version guard: base version resolution (V1/V2)', function () {

    test('V1: the shipped version wins over a stale ledger', function () {
        // The 091304 run: main's ledger said 0.1.35, the previous release
        // (075526) had SHIPPED 0.1.36. Bumping from the ledger re-shipped
        // 0.1.36 with new content — the incident. The shipped version is
        // the base.
        assert.equal(guard().resolveBaseVersion('0.1.35', '0.1.36'), '0.1.36');
    });

    test('the ledger is the fallback when no release shipped the agent yet', function () {
        assert.equal(guard().resolveBaseVersion('0.1.35', null), '0.1.35');
    });

    test('a brand-new agent starts at 0.1.0', function () {
        assert.equal(guard().resolveBaseVersion(null, null), '0.1.0');
    });

    test('V2: an affected agent bumps from the shipped base', function () {
        assert.equal(guard().resolveCandidateVersion('0.1.36', 'patch', true), '0.1.37');
        assert.equal(guard().resolveCandidateVersion('0.1.36', 'minor', true), '0.2.0');
        assert.equal(guard().resolveCandidateVersion('0.1.36', 'major', true), '1.0.0');
    });

    test('an unaffected agent keeps the shipped version', function () {
        assert.equal(guard().resolveCandidateVersion('0.1.36', 'patch', false), '0.1.36');
    });
});

// ── V3: content-vs-version uniqueness (AC2) ──────────────────────────────────

suite('version guard: two releases with differing content never share a version (V3/AC2)', function () {

    test('V3: a rebuilt unbumped agent with changed payload gets an extra patch bump', function () {
        // Build at the unchanged shipped version, compare payloads against
        // what that version already shipped: different content under the
        // same version is exactly the gh-812 collision — bump again.
        assert.equal(
            guard().resolveShipVersion('0.1.36', guard().fingerprintsDiffer(PREV_MANIFEST, CHANGED_PAYLOAD_MANIFEST)),
            '0.1.37');
    });

    test('a rebuilt unbumped agent with IDENTICAL payload keeps the version', function () {
        // Byte-identical rebuild (same inputs, deterministic zip) is the
        // same pack — no churn.
        assert.equal(
            guard().resolveShipVersion('0.1.36', guard().fingerprintsDiffer(PREV_MANIFEST, SAME_PAYLOAD_MANIFEST)),
            '0.1.36');
    });

    test('no previous artifact → no forced bump', function () {
        assert.equal(guard().resolveShipVersion('0.1.36', false), '0.1.36');
    });

    test('incident replay: 091304 would have shipped sm_github-0.1.37, not a second 0.1.36', function () {
        // End-to-end over the pure API, using the incident's real numbers:
        // ledger 0.1.35 (stale), 075526 shipped 0.1.36, PR #810 changed js/
        // (sm_github affected). Phases mirror release_packs.mjs.
        var g = guard();
        var base = g.resolveBaseVersion('0.1.35', '0.1.36'); // V1: shipped wins
        var candidate = g.resolveCandidateVersion(base, 'patch', true); // affected
        assert.equal(candidate, '0.1.37');
        assert.notEqual(candidate, '0.1.36',
            'the version that already shipped different content must never be reused');
    });

    test('incident replay, unaffected path: content drift alone forces the bump', function () {
        // An agent NOT in the affected set whose rebuilt payload differs
        // from its shipped version must still move (the collision class is
        // not limited to affected agents).
        var g = guard();
        var base = g.resolveBaseVersion('0.1.34', '0.1.36');
        var candidate = g.resolveCandidateVersion(base, 'patch', false);
        assert.equal(candidate, '0.1.36');
        var shipped = g.resolveShipVersion(candidate, true);
        assert.equal(shipped, '0.1.37');
    });
});
