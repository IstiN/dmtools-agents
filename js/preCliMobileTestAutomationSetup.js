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
const { STATUSES } = require('./config.js');

function cleanCommandOutput(output) {
    if (!output) return '';
    return output.split('\n').filter(function(line) {
        return line.indexOf('Script started') === -1 &&
               line.indexOf('Script done') === -1 &&
               line.indexOf('COMMAND=') === -1 &&
               line.indexOf('COMMAND_EXIT_CODE=') === -1;
    }).join('\n').trim();
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
        runInRepo('git fetch origin --prune', workingDir);
    } catch (e) {
        console.warn('Could not fetch remote branches:', e);
    }

    var localBranches = cleanCommandOutput(
        runInRepo('git branch --list "' + branchName + '"', workingDir) || ''
    );

    function syncWithBase() {
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
        var remoteBranches = cleanCommandOutput(
            runInRepo('git ls-remote --heads origin ' + branchName, workingDir) || ''
        );

        if (remoteBranches.trim()) {
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

/** Fetch all Test Cases linked via "is tested by" and write to input folder. */
function fetchLinkedTestCases(ticketKey, folder) {
    var linkedTCs = [];

    // Primary: "is tested by" relationship
    try {
        linkedTCs = jira_search_by_jql({
            jql: 'issue in linkedIssues("' + ticketKey + '", "is tested by") AND issuetype = "Test Case"',
            fields: ['key', 'summary', 'status', 'description', 'priority', 'labels', 'comment'],
            maxResults: 30
        });
    } catch (e) {
        console.warn('Primary JQL failed, trying fallback:', e);
    }

    // Fallback: any linked test cases (broader search)
    if (!linkedTCs || linkedTCs.length === 0) {
        try {
            linkedTCs = jira_search_by_jql({
                jql: 'issue in linkedIssues("' + ticketKey + '") AND issuetype = "Test Case"',
                fields: ['key', 'summary', 'status', 'description', 'priority', 'labels', 'comment'],
                maxResults: 30
            });
        } catch (e2) {
            console.warn('Fallback JQL also failed:', e2);
        }
    }

    if (!linkedTCs || linkedTCs.length === 0) {
        console.log('No linked test cases found for', ticketKey);
        file_write(folder + '/linked_test_cases.md',
            '# Linked Test Cases\n\nNo linked Test Case tickets found for ' + ticketKey + '.\n');
        return 0;
    }

    console.log('Found', linkedTCs.length, 'linked test case(s)');

    var lines = [];
    lines.push('# Linked Test Cases for ' + ticketKey + '\n');
    lines.push('> Automate EVERY test case listed here.\n');

    for (var i = 0; i < linkedTCs.length; i++) {
        var tc = linkedTCs[i];
        var f = tc.fields || {};
        var status = (f.status && f.status.name) || 'Unknown';
        var priority = (f.priority && f.priority.name) || 'Unknown';

        lines.push('---\n');
        lines.push('## ' + tc.key + ': ' + (f.summary || '(no summary)'));
        lines.push('**Status**: ' + status + '  **Priority**: ' + priority + '\n');

        if (f.description) {
            lines.push('**Description / Test Steps**:\n\n' + f.description + '\n');
        }

        // Fetch full ticket for comments (run history, prior failures)
        try {
            var tcDetails = jira_get_ticket({ key: tc.key });
            var tcFields = tcDetails && tcDetails.fields || {};
            var commentBlock = tcFields.comment;
            var comments = commentBlock && commentBlock.comments || [];

            if (comments.length > 0) {
                var startIdx = Math.max(0, comments.length - 5);
                lines.push('**Recent Test Run Comments** (' + (comments.length - startIdx) + ' of ' + comments.length + '):\n');
                for (var j = startIdx; j < comments.length; j++) {
                    var c = comments[j];
                    var author = (c.author && c.author.displayName) || 'Unknown';
                    var body = (c.body || '').substring(0, 2000);
                    lines.push('**[' + author + ']**:\n' + body + '\n');
                }
            }
        } catch (ce) {
            console.warn('Could not fetch comments for', tc.key + ':', ce);
        }
    }

    file_write(folder + '/linked_test_cases.md', lines.join('\n'));
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
        var parsed = parseMcpResult(raw);
        var list = Array.isArray(parsed) ? parsed : (parsed && parsed.data ? parsed.data : []);
        for (var i = 0; i < list.length; i++) {
            var pr = list[i];
            var head = pr.head && pr.head.ref ? pr.head.ref : (pr.branch || pr.source_branch || '');
            if (head.indexOf(ticketKey) !== -1) {
                console.log('✅ Found feature branch:', head, '(PR #' + pr.number + ')');
                return head;
            }
        }
        console.log('No open PR found for', ticketKey, 'in', featurePR.owner + '/' + featurePR.repo);
    } catch (e) {
        console.warn('Could not list PRs for feature branch lookup:', e);
    }
    return null;
}

/**
 * Download the latest successful iOS simulator build artifact from Bitrise.
 *
 * Looks for the most recent successful build of workflowId on the feature branch,
 * downloads the .zip artifact, unzips it, finds the .app bundle, and writes
 * input/{KEY}/app_info.md with the path for the agent prompt to use.
 *
 * @param {string} ticketKey
 * @param {string} folder       - input folder path, e.g. "input/MAPC-6618"
 * @param {object} bitriseBuild - { appSlug, workflowId }
 * @param {string} branch       - feature branch name (may be null → any branch)
 * @param {string} workingDir   - working directory for cli commands
 */
function downloadBitriseApp(ticketKey, folder, bitriseBuild, branch, workingDir) {
    if (!bitriseBuild || !bitriseBuild.appSlug || !bitriseBuild.workflowId) {
        console.log('No bitriseBuild config — skipping artifact download');
        return;
    }

    var appSlug = bitriseBuild.appSlug;
    var workflowId = bitriseBuild.workflowId;
    console.log('🔍 Looking for latest successful', workflowId, 'build' +
        (branch ? ' on branch ' + branch : '') + ' ...');

    // Find latest successful build
    var buildSlug = null;
    try {
        var listParams = {
            appSlug: appSlug,
            workflowId: workflowId,
            limit: 10
        };
        if (branch) listParams.branch = branch;

        var buildsResult = parseMcpResult(bitrise_list_builds(listParams));
        var builds = buildsResult && buildsResult.data ? buildsResult.data : [];

        // status=1 means success in Bitrise API
        var successBuilds = builds.filter(function(b) { return b.status === 1 || b.status_text === 'success'; });
        if (successBuilds.length === 0 && branch) {
            // Fallback: try without branch filter but warn loudly
            console.warn('⚠️ No successful builds on branch', branch,
                '— falling back to latest build from ANY branch.',
                'Ensure the build was triggered with the correct branch (not main).');
            var fallbackResult = parseMcpResult(bitrise_list_builds({ appSlug: appSlug, workflowId: workflowId, limit: 10 }));
            var fallbackBuilds = fallbackResult && fallbackResult.data ? fallbackResult.data : [];
            successBuilds = fallbackBuilds.filter(function(b) { return b.status === 1 || b.status_text === 'success'; });
            if (successBuilds.length > 0) {
                var fb = successBuilds[0];
                console.warn('⚠️ Using build #' + fb.build_number + ' from branch "' +
                    (fb.branch || 'unknown') + '" (requested: "' + branch + '")');
            }
        }

        if (successBuilds.length === 0) {
            throw new Error('No successful ' + workflowId + ' builds found for branch ' + (branch || 'any') + '. Trigger a build first, then re-run this automation.');
        }
        buildSlug = successBuilds[0].slug;
        console.log('✅ Found build #' + successBuilds[0].build_number + ' slug:', buildSlug);
    } catch (e) {
        throw new Error('Failed to list Bitrise builds: ' + e);
    }

    // List artifacts
    var artifactSlug = null;
    var artifactTitle = null;
    try {
        var artifacts = parseMcpResult(bitrise_list_build_artifacts({ appSlug: appSlug, buildSlug: buildSlug }));
        var artifactList = artifacts && artifacts.data ? artifacts.data : [];
        // Find .zip or .app artifact
        var appArtifact = null;
        for (var ai = 0; ai < artifactList.length; ai++) {
            var t = (artifactList[ai].title || '').toLowerCase();
            if (t.indexOf('.zip') !== -1 || t.indexOf('.app') !== -1 || t.indexOf('simulator') !== -1) {
                appArtifact = artifactList[ai];
                break;
            }
        }
        if (!appArtifact && artifactList.length > 0) appArtifact = artifactList[0];
        if (!appArtifact) {
            console.warn('No artifacts found for build', buildSlug);
            return;
        }
        artifactSlug = appArtifact.slug;
        artifactTitle = appArtifact.title;
        console.log('📦 Found artifact:', artifactTitle, '(' + Math.round((appArtifact.file_size_bytes || 0) / 1024 / 1024) + ' MB)');
    } catch (e) {
        console.warn('Failed to list artifacts:', e);
        return;
    }

    // Get expiring download URL
    var downloadUrl = null;
    try {
        var artifactDetails = parseMcpResult(bitrise_get_build_artifact({
            appSlug: appSlug,
            buildSlug: buildSlug,
            artifactSlug: artifactSlug
        }));
        downloadUrl = artifactDetails && artifactDetails.data && artifactDetails.data.expiring_download_url;
        if (!downloadUrl) {
            console.warn('No download URL in artifact response');
            return;
        }
    } catch (e) {
        console.warn('Failed to get artifact download URL:', e);
        return;
    }

    // Download and unzip to input folder
    var appDir = folder + '/app';
    var zipPath = folder + '/app.zip';
    try {
        cli_execute_command({ command: 'mkdir -p "' + appDir + '"' });
        console.log('⬇️  Downloading artifact to', zipPath, '...');
        cli_execute_command({
            command: 'curl -s -L "' + downloadUrl + '" -o "' + zipPath + '"'
        });
        console.log('📂 Unzipping to', appDir, '...');
        cli_execute_command({ command: 'unzip -o "' + zipPath + '" -d "' + appDir + '"' });
    } catch (e) {
        console.warn('Failed to download/unzip artifact:', e);
        return;
    }
    // Remove zip after successful unzip (non-fatal if it fails)
    try { cli_execute_command({ command: 'rm -f "' + zipPath + '"' }); } catch (_) {}

    // Find the .app bundle path
    var appPath = null;
    try {
        var findResult = cleanCommandOutput(
            cli_execute_command({ command: 'find "' + appDir + '" -name "*.app" -maxdepth 3 -type d' })
        );
        if (findResult) {
            // Filter out .dSYM, pick first real .app
            var lines = findResult.split('\n').map(function(l) { return l.trim(); }).filter(function(l) {
                return l.length > 0 && l.indexOf('.dSYM') === -1;
            });
            if (lines.length > 0) {
                appPath = lines[0];
                console.log('✅ iOS .app found:', appPath);
            } else {
                console.warn('Could not find .app bundle after unzip');
            }
        }
    } catch (e) {
        console.warn('Failed to locate .app bundle:', e);
    }

    // Write app_info.md for the agent prompt
    var lines = [];
    lines.push('# iOS App Build Info\n');
    lines.push('The iOS simulator app has been downloaded from Bitrise and is ready to use.\n');
    lines.push('| Field | Value |');
    lines.push('|-------|-------|');
    lines.push('| Bitrise Workflow | ' + workflowId + ' |');
    lines.push('| Build Slug | ' + buildSlug + ' |');
    lines.push('| Artifact | ' + artifactTitle + ' |');
    if (branch) lines.push('| Branch | ' + branch + ' |');
    if (appPath) {
        lines.push('| App Path | `' + appPath + '` |');
        lines.push('\n## How to use\n');
        lines.push('Set `APP_PATH` environment variable or pass `--app-path` to Maestro:\n');
        lines.push('```bash');
        lines.push('export APP_PATH="' + appPath + '"');
        lines.push('maestro test --app-path "$APP_PATH" src/flows/...');
        lines.push('```');
    } else {
        lines.push('| App Dir | `' + appDir + '` |');
        lines.push('\n> ⚠️ Unzipped to `' + appDir + '` — locate the `.app` bundle manually.');
    }
    file_write(folder + '/app_info.md', lines.join('\n'));
    console.log('✅ Written app_info.md' + (appPath ? ' → ' + appPath : ''));
    return appPath || null;
}

/**
 * Install the .app on the already-booted iOS simulator.
 * The simulator is booted in a prior Bitrise step; SIMULATOR_UDID is in env.
 *
 * @param {string} appPath - absolute path to the .app bundle
 * @param {string} folder  - input folder for writing updated app_info.md
 * @param {string} [appId] - bundle identifier (e.g. com.postnl.internal.business.customer)
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
            var match = simList.match(/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/);
            if (match) udid = match[0];
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
    var resolvedAppId = appId || 'com.postnl.internal.business.customer';
    try {
        var simInfo = [
            '\n## Simulator & Maestro\n',
            '| Field | Value |',
            '|-------|-------|',
            '| MAESTRO_DEVICE | `' + udid + '` |',
            '| APP_ID | `' + resolvedAppId + '` |',
            '',
            'The simulator is booted and the app is installed. Use `run-flow.sh` to run tests:',
            '```bash',
            'MAESTRO_DEVICE="' + udid + '" APP_ID="' + resolvedAppId + '" PLATFORM=ios bash src/scripts/run-flow.sh <flow.yaml> --a11y',
            '```'
        ];
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

        console.log('=== Mobile test automation setup for:', ticketKey, '===');

        // Step 1: Move trigger ticket to In Development
        try {
            jira_move_to_status({ key: ticketKey, statusName: STATUSES.IN_DEVELOPMENT });
            console.log('✅ Moved', ticketKey, 'to In Development');
        } catch (e) {
            console.warn('Failed to move ticket to In Development:', e);
        }

        // Step 2: Fetch linked Test Cases and write to input folder
        try {
            fetchLinkedTestCases(ticketKey, folder);
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
            var buildConfig = customParams.bitriseBuild;
            var testEnvironment = customParams.testEnvironment || 'prod';
            if (buildConfig.environments && buildConfig.environments[testEnvironment]) {
                var envConfig = buildConfig.environments[testEnvironment];
                console.log('🌍 Using environment:', testEnvironment);
                // Override workflowId from environment config
                buildConfig = {
                    appSlug: buildConfig.appSlug,
                    workflowId: envConfig.workflowId || buildConfig.workflowId
                };
                // Write environment info for the agent prompt
                var envLines = [];
                envLines.push('# Test Environment: ' + testEnvironment.toUpperCase() + '\n');
                envLines.push('| Setting | Value |');
                envLines.push('|---------|-------|');
                envLines.push('| Environment | ' + testEnvironment + ' |');
                envLines.push('| Bitrise Workflow | ' + buildConfig.workflowId + ' |');
                if (envConfig.appId) envLines.push('| APP_ID | `' + envConfig.appId + '` |');
                envLines.push('\n## Credentials\n');
                envLines.push('Login credentials are available as environment variables:');
                envLines.push('- `' + (envConfig.userEnvVar || 'TEST_USER_EMAIL') + '` — user email');
                envLines.push('- `' + (envConfig.passwordEnvVar || 'TEST_USER_PASSWORD') + '` — password');
                envLines.push('- `' + (envConfig.pinEnvVar || 'TEST_USER_PIN') + '` — PIN code');
                envLines.push('\nUse these env var names in Maestro flows for `inputText` steps.');
                file_write(folder + '/environment.md', envLines.join('\n'));
                console.log('✅ Written environment.md for', testEnvironment);
            }

            appPath = downloadBitriseApp(ticketKey, folder, buildConfig, featureBranch, config.workingDir);
        }

        // Resolve appId from environment config
        var resolvedAppId = null;
        if (customParams.bitriseBuild && customParams.bitriseBuild.environments) {
            var testEnv = customParams.testEnvironment || 'prod';
            var ec = customParams.bitriseBuild.environments[testEnv];
            if (ec && ec.appId) resolvedAppId = ec.appId;
        }

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
