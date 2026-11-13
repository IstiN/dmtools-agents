/**
 * The reviewer-pool IN-JOB round setup for the pre-cli dispatcher
 * (preparePRForReview.js) — gh-1471.
 *
 * Split out of the dispatcher so each phase keeps its own (small) complexity
 * budget: the pool-resolution io, the hunks context, the specialist io and
 * the round execution are four functions here instead of one god function in
 * the dispatcher (whose module sits at the module-size top-level-function
 * limit). The dispatcher's module-scoped collaborators cross the boundary as
 * an explicit `deps` bag — read at CALL time, so the unit tests' mocked
 * globals keep working through the dispatcher adapter unchanged.
 */

var branchSetup = require('./branchSetup.js');
var reviewPoolModule = require('./reviewPool.js');
var reviewPoolInJob = require('./reviewPoolInJob.js');

/**
 * The pool-resolution io: file_list returns entry objects/JSON — normalized
 * through the sessionDelta parse (the same shape reviewPool's nameOf
 * accepts). Read failures are null (no pool → no round).
 */
function poolResolveIoOf(deps) {
    return {
        readFile: function(path) { try { return deps.file_read({ path: path }); } catch (e) { return null; } },
        listFiles: function(dir) {
            try {
                var raw = deps.file_list({ path: dir });
                var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                return Array.isArray(parsed) ? parsed : (parsed && parsed.entries) ? parsed.entries : [];
            } catch (eList) { return null; }
        }
    };
}

/**
 * The hunks context for the round: the diff-of-diff between the last
 * reviewed head and this one, as the `+++ b/` path list.
 */
function roundHunksOf(deps, ctx, prDetails, comments) {
    var heads = deps.resolveNewHunksContext(ctx, prDetails, comments);
    var hunks = heads ? deps.gitOps.getDiffBetweenCommits(heads.lastHead, heads.currentHead, ctx.config.workingDir) : null;
    var hunkPaths = [];
    if (hunks) {
        var matches = String(hunks).match(/^\+\+\+ b\/(.+)$/gm) || [];
        for (var m = 0; m < matches.length; m++) hunkPaths.push(matches[m].substring(6).trim());
    }
    return { hasNewHunks: !!hunks, newHunkPaths: hunkPaths };
}

/**
 * The in-job specialist io: the pre-cli sandbox spawns the leg sessions,
 * the prompts land in the ticket's input folder (the RETURN value is the
 * child-visible path), the candidates files resolve across the outputs/
 * and workingDir shapes.
 */
function inJobIoOf(deps, ctx) {
    return {
        executeCommand: function(command) {
            // The pre-cli sandbox exposes cli_execute_command (see
            // preCliTestAutomationSetup); `bash` is whitelisted by the
            // leg's CLI_ALLOWED_COMMANDS.
            deps.cli_execute_command({ command: command });
        },
        writeFile: function(path, content) {
            deps.gitOps.writeInputFile(path, content, 'pool specialist prompt');
            return path;
        },
        readFile: function(path) {
            var file = deps.outputFiles.readOutputFileDetailed(path, {
                ticketKey: ctx.ticketKey,
                workingDir: ctx.config && ctx.config.workingDir
            });
            return file && file.content ? file.content : null;
        },
        nowIso: function() { return new Date().toISOString(); }
    };
}

/** The in-job round outcome log — completed/unavailable lists, fail-open noted. */
function logInJobRoundOutcome(round) {
    if (round.completed.length === 0 && round.unavailable.length === 0) return;
    console.log('✅ Reviewer pool in-job round: completed [' + round.completed.join(', ') + ']' +
        (round.unavailable.length > 0 ? ', unavailable [' + round.unavailable.join(', ') + '] (fail-open)' : ''));
}

/** The round context: head sha + the hunks flags (the diff-of-diff paths). */
function roundContextOf(deps, ctx, prDetails, comments) {
    var hunks = roundHunksOf(deps, ctx, prDetails, comments);
    return {
        ticketKey: ctx.ticketKey,
        headSha: prDetails.head && prDetails.head.sha,
        hasNewHunks: hunks.hasNewHunks,
        newHunkPaths: hunks.newHunkPaths
    };
}

/** The comment list for the hunks step: the shared already-fetched list
 * wins; a direct call (the unit tests' shape) fetches its own. */
function roundCommentsOf(deps, ctx, prDetails, prComments) {
    return prComments === undefined
        ? deps.prCommentsForContextSteps(ctx.scm, prDetails.number) : prComments;
}

/** The pool for this run, or null (no pool config / an empty reviewer list —
 * the round is skipped and the plain single-reviewer floor applies). */
function resolvePoolOrNull(deps, ctx) {
    var jp = ctx.jp || ctx.params.jobParams || {};
    var pool = reviewPoolModule.resolvePool(poolResolveIoOf(deps), ctx.config, jp, {});
    if (!pool || pool.reviewers.length === 0) return null;
    return pool;
}

/**
 * The dispatcher's gh-1471 step: resolve the pool, materialize the round
 * context (head, hunks) and execute the specialists IN-JOB. Returns
 * { round, roundCtx } or null (dry runs, no pool, any failure — the
 * single-reviewer round is the fail-open floor).
 */
function reviewerPoolRoundSetup(deps, ctx, prDetails, prComments) {
    if (ctx.dryRun || branchSetup.isDryRunParams(ctx.params)) return null;
    try {
        var pool = resolvePoolOrNull(deps, ctx);
        if (!pool) return null;
        var comments = roundCommentsOf(deps, ctx, prDetails, prComments);
        var roundCtx = roundContextOf(deps, ctx, prDetails, comments);
        var round = reviewPoolInJob.runSpecialists(inJobIoOf(deps, ctx), pool, roundCtx);
        logInJobRoundOutcome(round);
        return { round: round, roundCtx: roundCtx };
    } catch (e) {
        console.warn('reviewer pool round setup failed (non-fatal, single-reviewer round):', e.message || e);
        return null;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        reviewerPoolRoundSetup: reviewerPoolRoundSetup,
        poolResolveIoOf: poolResolveIoOf,
        roundHunksOf: roundHunksOf,
        inJobIoOf: inJobIoOf,
        roundContextOf: roundContextOf,
        logInJobRoundOutcome: logInJobRoundOutcome
    };
}
