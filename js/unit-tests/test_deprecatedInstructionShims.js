/**
 * Unit tests: the deprecated v1 instruction shims (the 2026-11-12 owner
 * decision — backward compatibility for downstream repos that pin the OLD
 * instruction paths in their own .dmtools configs).
 *
 * The v1 shims are FROZEN files restored under their pre-split paths:
 *   - 3 renames carry the live v2 content verbatim (banner-prepended);
 *   - 4 deleted/split files carry their pre-split content verbatim from
 *     git history (banner-prepended).
 *
 * Guards, per shim:
 *   S1 exists + opens with the DEPRECATED banner (an agent opening the file
 *      sees the migration notice before anything else);
 *   S2 the live v2 target(s) referenced in the banner exist and are
 *      non-empty;
 *   S3 rename-copies stay byte-identical to their live v2 file after the
 *      banner (mechanical sync for the deprecation window — v1 must never
 *      silently diverge from v2).
 *
 * Plus H1: the pack-reachability hub lists every shim path
 * (test_instructionRefs R2/R3 keep the otherwise-live directories fully
 * reachable ONLY through the hub — a shim added without a hub entry would
 * not ship in pack zips while runners still pin pack:<v1-path> — the
 * #600 crash class).
 */

// shim path -> { kind: 'copy'|'frozen', live: [v2 paths] }
var SHIMS = {
    'instructions/pr_review/formatting_rules.md':
        { kind: 'copy', live: ['instructions/pr_review/base/formatting_rules.md'] },
    'instructions/pr_review/review_verdict_rules.md':
        { kind: 'copy', live: ['instructions/pr_review/base/review_verdict_rules.md'] },
    'instructions/pr_review/few_shots.md':
        { kind: 'copy', live: ['instructions/pr_review/generalist/few_shots.md'] },
    'instructions/pr_review/general_guidelines.md':
        { kind: 'frozen', live: ['instructions/pr_review/generalist/lens.md',
            'instructions/pr_review/base/input_context.md',
            'instructions/pr_review/base/registry_protocol.md'] },
    'instructions/pr_review/output_rules.md':
        { kind: 'frozen', live: ['instructions/pr_review/base/output_rules.md',
            'instructions/pr_review/base/input_context.md'] },
    'instructions/pr_test_automation_review/output_rules.md':
        { kind: 'frozen', live: ['instructions/pr_review/base/output_rules.md'] },
    'instructions/pr_test_automation_review/formatting_rules.md':
        { kind: 'frozen', live: ['instructions/pr_review/base/formatting_rules.md'] }
};

var HUB = 'instructions/pr_review/deprecated-v1.md';
var BANNER_MARK = 'DEPRECATED v1 shim';

function readText(p) {
    try {
        var c = file_read({ path: p });
        if (c === null || c === undefined) return null;
        return typeof c === 'string' ? c : String(c);
    } catch (e) {
        return null;
    }
}

suite('deprecated v1 instruction shims — backward-compat freeze', function () {

    test('every shim exists and opens with the DEPRECATED banner (S1)', function () {
        Object.keys(SHIMS).forEach(function (shimPath) {
            var text = readText(shimPath);
            assert.ok(text !== null, shimPath + ' must exist (downstream configs pin it)');
            var head = String(text).substring(0, 400);
            assert.ok(head.indexOf(BANNER_MARK) !== -1,
                shimPath + ' must open with the deprecation banner');
            assert.ok(head.indexOf('next major') !== -1,
                shimPath + ' banner must state the removal window');
        });
    });

    test('every banner names live v2 targets that exist and are non-empty (S2)', function () {
        Object.keys(SHIMS).forEach(function (shimPath) {
            SHIMS[shimPath].live.forEach(function (livePath) {
                var text = readText(livePath);
                assert.ok(text !== null && String(text).trim().length > 0,
                    shimPath + ' banner points at missing/empty live file: ' + livePath);
            });
        });
    });

    test('rename-copies stay byte-identical to their live v2 file after the banner (S3)', function () {
        Object.keys(SHIMS).forEach(function (shimPath) {
            if (SHIMS[shimPath].kind !== 'copy') return;
            var shim = readText(shimPath);
            SHIMS[shimPath].live.forEach(function (livePath) {
                var live = readText(livePath);
                assert.ok(shim !== null && live !== null);
                assert.ok(String(shim).indexOf(String(live)) !== -1,
                    shimPath + ' content must contain the live ' + livePath +
                    ' verbatim — the v1 copy drifted (update the shim in the same commit)');
            });
        });
    });

    test('the pack-reachability hub lists every shim path (H1 — #600 crash class)', function () {
        var hub = readText(HUB);
        assert.ok(hub !== null, HUB + ' must exist (it keeps the shims pack-reachable)');
        Object.keys(SHIMS).forEach(function (shimPath) {
            assert.ok(hub.indexOf(shimPath) !== -1,
                HUB + ' must reference the shim ' + shimPath +
                ' — an unlisted shim is unreachable and never ships in pack zips');
        });
    });

    test('a reachable base file anchors the hub (the hub itself must be pack-reachable)', function () {
        var anchor = readText('instructions/pr_review/base/input_context.md');
        assert.ok(anchor !== null);
        assert.ok(String(anchor).indexOf(HUB) !== -1,
            'instructions/pr_review/base/input_context.md must reference ' + HUB +
            ' — without the anchor the hub (and through it every shim) drops out of the pack');
    });
});
