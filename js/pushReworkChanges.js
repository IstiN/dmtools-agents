/**
 * Push Rework Changes Post-Action
 * postJSAction for pr_rework agent:
 * 1. Stages, commits, and pushes changes to the existing PR branch
 * 2. Posts replies to each open PR review thread and resolves the threads
 * 3. Posts the fix summary (outputs/response.md) as a top-level PR comment
 * 4. Moves ticket to "In Review"
 * 5. Posts completion comment to the ticket (Jira/ADO/GitHub via common/trackers.js)
 */

var configLoader = require('./configLoader.js');
var scmModule = require('./common/scm.js');
const commentMarkup = require('./common/commentMarkup.js');
var trackersModule = require('./common/trackers.js');
var submoduleHelper = require('./common/submodules.js');
var prHelper = require('./common/pullRequest.js');
var ghHelpers = require('./common/githubHelpers.js');
var feedbackLoop = require('./common/feedbackLoop.js');
var autoStart = require('./common/autoStart.js');
var outputFiles = require('./common/outputFiles.js');
var gitStaging = require('./common/gitStaging.js');
const { GIT_CONFIG, STATUSES, LABELS, resolveStatuses } = require('./config.js');
var cacheToReleases = require('./cacheToReleases.js');
var tokenUsageComment = require('./common/tokenUsageComment.js');

/**
 * Wraps feedbackLoop.resumeAgent() so an unexpected failure inside it (e.g. its own
 * mkdir/bash/run-agent.sh --continue self-invocation being blocked by a
 * misconfigured CLI_ALLOWED_COMMANDS whitelist) can never throw out of a call site.
 * Every caller treats { attempted: false } as "could not resume" and falls through to
 * posting an honest error comment / resetting the ticket — an uncaught throw here would
 * skip that fallback entirely and leave the ticket silently stuck.
 */
function tryResumeAgent(options) {
    try {
        return feedbackLoop.resumeAgent(options);
    } catch (resumeError) {
        console.error('tryResumeAgent: feedbackLoop.resumeAgent failed unexpectedly — treating as "not attempted" so the caller\'s reset/error-comment fallback still runs:', resumeError);
        return { attempted: false };
    }
}

/**
 * Returns true if the Jira ticket has the pr_approved label.
 */
function hasPrApprovedLabel(ticket) {
    var labels = (ticket && ticket.fields && ticket.fields.labels) ? ticket.fields.labels : [];
    return labels.indexOf(LABELS.PR_APPROVED) !== -1;
}

/**
 * pr_approved stickiness beats rework completion (owner rule 2026-09-21):
 * once a review concluded APPROVED, NO later rework leg may clear
 * ai_pr_reviewed or arm a re-review — the reworked head just re-validates
 * and merges. The verdict lives on the PR (REST labels: [{name}] objects
 * or strings); the ticket-hydration path (hasPrApprovedLabel) is the
 * fallback when the PR body is unavailable.
 */
function prHasApproved(pr, ticket) {
    if (pr && Array.isArray(pr.labels)) {
        for (var i = 0; i < pr.labels.length; i++) {
            var l = pr.labels[i];
            var name = (l && typeof l === 'object') ? l.name : l;
            if (name === LABELS.PR_APPROVED) return true;
        }
    }
    return hasPrApprovedLabel(ticket);
}

function normalizeLabels(singleLabel, labelList) {
    var labels = [];
    if (singleLabel) labels.push(singleLabel);
    if (Array.isArray(labelList)) {
        labelList.forEach(function(label) {
            if (label && labels.indexOf(label) === -1) labels.push(label);
        });
    }
    return labels;
}

function removeConfiguredLabels(tracker, ticketKey, customParams) {
    normalizeLabels(customParams && customParams.removeLabel, customParams && customParams.removeLabels)
        .forEach(function(label) {
            try {
                tracker.removeLabel(ticketKey, label);
                console.log('✅ Removed SM label:', label);
            } catch (e) {
                console.warn('Failed to remove SM label ' + label + ':', e);
            }
        });
}

function resolveCustomParams(params, actualParams, config) {
    var merged = {};
    var patch = configLoader.resolveInstructions(
        'pr_rework',
        null,
        config
    ).jobParamPatch;
    if (patch && patch.customParams) {
        Object.assign(merged, patch.customParams);
    }
    Object.assign(
        merged,
        (params.jobParams && params.jobParams.customParams) ||
            (actualParams && actualParams.customParams) ||
            params.customParams ||
            {}
    );
    return merged;
}

function cleanCommandOutput(output) {
    if (!output) {
        return '';
    }
    const lines = output.split('\n').filter(function(line) {
        return line.indexOf('Script started') === -1 &&
               line.indexOf('Script done') === -1 &&
               line.indexOf('COMMAND=') === -1 &&
               line.indexOf('COMMAND_EXIT_CODE=') === -1;
    });
    return lines.join('\n').trim();
}

function getGitHubRepoInfo() {
    try {
        const remoteUrl = cleanCommandOutput(
            cli_execute_command({ command: 'git config --get remote.origin.url' }) || ''
        );
        const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/?#\s]+)/);
        if (!match) {
            return null;
        }
        return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
    } catch (error) {
        console.error('Failed to get GitHub repo info:', error);
        return null;
    }
}

/**
 * Greppable failure marker for PR-lookup failures in the post-action. Appears
 * in the leg log, in the action result (job summary), and in the tracker error
 * comment — so an operator can find every empty-rework-lap incident by grep.
 */
var PR_LOOKUP_FAILED_PREFIX = 'PR-LOOKUP-FAILED:';

function findPRForTicket(scm, ticketKey) {
    // PR-anchored (githubSource #544): a pseudo-ticket key 'pr-N' IS the PR —
    // resolve it directly by number via the shared helper's deterministic
    // get-by-number path. Never list-scan a pseudo key: the PR's title/branch
    // reference the ORIGINAL work item (live fa #1212, 2026-10-04: key
    // 'pr-1212', branch 'ai/gh-1204' — the scan matched nothing and the
    // replies/resolutions were silently skipped). Jira-shaped keys keep the
    // unchanged substring scan below (byte-identical jiraSource behavior).
    if (/^pr-(\d+)$/.test(String(ticketKey || ''))) {
        return ghHelpers.findPRForTicket(scm, ticketKey);
    }
    try {
        const openPRs = scm.listPrs('open');

        const matching = openPRs.filter(function(pr) {
            return (pr.title && pr.title.indexOf(ticketKey) !== -1) ||
                   (pr.head && pr.head.ref && pr.head.ref.indexOf(ticketKey) !== -1);
        });

        if (matching.length > 0) {
            return matching[0];
        }

        console.warn('No open PR found for ticket', ticketKey);
        return null;
    } catch (error) {
        console.error('Failed to find PR:', error);
        return null;
    }
}

function configureGitAuthor(config) {
    try {
        cli_execute_command({ command: 'git config user.name "' + config.git.authorName + '"' });
        cli_execute_command({ command: 'git config user.email "' + config.git.authorEmail + '"' });
        return true;
    } catch (error) {
        console.error('Failed to configure git author:', error);
        return false;
    }
}

/**
 * gh-711 (live fa queue 2026-10-04, fa #1212/#1217/#1221/#1222/#1223/#1225):
 * a rework commit message may carry a CI-skip directive (project-configured
 * `formats.commitMessage.rework` template — "correct" for CI-noise on
 * data-only branches). On a validation-bound PR branch that directive
 * suppresses CI entirely: the required check never registers on the new
 * head and the PR sits BLOCKED with green latches until a human dispatches
 * ci.yml manually. A rework push exists precisely to re-validate the PR,
 * so the directive is stripped here — GitHub honors skip directives
 * case-insensitively ([skip ci], [ci skip], [no ci], [skip actions],
 * [actions skip]), the whole bracket token is removed, and the cleaned-up
 * whitespace collapse keeps the message readable. Branches that genuinely
 * must not run CI (e.g. factory-data publishes) never pass through here.
 */
function stripCiSkipTokens(message) {
    if (!message) return message;
    return String(message)
        .replace(/\[(skip[\s-]?ci|ci[\s-]?skip|no[\s-]?ci|skip[\s-]?actions|actions[\s-]?skip)\]/gi, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

function commitAndPush(ticketKey, config, customParams) {
    var workingDir = config.workingDir || null;
    var cmdOpts = workingDir ? { workingDirectory: workingDir } : {};
    var cmd = function(command) { return cli_execute_command(Object.assign({}, cmdOpts, { command: command })); };

    // Read expected branch from pr_info.md (written by preCliReworkSetup).
    // Do NOT trust git branch --show-current — the CLI agent may have switched branches.
    var expectedBranch = null;
    try {
        var prInfoPath = 'input/' + ticketKey + '/pr_info.md';
        var prInfo = file_read({ path: prInfoPath }) || '';
        var branchMatch = prInfo.match(/\*\*Branch\*\*:\s*`([^`]+)`/);
        if (branchMatch) expectedBranch = branchMatch[1].trim();
    } catch (e) {
        throw new Error('Missing PR context file input/' + ticketKey + '/pr_info.md. Rework setup did not find or checkout a PR; refusing to commit or push.');
    }
    if (!expectedBranch) {
        throw new Error('Could not determine expected PR branch from input/' + ticketKey + '/pr_info.md; refusing to commit or push.');
    }
    var baseBranch = (config.git && config.git.baseBranch) || 'main';
    try {
        var baseMatch = prInfo.match(/\*\*Branch\*\*:\s*`[^`]+`\s*→\s*`([^`]+)`/);
        if (baseMatch && baseMatch[1]) baseBranch = baseMatch[1].trim();
    } catch (e) {}

    var currentBranch = cleanCommandOutput(cmd('git branch --show-current') || '');
    console.log('Current branch:', currentBranch, '| Expected:', expectedBranch);

    var branchName = currentBranch;
    if (expectedBranch && currentBranch !== expectedBranch) {
        console.warn('⚠️ Branch mismatch — forcing checkout to expected branch:', expectedBranch);
        try {
            cmd('git checkout ' + expectedBranch);
            branchName = expectedBranch;
            console.log('✅ Switched to expected branch:', branchName);
        } catch (e) {
            console.warn('Could not checkout expected branch, using current:', currentBranch, e);
        }
    }

    // Hard invariant: never commit/push while sitting on the base branch —
    // if the forced checkout above didn't work and we're still parked on
    // baseBranch, refuse rather than pushing WIP straight into the mainline.
    if (branchName && branchName === baseBranch) {
        throw new Error('Refusing to commit/push: current branch "' + branchName +
            '" is the base branch (' + baseBranch + '), not the expected PR branch "' + expectedBranch + '".');
    }

    submoduleHelper.pushManagedSubmodules({
        run: cmd,
        cleanOutput: cleanCommandOutput,
        config: config,
        customParams: customParams,
        ticketKey: ticketKey
    });

    try {
        // gh-628: untrack machine-local runtime logs carried by
        // already-poisoned branches (a broad add swept the credential
        // helper's serving trace onto ai/gh-628); the staging pathspec
        // below keeps them out going forward. Shared canonical list:
        // js/common/gitStaging.js.
        cmd(gitStaging.buildUntrackCommand());
    } catch (cleanupErr) {
        console.warn('Could not remove tracked Copilot session cache before staging:', cleanupErr);
    }

    // `:!factory-kit` — nested machine-infra gitlink must not kill rework staging (#648 class)
    // `:!.dmtools/...` runtime logs (gh-628) — excluded by pathspec because
    // they live next to COMMITTED .dmtools/ files.
    // gh-683 (live fa run 37153405587): the check-ignore probe (via cmd)
    // drops exclusions for paths git already ignores — naming an existing
    // ignored-untracked path in an exclusion pathspec trips git add's
    // ignored-files guard and kills the leg.
    // gh-1164: `factory-kit` is probe-filtered like the runtime artifacts —
    // a static `:!factory-kit` exclusion trips git add's ignored-pathspec
    // guard when the kit is materialized AND gitignored.
    cmd('git add . -- ' + gitStaging.buildStagingPathspecs(function (args) {
        return cmd(args.command);
    }, ['factory-kit']));

    const status = prHelper.readStagedDiffStat(cmd, workingDir);

    var hasChanges = false;
    if (status.trim()) {
        const commitMsg = stripCiSkipTokens(configLoader.formatTemplate(config.formats.commitMessage.rework, {ticketKey: ticketKey}));
        cmd('git commit -m "' + commitMsg + '"');
        console.log('✅ Committed rework changes');
        hasChanges = true;
    } else {
        console.warn('No file changes detected — pushing existing commits only');
    }

    var syncResult = prHelper.syncBranchWithBase({
        branchName: branchName,
        baseBranch: baseBranch,
        workingDir: workingDir,
        runCommand: function(command, dir) {
            var args = { command: command };
            if (dir) args.workingDirectory = dir;
            return cli_execute_command(args);
        }
    });
    if (!syncResult.success) {
        throw new Error('Could not sync PR branch with origin/' + baseBranch + ' before rework push: ' + syncResult.error);
    }

    try {
        cmd('git push -u origin ' + branchName);
    } catch (pushError) {
        console.warn('Normal push failed; synchronizing with origin/' + branchName + ' before retry:', pushError.message || pushError);
        try {
            cmd('git -c fetch.recurseSubmodules=no fetch origin ' + branchName + ':refs/remotes/origin/' + branchName);
            cmd('git merge --no-edit origin/' + branchName);
            cmd('git push -u origin ' + branchName);
        } catch (syncPushError) {
            throw new Error(
                'Could not push rework branch after synchronizing with origin/' + branchName +
                '. Refusing to force-push over remote updates. Error: ' +
                (syncPushError.message || syncPushError)
            );
        }
    }

    const remoteCheck = cleanCommandOutput(cmd('git ls-remote --heads origin ' + branchName) || '');
    if (!remoteCheck.trim()) {
        throw new Error('Branch was not successfully pushed to remote');
    }

    console.log('✅ Pushed to remote branch:', branchName);
    return { branch: branchName, hasChanges: hasChanges };
}

/**
 * Extracts review-thread ids (GitHub GraphQL node ids, PRRT_...) cited anywhere
 * in a text — typically the rework response/fix summary. A rework that cites a
 * thread id is claiming that thread's findings as addressed, so those threads
 * MUST be resolved (gh-692); this is the citeable fallback when the AI-written
 * review_replies.json is missing or lacks threadIds.
 */
function extractCitedThreadIds(text) {
    var ids = [];
    var seen = {};
    String(text || '').replace(/PRRT_[A-Za-z0-9_]+/g, function(m) {
        if (!seen[m]) { seen[m] = true; ids.push(m); }
        return m;
    });
    return ids;
}

/**
 * Reads the setup-time thread snapshot input/<ticketKey>/pr_discussions_raw.json
 * (written by preCliReworkSetup via gitOps.writePRContext). Each thread carries
 * BOTH ids needed post-rework: rootCommentId (inline reply target) and threadId
 * (resolve target). Returns [] when missing or unparsable.
 */
function readInputRawThreads(ticketKey, outputOptions) {
    if (!ticketKey) return [];
    var candidates = ['input/' + ticketKey + '/pr_discussions_raw.json'];
    if (outputOptions && outputOptions.workingDir) {
        candidates.push(outputOptions.workingDir + '/input/' + ticketKey + '/pr_discussions_raw.json');
    }
    for (var i = 0; i < candidates.length; i++) {
        try {
            var raw = file_read({ path: candidates[i] });
            if (!raw || !String(raw).trim()) continue;
            var parsed = JSON.parse(raw);
            var threads = (parsed && parsed.threads) ? parsed.threads : (Array.isArray(parsed) ? parsed : []);
            if (threads && threads.length > 0) return threads;
        } catch (e) { /* try next candidate */ }
    }
    return [];
}

/**
 * Indexes a thread list by both id kinds (stringified keys — the AI output and
 * the snapshot may disagree on number vs string).
 */
function buildThreadLookup(threads) {
    var byRoot = {};
    var byThread = {};
    (threads || []).forEach(function(t) {
        if (!t) return;
        if (t.rootCommentId !== null && t.rootCommentId !== undefined) {
            byRoot[String(t.rootCommentId)] = t;
        }
        if (t.threadId) byThread[String(t.threadId)] = t;
    });
    return { byRoot: byRoot, byThread: byThread };
}

/**
 * gh-692 closure step: after posting replies, make ONE fresh API pass over the
 * PR's review threads and resolve every still-open thread this rework addressed —
 * matched by threadId/rootCommentId from review_replies.json, by the setup-time
 * snapshot, or by the thread ids cited in the rework response (MUST-resolve).
 *
 * Why this exists (live fa #1194, 2026-10-04): the rework leg fixed the findings
 * and pushed, but the review threads stayed open because the raw discussion
 * export lacked threadIds — postThreadReplies could not resolve what it could not
 * name. With the threads open, the threadsResolved:true re-review rule never
 * matches while the unresolved-threads rule (gh-683) keeps re-arming rework:
 * an infinite loop whose only exit is a human. A fresh sweep at resolution time
 * re-fetches the current thread ids, closing the loop even when every earlier
 * id source was incomplete.
 *
 * Fail-open by design: probe/resolution errors are logged, never thrown — a
 * broken sweep must not fail the rework leg.
 */
function resolveRemainingAddressedThreads(scm, pullRequestId, addressed) {
    var cited = (addressed && addressed.citedThreadIds) || [];
    var byThreadId = (addressed && addressed.addressedThreadIds) || {};
    var byRootId = (addressed && addressed.addressedRootIds) || {};
    var hasWork = cited.length > 0 ||
        Object.keys(byThreadId).length > 0 ||
        Object.keys(byRootId).length > 0;
    if (!hasWork) return;

    var resolvedViaSweep = {};
    var freshThreads = [];
    if (scm && typeof scm.fetchDiscussions === 'function') {
        try {
            var data = scm.fetchDiscussions(String(pullRequestId));
            freshThreads = (data && data.rawThreads && data.rawThreads.threads) || [];
        } catch (e) {
            console.warn('Fresh review-thread sweep failed (falling back to direct resolution of cited ids):', e.message || e);
        }
    }

    freshThreads.forEach(function(t) {
        if (!t || t.resolved === true) return;
        var isAddressed =
            (t.threadId && (byThreadId[String(t.threadId)] || cited.indexOf(String(t.threadId)) !== -1)) ||
            (t.rootCommentId !== null && t.rootCommentId !== undefined && byRootId[String(t.rootCommentId)]);
        if (!isAddressed) return;
        try {
            scm.resolveThread(pullRequestId, { threadId: t.threadId });
            console.log('✅ Resolved still-open addressed thread (fresh sweep):', t.threadId);
            if (t.threadId) resolvedViaSweep[String(t.threadId)] = true;
        } catch (e) {
            console.warn('Failed to resolve thread', t.threadId + ':', e.message || e);
        }
    });

    // Threads cited in the rework response MUST be resolved even when the sweep
    // could not confirm them open (probe failed, pagination, stale flags) —
    // resolve them directly; resolving an already-resolved thread is harmless.
    cited.forEach(function(threadId) {
        if (resolvedViaSweep[String(threadId)]) return;
        try {
            scm.resolveThread(pullRequestId, { threadId: threadId });
            console.log('✅ Resolved thread cited in rework response:', threadId);
        } catch (e) {
            console.warn('Failed to resolve cited thread', threadId + ':', e.message || e);
        }
    });
}

/**
 * Post replies to each review thread and resolve them.
 * Reads outputs/review_replies.json produced by the cursor agent.
 *
 * JSON format: { "replies": [{ "inReplyToId": 123, "threadId": "PRRT_...", "reply": "outputs/review_replies/thread1.md" }] }
 * The "reply" field may be a path to a Markdown file (preferred) or inline text (legacy).
 *
 * Defensive fallback: also accepts "rootCommentId" (instead of "inReplyToId") and
 * "body" (instead of "reply", as inline text) — the AI agent frequently mirrors
 * field names from input/<TICKET>/pr_discussions_raw.json (rootCommentId/body)
 * rather than renaming them to the documented output schema.
 *
 * Id enrichment (gh-692): a missing threadId/inReplyToId is filled in from the
 * setup-time snapshot input/<ticketKey>/pr_discussions_raw.json (matched by the
 * id that IS present), so a reply becomes threaded and its thread resolvable
 * even when the agent dropped one of the two ids.
 *
 * Closure sweep (gh-692): after the per-item pass, resolveRemainingAddressedThreads()
 * resolves every still-open thread the rework addressed — including threads whose
 * ids only appear in the rework response text (outputOptions.responseText). Without
 * this step the threadsResolved:true re-review rule can never match.
 *
 * Anti-spam: replies without any usable comment id (no inReplyToId/rootCommentId,
 * even after enrichment) cannot be posted as an inline threaded reply. Instead of
 * posting one generic top-level PR comment per such item (which spams the
 * conversation with repeated "✅ Addressed." messages), all of them are batched
 * into a single combined top-level comment — the specified fallback for
 * unciteable items.
 */
function postThreadReplies(scm, pullRequestId, outputOptions) {
    outputOptions = outputOptions || {};
    var lookup = buildThreadLookup(readInputRawThreads(outputOptions.ticketKey, outputOptions));

    let repliesJson = outputFiles.readOutputFile('review_replies.json', outputOptions);
    if (!repliesJson) {
        console.warn('outputs/review_replies.json not found — skipping thread replies');
    }

    let data = null;
    if (repliesJson) {
        try {
            data = JSON.parse(repliesJson);
        } catch (e) {
            console.warn('Failed to parse review_replies.json:', e.message || e);
        }
    }

    const replies = (data && data.replies) ? data.replies : [];
    if (replies.length === 0) {
        console.log('No thread replies to post');
    }

    function resolveReplyText(replyRef) {
        if (!replyRef) return '✅ Addressed.';
        const looksLikePath = replyRef.indexOf('outputs/') === 0 ||
            replyRef.indexOf('/') !== -1 ||
            replyRef.indexOf('.md') !== -1;
        if (looksLikePath) {
            const fileContent = outputFiles.readOutputFile(replyRef, outputOptions);
            if (fileContent && fileContent.trim()) {
                return fileContent.trim();
            }
        }
        return replyRef;
    }

    let posted = 0;
    const untargeted = [];
    const addressed = { threadIds: {}, rootIds: {} };
    replies.forEach(function(item) {
        // Accept both the documented field names (inReplyToId/reply) and the
        // input-schema field names (rootCommentId/body) — the AI agent commonly
        // mirrors field names from input/<TICKET>/pr_discussions_raw.json
        // (which uses rootCommentId/body) instead of renaming them for output.
        let inReplyToId = item.inReplyToId || item.rootCommentId || null;

        // gh-692: fill a missing id from the setup-time snapshot so the reply can
        // be posted inline and the thread can be resolved.
        if (!inReplyToId && item.threadId && lookup.byThread[String(item.threadId)] &&
            lookup.byThread[String(item.threadId)].rootCommentId !== null &&
            lookup.byThread[String(item.threadId)].rootCommentId !== undefined) {
            inReplyToId = lookup.byThread[String(item.threadId)].rootCommentId;
        }
        if (!item.threadId && inReplyToId && lookup.byRoot[String(inReplyToId)] &&
            lookup.byRoot[String(inReplyToId)].threadId) {
            item.threadId = lookup.byRoot[String(inReplyToId)].threadId;
        }

        const replyText = resolveReplyText(item.reply || item.body);
        const thread = { rootCommentId: inReplyToId, threadId: item.threadId || null };

        // Track every id this rework claims as addressed — the closure sweep
        // below retries resolution for anything the per-item pass could not
        // name or complete.
        if (item.threadId) addressed.threadIds[String(item.threadId)] = true;
        if (inReplyToId) addressed.rootIds[String(inReplyToId)] = true;

        if (inReplyToId) {
            // Normal case: post an inline threaded reply — this appears nested
            // inside the review conversation, not as a new top-level PR comment.
            try {
                scm.replyToThread(pullRequestId, thread, replyText);
                console.log('✅ Replied to comment #' + inReplyToId);
                posted++;
            } catch (e) {
                console.warn('Failed to post reply:', e.message || e);
            }
        } else {
            // No comment id available at all — a threaded reply is not possible.
            // Queue it instead of posting a separate top-level PR comment per
            // item, which would spam the conversation with repeated generic text.
            untargeted.push({ threadId: item.threadId || null, text: replyText });
        }

        if (item.threadId) {
            try {
                scm.resolveThread(pullRequestId, thread);
                console.log('✅ Resolved thread', item.threadId);
            } catch (e) {
                console.warn('Failed to resolve thread', item.threadId + ':', e.message || e);
            }
        }
    });

    if (untargeted.length > 0) {
        // Post exactly one combined top-level comment for all untargeted replies
        // instead of one generic comment per item.
        const lines = untargeted.map(function(u, i) {
            return (i + 1) + '. ' + u.text + (u.threadId ? ' (thread ' + u.threadId + ')' : '');
        });
        const combinedText = untargeted.length === 1
            ? untargeted[0].text
            : '✅ Addressed ' + untargeted.length + ' review comment(s) without a specific inline target:\n\n' + lines.join('\n');
        try {
            scm.addComment(pullRequestId, combinedText);
            console.log('✅ Posted 1 combined comment for ' + untargeted.length + ' untargeted repl' + (untargeted.length === 1 ? 'y' : 'ies'));
            posted++;
        } catch (e) {
            console.warn('Failed to post combined untargeted reply comment:', e.message || e);
        }
    }

    // Closure step (gh-692): sweep the PR's fresh open threads and resolve every
    // still-open thread this rework addressed — plus the ids cited in the rework
    // response, which MUST be resolved. Runs even when review_replies.json was
    // missing entirely.
    resolveRemainingAddressedThreads(scm, pullRequestId, {
        citedThreadIds: extractCitedThreadIds(outputOptions.responseText),
        addressedThreadIds: addressed.threadIds,
        addressedRootIds: addressed.rootIds
    });

    console.log('Posted ' + posted + '/' + replies.length + ' thread replies');
    return posted;
}

function postPRComment(scm, pullRequestId, fixSummary, ticketKey, repliesPosted) {
    try {
        var commentText;
        if (repliesPosted > 0) {
            // When review thread replies exist, keep the top-level comment minimal.
            // The detailed answers live in the thread replies.
            commentText = '## 🔧 Rework Complete — ' + ticketKey + '\n\n' +
                'All review feedback has been addressed in the thread replies above.';
        } else {
            commentText = '## 🔧 Rework Complete — ' + ticketKey + '\n\n' +
                'All PR review comments have been addressed. See fix summary below.\n\n' +
                '---\n\n' +
                fixSummary;
        }
        scm.addComment(pullRequestId, commentText);
        console.log('✅ Posted fix summary to PR #' + pullRequestId);
        return true;
    } catch (error) {
        console.error('Failed to post PR comment:', error);
        return false;
    }
}

function postJiraComment(tracker, ticketKey, prUrl, branchName, prCommentPosted, codeChangesCommitted, fixSummary) {
    try {
        const m = commentMarkup.forTicket(ticketKey);
        let comment;
        if (codeChangesCommitted) {
            comment = m.h(3, '✅ Rework Completed') + '\n\n';
            comment += m.bold('Branch') + ': ' + m.code(branchName) + '\n';
            if (prUrl) {
                comment += m.bold('Pull Request') + ': ' + prUrl + '\n';
            }
            comment += '\nAI Teammate has addressed all PR review comments and pushed the fixes.\n';
        } else {
            comment = m.h(3, '✅ Rework Analysis Completed') + '\n\n';
            if (prUrl) {
                comment += m.bold('Pull Request') + ': ' + prUrl + '\n';
            }
            comment += '\nAI Teammate analyzed all PR review comments and determined no code changes are required.\n';
        }
        if (prCommentPosted) {
            comment += 'A fix summary has been posted as a comment on the Pull Request.';
        }

        tracker.postComment(ticketKey, comment);
        console.log('✅ Posted completion comment to ticket:', ticketKey);
    } catch (error) {
        console.error('Failed to post tracker comment:', error);
    }
}

function isInterruptedReworkResponse(response) {
    var text = String(response || '');
    return text.indexOf('CLI command executed but did not produce output file') !== -1 ||
        text.indexOf('Command failed (exit code 124)') !== -1 ||
        text.indexOf('Copilot command timed out') !== -1 ||
        text.indexOf('outputs/response.md missing') !== -1 ||
        text.indexOf('"path":"interrupted"') !== -1 ||
        text.indexOf('"path": "interrupted"') !== -1;
}

/**
 * Fatal (non-interruption) CLI failure in the rework response.
 *
 * Live pathology 2026-09-29 (IstiN/flutter_agent_harness #1052 machine loop):
 * a rework CLI command that exited non-zero (exit code 1) was announced as
 * "✅ Rework Complete" because only interruption-class failures (timeout exit
 * 124, missing output file) were detected. The loop then re-validated a head
 * that could never go green — forever.
 *
 * The `Error: Command failed (exit code N)` marker is written by the
 * CliExecutionHelper into the RAW command log; it only reaches the response
 * when the CLI died WITHOUT writing outputs/response.md (a completed agent's
 * response comes from the output file, which never embeds this helper
 * marker). So seeing it here means the rework CLI run failed outright.
 * Exit 124 stays in the interruption class — [isInterruptedReworkResponse]
 * owns it and its resume-once semantics.
 */
function isFailedCliReworkResponse(response) {
    var m = /Error: Command failed \(exit code (\d+)\)/.exec(String(response || ''));
    if (!m) return false;
    var code = parseInt(m[1], 10);
    return code !== 0 && code !== 124;
}

/**
 * Terminal handler for a fatally failed rework CLI run: surface the failure
 * honestly instead of announcing completion. Mirrors [handleInterruptedRework]
 * semantics (leave PR conversations open, reset the ticket for retry) but
 * posts a failure comment and reports success:false so callers/metrics see it.
 */
function handleFailedReworkCli(tracker, ticketKey, branchName, customParams, statuses, error) {
    console.warn('Rework CLI failed with a non-zero exit — surfacing the failure instead of announcing completion.');
    try {
        const mi = commentMarkup.forTicket(ticketKey);
        tracker.postComment(
            ticketKey,
            mi.h(3, '❌ Rework CLI Failed') + '\nThe rework CLI command exited with a non-zero code. No completion is claimed; PR conversations were left open. The ticket was moved back to ' + mi.bold(statuses.IN_REWORK) + ' for retry.\n'
                + mi.code(String(error).substring(0, 2000))
        );
    } catch (e) {
        console.warn('Failed to post failed-rework comment:', e.message || e);
    }
    try {
        tracker.moveToStatus(ticketKey, statuses.IN_REWORK);
        console.log('✅ Moved', ticketKey, 'back to', statuses.IN_REWORK, 'for retry');
    } catch (e) {
        console.warn('Failed to move ticket back to ' + statuses.IN_REWORK + ':', e.message || e);
    }
    removeConfiguredLabels(tracker, ticketKey, customParams || {});
    return {
        success: false,
        path: 'rework-cli-failed',
        ticketKey: ticketKey,
        branchName: branchName
    };
}

/**
 * Reads input/<ticketKey>/rework_setup_failed.md, written by preCliReworkSetup's
 * failSetup() when it could not find/checkout a PR for the ticket (e.g. "no PR
 * found for ticket"). Returns the file content, or null if the file does not
 * exist (the normal, working-PR path).
 */
function readReworkSetupFailure(ticketKey) {
    try {
        var content = file_read({ path: 'input/' + ticketKey + '/rework_setup_failed.md' });
        return (content && content.trim()) ? content : null;
    } catch (e) {
        return null;
    }
}

/**
 * Rework setup already failed (most commonly: no PR found for the ticket) before
 * the CLI agent even ran. There is no branch/PR to push changes to, and retrying
 * the CLI cannot conjure one up — in the observed incident, retrying instead led
 * the CLI agent to fabricate a fake pr_info.md just to satisfy the "refuse to
 * commit on base branch" guard. Skip commitAndPush() and the resumeAgent retry
 * entirely, and just make sure Jira reflects what happened.
 */
function handleReworkSetupAlreadyFailed(tracker, ticketKey, customParams, failureContent) {
    console.warn('⚠️ Rework setup already failed (no PR found) for', ticketKey, '— skipping commit/push and CLI retry.');
    try {
        var m = commentMarkup.forTicket(ticketKey);
        var comment = m.h(3, '❌ Rework Push Skipped — Setup Already Failed') + '\n\n' +
            'Rework setup did not find (or could not check out) a Pull Request for this ticket, ' +
            'so there is no branch to push changes to. Retrying the CLI agent cannot fix a missing PR, ' +
            'so the push step was skipped rather than retried.\n\n';
        if (failureContent) {
            comment += m.code(failureContent.trim());
        } else {
            comment += 'See ' + m.code('input/' + ticketKey + '/rework_setup_failed.md') + ' for details.';
        }
        tracker.postComment(ticketKey, comment);
        console.log('✅ Posted rework-setup-already-failed comment to ticket:', ticketKey);
    } catch (e) {
        console.warn('Failed to post rework-setup-already-failed comment:', e.message || e);
    }
    removeConfiguredLabels(tracker, ticketKey, customParams || {});
    return {
        success: true,
        path: 'rework-setup-already-failed',
        ticketKey: ticketKey,
        error: 'Rework setup already failed (no PR found for ticket); push step skipped.'
    };
}

function handleInterruptedRework(tracker, ticketKey, branchName, customParams, statuses) {
    console.warn('Rework CLI was interrupted before writing required outputs; leaving PR conversations open and resetting ticket for retry.');
    try {
        const mi = commentMarkup.forTicket(ticketKey);
        tracker.postComment(
            ticketKey,
            mi.h(3, '⏸️ Rework Interrupted') + '\n\nThe AI agent pushed any staged partial changes, but it was interrupted before writing ' + mi.code('outputs/response.md') + ' and ' + mi.code('outputs/review_replies.json') + '. PR conversations were left open. The ticket was moved back to ' + mi.bold(statuses.IN_REWORK) + ' for retry.\n\n' + mi.bold('Branch') + ': ' + mi.code(branchName)
        );
    } catch (e) {
        console.warn('Failed to post interrupted rework comment:', e.message || e);
    }
    try {
        tracker.moveToStatus(ticketKey, statuses.IN_REWORK);
        console.log('✅ Moved', ticketKey, 'back to', statuses.IN_REWORK, 'for retry');
    } catch (e) {
        console.warn('Failed to move ticket back to ' + statuses.IN_REWORK + ':', e.message || e);
    }
    removeConfiguredLabels(tracker, ticketKey, customParams || {});
    return {
        success: true,
        path: 'rework-interrupted',
        ticketKey: ticketKey,
        branchName: branchName
    };
}

/**
 * GitHub machine loop, token-burn guard (live pathology 2026-09-21,
 * epam/dmtools-dart #194): a rework run that pushed NO new commits used to
 * clear ai_pr_reviewed and auto-start a fresh LLM review of the SAME head —
 * a full reviewer pass that just restated the standing findings ("round 2,
 * unchanged commit"). The last concluded PR review's commit_id is the
 * durable "what the verdict covered" marker: when it equals the PR head,
 * the rework was a no-op and the verdict still stands.
 *
 * Returns true when a fresh review IS wanted (head moved, no concluded
 * reviews, or the probe failed — fail-open so the review loop can never
 * stall on a broken probe).
 */
function headMovedSinceLastReview(scm, pr) {
    try {
        if (!pr || !pr.number) { return true; }
        var reviews = scm.listReviews(pr.number);
        var concluded = (reviews || []).filter(function (r) {
            return r && (r.state === 'CHANGES_REQUESTED' || r.state === 'APPROVED');
        });
        if (!concluded.length) { return true; }
        concluded.sort(function (a, b) {
            return String(a.submitted_at || '') < String(b.submitted_at || '') ? -1 : 1;
        });
        var last = concluded[concluded.length - 1];
        var headSha = pr.head && (pr.head.sha || pr.head);
        if (last.commit_id && headSha && String(last.commit_id) === String(headSha)) {
            return false;
        }
    } catch (e) {
        console.warn('headMovedSinceLastReview probe failed (fail-open):', e.message || e);
    }
    return true;
}

function action(params) {
    try {
        const actualParams = params.ticket ? params : (params.jobParams || params);
        const ticketKey = actualParams.ticket.key;
        const fixSummary = actualParams.response || '_(No fix summary generated)_';
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var scm = scmModule.createScm(config);
        const _customParams = resolveCustomParams(params, actualParams, config);
        const statuses = resolveStatuses(_customParams, config.jira && config.jira.statuses);
        // Probe the tracker provider once — the same script then runs unchanged
        // on Jira / ADO / GitHub deployments.
        var tracker = trackersModule.createTracker(config, _customParams);

        console.log('=== Push rework changes for:', ticketKey, '===');

        // Configure git
        configureGitAuthor(config);

        var gateResult = feedbackLoop.runQualityGates({
            ticketKey: ticketKey,
            customParams: _customParams,
            section: 'qualityGates'
        });
        if (!gateResult.success) {
            throw new Error('Quality gate failed before rework push: ' + gateResult.failedGate + '\n' + gateResult.error);
        }
        var policyResult = feedbackLoop.runPolicyGates({
            ticketKey: ticketKey,
            customParams: _customParams,
            section: 'policyGates'
        });
        if (!policyResult.success) {
            throw new Error('Policy gate failed before rework push: ' + policyResult.failedGate + '\n' + policyResult.error);
        }

        // Non-blocking gate failures (e.g. spotbugs findings unrelated to the PR, marked
        // "blocking": false in config) don't abort the push/PR-reply flow, but should still
        // be visible to the developer/reviewer rather than silently swallowed.
        var nonBlockingGateWarnings = [].concat(
            gateResult.nonBlockingFailures || [],
            policyResult.nonBlockingFailures || []
        );
        var nonBlockingGateWarningBlock = '';
        if (nonBlockingGateWarnings.length > 0) {
            var warningLines = nonBlockingGateWarnings.map(function(f) {
                return '- **' + f.name + '**: ' + String(f.error).substring(0, 500);
            });
            nonBlockingGateWarningBlock = '\n\n⚠️ **Non-blocking gate warnings** (did not block this push):\n' + warningLines.join('\n');
            console.warn('⚠️ Non-blocking gate failures (push/replies continue):\n' + warningLines.join('\n'));
        }
        const fixSummaryWithWarnings = fixSummary + nonBlockingGateWarningBlock;

        // If rework setup already failed (e.g. no PR found for this ticket), there is
        // nothing to commit/push to and no amount of CLI retrying can fix a missing PR.
        // Bail out here, before touching git at all.
        var reworkSetupFailure = readReworkSetupFailure(ticketKey);
        if (reworkSetupFailure !== null) {
            return handleReworkSetupAlreadyFailed(tracker, ticketKey, _customParams, reworkSetupFailure);
        }

        // Commit and push
        let branchName;
        let codeChangesCommitted = false;
        try {
            const pushResult = commitAndPush(ticketKey, config, _customParams);
            branchName = pushResult.branch;
            codeChangesCommitted = pushResult.hasChanges;
        } catch (gitError) {
            console.error('Git operations failed:', gitError);
            var resume = tryResumeAgent({
                ticketKey: ticketKey,
                customParams: _customParams,
                section: 'postAction',
                stage: 'rework_git_operations',
                error: gitError.toString()
            });
            if (resume.attempted) {
                return action(params);
            }
            try {
                var pm = commentMarkup.forTicket(ticketKey);
                tracker.postComment(
                    ticketKey,
                    pm.h(3, '❌ Rework Push Failed') + '\n\n' + pm.code(gitError.toString()) + '\n\nPlease check the logs and retry.'
                );
            } catch (e) {}
            return { success: false, error: gitError.toString() };
        }

        var postPublishGateResult = feedbackLoop.runPostPublishGates({
            ticketKey: ticketKey,
            customParams: _customParams,
            section: 'postPublishGates',
            workingDir: config.workingDir || null
        });
        if (!postPublishGateResult.success) {
            var gateError = 'Post-publish quality gate failed: ' +
                postPublishGateResult.failedGate + '\n' + postPublishGateResult.error;
            if (postPublishGateResult.resumeAttempted) {
                return action(params);
            }
            try {
                var qm = commentMarkup.forTicket(ticketKey);
                tracker.postComment(
                    ticketKey,
                    qm.h(3, '❌ Rework Quality Gate Failed') + '\n\n' + qm.code(gateError) + '\n\nThe branch was pushed before running this gate. Please check the logs and retry.'
                );
            } catch (e) {}
            return { success: false, error: gateError };
        }

        if (isInterruptedReworkResponse(fixSummary)) {
            var interruptedResume = tryResumeAgent({
                ticketKey: ticketKey,
                customParams: _customParams,
                section: 'postAction',
                stage: 'rework_missing_outputs',
                error: fixSummary
            });
            if (interruptedResume.attempted) {
                return action(params);
            }
            return handleInterruptedRework(tracker, ticketKey, branchName, _customParams, statuses);
        }

        // Fatal CLI failure (non-zero exit ≠ interruption): one resume attempt,
        // then the honest failure path — never a "Rework Complete" announcement
        // (live 2026-09-29: exit 1 was announced as completion, the #1052 loop).
        if (isFailedCliReworkResponse(fixSummary)) {
            var failedResume = tryResumeAgent({
                ticketKey: ticketKey,
                customParams: _customParams,
                section: 'postAction',
                stage: 'rework_cli_failed',
                error: String(fixSummary).substring(0, 2000)
            });
            if (failedResume.attempted) {
                return action(params);
            }
            return handleFailedReworkCli(tracker, ticketKey, branchName, _customParams, statuses, fixSummary);
        }

        // Find PR to post comment — prefer targetRepository from config over git remote
        var repoInfo = null;
        if (config.repository && config.repository.owner && config.repository.repo) {
            repoInfo = { owner: config.repository.owner, repo: config.repository.repo };
            console.log('Using targetRepository from config:', repoInfo.owner + '/' + repoInfo.repo);
        } else {
            repoInfo = scm.getRemoteRepoInfo();
        }
        if (!repoInfo) {
            throw new Error(PR_LOOKUP_FAILED_PREFIX +
                ' could not determine the GitHub repository (no config.repository, git remote unparsable) for ticket ' +
                ticketKey + ' — the rework PR replies/comments cannot be posted and the rework cycle is NOT closed.');
        }
        const pr = findPRForTicket(scm, ticketKey);
        if (!pr) {
            // Loud failure instead of silent skip (live fa #1212, run 37200002499,
            // 2026-10-04): the old silent skip left review threads unresolved, still
            // moved the ticket to In Review, removed the rework labels and declared
            // the cycle closed — SM re-armed rework on the same unresolved threads →
            // infinite empty-lap loop. Replies/resolutions were skipped for
            // infrastructure reasons: the cycle-close steps below must NOT run.
            console.error(PR_LOOKUP_FAILED_PREFIX + ' no Pull Request found for ticket ' + ticketKey +
                " after the rework push (branch '" + branchName + "') — PR replies/resolutions skipped;" +
                ' failing the leg instead of closing the cycle.');
            throw new Error(PR_LOOKUP_FAILED_PREFIX + ' no Pull Request found for ticket ' + ticketKey +
                " after the rework push (branch '" + branchName + "'). Review-thread replies/resolutions and the" +
                ' fix-summary comment were NOT posted; the rework cycle was NOT closed — failing loudly instead of' +
                ' silently skipping (silent skip re-arms empty rework laps forever, live fa #1212 2026-10-04).');
        }
        let prCommentPosted = false;

        // Reply to each review thread and resolve it. responseText feeds the
        // gh-692 closure sweep: threads cited in the rework response MUST be
        // resolved even when review_replies.json lacks their ids.
        const repliesPosted = postThreadReplies(scm, pr.number, {
            ticketKey: ticketKey,
            workingDir: config.workingDir || null,
            responseText: fixSummary
        });
        console.log('Thread replies posted:', repliesPosted);

        // Post general fix summary as a top-level PR comment only when there are no
        // review thread replies. When replies exist, the thread replies themselves are
        // sufficient; an extra top-level comment is noise — except non-blocking gate
        // warnings, which are worth a short standalone comment even then, since they
        // wouldn't otherwise be visible anywhere on the PR.
        var hasMeaningfulSummary = fixSummary && fixSummary.length > 50
            && fixSummary !== '_(No fix summary generated)_';
        if (repliesPosted > 0) {
            console.log('ℹ️ Review thread replies posted — skipping general PR comment');
            if (nonBlockingGateWarningBlock) {
                try {
                    scm.addComment(pr.number, '## ⚠️ Non-blocking gate warnings' + nonBlockingGateWarningBlock);
                } catch (e) {
                    console.warn('Failed to post non-blocking gate warning comment:', e);
                }
            }
        } else if (codeChangesCommitted || hasMeaningfulSummary) {
            prCommentPosted = postPRComment(scm, pr.number, fixSummaryWithWarnings, ticketKey, repliesPosted);
        } else {
            console.log('ℹ️ No thread replies, no code changes, and no meaningful summary — skipping general PR comment');
        }

        // Move ticket to In Review
        try {
            tracker.moveToStatus(ticketKey, statuses.IN_REVIEW);
            console.log('✅ Moved', ticketKey, 'to', statuses.IN_REVIEW);
        } catch (statusError) {
            console.warn('Failed to move ticket to In Review:', statusError);
        }

        // Assign back to initiator (if provided)
        try {
            const initiatorId = actualParams.initiator;
            if (initiatorId) {
                tracker.assignTo(ticketKey, initiatorId);
                console.log('✅ Assigned ticket back to initiator');
            }
        } catch (e) {
            console.warn('Failed to assign ticket:', e);
        }

        // Post completion comment to the ticket
        const prUrl = pr ? pr.html_url : null;
        postJiraComment(tracker, ticketKey, prUrl, branchName, prCommentPosted, codeChangesCommitted, fixSummaryWithWarnings);

        // Remove WIP label if present
        const wipLabel = actualParams.metadata && actualParams.metadata.contextId
            ? actualParams.metadata.contextId + '_wip'
            : null;
        if (wipLabel) {
            try {
                tracker.removeLabel(ticketKey, wipLabel);
                console.log('Removed WIP label:', wipLabel);
            } catch (e) {
                console.warn('Failed to remove WIP label:', e);
            }
        }

        // Remove SM idempotency label so the ticket can be re-triggered next cycle
        removeConfiguredLabels(tracker, ticketKey, _customParams);

        // GitHub machine loop: the once-guard lives on the PR (ai_pr_reviewed),
        // not the issue. Clear it so the reworked head gets a FRESH review —
        // otherwise review-after-dev (notPrLabels: ai_pr_reviewed) skips the
        // PR forever and the loop stalls after one review round.
        //
        // Token-burn guard: a no-op rework (no new commits since the last
        // review's head) keeps the latch and goes straight back to rework —
        // no LLM re-review of the unchanged head.
        var stickyApproved = prHasApproved(pr, actualParams.ticket || (params.jobParams && params.jobParams.ticket));
        var freshReviewWanted = !stickyApproved && headMovedSinceLastReview(scm, pr);
        if (stickyApproved && pr && pr.number) {
            // Owner rule (sticky approval): never re-review an approved PR.
            // The rework pushed its fixes; validation re-runs on the new
            // head and merge-validated closes the loop. Keep BOTH latches
            // (pr_approved + ai_pr_reviewed) and arm nothing.
            try {
                scm.addComment(pr.number,
                    '✅ Rework finished. `pr_approved` is sticky (approved once — never re-reviewed): ' +
                    'the new head re-validates and merges directly.');
            } catch (e) {
                console.warn('Failed to post sticky-approval comment on PR #' + pr.number + ':', e.message || e);
            }
            console.log('ℹ️ Sticky approval on PR #' + pr.number + ' — re-review NOT armed; re-validation + merge follow');
        }
        if (!stickyApproved && !freshReviewWanted && pr && pr.number) {
            try {
                tracker.addLabel(ticketKey, 'agent:rework');
                console.log('✅ No-op rework: verdict head unchanged — agent:rework re-armed on ' + ticketKey);
            } catch (e) {
                console.warn('Failed to re-arm agent:rework on ' + ticketKey + ':', e.message || e);
            }
            try {
                scm.addComment(pr.number,
                    '⚠️ Rework finished with **no new commits** — the previous review verdict (same head) ' +
                    'still stands and its findings are unchanged. Re-review skipped (token guard); rework re-armed.');
            } catch (e) {
                console.warn('Failed to post no-op rework comment on PR #' + pr.number + ':', e.message || e);
            }
        }
        if (freshReviewWanted && pr && pr.number && typeof github_remove_label === 'function') {
            try {
                github_remove_label({
                    workspace: repoInfo.owner, repository: repoInfo.repo,
                    number: pr.number, label: 'ai_pr_reviewed'
                });
                console.log('✅ Cleared ai_pr_reviewed on PR #' + pr.number + ' — fresh review armed');
            } catch (e) {
                console.warn('Failed to clear ai_pr_reviewed on PR #' + pr.number + ':', e.message || e);
            }
        }

        // Auto-start pr_review after rework is pushed to In Review (opt-in via customParams)
        var reviewStarted = false;
        const autoStartReview = _customParams && _customParams.autoStartReview;
        const reviewConfigFile = _customParams && _customParams.autoStartReviewConfigFile;
        if (autoStartReview && reviewConfigFile) {
            // Skip if ticket already has pr_approved label (already approved, merge pending)
            const ticket = actualParams.ticket || (params.jobParams && params.jobParams.ticket);
            if (!freshReviewWanted) {
                console.log('ℹ️ autoStartReview: skipped — rework pushed no new commits (token guard)');
            } else if (stickyApproved) {
                console.log('ℹ️ autoStartReview: skipped — pr_approved is sticky on the PR (owner rule 2026-09-21)');
            } else if (hasPrApprovedLabel(ticket)) {
                console.log('ℹ️ autoStartReview: skipped — ticket has pr_approved label');
            } else {
                try {
                    reviewStarted = autoStart.triggerConfiguredWorkflowForTicket({
                        ticketKey: ticketKey,
                        customParams: _customParams,
                        config: config,
                        configFile: reviewConfigFile,
                        label: 'pr_review',
                        scm: scm,
                        stripKeys: [
                            'removeLabel',
                            'autoStartReview',
                            'autoStartReviewConfigFile'
                        ]
                    });
                } catch (e) {
                    console.warn('⚠️ autoStartReview trigger failed:', e.message || e);
                }
            }
        }
        if (!reviewStarted) {
            autoStart.triggerSmIfIdle({ config: config, customParams: _customParams, scm: scm });
        }

        // Cache configured artefacts (e.g. cosmo test reports) to GitHub Release — non-fatal
        try { cacheToReleases.action(params); } catch (e) { console.warn('⚠️ cacheToReleases failed (non-fatal):', e); }

        console.log('✅ Rework workflow completed successfully');

        // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
        // wrote outputs/*_usage.json during the agent run.
        try {
            tokenUsageComment.postTokenUsageComments(ticketKey, { initiator: params.initiator });
        } catch (e) {
            console.warn('Failed to post token usage comments:', e);
        }

        return {
            success: true,
            message: ticketKey + ' rework pushed, PR commented, moved to ' + statuses.IN_REVIEW,
            branchName: branchName,
            prUrl: prUrl,
            prCommentPosted: prCommentPosted
        };

    } catch (error) {
        console.error('❌ Error in pushReworkChanges:', error);
        try {
            const actualParams = params.ticket ? params : (params.jobParams || params);
            if (actualParams && actualParams.ticket && actualParams.ticket.key) {
                const customParams = (params.jobParams && params.jobParams.customParams) || actualParams.customParams;
                var resume = tryResumeAgent({
                    ticketKey: actualParams.ticket.key,
                    customParams: customParams,
                    section: 'postAction',
                    stage: 'rework_post_action',
                    error: error.toString()
                });
                if (resume.attempted) {
                    return action(params);
                }
                // Post the error to the ticket via the probed tracker provider
                var errorTracker = (typeof tracker !== 'undefined' && tracker) ? tracker : null;
                if (!errorTracker) {
                    try {
                        errorTracker = trackersModule.createTracker(
                            configLoader.loadProjectConfig(params.jobParams || params), customParams);
                    } catch (trackerError) {
                        console.error('Failed to create tracker for error comment:', trackerError);
                    }
                }
                if (errorTracker) {
                    var em = commentMarkup.forTicket(actualParams.ticket.key);
                    errorTracker.postComment(
                        actualParams.ticket.key,
                        em.h(3, '❌ Rework Workflow Error') + '\n\n' + em.code(error.toString())
                    );
                }
            }
        } catch (e) {}
        return { success: false, error: error.toString() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action, resolveCustomParams, isInterruptedReworkResponse, isFailedCliReworkResponse, handleFailedReworkCli, postThreadReplies, commitAndPush, readReworkSetupFailure, headMovedSinceLastReview, extractCitedThreadIds, readInputRawThreads, buildThreadLookup, resolveRemainingAddressedThreads };
}
