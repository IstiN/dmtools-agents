/**
 * Post PR Review Comments Action
 * PostJSAction that:
 * 1. Reads outputs/pr_review.json with structured review data
 * 2. Posts general review comment to GitHub PR using github_add_pr_comment
 * 3. Posts inline code comments to GitHub PR using github_add_inline_comment
 * 4. Posts a formatted review summary to the ticket (Jira/ADO/GitHub via common/trackers.js)
 * 5. Updates ticket status based on review outcome
 * 6. Adds labels to indicate review completion
 *
 * gh-926: action() is a thin executor over a pipeline of named steps.
 * Pure decisions live in parse/normalize/decide/build/resolve helpers
 * (unit-tested directly); side-effecting steps live in single-purpose
 * functions invoked by action() in the same order as before the flattening.
 */

const {
    LABELS,
    STATUSES,
    resolveStatuses,
    countReworkRounds,
    maxAutoReworkRoundsOf,
    checkAutoReworkBudget,
    stampReworkRound
} = require('./config.js');
var scmModule = require('./common/scm.js');
var trackersModule = require('./common/trackers.js');
var autoStart = require('./common/autoStart.js');
var configLoader = require('./configLoader.js');
var machineAuthorModule = require('./common/machineAuthor.js');
var outputFiles = require('./common/outputFiles.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');
var gh = require('./common/githubHelpers.js');
const commentMarkup = require('./common/commentMarkup.js');
var reviewVerdicts = require('./common/reviewVerdicts.js');
// gh-1351 (hoisted, never lazy — the gh-823 pack-require rule): the
// reviewPolicy config + verdict layer — the machine approval recomputation
// (model advisory, machine enforces), the legacy-knob audit and the density
// control.
var reviewPolicyModule = require('./common/reviewPolicy.js');
// gh-1332 (hoisted, never lazy — the gh-823 pack-require rule): the
// finding-identity registry — the review-round dedup. The round's structured
// inlineComments already carry path/severity/claim, so registering the round
// mechanically costs no extra agent work.
var findingRegistry = require('./common/findingRegistry.js');
var reviewSpecClaims = require('./common/reviewSpecClaims.js');
// gh-1403 (hoisted, never lazy — the gh-823 pack-require rule): the
// finding-filter leg — reviewPolicy.verification = filter re-verifies each
// rework/polish-tier candidate in a fresh context before it posts.
var reviewFilterModule = require('./common/reviewFilter.js');
var reviewHelpers = require('./postStoryTestAutomationReviewHelpers.js');
// gh-1369 (hoisted, never lazy — the gh-823 pack-require rule): the
// terminal-PR guard — a MERGED/CLOSED PR never re-enters the rework loop
// (the review-leg verdict stamp and the auto-started rework arm).
var prTerminalStateModule = require('./common/prTerminalState.js');
// The runtime's input folder name for a ticket (input/gh-N for a GitHub key): the Java runtime
// passes params.inputFolderPath to pre-CLI actions only, so a post-action derives it.
var ticketKeyShapes = require('./common/ticketKeyShapes.js');

var RESUME_MARKER = 'outputs/.pr-review-missing-output-resume-attempted';

// ── Tiny value guards (CC ≤ 2 so helpers stay under the CRAP gate) ───────────

function orNull(value) {
    return value || null;
}

function orZero(value) {
    return value || 0;
}

function orEmpty(value) {
    return value || '';
}

function hasLabel(labels, label) {
    return (labels || []).indexOf(label) !== -1;
}

/**
 * Derive project key from customParams.configPath or customParams.projectKey.
 * e.g. ".dmtools/configs/myproject.js" → "myproject"
 */
function deriveProjectKey(customParams) {
    if (!customParams) return '';
    if (customParams.projectKey) return customParams.projectKey;
    return projectKeyFromConfigPath(customParams.configPath);
}

function projectKeyFromConfigPath(configPath) {
    var base = basenameNoJs(configPath);
    if (!base) return '';
    if (base === 'config') return '';
    return base;
}

function basenameNoJs(configPath) {
    if (!configPath) return '';
    return configPath.substring(configPath.lastIndexOf('/') + 1).replace(/\.js$/, '');
}

function ticketLabels(ticket) {
    if (!ticket) return [];
    return ticketFieldLabels(ticket.fields);
}

function ticketFieldLabels(fields) {
    if (!fields) return [];
    return fields.labels || [];
}

/**
 * Returns true if the Jira ticket has the pr_approved label.
 */
function hasPrApprovedLabel(ticket) {
    return hasLabel(ticketLabels(ticket), LABELS.PR_APPROVED);
}

/**
 * Count open review threads / general comments on a PR.
 * Kept post-gh-1351 as a read-only thread census utility (the force-approve
 * valve it once fed was replaced by machine enforcement); no production
 * caller remains.
 */
function countReviewThreads(scm, pullRequestId) {
    var count = 0;
    try {
        var discussions = scm.fetchDiscussions(pullRequestId);
        if (discussions && discussions.rawThreads && discussions.rawThreads.threads) {
            count += discussions.rawThreads.threads.length;
        }
    } catch (e) {
        console.warn('Could not count review threads:', e.message || e);
    }
    return count;
}

function markForSmStoryRework(tracker, ticketKey) {
    try {
        tracker.addLabel(ticketKey, 'sm_story_rework_triggered');
        console.log('✅ Added SM rework label: sm_story_rework_triggered');
    } catch (e) {
        console.warn('⚠️ Failed to add SM rework label:', e.message || e);
        return false;
    }
    // GitHub machine loop (live pathology: fa gh-746 — 24 review rounds,
    // zero reworks): no SM rule reads sm_story_rework_triggered — the
    // rework-on-red-ci rule matches agent:rework (prMachineAuthor-gated).
    // Arm the live label so the SM can actually dispatch the rework leg;
    // it also blocks review-after-dev (notLabels agent:rework), stopping
    // the every-tick re-review loop on the same unchanged head.
    try {
        tracker.addLabel(ticketKey, 'agent:rework');
        console.log('✅ Armed agent:rework on', ticketKey, '— SM will dispatch the rework leg');
        return true;
    } catch (e2) {
        console.warn('⚠️ Failed to arm agent:rework:', e2.message || e2);
        return false;
    }
}

function resolveCustomParams(params, config) {
    // Canonical merge in postStoryTestAutomationReviewHelpers.js (gh-1246).
    return reviewHelpers.resolveCustomParams(configLoader, params, config, 'pr_review');
}

/**
 * Read and parse outputs/pr_review.json
 * @returns {Object|null} Parsed review data or null on error
 */
function readReviewJson(ticketKey, workingDir) {
    try {
        return parseReviewJson(outputFiles.readOutputFileDetailed('pr_review.json', {
            ticketKey: ticketKey,
            workingDir: workingDir
        }));
    } catch (error) {
        console.error('Failed to read/parse outputs/pr_review.json:', error);
        return null;
    }
}

function parseReviewJson(review) {
    var raw = review ? review.content : null;
    if (!raw || isBlankText(raw)) return emptyReviewJson();
    var parsed = JSON.parse(raw);
    attachReviewSourcePath(parsed, review);
    console.log('Parsed pr_review.json:', JSON.stringify(parsed, null, 2));
    return parsed;
}

function isBlankText(raw) {
    return raw.trim() === '';
}

function emptyReviewJson() {
    console.warn('outputs/pr_review.json is empty');
    return null;
}

function attachReviewSourcePath(parsed, review) {
    if (!parsed.__sourcePath && review.path) parsed.__sourcePath = review.path;
}

/**
 * Read markdown file content
 * @param {string} filePath - Path to markdown file
 * @returns {string} File content or empty string on error
 */
function readMarkdownFile(filePath, ticketKey, workingDir) {
    if (!filePath) {
        return '';
    }
    try {
        const content = outputFiles.readOutputFile(filePath, {
            ticketKey: ticketKey,
            workingDir: workingDir
        });
        if (content && content.trim() !== '') {
            return content;
        }
    } catch (error) {
        console.warn('Could not read file ' + filePath + ':', error);
    }
    return '';
}

/**
 * Defense-in-depth guard: the agent is instructed (instructions/pr_review/output_rules.md,
 * few_shots.md) to reference comment text via the `comment` field (a path to a
 * .md file under outputs/), never inline in `body`. If a
 * prompt/schema inconsistency ever causes the model to duplicate that path
 * into `body` instead of the actual comment text (observed in production),
 * posting it verbatim would silently publish a broken review comment
 * containing just a file path. Detect that shape and resolve it to the real
 * file content instead of trusting `body` blindly.
 *
 * The same shape holds for `generalComment`: the contract carries the PATH
 * to outputs/pr_review_general.md (postGeneralComment reads the file), and
 * the formal-review path must resolve it too — live bug: an APPROVE review
 * landed with the literal string "outputs/pr_review_general.md" as its body
 * (flutter_agent_harness #720).
 */
function resolveCommentFileReference(value, ticketKey, workingDir) {
    if (typeof value !== 'string') return null;
    var trimmed = value.trim();
    if (!/^(outputs\/)?(pr_review_comments\/)?[\w.\-]+\.md$/.test(trimmed)) {
        return null;
    }
    var content = readMarkdownFile(trimmed, ticketKey, workingDir);
    return content || null;
}

function writeFile(path, content) {
    try {
        file_write({ path: path, content: content });
    } catch (e) {
        file_write(path, content);
    }
}

/**
 * The resume prompt written to outputs/.pr-review-resume-prompt.md and fed
 * to the one-shot recovery run when mandatory review outputs are missing.
 */
function buildResumePrompt(ticketKey) {
    return 'RESUME TASK: The previous PR review run ended without writing mandatory review output files.\n\n' +
        'Do not rework product code. Read input/' + ticketKey + '/pr_info.md, pr_diff.txt, pr_discussions.md, ' +
        'pr_discussions_raw.json when present, ci_failures.md and ci_failures_full.log when present, and the current PR context.\n\n' +
        'Write these files before stopping:\n' +
        '1. outputs/pr_review.json with fields recommendation, generalComment, resolvedThreadIds, inlineComments, issueCounts.\n' +
        '2. outputs/pr_review_general.md with a short GitHub Markdown review summary.\n' +
        '3. outputs/pr_review_comments/*.md for every inline comment; reference each via the "comment" field in pr_review.json.\n' +
        '   Never put comment text inline in the JSON (no "body" field).\n\n' +
        'Do NOT write outputs/response.md.\n\n' +
        'If you found a BLOCK or REQUEST_CHANGES result, still write the files. Do not return only plain text.\n' +
        'If the finding is not on a changed diff line, put it in outputs/pr_review_general.md and leave inlineComments empty.\n' +
        'Validate outputs/pr_review.json as parseable JSON before stopping.\n' +
        'Ticket: ' + ticketKey + '\n';
}

function attemptResumeIfReviewOutputsMissing(ticketKey) {
    if (readReviewJson()) {
        return false;
    }
    if (resumeAlreadyAttempted()) {
        return false;
    }
    return runResumeAttempt(ticketKey);
}

function resumeAlreadyAttempted() {
    try {
        var marker = file_read({ path: RESUME_MARKER });
        if (marker && marker.trim()) {
            console.warn('Review output resume already attempted once — skipping');
            return true;
        }
        return false;
    } catch (e) {
        return false;
    }
}

function runResumeAttempt(ticketKey) {
    console.log('Mandatory PR review outputs are missing. Attempting one resume run to write them.');
    writeFile(RESUME_MARKER, new Date().toISOString() + '\n');

    var promptFile = 'outputs/.pr-review-resume-prompt.md';
    writeFile(promptFile, buildResumePrompt(ticketKey));

    try {
        var resumeResult = cli_execute_command({
            // `--continue` alone resumes the most recent session in this directory;
            // pairing it with `--resume` is rejected by the Copilot CLI as mutually
            // exclusive ("cannot be used with option '--continue'"), which made this
            // recovery run fail deterministically before ever reaching the agent.
            command: 'bash agents/scripts/run-agent.sh --continue ' + promptFile
        });
        console.log('Review output resume run output:', (resumeResult || '').substring(0, 500));
        return true;
    } catch (e) {
        console.error('Review output resume run failed:', e);
        return false;
    }
}

function handleMissingReviewData(params, config, customParams, tracker) {
    var ticketKey = params.ticket.key;
    console.error('Failed to read pr_review.json after resume attempt');

    postMissingOutputComment(tracker, ticketKey);
    removeSmLabelAfterMissingOutput(tracker, ticketKey, customParams);
    triggerSmAfterMissingOutput(config, customParams);

    return {
        success: true,
        action: 'missing_review_outputs',
        error: 'No review data found in pr_review.json'
    };
}

function postMissingOutputComment(tracker, ticketKey) {
    try {
        const mm = commentMarkup.forTicket(ticketKey);
        tracker.postComment(
            ticketKey,
            mm.h(3, '⚠️ PR Review Output Missing') + '\n\n' +
                'The PR review agent completed without writing ' + mm.inline('outputs/pr_review.json') + '. ' +
                'A resume was attempted once, but mandatory outputs are still missing. ' +
                'The SM trigger label was cleared so the review can retry.'
        );
    } catch (e) {
        console.warn('Could not post missing review output comment:', e);
    }
}

function removeSmLabelAfterMissingOutput(tracker, ticketKey, customParams) {
    var removeLabel = customParams && customParams.removeLabel;
    if (!removeLabel) return;
    try {
        tracker.removeLabel(ticketKey, removeLabel);
        console.log('Removed SM label after missing review output:', removeLabel);
    } catch (e) {
        console.warn('Could not remove SM label after missing review output:', e);
    }
}

function triggerSmAfterMissingOutput(config, customParams) {
    try {
        var scm = scmModule.createScm(config);
        autoStart.triggerSmIfIdle({ config: config, customParams: customParams, scm: scm });
    } catch (e) {
        console.warn('Could not trigger SM after missing review output:', e);
    }
}

/**
 * Extract owner and repo from git remote URL
 * @returns {Object|null} {owner, repo} or null on error
 */
function getGitHubRepoInfo() {
    try {
        return parseGitHubRemoteUrl(cli_execute_command({
            command: 'git config --get remote.origin.url'
        }) || '');
    } catch (error) {
        console.error('Failed to get GitHub repo info:', error);
        return null;
    }
}

/**
 * Parse the first github.com remote line out of raw `git config` output.
 * cli_execute_command may append shell wrapper lines (Script done,
 * COMMAND_EXIT_CODE=...), so only URL-looking lines are considered.
 */
function parseGitHubRemoteUrl(rawOutput) {
    var remoteUrl = firstGithubRemoteLine(rawOutput);
    var match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/?#\s]+)/);
    if (!match) {
        console.error('Could not parse GitHub URL from:', remoteUrl);
        return null;
    }
    console.log('GitHub repo:', match[1] + '/' + repoNameFromMatch(match[2]));
    return { owner: match[1], repo: repoNameFromMatch(match[2]) };
}

function firstGithubRemoteLine(rawOutput) {
    var lines = String(rawOutput).split('\n').map(function(l) { return l.trim(); });
    return lines.filter(function(l) { return l.indexOf('github.com') !== -1; })[0] || '';
}

function repoNameFromMatch(repo) {
    return repo.replace(/\.git$/, '');
}

function postGeneralComment(scm, pullRequestId, commentPath, ticketKey, workingDir) {
    try {
        const comment = readMarkdownFile(commentPath, ticketKey, workingDir);
        if (!comment) {
            console.warn('No general comment content found at', commentPath);
            return false;
        }
        console.log('Posting general review comment to PR #' + pullRequestId);
        scm.addComment(pullRequestId, comment);
        console.log('✅ Posted general review comment');
        return true;
    } catch (error) {
        console.error('Failed to post general comment:', error);
        return false;
    }
}

function parseDiffLineInfo(diffText, filePath, targetLine) {
    // Returns { present: true/false, side: 'RIGHT'|'LEFT'|null }.
    if (!diffText || !filePath || !targetLine) return { present: true, side: null };

    var lineNumber = parseInt(targetLine, 10);
    if (!lineNumber) return { present: true, side: null };

    return scanDiffForLine(diffLines(diffText), filePath, lineNumber);
}

function newParseScanState() {
    return { currentFile: null, oldFile: null, oldLine: null, newLine: null, pendingLeftMatch: null };
}

/**
 * One line of the diff scan: header bookkeeping (file switches, hunk
 * counters) or content matching. Returns a match object to stop the scan,
 * or null to continue.
 */
function scanDiffLine(st, filePath, lineNumber, line) {
    if (parseTrackHeaderLine(st, line)) return null;
    if (st.currentFile !== filePath) return null;
    return consumeParsedContentLine(st, line, lineNumber);
}

function scanDiffForLine(lines, filePath, lineNumber) {
    var st = newParseScanState();
    for (var i = 0; i < lines.length; i++) {
        var match = scanDiffLine(st, filePath, lineNumber, lines[i]);
        if (match) return match;
    }
    // Deferred LEFT match: a removed line ('-') at the target line number.
    // We don't return immediately on a LEFT match because a same-numbered
    // added line ('+') can appear later in the same replace block (the
    // common "-old\n+new" single-line replacement pattern) and RIGHT should
    // win — the finding is about the current/new code, not the removed one.
    if (st.pendingLeftMatch) return st.pendingLeftMatch;
    return { present: false, side: null };
}

function parseTrackHeaderLine(st, line) {
    if (line.indexOf('--- a/') === 0) {
        st.oldFile = oldFilePathOf(line);
        return true;
    }
    if (line.indexOf('+++') === 0) {
        parseTrackNewFile(st, line);
        return true;
    }
    if (line.indexOf('diff --git ') === 0) {
        st.currentFile = null;
        st.oldFile = null;
        st.oldLine = null;
        st.newLine = null;
        st.pendingLeftMatch = null;
        return true;
    }
    return false;
}

function parseTrackNewFile(st, line) {
    if (line.indexOf('+++ /dev/null') === 0) {
        // Deleted files have +++ /dev/null; use the old path so comments can be anchored.
        st.currentFile = st.oldFile;
        return;
    }
    st.currentFile = line.substring('+++ b/'.length);
}

function consumeParsedContentLine(st, line, lineNumber) {
    if (applyHunkHeader(st, line)) return null;
    if (st.oldLine === null || st.newLine === null) return null;
    return dispatchParsedLine(st, line, lineNumber);
}

function applyHunkHeader(st, line) {
    var hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (!hunk) return false;
    st.oldLine = parseInt(hunk[1], 10);
    st.newLine = parseInt(hunk[2], 10);
    return true;
}

function dispatchParsedLine(st, line, lineNumber) {
    if (line.indexOf('+') === 0) return matchAddedLine(st, lineNumber);
    if (line.indexOf('-') === 0) return matchRemovedLine(st, lineNumber);
    return dispatchSpaceOrOtherLine(st, line, lineNumber);
}

function dispatchSpaceOrOtherLine(st, line, lineNumber) {
    if (line.indexOf(' ') === 0) return matchContextLine(st, lineNumber);
    if (line === '\\ No newline at end of file') return null;
    st.oldLine++;
    st.newLine++;
    return null;
}

function matchAddedLine(st, lineNumber) {
    if (st.newLine === lineNumber) return { present: true, side: 'RIGHT' };
    st.newLine++;
    return null;
}

function matchRemovedLine(st, lineNumber) {
    if (st.oldLine === lineNumber && !st.pendingLeftMatch) {
        st.pendingLeftMatch = { present: true, side: 'LEFT' };
    }
    st.oldLine++;
    return null;
}

function matchContextLine(st, lineNumber) {
    // Context lines exist on both sides; prefer RIGHT (new version).
    if (st.newLine === lineNumber) return { present: true, side: 'RIGHT' };
    if (st.oldLine === lineNumber) return { present: true, side: 'LEFT' };
    st.oldLine++;
    st.newLine++;
    return null;
}

function diffLines(diffText) {
    return String(diffText).split(/\r?\n/);
}

function isFileDeletedInDiff(diffText, filePath) {
    if (!diffText || !filePath) return false;
    return scanDeletedFileMarker(diffLines(diffText), filePath);
}

function scanDeletedFileMarker(lines, filePath) {
    var state = { oldFile: null, currentFile: null };
    for (var i = 0; i < lines.length; i++) {
        trackDiffFileState(state, lines[i]);
        if (deletedMarkerInLine(state, filePath, lines[i])) return true;
    }
    return false;
}

function trackDiffFileState(state, line) {
    if (line.indexOf('--- a/') === 0) {
        state.oldFile = oldFilePathOf(line);
        return state;
    }
    if (line.indexOf('+++') === 0) {
        return trackNewFileMarker(state, line);
    }
    if (line.indexOf('diff --git ') === 0) {
        // "deleted file mode" precedes the ---/+++ lines in a deletion
        // header, so key the segment off the diff --git a/<p> b/<p> path.
        var segPath = headerPathOf(line);
        state.currentFile = segPath;
        state.oldFile = segPath;
    }
    return state;
}

function trackNewFileMarker(state, line) {
    if (line.indexOf('+++ /dev/null') === 0) {
        // Deleted files have +++ /dev/null; the current path is the old one.
        state.currentFile = state.oldFile;
        return state;
    }
    state.currentFile = line.substring('+++ b/'.length);
    return state;
}

function headerPathOf(line) {
    var rest = line.substring('diff --git a/'.length);
    var sep = rest.indexOf(' b/');
    if (sep === -1) return rest;
    return rest.substring(0, sep);
}

function oldFilePathOf(line) {
    var oldFile = line.substring('--- a/'.length);
    if (oldFile === '/dev/null') return null;
    return oldFile;
}

function deletedMarkerInLine(state, filePath, line) {
    return state.currentFile === filePath && line.indexOf('deleted file mode') === 0;
}

function isLinePresentInDiff(diffText, filePath, targetLine, side) {
    var info = parseDiffLineInfo(diffText, filePath, targetLine);
    if (!info.present) return false;
    if (!side) return true;
    return info.side === side;
}

function submoduleSegmentRegex(filePath) {
    var escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('diff --git a/' + escaped + '(?:\\s+b/' + escaped + '(?:\\s|$))?');
}

/**
 * Scan the `filePath` submodule segment of the diff with a per-line predicate.
 * Shared by isSubmodulePathInDiff (any pointer mention) and
 * submoduleHasNewPointer (new pointer only).
 */
function scanSubmoduleSegment(diffText, filePath, linePredicate) {
    var lines = diffLines(diffText);
    var segmentRe = submoduleSegmentRegex(filePath);
    var inSegment = false;
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf('diff --git ') === 0) {
            inSegment = segmentRe.test(line);
            continue;
        }
        if (inSegment && linePredicate(line)) {
            return true;
        }
    }
    return false;
}

function containsSubprojectCommit(line) {
    return line.indexOf('Subproject commit') !== -1;
}

function startsWithNewSubprojectCommit(line) {
    return line.indexOf('+Subproject commit') === 0;
}

/**
 * Returns true if the PR diff contains a submodule pointer change for `filePath`
 * (e.g. "Subproject commit ...").
 */
function isSubmodulePathInDiff(diffText, filePath) {
    if (!diffText || !filePath) return false;
    return scanSubmoduleSegment(diffText, filePath, containsSubprojectCommit);
}

/**
 * For comments targeting a file inside a submodule (e.g. "trackstate-setup/README.md:7")
 * when the parent PR diff only contains the submodule pointer change, map the comment
 * to the submodule path itself (e.g. "trackstate-setup"). Returns the submodule path or
 * null if no matching submodule segment exists.
 */
function findSubmodulePathForFile(diffText, filePath) {
    if (!diffText || !filePath) return null;
    var parts = filePath.split('/');
    for (var i = parts.length; i > 0; i--) {
        var candidate = parts.slice(0, i).join('/');
        if (isSubmodulePathInDiff(diffText, candidate)) {
            return candidate;
        }
    }
    return null;
}

/**
 * Returns true if the submodule segment for `filePath` contains a new pointer
 * ("+Subproject commit ..."), i.e. the submodule was updated rather than deleted.
 */
function submoduleHasNewPointer(diffText, filePath) {
    if (!diffText || !filePath) return false;
    return scanSubmoduleSegment(diffText, filePath, startsWithNewSubprojectCommit);
}

function postFallbackInlineComment(scm, pullRequestId, filePath, line, commentText) {
    var lineRef = filePath + (line ? ':' + line : '');
    scm.addComment(pullRequestId, '📍 **`' + lineRef + '`**\n\n' + commentText);
    console.log('✅ Posted fallback PR comment for ' + lineRef);
}

function inlineTargetOf(inlineComment) {
    return inlineComment.path || inlineComment.file;
}

function rawInlineTextOf(inlineComment, ticketKey, workingDir) {
    return inlineComment.body || readMarkdownFile(inlineComment.comment, ticketKey, workingDir);
}

/**
 * Resolve the effective inline comment text: a `body` that actually holds a
 * comment-file reference is replaced with the referenced file's content
 * (see resolveCommentFileReference).
 */
function resolveInlineComment(inlineComment, ticketKey, workingDir) {
    var commentText = rawInlineTextOf(inlineComment, ticketKey, workingDir);
    var resolvedFromBody = resolveCommentFileReference(commentText, ticketKey, workingDir);
    if (!resolvedFromBody) return commentText;
    console.warn('inlineComment.body looked like a comment-file path (' + commentText + ') — reading its content instead of posting the path literally');
    return resolvedFromBody;
}

/**
 * gh-1350 machine-stamped severity (epic gh-1328 step 1/4): the posted
 * thread's severity prefix is built from the STRUCTURED JSON field
 * (`inlineComment.severity`) — the canonical `🚨 severity: BLOCKING —` /
 * `⚠️ severity: IMPORTANT —` / `💡 severity: SUGGESTION —` line first, the
 * agent's prose below it. The comment file's own severity prose is never
 * the source: a body opening `🚨 severity: none` under a JSON severity
 * IMPORTANT posts `⚠️ severity: IMPORTANT` (the PR #1319 thread 1
 * corruption class dies here). No (or unrecognized — the NIT enum lands in
 * part 2) severity stamps nothing and the body posts verbatim.
 */
function machineStampedInlineText(inlineComment, commentText) {
    var stamped = reviewVerdicts.machineSeverityLine(inlineComment && inlineComment.severity);
    if (!stamped) return commentText;
    return stamped + '\n' + reviewVerdicts.stripLeadingSeverityLine(commentText);
}

function postInlineComment(scm, pullRequestId, inlineComment, ticketKey, workingDir) {
    // Accept both spec formats:
    //   old spec: { file, comment: "path/to/file.md" }
    //   agent output: { path, body: "inline text" }
    var filePath = inlineTargetOf(inlineComment);
    var commentText = machineStampedInlineText(inlineComment, resolveInlineComment(inlineComment, ticketKey, workingDir));

    try {
        return postResolvedInlineComment(scm, pullRequestId, inlineComment, filePath, commentText, ticketKey, workingDir);
    } catch (error) {
        // 422 = line not in diff hunk — fall back to a regular PR comment so nothing is lost
        return fallbackInlineComment(scm, pullRequestId, filePath, inlineComment.line, commentText, error);
    }
}

function postResolvedInlineComment(scm, pullRequestId, inlineComment, filePath, commentText, ticketKey, workingDir) {
    // Guard + target log shared with the story review poster (gh-1246).
    if (!reviewHelpers.validateInlineCommentTarget(filePath, inlineComment.line, commentText)) {
        return false;
    }
    return dispatchInlineComment(scm, pullRequestId, inlineComment, filePath, commentText, ticketKey, workingDir);
}

function dispatchInlineComment(scm, pullRequestId, inlineComment, filePath, commentText, ticketKey, workingDir) {
    var diffText = fetchPrDiffQuietly(scm, pullRequestId, workingDir);
    if (isDiffUnavailable(diffText)) {
        console.warn('PR diff unavailable; falling back to general PR comment on ' + filePath + ':' + inlineComment.line);
        postFallbackInlineComment(scm, pullRequestId, filePath, inlineComment.line, commentText);
        return true;
    }
    return postAnchoredInlineComment(scm, pullRequestId, inlineComment, filePath, commentText, diffText);
}

function fetchPrDiffQuietly(scm, pullRequestId, workingDir) {
    try {
        return scm.getPrDiff(pullRequestId, workingDir);
    } catch (diffError) {
        console.warn('Could not fetch PR diff for inline comment validation:', diffError.message || diffError);
        return null;
    }
}

function isDiffUnavailable(diffText) {
    return diffText === null || diffText === '';
}

/**
 * Plan where/how the inline comment anchors in the diff: submodule remap,
 * side resolution and the optional submodule-content prefix. Pure given the
 * diff text — no SCM calls.
 */
function planInlineAnchor(diffText, inlineComment, filePath, commentText) {
    var plan = {
        requestedSide: inlineComment.side || null,
        effectivePath: filePath,
        effectiveLine: inlineComment.line,
        startLine: inlineComment.startLine || null,
        commentText: commentText
    };
    plan.lineInfo = parseDiffLineInfo(diffText, plan.effectivePath, plan.effectiveLine);
    applySubmoduleRemap(diffText, inlineComment, filePath, plan);
    resolveRequestedSide(diffText, plan);
    return plan;
}

function applySubmoduleRemap(diffText, inlineComment, filePath, plan) {
    if (plan.lineInfo.present) return;
    var submodulePath = findSubmodulePathForFile(diffText, filePath);
    if (!submodulePath) return;
    remapToSubmodule(diffText, inlineComment, filePath, submodulePath, plan);
}

function remapToSubmodule(diffText, inlineComment, filePath, submodulePath, plan) {
    console.log('Comment target ' + filePath + ':' + inlineComment.line +
        ' is inside submodule ' + submodulePath +
        '; mapping to submodule diff line 1 to create a review thread');
    plan.effectivePath = submodulePath;
    plan.effectiveLine = 1;
    plan.startLine = null;
    plan.lineInfo = parseDiffLineInfo(diffText, plan.effectivePath, plan.effectiveLine);
    // Submodule updates expose both old and new pointers; anchor on the new side
    // so the review thread appears on the updated submodule line.
    plan.requestedSide = submoduleAnchorSide(diffText, plan);
    if (submodulePath !== filePath || inlineComment.line != 1) {
        plan.commentText = '📍 **`' + filePath + ':' + inlineComment.line + '`** (submodule content line)\n\n' + plan.commentText;
    }
}

function submoduleAnchorSide(diffText, plan) {
    if (plan.lineInfo.side === 'LEFT' && submoduleHasNewPointer(diffText, plan.effectivePath)) return 'RIGHT';
    return plan.lineInfo.side || 'RIGHT';
}

function resolveRequestedSide(diffText, plan) {
    if (plan.requestedSide) return;
    if (plan.lineInfo.present) {
        plan.requestedSide = plan.lineInfo.side;
        return;
    }
    if (isFileDeletedInDiff(diffText, plan.effectivePath)) {
        plan.requestedSide = 'LEFT';
    }
}

function postAnchoredInlineComment(scm, pullRequestId, inlineComment, filePath, commentText, diffText) {
    var plan = planInlineAnchor(diffText, inlineComment, filePath, commentText);

    if (!plan.lineInfo.present) {
        console.warn('Inline comment line is not present in PR diff; falling back to PR comment on ' + filePath + ':' + inlineComment.line);
        postFallbackInlineComment(scm, pullRequestId, filePath, inlineComment.line, plan.commentText);
        return true;
    }

    if (inlineComment.side && plan.lineInfo.side !== inlineComment.side) {
        console.warn('Inline comment line is not present on requested side ' + inlineComment.side + '; falling back to PR comment on ' + filePath + ':' + inlineComment.line);
        postFallbackInlineComment(scm, pullRequestId, filePath, inlineComment.line, plan.commentText);
        return true;
    }

    scm.addInlineComment(
        pullRequestId, plan.effectivePath, plan.effectiveLine, plan.commentText,
        plan.startLine, plan.requestedSide
    );

    console.log('✅ Posted inline comment on ' + plan.effectivePath + ':' + plan.effectiveLine +
        (inlineCommentMapped(plan, filePath, inlineComment) ?
            ' (mapped from ' + filePath + ':' + inlineComment.line + ')' : ''));
    return true;
}

function inlineCommentMapped(plan, filePath, inlineComment) {
    return plan.effectivePath !== filePath || plan.effectiveLine !== inlineComment.line;
}

function fallbackInlineComment(scm, pullRequestId, filePath, line, commentText, error) {
    console.warn('Inline comment failed (line not in diff?), falling back to PR comment on ' + filePath + ':' + line);
    try {
        postFallbackInlineComment(scm, pullRequestId, filePath, line, commentText);
        return true;
    } catch (fallbackError) {
        console.error('Failed to post fallback PR comment for ' + filePath + ':', fallbackError);
        return false;
    }
}

function resolveApprovedThreads(scm, pullRequestId, resolvedThreadIds) {
    if (!resolvedThreadIds || resolvedThreadIds.length === 0) return;
    console.log('Resolving ' + resolvedThreadIds.length + ' fixed review thread(s)...');
    resolvedThreadIds.forEach(function(threadId) {
        try {
            scm.resolveThread(pullRequestId, { threadId: threadId });
            console.log('✅ Resolved thread', threadId);
        } catch (e) {
            console.warn('Failed to resolve thread ' + threadId + ':', e.message || e);
        }
    });
}

/**
 * Opt-in native GitHub PR review (formal Approve/Request Changes decision via the
 * real GitHub Review API), entirely additive to — and independent from — the
 * pr_approved label lifecycle managed elsewhere in this file. Enabled via
 * customParams.formalGithubReview = true.
 *
 * When AI does not approve (recommendation !== APPROVE, i.e. isApproved === false):
 *   formally requests changes on the PR (scm.submitReview(..., 'REQUEST_CHANGES', ...)).
 * When AI approves (isApproved === true):
 *   dismisses any prior formally-requested-changes review left on the PR so the
 *   PR is no longer blocked by our own earlier "Request Changes" decision, then
 *   submits a formal APPROVE review (providers may reject approvals from the
 *   PR author — that rejection is logged, never fatal: the label lifecycle
 *   stays the source of truth in that case).
 *
 * Never touches LABELS.PR_APPROVED or any Jira/GitHub label.
 */
function applyFormalGithubReview(scm, pullRequestId, isApproved, recommendation, generalComment, ticketKey, workingDir) {
    if (typeof scm.submitReview !== 'function') {
        console.warn('formalGithubReview: SCM provider does not support submitReview — skipping');
        return;
    }
    try {
        if (isApproved) {
            applyFormalApprove(scm, pullRequestId, formalApproveBody(generalComment, ticketKey, workingDir));
            return;
        }
        scm.submitReview(pullRequestId, 'REQUEST_CHANGES', formalRejectBody(generalComment, recommendation, ticketKey, workingDir));
        console.log('✅ Submitted formal Request Changes review');
    } catch (e) {
        console.warn('formalGithubReview: failed to apply formal review:', e.message || e);
    }
}

function formalReviewContent(generalComment, ticketKey, workingDir) {
    // generalComment follows the file-path contract (postGeneralComment
    // reads it via readMarkdownFile): resolve path → CONTENT before
    // submitting, or the review body is the literal "outputs/..." string
    // (live: flutter_agent_harness #720 APPROVE body was the file path).
    return resolveCommentFileReference(generalComment, ticketKey, workingDir) || generalComment;
}

function nonEmptyBody(content, fallback) {
    return (content && String(content).trim()) ? content : fallback;
}

function formalApproveBody(generalComment, ticketKey, workingDir) {
    return nonEmptyBody(formalReviewContent(generalComment, ticketKey, workingDir), 'AI review approves this pull request.');
}

function formalRejectBody(generalComment, recommendation, ticketKey, workingDir) {
    return nonEmptyBody(formalReviewContent(generalComment, ticketKey, workingDir),
        'AI review returned ' + recommendation + '. See PR comments for details.');
}

function applyFormalApprove(scm, pullRequestId, approveBody) {
    // Dismiss our own earlier "Request Changes" first (GitHub keeps
    // blocking the PR until it is dismissed). Providers without a
    // review listing (GitLab) skip the pass — approving over a stale
    // requested-changes comment is still a net approval.
    dismissPriorChangeRequests(scm, pullRequestId);
    try {
        scm.submitReview(pullRequestId, 'APPROVE', approveBody);
        console.log('✅ Submitted formal APPROVE review');
    } catch (approveErr) {
        // GitHub/GitLab refuse approvals from the PR/MR AUTHOR. When
        // the reviewing identity is the same bot that opened the PR,
        // the label lifecycle stays the source of truth — do not fail
        // the whole review action over it.
        console.warn('formalGithubReview: formal APPROVE rejected (own-PR restriction?):', approveErr.message || approveErr);
    }
}

function dismissPriorChangeRequests(scm, pullRequestId) {
    if (typeof scm.listReviews !== 'function') return;
    dismissEachChangeRequest(scm, pullRequestId, listReviewsQuietly(scm, pullRequestId));
}

function listReviewsQuietly(scm, pullRequestId) {
    try {
        return scm.listReviews(pullRequestId) || [];
    } catch (listErr) {
        console.warn('formalGithubReview: failed to list existing reviews:', listErr.message || listErr);
        return [];
    }
}

function changeRequestReviews(reviews) {
    return reviews.filter(function(r) {
        return r && r.state === 'CHANGES_REQUESTED';
    });
}

function dismissEachChangeRequest(scm, pullRequestId, reviews) {
    changeRequestReviews(reviews).forEach(function(r) {
        try {
            scm.dismissReview(pullRequestId, r.id, 'Superseded — issues addressed, AI review now approves.');
            console.log('✅ Dismissed prior formal Request Changes review', r.id);
        } catch (dismissErr) {
            console.warn('formalGithubReview: failed to dismiss review ' + r.id + ':', dismissErr.message || dismissErr);
        }
    });
}

/**
 * gh-807 verdict persistence: stamp the machine-parseable verdict record on
 * the PR — a comment carrying the structured review-verdict marker (head sha
 * + EFFECTIVE verdict + thread census). The SM tick reconciles contradictory
 * review legs per head from these records; free-form comment text is never
 * consulted (AC4). The verdict recorded is what this leg actually DID
 * (isApproved reflects the approve-with-suggestions overrides), not the raw
 * LLM token. Non-fatal: a lost record degrades to pre-gh-807 behavior — the
 * tick fails open when a head has no records. A head sha is REQUIRED: a
 * verdict without a head is exactly the pathology this fixes, so the post is
 * skipped when the sha cannot be resolved.
 */
function postVerdictRecord(scm, repoInfo, prNumber, isApproved, recommendation, issueCounts, provider) {
    try {
        return postVerdictRecordChecked(scm, repoInfo, prNumber, isApproved, recommendation, issueCounts, provider);
    } catch (e) {
        console.warn('verdict record post failed (non-fatal):', e.message || e);
        return null;
    }
}

function postVerdictRecordChecked(scm, repoInfo, prNumber, isApproved, recommendation, issueCounts, provider) {
    // The same probe feeds the density audit (gh-1351): the PR object's
    // additions field sizes the 💡/🪶 thread cap. null → the audit skips.
    var prObj = probePrObject(repoInfo, prNumber);
    if (prObj === null) return null;
    var headSha = headShaOfObject(prObj);
    if (!headSha) {
        console.warn('verdict record: PR #' + prNumber + ' has no head sha — record not posted');
        return null;
    }
    stampVerdictRecord(scm, prNumber, headSha, isApproved, recommendation, issueCounts, provider);
    return prObj;
}

/**
 * One best-effort PR object probe (github_get_pr) for the verdict record +
 * the density audit. Returns the parsed object, or null when the probe
 * fails (already warned — the callers degrade, never fail).
 */
function probePrObject(repoInfo, prNumber) {
    try {
        var prRaw = github_get_pr({
            workspace: repoInfo.owner, repository: repoInfo.repo, pullRequestId: String(prNumber)
        });
        return prObjectOf(prRaw);
    } catch (headErr) {
        console.warn('verdict record: head sha probe failed — record not posted:', headErr.message || headErr);
        return null;
    }
}

function prObjectOf(prRaw) {
    if (typeof prRaw === 'string') {
        try {
            return JSON.parse(prRaw) || {};
        } catch (e) {
            return {};
        }
    }
    return prRaw || {};
}

function prAdditionsOf(prRaw) {
    var obj = prObjectOf(prRaw);
    return typeof obj.additions === 'number' ? obj.additions : null;
}

function headShaOfObject(prObj) {
    if (!prObj) return undefined;
    if (!prObj.head) return undefined;
    return prObj.head.sha;
}

function verdictLabel(isApproved, recommendation) {
    if (isApproved) return 'APPROVE';
    return recommendation === 'BLOCK' ? 'BLOCK' : 'REQUEST_CHANGES';
}

function stampVerdictRecord(scm, prNumber, headSha, isApproved, recommendation, issueCounts, provider) {
    var verdict = verdictLabel(isApproved, recommendation);
    var body = reviewVerdicts.buildVerdictComment({
        head: headSha,
        verdict: verdict,
        blocking: issueCounts.blocking,
        important: issueCounts.important,
        suggestions: issueCounts.suggestions,
        nits: issueCounts.nits,
        digest: issueCounts.digest,
        source: 'pr_review.json'
    }, provider);
    if (!body) {
        console.warn('verdict record: unbuildable record (verdict ' + verdict + ') — not posted');
        return;
    }
    scm.addComment(prNumber, body);
    console.log('✅ Stamped machine verdict record on PR #' + prNumber + ' (' + verdict +
                ', head ' + String(headSha).substring(0, 7) + ')');
}

// ═══════════════ gh-1403 review filter leg (verification: filter) ═══════════════
//
// Placement (gh-1403): AFTER the review leg produces outputs/pr_review.json,
// BEFORE posting (this action's step 4). A fresh-context CLI run (the same
// run-agent.sh wrapper, one extra review pass per round — the ByteDance
// BitsAI-CR shape) verifies each rework/polish-tier candidate against the
// diff hunks + the interaction neighborhood and returns
// keep | demote(<tier>) | drop per candidate. Machine semantics: the census
// is recomputed AFTER filtering; drop → digest-only line (visible, never a
// thread); demote → tier downgrade. 💡-digest lines are not threads and
// round-none tiers (🪶 under the default preset) never go through.
// Fail-open end to end: any filter failure (CLI, missing/malformed verdict
// file) logs and degrades to the unfiltered review — the filter can never
// cost the leg its posting.

var FILTER_PROMPT_FILE = 'outputs/.pr-review-filter-prompt.md';
var FILTER_CLI_PREFIX = 'bash agents/scripts/run-agent.sh ';

function verificationEnabledOf(policy) {
    return !!policy && policy.verification === 'filter';
}

function filterDiffPathOf(params) {
    var folder = params && params.inputFolderPath;
    return (folder ? folder : 'input') + '/pr_diff.txt';
}

function filterCliCommandOf() {
    return FILTER_CLI_PREFIX + FILTER_PROMPT_FILE;
}

/**
 * The claim resolution injected into the pure candidate selection — the
 * same body-or-comment-file resolution the poster uses.
 */
function filterClaimResolver(ctx) {
    return function (inlineComment) {
        return resolveInlineComment(inlineComment, ctx.ticketKey, ctx.workingDir);
    };
}

function writeFilterArtifact(path, content) {
    writeFile(path, content);
}

function runFilterCli() {
    // No workingDirectory override: the filter agent reads input/ + outputs/
    // from the RUNTIME cwd exactly like the review leg and the gh-775
    // resume run; code paths (when config.workingDir is set) ride the
    // prompt, not the subprocess cwd.
    try {
        var out = cli_execute_command({ command: filterCliCommandOf() });
        console.log('🧯 review filter CLI run completed: ' + String(out || '').substring(0, 300));
        return true;
    } catch (e) {
        console.warn('🧯 review filter CLI failed (gh-1403 fail-open, running unfiltered): ' + (e.message || e));
        return false;
    }
}

function readFilterVerdictsRaw(ctx) {
    try {
        var review = outputFiles.readOutputFileDetailed(reviewFilterModule.OUTPUT_FILE, {
            ticketKey: ctx.ticketKey,
            workingDir: ctx.workingDir
        });
        return review && review.content ? review.content : null;
    } catch (e) {
        console.warn('🧯 review filter verdicts unreadable (gh-1403 fail-open, running unfiltered): ' + (e.message || e));
        return null;
    }
}

function filterPathOfGeneralComment(reviewData) {
    var path = reviewData && typeof reviewData.generalComment === 'string' ? reviewData.generalComment.trim() : null;
    if (!path || !/^(outputs\/)?(pr_review_comments\/)?[\w.\-]+\.md$/.test(path)) return null;
    return path;
}

/**
 * The anti-over-suppression listing (gh-1403): the dropped candidates are
 * appended to the general comment file the generalComment field references
 * — visible, one line each, never a thread. A non-file generalComment (or
 * an unreadable file) skips the injection; the stats still log.
 */
function appendDroppedSection(reviewData, section, ctx) {
    var path = filterPathOfGeneralComment(reviewData);
    if (!path) return false;
    var content = readMarkdownFile(path, ctx.ticketKey, ctx.workingDir);
    if (!content) return false;
    writeFilterArtifact(path, content.replace(/\s*$/, '') + '\n' + section + '\n');
    return true;
}

/**
 * A demote on a FILE-referenced comment stamps the demotion note into the
 * comment file (inline bodies got theirs from the pure apply). Entries are
 * consumed once so two demotes on one file cannot double-append.
 */
function stampDemotionNotesOnFiles(reviewData, applied, ctx) {
    var inline = reviewData && Array.isArray(reviewData.inlineComments) ? reviewData.inlineComments : [];
    var stamps = (applied || []).filter(function(a) { return a.decision === 'demote' && a.note; });
    for (var i = 0; i < stamps.length; i++) {
        var stamp = stamps[i];
        for (var j = 0; j < inline.length; j++) {
            var entry = inline[j] || {};
            if (entry.__filterNoted || entry.path !== stamp.path || entry.line !== stamp.line) continue;
            if (String(entry.severity || '').toUpperCase() !== stamp.to) continue;
            entry.__filterNoted = true;
            if (!entry.comment) break;
            var content = readMarkdownFile(entry.comment, ctx.ticketKey, ctx.workingDir);
            if (content) {
                writeFilterArtifact(entry.comment, content.replace(/\s*$/, '') + '\n' + stamp.note + '\n');
            }
            break;
        }
    }
    for (var k = 0; k < inline.length; k++) {
        delete inline[k].__filterNoted;
    }
}

function logFilterOutcome(stats, warning, notes) {
    console.log('🧯 ' + reviewFilterModule.buildFilterStampLine(stats));
    (notes || []).forEach(function(n) {
        console.warn('🧯 review filter: ' + n);
    });
    if (warning) console.warn(warning);
}

/**
 * The wired filter leg (gh-1403): select candidates → run the fresh-context
 * CLI → apply verdicts → recompute the census → list drops in the general
 * comment. Returns { stats, applied, dropped } or null (verification none,
 * zero candidates, or any fail-open degradation — in every null case the
 * review data posts exactly as the review leg raised it).
 */
function applyReviewFilter(reviewData, ctx, diffPath) {
    try {
        if (!verificationEnabledOf(ctx.reviewPolicy)) return null;
        var candidates = reviewFilterModule.selectFilterCandidates(reviewData, ctx.reviewPolicy, filterClaimResolver(ctx));
        if (candidates.length === 0) {
            console.log('🧯 review filter (gh-1403): 0 candidates (no rework/polish-tier threads) — skipped');
            return null;
        }
        writeFilterArtifact('outputs/' + reviewFilterModule.INPUT_FILE, reviewFilterModule.buildFilterInputJson(candidates));
        writeFilterArtifact(FILTER_PROMPT_FILE, reviewFilterModule.buildFilterPrompt(diffPath, ctx.workingDir));
        if (!runFilterCli()) return null;
        var raw = readFilterVerdictsRaw(ctx);
        if (!raw) {
            console.warn('🧯 review filter: no verdicts file — running unfiltered (gh-1403 fail-open)');
            return null;
        }
        var parsed = reviewFilterModule.parseFilterVerdicts(raw);
        var result = reviewFilterModule.applyFilterVerdicts(reviewData, candidates, parsed.verdicts);
        if (!result.changed) {
            // Zero applicable verdicts (malformed payload, unknown ids,
            // all-refused demotes) — nothing was filtered, so the census is
            // NOT recomputed and the leg posts exactly as raised.
            console.warn('🧯 review filter: no applicable verdicts — running unfiltered (gh-1403 fail-open)');
            return null;
        }
        stampDemotionNotesOnFiles(reviewData, result.applied, ctx);
        // gh-1403 machine semantics: the census is recomputed AFTER filtering;
        // the gh-1351 verdict machinery then reads it unchanged.
        reviewData.issueCounts = reviewFilterModule.recomputeCensus(reviewData, result.dropped.length);
        var stats = reviewFilterModule.filterStats(candidates.length, result.applied);
        var warning = reviewFilterModule.buildOverSuppressionWarning(stats);
        logFilterOutcome(stats, warning, parsed.notes.concat(result.notes));
        var section = reviewFilterModule.buildGeneralCommentInjection(stats, result.dropped);
        if (section) appendDroppedSection(reviewData, section, ctx);
        return { stats: stats, applied: result.applied, dropped: result.dropped, warning: warning };
    } catch (e) {
        console.warn('🧯 review filter failed (gh-1403 non-fatal, running unfiltered): ' + (e.message || e));
        return null;
    }
}

/**
 * The filter stamp in the tracker review comment (gh-1403): one line per
 * round, plus the misconfigured-filter warning when it fired. '' when the
 * filter did not run.
 */
function filterStampSection(m, filterOutcome) {
    if (!filterOutcome || !filterOutcome.stats) return '';
    var line = m.h(3, 'Review Filter (gh-1403)') + '\n' +
        reviewFilterModule.buildFilterStampLine(filterOutcome.stats);
    if (filterOutcome.dropped && filterOutcome.dropped.length > 0) {
        line += '\n' + reviewFilterModule.buildDroppedDigestLines(filterOutcome.dropped).join('\n');
    }
    if (filterOutcome.warning) line += '\n' + filterOutcome.warning;
    return line + '\n\n';
}

// ═══════════════ gh-1332 finding-identity registry ═══════════════
//
// The review-round dedup: this round's structured inlineComments already
// carry path/severity/claim, so registering the round mechanically (marker
// comment on the PR, same dmtools: marker family as the verdict record)
// costs no extra agent work. The next round's context prep injects the
// registry ("previously raised findings F1–Fn…"), so re-raised defects
// re-introduce their identity instead of minting duplicate threads.

/**
 * The registry claim is the REVIEWER's claim text. The gh-1053/gh-1334
 * demotion appends its confirm-note and provenance marker after a
 * '\n---\n' separator — machine annotation, not reviewer prose. Kept in
 * the claim it would dilute cross-round similarity (a cited re-raise of a
 * demoted finding could fall below the candidate bar — the amnesia loop
 * gh-1334 closes), so the machine-appended tail is stripped here.
 *
 * The cut is at the tail's exact head (reviewSpecClaims.DEMOTION_NOTE_HEAD,
 * joined by the '\n' separator downgradeBody uses) — never at the generic
 * '\n---\n' separator: a reviewer-authored claim that legitimately contains
 * a markdown horizontal rule would lose everything after the rule, and
 * cross-round similarity would run on truncated text.
 */
var DEMOTION_TAIL_SEPARATOR = '\n' + reviewSpecClaims.DEMOTION_NOTE_HEAD;

function registryClaimOf(claim) {
    var text = String(claim || '');
    var cut = text.indexOf(DEMOTION_TAIL_SEPARATOR);
    return cut === -1 ? text : text.substring(0, cut);
}

/**
 * The round's findings in registry input shape: file/claim/severity/line
 * from inlineComments, with the claim resolved through the same path the
 * poster uses (inline body or the referenced comment file). Findings without
 * a usable claim are skipped — an identity needs an assertable defect.
 * gh-1334: a demoted entry carries its provenance onto the finding so the
 * registry identity records it (re-elevation + escalation packets).
 */
function findingsFromReviewData(reviewData, ticketKey, workingDir) {
    var inline = reviewData && Array.isArray(reviewData.inlineComments) ? reviewData.inlineComments : [];
    var findings = [];
    inline.forEach(function(inlineComment) {
        var file = inlineTargetOf(inlineComment);
        var claim = registryClaimOf(resolveInlineComment(inlineComment, ticketKey, workingDir));
        if (!file || !claim || !String(claim).trim()) return;
        findings.push({
            file: file,
            claim: String(claim),
            severity: inlineComment.severity,
            line: inlineComment.line,
            demotion: inlineComment.demotion || null
        });
    });
    return findings;
}

/**
 * The reviewer's structured answer to the previous round's registry:
 * { dispositions: [{n, status: fixed|withdrawn|re-introduced, hunk?, reason?}],
 *   confirmations: [{proposedFor, same}] }. Absent or malformed → empty
 *   arrays (the registry treats silence as new, never as merge).
 */
function findingReviewOf(reviewData) {
    var block = reviewData && reviewData.findingReview;
    var out = { dispositions: [], confirmations: [] };
    if (!block || typeof block !== 'object') return out;
    if (Array.isArray(block.dispositions)) out.dispositions = block.dispositions;
    if (Array.isArray(block.confirmations)) out.confirmations = block.confirmations;
    return out;
}

/**
 * PR comments for the registry read. Returns null when the provider cannot
 * list comments (no getPrComments, read failure) — without a trusted
 * previous state the stamp is SKIPPED (fail-closed: a provider that cannot
 * list must not re-post round 1 every round). The shape ladder is the shared
 * normalizePrCommentList — the catch-and-null policy lives here.
 */
function prCommentsForRegistry(scm, prNumber) {
    if (!scm || typeof scm.getPrComments !== 'function') return null;
    try {
        return findingRegistry.normalizePrCommentList(scm.getPrComments(prNumber));
    } catch (e) {
        console.warn('finding-identity registry: comment read failed (non-fatal):', e.message || e);
        return null;
    }
}

function addFindingRoundLabel(scm, prNumber, label) {
    try {
        scm.addLabel(prNumber, label);
        console.log('✅ Added review-round label:', label);
    } catch (e) {
        console.warn('finding-identity registry: label add failed (non-fatal):', e.message || e);
    }
}

// The previous registry off the PR comments (an empty machine-logins list
// trusts nothing — fail-closed).
function previousRegistryOf(prComments, machineLogins) {
    return findingRegistry.latestRegistry(prComments || [], { authorLogins: machineLogins || [] });
}

function logRegistryRoundOutcome(outcome) {
    console.log('✅ Finding-identity registry advanced to round ' + outcome.round +
        ' (new: ' + outcome.newIdentities.length + ', auto-merged: ' + outcome.autoMerged.length +
        ', candidates: ' + outcome.candidates.length + ')');
}

/**
 * Applies one registry round (previous state from prComments, this round's
 * findings + the reviewer's dispositions/confirmations), posts the advanced
 * registry marker and the review-round-N label. Returns the outcome, or null
 * when the round was a no-op or the previous state was unavailable.
 */
function stampFindingRegistry(scm, prNumber, prComments, roundInput, policy, machineLogins) {
    if (prComments === null) {
        console.warn('finding-identity registry: PR comments unavailable — registry update skipped (non-fatal)');
        return null;
    }
    var previous = previousRegistryOf(prComments, machineLogins);
    var outcome = findingRegistry.applyRound(
        previous ? previous.registry : null, roundInput, policy || findingRegistry.resolveIdentityPolicy({}, null));
    if (!outcome) return null;
    var body = findingRegistry.buildRegistryComment(
        Object.assign(outcome.registry, { at: roundInput.at || new Date().toISOString() }));
    if (!body) return null;
    scm.addComment(prNumber, body);
    addFindingRoundLabel(scm, prNumber, findingRegistry.reviewRoundLabel(outcome.round));
    logRegistryRoundOutcome(outcome);
    return outcome;
}

/**
 * This round's registry input (findings + the reviewer's dispositions and
 * confirmations), or null when the review registered nothing at all.
 */
function findingRoundInputOf(ctx, reviewData) {
    var findings = findingsFromReviewData(reviewData, ctx.ticketKey, ctx.workingDir);
    var reviewBlock = findingReviewOf(reviewData);
    if (!findings.length && !reviewBlock.dispositions.length && !reviewBlock.confirmations.length) {
        return null;
    }
    return {
        at: new Date().toISOString(),
        findings: findings,
        dispositions: reviewBlock.dispositions,
        confirmations: reviewBlock.confirmations
    };
}

/**
 * The wired post-review step: collect this round's findings, read the
 * previous registry off the PR, advance it. Non-fatal end to end — a lost
 * registry round degrades to the old stateless behavior.
 */
function postFindingRegistryUpdate(ctx, pr, reviewData) {
    try {
        if (!pr || !pr.number) return null;
        var roundInput = findingRoundInputOf(ctx, reviewData);
        if (!roundInput) return null;
        var comments = prCommentsForRegistry(ctx.scm, pr.number);
        if (comments === null) return null;
        return stampFindingRegistry(ctx.scm, pr.number, comments, roundInput,
            findingRegistry.resolveIdentityPolicy(ctx.customParams, ctx.config),
            machineAuthorModule.machineAuthorLogins(ctx.machineAuthor));
    } catch (e) {
        console.warn('finding-identity registry update failed (non-fatal):', e.message || e);
        return null;
    }
}

/**
 * Post review results to the ticket (Jira/ADO/GitHub depending on the probed provider)
 * @param {Object} tracker - trackers.js provider instance
 * @param {string} ticketKey - Ticket key
 * @param {string} reviewContent - Review content (from outputs/response.md)
 * @param {Object} reviewData - Parsed pr_review.json data
 * @param {string} prUrl - PR URL for linking
 */
/** The outcome badge panel for the tracker comment (pure). */
function outcomeBadgePanel(m, recommendation) {
    if (recommendation === 'APPROVE') {
        return m.panel(null, '✅ ' + m.bold('APPROVED') + ' - AI review passed. Awaiting required reviewer approval to merge.', 'bgColor=#E3FCEF|borderColor=#00875A') + '\n\n';
    }
    if (recommendation === 'BLOCK') {
        return m.panel(null, '🚨 ' + m.bold('BLOCKED') + ' - Critical issues must be fixed before merge', 'bgColor=#FFEBE6|borderColor=#DE350B') + '\n\n';
    }
    return m.panel(null, '⚠️ ' + m.bold('CHANGES REQUESTED') + ' - Issues found, ticket returned to In Rework', 'bgColor=#FFF7E6|borderColor=#FF991F') + '\n\n';
}

/** The census summary lines — gh-1351: 🪶 nits + the ranked digest lines join. */
function censusSummaryLines(m, issueCounts) {
    return '* 🚨 Blocking Issues: ' + m.bold(String(issueCounts.blocking)) + '\n' +
        '* ⚠️ Important Issues: ' + m.bold(String(issueCounts.important)) + '\n' +
        '* 💡 Suggestions: ' + m.bold(String(issueCounts.suggestions)) + '\n' +
        '* 🪶 Nits: ' + m.bold(String(issueCounts.nits)) + '\n' +
        '* 📋 Digest lines: ' + m.bold(String(issueCounts.digest)) + '\n\n';
}

/**
 * gh-1351: the resolved reviewPolicy table stamped into the review summary
 * (this comment) so the rework leg and every human reader can trace the
 * verdict to the policy that produced it. '' when no policy rode the run.
 */
function policyStampSection(m, policy) {
    if (!policy || policy.source === undefined) return '';
    return m.h(3, 'Review Policy (' + String(policy.source) + (policy.preset ? ', preset ' + policy.preset : '') + ')') + '\n' +
        reviewPolicyModule.policyTableBody(policy) + '\n\n';
}

function postReviewToJira(tracker, ticketKey, reviewContent, reviewData, prUrl, policy, filterOutcome) {
    try {
        const m = commentMarkup.forTicket(ticketKey);
        let comment = m.h(2, '🔍 Automated PR Review Completed') + '\n\n';

        // Add outcome badge
        // Normalize: LLM sometimes returns "APPROVED" instead of "APPROVE"
        const recommendation = (reviewData.recommendation || reviewData.verdict || 'REQUEST_CHANGES').replace(/^APPROVED$/, 'APPROVE');
        comment += outcomeBadgePanel(m, recommendation);

        // Add issue summary (gh-1350: the normalized census — singular
        // `suggestion` spellings render, missing counts stay 0)
        const issueCounts = normalizeIssueCounts(reviewData);
        comment += m.h(3, 'Issue Summary') + '\n';
        comment += censusSummaryLines(m, issueCounts);
        comment += policyStampSection(m, policy);
        // gh-1403: the filter round summary + the dropped list (visible, one
        // line each — the anti-over-suppression listing rides the ticket too).
        comment += filterStampSection(m, filterOutcome);

        if (prUrl) {
            comment += m.h(3, 'Pull Request') + '\n';
            comment += m.link('View PR on GitHub', prUrl) + '\n\n';
        }

        comment += '----\n';
        comment += '_Generated by AI Code Reviewer with focus on security, code quality, and OOP principles_';

        tracker.postComment(ticketKey, comment);

        console.log('✅ Posted review results to ticket', ticketKey);

    } catch (error) {
        console.error('Failed to post review to tracker:', error);
    }
}

// ═══════════════ gh-926 pipeline: pure parse/decide/build helpers ═══════════════

function jobParamsOf(params) {
    return params.jobParams || params;
}

function folderKeyOf(inputFolderPath) {
    return String(orEmpty(String(orEmpty(inputFolderPath).split('/').pop())));
}

function parseFolderPRAnchor(inputFolderPath) {
    var anchorMatch = /^pr-(\d+)$/.exec(folderKeyOf(inputFolderPath));
    if (!anchorMatch) return null;
    return parseInt(anchorMatch[1], 10);
}

function firstPrNumberParam(jp) {
    return jp.prNumber || jp.pr;
}

function parseJobParamPRAnchor(jp) {
    return orNull(parseInt(firstPrNumberParam(jp), 10));
}

/**
 * PR-anchored runs (#687) key off the input folder name `pr-<n>`, falling
 * back to jobParams.prNumber / jobParams.pr. Null when the run is
 * ticket-anchored.
 */
function parsePRAnchor(params, jp) {
    return parseFolderPRAnchor(params.inputFolderPath) || parseJobParamPRAnchor(jp);
}

function resolveReviewTicketKey(params, prAnchor) {
    if (prAnchor) return 'pr-' + prAnchor;
    return params.ticket.key;
}

function matchPRNumber(prInfo, fallback) {
    var m = prInfo.match(/\*\*PR #\*\*:\s*(\d+)/);
    if (!m) return fallback;
    return parseInt(m[1], 10);
}

function matchPRUrl(prInfo, fallback) {
    var m = prInfo.match(/\*\*URL\*\*:\s*(https:\/\/[^\s]+)/);
    if (!m) return fallback;
    return m[1];
}

function matchPRBranch(prInfo, fallback) {
    var m = prInfo.match(/\*\*Branch\*\*:\s*([^\s\n]+)/);
    if (!m) return fallback;
    return m[1];
}

function authorFromPRInfo(prInfo) {
    var m = prInfo.match(/\*\*Author\*\*:\s*([^\s\n]+)/);
    if (!m) return null;
    return m[1];
}

function matchPRAuthor(prInfo, prAnchor) {
    if (!prAnchor) return null;
    return authorFromPRInfo(prInfo);
}

/**
 * Parse input/<key>/pr_info.md (written by writePRContext). Misses carry the
 * current values forward — parsed fields only overwrite on a match. The
 * Author line decides whether an approve may arm the machine merge pipeline
 * and is only read for PR-anchored runs.
 */
function parsePRInfoMarkdown(prInfo, prAnchor, current) {
    if (!prInfo) return current;
    return {
        prNumber: matchPRNumber(prInfo, current.prNumber),
        prUrl: matchPRUrl(prInfo, current.prUrl),
        prBranch: matchPRBranch(prInfo, current.prBranch),
        prAuthor: matchPRAuthor(prInfo, prAnchor)
    };
}

function normalizeRecommendation(reviewData) {
    // Normalize: LLM sometimes returns "APPROVED" instead of "APPROVE"
    return (reviewData.recommendation || reviewData.verdict || 'REQUEST_CHANGES').replace(/^APPROVED$/, 'APPROVE');
}

// The advisory token exactly as the model emitted it (pre-cross-check,
// pre-machine-recomputation) — carried on the result for auditability.
function advisoryTokenOf(reviewData) {
    return normalizeRecommendation(reviewData);
}

// gh-1350 census normalization: the agent sometimes emits the singular
// `suggestion` spelling — both spellings are the same census (the plural
// wins when both are present). `nits` and `digest` ride the normalized
// shape from here on (the NIT severity enum itself lands in part 2 — this
// is the census plumbing only). Counts normalize through the verdict
// module's censusCount (Number() || 0).
function suggestionsCensusOf(counts) {
    if (counts.suggestions === undefined || counts.suggestions === null) return counts.suggestion;
    return counts.suggestions;
}

function normalizeIssueCounts(reviewData) {
    var counts = (reviewData && reviewData.issueCounts) || {};
    return {
        blocking: reviewVerdicts.censusCount(counts.blocking),
        important: reviewVerdicts.censusCount(counts.important),
        suggestions: reviewVerdicts.censusCount(suggestionsCensusOf(counts)),
        nits: reviewVerdicts.censusCount(counts.nits),
        digest: reviewVerdicts.censusCount(counts.digest)
    };
}

function positiveCount(value) {
    return (value || 0) > 0;
}

function hasAnyOpenIssue(issueCounts) {
    var counts = issueCounts || {};
    // gh-1350: the singular `suggestion` spelling is the same census.
    // nits/digest deliberately do NOT open issues yet — the NIT enum and
    // the policy config land in parts 2-4 (no behavior flip in this step).
    return positiveCount(counts.blocking) ||
        positiveCount(counts.important) ||
        positiveCount(counts.suggestions) ||
        positiveCount(counts.suggestion);
}

// ── gh-1350 census cross-check (review_verdict_rules.md enforcement) ────────
//
// The rules promise: "The machine also cross-checks the counter against
// your inline comments ... before honoring a blocking-0 approval." Nothing
// enforced it — an agent could post a 🚨 BLOCKING thread while reporting
// `issueCounts.blocking: 0` and the approval flowed through. The posted
// severity IS the structured JSON field (machine-stamped since this step),
// so the cross-check reads `inlineComments[].severity` only — free-form
// comment prose is never the protocol (same doctrine as the verdict
// records).

function severityIsBlocking(severity) {
    return String(severity || '').trim().toUpperCase() === 'BLOCKING';
}

function postedBlockingSeverity(reviewData) {
    var inline = reviewData && Array.isArray(reviewData.inlineComments) ? reviewData.inlineComments : [];
    for (var i = 0; i < inline.length; i++) {
        if (severityIsBlocking((inline[i] || {}).severity)) return true;
    }
    return false;
}

function unchangedVerdict(recommendation) {
    return { recommendation: recommendation, overridden: false };
}

/**
 * The census cross-check (pure): any posted inline severity BLOCKING with
 * `issueCounts.blocking == 0` overrides an approving verdict to
 * REQUEST_CHANGES. A census that already counts the thread, a
 * non-approving verdict, and reviews without posted BLOCKING severities
 * pass through unchanged. The returned corrected census bumps `blocking` to
 * 1 when the override fires — the gh-1351 machine recomputation reads the
 * CORRECTED census (posted evidence outranks a lying counter), so the
 * cross-check cannot be nullified by a census-clean recomputation.
 */
/** The census copy the machine recomputation reads: posted evidence bumps blocking to ≥ 1. */
function correctedCensusOf(issueCounts) {
    var corrected = {};
    var source = issueCounts || {};
    for (var key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key)) corrected[key] = source[key];
    }
    corrected.blocking = Math.max(reviewVerdicts.censusCount(source.blocking), 1);
    return corrected;
}

function censusCrossCheckOverride(reviewData, recommendation, issueCounts) {
    if (!postedBlockingSeverity(reviewData)) return unchangedVerdict(recommendation);
    if (reviewVerdicts.censusCount(issueCounts && issueCounts.blocking) > 0) return unchangedVerdict(recommendation);
    if (recommendation !== 'APPROVE') return unchangedVerdict(recommendation);
    return { recommendation: 'REQUEST_CHANGES', overridden: true, issueCounts: correctedCensusOf(issueCounts) };
}

function buildCensusCrossCheckWarning(issueCounts) {
    return '🚨 Census cross-check (gh-1350): a posted inline comment carries severity BLOCKING ' +
        'but issueCounts.blocking=' + orZero(issueCounts && issueCounts.blocking) +
        ' — overriding the verdict to REQUEST_CHANGES. Keep issueCounts accurate: ' +
        'it is the machine source of truth, not prose.';
}

function hasAllowApproveWithSuggestions(customParams) {
    return !!(customParams && customParams.allowApproveWithSuggestions === true);
}

/**
 * The verdict gate (gh-1351): do any approval-gating threads remain? Under
 * the resolved policy that is every tier whose round is `rework` — the
 * default preset: any 🚨 BLOCKING or ⚠️ IMPORTANT open.
 */
function hasBlockingOrImportant(issueCounts, policy) {
    return reviewPolicyModule.hasBlockingOrImportant(issueCounts, policy);
}

/**
 * The machine approval recomputation (gh-1351): the advisory token in, the
 * EFFECTIVE decision out — computed from the severity census + the resolved
 * policy. Delegates to the pure policy module.
 */
function machineApprovalFromCensus(recommendation, issueCounts, policy) {
    return reviewPolicyModule.machineApprovalDecision(recommendation, issueCounts, policy);
}

/**
 * The machine-enforcement audit line for a recomputed verdict (the model is
 * advisory, the machine enforces).
 */
function buildMachineVerdictLog(machine, recommendation) {
    return '⚖️ Machine enforcement (gh-1351): advisory ' + recommendation +
        ' → effective ' + machine.verdict + ' — ' + machine.reason;
}

/**
 * The effective approval decision: the agent's APPROVE verdict stands unless
 * open issues override it — allowApproveWithSuggestions or the thread-limit
 * safety valve re-enable it.
 */
function decideApproval(recommendation, hasOpenIssues, allowApproveWithSuggestions, forceApproveDueToThreadLimit) {
    return recommendation === 'APPROVE' &&
        (!hasOpenIssues || allowApproveWithSuggestions || forceApproveDueToThreadLimit);
}

function verdictNeedsIssueOverride(recommendation, hasOpenIssues, allowApproveWithSuggestions) {
    return recommendation === 'APPROVE' && hasOpenIssues && !allowApproveWithSuggestions;
}

function isApprovalOverridden(recommendation, hasOpenIssues, allowApproveWithSuggestions, forceApproveDueToThreadLimit) {
    return verdictNeedsIssueOverride(recommendation, hasOpenIssues, allowApproveWithSuggestions) &&
        !forceApproveDueToThreadLimit;
}

function buildApprovalOverrideWarning(issueCounts) {
    return '⚠️ Agent returned APPROVE but there are open issues ' +
        '(blocking=' + issueCounts.blocking + ', important=' + issueCounts.important +
        ', suggestions=' + issueCounts.suggestions + '). ' +
        'Overriding to REQUEST_CHANGES. Set allowApproveWithSuggestions=true in customParams to allow.';
}

// gh-1351: the legacy thread-limit force-approve machinery
// (threadLimitConfigured / shouldProbeThreadLimit / threadCountExceedsLimit /
// probeThreadLimitOverride / maxThreadLimitOf) is GONE — machine enforcement
// recomputes the verdict from the census + resolved policy, and the
// `maxReviewThreadsBeforeForceApprove` knob is rejected alongside the policy
// (reviewPolicyModule.legacyKnobAudit). Thread budgets are policy bounds
// (bounds.densityMax / bounds.polishMaxThreads), never a force-approve valve.

/**
 * Formal GitHub review resolution chain (first explicit win):
 *   1. agent customParams.formalGithubReview (true/false, per run)
 *   2. project .dmtools/config.js formalGithubReview (project default)
 *   3. false (off — historical behavior)
 */
function resolveFormalReviewEnabled(customParams, config) {
    if (customParams && typeof customParams.formalGithubReview === 'boolean') {
        return customParams.formalGithubReview;
    }
    return !!(config && config.formalGithubReview === true);
}

function parseLinkedIssueNumber(prBody) {
    // gh-728: the knob is a comma-separated LIST of machine logins — the
    // linked-issue lookup only needs the trailing "closes #N" reference.
    var m = /(?:closes|fixes|resolves)\s+#(\d+)/i.exec(String(orEmpty(prBody)));
    if (!m) return null;
    return parseInt(m[1], 10);
}

function resolveWipLabel(params) {
    var contextId = params.metadata && params.metadata.contextId;
    if (!contextId) return 'pr_review_wip';
    return contextId + '_wip';
}

function buildBitriseEnvVars(bitriseBuild, ticketKey, prUrl) {
    var envVars = (bitriseBuild.envVars || []).slice();
    // Always pass the ticket key so the build can reference it
    envVars.push({ mapped_to: 'TICKET_KEY', value: ticketKey, is_expand: false });
    if (prUrl) {
        envVars.push({ mapped_to: 'PR_URL', value: prUrl, is_expand: false });
    }
    return envVars;
}

function resolveBitriseBranch(bitriseBuild, prBranch) {
    if (prBranch) return prBranch;
    return bitriseBuild.branch || 'develop';
}

function aiRepoConfigOf(customParams) {
    if (!customParams) return null;
    return customParams.aiRepository;
}

function repoOwnerFallback(cfgOwner, repository) {
    if (cfgOwner) return cfgOwner;
    return repoOwnerOf(repository);
}

function repoRepoFallback(cfgRepo, repository) {
    if (cfgRepo) return cfgRepo;
    return repoNameOf(repository);
}

function resolveTestCasesGeneratorRepo(customParams, config) {
    var aiRepoCfg = aiRepoConfigOf(customParams);
    return {
        owner: repoOwnerFallback(aiRepoCfg && aiRepoCfg.owner, config.repository),
        repo: repoRepoFallback(aiRepoCfg && aiRepoCfg.repo, config.repository)
    };
}

function scmProviderOf(config) {
    return (config && config.scm && config.scm.provider) || 'github';
}

// ═══════════════ gh-926 pipeline: single-purpose side-effect steps ═══════════════

function truthyRepoFields(repository) {
    if (!repository.owner) return false;
    return !!repository.repo;
}

function truthyRepo(repository) {
    if (!repository) return false;
    return truthyRepoFields(repository);
}

function repoInfoFromConfig(repository) {
    if (!truthyRepo(repository)) return null;
    return { owner: repository.owner, repo: repository.repo };
}

function repoOwnerOf(repository) {
    if (!repository) return undefined;
    return repository.owner;
}

function repoNameOf(repository) {
    if (!repository) return undefined;
    return repository.repo;
}

function resolveRepoInfo(config, scm) {
    var fromConfig = repoInfoFromConfig(config.repository);
    if (fromConfig) {
        console.log('Using targetRepository from config:', fromConfig.owner + '/' + fromConfig.repo);
        return fromConfig;
    }
    return scm.getRemoteRepoInfo();
}

function readFolderPRInfo(inputFolder) {
    try {
        return file_read({
            path: inputFolder + '/pr_info.md'
        }) || null;
    } catch (error) {
        return null;
    }
}

// The ticket-context files the spec-claim verification matches against
// (gh-1334) — the ticket text the review run already has in input/.
var TICKET_CLAIM_FILES = ['ticket.md', 'request.md'];

function readInputFileOrNull(path) {
    try {
        var content = file_read({ path: path });
        return (content && String(content).trim()) ? String(content) : null;
    } catch (e) {
        return null;
    }
}

/**
 * gh-1334: the ticket text an uncited spec claim is verified against — the
 * first non-empty ticket.md/request.md along the input-folder candidate
 * chain (the runtime-passed folder, the Java-derived name, the legacy
 * input/<ticketKey>). Null when the run has no ticket text: verification
 * degrades to inconclusive and the demotion behaves exactly as before
 * (never demote harder than today).
 */
function readTicketClaimSource(inputFolderPath, ticketKey) {
    var folders = ticketKeyShapes.inputFolderCandidates(inputFolderPath, ticketKey);
    for (var f = 0; f < TICKET_CLAIM_FILES.length; f++) {
        for (var i = 0; i < folders.length; i++) {
            var text = readInputFileOrNull(folders[i] + '/' + TICKET_CLAIM_FILES[f]);
            if (text) return { file: TICKET_CLAIM_FILES[f], text: text };
        }
    }
    return null;
}

// First pr_info.md along the folder chain: the folder the runtime passed, the Java runtime's
// input/<inputFolderNameFor(key)>, then the legacy input/<ticketKey> (Dart and older runtimes).
function readPRInfoMarkdown(inputFolderPath, ticketKey) {
    var candidates = ticketKeyShapes.inputFolderCandidates(inputFolderPath, ticketKey);
    for (var i = 0; i < candidates.length; i++) {
        var prInfo = readFolderPRInfo(candidates[i]);
        if (prInfo) return prInfo;
    }
    console.warn('Could not read PR info from any input folder: ' + candidates.join(', '));
    return null;
}

function applyPRInfoMarkdown(prInfo, prAnchor, pr) {
    if (!prInfo) return false;
    var parsed = parsePRInfoMarkdown(prInfo, prAnchor, {
        prNumber: pr.number,
        prUrl: pr.url,
        prBranch: pr.branch,
        prAuthor: pr.author
    });
    pr.number = parsed.prNumber;
    pr.url = parsed.prUrl;
    pr.branch = parsed.prBranch;
    pr.author = parsed.prAuthor;
    console.log('Found PR info in input folder: #' + pr.number);
    return true;
}

function prHeadRef(head) {
    if (!head) return null;
    return orNull(head.ref);
}

function prHeadRefOf(pr) {
    if (!pr) return null;
    return prHeadRef(pr.head);
}

function prSearchOptionsOf(config) {
    if (!config.prSearchFn) return {};
    return { prSearchFn: config.prSearchFn };
}

function needsPRSearch(prNumber, repoInfo) {
    return !prNumber && !!repoInfo;
}

function needsNoSearchWarning(prNumber, repoInfo) {
    return !prNumber && !repoInfo;
}

function findPRViaSearch(scm, ticketKey, prSearchOptions) {
    var pr = gh.findPRForTicket(scm, ticketKey, prSearchOptions);
    if (!pr) {
        console.warn('Could not find PR for ticket', ticketKey);
        return null;
    }
    console.log('Found PR via GitHub search: #' + pr.number);
    return pr;
}

function warnIfUnsearchable(prNumber, repoInfo) {
    if (needsNoSearchWarning(prNumber, repoInfo)) {
        console.warn('PR number not found and cannot search without repo info');
    }
}

function applyFoundPR(pr, found) {
    if (!found) return;
    pr.number = found.number;
    pr.url = found.html_url;
    pr.branch = prHeadRefOf(found);
}

function searchMissingPRNumber(scm, config, ticketKey, pr, repoInfo) {
    if (!needsPRSearch(pr.number, repoInfo)) {
        warnIfUnsearchable(pr.number, repoInfo);
        return;
    }
    console.log('PR number not found in input folder, searching GitHub...');
    applyFoundPR(pr, findPRViaSearch(scm, ticketKey, prSearchOptionsOf(config)));
}

/**
 * Step 2: resolve the review target — repo info (config targetRepository
 * preferred over git remote), PR number from the pr-<n> anchor / pr_info.md,
 * with a GitHub search fallback.
 */
function discoverPullRequest(params, ctx) {
    var repoInfo = resolveRepoInfo(ctx.config, ctx.scm);
    if (!repoInfo) {
        console.warn('Could not get GitHub repo info - skipping GitHub comments');
    }
    var pr = { number: ctx.prAnchor, url: null, branch: null, author: null };
    applyPRInfoMarkdown(readPRInfoMarkdown(params.inputFolderPath, ctx.ticketKey), ctx.prAnchor, pr);
    searchMissingPRNumber(ctx.scm, ctx.config, ctx.ticketKey, pr, repoInfo);
    return { repoInfo: repoInfo, pr: pr };
}

function readOrResumeReviewData(ticketKey, workingDir) {
    var reviewData = readReviewJson(ticketKey, workingDir);
    if (reviewData) return reviewData;
    attemptResumeIfReviewOutputsMissing(ticketKey);
    return readReviewJson(ticketKey, workingDir);
}

/**
 * gh-1053: downgrade BLOCKING findings whose core claim is an uncited
 * external-spec assertion BEFORE anything derives verdicts, census, or
 * posted bodies from the review data (see js/common/reviewSpecClaims.js).
 * gh-1334: the demotion path first verifies the claim against the ticket
 * text the review run already has (input/<folder>/ticket.md, falling back
 * to request.md along the input-folder candidate chain) — a verifiably
 * present requirement keeps BLOCKING force with the citation auto-appended;
 * every remaining demotion stamps the provenance marker.
 * File-referenced comment bodies are rewritten via writeFile so the posted
 * thread no longer carries the 🚨 marker; every downgrade is logged.
 */
function applySpecClaimDowngrades(reviewData, ticketKey, workingDir, inputFolderPath) {
    try {
        var ticketSource = readTicketClaimSource(inputFolderPath, ticketKey);
        var opts = ticketSource ? { ticketText: ticketSource.text, ticketFile: ticketSource.file } : {};
        var result = reviewSpecClaims.sanitizeReviewData(reviewData, function (path) {
            return readMarkdownFile(path, ticketKey, workingDir);
        }, opts);
        result.rewrites.forEach(function (rw) {
            writeFile(rw.path, rw.content);
        });
        result.citations.forEach(function (citation) {
            console.log('✅ gh-1334 spec-claim verified against the ticket: ' + citation.path +
                ' kept BLOCKING, citation auto-appended (' + citation.citation + ')');
        });
        result.notes.forEach(function (note) {
            console.warn('⚠️ gh-1053 spec-claim guard:', note);
        });
        return result;
    } catch (e) {
        console.warn('⚠️ gh-1053 spec-claim guard failed (continuing un-sanitized):', e.message || e);
        return { downgrades: 0, notes: [], rewrites: [], demotions: [], citations: [] };
    }
}

function hasGitHubTarget(pr, repoInfo) {
    return !!(pr.number && repoInfo);
}

/**
 * gh-1351 machine-side density audit (epic §4.6): the posted 💡/🪶 thread
 * census vs `allowed = clamp(round(2 + 3*sqrt(additions/200)), 2, 8)`.
 * The reviewer ranks and posts top-K, the overflow rides the digest list —
 * the machine only AUDITS (warn), it never fails the leg. Skipped when the
 * PR object probe carried no additions count (unknown diff size must not
 * false-warn).
 */
function auditDensityAgainstPolicy(issueCounts, prObj, policy) {
    try {
        var additions = prAdditionsOf(prObj);
        if (additions === null) return null;
        var bounds = policy && policy.bounds;
        var audit = reviewPolicyModule.densityAudit(issueCounts, additions, bounds);
        if (audit.warning) console.warn(audit.warning);
        return audit;
    } catch (e) {
        console.warn('density audit failed (non-fatal):', e.message || e);
        return null;
    }
}

function postGeneralCommentIfPresent(ctx, pr, reviewData) {
    if (!reviewData.generalComment) return;
    postGeneralComment(ctx.scm, pr.number, reviewData.generalComment, ctx.ticketKey, ctx.workingDir);
}

function hasInlineComments(reviewData) {
    return !!(reviewData.inlineComments && Array.isArray(reviewData.inlineComments) && reviewData.inlineComments.length > 0);
}

function postInlineCommentsIfPresent(ctx, pr, reviewData) {
    if (!hasInlineComments(reviewData)) return;
    console.log('Posting ' + reviewData.inlineComments.length + ' inline comments');

    reviewData.inlineComments.forEach(function(inlineComment, index) {
        console.log('Processing inline comment ' + (index + 1) + '/' + reviewData.inlineComments.length);
        postInlineComment(ctx.scm, pr.number, inlineComment, ctx.ticketKey, ctx.workingDir);
    });
}

function addPRLabelQuietly(scm, prNumber, label, okMessage, warnPrefix) {
    try {
        scm.addLabel(prNumber, label);
        console.log(okMessage);
    } catch (labelErr) {
        console.warn(warnPrefix, labelErr);
    }
}

function addPRLabelQuietlyDetailed(scm, prNumber, label, warnPrefix) {
    try {
        scm.addLabel(prNumber, label);
    } catch (prLabelError) {
        console.warn(warnPrefix, prLabelError.message || prLabelError);
    }
}

function removePRLabelQuietly(scm, prNumber, label, warnMessage) {
    try {
        scm.removeLabel(prNumber, label);
    } catch (e2) {
        console.warn(warnMessage);
    }
}

function applyPRApprovalOutcome(ctx, pr, isApproved, recommendation) {
    if (!isApproved) {
        // STATE 2: REQUEST_CHANGES / BLOCK → do NOT merge
        console.log('PR has issues (' + recommendation + ') - will NOT merge, returning ticket to In Development');
        return;
    }
    // STATE 1: APPROVE → label PR and Jira ticket; SM will retry merge when CI passes.
    // Owner rule: auto-APPROVE applies to EXTERNAL PRs too —
    // pr_approved arms the SM merge pipeline (validate → merge)
    // for any author. Only auto-REWORK stays machine-author-gated
    // (the re-arm in finishPRAnchoredReview).
    addPRLabelQuietly(ctx.scm, pr.number, LABELS.PR_APPROVED,
        '✅ Added pr_approved label to GitHub PR #' + pr.number,
        'Failed to add pr_approved label to GitHub PR:');
}

function applyFormalReviewIfEnabled(ctx, pr, reviewData, isApproved, recommendation) {
    if (!resolveFormalReviewEnabled(ctx.customParams, ctx.config)) return;
    applyFormalGithubReview(ctx.scm, pr.number, isApproved, recommendation, reviewData.generalComment, ctx.ticketKey, ctx.workingDir);
}

/**
 * Step 4/5: post all comments to the GitHub PR (always, regardless of
 * outcome), then apply the two-state outcome (pr_approved label vs
 * will-not-merge) and the opt-in formal review.
 */
function postGitHubReview(ctx, pr, repoInfo, reviewData, isApproved, recommendation, issueCounts) {
    if (!hasGitHubTarget(pr, repoInfo)) {
        console.warn('No PR number or repo info - skipping GitHub comments and merge');
        return;
    }
    console.log('Posting review to GitHub PR #' + pr.number + ' (recommendation: ' + recommendation + ')');

    // Post general comment
    postGeneralCommentIfPresent(ctx, pr, reviewData);

    // Post inline comments
    postInlineCommentsIfPresent(ctx, pr, reviewData);

    // Resolve threads that were fully fixed in this rework
    resolveApprovedThreads(ctx.scm, pr.number, reviewData.resolvedThreadIds);

    console.log('✅ Posted all review comments to GitHub PR');

    // gh-807 verdict persistence: the machine-parseable record
    // (head sha + effective verdict + census) the tick reconciles
    // per head — see js/common/reviewVerdicts.js. Returns the probed
    // PR object (null when the probe failed) for the density audit.
    var prObj = postVerdictRecord(ctx.scm, repoInfo, pr.number, isApproved, recommendation, issueCounts, scmProviderOf(ctx.config));

    // gh-1351 machine density audit (§4.6): posted 💡/🪶 threads vs the
    // policy cap for the diff size — warn-only, never fails the leg.
    auditDensityAgainstPolicy(issueCounts, prObj, ctx.reviewPolicy);

    // gh-1332 finding-identity registry: the round's findings are registered
    // mechanically against the previous rounds (dedup across review legs).
    postFindingRegistryUpdate(ctx, pr, reviewData);

    // Step 5: Two-state outcome
    applyPRApprovalOutcome(ctx, pr, isApproved, recommendation);

    // Opt-in: formal review decision (Approve / Request Changes via the
    // real Review API), independent of the pr_approved label logic above.
    applyFormalReviewIfEnabled(ctx, pr, reviewData, isApproved, recommendation);
}

function fetchPullRequestObject(repoInfo, prNumber) {
    var prRaw = github_get_pr({
        workspace: repoInfo.owner, repository: repoInfo.repo, pullRequestId: prNumber
    });
    return typeof prRaw === 'string' ? JSON.parse(prRaw) : (prRaw || {});
}

// gh-1369: fresh terminal-PR probe for the review-leg rework arms. The PR
// was matched via an OPEN-PR search at leg start — a leg in flight at merge
// time (#1368: merged 48s before its stamp) must not stamp agent:rework on
// shipped code. The probe re-reads github_get_pr at ARM time. Fail-open: a
// missing repo/PR number, a legacy bridge without the tool, or a failed
// read is NOT terminal — the legacy arm semantics keep firing.
function prIsTerminal(repoInfo, prNumber) {
    try {
        if (!repoInfo || !prNumber || typeof github_get_pr !== 'function') return false;
        var prObj = fetchPullRequestObject(repoInfo, prNumber);
        return prTerminalStateModule.isTerminalPrState(prObj.state, prObj.merged);
    } catch (e) {
        console.warn('⚠️ terminal-PR probe failed (fail-open): ' + (e.message || e));
        return false;
    }
}

function parseBranchIssueNumber(branch) {
    var m = /(^|[^a-z0-9])gh-0*(\d+)([^0-9]|$)/i.exec(String(orEmpty(branch)));
    return m ? parseInt(m[2], 10) : null;
}

function linkedIssueNumberFromPR(repoInfo, prNumber, prBranch) {
    var prObj = fetchPullRequestObject(repoInfo, prNumber);
    var fromBody = parseLinkedIssueNumber(prObj.body);
    if (fromBody) return fromBody;
    var headRef = prObj.head && (prObj.head.ref || prObj.head);
    return parseBranchIssueNumber(headRef) || parseBranchIssueNumber(prBranch);
}

function stripLinkedIssueArmLabels(scm, linkedIssue, isApproved) {
    if (!linkedIssue) return;
    removePRLabelQuietly(scm, linkedIssue, 'agent:review', 'No agent:review label to remove from issue #' + linkedIssue);
    if (isApproved) {
        removePRLabelQuietly(scm, linkedIssue, 'agent:rework', 'No agent:rework label to remove from issue #' + linkedIssue);
    }
}

function rearmReworkOnLinkedIssue(ctx, pr, repoInfo) {
    try {
        var linkedIssue = linkedIssueNumberFromPR(repoInfo, pr.number, pr.branch);
        if (linkedIssue) {
            stripLinkedIssueArmLabels(ctx.scm, linkedIssue, false);
            ctx.scm.addLabel(linkedIssue, 'agent:rework');
            console.log('Re-armed agent:rework on linked issue #' + linkedIssue);
        }
    } catch (e3) {
        console.warn('Linked-issue rework re-arm failed:', e3.message || e3);
    }
}

function rearmLinkedIssueRework(ctx, pr, repoInfo) {
    // Machine-authored: re-arm the rework loop on the linked
    // issue; external: the verdict comment is the whole report.
    // gh-728: the knob is a comma-separated LIST of machine
    // logins — a direct single-login compare here stranded
    // github-actions[bot] PRs as guests forever (live fa PR
    // #1249).
    if (!machineAuthorModule.isMachineAuthored({ author: pr.author }, ctx.machineAuthor, repoOwnerOf(repoInfo))) return;
    rearmReworkOnLinkedIssue(ctx, pr, repoInfo);
}

function cleanLinkedIssueArmsOnApproval(ctx, pr, repoInfo) {
    if (!machineAuthorModule.isMachineAuthored({ author: pr.author }, ctx.machineAuthor, repoOwnerOf(repoInfo))) return;
    try {
        stripLinkedIssueArmLabels(ctx.scm, linkedIssueNumberFromPR(repoInfo, pr.number, pr.branch), true);
    } catch (e) {
        console.warn('Linked-issue approval cleanup failed:', e.message || e);
    }
}

/**
 * ── PR-anchored runs end here (#687): verdict + labels live on the
 * PR; the ticket-side steps below (tracker statuses/labels, ticket
 * comments) assume a hydrated ticket this run does not have.
 */
function finishPRAnchoredReview(ctx, pr, repoInfo, isApproved, recommendation) {
    addPRLabelQuietlyDetailed(ctx.scm, pr.number, LABELS.AI_PR_REVIEWED,
        'Failed to add ai_pr_reviewed to PR #' + pr.number + ':');
    // Consume the on-demand trigger so the label never loops.
    removePRLabelQuietly(ctx.scm, pr.number, 'agent:review', 'No agent:review label to remove from PR #' + pr.number);
    if (!isApproved) {
        // gh-1369: a review leg in flight at merge time concluding
        // REQUEST_CHANGES must not re-arm agent:rework on the now-terminal
        // PR's linked issue (the rework-on-label dispatch would hit shipped
        // code). Fail-open: an unknown state keeps the legacy re-arm.
        if (prIsTerminal(repoInfo, pr.number)) {
            console.log('⏭️ PR #' + pr.number + ' is merged/closed (gh-1369) — linked-issue ' +
                'agent:rework re-arm skipped: nothing to rework on shipped code');
        } else {
            rearmLinkedIssueRework(ctx, pr, repoInfo);
        }
    } else {
        cleanLinkedIssueArmsOnApproval(ctx, pr, repoInfo);
    }
    console.log('✅ PR-anchored review complete — PR #' + pr.number + ' (' + recommendation + ')');
    return { success: true, prNumber: pr.number, recommendation: recommendation };
}

function approveTicketForMerge(tracker, ticketKey) {
    // Approved → add pr_approved label to the ticket and stay in In Review for SM retry-merge
    tracker.addLabel(ticketKey, LABELS.PR_APPROVED);
    console.log('✅ Added pr_approved label to ticket — SM will retry merge');
}

function moveTicketToRework(tracker, ticketKey, statuses) {
    // Has issues, and there is an actual PR to rework → move to In Rework for focused fixes
    // agents#890: an ADO process may have no "In Rework" state; with stageFallback 'label' the
    // stage is recorded as a label instead of being lost (default 'none' = same as moveToStatus).
    var reworkMove = tracker.moveToStatusOrMark(ticketKey, statuses.IN_REWORK, 'IN_REWORK');
    console.log(reworkMove.moved ? '✅ Ticket moved to ' + statuses.IN_REWORK
        : '⚠️ Ticket could not move to ' + statuses.IN_REWORK + '; marked with label ' + reworkMove.label);
}

function unattachedReviewComment(ticketKey, inReworkStatus) {
    return commentMarkup.forTicket(ticketKey).h(3, '⚠️ PR Review Could Not Be Attached') + '\n\n' +
        'The review analysis completed, but no open Pull Request could be matched to this ticket. ' +
        'The ticket status was left unchanged (not moved to ' + inReworkStatus + ') since there is no PR to rework.';
}

function reportUnattachedReview(tracker, ticketKey, statuses) {
    try {
        tracker.postComment(ticketKey, unattachedReviewComment(ticketKey, statuses.IN_REWORK));
    } catch (commentError) {
        console.warn('Could not post PR-review-could-not-be-attached comment:', commentError);
    }
    console.warn('⚠️ No PR found for', ticketKey, '— leaving ticket status unchanged');
}

function applyReworkOrNoPROutcome(tracker, ticketKey, statuses, pr, repoInfo) {
    if (!hasGitHubTarget(pr, repoInfo)) {
        // Has issues, but no PR was ever matched to this ticket — moving to In Rework
        // would start a rework cycle with nothing to rework. Leave the status alone
        // and surface this explicitly instead of silently transitioning the ticket.
        reportUnattachedReview(tracker, ticketKey, statuses);
        return;
    }
    moveTicketToRework(tracker, ticketKey, statuses);
}

function applyTicketOutcomeInner(tracker, ticketKey, statuses, isApproved, pr, repoInfo) {
    if (isApproved) {
        approveTicketForMerge(tracker, ticketKey);
        return;
    }
    applyReworkOrNoPROutcome(tracker, ticketKey, statuses, pr, repoInfo);
}

/**
 * Step 7: Update ticket status based on outcome.
 */
function applyTicketOutcome(tracker, ticketKey, statuses, isApproved, pr, repoInfo) {
    try {
        applyTicketOutcomeInner(tracker, ticketKey, statuses, isApproved, pr, repoInfo);
    } catch (statusError) {
        console.warn('Could not update ticket status/label:', statusError);
    }
}

function addTicketAiPrReviewedLabel(tracker, ticketKey) {
    try {
        tracker.addLabel(ticketKey, LABELS.AI_PR_REVIEWED);
    } catch (error) {
        console.warn('Failed to add ai_pr_reviewed label:', error);
    }
}

/**
 * Step 8: add the review label on the ticket AND on the PR — the SM's
 * review-after-dev rule reads notPrLabels on the PR (#750 pathology): an
 * issue-anchored review that only labels the ticket leaves the PR unmarked
 * and the rule re-dispatches a review every tick on the same unchanged head.
 */
function addReviewMarkers(ctx, ticketKey, pr, repoInfo) {
    addTicketAiPrReviewedLabel(ctx.tracker, ticketKey);
    if (!hasGitHubTarget(pr, repoInfo)) return;
    addPRLabelQuietlyDetailed(ctx.scm, pr.number, LABELS.AI_PR_REVIEWED,
        'Failed to add ai_pr_reviewed to PR #' + pr.number + ':');
}

function removeWipLabel(tracker, ticketKey, wipLabel) {
    try {
        tracker.removeLabel(ticketKey, wipLabel);
        console.log('Removed WIP label:', wipLabel);
    } catch (error) {
        console.warn('Failed to remove WIP label:', error);
    }
}

function removeSmLabelIfConfigured(tracker, ticketKey, customParams) {
    var removeLabel = customParams && customParams.removeLabel;
    if (!removeLabel) return;
    try {
        tracker.removeLabel(ticketKey, removeLabel);
        console.log('✅ Removed SM label:', removeLabel);
    } catch (e) {}
}

function assignBackToInitiator(tracker, ticketKey, initiator) {
    try {
        if (!initiator) return;
        tracker.assignTo(ticketKey, initiator);
        console.log('✅ Assigned ticket back to initiator');
    } catch (error) {
        console.warn('Failed to assign ticket:', error);
    }
}

function autoStartReworkConfigured(customParams) {
    return !!(customParams && customParams.autoStartRework && customParams.autoStartReworkConfigFile);
}

function triggerConfiguredRework(ctx) {
    try {
        return autoStart.triggerConfiguredWorkflowForTicket({
            ticketKey: ctx.ticketKey,
            customParams: ctx.customParams,
            config: ctx.config,
            configFile: ctx.customParams.autoStartReworkConfigFile,
            label: 'pr_rework',
            scm: ctx.scm,
            stripKeys: [
                'removeLabel',
                'autoStartRework',
                'autoStartReworkConfigFile'
            ]
        });
    } catch (e) {
        console.warn('⚠️ autoStartRework trigger failed:', e.message || e);
        return false;
    }
}

// Jira review<->rework loop cap (live: 22 alternating review/rework runs on one Jira ticket, every
// rework resolved all threads and each new review found fresh suggestions).
// Each auto-started rework stamps rework-round-N on the ticket AFTER the
// configured workflow is actually triggered (so transient trigger skips like
// global workflow cap or an active duplicate run do not consume rounds);
// once maxAutoReworkRounds (default 3) rounds are spent the ticket gets
// needs-human and no further rework is chained. Removing the labels is a
// human decision that resets the budget.
var reworkRoundOf = countReworkRounds;

function startConfiguredRework(ctx, params) {
    if (!autoStartReworkConfigured(ctx.customParams)) return false;
    // Skip if ticket already has pr_approved label (merge in progress)
    if (hasPrApprovedLabel(params.ticket)) {
        console.log('ℹ️ autoStartRework: skipped — ticket has pr_approved label');
        return false;
    }
    // customParams.maxAutoReworkRounds caps the auto-rework loop.
    var nextRound = checkAutoReworkBudget({
        ticket: params.ticket,
        customParams: ctx.customParams,
        tracker: ctx.tracker,
        ticketKey: ctx.ticketKey
    });
    if (nextRound === null) return null;
    var triggered = triggerConfiguredRework(ctx);
    if (triggered) {
        stampReworkRound(ctx.tracker, ctx.ticketKey, nextRound);
    }
    return triggered;
}

function shouldRunReworkLeg(isApproved, pr, repoInfo) {
    return !isApproved && !!(pr.number && repoInfo);
}

/**
 * Step 12: auto-start pr_rework when changes were requested (opt-in via
 * customParams). Only when there's an actual PR to rework — with no PR
 * found, there's nothing for a rework cycle to act on, so don't mark for SM
 * rework or trigger SM.
 */
function runReworkLeg(ctx, params, pr, repoInfo, isApproved) {
    if (!shouldRunReworkLeg(isApproved, pr, repoInfo)) return;
    // gh-1369: a review leg concluding after the merge must not arm rework
    // on shipped code — the terminal probe runs FRESH at arm time (the PR
    // search above listed the PR open at leg start; #1368 merged 48s before
    // its stamp). Fail-open: an unknown state keeps the legacy arm.
    if (prIsTerminal(repoInfo, pr.number)) {
        console.log('⏭️ PR #' + pr.number + ' is merged/closed (gh-1369) — rework never arms ' +
            'on a terminal PR: sm_story_rework_triggered/agent:rework skipped');
        return;
    }
    var started = startConfiguredRework(ctx, params);
    // null = capped / needs-human: no rework at all, not even the SM fallback.
    if (started === null) return;
    if (!started) {
        markForSmStoryRework(ctx.tracker, ctx.ticketKey);
        autoStart.triggerSmIfIdle({ config: ctx.config, customParams: ctx.customParams, scm: ctx.scm });
    }
}

function onApprovedOf(customParams) {
    if (!customParams) return null;
    return customParams.onApproved;
}

function triggerBitriseBuild(ctx, pr, bb) {
    try {
        bitrise_trigger_build({
            appSlug: bb.appSlug,
            workflowId: bb.workflowId,
            branch: resolveBitriseBranch(bb, pr.branch),
            commitMessage: ctx.ticketKey + ' — triggered by AI PR review approval',
            envVars: JSON.stringify(buildBitriseEnvVars(bb, ctx.ticketKey, pr.url))
        });
        console.log('✅ Triggered Bitrise build:', bb.workflowId, 'branch:', resolveBitriseBranch(bb, pr.branch), 'for', ctx.ticketKey);
    } catch (e) {
        console.warn('⚠️ Bitrise build trigger failed:', e.message || e);
    }
}

function triggerBitriseIfConfigured(ctx, pr, onApproved) {
    // 13a: Trigger Bitrise build (e.g. build_ios_simulator)
    if (!onApproved.bitriseBuild) return;
    triggerBitriseBuild(ctx, pr, onApproved.bitriseBuild);
}

function markTestsGenerated(ctx) {
    try {
        ctx.tracker.addLabel(ctx.ticketKey, LABELS.AI_TESTS_GENERATED);
        console.log('✅ Added label "' + LABELS.AI_TESTS_GENERATED + '" to ' + ctx.ticketKey);
    } catch (labelErr) {
        console.warn('⚠️ Could not add ai_tests_generated label:', labelErr.message || labelErr);
    }
}

function startTestCasesGenerator(ctx, tcg) {
    var tcgStarted = autoStart.triggerConfiguredWorkflowForTicket({
        ticketKey: ctx.ticketKey,
        customParams: ctx.customParams,
        config: ctx.config,
        configFile: tcg.configFile,
        workflowFile: tcg.workflow || 'ai-teammate.yml',
        scm: ctx.scm
    });
    if (!tcgStarted) {
        console.log('ℹ️ TestCasesGenerator not started for', ctx.ticketKey,
            '[config=' + tcg.configFile + ']');
        return;
    }
    // Mark ticket so subsequent approvals skip re-generation
    markTestsGenerated(ctx);
}

function runTestCasesGenerator(ctx, tcg) {
    // Guard: skip if tests were already generated for this ticket
    if (hasLabel(ctx.labels, LABELS.AI_TESTS_GENERATED)) {
        console.log('ℹ️ TestCasesGenerator skipped — label "' + LABELS.AI_TESTS_GENERATED + '" already present on ' + ctx.ticketKey + ' (tests generated in a previous cycle)');
        return;
    }
    var repos = resolveTestCasesGeneratorRepo(ctx.customParams, ctx.config);
    if (!repos.owner || !repos.repo) {
        console.warn('⚠️ TestCasesGenerator: aiRepository owner/repo not set — skipping');
        return;
    }
    startTestCasesGenerator(ctx, tcg);
}

function triggerTestCasesGenerator(ctx, tcg) {
    // 13b: Trigger TestCasesGenerator via GitHub Actions (only once per ticket)
    try {
        runTestCasesGenerator(ctx, tcg);
    } catch (e) {
        console.warn('⚠️ TestCasesGenerator trigger failed:', e.message || e);
    }
}

function triggerTestCasesGeneratorIfConfigured(ctx, onApproved) {
    if (!onApproved.testCasesGenerator) return;
    triggerTestCasesGenerator(ctx, onApproved.testCasesGenerator);
}

/**
 * Step 13: on-approved triggers (opt-in via customParams.onApproved).
 */
function runOnApprovedTriggers(ctx, pr, isApproved) {
    var onApproved = onApprovedOf(ctx.customParams);
    if (!isApproved || !onApproved) return;
    triggerBitriseIfConfigured(ctx, pr, onApproved);
    triggerTestCasesGeneratorIfConfigured(ctx, onApproved);
}

function postTokenUsageQuietly(ctx, params) {
    try {
        // agents#889: reuse the tracker resolved for this run (customParams patched by the pr_review
        // instructions); customParamsOf(params) alone misses it and fell back to Jira on ADO.
        tokenUsageComment.postTokenUsageComments(ctx.ticketKey, { initiator: params.initiator, tracker: ctx.tracker });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }
}

/**
 * SM fallback for approved PRs (merge via pr_approved flow), the completion
 * log line and the token-usage summary comments.
 */
function finalizeReviewRun(ctx, params, isApproved) {
    if (isApproved) {
        autoStart.triggerSmIfIdle({ config: ctx.config, customParams: ctx.customParams, scm: ctx.scm });
    }
    console.log('✅ PR review workflow completed:', isApproved ? 'APPROVED' : 'CHANGES REQUESTED');
    // Post token usage summary comments (e.g. [story_acceptance_criteria]: {...}) if any provider
    // wrote outputs/*_usage.json during the agent run.
    postTokenUsageQuietly(ctx, params);
}

function buildSuccessResult(isApproved, recommendation, reviewData, pr, repoInfo, advisoryRecommendation, filterStats) {
    var result = {
        success: true,
        message: isApproved ? 'PR approved — awaiting reviewer merge' : 'Changes requested, ticket returned to In Development',
        recommendation: recommendation,
        advisoryRecommendation: advisoryRecommendation || recommendation,
        issueCounts: reviewData.issueCounts,
        githubCommentsPosted: !!(pr.number && repoInfo)
    };
    if (filterStats) result.filter = filterStats;
    return result;
}

function ticketKeyOfTicket(ticket) {
    if (!ticket) return null;
    return ticket.key;
}

function ticketKeyOfParams(params) {
    if (!params) return null;
    return ticketKeyOfTicket(params.ticket);
}

function fallbackErrorTracker(params) {
    try {
        return trackersModule.createTracker(configLoader.loadProjectConfig(jobParamsOf(params)));
    } catch (trackerError) {
        console.error('Failed to create tracker for error comment:', trackerError);
        return null;
    }
}

function resolveErrorTracker(params, tracker) {
    if (tracker) return tracker;
    return fallbackErrorTracker(params);
}

function buildReviewErrorComment(ticketKey, error) {
    var em = commentMarkup.forTicket(ticketKey);
    return em.h(3, '❌ PR Review Error') + '\n\n' +
        em.code(error.toString()) + '\n\n' +
        'Please check the workflow logs for details.';
}

function postErrorCommentOnTracker(ticketKey, errorTracker, error) {
    if (!errorTracker) return;
    errorTracker.postComment(ticketKey, buildReviewErrorComment(ticketKey, error));
}

function postErrorCommentQuietly(params, tracker, error) {
    var ticketKey = ticketKeyOfParams(params);
    if (!ticketKey) return;
    postErrorCommentOnTracker(ticketKey, resolveErrorTracker(params, tracker), error);
}

/**
 * Top-level failure handler: log, best-effort error comment on the ticket
 * (via the run tracker when one was resolved, else a freshly probed one),
 * and the failure result.
 */
function reportReviewError(params, tracker, error) {
    console.error('❌ Error in postPRReviewComments:', error);
    try {
        postErrorCommentQuietly(params, tracker, error);
    } catch (commentError) {
        console.error('Failed to post error comment:', commentError);
    }
    return {
        success: false,
        error: error.toString()
    };
}

function jiraStatusesOf(config) {
    if (!config.jira) return null;
    return config.jira.statuses;
}

/**
 * Run-scoped context: everything resolved once from params/config before the
 * pipeline starts. tracker/customParams are attached by action() after the
 * header log line (their resolution order is observable in the logs).
 */
function buildReviewContext(params) {
    var jp = jobParamsOf(params);
    var prAnchor = parsePRAnchor(params, jp);
    var config = configLoader.loadProjectConfig(jp);
    return {
        jp: jp,
        prAnchor: prAnchor,
        ticketKey: resolveReviewTicketKey(params, prAnchor),
        jiraReview: orEmpty(params.response),
        config: config,
        // gh-1351: the resolved reviewPolicy governs the verdict — a
        // malformed config throws HERE (a hard validation error at the
        // leg's start of post-processing; the pre-cli action fails the leg
        // even earlier) and no side effect runs.
        reviewPolicy: reviewPolicyModule.resolveReviewPolicy(config, jp),
        machineAuthor: machineAuthorModule.resolveMachineAuthor(jp, config),
        workingDir: config.workingDir || null,
        scm: scmModule.createScm(config),
        labels: ticketLabels(params.ticket),
        customParams: null,
        tracker: null
    };
}

/**
 * Main action function
 * Posts review results to GitHub and Jira, updates ticket
 *
 * Thin executor over the gh-926 pipeline: every decision lives in a pure
 * parse/decide/build helper, every side effect in a named step, and this
 * function only sequences them — in the same order as before the split.
 *
 * @param {Object} params - Parameters from Teammate job
 * @param {Object} params.ticket - Jira ticket object
 * @param {string} params.response - Jira-formatted review from outputs/response.md
 * @param {string} params.inputFolderPath - Path to input folder
 * @returns {Object} Result object
 */
function action(params) {
    var tracker = null;
    try {
        var ctx = buildReviewContext(params);

        console.log('=== Processing PR review results for', ctx.ticketKey, '===');

        // Resolve customParams and probe the tracker provider once for the whole run:
        // the same script then works unchanged on Jira / ADO / GitHub deployments.
        ctx.customParams = resolveCustomParams(params, ctx.config);
        ctx.tracker = trackersModule.createTracker(ctx.config, ctx.customParams);
        tracker = ctx.tracker;

        // Step 1: Read structured review data
        var reviewData = readOrResumeReviewData(ctx.ticketKey, ctx.workingDir);
        if (!reviewData) {
            return handleMissingReviewData(params, ctx.config, ctx.customParams, tracker);
        }

        // gh-1053: uncited external-spec BLOCKING claims are downgraded to
        // non-blocking questions before they can drive the verdict/census.
        // gh-1334: an uncited claim is first verified against the ticket
        // text (input/<folder>/ticket.md | request.md) — a verifiably true
        // claim keeps BLOCKING force with the citation auto-appended.
        applySpecClaimDowngrades(reviewData, ctx.ticketKey, ctx.workingDir, params.inputFolderPath);

        // gh-1403: the finding-filter leg (reviewPolicy.verification =
        // filter) — a fresh-context pass verifies each rework/polish-tier
        // candidate BEFORE posting; drops become digest lines, demotes tier
        // downgrades, the census is recomputed after filtering. Non-fatal:
        // any filter failure degrades to the unfiltered review.
        var filterOutcome = applyReviewFilter(reviewData, ctx, filterDiffPathOf(params));

        console.log('Review recommendation:', reviewData.recommendation);
        console.log('Issue counts:', JSON.stringify(reviewData.issueCounts));

        // Resolve statuses — project-wide overrides via .dmtools/config.js's jira.statuses,
        // plus legacy per-invocation overrides via customParams.customStatuses
        var statuses = resolveStatuses(ctx.customParams, jiraStatusesOf(ctx.config));

        // Step 2: Extract PR info from input folder or find PR
        var discovered = discoverPullRequest(params, ctx);
        var repoInfo = discovered.repoInfo;
        var pr = discovered.pr;

        var recommendation = normalizeRecommendation(reviewData);
        var issueCounts = normalizeIssueCounts(reviewData);

        // gh-1351: the resolved reviewPolicy governs this leg — the table is
        // logged (and stamped into the run context by the pre-cli action) so
        // every decision is traceable to the policy that produced it.
        console.log(reviewPolicyModule.policyTableMarkdown(ctx.reviewPolicy));
        reviewPolicyModule.legacyKnobAudit(ctx.customParams, ctx.reviewPolicy).lines.forEach(function(line) {
            console.warn(line);
        });

        // gh-1350 census cross-check (review_verdict_rules.md enforcement):
        // a posted inline BLOCKING severity with an empty blocking census
        // cannot ride an approval — the verdict flips to REQUEST_CHANGES.
        // Fires BEFORE the machine recomputation: posted evidence corrects
        // the census the recomputation reads.
        var censusCrossCheck = censusCrossCheckOverride(reviewData, recommendation, issueCounts);
        recommendation = censusCrossCheck.recommendation;
        if (censusCrossCheck.overridden) {
            issueCounts = censusCrossCheck.issueCounts;
            console.warn(buildCensusCrossCheckWarning(issueCounts));
        }

        // gh-1351 machine enforcement: the approval is recomputed from the
        // severity census + the resolved policy — the model verdict is
        // advisory. Any 🚨/⚠️ (rework-tier) thread open → REQUEST_CHANGES;
        // only 💡/🪶 → APPROVE (suggestion-only cycles converge).
        var machine = machineApprovalFromCensus(recommendation, issueCounts, ctx.reviewPolicy);
        var isApproved = machine.approved;
        if (machine.recomputed) {
            console.warn(buildMachineVerdictLog(machine, recommendation));
        }
        recommendation = machine.verdict;

        // Step 4: Post all comments to GitHub PR (always, regardless of outcome)
        postGitHubReview(ctx, pr, repoInfo, reviewData, isApproved, recommendation, issueCounts);

        // ── PR-anchored runs end here (#687)
        if (ctx.prAnchor) {
            return finishPRAnchoredReview(ctx, pr, repoInfo, isApproved, recommendation);
        }

        // Step 6: Post review to the ticket (merge is handled by SM/required reviewers, not by this agent)
        postReviewToJira(tracker, ctx.ticketKey, ctx.jiraReview, reviewData, pr.url, ctx.reviewPolicy, filterOutcome);

        // Step 7: Update ticket status based on outcome
        applyTicketOutcome(tracker, ctx.ticketKey, statuses, isApproved, pr, repoInfo);

        // Step 8: Add review label
        addReviewMarkers(ctx, ctx.ticketKey, pr, repoInfo);

        // Step 9: Remove WIP label if present
        removeWipLabel(tracker, ctx.ticketKey, resolveWipLabel(params));

        // Step 10: Remove SM idempotency label (via customParams)
        removeSmLabelIfConfigured(tracker, ctx.ticketKey, ctx.customParams);

        // Step 11: Assign back to initiator
        assignBackToInitiator(tracker, ctx.ticketKey, params.initiator);

        // Step 12: Auto-start pr_rework when changes were requested (opt-in via customParams)
        runReworkLeg(ctx, params, pr, repoInfo, isApproved);

        // Step 13: On-approved triggers (opt-in via customParams.onApproved)
        runOnApprovedTriggers(ctx, pr, isApproved);

        finalizeReviewRun(ctx, params, isApproved);

        return buildSuccessResult(isApproved, recommendation, reviewData, pr, repoInfo, advisoryTokenOf(reviewData),
            filterOutcome ? filterOutcome.stats : null);

    } catch (error) {
        return reportReviewError(params, tracker, error);
    }
}

// Export for dmtools standalone execution
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        reworkRoundOf: reworkRoundOf,
        action,
        resolveCustomParams,
        isLinePresentInDiff,
        countReviewThreads,
        postInlineComment,
        postGeneralComment,
        postVerdictRecord,
        findingsFromReviewData,
        findingReviewOf,
        prCommentsForRegistry,
        stampFindingRegistry,
        postFindingRegistryUpdate,
        resolveApprovedThreads,
        parseDiffLineInfo,
        isFileDeletedInDiff,
        isSubmodulePathInDiff,
        findSubmodulePathForFile,
        submoduleHasNewPointer,
        resolveCommentFileReference,
        // gh-926 pipeline helpers
        parsePRAnchor,
        resolveReviewTicketKey,
        parsePRInfoMarkdown,
        readPRInfoMarkdown,
        normalizeRecommendation,
        advisoryTokenOf,
        normalizeIssueCounts,
        hasAnyOpenIssue,
        censusCrossCheckOverride,
        buildCensusCrossCheckWarning,
        machineStampedInlineText,
        hasAllowApproveWithSuggestions,
        hasBlockingOrImportant,
        machineApprovalFromCensus,
        buildMachineVerdictLog,
        auditDensityAgainstPolicy,
        prAdditionsOf,
        decideApproval,
        isApprovalOverridden,
        buildApprovalOverrideWarning,
        correctedCensusOf,
        outcomeBadgePanel,
        censusSummaryLines,
        policyStampSection,
        resolveFormalReviewEnabled,
        parseLinkedIssueNumber,
        parseBranchIssueNumber,
        linkedIssueNumberFromPR,
        stripLinkedIssueArmLabels,
        cleanLinkedIssueArmsOnApproval,
        finishPRAnchoredReview,
        runReworkLeg,
        resolveWipLabel,
        buildBitriseEnvVars,
        resolveBitriseBranch,
        resolveTestCasesGeneratorRepo,
        hasLabel,
        reworkRoundOf,
        maxAutoReworkRoundsOf,
        ticketLabels,
        scmProviderOf,
        deriveProjectKey,
        parseGitHubRemoteUrl,
        buildResumePrompt,
        attemptResumeIfReviewOutputsMissing,
        readReviewJson,
        hasPrApprovedLabel,
        getGitHubRepoInfo,
        searchMissingPRNumber,
        ticketKeyOfParams,
        applySpecClaimDowngrades,
        readTicketClaimSource,
        // gh-1403 review filter leg
        verificationEnabledOf,
        filterDiffPathOf,
        filterCliCommandOf,
        applyReviewFilter,
        filterStampSection,
        appendDroppedSection,
        stampDemotionNotesOnFiles
    };
}
