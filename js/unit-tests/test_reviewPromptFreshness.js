/**
 * The gh-1406 prompt freshness gate (docs-coverage-gate style): every
 * reviewer leg's prompt list must include the FULL
 * `instructions/pr_review/base/` contract set, and the base reviewer leg
 * must not claim the security-expert persona (deep security moved to the
 * security specialist — gh-1406 §1).
 *
 * Discovery mirrors test_agentDocsCoverage: git ls-files for the tracked
 * agent configs + the tracked base instruction files; cliPrompts entries
 * are strings or { prompt, condition } conditionals.
 *
 * Fails when a reviewer leg's prompt list misses a base contract file —
 * the machine parses what the base files mandate (output schema, verdict
 * rules, census rules, registry protocol, citation rule); a reviewer leg
 * running without the full base set is a contract drift, not a prompt
 * preference.
 */

var REVIEWER_CONTEXT_IDS = {
    'pr_review': true,
    'pr_test_automation_review': true,
    'pr_story_test_automation_review': true,
    'pr_bug_test_automation_review': true
};

function readText(path) {
    try {
        return file_read({ path: path });
    } catch (e) {
        return null;
    }
}

function listTrackedBaseFiles() {
    var output = cli_execute_command({ command: 'git ls-files "instructions/pr_review/base/*"' });
    return (output || '').split('\n').map(function(f) { return f.trim(); })
        .filter(function(f) { return f && f.indexOf('.md', f.length - 3) !== -1; })
        .sort();
}

function listReviewerConfigs() {
    var output = cli_execute_command({ command: 'git ls-files "*.json"' });
    return (output || '').split('\n').map(function(f) { return f.trim(); })
        .filter(function(f) {
            if (!f || f.indexOf('/') !== -1) return false; // root configs only
            return REVIEWER_CONTEXT_IDS[f.replace('.json', '')] === true;
        }).sort();
}

function promptPathOf(entry) {
    return (entry && typeof entry === 'object') ? String(entry.prompt || '') : String(entry || '');
}

suite('reviewPromptFreshness — every reviewer leg carries the full base contract (gh-1406)', function() {

    test('the base contract set is non-empty (the gate guards a real set)', function() {
        var base = listTrackedBaseFiles();
        assert.ok(base.length >= 6, 'expected the 6 base contract files, got: ' + base.join(', '));
    });

    test('every reviewer leg prompt list includes the full pr_review/base/ set', function() {
        var base = listTrackedBaseFiles();
        var configs = listReviewerConfigs();
        assert.ok(configs.length >= 4, 'expected the 4 reviewer legs, got: ' + configs.join(', '));
        // review_verdict_rules.md lives IN the base set (ticket §1 layout);
        // its pack reachability is pinned separately by the #605 anchor in
        // test_instructionRefs R4.
        var failures = [];
        configs.forEach(function(configPath) {
            var config = JSON.parse(readText(configPath));
            var prompts = (config.params && config.params.cliPrompts) || [];
            var paths = prompts.map(promptPathOf);
            base.forEach(function(basePath) {
                var referenced = './agents/' + basePath;
                if (paths.indexOf(referenced) === -1) {
                    failures.push(configPath + ': missing base contract file ' + referenced +
                        ' — every reviewer leg assembles [roleLine → base/* → lens → few-shots + verdict rules]');
                }
            });
        });
        assert.deepEqual(failures, [], 'freshness gate failures:\n' + failures.join('\n'));
    });

    test('the base reviewer leg no longer claims the security-expert persona', function() {
        var config = JSON.parse(readText('pr_review.json'));
        var prompts = (config.params && config.params.cliPrompts) || [];
        assert.equal(String(prompts[0]), 'Senior Code Reviewer',
            'the base role line drops "& Security Expert" — deep security is the specialist (gh-1406 §1)');
        prompts.forEach(function(p) {
            var role = typeof p === 'string' ? p : '';
            assert.ok(role.indexOf('Security Expert') === -1,
                'no reviewer leg prompt list claims the Security Expert persona');
        });
    });

    test('the generalist and security lenses exist and are non-empty', function() {
        ['instructions/pr_review/generalist/lens.md',
         'instructions/pr_review/generalist/few_shots.md',
         'instructions/pr_review/security/lens.md',
         'instructions/pr_review/security/few_shots.md',
         'instructions/pr_review/security/references.md'].forEach(function(path) {
            var text = readText(path);
            assert.ok(text && String(text).trim().length > 100, path + ' must exist and be non-empty');
        });
    });

    test('the factory skill files exist and parse (base + security, gh-1406 §4)', function() {
        var base = JSON.parse(readText('instructions/review/base.json'));
        assert.equal(base.name, 'base');
        assert.equal(base.isRequired, true, 'the factory base reviewer gates the merge');
        assert.equal(base.lens, 'instructions/pr_review/generalist/lens.md');
        var security = JSON.parse(readText('instructions/review/security.json'));
        assert.equal(security.name, 'security');
        assert.equal(security.isRequired, true, 'the security reviewer is the factory merge gate (gh-1406 §7)');
        assert.equal(security.isRequired === true && security.rounds.indexOf('first') !== -1 &&
            security.rounds.indexOf('hunks') !== -1, true, 'security ships rounds ["first","hunks"]');
        assert.deepEqual(security.triggerPaths, [], 'security ships triggerPaths [] — no path limitation');
        assert.ok(security.mayRaise.indexOf('BLOCKING') !== -1, 'mayRaise includes BLOCKING explicitly');
    });
});
