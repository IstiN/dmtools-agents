/**
 * Pre-CLI Mobile Test Automation Setup (generic preCliJSAction)
 *
 * Designed for story/bug trigger tickets that have linked Test Case tickets
 * via "is tested by" relationship. Prepares the test automation repository
 * for the AI agent to write and run mobile tests.
 *
 * Steps:
 * 1. Move trigger ticket to In Development
 * 2. Fetch ALL linked Test Case tickets ("is tested by" relationship)
 * 3. Write linked test case details to input/{KEY}/linked_test_cases.md
 * 4. Create / checkout test/{KEY} branch in the target test automation repo
 * 5. Download latest successful iOS simulator build artifact from Bitrise
 *    and write the .app path to input/{KEY}/app_info.md
 *
 * Used by: project-specific test automation agent configs
 * Requires: customParams.targetRepository.workingDir pointing to the
 *           checked-out test automation repository.
 * Optional: customParams.bitriseBuild.appSlug + workflowId to enable
 *           artifact download. Also needs customParams.featurePR to
 *           resolve the feature branch from the Jira ticket's linked PR.
 */

var configLoader = require('./configLoader.js');
var prHelper = require('./common/pullRequest.js');
var mergeState = require('./common/mergeState.js');
const { STATUSES } = require('./config.js');
var trackersModule = require('./common/trackers.js');
var setupHelpers = require('./preCliMobileTestAutomationSetupHelpers.js');

// Canonical copy (gh-823/gh-912): the warning:/note: line filter lives in
// common/pullRequest.js once — this delegate keeps every local call site.
function cleanCommandOutput(output) {
    return prHelper.cleanCommandOutput(output);
}

/** Run a git / shell command inside the test automation repo working directory. */
function runInRepo(command, workingDir) {
    return cli_execute_command({ command: command, workingDirectory: workingDir });
}

/**
 * Checkout (or create) test/{ticketKey} branch in the automation repo.
 * Syncs existing branch from origin/<baseBranch> via rebase, falling back to merge.
 */
function checkoutAutomationBranch(ticketKey, config) {
    var workingDir = config.workingDir;
    var baseBranch = (config.git && config.git.baseBranch) || 'main';
    var branchName = 'test/' + ticketKey;

    console.log('Setting up automation repo branch:', branchName, 'in', workingDir);

    try {
        runInRepo('git config user.name "' + config.git.authorName + '"', workingDir);
        runInRepo('git config user.email "' + config.git.authorEmail + '"', workingDir);
    } catch (e) {
        console.warn('Failed to configure git author:', e);
    }

    try {
        var targetedFetch = prHelper.buildTargetedOriginFetchCommand(
            [branchName, (config.git && config.git.baseBranch) || 'main']);
        if (targetedFetch) runInRepo(targetedFetch, workingDir);
    } catch (e) {
        console.warn('Could not fetch remote branches:', e);
    }

    var localBranches = cleanCommandOutput(
        runInRepo('git branch --list "' + branchName + '"', workingDir) || ''
    );

    function syncWithBase() {
        // gh-761: never start a rebase or merge on top of an unconcluded
        // merge (MERGE_HEAD present — e.g. the agent left a conflicted
        // base-branch merge unresolved). The rebase would fail, and the
        // merge fallback below would then fail with "You have not concluded
        // your merge" and SILENTLY `git merge --abort` the agent's in-flight
        // resolution — destroying work this setup step did not start. Leave
        // the tree exactly as the agent left it; the agent concludes (or
        // aborts) the merge itself.
        if (mergeState.isMergeInProgress(runInRepo, workingDir)) {
            console.warn('⚠️ MERGE_HEAD exists in ' + workingDir +
                ' — a merge is already in progress; skipping base-branch sync (rebase/merge on top of it would finalize or abort the in-flight merge)');
            return;
        }
        try {
            runInRepo('git rebase origin/' + baseBranch, workingDir);
            console.log('✅ Rebase succeeded');
        } catch (rebaseErr) {
            console.warn('Rebase failed, falling back to merge:', rebaseErr);
            try { runInRepo('git rebase --abort', workingDir); } catch (_) {}
            try {
                runInRepo('git merge origin/' + baseBranch + ' --no-edit', workingDir);
                console.log('✅ Merged base into branch');
            } catch (mergeErr) {
                console.warn('Merge also failed:', mergeErr);
                try { runInRepo('git merge --abort', workingDir); } catch (_) {}
            }
        }
    }

    if (localBranches.trim()) {
        console.log('Branch exists locally, syncing from', baseBranch + ':', branchName);
        runInRepo('git checkout ' + branchName, workingDir);
        syncWithBase();
    } else {
        var remoteBranchExists = false;
        try {
            // gh-912: decide on a real refs/heads/<branch> ref line — a
            // warning-only capture (central-mode insteadOf origin, git ≥
            // 2.54) must classify as "branch absent".
            remoteBranchExists = prHelper.remoteBranchExists(runInRepo, workingDir, branchName);
        } catch (e) {
            console.warn('Error checking remote branches:', e);
        }

        if (remoteBranchExists) {
            console.log('Branch exists on remote, checking out:', branchName);
            runInRepo('git checkout -b ' + branchName + ' origin/' + branchName, workingDir);
            syncWithBase();
        } else {
            console.log('Creating new branch from', baseBranch + ':', branchName);
            runInRepo('git checkout ' + baseBranch, workingDir);
            runInRepo('git pull origin ' + baseBranch, workingDir);
            runInRepo('git checkout -b ' + branchName, workingDir);
        }
    }

    console.log('✅ Automation branch ready:', branchName);
}

/** Run every linked-TC search (primary JQL, then the broader fallback). */
function searchLinkedTestCases(ticketKey, tracker) {
    var linkedTCs = [];

    // Primary: "is tested by" relationship
    try {
        // JQL text: provider-specific query (WIQL on ado)
        linkedTCs = tracker.searchIssues(
            setupHelpers.buildPrimaryLinkedTcJql(ticketKey),
            setupHelpers.linkedTcSearchOptions());
    } catch (e) {
        console.warn('Primary JQL failed, trying fallback:', e);
    }

    // Fallback: any linked test cases (broader search)
    if (!linkedTCs || linkedTCs.length === 0) {
        try {
            // JQL text: provider-specific query (WIQL on ado)
            linkedTCs = tracker.searchIssues(
                setupHelpers.buildFallbackLinkedTcJql(ticketKey),
                setupHelpers.linkedTcSearchOptions());
        } catch (e2) {
            console.warn('Fallback JQL also failed:', e2);
        }
    }

    return linkedTCs;
}

/** Fetch one TC's full ticket and append its recent run comments to lines. */
function appendTcRunComments(lines, tc, tracker) {
    // Fetch full ticket for comments (run history, prior failures)
    try {
        var tcDetails = tracker.getIssue(tc.key);
        var tcFields = tcDetails && tcDetails.fields || {};
        var commentBlock = tcFields.comment;
        var comments = commentBlock && commentBlock.comments || [];

        Array.prototype.push.apply(lines, setupHelpers.formatRecentTcComments(comments));
    } catch (ce) {
        console.warn('Could not fetch comments for', tc.key + ':', ce);
    }
}

/** Build the linked_test_cases.md body for non-empty search results. */
function buildLinkedTestCasesMarkdown(ticketKey, linkedTCs, tracker) {
    var lines = setupHelpers.buildLinkedTestCasesHeader(ticketKey);

    for (var i = 0; i < linkedTCs.length; i++) {
        var tc = linkedTCs[i];
        Array.prototype.push.apply(lines, setupHelpers.formatLinkedTcEntry(tc));
        appendTcRunComments(lines, tc, tracker);
    }

    return lines;
}

/** Fetch all Test Cases linked via "is tested by" and write to input folder. */
function fetchLinkedTestCases(ticketKey, folder, tracker) {
    var linkedTCs = searchLinkedTestCases(ticketKey, tracker);

    if (!linkedTCs || linkedTCs.length === 0) {
        console.log('No linked test cases found for', ticketKey);
        file_write(folder + '/linked_test_cases.md',
            '# Linked Test Cases\n\nNo linked Test Case tickets found for ' + ticketKey + '.\n');
        return 0;
    }

    console.log('Found', linkedTCs.length, 'linked test case(s)');

    file_write(folder + '/linked_test_cases.md',
        buildLinkedTestCasesMarkdown(ticketKey, linkedTCs, tracker).join('\n'));
    console.log('✅ Written linked_test_cases.md (' + linkedTCs.length + ' TCs)');
    return linkedTCs.length;
}

function parseMcpResult(result) {
    if (!result) return null;
    if (typeof result === 'string') {
        try { return JSON.parse(result); } catch (e) { return null; }
    }
    return result;
}

/**
 * Find the feature branch for ticketKey from open PRs in the featurePR repo.
 * Returns the branch name string, or null if not found.
 */
function findFeatureBranch(ticketKey, featurePR) {
    if (!featurePR || !featurePR.owner || !featurePR.repo) return null;
    try {
        var raw = github_list_prs({
            workspace: featurePR.owner,
            repository: featurePR.repo,
            state: 'open'
        });
        var match = setupHelpers.decideFeatureBranchFromPrs(
            setupHelpers.parseMcpPrList(parseMcpResult(raw)), ticketKey);
        if (match.found) {
            console.log('✅ Found feature branch:', match.branch, '(PR #' + match.prNumber + ')');
            return match.branch;
        }
        console.log('No open PR found for', ticketKey, 'in', featurePR.owner + '/' + featurePR.repo);
    } catch (e) {
        console.warn('Could not list PRs for feature branch lookup:', e);
    }
    return null;
}

/** Log the branch-match outcome of the build listing (matched vs fallback). */
function logBranchMatchOutcome(branch, branchDecision, successBuilds) {
    if (branch && successBuilds.length > 0) {
        if (branchDecision.matched) {
            console.log('✅ Found', branchDecision.builds.length, 'build(s) matching branch', branch);
        } else {
            console.warn('⚠️ No builds found with commit message matching "' + branch + '".',
                'Using latest successful build instead. Available builds:');
            var warnLines = setupHelpers.formatBuildsWarningList(successBuilds);
            for (var wi = 0; wi < warnLines.length; wi++) {
                console.warn(warnLines[wi]);
            }
        }
    }
}

/**
 * List recent builds, narrow to successful/branch-matched, and return the
 * build slug. Throws the canonical wrapped error on listing failure.
 */
function resolveBitriseBuildSlug(appSlug, workflowId, branch) {
    try {
        // Bitrise trigger branch is always "main" (for YAML source), so we
        // cannot filter by feature branch. Instead, list recent builds for the
        // workflow and match by commit message which contains the feature branch.
        var buildsResult = parseMcpResult(bitrise_list_builds({
            appSlug: appSlug,
            workflowId: workflowId,
            limit: 20
        }));
        var builds = setupHelpers.parseMcpDataList(buildsResult);

        // status=1 means success in Bitrise API
        var successBuilds = setupHelpers.decideSuccessfulBuilds(builds);

        // If we have a feature branch, find the build whose commit message
        // mentions it (e.g. "PROJ-6818 — iOS build for bug/PROJ-6818")
        var branchDecision = setupHelpers.decideBranchBuilds(successBuilds, branch);
        logBranchMatchOutcome(branch, branchDecision, successBuilds);

        var buildDecision = setupHelpers.decideBuildSlug(branchDecision.builds, workflowId);
        console.log('✅ Found build #' + buildDecision.buildNumber + ' slug:', buildDecision.slug);
        return buildDecision.slug;
    } catch (e) {
        throw new Error('Failed to list Bitrise builds: ' + e);
    }
}

/** Pick the app artifact of a build. Returns { slug, title } or null. */
function resolveBitriseArtifact(appSlug, buildSlug) {
    try {
        var artifacts = parseMcpResult(bitrise_list_build_artifacts({ appSlug: appSlug, buildSlug: buildSlug }));
        var artifactList = setupHelpers.parseMcpDataList(artifacts);
        // Find .zip or .app artifact
        var appArtifact = setupHelpers.decideAppArtifact(artifactList);
        if (!appArtifact) {
            console.warn('No artifacts found for build', buildSlug);
            return null;
        }
        console.log('📦 Found artifact:', appArtifact.title, '(' + Math.round((appArtifact.file_size_bytes || 0) / 1024 / 1024) + ' MB)');
        return { slug: appArtifact.slug, title: appArtifact.title };
    } catch (e) {
        console.warn('Failed to list artifacts:', e);
        return null;
    }
}

/** Get the expiring download URL of an artifact (null when unavailable). */
function resolveArtifactDownloadUrl(appSlug, buildSlug, artifactSlug) {
    try {
        var artifactDetails = parseMcpResult(bitrise_get_build_artifact({
            appSlug: appSlug,
            buildSlug: buildSlug,
            artifactSlug: artifactSlug
        }));
        var downloadUrl = artifactDetails && artifactDetails.data && artifactDetails.data.expiring_download_url;
        if (!downloadUrl) {
            console.warn('No download URL in artifact response');
            return null;
        }
        return downloadUrl;
    } catch (e) {
        console.warn('Failed to get artifact download URL:', e);
        return null;
    }
}

/**
 * Download the artifact zip into the input folder and unzip it there.
 * Removes the zip after a successful unzip (non-fatal if that fails).
 * Returns false when the download/unzip step failed.
 */
function downloadAndUnzipArtifact(downloadUrl, folder) {
    var appDir = folder + '/app';
    var zipPath = folder + '/app.zip';
    try {
        cli_execute_command({ command: 'bash -c "mkdir -p \'' + appDir + '\'"' });
        console.log('⬇️  Downloading artifact to', zipPath, '...');
        cli_execute_command({
            command: 'curl -s -L "' + downloadUrl + '" -o "' + zipPath + '"'
        });
        console.log('📂 Unzipping to', appDir, '...');
        cli_execute_command({ command: 'unzip -o "' + zipPath + '" -d "' + appDir + '"' });
    } catch (e) {
        console.warn('Failed to download/unzip artifact:', e);
        return false;
    }
    try { cli_execute_command({ command: 'rm -f "' + zipPath + '"' }); } catch (_) {}
    return true;
}

/** Locate the .app bundle under the unzip dir (null when not found). */
function locateAppBundlePath(appDir) {
    try {
        var findResult = cleanCommandOutput(
            cli_execute_command({ command: 'find "' + appDir + '" -name "*.app" -maxdepth 3 -type d' })
        );
        var appPath = setupHelpers.parseFindAppResult(findResult);
        if (appPath) {
            console.log('✅ iOS .app found:', appPath);
        } else if (findResult) {
            // Filter out .dSYM, pick first real .app
            console.warn('Could not find .app bundle after unzip');
        }
        return appPath;
    } catch (e) {
        console.warn('Failed to locate .app bundle:', e);
        return null;
    }
}

/** Write app_info.md for the agent prompt. */
function writeAppInfoFile(folder, workflowId, buildSlug, artifactTitle, branch, appPath) {
    var infoLines = setupHelpers.buildAppInfoMarkdown(
        workflowId, buildSlug, artifactTitle, branch, appPath, folder + '/app');
    file_write(folder + '/app_info.md', infoLines.join('\n'));
    console.log('✅ Written app_info.md' + (appPath ? ' → ' + appPath : ''));
}

/**
 * Download the latest successful iOS simulator build artifact from Bitrise.
 *
 * Looks for the most recent successful build of workflowId on the feature branch,
 * downloads the .zip artifact, unzips it, finds the .app bundle, and writes
 * input/{KEY}/app_info.md with the path for the agent prompt to use.
 *
 * @param {string} ticketKey
 * @param {string} folder       - input folder path, e.g. "input/PROJ-6618"
 * @param {object} bitriseBuild - { appSlug, workflowId }
 * @param {string} branch       - feature branch name (may be null → any branch)
 * @param {string} workingDir   - working directory for cli commands
 */
function downloadBitriseApp(ticketKey, folder, bitriseBuild, branch, workingDir) {
    if (!setupHelpers.decideBitriseBuildConfigured(bitriseBuild)) {
        console.log('No bitriseBuild config — skipping artifact download');
        return;
    }

    var appSlug = bitriseBuild.appSlug;
    var workflowId = bitriseBuild.workflowId;
    console.log('🔍 Looking for latest successful', workflowId, 'build' +
        (branch ? ' on branch ' + branch : '') + ' ...');

    // Find latest successful build
    var buildSlug = resolveBitriseBuildSlug(appSlug, workflowId, branch);

    // List artifacts
    var artifact = resolveBitriseArtifact(appSlug, buildSlug);
    if (!artifact) {
        return;
    }

    // Get expiring download URL
    var downloadUrl = resolveArtifactDownloadUrl(appSlug, buildSlug, artifact.slug);
    if (!downloadUrl) {
        return;
    }

    // Download and unzip to input folder
    if (!downloadAndUnzipArtifact(downloadUrl, folder)) {
        return;
    }

    // Find the .app bundle path
    var appPath = locateAppBundlePath(folder + '/app');

    // Write app_info.md for the agent prompt
    writeAppInfoFile(folder, workflowId, buildSlug, artifact.title, branch, appPath);
    return appPath || null;
}

/**
 * Install the .app on the already-booted iOS simulator.
 * The simulator is booted in a prior Bitrise step; SIMULATOR_UDID is in env.
 *
 * @param {string} appPath - absolute path to the .app bundle
 * @param {string} folder  - input folder for writing updated app_info.md
 * @param {string} [appId] - bundle identifier (e.g. com.example.internal.business.app)
 */
function installAppOnSimulator(appPath, folder, appId) {
    if (!appPath) {
        console.warn('No app path — skipping simulator install');
        return;
    }

    // Read SIMULATOR_UDID from env (set by the "Boot iOS simulator" Bitrise step)
    var udid = null;
    try {
        udid = cleanCommandOutput(
            cli_execute_command({ command: 'bash -c "echo $SIMULATOR_UDID"' })
        );
    } catch (_) {}

    if (!udid) {
        // Fallback: find already-booted simulator
        try {
            var simList = cleanCommandOutput(
                cli_execute_command({ command: 'xcrun simctl list devices booted' })
            );
            udid = setupHelpers.matchBootedSimulatorUdid(simList);
        } catch (e) {
            console.warn('Could not list booted simulators:', e);
        }
    }

    if (!udid) {
        console.warn('⚠️ No booted simulator found — agent will write flows only');
        return;
    }

    // Install app on the booted simulator
    try {
        cli_execute_command({ command: 'xcrun simctl install "' + udid + '" "' + appPath + '"' });
        console.log('✅ App installed on simulator:', udid);
    } catch (e) {
        console.error('Failed to install app on simulator:', e);
        return;
    }

    // Append simulator info to app_info.md
    var resolvedAppId = setupHelpers.defaultAppId(appId);
    try {
        var simInfo = setupHelpers.buildSimulatorInfoMarkdown(udid, resolvedAppId);
        var existing = '';
        try { existing = file_read({ path: folder + '/app_info.md' }) || ''; } catch (_) {}
        file_write(folder + '/app_info.md', existing + '\n' + simInfo.join('\n'));
    } catch (e) {
        console.warn('Failed to update app_info.md with simulator info:', e);
    }
}


function action(params) {
    try {
        var actualParams = params.inputFolderPath ? params : (params.jobParams || params);
        var folder = actualParams.inputFolderPath;
        var ticketKey = folder.split('/').pop();
        var config = configLoader.loadProjectConfig(params.jobParams || params);
        var customParams = (params.jobParams || params).customParams || {};
        var tracker = trackersModule.createTracker(config, customParams);

        console.log('=== Mobile test automation setup for:', ticketKey, '===');

        // Step 1: Move trigger ticket to In Development
        try {
            tracker.moveToStatus(ticketKey, STATUSES.IN_DEVELOPMENT);
            console.log('✅ Moved', ticketKey, 'to In Development');
        } catch (e) {
            console.warn('Failed to move ticket to In Development:', e);
        }

        // Step 2: Fetch linked Test Cases and write to input folder
        try {
            fetchLinkedTestCases(ticketKey, folder, tracker);
        } catch (e) {
            console.error('Failed to fetch linked test cases:', e);
        }

        // Step 3: Checkout test/{KEY} branch in automation repo
        if (config.workingDir) {
            try {
                checkoutAutomationBranch(ticketKey, config);
            } catch (e) {
                console.error('Branch checkout failed (non-fatal):', e);
            }
        } else {
            console.warn('No workingDir configured — skipping branch checkout');
        }

        // Step 4: Download Bitrise iOS simulator build artifact
        var appPath = null;
        if (customParams.bitriseBuild) {
            var featureBranch = findFeatureBranch(ticketKey, customParams.featurePR);

            // Resolve environment-specific config if available
            var envResolution = setupHelpers.resolveEnvironmentBuildConfig(
                customParams.bitriseBuild, customParams.testEnvironment || 'prod');
            var buildConfig = envResolution.buildConfig;
            if (envResolution.active) {
                console.log('🌍 Using environment:', envResolution.environment);
                // Write environment info for the agent prompt
                var envLines = setupHelpers.buildEnvironmentMarkdown(
                    envResolution.environment, buildConfig.workflowId, envResolution.envConfig);
                file_write(folder + '/environment.md', envLines.join('\n'));
                console.log('✅ Written environment.md for', envResolution.environment);
            }

            appPath = downloadBitriseApp(ticketKey, folder, buildConfig, featureBranch, config.workingDir);
        }

        // Resolve appId from environment config
        var resolvedAppId = setupHelpers.decideAppId(
            customParams.bitriseBuild, customParams.testEnvironment || 'prod');

        // Step 5: Install app on the already-booted simulator
        if (appPath) {
            installAppOnSimulator(appPath, folder, resolvedAppId);
        }

        console.log('✅ Mobile test automation setup complete for', ticketKey);

    } catch (error) {
        console.error('❌ Error in preCliMobileTestAutomationSetup:', error);
        throw error;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
