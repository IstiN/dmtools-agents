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
// Emptied in gh-1147 after deleting all 44 verified-unreachable legacy .md files.
var KNOWN_ORPHANS = [];

// Directories that are 100% legacy (no reachable file at all) are skipped by
// R2/R3 wholesale. Emptied in gh-1147 after deleting all legacy directories.
var LEGACY_DIRS = [];

// Known dangling references — emptied in gh-1292 after retargeting
// batch_scope.md and prepareBugFixBatchContext.js to bug_development/*.md.
var KNOWN_DANGLING = [];

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

function listEntries(dir) {
    var out = file_list(fsPath(dir));
    if (typeof out === 'string') out = JSON.parse(out);
    return (out && out.entries) || [];
}

function toRelFromRootDir(s, dir) {
    var cut = s.indexOf('/instructions/');
    if (cut === -1) cut = s.indexOf('/prompts/');
    return cut !== -1 ? s.slice(cut + 1) : dir + '/' + s.slice(s.lastIndexOf('/') + 1);
}

// file_list(dir) -> { entries: [absolute paths] }; returns repo-relative names
function listNames(dir) {
    return listEntries(dir).map(function (e) {
        var s = String(e).replace(/\\/g, '/');
        var cut = s.indexOf('/instructions/');
        if (cut !== -1) return s.slice(cut + 1);
        var slash = s.lastIndexOf('/');
        return slash === -1 ? s : s.slice(slash + 1);
    }).filter(function (n) { return n && n[0] !== '.'; });
}

// Recursively collect repo-relative '<rootDir>/**.md' paths.
function collectInstructionFiles(dir, acc) {
    acc = acc || {};
    listEntries(dir).forEach(function (e) {
        var s = String(e).replace(/\\/g, '/');
        var rel = toRelFromRootDir(s, dir);
        if (rel.slice(rel.lastIndexOf('/') + 1)[0] === '.') return;
        if (/\.md$/.test(rel)) acc[rel] = true;
        else if (file_exists(s) === true) collectInstructionFiles(rel, acc);
    });
    return acc;
}

// gh-1230 CRAP: pure — queue every path-shaped .md/.js reference found in a
// parsed config value, recursing through arrays and objects.
function queueConfigReferences(x, queue) {
    if (typeof x === 'string') {
        if (/\.(md|js)$/.test(x) && x.indexOf('/') !== -1) queue.push(rebase(x));
    } else if (Array.isArray(x)) {
        x.forEach(function (v) { queueConfigReferences(v, queue); });
    } else if (x && typeof x === 'object') {
        Object.keys(x).forEach(function (k) { queueConfigReferences(x[k], queue); });
    }
}

// gh-1230 CRAP: queue the references of one root config file. Non-JSON names
// and versions.json are skipped; invalid JSON configs parse to a skip.
function queueRootConfigReferences(name, queue) {
    if (name.slice(-5) !== '.json' || name === 'versions.json') return;
    var raw = readText(name);
    if (raw === null) {
        throw new Error('cannot read base config: ' + name);
    }
    var cfg;
    try { cfg = JSON.parse(raw); } catch (e) { return; }
    queueConfigReferences(cfg, queue);
}

// gh-1230 CRAP: drain queued references — read reachable files, queue their
// own references, record instructions/prompts danglers along the way.
function drainReferenceQueue(queue, reachable, dangling) {
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

    while (queue.length) {
        var p = queue.pop();
        if (existsOnDisk(p)) scanFile(p);
        else if (/^(?:instructions|prompts)\//.test(p)) dangling[p] = true;
    }
}

// Build the union reference closure of all root configs.
// Returns { reachable: {path->true}, dangling: [path] }.
function buildClosure() {
    var reachable = {};
    var dangling = {};
    var queue = [];

    listNames('.').forEach(function (name) {
        queueRootConfigReferences(name, queue);
    });

    drainReferenceQueue(queue, reachable, dangling);
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

    test('R2: live instruction and prompt directories are fully reachable (0 orphans)', function () {
        var c = buildClosure();
        var files = Object.keys(collectInstructionFiles('instructions'))
            .concat(Object.keys(collectInstructionFiles('prompts')));
        var byDir = {};
        files.forEach(function (f) {
            var d = dirOf(f);
            byDir[d] = byDir[d] || { any: false, missing: [] };
            if (c.reachable[f]) byDir[d].any = true;
            else if (KNOWN_ORPHANS.indexOf(f) === -1) byDir[d].missing.push(f);
        });
        var violators = [];
        Object.keys(byDir).forEach(function (d) {
            if (!isLegacy(d) && byDir[d].missing.length) {
                violators.push(d + ': ' + byDir[d].missing.join(', '));
            }
        });
        assert.deepEqual(violators, [],
            'files present in instructions/ or prompts/ but never packed ' +
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
        assert.ok(c.reachable['prompts/codegraph_tools.md'],
            '#941 regression: prompts/codegraph_tools.md must be reachable from agent configs');
        assert.ok(c.reachable['js/conditions/isCodeGraphAvailable.js'],
            '#941 regression: js/conditions/isCodeGraphAvailable.js must be reachable from agent configs');
    });

    test('R5 (gh-1160): no tracker- or Confluence-specific prompt remains in base cliPrompts', function () {
        var forbiddenInBase = /(?:\/tracker\/|\/(?:jira_|ado_|github_comment_format\.md|confluence_comments\.md$))/;
        var violators = [];
        listNames('.').forEach(function (name) {
            if (name.slice(-5) !== '.json' || name === 'versions.json' || name[0] === '.') return;
            var raw = readText(name);
            if (!raw) return;
            var cfg;
            try { cfg = JSON.parse(raw); } catch (e) { return; }
            var base = (cfg.params && Array.isArray(cfg.params.cliPrompts)) ? cfg.params.cliPrompts : [];
            base.forEach(function (entry) {
                if (typeof entry === 'string' && forbiddenInBase.test(entry)) {
                    violators.push(name + ': ' + entry);
                }
            });
        });
        assert.deepEqual(violators, [],
            'tracker- or Confluence-specific prompts must live in cliPromptsByTracker, not base cliPrompts: ' +
            violators.join(' | '));
    });

    test('R6 (gh-1160): dev, review, and rework configs declare cliPromptsByTracker for jira, ado, and github', function () {
        var requiredConfigs = [
            'story_development.json',
            'bug_development.json',
            'bug_fix_batch_development.json',
            'pr_review.json',
            'pr_rework.json'
        ];
        requiredConfigs.forEach(function (name) {
            var cfg = JSON.parse(readText(name));
            var byTracker = (cfg.params && cfg.params.cliPromptsByTracker) || {};
            assert.ok(Array.isArray(byTracker.jira) && byTracker.jira.indexOf('./agents/instructions/tracker/jira_comment_format.md') !== -1,
                name + ' must wire jira_comment_format.md in cliPromptsByTracker.jira');
            assert.ok(Array.isArray(byTracker.ado) && byTracker.ado.indexOf('./agents/instructions/tracker/ado_comment_format.md') !== -1,
                name + ' must wire ado_comment_format.md in cliPromptsByTracker.ado');
            assert.ok(Array.isArray(byTracker.github) && byTracker.github.indexOf('./agents/instructions/common/github_comment_format.md') !== -1,
                name + ' must wire github_comment_format.md in cliPromptsByTracker.github');
        });
    });

    test('R7 (gh-1278): ado_comment_format.md and ado_markup_transform.md require #<id> prefix for ADO ticket references', function () {
        var commentFormat = readText('instructions/tracker/ado_comment_format.md');
        var markupTransform = readText('instructions/tracker/ado_markup_transform.md');
        assert.ok(commentFormat.indexOf('#12345') !== -1, 'ado_comment_format.md must instruct #<id> format (e.g. #12345)');
        assert.ok(markupTransform.indexOf('#12345') !== -1, 'ado_markup_transform.md must instruct #<id> format (e.g. #12345)');
    });

    test('R8 (gh-1292, gh-1293, gh-1296): batch_scope.md and instructions do not reference already-inlined files by path', function () {
        var batchScope = readText('instructions/bug_fix_batch_development/batch_scope.md');
        assert.ok(batchScope.indexOf('bug_fix_development/') === -1, 'batch_scope.md must not reference non-existent bug_fix_development/*');
        assert.ok(batchScope.indexOf('tdd_approach.md') === -1, 'batch_scope.md must not reference already-inlined tdd_approach.md by path');

        var inputReading = readText('instructions/common/input_context_reading.md');
        assert.ok(inputReading.indexOf('dmtools_cli.md') === -1, 'input_context_reading.md must not reference dmtools_cli.md by path');

        var storyGuidelines = readText('instructions/story_development/general_guidelines.md');
        assert.ok(storyGuidelines.indexOf('tdd_approach.md') === -1, 'story_development/general_guidelines.md must not reference tdd_approach.md by path');

        var reworkGuidelines = readText('instructions/pr_rework/general_guidelines.md');
        assert.ok(reworkGuidelines.indexOf('tdd_approach.md') === -1, 'pr_rework/general_guidelines.md must not reference tdd_approach.md by path');

        var checkedFiles = [
            'instructions/intake/description_template.md',
            'instructions/story_questions/description_template.md',
            'instructions/intake/workflow.md',
            'instructions/enhancement/solution_design_few_shots.md',
            'instructions/story_solution/affected_repos_section_format.md',
            'instructions/test_automation/test_automation_output_files.md'
        ];
        checkedFiles.forEach(function (file) {
            var content = readText(file);
            assert.ok(content.indexOf('jira_markup_transform.md') === -1, file + ' must not reference jira_markup_transform.md by path');
            assert.ok(content.indexOf('ado_markup_transform.md') === -1, file + ' must not reference ado_markup_transform.md by path');
            assert.ok(content.indexOf('jira_comment_format.md') === -1, file + ' must not reference jira_comment_format.md by path');
            assert.ok(content.indexOf('ado_comment_format.md') === -1, file + ' must not reference ado_comment_format.md by path');
            assert.ok(content.indexOf('test_automation_json_output.md') === -1, file + ' must not reference test_automation_json_output.md by path');
        });
    });

    test('R9 (gh-1298): prompts and instructions contain no internal issue/PR refs, ISO dates, or live-incident provenance markers', function () {
        var files = Object.keys(collectInstructionFiles('instructions'))
            .concat(Object.keys(collectInstructionFiles('prompts')));
        var internalRefRe = /\b(?:fa#[0-9]+|agents#[0-9]+|gh-[0-9]+|pr-[0-9]+)\b/i;
        var isoDateRe = /\b20[0-9]{2}-[0-9]{2}-[0-9]{2}\b/;
        var liveMarkerRe = /(?:Evidence\s*\(|observed live|live:\s)/i;
        var violators = [];
        files.forEach(function (file) {
            var content = readText(file) || '';
            var m = content.match(internalRefRe) || content.match(isoDateRe) || content.match(liveMarkerRe);
            if (m) violators.push(file + ' (' + m[0] + ')');
        });
        assert.deepEqual(violators, [],
            'prompts/ and instructions/ must not leak internal issue/PR refs, ISO dates, or live evidence markers: ' +
            violators.join(', '));
    });

    test('R10 (gh-1303): generic prompts and instructions do not hardcode Flutter/Dart/WidgetTester test paths or examples', function () {
        var files = Object.keys(collectInstructionFiles('instructions'))
            .concat(Object.keys(collectInstructionFiles('prompts')));
        var stackRe = /\b(?:flutter|dart|dartdoc|widgettester)\b/i;
        var allowedRuleDoc = { 'instructions/pr_rework/general_guidelines.md': true };
        var violators = [];
        files.forEach(function (file) {
            var content = readText(file) || '';
            if (allowedRuleDoc[file]) {
                content = content.replace(/`dart format[^`]*`/g, '').replace(/`dart_format`/g, '');
            }
            var m = content.match(stackRe);
            if (m) violators.push(file + ' (' + m[0] + ')');
        });
        assert.deepEqual(violators, [],
            'prompts/ and instructions/ must stay stack-agnostic (no Flutter/Dart/WidgetTester references): ' +
            violators.join(', '));
    });
});

// ── gh-1230 CRAP characterization: reference-queue helpers ───────────────────

suite('instructionRefs — reference queue helpers (gh-1230 characterization)', function () {

    test('queueConfigReferences: only path-shaped .md/.js strings are queued (recursively)', function () {
        var queue = [];
        queueConfigReferences('instructions/common/github_comment_format.md', queue);
        queueConfigReferences('agents/js/common/scm.js', queue);
        queueConfigReferences('plain string without slash', queue);
        queueConfigReferences('no-extension/path', queue);
        queueConfigReferences(['instructions/a.md', ['js/b.js'], { nested: 'prompts/c.md' }], queue);
        queueConfigReferences({ deep: { deeper: 'instructions/d.md' }, skip: 42 }, queue);
        queueConfigReferences(null, queue);
        queueConfigReferences(42, queue);
        assert.deepEqual(queue, [
            'instructions/common/github_comment_format.md',
            'js/common/scm.js',
            'instructions/a.md',
            'js/b.js',
            'prompts/c.md',
            'instructions/d.md'
        ]);
    });

    test('queueRootConfigReferences: non-JSON and versions.json names are skipped', function () {
        var queue = [];
        queueRootConfigReferences('versions.json', queue);
        queueRootConfigReferences('README.md', queue);
        queueRootConfigReferences('instruction.md', queue);
        assert.deepEqual(queue, [], 'no references queued for skipped names');
    });

    test('queueRootConfigReferences: a real base config queues its referenced files', function () {
        var queue = [];
        queueRootConfigReferences('discovery.json', queue);
        assert.ok(queue.length > 0, 'discovery.json references at least one file');
        var allPaths = queue.every(function (p) { return /\.md$|\.js$/.test(p); });
        assert.ok(allPaths, 'queued entries are .md/.js paths');
    });
});
