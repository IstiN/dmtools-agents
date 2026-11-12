/**
 * Unit tests for js/common/reviewPool.js — the gh-1406 reviewer pool:
 * skill-file schema + defaults (§2), factory/repo pool resolution with the
 * same-name tuning rules (extend, never replace), reviewPolicy.reviewers /
 * promptAppend tuning (§3), and the rounds/triggerPaths gating (§6).
 *
 * Pure module — loaded with an injected file-io map; no dmtools globals.
 */

var reviewVerdicts = loadModule('js/common/reviewVerdicts.js',
    makeRequire({ './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}) }), {});
var reviewPolicy = loadModule('js/common/reviewPolicy.js',
    makeRequire({ './reviewVerdicts.js': reviewVerdicts }), {});
var mod = loadModule('js/common/reviewPool.js',
    makeRequire({ './reviewPolicy.js': reviewPolicy }), {});

function skillErrorOf(fn) {
    try {
        fn();
    } catch (e) {
        return e;
    }
    return null;
}

// A tiny in-memory io bag: { files: {path: text}, dirs: {dir: [entries]} }
function makeIo(files, dirs) {
    return {
        readFile: function(p) {
            if (files && files[p] !== undefined) return files[p];
            return null;
        },
        listFiles: function(d) {
            if (dirs && dirs[d]) return dirs[d];
            return null;
        }
    };
}

var BASE_JSON = JSON.stringify({
    name: 'base',
    lens: 'instructions/pr_review/generalist/lens.md',
    roleLine: 'Senior Code Reviewer',
    rounds: ['all']
});
var SECURITY_JSON = JSON.stringify({
    name: 'security',
    lens: 'instructions/pr_review/security/lens.md',
    rounds: ['first', 'hunks'],
    triggerPaths: [],
    mayRaise: ['BLOCKING', 'IMPORTANT', 'SUGGESTION', 'NIT'],
    options: { referencePack: 'instructions/pr_review/security/references/' }
});

var FACTORY_DIRS = { 'instructions/review': ['base.json', 'security.json'] };
var FACTORY_FILES = {
    'instructions/review/base.json': BASE_JSON,
    'instructions/review/security.json': SECURITY_JSON,
    'instructions/pr_review/generalist/lens.md': '# Generalist lens\ncitation discipline: cite file:line for every 🚨 claim.',
    'instructions/pr_review/security/lens.md': '# Security lens\nCitation rule: quote the vulnerable lines before raising BLOCKING.'
};

suite('reviewPool — skill-file schema and defaults (§2)', function() {

    test('minimal file defines a FULL reviewer: every universal field defaults', function() {
        var r = mod.validateSkillDefinition(
            { name: 'a11y', lens: '.dmtools/review/a11y.md' }, 'test/a11y.json');
        assert.equal(r.warnings.length, 0);
        var s = r.skill;
        assert.equal(s.name, 'a11y');
        assert.equal(s.lens, '.dmtools/review/a11y.md');
        assert.equal(s.roleLine, 'Specialized Code Reviewer \u2014 a11y');
        assert.deepEqual(s.mayRaise, ['BLOCKING', 'IMPORTANT', 'SUGGESTION', 'NIT']);
        assert.equal(s.filterWeight, 'normal');
        assert.equal(s.isFiltered, true);
        assert.deepEqual(s.rounds, ['all']);
        assert.deepEqual(s.triggerPaths, []);
        assert.deepEqual(s.options, {});
        assert.equal(s.model, null);
        assert.equal(s.isEnabled, true);
    });

    test('name and lens are the only required fields', function() {
        var e1 = skillErrorOf(function() { mod.validateSkillDefinition({ lens: 'x.md' }, 't'); });
        assert.ok(e1 && e1.message.indexOf('"name"') !== -1);
        var e2 = skillErrorOf(function() { mod.validateSkillDefinition({ name: 'x' }, 't'); });
        assert.ok(e2 && e2.message.indexOf('"lens"') !== -1);
        assert.equal(e2.name, 'ReviewSkillValidationError');
    });

    test('unknown top-level fields are WARNED (typo protection), never dropped silently', function() {
        var r = mod.validateSkillDefinition(
            { name: 'x', lens: 'x.md', filterWeigth: 'high', extra: 1 }, 't');
        assert.ok(r.skill.filterWeight === 'normal', 'unknown typo field does not become the value');
        assert.equal(r.warnings.length, 1);
        assert.ok(r.warnings[0].indexOf('filterWeigth, extra') !== -1, 'warning names the typos: ' + r.warnings[0]);
        assert.ok(r.warnings[0].indexOf('options') !== -1, 'warning points at the options bucket');
    });

    test('mayRaise must be a non-empty subset of the tiers', function() {
        var ok = mod.validateSkillDefinition({ name: 'x', lens: 'x.md', mayRaise: ['blocking', 'NIT'] }, 't');
        assert.deepEqual(ok.skill.mayRaise, ['BLOCKING', 'NIT']);
        var e1 = skillErrorOf(function() { mod.validateSkillDefinition({ name: 'x', lens: 'x.md', mayRaise: [] }, 't'); });
        assert.ok(e1 && e1.message.indexOf('non-empty') !== -1);
        var e2 = skillErrorOf(function() { mod.validateSkillDefinition({ name: 'x', lens: 'x.md', mayRaise: ['HUGE'] }, 't'); });
        assert.ok(e2 && e2.message.indexOf('HUGE') !== -1 && e2.message.indexOf('known tiers') !== -1);
    });

    test('booleans take the is prefix and must be booleans; filterWeight is the enum', function() {
        var e2 = skillErrorOf(function() { mod.validateSkillDefinition({ name: 'x', lens: 'x.md', isFiltered: 1 }, 't'); });
        assert.ok(e2 && e2.message.indexOf('isFiltered must be a boolean') !== -1);
        var e3 = skillErrorOf(function() { mod.validateSkillDefinition({ name: 'x', lens: 'x.md', filterWeight: 'heavy' }, 't'); });
        assert.ok(e3 && e3.message.indexOf('low | normal | high') !== -1);
        var ok = mod.validateSkillDefinition({ name: 'x', lens: 'x.md', filterWeight: 'high' }, 't');
        assert.equal(ok.skill.filterWeight, 'high');
    });

    test('explicit BLOCKING in mayRaise is legal for any reviewer (no tier limits)', function() {
        var r = mod.validateSkillDefinition(
            { name: 'translator', lens: 't.md', mayRaise: ['BLOCKING'] }, 't');
        assert.deepEqual(r.skill.mayRaise, ['BLOCKING']);
    });
});

suite('reviewPool — same-name repo tuning (extend, never replace)', function() {

    test('a same-name repo file may tune exactly the tunable field set', function() {
        var factory = mod.validateSkillDefinition(SECURITY_JSON_SAFE(), 'factory').skill;
        var r = mod.validateRepoTuning(JSON.stringify === undefined ? {} : {
            name: 'security',
            isEnabled: false,
            rounds: ['all'],
            triggerPaths: ['src/auth/'],
            options: { referencePack: 'own/' },
            model: 'openai/x'
        }, factory, 'repo/.dmtools/review/security.json');
        assert.equal(r.warnings.length, 0);
        var tuned = mod.applyTuning(factory, r.tuning);
        assert.equal(tuned.isEnabled, false);
        assert.deepEqual(tuned.rounds, ['all']);
        assert.deepEqual(tuned.triggerPaths, ['src/auth/']);
        assert.deepEqual(tuned.options, { referencePack: 'own/' });
        assert.equal(tuned.model, 'openai/x');
        // Contract fields ride untouched.
        assert.equal(tuned.lens, factory.lens);
    });

    test('re-defining a contract field in a same-name repo file is a hard error', function() {
        var factory = mod.validateSkillDefinition(SECURITY_JSON_SAFE(), 'factory').skill;
        var e = skillErrorOf(function() {
            mod.validateRepoTuning({ name: 'security', isRequired: false }, factory, 'repo');
        });
        assert.ok(e, 'isRequired is not tunable — a same-name file carrying it must throw');
        assert.ok(e.message.indexOf('extend, never replace') !== -1, 'error names the invariant: ' + e.message);
        assert.ok(e.message.indexOf('may only TUNE') !== -1);
        var e2 = skillErrorOf(function() {
            mod.validateRepoTuning({ name: 'security', lens: '.dmtools/review/own-lens.md' }, factory, 'repo');
        });
        assert.ok(e2 && e2.message.indexOf('lens') !== -1);
    });

    test('a same-name file claiming another reviewer name is rejected', function() {
        var factory = mod.validateSkillDefinition(SECURITY_JSON_SAFE(), 'factory').skill;
        var e = skillErrorOf(function() {
            mod.validateRepoTuning({ name: 'legal', isEnabled: true }, factory, 'repo');
        });
        assert.ok(e && e.message.indexOf('does not match') !== -1);
    });

    test('a repo file defining a NEW reviewer is a full skill definition (repo-authored lens)', function() {
        var io = makeIo({
            'instructions/review/base.json': BASE_JSON,
            '.dmtools/review/legal.json': JSON.stringify({ name: 'legal', lens: '.dmtools/review/legal.lens.md' }),
            '.dmtools/review/legal.lens.md': '# Legal lens\nConsent/privacy/terms; citation required for BLOCKING.'
        }, { 'instructions/review': ['base.json'], '.dmtools/review': ['legal.json'] });
        var pool = mod.resolvePool(io, {}, {});
        assert.deepEqual(pool.factoryNames, ['base']);
        assert.deepEqual(pool.repoNames, ['legal']);
        var legal = mod.findSkill(pool, 'legal');
        assert.ok(legal, 'repo-defined reviewer is in the pool');
        assert.equal(legal.roleLine, 'Specialized Code Reviewer \u2014 legal');
    });
});

function SECURITY_JSON_SAFE() {
    return JSON.parse(SECURITY_JSON);
}

suite('reviewPool — pool resolution (§2 loading + §3 tuning)', function() {

    test('factory base + security load with their shipped shapes', function() {
        var pool = mod.resolvePool(makeIo(FACTORY_FILES, FACTORY_DIRS), {}, {});
        assert.deepEqual(pool.factoryNames, ['base', 'security']);
        assert.equal(pool.warnings.length, 0);
        var security = mod.findSkill(pool, 'security');
        assert.deepEqual(security.rounds, ['first', 'hunks']);
        assert.deepEqual(security.triggerPaths, [], 'security ships without a path limitation');
        assert.deepEqual(security.mayRaise, ['BLOCKING', 'IMPORTANT', 'SUGGESTION', 'NIT']);
        // The merge gate is pool policy now: factory default names base + security.
        assert.deepEqual(pool.policy.required, ['base', 'security']);
        assert.equal(mod.isRequiredReviewer(pool, 'base'), true);
        assert.equal(mod.isRequiredReviewer(pool, 'security'), true);
        assert.deepEqual(mod.requiredReviewers(pool).map(function(s) { return s.name; }), ['base', 'security']);
        assert.deepEqual(mod.unresolvedRequiredNames(pool), []);
    });

    test('reviewPolicy.required is repo-owned: shrink to [] or a subset', function() {
        var pool = mod.resolvePool(makeIo(FACTORY_FILES, FACTORY_DIRS), { reviewPolicy: { required: [] } }, {});
        assert.deepEqual(pool.policy.required, [], 'an explicit empty list gates nothing');
        assert.deepEqual(mod.requiredReviewers(pool), []);
        var pool2 = mod.resolvePool(makeIo(FACTORY_FILES, FACTORY_DIRS), { reviewPolicy: { required: ['security'] } }, {});
        assert.deepEqual(mod.requiredReviewers(pool2).map(function(s) { return s.name; }), ['security']);
    });

    test('the factory default required list adapts to a partial factory set (warning, fail-soft)', function() {
        var io = makeIo({
            'instructions/review/base.json': BASE_JSON,
            '.dmtools/review/legal.json': JSON.stringify({ name: 'legal', lens: '.dmtools/review/legal.lens.md' })
        }, { 'instructions/review': ['base.json'], '.dmtools/review': ['legal.json'] });
        var pool = mod.resolvePool(io, {}, {});
        var warned = false;
        pool.warnings.forEach(function(w) { if (w.indexOf('not loaded') !== -1) warned = true; });
        assert.ok(warned, 'default security not loaded — warn, never throw: ' + JSON.stringify(pool.warnings));
        assert.deepEqual(mod.requiredReviewers(pool).map(function(s) { return s.name; }), ['base']);
    });

    test('a required entry naming an unknown reviewer is a hard error (§8 check 8)', function() {
        var e = skillErrorOf(function() {
            mod.resolvePool(makeIo(FACTORY_FILES, FACTORY_DIRS), { reviewPolicy: { required: ['secuirty'] } }, {});
        });
        assert.ok(e, 'a misspelled gate silently gates nothing — must throw');
        assert.ok(e.message.indexOf('secuirty') !== -1, e.message);
        assert.ok(e.message.indexOf('reviewPolicy.required') !== -1, e.message);
    });

    test('a required-but-disabled reviewer warns (it can never gate)', function() {
        var files = {};
        for (var k in FACTORY_FILES) files[k] = FACTORY_FILES[k];
        files['.dmtools/review/security.json'] = JSON.stringify({ name: 'security', isEnabled: false });
        var io = makeIo(files, {
            'instructions/review': ['base.json', 'security.json'],
            '.dmtools/review': ['security.json']
        });
        var pool = mod.resolvePool(io, {}, {});
        assert.equal(pool.warnings.length, 1, 'exactly the disabled-required warning: ' + JSON.stringify(pool.warnings));
        assert.ok(pool.warnings[0].indexOf('security') !== -1 && pool.warnings[0].indexOf('cannot gate') !== -1, pool.warnings[0]);
        assert.deepEqual(mod.requiredReviewers(pool).map(function(s) { return s.name; }), ['base']);
    });

    test('required list rejects non-strings, empties and duplicates', function() {
        var e1 = skillErrorOf(function() { reviewPolicy.validateReviewPolicy({ required: [''] }, 't'); });
        assert.ok(e1 && e1.message.indexOf('non-empty') !== -1);
        var e2 = skillErrorOf(function() { reviewPolicy.validateReviewPolicy({ required: ['a', 'a'] }, 't'); });
        assert.ok(e2 && e2.message.indexOf('more than once') !== -1);
        var e3 = skillErrorOf(function() { reviewPolicy.validateReviewPolicy({ required: 'base' }, 't'); });
        assert.ok(e3 && e3.message.indexOf('must be an array') !== -1);
    });

    test('repo same-name tuning merges onto the factory reviewer', function() {
        var files = {};
        for (var k in FACTORY_FILES) files[k] = FACTORY_FILES[k];
        files['.dmtools/review/security.json'] = JSON.stringify({ name: 'security', rounds: ['all'] });
        var io = makeIo(files, {
            'instructions/review': ['base.json', 'security.json'],
            '.dmtools/review': ['security.json']
        });
        var pool = mod.resolvePool(io, {}, {});
        var security = mod.findSkill(pool, 'security');
        assert.deepEqual(security.rounds, ['all'], 'repo tuning wins over the factory rounds');
        assert.equal(mod.isRequiredReviewer(pool, 'security'), true, 'policy required rides untouched');
        assert.deepEqual(pool.factoryNames, ['base', 'security']);
        assert.deepEqual(pool.repoNames, [], 'same-name tuning is not a repo-defined reviewer');
    });

    test('a second same-name file for an already repo-defined reviewer is a duplicate-name error (§8 check 4)', function() {
        var files = {};
        for (var k in FACTORY_FILES) files[k] = FACTORY_FILES[k];
        files['.dmtools/review/twin1.json'] = JSON.stringify({
            name: 'twin', lens: '.dmtools/review/legal.lens.md', roleLine: 'first twin'
        });
        files['.dmtools/review/twin2.json'] = JSON.stringify({
            name: 'twin', lens: '.dmtools/review/legal.lens.md', roleLine: 'second twin'
        });
        var io = makeIo(files, {
            'instructions/review': ['base.json'],
            '.dmtools/review': ['twin1.json', 'twin2.json']
        });
        var e = skillErrorOf(function() {
            mod.resolvePool(io, {}, {});
        });
        assert.ok(e, 'duplicate repo reviewer names must be a hard error, not a silent merge');
        assert.ok(e.message.indexOf('duplicate reviewer name') !== -1, e.message);
        assert.ok(e.message.indexOf('twin') !== -1, e.message);
    });

    test('reviewPolicy.reviewers tuning applies (and unknown names are a hard error)', function() {
        var io = makeIo(FACTORY_FILES, FACTORY_DIRS);
        var pool = mod.resolvePool(io, { reviewPolicy: { reviewers: { security: { isEnabled: false } } } }, {});
        assert.equal(mod.findSkill(pool, 'security').isEnabled, false);
        assert.equal(mod.findSkill(pool, 'base').isEnabled, true);
        var e = skillErrorOf(function() {
            mod.resolvePool(io, { reviewPolicy: { reviewers: { legal: { isEnabled: true } } } }, {});
        });
        assert.ok(e, 'unknown reviewer tuning must throw at resolution');
        assert.ok(e.message.indexOf('legal') !== -1 && e.message.indexOf('defined reviewers') !== -1);
    });

    test('reviewPolicy.promptAppend resolves targets and files; missing files warn, unknown targets throw', function() {
        var files = {};
        for (var k in FACTORY_FILES) files[k] = FACTORY_FILES[k];
        files['.dmtools/review/base.append.md'] = 'Repo-wide append.';
        var io = makeIo(files, FACTORY_DIRS);
        var pool = mod.resolvePool(io, {
            reviewPolicy: { promptAppend: {
                base: ['.dmtools/review/base.append.md'],
                security: ['.dmtools/review/security.append.md']
            } }
        }, {});
        assert.deepEqual(pool.appends.base, ['.dmtools/review/base.append.md']);
        assert.deepEqual(pool.appends.security, [], 'missing append file warns, resolves empty');
        assert.ok(pool.warnings.join('\n').indexOf('security.append.md') !== -1);
        var e = skillErrorOf(function() {
            mod.resolvePool(io, { reviewPolicy: { promptAppend: { nope: ['x.md'] } } }, {});
        });
        assert.ok(e && e.message.indexOf('nope') !== -1);
    });

    test('lens must exist and be non-empty; explicit BLOCKING without a citation hint warns', function() {
        var files = {};
        for (var k in FACTORY_FILES) files[k] = FACTORY_FILES[k];
        files['instructions/pr_review/security/lens.md'] = '# Security lens\nHunt for injections, secrets, unsafe defaults.';
        var io = makeIo(files, FACTORY_DIRS);
        var pool = mod.resolvePool(io, {}, {});
        assert.ok(pool.warnings.join('\n').indexOf('citation-discipline hint') !== -1,
            'BLOCKING-allowed lens without citation hint warns');
        var files2 = {};
        for (var k2 in FACTORY_FILES) files2[k2] = FACTORY_FILES[k2];
        delete files2['instructions/pr_review/security/lens.md'];
        var pool2 = mod.resolvePool(makeIo(files2, FACTORY_DIRS), {}, {});
        assert.ok(pool2.warnings.join('\n').indexOf('lens file missing or empty') !== -1);
    });

    test('duplicate reviewer names inside one factory dir are a hard error (§8 check 4)', function() {
        var io = makeIo({
            'instructions/review/a.json': JSON.stringify({ name: 'dup', lens: 'a.md' }),
            'instructions/review/b.json': JSON.stringify({ name: 'dup', lens: 'b.md' })
        }, { 'instructions/review': ['a.json', 'b.json'] });
        var e = skillErrorOf(function() { mod.resolvePool(io, {}, {}); });
        assert.ok(e && e.message.indexOf('duplicate reviewer name') !== -1);
    });

    test('no skill dirs at all → empty pool, no crash (repos without the pack files)', function() {
        var pool = mod.resolvePool(makeIo({}, {}), {}, {});
        assert.deepEqual(pool.reviewers, []);
        assert.deepEqual(pool.factoryNames, []);
        assert.deepEqual(pool.repoNames, []);
        assert.deepEqual(mod.enabledReviewers(pool), []);
    });

    test('a broken factory skill JSON fails loudly (factory files ship correct)', function() {
        var io = makeIo({
            'instructions/review/base.json': '{not json'
        }, { 'instructions/review': ['base.json'] });
        var e = skillErrorOf(function() { mod.resolvePool(io, {}, {}); });
        assert.ok(e && e.message.indexOf('not valid JSON') !== -1);
    });

    test('enabledReviewers / requiredReviewers / findSkill read the resolved pool', function() {
        var pool = mod.resolvePool(makeIo(FACTORY_FILES, FACTORY_DIRS),
            { reviewPolicy: { reviewers: { security: { isEnabled: false } } } }, {});
        var enabled = mod.enabledReviewers(pool);
        assert.equal(enabled.length, 1);
        assert.equal(enabled[0].name, 'base');
        assert.deepEqual(mod.requiredReviewers(pool).map(function(s) { return s.name; }), ['base']);
    });
});

suite('reviewPool — rounds and triggerPaths gating (§6)', function() {

    test('triggerPaths: empty list imposes no limitation; substring match on hunk paths', function() {
        assert.equal(mod.triggerPathsHit([], ['src/anything.ts']), true);
        assert.equal(mod.triggerPathsHit(['src/auth/'], ['src/auth/login.ts', 'README.md']), true);
        assert.equal(mod.triggerPathsHit(['src/auth/'], ['src/ui/button.ts']), false);
        assert.equal(mod.triggerPathsHit(['src/auth/', 'db/'], ['db/migrate.sql']), true);
        assert.equal(mod.triggerPathsHit(['src/auth/'], []), false);
    });

    test('roundsDecide: the four legal shapes (§6)', function() {
        var first = { firstDone: false, hasNewHunks: false, hunksHitTrigger: false };
        var hunks = { firstDone: true, hasNewHunks: true, hunksHitTrigger: true };
        assert.equal(mod.roundsDecide(['first'], first), true, '["first"] runs the initial pass');
        assert.equal(mod.roundsDecide(['first'], hunks), false, '["first"] never re-fires after completion');
        assert.equal(mod.roundsDecide(['hunks'], first), false, '["hunks"] skips the first round');
        assert.equal(mod.roundsDecide(['hunks'], hunks), true);
        assert.equal(mod.roundsDecide(['hunks'], { firstDone: true, hasNewHunks: true, hunksHitTrigger: false }), false,
            '["hunks"] needs the triggerPaths hit');
        assert.equal(mod.roundsDecide(['first', 'hunks'], hunks), true, 'combined runs both');
        assert.equal(mod.roundsDecide(['first', 'hunks'], { firstDone: true, hasNewHunks: false, hunksHitTrigger: true }), false,
            'combined skips a quiet round');
        assert.equal(mod.roundsDecide(['all'], { firstDone: true, hasNewHunks: false, hunksHitTrigger: false }), true,
            '["all"] runs every round unconditionally');
    });

    test('first counts COMPLETIONS, not attempts (§6 invariant 4): firstDone → skip', function() {
        // A 429-failed leg leaves no PASS marker → firstDone stays false → the
        // leg re-fires next round. Modeled here as firstDone=false.
        var state = { firstDone: false, hasNewHunks: true, hunksHitTrigger: true };
        assert.equal(mod.roundsDecide(['first'], state), true);
    });

    test('reviewerShouldRun: disabled reviewers never run; enabled follow the rounds gate', function() {
        var skill = mod.validateSkillDefinition(SECURITY_JSON_SAFE(), 'f').skill;
        assert.equal(mod.reviewerShouldRun(skill, { firstDone: false, hasNewHunks: false, hunksHitTrigger: false }), true,
            'security (first+hunks) runs the first pass');
        assert.equal(mod.reviewerShouldRun(skill, { firstDone: true, hasNewHunks: false, hunksHitTrigger: true }), false);
        assert.equal(mod.reviewerShouldRun(skill, { firstDone: true, hasNewHunks: true, hunksHitTrigger: true }), true,
            'security re-verifies on new hunks (triggerPaths [] always hits)');
        var disabled = mod.applyTuning(skill, { isEnabled: false });
        assert.equal(mod.reviewerShouldRun(disabled, { firstDone: false, hasNewHunks: true, hunksHitTrigger: true }), false);
        assert.equal(mod.reviewerShouldRun(null, { firstDone: false, hasNewHunks: true, hunksHitTrigger: true }), false);
    });

    test('roundsDecide: unknown round flags never fire (the gate is closed to typos)', function() {
        var state = { firstDone: false, hasNewHunks: true, hunksHitTrigger: true };
        assert.equal(mod.roundsDecide(['nonsense'], state), false);
        assert.equal(mod.roundsDecide('first', state), false, 'a non-array rounds value decides nothing');
        assert.equal(mod.roundsDecide(null, null), false, 'missing rounds and state degrade to no-run');
    });
});

// ── gh-1406 CRAP-gate lap: edge branches pinned before the CRAP-split ────────
// The crap ratchet flagged the pool functions as NEW > 8; the fix splits
// them into smaller helpers. These tests pin the previously-uncovered
// branches FIRST so the split provably keeps behavior identical.

suite('reviewPool — skill-file validation edge branches (§2/§8)', function() {

    test('a non-object skill file is a hard error', function() {
        var e1 = skillErrorOf(function() { mod.validateSkillDefinition('nope', 't'); });
        assert.ok(e1 && e1.message.indexOf('must be a JSON object') !== -1);
        var e2 = skillErrorOf(function() { mod.validateSkillDefinition(null, 't'); });
        assert.ok(e2 && e2.message.indexOf('must be a JSON object') !== -1);
    });

    test('roleLine must be a non-empty string when present; an explicit roleLine is kept', function() {
        var e = skillErrorOf(function() {
            mod.validateSkillDefinition({ name: 'x', lens: 'x.md', roleLine: '   ' }, 't');
        });
        assert.ok(e && e.message.indexOf('roleLine must be a non-empty string') !== -1);
        var ok = mod.validateSkillDefinition({ name: 'x', lens: 'x.md', roleLine: 'Custom Persona' }, 't');
        assert.equal(ok.skill.roleLine, 'Custom Persona', 'explicit roleLine wins over the derived one');
    });

    test('model must be a string or null (skill file)', function() {
        var e = skillErrorOf(function() {
            mod.validateSkillDefinition({ name: 'x', lens: 'x.md', model: 42 }, 't');
        });
        assert.ok(e && e.message.indexOf('model must be a string or null') !== -1);
        var ok = mod.validateSkillDefinition({ name: 'x', lens: 'x.md', model: 'openai/x' }, 't');
        assert.equal(ok.skill.model, 'openai/x');
    });

    test('explicit isEnabled false is legal in a skill file', function() {
        var r = mod.validateSkillDefinition({ name: 'x', lens: 'x.md', isEnabled: false }, 't');
        assert.equal(r.skill.isEnabled, false);
    });
});

suite('reviewPool — same-name repo tuning edge branches (§8 check 5)', function() {

    test('a non-object same-name tuning file is a hard error naming the factory reviewer', function() {
        var factory = mod.validateSkillDefinition(SECURITY_JSON_SAFE(), 'factory').skill;
        var e = skillErrorOf(function() { mod.validateRepoTuning('nope', factory, 'repo'); });
        assert.ok(e && e.message.indexOf('must be a JSON object') !== -1);
        assert.ok(e.message.indexOf('security') !== -1, 'the error names the tuned factory reviewer');
    });

    test('tuned model must be a string or null (repo tuning)', function() {
        var factory = mod.validateSkillDefinition(SECURITY_JSON_SAFE(), 'factory').skill;
        var e = skillErrorOf(function() {
            mod.validateRepoTuning({ name: 'security', model: 42 }, factory, 'repo');
        });
        assert.ok(e && e.message.indexOf('model must be a string or null') !== -1);
    });
});

suite('reviewPool — pool resolution edge branches (io failure shapes)', function() {

    test('an io without listFiles degrades to an empty pool (capability miss)', function() {
        var pool = mod.resolvePool({ readFile: function() { return null; } }, {}, {});
        assert.deepEqual(pool.reviewers, []);
        assert.deepEqual(pool.factoryNames, []);
    });

    test('a throwing listFiles degrades to an empty pool (fail-soft dir read)', function() {
        var io = makeIo(FACTORY_FILES, FACTORY_DIRS);
        io.listFiles = function() { throw new Error('dir boom'); };
        var pool = mod.resolvePool(io, {}, {});
        assert.deepEqual(pool.reviewers, []);
    });

    test('a throwing readFile degrades to missing (no reviewers, no crash)', function() {
        var io = makeIo(FACTORY_FILES, FACTORY_DIRS);
        io.readFile = function() { throw new Error('read boom'); };
        var pool = mod.resolvePool(io, {}, {});
        assert.deepEqual(pool.factoryNames, [], 'unreadable factory files contribute no reviewers');
        assert.deepEqual(pool.reviewers, []);
    });

    test('a listed repo skill file that cannot be read is skipped silently', function() {
        var files = {};
        for (var k in FACTORY_FILES) files[k] = FACTORY_FILES[k];
        var io = makeIo(files, {
            'instructions/review': ['base.json', 'security.json'],
            '.dmtools/review': ['ghost.json'] // listed, but no content behind it
        });
        var pool = mod.resolvePool(io, {}, {});
        assert.deepEqual(pool.repoNames, [], 'unreadable repo files define nothing');
        assert.deepEqual(pool.factoryNames, ['base', 'security']);
    });

    test('a repo-defined reviewer with an unknown field is warned (typo protection rides the loader)', function() {
        var files = {};
        for (var k in FACTORY_FILES) files[k] = FACTORY_FILES[k];
        files['.dmtools/review/legal.json'] = JSON.stringify({ name: 'legal', lens: 'legal.md', mayRaize: ['NIT'] });
        var io = makeIo(files, {
            'instructions/review': ['base.json'],
            '.dmtools/review': ['legal.json']
        });
        var pool = mod.resolvePool(io, {}, {});
        assert.ok(pool.warnings.join('\n').indexOf('mayRaize') !== -1,
            'unknown field warns: ' + pool.warnings.join('\n'));
        assert.deepEqual(pool.repoNames, ['legal']);
    });

    test('listFiles entry shapes: strings, {name}, {path} load; null/empty/non-json entries skip', function() {
        var files = {};
        for (var k in FACTORY_FILES) files[k] = FACTORY_FILES[k];
        var io = makeIo(files, {});
        io.listFiles = function(dir) {
            if (dir === 'instructions/review') {
                return ['base.json', { name: 'security.json' }, { path: 'ghost.json' }, null, 'README.md', ''];
            }
            return [];
        };
        var pool = mod.resolvePool(io, {}, {});
        assert.deepEqual(pool.factoryNames, ['base', 'security'],
            'string, {name} and {path} entries load; null, empty and non-json entries skip');
    });

    test('a throwing promptAppend readFile warns and resolves empty (legs fail open)', function() {
        var io = makeIo(FACTORY_FILES, FACTORY_DIRS);
        io.readFile = function(p) {
            if (p === '.dmtools/review/base.append.md') throw new Error('append boom');
            if (FACTORY_FILES[p] !== undefined) return FACTORY_FILES[p];
            return null;
        };
        var pool = mod.resolvePool(io, {
            reviewPolicy: { promptAppend: { base: ['.dmtools/review/base.append.md'] } }
        }, {});
        assert.deepEqual(pool.appends.base, [], 'an unreadable append file resolves empty');
        assert.ok(pool.warnings.join('\n').indexOf('base.append.md') !== -1);
    });
});

suite('reviewPool — poolSummaryLine (run-context stamp)', function() {

    test('empty, null and shapeless pools render the empty line', function() {
        assert.equal(mod.poolSummaryLine({ reviewers: [] }), 'reviewer pool: (empty)');
        assert.equal(mod.poolSummaryLine(null), 'reviewer pool: (empty)');
        assert.equal(mod.poolSummaryLine({}), 'reviewer pool: (empty)');
    });

    test('each reviewer renders its pool-relevant flags in order', function() {
        var full = mod.validateSkillDefinition(SECURITY_JSON_SAFE(), 'f').skill;
        full.filterWeight = 'high';
        var minimal = { name: 'a11y', rounds: ['first'] };
        var line = mod.poolSummaryLine({ policy: { required: ['security'] }, reviewers: [full, minimal] });
        assert.equal(line, 'reviewer pool: security (required, weight:high, first+hunks) · a11y (first)');
        var disabled = mod.applyTuning(full, { isEnabled: false });
        var line2 = mod.poolSummaryLine({ policy: { required: ['security'] }, reviewers: [disabled] });
        assert.equal(line2, 'reviewer pool: security (required, disabled, weight:high, first+hunks)');
    });
});
