/**
 * Unit tests for scripts/restore-fa-session.sh — the engine-side fa session
 * restore (dmtools-agents#943 moved the lifecycle block from the awf
 * factory-kit into this repo; the factory-teammate workflow executes THIS
 * copy via the factory-setup zip).
 *
 * RCA (gh-944, night operation 2026-10-17 — 2/2 repro on #925, first
 * dev-leg run 38965689543 and its 01:01Z retry): the restore fetched the
 * fa-sess/<anchor> branch with a BARE `refs/heads/<branch>` refspec. In an
 * actions/checkout shallow single-branch clone (remote.origin.fetch =
 * +refs/heads/<head>:refs/remotes/origin/<head>) that fetch SUCCEEDS yet
 * materializes NO refs/remotes/origin/<branch> tracking ref — the following
 * `git checkout refs/remotes/origin/<branch> -- .dmtools/fa-sessions` then
 * dies (rc 128 `fatal: invalid reference` on modern git; rc 1
 * `error: pathspec '.dmtools/fa-sessions' did not match any file(s) known
 * to git` when the ref resolves but the branch tree carries no store — the
 * exact gh-944 message). Under the step's `bash -e` either shape kills the
 * whole dev leg. Acceptance (a): a dev leg for an issue with NO prior
 * fa-sess branch — or with a branch that exists but carries no session
 * store — must complete without pathspec errors: the restore must be a
 * clean no-op ("starting fresh") in both shapes.
 *
 * Verified git mechanics (git 2.55 sandbox, gh-944 dev leg):
 *   - explicit fetch WITH a destination refspec always creates the tracking
 *     ref (`* [new branch] <b> -> origin/<b>`) and fails cleanly when the
 *     branch is absent;
 *   - `git ls-tree --name-only <ref> -- <path>` prints nothing when the
 *     path is absent (rc 0) and stays safe inside `[ -n "$(...)" ]` even
 *     for an unresolvable ref.
 *
 * The script is bash (the workflow step runs `bash -e`), so these tests pin
 * the CONTRACT textually (same pattern as test_faSessionQuarantine.js
 * pinning the workflow YAML) — the observable step behavior is the script
 * text the factory-setup zip ships.
 *
 * Uses: file_read(), suite(), test(), assert
 */

var script = file_read({ path: 'scripts/restore-fa-session.sh' });

suite('restore-fa-session.sh — first-session no-op contract (gh-944)', function () {

    test('fetch carries a force destination refspec — the tracking ref must always materialize', function () {
        assert.ok(
            script.indexOf('+refs/heads/$FA_SESS_BRANCH:refs/remotes/origin/$FA_SESS_BRANCH') !== -1,
            'fetch must use "+refs/heads/$FA_SESS_BRANCH:refs/remotes/origin/$FA_SESS_BRANCH" — ' +
            'a bare refs/heads/<branch> refspec leaves refs/remotes/origin/<branch> unresolved in ' +
            'single-branch clones and the checkout dies (gh-944 rc 128)');
        assert.ok(script.indexOf('git fetch --depth 1 origin "+refs/heads/$FA_SESS_BRANCH') !== -1,
            'the depth-1 fetch is the one carrying the destination refspec');
    });

    test('no bare-branch fetch remains (the gh-944 shape must be gone)', function () {
        assert.equal(
            script.indexOf('git fetch --depth 1 origin "refs/heads/$FA_SESS_BRANCH"'), -1,
            'the bare refs/heads/$FA_SESS_BRANCH fetch (no destination) is the bug — it must not remain');
    });

    test('an ls-tree guard precedes the checkout — a branch with no store is a no-op', function () {
        var guard = script.indexOf('git ls-tree --name-only "refs/remotes/origin/$FA_SESS_BRANCH" -- .dmtools/fa-sessions');
        var checkout = script.indexOf('git checkout "refs/remotes/origin/$FA_SESS_BRANCH" -- .dmtools/fa-sessions');
        assert.ok(guard !== -1, 'ls-tree path guard present');
        assert.ok(checkout !== -1, 'the checkout is still present');
        assert.ok(guard < checkout,
            'the checkout must run only after the ls-tree guard — a branch that exists but carries ' +
            'no .dmtools/fa-sessions (first-session shape) must not reach it (gh-944 pathspec error)');
    });

    test('the guarded checkout keeps the unstage follow-up (checkout <ref> -- <path> STAGES)', function () {
        var restoreStaged = script.indexOf('git restore --staged .dmtools/fa-sessions');
        var checkout = script.indexOf('git checkout "refs/remotes/origin/$FA_SESS_BRANCH" -- .dmtools/fa-sessions');
        assert.ok(restoreStaged !== -1, 'git restore --staged present');
        assert.ok(restoreStaged > checkout,
            'the unstage must follow the checkout — the session store belongs on the fa-sess branch only');
    });

    test('both no-session shapes land in a clean "starting fresh" branch, never an error', function () {
        assert.ok(script.indexOf('— starting fresh') !== -1,
            'absent-branch fetch failure still prints the fresh-start message');
        assert.ok(script.indexOf('carries no fa session store') !== -1,
            'the ls-tree else-branch (branch exists, store absent) prints its own fresh-start message');
    });
});
