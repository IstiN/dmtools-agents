/**
 * Develop Bug and Create PR Post-Action
 * postJSAction for bug_development agent.
 *
 * Four possible outcomes determined by outputs written by the CLI agent:
 *
 *   outputs/blocked.json      → Bug cannot be fixed (needs human / credentials / etc.)
 *                               → Post Jira comment, move to Blocked, remove labels
 *
 *   outputs/already_fixed.json → Bug was fixed in a prior commit, no new code changes
 *                               → Post Jira comment with commit ref, move to Done
 *
 *   (neither file, but response.md missing) → CLI agent was interrupted (rate limit / crash)
 *                               → Push partial work (e.g. outputs/rca.md) if any
 *                               → Post informational comment, move to Ready For Development for retry
 *                               → Fail the run (gh-742) so the no-PR leg is a visible dead letter
 *
 *   (neither file, response.md present) → Normal fix — code changes made
 *                               → Delegate to developTicketAndCreatePR: commit, push, create PR, move to In Review
 */

var configLoader = require('./configLoader.js');
const { LABELS, resolveStatuses } = require('./config.js');
const developTicket = require('./developTicketAndCreatePR.js');
const commentMarkup = require('./common/commentMarkup.js');
const outputFiles = require('./common/outputFiles.js');
const gitStaging = require('./common/gitStaging.js');
// gh-1087: quota circuit-breaker — shared classification/comment contract
// with the story leg (both legs park the lane on a hard quota failure).
var quotaBreaker = require('./common/quotaCircuitBreaker.js');
var trackersModule = require('./common/trackers.js');

function cleanCliOutput(output) {
    return (output || '').split('\n').filter(function(l) {
        return l.trim() &&
               l.indexOf('Script started') === -1 &&
               l.indexOf('Script done') === -1 &&
               l.indexOf('COMMAND=') === -1 &&
               l.indexOf('COMMAND_EXIT_CODE=') === -1;
    }).join('').trim();
}

function readJson(path) {
    try {
        const raw = outputFiles.readOutputFile(path, {});
        return (raw && raw.trim()) ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function hasCodeGraphUsage() {
    try {
        const raw = file_read({ path: '.dmtools/codegraph-usage.log' });
        return !!(raw && raw.trim());
    } catch (e) {
        return false;
    }
}

/**
 * True when outputs/response.md exists with content. Thin wrapper over the
 * canonical outputFiles.hasOutputFile so the existence read shares one
 * candidate-expansion shape with developTicketAndCreatePR's content reader
 * (readResponseMd) — review round 1, duplicate-readers thread.
 */
function readHasResponseMd(ticketKey) {
    try {
        return outputFiles.hasOutputFile('response.md', { ticketKey: ticketKey });
    } catch (e) {
        return false;
    }
}

function removeLabels(ticketKey, params, tracker) {
    const wipLabel = params.metadata && params.metadata.contextId
        ? params.metadata.contextId + '_wip' : null;
    if (wipLabel) {
        try { tracker.removeLabel(ticketKey, wipLabel); } catch (e) {}
    }

    const customParams = params.jobParams && params.jobParams.customParams;
    const removeLabel = customParams && customParams.removeLabel;
    if (removeLabel) {
        try {
            tracker.removeLabel(ticketKey, removeLabel);
            console.log('✅ Removed SM label:', removeLabel);
        } catch (e) {}
    }
}

/**
 * gh-1003: `params.ticket ? params : (params.jobParams || params)` was
 * evaluated twice in action; one named helper owns the actual-params
 * resolution.
 */
function resolveActualParams(params) {
    return params.ticket ? params : (params.jobParams || params);
}

/**
 * gh-1003: Path 0 (PR already open) scan predicate extracted from action —
 * same listPrs('open') shape, same head.ref match, null-tolerant.
 */
function findOpenPrForBranch(openPrs, expectedBranch) {
    return (openPrs || []).filter(function(pr) {
        return pr && pr.head && pr.head.ref === expectedBranch;
    })[0];
}

/**
 * gh-1003: Path 0 comment builder — pure markup assembly extracted so the
 * comment contract is unit-testable.
 */
function buildPrAlreadyOpenComment(ticketKey, existingUrl) {
    const m = commentMarkup.forTicket(ticketKey);
    return m.h(3, 'ℹ️ PR Already Open') + '\n\n' +
            'A pull/merge request already exists for this ticket: ' + existingUrl + '\n\n' +
            'Moved ticket to ' + m.bold('In Review') + ' for review.';
}

/**
 * gh-1003: Path 1 comment bodies extracted from action. The blocked comment
 * keeps the reason/tried/needs assembly — a multi-item `tried` list renders
 * one bullet per entry.
 */
function buildBlockedComment(ticketKey, blocked) {
    const m = commentMarkup.forTicket(ticketKey);
    let comment = m.h(3, '🚫 Bug Cannot Be Fixed Automatically') + '\n\n';
    comment += m.bold('Reason') + ': ' + (blocked.reason || '(see details below)') + '\n\n';
    if (blocked.tried && blocked.tried.length > 0) {
        comment += m.bold('Attempted') + ':\n';
        blocked.tried.forEach(function(t) { comment += '- ' + t + '\n'; });
        comment += '\n';
    }
    if (blocked.needs) {
        comment += m.bold('Needs from human') + ': ' + blocked.needs + '\n';
    }
    return comment;
}

/**
 * gh-1003: the CodeGraph-rejection wording for a blocked.json without
 * recorded CodeGraph usage (Path 1a).
 */
function buildBlockedWithoutCodeGraphComment(ticketKey) {
    const m = commentMarkup.forTicket(ticketKey);
    return m.h(3, '⚠️ Blocked Claim Needs CodeGraph Verification') + '\n\n' +
            'The agent wrote `outputs/blocked.json`, but no CodeGraph usage was recorded. ' +
            'Source-code bugs must use CodeGraph before declaring the work blocked.\n\n' +
            'Resetting to ' + m.bold('Ready For Development') + ' for an automatic retry.';
}

/**
 * gh-1003: Path 2 comment builder — rca/commit/description are optional; the
 * CodeGraph-usage wording difference (with/without) is preserved verbatim.
 */
function buildAlreadyFixedComment(ticketKey, alreadyFixed, codeGraphUsed) {
    const m = commentMarkup.forTicket(ticketKey);
    let comment = m.h(3, '✅ Bug Already Fixed') + '\n\n';
    if (alreadyFixed.rca) {
        comment += m.bold('Root Cause') + ': ' + alreadyFixed.rca + '\n\n';
    }
    if (alreadyFixed.commit) {
        comment += m.bold('Fixed in commit') + ': ' + m.code(alreadyFixed.commit) + '\n\n';
    }
    if (alreadyFixed.description) {
        comment += alreadyFixed.description + '\n\n';
    }
    if (!codeGraphUsed) {
        comment += 'No new PR required — fix is already in the codebase. No CodeGraph usage was recorded, but the ticket is being moved to *Done* as requested.\n\n';
    } else {
        comment += 'No new PR required — fix is already in the codebase. Moved to *Done*.';
    }
    return comment;
}

/**
 * gh-1003: Path 3 interrupted-leg comment builder — the partial-work wording
 * depends only on whether any git changes were found.
 */
function buildInterruptedComment(ticketKey, hasGitChanges) {
    const m = commentMarkup.forTicket(ticketKey);
    return m.h(3, '⏸️ Development Interrupted') + '\n\nThe AI agent was interrupted (likely hit a rate limit) before completing the implementation. The ticket has been reset to ' + m.bold('Ready For Development') + ' and will be automatically retried.\n\n' +
            (hasGitChanges ? 'Partial analysis work was saved to the branch.' : 'No partial work was produced.');
}

/**
 * gh-1003: the `git status --porcelain` line filter extracted from action's
 * staging/status check — same four exclusions in the same order (factory-kit
 * gitlink, machine-local runtime artifacts, script noise).
 */
function isMeaningfulStatusLine(line) {
    return !!line.trim() &&
           !/^(\?\?|A )\s+factory-kit(\/|$)/.test(line) &&
           !gitStaging.isRuntimeArtifactStatusLine(line) &&
           line.indexOf('Script started') === -1 &&
           line.indexOf('Script done') === -1;
}

/**
 * gh-1003: the staging + porcelain-status probe extracted from action.
 * Receives the raw cli tool so both the untrack wrapper and the
 * buildStagingPathspecs check-ignore probe keep their original call shapes.
 * A staging failure degrades to "no changes" (as before), never a throw.
 */
function detectGitChanges(cliTool) {
    const run = function (command) { return cliTool({ command: command }); };
    try {
        try {
            // gh-628: untrack machine-local runtime logs carried by
            // already-poisoned branches (the timer's broad add swept
            // .dmtools/credential-helper.log onto ai/gh-628); the
            // staging pathspec below keeps them out going forward.
            // Shared canonical list: js/common/gitStaging.js.
            gitStaging.untrackRuntimeArtifacts(run);
        } catch (cleanupErr) {
            console.warn('Could not remove tracked Copilot session cache before checking status:', cleanupErr);
        }
        // `:!factory-kit` — the factory workflow's kit step materializes a
        // NESTED git repo at $GITHUB_WORKSPACE/factory-kit; staging that
        // unstaged gitlink dies exit 128 and kills the whole bug/rework
        // leg after a green dev run (same class as gh-1000 on the story
        // flow, #648). Excluded like copilot-sessions; the status filter
        // below skips its `?? factory-kit/` line too.
        // `:!.dmtools/...` runtime logs (gh-628) — excluded by pathspec
        // because they live next to COMMITTED .dmtools/ files.
        // gh-683 (live fa run 37153405587): the check-ignore probe
        // (via cli_execute_command) drops exclusions for paths git
        // already ignores — naming an existing ignored-untracked path
        // in an exclusion pathspec trips git add's ignored-files guard.
        // gh-1164: `factory-kit` goes through the same check-ignore
        // probe (inside buildStagingPathspecs' extraPaths) — a static
        // exclusion trips the same ignored-pathspec guard when the kit
        // is materialized AND gitignored.
        run('git add . -- ' + gitStaging.buildStagingPathspecs(cliTool, ['factory-kit']));
        const rawStatus = run('git status --porcelain') || '';
        return rawStatus.split('\n').filter(isMeaningfulStatusLine).length > 0;
    } catch (e) {
        console.warn('Could not check git status:', e);
        return false;
    }
}

/**
 * gh-1003: pure planner for the interrupted-leg partial-work push — decides
 * the target branch (expected branch wins over the current one), whether a
 * checkout switch is needed, and whether the push needs --force-with-lease
 * (partial work rescued from a protected branch). Returns null when there is
 * no branch to push at all.
 */
function decidePartialPush(currentBranch, expectedBranch, baseBranch) {
    const partialBranch = expectedBranch || currentBranch;
    if (!partialBranch) {
        return null;
    }
    return {
        branch: partialBranch,
        needsCheckout: currentBranch !== partialBranch,
        force: currentBranch === baseBranch || currentBranch === 'main' || currentBranch === 'master'
    };
}

/**
 * gh-1003: Path 0 completion extracted from action — posts the
 * already-open-PR comment, moves the ticket to In Review, removes SM labels
 * and returns the pr_already_open outcome. Tracker call order preserved.
 */
function handlePrAlreadyOpen(ticketKey, existingPr, tracker, statuses, params) {
    const existingUrl = existingPr.html_url || existingPr.url || ('#' + existingPr.number);
    console.log('⚠️  PR already open for', ticketKey, ':', existingUrl, '— skipping re-development');
    try {
        tracker.postComment(ticketKey, buildPrAlreadyOpenComment(ticketKey, existingUrl));
    } catch (e) {}
    try {
        tracker.moveToStatus(ticketKey, statuses.IN_REVIEW);
        console.log('✅ Moved', ticketKey, 'to In Review');
    } catch (e) { console.warn('Failed to move to In Review:', e); }
    removeLabels(ticketKey, params, tracker);
    return { success: true, path: 'pr_already_open', ticketKey };
}

/**
 * gh-1003: Path 1 completion extracted from action. Without recorded
 * CodeGraph usage the blocked claim is rejected and the ticket resets for a
 * retry; otherwise the blocked comment is posted and the ticket moves to
 * Blocked. Tracker call order (comment → move → labels) preserved.
 */
function completeBlockedPath(ticketKey, blocked, hasCodeGraph, tracker, statuses, jiraConfig, params) {
    if (!hasCodeGraph) {
        console.warn('outputs/blocked.json rejected — no CodeGraph usage was recorded');
        try {
            tracker.postComment(ticketKey, buildBlockedWithoutCodeGraphComment(ticketKey));
        } catch (e) {}
        try {
            tracker.moveToStatus(ticketKey, statuses.READY_FOR_DEVELOPMENT);
            console.log('✅ Moved', ticketKey, 'to Ready For Development for CodeGraph retry');
        } catch (e) {
            console.warn('Failed to move ticket to Ready For Development:', e);
        }
        removeLabels(ticketKey, params, tracker);
        return { success: true, path: 'blocked_without_codegraph', ticketKey };
    }

    try { tracker.postComment(ticketKey, buildBlockedComment(ticketKey, blocked)); } catch (e) {}

    try {
        tracker.moveToStatus(ticketKey, jiraConfig.statuses.BLOCKED);
        console.log('✅ Moved', ticketKey, 'to Blocked');
    } catch (e) {
        console.warn('Failed to move to Blocked:', e);
    }

    removeLabels(ticketKey, params, tracker);
    return { success: true, path: 'blocked', ticketKey };
}

/**
 * gh-1003: Path 2 completion extracted from action — posts the
 * already-fixed comment, moves the ticket to Done, stamps the
 * AI_DEVELOPED label, removes SM labels. Tracker call order preserved.
 */
function completeAlreadyFixedPath(ticketKey, alreadyFixed, hasCodeGraph, tracker, jiraConfig, params) {
    if (!hasCodeGraph) {
        console.warn('outputs/already_fixed.json accepted without CodeGraph usage');
    }
    try { tracker.postComment(ticketKey, buildAlreadyFixedComment(ticketKey, alreadyFixed, hasCodeGraph)); } catch (e) {}

    try {
        tracker.moveToStatus(ticketKey, jiraConfig.statuses.DONE);
        console.log('✅ Moved', ticketKey, 'to Done');
    } catch (e) {
        console.warn('Failed to move to Done:', e);
    }

    try { tracker.addLabel(ticketKey, LABELS.AI_DEVELOPED); } catch (e) {}

    removeLabels(ticketKey, params, tracker);
    return { success: true, path: 'already_fixed', ticketKey };
}

/**
 * gh-1087 AC2: the quota-park variant of the interrupted-leg tracker side
 * effects — park comment (provider / quota window / reset condition), park
 * label on the ticket AND on the open PR for the branch (if any), but NO
 * status reset: an immediate retry is guaranteed to fail against the quota
 * wall. The SM dispatch lanes skip the park label; a bounded probe or a
 * human lifts it (AC3).
 */
// gh-1087 AC2: the open PR for the branch (if any) carries the park label
// too, so the PR reads parked to humans and review automation.
function parkLabelOpenPr(parkLabel, config, ticket, scm) {
    try {
        var pr = findOpenPrForBranch(scm.listPrs('open'), configLoader.resolveBranchName(config, ticket, 'development'));
        if (pr && pr.number) {
            scm.addLabel(pr.number, parkLabel);
            console.log('🅿️  Added quota park label', parkLabel, 'to PR #' + pr.number);
        }
    } catch (e) {
        console.warn('Could not label the open PR with the quota park label (non-fatal):', e);
    }
}

function parkQuotaPath(ticketKey, config, ticket, tracker, params, scm, classification) {
    var jobParams = (params && params.jobParams) || {};
    var parkLabel = quotaBreaker.parkLabelOf(jobParams);
    var everyN = quotaBreaker.probeEveryOf(jobParams);
    var m = commentMarkup.forTicket(ticketKey);
    try {
        tracker.postComment(ticketKey, quotaBreaker.parkComment(m, classification, parkLabel, everyN));
    } catch (e) { }
    try {
        tracker.addLabel(ticketKey, parkLabel);
        console.log('🅿️  Added quota park label', parkLabel, 'to', ticketKey);
    } catch (e) {
        console.warn('Failed to add quota park label ' + parkLabel + ':', e);
    }
    parkLabelOpenPr(parkLabel, config, ticket, scm);
    console.log('🅿️  Quota-exhausted leg parked — ticket NOT reset; the SM will skip the', parkLabel,
        'lane until the quota window resets (probe every', everyN, 'ticks) or a human removes the label.');
}

/**
 * gh-1003: Path 3 interrupted-leg completion extracted from action — pushes
 * any partial work (planned by decidePartialPush), posts the informational
 * comment, resets the ticket for retry, removes SM labels and fails the run
 * via the shared throwInterruptedReset marker. Command and tracker call
 * order preserved.
 *
 * gh-1087: when the leg's failure text classifies as quota_exhausted the
 * reset is replaced by a quota park (label + comment + NO status reset) and
 * the run fails via the shared throwQuotaPark marker instead.
 */
function completeInterruptedPath(ticketKey, hasGitChanges, cliTool, config, ticket, tracker, statuses, params, scm, quotaClassification) {
    pushPreservedAnalysisWork(hasGitChanges, cliTool, config, ticket, ticketKey);
    parkQuotaInterruptedGate(ticketKey, config, ticket, tracker, params, scm, quotaClassification);
    resetTicketForRetry(ticketKey, hasGitChanges, tracker, statuses);

    removeLabels(ticketKey, params, tracker);
    // gh-742: ticket is reset for retry — fail the RUN so this
    // interrupted half-exit is a visible dead letter, not a green
    // no-PR leg that arms review downstream. The marked
    // throwInterruptedReset helper is shared from
    // developTicketAndCreatePR (required above) so the
    // marker/message contract lives in exactly one place.
    developTicket.throwInterruptedReset(ticketKey);
}

// gh-1003: the partial-work push from the interrupted path — the branch
// probe + decidePartialPush plan live in executePartialPushPlan.
function pushPreservedAnalysisWork(hasGitChanges, cliTool, config, ticket, ticketKey) {
    if (!hasGitChanges) {
        console.log('No git changes — nothing to push.');
        return;
    }
    console.log('Partial git changes found — pushing to preserve analysis work...');
    try {
        const currentBranch = cleanCliOutput(cliTool({ command: 'git branch --show-current' }));
        const expectedBranch = configLoader.resolveBranchName(config, ticket, 'development');
        const baseBranch = (config.git && config.git.baseBranch) || 'main';
        executePartialPushPlan(cliTool, config, ticketKey, decidePartialPush(currentBranch, expectedBranch, baseBranch), currentBranch);
    } catch (pushErr) {
        console.warn('Could not push partial work:', pushErr);
    }
}

function executePartialPushPlan(cliTool, config, ticketKey, plan, currentBranch) {
    if (!plan) {
        return;
    }
    if (plan.needsCheckout) {
        console.log('Switching partial work from ' + (currentBranch || '(unknown)') +
            ' to development branch: ' + plan.branch);
        cliTool({ command: 'git checkout -B ' + plan.branch });
    }
    pushPartialWork(cliTool, config, ticketKey, plan);
}

/**
 * gh-1087 AC1/AC2: the quota variant of the interrupted-leg completion —
 * when the leg's failure text classifies as quota_exhausted the ticket is
 * PARKED (label + comment + NO status reset) and the run fails with the
 * shared quotaPark marker (same dead-letter contract as gh-742). Transient
 * or unknown classifications are a no-op here (the classic gh-742 reset
 * below handles them).
 */
function parkQuotaInterruptedGate(ticketKey, config, ticket, tracker, params, scm, quotaClassification) {
    if (!quotaClassification || quotaClassification.kind !== 'quota_exhausted') {
        return;
    }
    parkQuotaPath(ticketKey, config, ticket, tracker, params, scm, quotaClassification);
    removeLabels(ticketKey, params, tracker);
    developTicket.throwQuotaPark(ticketKey, quotaBreaker.parkLabelOf((params && params.jobParams) || {}));
}

/**
 * gh-1087: the development context the delegated quota gate needs — the park
 * labels the open PR and resolves jobParams (park label / probe cadence
 * config). The CLI outcome signals are classified by the shared text
 * contract so both legs classify byte-identically.
 */
function quotaGateContextOf(actualParams, params, ticketKey, customParams, expectedBranch) {
    return {
        ticketKey: ticketKey,
        customParams: customParams,
        metadata: actualParams.metadata || null,
        expectedBranch: expectedBranch,
        branchName: null,
        jobParams: params.jobParams || {}
    };
}

function quotaFailureClassificationOf(actualParams) {
    return quotaBreaker.classifyFailure(
        developTicket.classifyInterruptedText(actualParams.currentCliErrorMessage || null, actualParams.response || ''));
}

/**
 * gh-1003: the marked-failure rethrow predicate from action's catch block —
 * the deliberate loud failures (fatal CLI environment, git-operations
 * gh-683, PR-creation gh-729, interrupted-reset gh-742) must keep
 * propagating so the RUN is RED.
 */
function isPropagatingFailure(error) {
    return !!(error && (error.fatalCliEnvironment || error.gitOperationsFailure || error.prCreationFailure || error.interruptedReset || error.quotaPark));
}

/**
 * gh-1003: the custom-params resolution from action's head — jobParams win,
 * then the actual params' own customParams.
 */
function resolveCustomParams(params, actualParams) {
    return (params.jobParams && params.jobParams.customParams) || actualParams.customParams;
}

/**
 * gh-1003: the interrupted-leg partial-work push commands, planned by
 * decidePartialPush — config/commit/push order preserved verbatim.
 */
function pushPartialWork(cliTool, config, ticketKey, plan) {
    cliTool({ command: 'git config user.name "' + config.git.authorName + '"' });
    cliTool({ command: 'git config user.email "' + config.git.authorEmail + '"' });
    cliTool({ command: 'git commit -m "' + configLoader.formatTemplate(config.formats.commitMessage.wip, {ticketKey: ticketKey}) + '"' });
    let pushCommand = 'git push -u origin ' + plan.branch;
    if (plan.force) {
        pushCommand += ' --force-with-lease';
    }
    cliTool({ command: pushCommand });
    console.log('✅ Pushed partial analysis to branch:', plan.branch);
}

/**
 * gh-1003: the interrupted-leg tracker side effects — informational comment
 * first, then the Ready For Development reset (comment → move order
 * preserved).
 */
function resetTicketForRetry(ticketKey, hasGitChanges, tracker, statuses) {
    try {
        tracker.postComment(ticketKey, buildInterruptedComment(ticketKey, hasGitChanges));
    } catch (e) {}

    try {
        tracker.moveToStatus(ticketKey, statuses.READY_FOR_DEVELOPMENT);
        console.log('✅ Moved', ticketKey, 'to Ready For Development for retry');
    } catch (e) {
        console.warn('Failed to move ticket to Ready For Development:', e);
    }
}

function action(params) {
    try {
        const actualParams = resolveActualParams(params);
        const ticketKey = actualParams.ticket.key;
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var jiraConfig = config.jira;
        var scm = configLoader.createScm(config);
        const _customParams = resolveCustomParams(params, actualParams);
        const statuses = resolveStatuses(_customParams, jiraConfig && jiraConfig.statuses);
        var tracker = trackersModule.createTracker(config, _customParams || {});

        console.log('=== Bug development post-action for', ticketKey, '===');

        // ── Path 0: PR already open — skip re-development ───────────────────
        // If a PR already exists for this ticket's branch, the previous run created
        // it but failed to move the ticket to In Review (e.g. was interrupted).
        // Move to In Review now and skip development entirely.
        const expectedBranch = configLoader.resolveBranchName(config, actualParams.ticket, 'development');
        try {
            const existingPr = findOpenPrForBranch(scm.listPrs('open'), expectedBranch);
            if (existingPr) {
                return handlePrAlreadyOpen(ticketKey, existingPr, tracker, statuses, params);
            }
        } catch (prCheckErr) {
            console.warn('Could not check existing PRs (non-fatal):', prCheckErr);
        }

        // ── Path 1: Blocked ──────────────────────────────────────────────────
        const blocked = readJson('outputs/blocked.json');
        if (blocked) {
            console.log('outputs/blocked.json found — bug cannot be fixed automatically');
            return completeBlockedPath(ticketKey, blocked, hasCodeGraphUsage(), tracker, statuses, jiraConfig, params);
        }

        // ── Path 2: Already Fixed ────────────────────────────────────────────
        const alreadyFixed = readJson('outputs/already_fixed.json');
        if (alreadyFixed) {
            console.log('outputs/already_fixed.json found — bug already resolved in codebase');
            return completeAlreadyFixedPath(ticketKey, alreadyFixed, hasCodeGraphUsage(), tracker, jiraConfig, params);
        }

        // ── Path 3: Normal Fix — code changes present ────────────────────────
        console.log('No special outputs found — proceeding with normal PR creation');

        // gh-729 (live fa gh-1197, run 37234028759): the job log went silent
        // between the staging check-ignore probes and the delegated
        // developTicketAndCreatePR call — 23s with no git add, no error, and
        // the leg still reported success with no PR. Every step below logs,
        // so a future stall in this window is diagnosable from the job log.
        console.log('Staging + status check: inspecting the working tree for agent changes...');

        // Before delegating, check if the CLI agent was interrupted (no response.md, no code changes).
        // If there ARE git changes (e.g. outputs/rca.md written) but no response.md, the agent
        // was interrupted mid-way. Push partial work and reset ticket for retry.
        // gh-1003: the staging + porcelain-status probe (with the gh-628 /
        // gh-683 / gh-1164 exclusion comments) lives in detectGitChanges.
        const hasGitChanges = detectGitChanges(cli_execute_command);

        let hasResponseMd = readHasResponseMd(ticketKey);

        console.log('Working tree check: git changes present = ' + hasGitChanges +
            '; outputs/response.md = ' + (hasResponseMd ? 'present' : 'MISSING') +
            (hasGitChanges || hasResponseMd ? '' : ' — neither work nor a response; the agent produced nothing'));

        // gh-775: ONE shared gate (developTicketAndCreatePR.recoverMissingResponse)
        // for every response.md-missing cold-reset site — the gating order (fatal
        // CLI/environment class FIRST: the resume never preempts it — AC6; then
        // exactly ONE bounded resume attempt; then the re-read) lives in exactly
        // one place. The bug leg passes its own CLI outcome signals so a fatally
        // broken environment (missing binary, unknown provider, exit 127) skips
        // the doomed attempt exactly like the story leg.
        if (!hasResponseMd) {
            const recovered = developTicket.recoverMissingResponse(
                ticketKey,
                _customParams,
                actualParams.response || '',
                actualParams.currentCliHasFatalError === true,
                actualParams.currentCliErrorMessage || null,
                // gh-1087: context for the delegated quota gate — the park
                // labels the open PR and resolves jobParams (park label /
                // probe cadence config).
                quotaGateContextOf(actualParams, params, ticketKey, _customParams, expectedBranch));
            hasResponseMd = !!(recovered && recovered.trim());
        }

        // gh-1087 AC1: classify the leg's failure text BEFORE the interrupted
        // path decides — a hard quota failure parks the lane instead of
        // resetting for a guaranteed-fail retry (transient keeps gh-742).
        var quotaCls = quotaFailureClassificationOf(actualParams);

        if (!hasResponseMd) {
            // CLI agent did not finish (rate limit / crash). Push whatever partial work exists
            // (e.g. outputs/rca.md) and reset the ticket so SM can retry.
            // gh-1003: the partial-work push + comment + reset sequence lives
            // in completeInterruptedPath (planned by decidePartialPush).
            console.log('outputs/response.md missing — CLI agent was interrupted. Resetting ticket for retry.');
            return completeInterruptedPath(ticketKey, hasGitChanges, cli_execute_command, config, actualParams.ticket, tracker, statuses, params, scm, quotaCls);
        }

        const result = developTicket.action(params);

        // Always remove SM idempotency label — even on failure — to avoid permanent lock
        // (developTicketAndCreatePR doesn't know about SM labels)
        removeLabels(ticketKey, params, tracker);

        return result;

    } catch (error) {
        console.error('❌ Error in developBugAndCreatePR:', error);
        // Marked failures from the delegated developTicketAndCreatePR (fatal
        // CLI environment, git-operations gh-683, PR-creation gh-729,
        // interrupted-reset gh-742) must keep propagating so the RUN is RED —
        // swallowing them here would turn a deliberate loud failure back into
        // a returned result.
        if (isPropagatingFailure(error)) {
            throw error;
        }
        try {
            const key = (params.ticket || (params.jobParams && params.jobParams.ticket) || {}).key;
            if (key) {
                tracker.postComment(key, commentMarkup.forTicket(key).h(3, '❌ Bug Development Error') + '\n\n' + commentMarkup.forTicket(key).code(error.toString())
                );
            }
        } catch (e) {}
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action,
        // gh-1003: pure helpers extracted from action — exported for direct
        // characterization tests.
        resolveActualParams,
        findOpenPrForBranch,
        buildPrAlreadyOpenComment,
        buildBlockedComment,
        buildBlockedWithoutCodeGraphComment,
        buildAlreadyFixedComment,
        buildInterruptedComment,
        isMeaningfulStatusLine,
        detectGitChanges,
        decidePartialPush,
        isPropagatingFailure,
        resolveCustomParams,
        pushPartialWork,
        resetTicketForRetry,
        handlePrAlreadyOpen,
        completeBlockedPath,
        completeAlreadyFixedPath,
        completeInterruptedPath,
        // gh-1087: quota park path — exported for direct characterization tests.
        parkQuotaPath
    };
}
