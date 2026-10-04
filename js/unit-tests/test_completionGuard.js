/**
 * Unit tests: story_development pack completion guard (gh-712)
 *
 * Incident (live, fa gh-1164, runs of 2026-10-03/04): a dev leg lost its
 * work (never-committed autosave), the NEXT leg — fresh branch off main —
 * read session memory ("task complete"), saw main's release tip in git log,
 * and concluded the work was committed without ever diffing against
 * origin/main. Endgame: "No changes to commit" → "No Code Changes Needed"
 * posted → review armed with no PR.
 *
 * The js-side landing guard (developTicketAndCreatePR.branchCarriesWork)
 * catches this only AFTER the agent finished, via an expensive resume
 * round-trip. This test pins the missing pack-level rule: the
 * story_development instructions must force the agent itself to prove the
 * work landed BEFORE writing outputs/response.md or concluding "no changes
 * needed".
 *
 * Guard contract (from the ticket):
 *   1. general_guidelines.md flowchart must contain a completion-guard step
 *      running `git fetch origin main && git log origin/main..HEAD --oneline`
 *      with an EMPTY result treated as "work did not land".
 *   2. output_rules.md must make that guard a precondition of writing
 *      outputs/response.md AND of any "no changes needed" conclusion.
 *
 * Uses: file_read(), suite(), test(), assert. Tests run with cwd = repo
 * root (agents/), so instruction paths resolve directly.
 */

var GUIDELINES = 'instructions/story_development/general_guidelines.md';
var OUTPUT_RULES = 'instructions/story_development/output_rules.md';

function readPackFile(path) {
    var c = file_read({ path: path });
    if (c === null || c === undefined) {
        throw new Error('cannot read pack file: ' + path);
    }
    return typeof c === 'string' ? c : String(c);
}

suite('completion guard — story_development pack (gh-712)', function () {

    test('general_guidelines.md contains the completion guard command', function () {
        var text = readPackFile(GUIDELINES);
        assert.ok(text.indexOf('git fetch origin main') !== -1,
            'guidelines must instruct the agent to fetch the base branch before proving completion');
        assert.ok(text.indexOf('git log origin/main..HEAD --oneline') !== -1,
            'guidelines must instruct the agent to diff HEAD against the base branch');
    });

    test('general_guidelines.md treats an empty diff as "work did not land"', function () {
        var text = readPackFile(GUIDELINES).toLowerCase();
        assert.ok(text.indexOf('empty') !== -1 && text.indexOf('did not land') !== -1,
            'an empty origin/main..HEAD result must be defined as "work did not land" — ' +
            're-do/resume instead of reporting done');
    });

    test('completion guard runs BEFORE writing outputs/response.md', function () {
        var text = readPackFile(GUIDELINES);
        var guardIdx = text.indexOf('origin/main..HEAD');
        var summaryIdx = text.indexOf('outputs/response.md');
        assert.ok(guardIdx !== -1, 'guard step missing entirely');
        assert.ok(summaryIdx !== -1, 'response.md step missing entirely');
        assert.ok(guardIdx < summaryIdx,
            'the completion guard must appear in the flow BEFORE the "write outputs/response.md" step');
    });

    test('output_rules.md makes the guard a precondition of response.md and of "no changes needed"', function () {
        var text = readPackFile(OUTPUT_RULES);
        assert.ok(text.indexOf('git log origin/main..HEAD --oneline') !== -1,
            'output_rules must carry the guard command, not just the guidelines');
        assert.ok(text.indexOf('no changes needed') !== -1,
            'output_rules must extend the same guard to the "no changes needed" conclusion');
        var guardIdx = text.indexOf('origin/main..HEAD');
        var responseIdx = text.indexOf('outputs/response.md');
        assert.ok(guardIdx < responseIdx,
            'guard rule must be stated before the response.md output contract');
    });
});
