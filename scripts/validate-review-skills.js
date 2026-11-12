#!/usr/bin/env node
/**
 * validate-review-skills.js — the gh-1406 §8 deterministic reviewer-pool
 * configuration validator (zero-dep node: fs + JSON only).
 *
 * Validates a consuming repository's reviewer-pool configuration:
 *   - the factory skill files   instructions/review/*.json   (when present)
 *   - the repo skill files      .dmtools/review/*.json       (when present)
 *   - the pool config keys      reviewPolicy.reviewers + reviewPolicy.promptAppend
 *     (from .dmtools/config.js)
 *
 * The §8 check list (the contract — implementations may differ, these may
 * not):
 *   1. skill JSON parses; `name`+`lens` present; unknown top-level fields
 *      WARNED (typo protection — `options` is the pass-through bucket);
 *   2. mayRaise ⊆ tiers; rounds flags valid; ["all"] not combined;
 *      booleans are booleans (the `is` prefix);
 *   3. lens file exists + non-empty; a skill that EXPLICITLY declares
 *      BLOCKING whose lens lacks the citation hint → WARNING;
 *   4. duplicate reviewer names → error;
 *   5. same-name factory-reviewer files contain only tunable fields →
 *      else error (extend, never replace);
 *   6. promptAppend targets resolve to real reviewers and files exist;
 *   7. reviewPolicy.reviewers.*.isEnabled entries resolve to defined
 *      reviewers.
 *
 * Exit codes: 0 (valid — warnings allowed), 1 (any validation error).
 * Warnings are printed but never fail: the script proves the configuration
 * is well-formed and loadable; whether a lens is any GOOD is the filter
 * leg's job (agent work — never script work).
 *
 * Usage (from the consuming repo root, with the agents pack available):
 *   node scripts/validate-review-skills.js [repoRoot]
 *   node scripts/validate-review-skills.js . --factory instructions/review --repo .dmtools/review
 *
 * The validation logic itself lives in js/common/reviewPool.js (pure,
 * GraalJS-clean, unit-tested); this wrapper is the file-system shell the
 * CI gate calls.
 */
'use strict';

var fs = require('fs');
var path = require('path');

function findPackRoot(startDir) {
    var dir = path.resolve(startDir);
    for (var i = 0; i < 6; i++) {
        if (fs.existsSync(path.join(dir, 'js', 'common', 'reviewPool.js'))) return dir;
        var parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
    return null;
}

var scriptDir = __dirname;
var packRoot = findPackRoot(scriptDir);
if (!packRoot) {
    console.error('validate-review-skills: cannot locate js/common/reviewPool.js from ' + scriptDir +
        ' — run the script from inside the agents pack checkout');
    process.exit(1);
}

var reviewPool = require(path.join(packRoot, 'js', 'common', 'reviewPool.js'));
var reviewPolicy = require(path.join(packRoot, 'js', 'common', 'reviewPolicy.js'));

// ── argument parsing (no deps) ───────────────────────────────────────────────

function parseArgs(argv) {
    var out = { repoRoot: '.', factory: null, repo: null, config: null };
    for (var i = 0; i < argv.length; i++) {
        var a = argv[i];
        if (a === '--factory') out.factory = argv[++i];
        else if (a === '--repo') out.repo = argv[++i];
        else if (a === '--config') out.config = argv[++i];
        else if (a === '-h' || a === '--help') out.help = true;
        else if (out.repoRoot === '.') out.repoRoot = a;
    }
    return out;
}

var args = parseArgs(process.argv.slice(2));
if (args.help) {
    console.log('usage: node scripts/validate-review-skills.js [repoRoot] [--factory <dir>] [--repo <dir>] [--config <path>]');
    process.exit(0);
}

var repoRoot = path.resolve(args.repoRoot);
var factoryDirs = args.factory ? [args.factory]
    : ['instructions/review', 'agents/instructions/review']
        .filter(function(d) { return fs.existsSync(path.join(repoRoot, d)); });
var repoDir = args.repo || '.dmtools/review';
var errors = [];
var warnings = [];
var errorCount = 0;
var warningCount = 0;

function report(kind, message) {
    if (kind === 'error') {
        errors.push(message);
        errorCount++;
        console.log('\u274C ' + message);
    } else {
        warnings.push(message);
        warningCount++;
        console.log('\u26A0\uFE0F  ' + message);
    }
}

// ── the io bag over fs (reviewPool.resolvePool contract) ─────────────────────

function toRepoRelative(p) {
    return path.isAbsolute(p) ? p : path.join(repoRoot, p);
}

var io = {
    readFile: function(p) {
        try {
            return fs.readFileSync(toRepoRelative(p), 'utf8');
        } catch (e) {
            return null;
        }
    },
    listFiles: function(dir) {
        try {
            return fs.readdirSync(toRepoRelative(dir));
        } catch (e) {
            return null;
        }
    }
};

// ── the project config (reviewPolicy keys) ───────────────────────────────────

function loadProjectConfig() {
    var configPath = args.config || path.join(repoRoot, '.dmtools', 'config.js');
    if (!fs.existsSync(configPath)) return null;
    try {
        var loaded = require(path.resolve(configPath));
        return loaded && typeof loaded === 'object' ? loaded : null;
    } catch (e) {
        report('error', '.dmtools/config.js failed to load: ' + e.message);
        return null;
    }
}

var projectConfig = loadProjectConfig();
var rawPolicy = projectConfig ? projectConfig.reviewPolicy : undefined;

// The pool config keys are validated by the same shape gate the legs use —
// a malformed reviewers/promptAppend block is a hard error HERE too (the
// §3 strictness: unknown keys still throw).
if (rawPolicy !== undefined && rawPolicy !== null) {
    try {
        reviewPolicy.validateReviewPolicy(rawPolicy, '.dmtools/config.js reviewPolicy');
    } catch (e) {
        report('error', String(e.message || e));
    }
}

// ── the pool resolution (checks 1–5 + 7 + 8) ─────────────────────────────────

var pool = null;
try {
    pool = reviewPool.resolvePool(io, rawPolicy ? { reviewPolicy: rawPolicy } : null, null,
        { factoryDirs: factoryDirs.length ? factoryDirs : ['instructions/review'], repoDir: repoDir });
} catch (e) {
    report('error', String(e.message || e));
}

if (pool) {
    var names = {};
    pool.reviewers.forEach(function(s) {
        names[s.name] = true;
        var src = pool.factoryNames.indexOf(s.name) !== -1 ? 'factory' : 'repo';
        console.log('\u2705 reviewer "' + s.name + '" (' + src + ') — lens ' + s.lens +
            ' | required:' + (reviewPool.isRequiredReviewer(pool, s.name) ? 'true' : 'false') +
            ' | rounds:[' + s.rounds.join(',') + '] | weight:' + s.filterWeight);
    });
    // Check 4 (duplicate names) already throws inside resolvePool; the
    // warnings ride out of the loader (unknown fields, lens problems,
    // missing append files).
    pool.warnings.forEach(function(w) {
        // Check 3 splits: a missing lens is an ERROR for the CI gate (a
        // reviewer whose lens is absent cannot run), a missing citation
        // hint stays a WARNING (§8 — "warning" verbatim).
        if (w.indexOf('lens file missing or empty') !== -1) report('error', w);
        else report('warning', w);
    });
}

// ── check 6: promptAppend targets + files ────────────────────────────────────
// resolvePool already errors on unknown targets and warns on missing files;
// surface the missing append files as CI-gate errors here.
if (pool && rawPolicy && rawPolicy.promptAppend) {
    Object.keys(rawPolicy.promptAppend).forEach(function(target) {
        (rawPolicy.promptAppend[target] || []).forEach(function(p) {
            var text = io.readFile(p);
            if (text === null || !String(text).trim()) {
                report('error', 'promptAppend[' + target + ']: file missing or empty: ' + p);
            }
        });
    });
}

// ── check 7: reviewPolicy.reviewers targets (belt: resolvePool throws; the
// validator reports the same failure against a RAW policy even when the pool
// resolution short-circuited for another reason) ─────────────────────────────
if (rawPolicy && rawPolicy.reviewers && pool) {
    Object.keys(rawPolicy.reviewers).forEach(function(name) {
        if (names[name] === undefined) {
            report('error', 'reviewPolicy.reviewers names the unknown reviewer "' + name +
                '" — defined reviewers: ' + pool.reviewers.map(function(s) { return s.name; }).join(', '));
        }
    });
}

// ── check 8: reviewPolicy.required entries resolve to defined reviewers
// (belt: resolvePool already hard-errors; report against the RAW policy even
// when the pool resolution short-circuited for another reason) ──────────────
if (rawPolicy && rawPolicy.required !== undefined && rawPolicy.required !== null && pool) {
    var known = {};
    pool.reviewers.forEach(function(s) { known[s.name] = true; });
    (Array.isArray(rawPolicy.required) ? rawPolicy.required : []).forEach(function(name) {
        if (known[name] === undefined) {
            report('error', 'reviewPolicy.required names the unknown reviewer "' + name +
                '" — a misspelled gate silently gates nothing. Defined reviewers: ' +
                pool.reviewers.map(function(s) { return s.name; }).join(', '));
        }
    });
}

// ── migration signal: deprecated v1 instruction paths (the 2026-11-12
// instruction-file split restored frozen v1 shims with deprecation banners;
// a repo still PINNING a v1 path degrades its own prompts when the shims are
// removed at the next major — warn loudly now) ─────────────────────────────
var DEPRECATED_V1_PATHS = [
    ['instructions/pr_review/general_guidelines.md', 'instructions/pr_review/generalist/lens.md'],
    ['instructions/pr_review/output_rules.md', 'instructions/pr_review/base/input_context.md + instructions/pr_review/base/output_rules.md'],
    ['instructions/pr_review/formatting_rules.md', 'instructions/pr_review/base/formatting_rules.md'],
    ['instructions/pr_review/review_verdict_rules.md', 'instructions/pr_review/base/review_verdict_rules.md'],
    ['instructions/pr_review/few_shots.md', 'instructions/pr_review/generalist/few_shots.md'],
    ['instructions/pr_test_automation_review/output_rules.md', 'instructions/pr_review/base/output_rules.md'],
    ['instructions/pr_test_automation_review/formatting_rules.md', 'instructions/pr_review/base/formatting_rules.md']
];
function scanForV1Paths(where, text) {
    if (!text) return;
    DEPRECATED_V1_PATHS.forEach(function(pair) {
        if (String(text).indexOf(pair[0]) !== -1) {
            report('warning', where + ' pins the deprecated v1 path "' + pair[0] +
                '" — moved to ' + pair[1] + ' (the v1 shim is frozen and will be REMOVED in the next major release)');
        }
    });
}
(function warnDeprecatedV1Pins() {
    if (!projectConfig) return;
    var arrays = [];
    if (Array.isArray(projectConfig.globalCliPrompts)) arrays.push(['globalCliPrompts', projectConfig.globalCliPrompts]);
    ['cliPrompts', 'cliPromptOverrides', 'additionalInstructions', 'instructionOverrides'].forEach(function(key) {
        var map = projectConfig[key];
        if (map && typeof map === 'object') {
            Object.keys(map).forEach(function(ctx) {
                var v = map[ctx];
                if (Array.isArray(v)) arrays.push([key + '[' + ctx + ']', v]);
                else if (typeof v === 'string') arrays.push([key + '[' + ctx + ']', [v]]);
            });
        }
    });
    arrays.forEach(function(entry) {
        entry[1].forEach(function(v) { scanForV1Paths('config ' + entry[0], v); });
    });
    var runnersDir = path.join(repoRoot, '.dmtools', 'runners');
    try {
        fs.readdirSync(runnersDir).forEach(function(f) {
            if (!/\.json$/.test(f)) return;
            scanForV1Paths('runner .dmtools/runners/' + f,
                fs.readFileSync(path.join(runnersDir, f), 'utf8'));
        });
    } catch (e) { /* no runners dir — nothing to scan */ }
})();

console.log('');
console.log('reviewer pool: ' + (pool ? pool.reviewers.length : 0) + ' reviewer(s) validated · ' +
    errorCount + ' error(s), ' + warningCount + ' warning(s)');
if (errorCount > 0) {
    console.log('\u274C validate-review-skills: FAILED');
    process.exit(1);
}
console.log('\u2705 validate-review-skills: OK');
process.exit(0);
