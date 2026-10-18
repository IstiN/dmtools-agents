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

const { LABELS, STATUSES, resolveStatuses } = require('./config.js');
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
var reviewSpecClaims = require('./common/reviewSpecClaims.js');

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
 * Used as a safety valve: after many review rounds, an APPROVE with remaining
 * suggestions is allowed so the loop terminates.
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
    var merged = {};
    var patch = configLoader.resolveInstructions(
        'pr_review',
        null,
        config
    ).jobParamPatch;
    if (patch && patch.customParams) {
        Object.assign(merged, patch.customParams);
    }
    Object.assign(
        merged,
        (params.jobParams && params.jobParams.customParams) ||
            params.customParams ||
            {}
    );
    return merged;
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

function postInlineComment(scm, pullRequestId, inlineComment, ticketKey, workingDir) {
    // Accept both spec formats:
    //   old spec: { file, comment: "path/to/file.md" }
    //   agent output: { path, body: "inline text" }
    var filePath = inlineTargetOf(inlineComment);
    var commentText = resolveInlineComment(inlineComment, ticketKey, workingDir);

    try {
        return postResolvedInlineComment(scm, pullRequestId, inlineComment, filePath, commentText, ticketKey, workingDir);
    } catch (error) {
        // 422 = line not in diff hunk — fall back to a regular PR comment so nothing is lost
        return fallbackInlineComment(scm, pullRequestId, filePath, inlineComment.line, commentText, error);
    }
}

function postResolvedInlineComment(scm, pullRequestId, inlineComment, filePath, commentText, ticketKey, workingDir) {
    if (!commentText) {
        console.warn('No comment content found for inline comment on', filePath);
        return false;
    }
    if (!filePath) {
        console.warn('No file path found for inline comment');
        return false;
    }

    console.log('Posting inline comment on ' + filePath + ':' + inlineComment.line);
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
        postVerdictRecordChecked(scm, repoInfo, prNumber, isApproved, recommendation, issueCounts, provider);
    } catch (e) {
        console.warn('verdict record post failed (non-fatal):', e.message || e);
    }
}

function postVerdictRecordChecked(scm, repoInfo, prNumber, isApproved, recommendation, issueCounts, provider) {
    var headSha = resolveHeadSha(repoInfo, prNumber);
    if (headSha === null) return; // probe failure — already warned
    if (!headSha) {
        console.warn('verdict record: PR #' + prNumber + ' has no head sha — record not posted');
        return;
    }
    stampVerdictRecord(scm, prNumber, headSha, isApproved, recommendation, issueCounts, provider);
}

function resolveHeadSha(repoInfo, prNumber) {
    try {
        var prRaw = github_get_pr({
            workspace: repoInfo.owner, repository: repoInfo.repo, pullRequestId: String(prNumber)
        });
        return headShaOf(prRaw);
    } catch (headErr) {
        console.warn('verdict record: head sha probe failed — record not posted:', headErr.message || headErr);
        return null;
    }
}

function headShaOf(prRaw) {
    var prObj = typeof prRaw === 'string' ? JSON.parse(prRaw) : (prRaw || {});
    return headShaOfObject(prObj);
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

/**
 * Post review results to the ticket (Jira/ADO/GitHub depending on the probed provider)
 * @param {Object} tracker - trackers.js provider instance
 * @param {string} ticketKey - Ticket key
 * @param {string} reviewContent - Review content (from outputs/response.md)
 * @param {Object} reviewData - Parsed pr_review.json data
 * @param {string} prUrl - PR URL for linking
 */
function postReviewToJira(tracker, ticketKey, reviewContent, reviewData, prUrl) {
    try {
        const m = commentMarkup.forTicket(ticketKey);
        let comment = m.h(2, '🔍 Automated PR Review Completed') + '\n\n';

        // Add outcome badge
        // Normalize: LLM sometimes returns "APPROVED" instead of "APPROVE"
        const recommendation = (reviewData.recommendation || reviewData.verdict || 'REQUEST_CHANGES').replace(/^APPROVED$/, 'APPROVE');
        if (recommendation === 'APPROVE') {
            comment += m.panel(null, '✅ ' + m.bold('APPROVED') + ' - AI review passed. Awaiting required reviewer approval to merge.', 'bgColor=#E3FCEF|borderColor=#00875A') + '\n\n';
        } else if (recommendation === 'BLOCK') {
            comment += m.panel(null, '🚨 ' + m.bold('BLOCKED') + ' - Critical issues must be fixed before merge', 'bgColor=#FFEBE6|borderColor=#DE350B') + '\n\n';
        } else {
            comment += m.panel(null, '⚠️ ' + m.bold('CHANGES REQUESTED') + ' - Issues found, ticket returned to In Rework', 'bgColor=#FFF7E6|borderColor=#FF991F') + '\n\n';
        }

        // Add issue summary
        const issueCounts = reviewData.issueCounts || { blocking: 0, important: 0, suggestions: 0 };
        comment += m.h(3, 'Issue Summary') + '\n';
        comment += '* 🚨 Blocking Issues: ' + m.bold(String(issueCounts.blocking)) + '\n';
        comment += '* ⚠️ Important Issues: ' + m.bold(String(issueCounts.important)) + '\n';
        comment += '* 💡 Suggestions: ' + m.bold(String(issueCounts.suggestions)) + '\n\n';

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

function normalizeIssueCounts(reviewData) {
    return reviewData.issueCounts || { blocking: 0, important: 0, suggestions: 0 };
}

function positiveCount(value) {
    return (value || 0) > 0;
}

function hasAnyOpenIssue(issueCounts) {
    return positiveCount(issueCounts.blocking) ||
        positiveCount(issueCounts.important) ||
        positiveCount(issueCounts.suggestions);
}

function hasAllowApproveWithSuggestions(customParams) {
    return !!(customParams && customParams.allowApproveWithSuggestions === true);
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

function threadLimitConfigured(prNumber, repoInfo, maxThreadLimit) {
    return !!prNumber && !!repoInfo && !!maxThreadLimit && maxThreadLimit > 0;
}

function shouldProbeThreadLimit(recommendation, hasOpenIssues, allowApproveWithSuggestions, prNumber, repoInfo, maxThreadLimit) {
    if (!verdictNeedsIssueOverride(recommendation, hasOpenIssues, allowApproveWithSuggestions)) return false;
    return threadLimitConfigured(prNumber, repoInfo, maxThreadLimit);
}

function threadCountExceedsLimit(scm, prNumber, maxThreadLimit) {
    try {
        var reviewThreadCount = countReviewThreads(scm, prNumber);
        if (reviewThreadCount >= maxThreadLimit) {
            console.warn(
                '⚠️ PR has ' + reviewThreadCount + ' review threads (>= limit ' + maxThreadLimit + '). ' +
                'Forcing APPROVE despite remaining suggestions to break the review loop.'
            );
            return true;
        }
        return false;
    } catch (e) {
        console.warn('Could not apply review-thread limit:', e.message || e);
        return false;
    }
}

/**
 * Safety valve: after many review rounds, force-approve an APPROVE verdict
 * even if suggestions remain, so the review/rework loop cannot run forever.
 */
function probeThreadLimitOverride(scm, prNumber, recommendation, hasOpenIssues, allowApproveWithSuggestions, repoInfo, maxThreadLimit) {
    if (!shouldProbeThreadLimit(recommendation, hasOpenIssues, allowApproveWithSuggestions, prNumber, repoInfo, maxThreadLimit)) return false;
    return threadCountExceedsLimit(scm, prNumber, maxThreadLimit);
}

function maxThreadLimitOf(customParams) {
    if (!customParams) return 0;
    return orZero(customParams.maxReviewThreadsBeforeForceApprove);
}

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

function readPRInfoMarkdown(inputFolderPath, ticketKey) {
    try {
        var inputFolder = inputFolderPath || ('input/' + ticketKey);
        return file_read({
            path: inputFolder + '/pr_info.md'
        });
    } catch (error) {
        console.warn('Could not read PR info from input folder:', error);
        return null;
    }
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
 * File-referenced comment bodies are rewritten via writeFile so the posted
 * thread no longer carries the 🚨 marker; every downgrade is logged.
 */
function applySpecClaimDowngrades(reviewData, ticketKey, workingDir) {
    try {
        var result = reviewSpecClaims.sanitizeReviewData(reviewData, function (path) {
            return readMarkdownFile(path, ticketKey, workingDir);
        });
        result.rewrites.forEach(function (rw) {
            writeFile(rw.path, rw.content);
        });
        result.notes.forEach(function (note) {
            console.warn('⚠️ gh-1053 spec-claim guard:', note);
        });
        return result;
    } catch (e) {
        console.warn('⚠️ gh-1053 spec-claim guard failed (continuing un-sanitized):', e.message || e);
        return { downgrades: 0, notes: [], rewrites: [] };
    }
}

function hasGitHubTarget(pr, repoInfo) {
    return !!(pr.number && repoInfo);
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
    // per head — see js/common/reviewVerdicts.js.
    postVerdictRecord(ctx.scm, repoInfo, pr.number, isApproved, recommendation, issueCounts, scmProviderOf(ctx.config));

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

function linkedIssueNumberFromPR(repoInfo, prNumber) {
    var prObj = fetchPullRequestObject(repoInfo, prNumber);
    return parseLinkedIssueNumber(prObj.body);
}

function rearmReworkOnLinkedIssue(ctx, pr, repoInfo) {
    try {
        var linkedIssue = linkedIssueNumberFromPR(repoInfo, pr.number);
        if (linkedIssue) {
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
        rearmLinkedIssueRework(ctx, pr, repoInfo);
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

function startConfiguredRework(ctx, params) {
    if (!autoStartReworkConfigured(ctx.customParams)) return false;
    // Skip if ticket already has pr_approved label (merge in progress)
    if (hasPrApprovedLabel(params.ticket)) {
        console.log('ℹ️ autoStartRework: skipped — ticket has pr_approved label');
        return false;
    }
    return triggerConfiguredRework(ctx);
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
    if (!startConfiguredRework(ctx, params)) {
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

function buildSuccessResult(isApproved, recommendation, reviewData, pr, repoInfo) {
    return {
        success: true,
        message: isApproved ? 'PR approved — awaiting reviewer merge' : 'Changes requested, ticket returned to In Development',
        recommendation: recommendation,
        issueCounts: reviewData.issueCounts,
        githubCommentsPosted: !!(pr.number && repoInfo)
    };
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
        applySpecClaimDowngrades(reviewData, ctx.ticketKey, ctx.workingDir);

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
        var hasOpenIssues = hasAnyOpenIssue(issueCounts);
        var allowApproveWithSuggestions = hasAllowApproveWithSuggestions(ctx.customParams);
        var forceApproveDueToThreadLimit = probeThreadLimitOverride(
            ctx.scm, pr.number, recommendation, hasOpenIssues, allowApproveWithSuggestions,
            repoInfo, maxThreadLimitOf(ctx.customParams));
        var isApproved = decideApproval(recommendation, hasOpenIssues, allowApproveWithSuggestions, forceApproveDueToThreadLimit);
        if (isApprovalOverridden(recommendation, hasOpenIssues, allowApproveWithSuggestions, forceApproveDueToThreadLimit)) {
            console.warn(buildApprovalOverrideWarning(issueCounts));
        }

        // Step 4: Post all comments to GitHub PR (always, regardless of outcome)
        postGitHubReview(ctx, pr, repoInfo, reviewData, isApproved, recommendation, issueCounts);

        // ── PR-anchored runs end here (#687)
        if (ctx.prAnchor) {
            return finishPRAnchoredReview(ctx, pr, repoInfo, isApproved, recommendation);
        }

        // Step 6: Post review to the ticket (merge is handled by SM/required reviewers, not by this agent)
        postReviewToJira(tracker, ctx.ticketKey, ctx.jiraReview, reviewData, pr.url);

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

        return buildSuccessResult(isApproved, recommendation, reviewData, pr, repoInfo);

    } catch (error) {
        return reportReviewError(params, tracker, error);
    }
}

// Export for dmtools standalone execution
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action,
        resolveCustomParams,
        isLinePresentInDiff,
        countReviewThreads,
        postInlineComment,
        postGeneralComment,
        postVerdictRecord,
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
        normalizeRecommendation,
        normalizeIssueCounts,
        hasAnyOpenIssue,
        hasAllowApproveWithSuggestions,
        decideApproval,
        isApprovalOverridden,
        buildApprovalOverrideWarning,
        shouldProbeThreadLimit,
        maxThreadLimitOf,
        resolveFormalReviewEnabled,
        parseLinkedIssueNumber,
        resolveWipLabel,
        buildBitriseEnvVars,
        resolveBitriseBranch,
        resolveTestCasesGeneratorRepo,
        hasLabel,
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
        applySpecClaimDowngrades
    };
}
