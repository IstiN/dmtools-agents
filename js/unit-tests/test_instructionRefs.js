/**
 * Unit tests: pack reference integrity for instructions/
 *
 * Guards the incident class of 2026-10-01:
 *   - #600: github_comment_format.md was moved into instructions/common/
 *     without a reference from the base agent configs, so `dmtools compile`
 *     shipped pack zips WITHOUT it while dmd/fa runners referenced
 *     pack:instructions/common/github_comment_format.md (live dev-leg crash).
 *   - #605: review_verdict_rules.md — same class for pr_review (live
 *     review-leg crash on pr-320).
 *
 * Invariant: `dmtools compile` packs only files reachable from the base
 * agent configs — path references anywhere in the config JSON, transitively
 * through path references inside the referenced .md/.js files. Therefore:
 *
 *   R1 dangling  — every instructions|js path referenced by a config must
 *                  exist on disk (typos and wrong moves fail loudly).
 *   R2 mixed dir — if a directory under instructions/ contains ANY reachable
 *                  file, every file in it must be reachable. Allowlist:
 *                  KNOWN_ORPHANS below (curated debt — shrinking only,
 *                  never add entries without a linked issue).
 *   R3 named dir — instructions/<X>/ where a base config <X>.json exists
 *                  must be fully reachable: the <X> pack is compiled from
 *                  <X>.json, an unpacked sibling is a future pack:- crash.
 *   R4 anchors   — the two incident files are asserted reachable explicitly,
 *                  so they can never regress even if the allowlist grows.
 *
 * NOTE on paths: tests run with cwd = agents/, while the base configs and
 * instructions/ live at the repository root — hence the '../' prefixes in
 * fsPath() and the rebase of file_list()'s absolute entries.
 */

// ── curated debt: unreachable files in otherwise-live directories ────────────
// Each entry needs a linked issue deciding reference-vs-delete.
var KNOWN_ORPHANS = [
    'instructions/common/bash_tools.md',
    'instructions/common/investigate_before_answer.md',
    'instructions/common/investigate_before_questioning.md',
    'instructions/common/json_validation.md',
    'instructions/pr_story_test_automation_review/general_guidelines.md',
    'instructions/story_questions/file_handling.md',
    'instructions/test_automation/mobile_test_instructions.md',
    'instructions/test_automation/pr_test_review_instructions.md'
];

// Directories that are 100% legacy (no reachable file at all) are skipped by
// R2/R3 wholesale — they are pre-restructure leftovers awaiting a cleanup PR.
// A directory leaves this list the moment any of its files becomes reachable.
var LEGACY_DIRS = [
    'instructions/bug',
    'instructions/development',
    'instructions/enhancement',
    'instructions/intake',
    'instructions/platform',
    'instructions/review',
    'instructions/rework',
    'instructions/scm'
];

// Known dangling references — TEXT pointers inside JS actions that mention
// files which never existed in git (prepareBugFixBatchContext.js points the
// CLI agent at agents/instructions/bug_fix_development/*.md; only
// bug_fix_batch_development/batch_scope.md exists). Tracked in the linked
// issue; fix = retarget the JS to real files, then shrink this list.
var KNOWN_DANGLING = [
    'instructions/bug_fix_development/analysis.md',
    'instructions/bug_fix_development/finalization.md',
    'instructions/bug_fix_development/implementation.md',
    'instructions/bug_fix_development/scope.md',
    'instructions/bug_fix_development/setup.md',
    'instructions/bug_fix_development/verification.md'
];

var REF_PAT = /(agents\/)?((?:instructions|js)\/[A-Za-z0-9_\-./]+\.(?:md|js))/g;

// Repo root = the job's working directory (tests run with cwd = the repo
// root). Resolved once as the parent of any file_list('.') entry — absolute
// entries are portable, relative paths are not. Deliberately NOT derived from
// an '/agents/' path segment: when this repo is checked out as the `agents`
// submodule of dmtools that segment is the checkout itself and the derived
// root pointed one level too high (every reference read then failed, and the
// closure was silently empty).
var ROOT = (function () {
    var out = file_list('.');
    if (typeof out === 'string') out = JSON.parse(out);
    var entries = ((out && out.entries) || []).map(function (e) { return String(e).replace(/\\/g, '/'); });
    for (var i = 0; i < entries.length; i++) {
        var cut = entries[i].lastIndexOf('/');
        if (cut > 0) return entries[i].slice(0, cut);
    }
    return '.';
})();

// repo-relative path -> absolute filesystem path
function fsPath(p) { return ROOT + '/' + p; }

function rebase(p) {
    if (p.indexOf('./') === 0) p = p.slice(2);
    if (p.indexOf('agents/') === 0) p = p.slice(7);
    return p;
}

// file_read is the direct host function — it takes an OBJECT argument
// ({path}) and returns null on any failure; file_exists returns
// {exists: bool} via the generated wrapper.
function existsOnDisk(p) {
    var r = file_exists(fsPath(p));
    if (r && typeof r === 'object') return r.exists === true;
    return r === true;
}

function readText(p) {
    var c = file_read({ path: fsPath(p) });
    if (c === null || c === undefined) return null;
    return typeof c === 'string' ? c : String(c);
}

// file_list(dir) -> { entries: [absolute paths] }; returns repo-relative names
function listNames(dir) {
    var out = file_list(fsPath(dir));
    if (typeof out === 'string') out = JSON.parse(out);
    var entries = (out && out.entries) || [];
    return entries.map(function (e) {
        var s = String(e).replace(/\\/g, '/');
        var cut = s.indexOf('/instructions/');
        if (cut !== -1) return s.slice(cut + 1);
        var slash = s.lastIndexOf('/');
        return slash === -1 ? s : s.slice(slash + 1);
    }).filter(function (n) { return n && n[0] !== '.'; });
}

// Recursively collect repo-relative 'instructions/**.md' paths.
function collectInstructionFiles(dir, acc) {
    acc = acc || {};
    var out = file_list(fsPath(dir));
    if (typeof out === 'string') out = JSON.parse(out);
    ((out && out.entries) || []).forEach(function (e) {
        var s = String(e).replace(/\\/g, '/');
        var cut = s.indexOf('/instructions/');
        var rel = cut !== -1 ? s.slice(cut + 1) : dir + '/' + s.slice(s.lastIndexOf('/') + 1);
        var name = rel.slice(rel.lastIndexOf('/') + 1);
        if (name[0] === '.') return;
        if (/\.md$/.test(rel)) {
            acc[rel] = true;
        } else if (file_exists(s) === true) {
            collectInstructionFiles(rel, acc); // subdirectory (absolute probe)
        }
    });
    return acc;
}

// Build the union reference closure of all root configs.
// Returns { reachable: {path->true}, dangling: [path] }.
function buildClosure() {
    var reachable = {};
    var dangling = {};
    var queue = [];

    function scanFile(p) {
        if (reachable[p]) return;
        var txt = readText(p);
        if (txt === null) {
            throw new Error('cannot read referenced file: ' + p);
        }
        reachable[p] = true;
        var m;
        REF_PAT.lastIndex = 0;
        while ((m = REF_PAT.exec(txt)) !== null) {
            queue.push(rebase(m[2]));
        }
    }

    listNames('.').forEach(function (name) {
        if (name.slice(-5) !== '.json' || name === 'versions.json') return;
        var cfg;
        var raw = readText(name);
        if (raw === null) {
            throw new Error('cannot read base config: ' + name);
        }
        try { cfg = JSON.parse(raw); } catch (e) { return; }
        (function walk(x) {
            if (typeof x === 'string') {
                if (/\.(md|js)$/.test(x) && x.indexOf('/') !== -1) queue.push(rebase(x));
            } else if (Array.isArray(x)) {
                x.forEach(walk);
            } else if (x && typeof x === 'object') {
                Object.keys(x).forEach(function (k) { walk(x[k]); });
            }
        })(cfg);
    });

    while (queue.length) {
        var p = queue.pop();
        if (existsOnDisk(p)) scanFile(p);
        else if (/^instructions\//.test(p)) dangling[p] = true;
    }
    return { reachable: reachable, dangling: Object.keys(dangling) };
}

function dirOf(p) { return p.slice(0, p.lastIndexOf('/')); }

function isLegacy(dir) { return LEGACY_DIRS.indexOf(dir) !== -1; }

// ── tests ────────────────────────────────────────────────────────────────────

suite('instructionRefs — pack reference integrity', function () {

    test('R1: no config references a non-existent instruction/js file', function () {
        var c = buildClosure();
        var real = c.dangling.filter(function (p) {
            return KNOWN_DANGLING.indexOf(p) === -1;
        });
        assert.deepEqual(real, [],
            'dangling references (file moved or typo?): ' + real.join(', '));
    });

    test('R2: live instruction directories are fully reachable', function () {
        var c = buildClosure();
        var files = Object.keys(collectInstructionFiles('instructions'));
        var byDir = {};
        files.forEach(function (f) {
            var d = dirOf(f);
            byDir[d] = byDir[d] || { any: false, missing: [] };
            if (c.reachable[f]) byDir[d].any = true;
            else if (KNOWN_ORPHANS.indexOf(f) === -1) byDir[d].missing.push(f);
        });
        var violators = [];
        Object.keys(byDir).forEach(function (d) {
            if (byDir[d].any && !isLegacy(d) && byDir[d].missing.length) {
                violators.push(d + ': ' + byDir[d].missing.join(', '));
            }
        });
        assert.deepEqual(violators, [],
            'files present in a live directory but never packed ' +
            '(reference them from the base config or delete them): ' +
            violators.join(' | '));
    });

    test('R3: directories named after a base config are fully reachable', function () {
        var c = buildClosure();
        var files = Object.keys(collectInstructionFiles('instructions'));
        var configs = {};
        listNames('.').forEach(function (n) {
            if (n.slice(-5) === '.json' && n !== 'versions.json') configs[n.slice(0, -5)] = true;
        });
        var violators = [];
        files.forEach(function (f) {
            var d = dirOf(f);
            var base = d.slice('instructions/'.length);
            if (configs[base] && !c.reachable[f] && !isLegacy(d) &&
                KNOWN_ORPHANS.indexOf(f) === -1) {
                violators.push(f + ' (not referenced by ' + base + '.json)');
            }
        });
        assert.deepEqual(violators, [],
            'pack for these configs would miss files that belong to them: ' +
            violators.join(' | '));
    });

    test('R4: incident regression anchors stay packed (#600, #605)', function () {
        var c = buildClosure();
        assert.ok(c.reachable['instructions/common/github_comment_format.md'],
            '#600 regression: github_comment_format.md is no longer reachable ' +
            '— story_development/bug_development/pr_review/pr_rework packs ' +
            'would ship without it (live crash 2026-10-01)');
        assert.ok(c.reachable['instructions/pr_review/review_verdict_rules.md'],
            '#605 regression: review_verdict_rules.md is no longer reachable ' +
            '— the pr_review pack would ship without it (live crash pr-320)');
    });
});
