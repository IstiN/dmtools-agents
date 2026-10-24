/**
 * Pre-CLI Test Automation Setup Action (preCliJSAction for test_case_automation)
 * 1. Moves ticket to In Development
 * 2. Creates/checks out test/{TICKET-KEY} branch from main
 */

var configLoader = require('./configLoader.js');
var prHelper = require('./common/pullRequest.js');
var branchSetup = require('./common/branchSetup.js');
const { GIT_CONFIG, STATUSES } = require('./config.js');
const fetchLinkedBugsToInput = require('./fetchLinkedBugsToInput.js');

// Tracker-agnostic ticket operations (jira / ado / github) — created lazily per action() run.
var trackersModule = require('./common/trackers.js');
var _trackerCtx = { config: null, customParams: {} };
var _trackerInst = null;
function initTracker(config, customParams) {
    _trackerCtx = { config: config || null, customParams: customParams || {} };
    _trackerInst = null;
}
function getTracker() {
    if (!_trackerInst) _trackerInst = trackersModule.createTracker(_trackerCtx.config, _trackerCtx.customParams);
    return _trackerInst;
}

function runGit(command, workingDir) {
    var args = { command: command };
    if (workingDir) args.workingDirectory = workingDir;
    return cli_execute_command(args);
}

function branchHasUniquePatches(baseBranch, workingDir) {
    return branchSetup.branchHasUniquePatches(prHelper, function (cmd) { return runGit(cmd, workingDir); }, baseBranch, 'Could not inspect unique test branch patches:');
}

function isAncestorRef(ancestor, descendant, workingDir) {
    return branchSetup.isAncestorRefRevList(
        prHelper,
        function (cmd) { return runGit(cmd, workingDir); },
        ancestor,
        descendant,
        'Could not inspect branch ancestry for'
    );
}

function findMergeBase(left, right, workingDir) {
    return branchSetup.findMergeBase(prHelper, function (cmd) { return runGit(cmd, workingDir); }, left, right);
}

function alignBranchWithBase(ticketKey, branchName, baseBranch, workingDir) {
    if (isAncestorRef('HEAD', 'origin/' + baseBranch, workingDir)) {
        console.log('Test branch changes are already included in origin/' + baseBranch + ', resetting local branch:', branchName);
        runGit('git reset --hard origin/' + baseBranch, workingDir);
        return;
    }

    if (!branchHasUniquePatches(baseBranch, workingDir)) {
        console.log('Test branch has no unique patches versus origin/' + baseBranch + ', resetting local branch:', branchName);
        runGit('git reset --hard origin/' + baseBranch, workingDir);
        return;
    }

    if (isAncestorRef('origin/' + baseBranch, 'HEAD', workingDir)) {
        console.log('Test branch already contains origin/' + baseBranch + ':', branchName);
        return;
    }

    console.warn('Test branch does not contain origin/' + baseBranch + ':', branchName);
    var details = branchSetup.collectMergeTreeDetails(
        prHelper,
        function (cmd) { return runGit(cmd, workingDir); },
        baseBranch,
        'No merge base found between HEAD and origin/' + baseBranch + '. The branch history may be unrelated to the current base or too shallow.'
    );
    branchSetup.writeBranchConflictGuidance(
        ticketKey,
        branchName,
        baseBranch,
        details.substring(0, 6000),
        'test automation work',
        'Before editing tests, sync the branch deliberately with `origin/' + baseBranch + '`. ' +
            'In most cases, prefer `origin/' + baseBranch + '` for repository setup, generated workflow/config files, ' +
            'and shared infrastructure, then re-apply only the ticket-specific test automation that is still relevant.',
        'Do not discard test files that are still needed for this ticket. Do not keep stale bootstrap/setup files just because they exist on the old branch.'
    );
    console.warn('Keeping divergent test branch ' + branchName + '; conflict guidance written for the agent.');
}

function checkoutBranch(ticketKey, config) {
    var head = branchSetup.checkoutTestBranchHead(ticketKey, config, { configLoader: configLoader, prHelper: prHelper, runGit: runGit });
    var branchName = head.branchName;
    var workingDir = head.workingDir;
    var exec = head.exec;

    var localBranches = branchSetup.readLocalBranchList(prHelper, exec, branchName, null);

    if (localBranches.trim()) {
        console.log('Branch exists locally, aligning with base:', branchName);
        runGit('git checkout ' + branchName, workingDir);
        alignBranchWithBase(ticketKey, branchName, config.git.baseBranch, workingDir);
    } else {
        var remoteBranchExists = false;
        try {
            // gh-912: decide on a real refs/heads/<branch> ref line — a
            // warning-only capture (central-mode insteadOf origin, git ≥
            // 2.54) must classify as "branch absent".
            remoteBranchExists = prHelper.remoteBranchExists(runGit, workingDir, branchName);
        } catch (e) {
            console.warn('Error checking remote branches:', e);
        }

        if (remoteBranchExists) {
            console.log('Branch exists on remote, checking out and aligning with base:', branchName);
            runGit('git checkout -b ' + branchName + ' origin/' + branchName, workingDir);
            alignBranchWithBase(ticketKey, branchName, config.git.baseBranch, workingDir);
        } else {
            console.log('Creating new branch from', config.git.baseBranch + ':', branchName);
            runGit('git checkout ' + config.git.baseBranch, workingDir);
            runGit('git pull origin ' + config.git.baseBranch, workingDir);
            runGit('git checkout -b ' + branchName, workingDir);
        }
    }

    console.log('✅ Branch ready:', branchName);
}

/** Step 1: move the ticket to In Development (non-fatal). */
function moveTicketToInDevelopment(ticketKey) {
    try {
        getTracker().moveToStatus(ticketKey, STATUSES.IN_DEVELOPMENT);
        console.log('✅ Moved ' + ticketKey + ' to ' + STATUSES.IN_DEVELOPMENT);
    } catch (e) {
        console.warn('Failed to move ticket to In Development:', e);
    }
}

/** Step 2: create/checkout test/{KEY} branch from main (non-fatal). */
function checkoutBranchSafely(ticketKey, config) {
    try {
        checkoutBranch(ticketKey, config);
    } catch (e) {
        console.error('Branch checkout failed (non-fatal):', e);
    }
}

/**
 * Step 2b: clear stale output files from previous runs so the post-action
 * does not accidentally read a result JSON belonging to a different ticket.
 */
function clearStaleOutputs(config) {
    try {
        runGit('bash -c "rm -f outputs/test_automation_result.json outputs/story_test_automation_result.json outputs/tracker_comment.md outputs/comment.md outputs/jira_comment.md outputs/response.md outputs/pr_body.md outputs/bug_description.md outputs/failed_description_*.md"', config.workingDir || null);
        console.log('✅ Cleared stale output files');
    } catch (e) {
        console.warn('Could not clear stale output files (non-fatal):', e);
    }
}

/**
 * Step 3: fetch linked bugs (with fix comments) into input folder.
 * This gives the test agent context about HOW bugs were fixed (timing,
 * delays, etc.). Non-fatal.
 */
function fetchLinkedBugsSafely(actualParams) {
    try {
        fetchLinkedBugsToInput.action(actualParams);
    } catch (e) {
        console.warn('fetchLinkedBugsToInput failed (non-fatal):', e);
    }
}

function action(params) {
    try {
        var resolved = branchSetup.resolveInputParams(params, function (p) {
            return configLoader.loadProjectConfig(p);
        });
        var actualParams = resolved.actualParams;
        var ticketKey = resolved.ticketKey;
        var config = resolved.config;
        initTracker(config, (params.jobParams && params.jobParams.customParams) || params.customParams || {});

        console.log('=== Test automation setup for:', ticketKey, '===');

        moveTicketToInDevelopment(ticketKey);
        checkoutBranchSafely(ticketKey, config);
        clearStaleOutputs(config);
        fetchLinkedBugsSafely(actualParams);

        console.log('✅ Test automation setup complete for', ticketKey);

    } catch (error) {
        console.error('❌ Error in preCliTestAutomationSetup:', error);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
