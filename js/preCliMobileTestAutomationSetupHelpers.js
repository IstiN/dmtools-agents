/**
 * Pure helpers for js/preCliMobileTestAutomationSetup.js (gh-1034, gh-1189).
 *
 * Parse/decide/build logic extracted from action(), downloadBitriseApp(),
 * installAppOnSimulator(), fetchLinkedTestCases() and findFeatureBranch()
 * so all of them shrink below the CRAP threshold.
 * Every function here is side-effect free (console/tracker/SCM/file calls
 * stay in the caller, in the original order) and every returned string or
 * decision must stay byte-identical to the original inline logic.
 */

/**
 * Successful Bitrise builds (status=1 or status_text 'success').
 * Empty-safe: a null/absent builds array yields an empty list.
 */
function decideSuccessfulBuilds(builds) {
    var success = [];
    var list = builds || [];
    for (var i = 0; i < list.length; i++) {
        if (list[i].status === 1 || list[i].status_text === 'success') {
            success.push(list[i]);
        }
    }
    return success;
}

/**
 * Branch-filter decision over successful builds.
 * Returns { builds, matched }: when a branch is given and at least one
 * build's commit message mentions it, builds is the matched subset and
 * matched is true; otherwise builds is the input list unchanged.
 */
function decideBranchBuilds(successBuilds, branch) {
    var result = { builds: successBuilds, matched: false };
    if (branch && successBuilds.length > 0) {
        var matched = [];
        for (var i = 0; i < successBuilds.length; i++) {
            var b = successBuilds[i];
            var msg = b.commit_message || b.original_build_params_commit_message || '';
            if (msg.indexOf(branch) !== -1) {
                matched.push(b);
            }
        }
        if (matched.length > 0) {
            result.builds = matched;
            result.matched = true;
        }
    }
    return result;
}

/**
 * First build's slug/number, or throw the canonical "no successful builds"
 * error the download step has always produced.
 */
function decideBuildSlug(builds, workflowId) {
    if (!builds || builds.length === 0) {
        throw new Error('No successful ' + workflowId +
            ' builds found. Trigger a build first, then re-run this automation.');
    }
    return { slug: builds[0].slug, buildNumber: builds[0].build_number };
}

/** Warning lines listing up to 5 available builds (for the no-match warn). */
function formatBuildsWarningList(successBuilds) {
    var lines = [];
    for (var si = 0; si < Math.min(successBuilds.length, 5); si++) {
        lines.push('   #' + successBuilds[si].build_number + ': "' +
            (successBuilds[si].commit_message || '').substring(0, 80) + '"');
    }
    return lines;
}

/**
 * Pick the app artifact from a build's artifact list: the first title
 * containing .zip/.app/simulator, else the first artifact, else null
 * (only possible when the list itself is empty).
 */
function decideAppArtifact(artifactList) {
    var list = artifactList || [];
    for (var i = 0; i < list.length; i++) {
        var t = (list[i].title || '').toLowerCase();
        if (t.indexOf('.zip') !== -1 || t.indexOf('.app') !== -1 || t.indexOf('simulator') !== -1) {
            return list[i];
        }
    }
    return list.length > 0 ? list[0] : null;
}

/** First real .app path from a `find ... -name "*.app"` output (no .dSYM). */
function parseFindAppResult(findResult) {
    if (!findResult) return null;
    var lines = findResult.split('\n');
    for (var i = 0; i < lines.length; i++) {
        var l = lines[i].trim();
        if (l.length > 0 && l.indexOf('.dSYM') === -1) {
            return l;
        }
    }
    return null;
}

/** app_info.md body — byte-identical to the original inline builder. */
function buildAppInfoMarkdown(workflowId, buildSlug, artifactTitle, branch, appPath, appDir) {
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
    return lines;
}

/**
 * Environment-specific build config resolution.
 * Returns { active, environment, buildConfig, envConfig }: when the
 * bitriseBuild config carries an entry for testEnvironment, buildConfig is
 * rebuilt with the env-specific workflowId override and active is true.
 */
function resolveEnvironmentBuildConfig(bitriseBuild, testEnvironment) {
    var result = {
        active: false,
        environment: testEnvironment,
        buildConfig: bitriseBuild,
        envConfig: null
    };
    if (bitriseBuild.environments && bitriseBuild.environments[testEnvironment]) {
        var envConfig = bitriseBuild.environments[testEnvironment];
        result.active = true;
        result.envConfig = envConfig;
        result.buildConfig = {
            appSlug: bitriseBuild.appSlug,
            workflowId: envConfig.workflowId || bitriseBuild.workflowId
        };
    }
    return result;
}

/** environment.md body — byte-identical to the original inline builder. */
function buildEnvironmentMarkdown(testEnvironment, workflowId, envConfig) {
    var envLines = [];
    envLines.push('# Test Environment: ' + testEnvironment.toUpperCase() + '\n');
    envLines.push('| Setting | Value |');
    envLines.push('|---------|-------|');
    envLines.push('| Environment | ' + testEnvironment + ' |');
    envLines.push('| Bitrise Workflow | ' + workflowId + ' |');
    if (envConfig.appId) envLines.push('| APP_ID | `' + envConfig.appId + '` |');
    envLines.push('\n## Credentials\n');
    envLines.push('Login credentials are available as environment variables:');
    envLines.push('- `' + (envConfig.userEnvVar || 'TEST_USER_EMAIL') + '` — user email');
    envLines.push('- `' + (envConfig.passwordEnvVar || 'TEST_USER_PASSWORD') + '` — password');
    envLines.push('- `' + (envConfig.pinEnvVar || 'TEST_USER_PIN') + '` — PIN code');
    envLines.push('\nUse these env var names in Maestro flows for `inputText` steps.');
    return envLines;
}

/** Bundle id from the environment config, or null when not configured. */
function decideAppId(bitriseBuild, testEnvironment) {
    if (bitriseBuild && bitriseBuild.environments) {
        var ec = bitriseBuild.environments[testEnvironment];
        if (ec && ec.appId) return ec.appId;
    }
    return null;
}

/** Default mobile bundle id when the caller did not provide one. */
function defaultAppId(appId) {
    return appId || 'com.example.internal.business.app';
}

/** First booted-simulator UDID in an `xcrun simctl list devices booted` output. */
function matchBootedSimulatorUdid(simList) {
    if (!simList) return null;
    var match = simList.match(/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/);
    return match ? match[0] : null;
}

/** Simulator & Maestro block appended to app_info.md — byte-identical. */
function buildSimulatorInfoMarkdown(udid, appId) {
    return [
        '\n## Simulator & Maestro\n',
        '| Field | Value |',
        '|-------|-------|',
        '| MAESTRO_DEVICE | `' + udid + '` |',
        '| APP_ID | `' + appId + '` |',
        '',
        'The simulator is booted and the app is installed. Use `run-flow.sh` to run tests:',
        '```bash',
        'MAESTRO_DEVICE="' + udid + '" APP_ID="' + appId + '" PLATFORM=ios bash src/scripts/run-flow.sh <flow.yaml> --a11y',
        '```'
    ];
}

// ── gh-1189: linked-test-case search builders ────────────────────────────────

/** Primary search: Test Cases linked via "is tested by". */
function buildPrimaryLinkedTcJql(ticketKey) {
    return 'issue in linkedIssues("' + ticketKey + '", "is tested by") AND issuetype = "Test Case"';
}

/** Fallback search: any linked Test Cases (broader). */
function buildFallbackLinkedTcJql(ticketKey) {
    return 'issue in linkedIssues("' + ticketKey + '") AND issuetype = "Test Case"';
}

/** Search fields shared by both linked-TC queries. */
function linkedTcSearchOptions() {
    return {
        fields: ['key', 'summary', 'status', 'description', 'priority', 'labels', 'comment'],
        maxResults: 30
    };
}

/** Header lines of linked_test_cases.md — byte-identical to the inline builder. */
function buildLinkedTestCasesHeader(ticketKey) {
    return [
        '# Linked Test Cases for ' + ticketKey + '\n',
        '> Automate EVERY test case listed here.\n'
    ];
}

/** One TC section of linked_test_cases.md — byte-identical to the inline builder. */
function formatLinkedTcEntry(tc) {
    var f = tc.fields || {};
    var status = (f.status && f.status.name) || 'Unknown';
    var priority = (f.priority && f.priority.name) || 'Unknown';

    var lines = [];
    lines.push('---\n');
    lines.push('## ' + tc.key + ': ' + (f.summary || '(no summary)'));
    lines.push('**Status**: ' + status + '  **Priority**: ' + priority + '\n');

    if (f.description) {
        lines.push('**Description / Test Steps**:\n\n' + f.description + '\n');
    }
    return lines;
}

/**
 * "Recent Test Run Comments" block: the last five comments, newest last.
 * Empty list when there are no comments — the caller pushes nothing then.
 */
function formatRecentTcComments(comments) {
    var list = comments || [];
    var lines = [];
    if (list.length === 0) return lines;

    var startIdx = Math.max(0, list.length - 5);
    lines.push('**Recent Test Run Comments** (' + (list.length - startIdx) + ' of ' + list.length + '):\n');
    for (var j = startIdx; j < list.length; j++) {
        var c = list[j];
        var author = (c.author && c.author.displayName) || 'Unknown';
        var body = (c.body || '').substring(0, 2000);
        lines.push('**[' + author + ']**:\n' + body + '\n');
    }
    return lines;
}

// ── gh-1189: MCP response shape helpers ──────────────────────────────────────

/** data array of a parsed MCP-ish response (missing data → empty list). */
function parseMcpDataList(result) {
    return (result && result.data) ? result.data : [];
}

/** PR list of a parsed MCP-ish response (plain array or {data:[...] }). */
function parseMcpPrList(parsed) {
    if (Array.isArray(parsed)) return parsed;
    return (parsed && parsed.data) ? parsed.data : [];
}

/** Head ref of a PR across API shapes: head.ref, branch, source_branch. */
function prHeadRef(pr) {
    return (pr.head && pr.head.ref) ? pr.head.ref : (pr.branch || pr.source_branch || '');
}

/**
 * First open PR whose head ref mentions ticketKey.
 * Returns { found, branch, prNumber } — found=false when nothing matches.
 */
function decideFeatureBranchFromPrs(list, ticketKey) {
    var prs = list || [];
    for (var i = 0; i < prs.length; i++) {
        var head = prHeadRef(prs[i]);
        if (head.indexOf(ticketKey) !== -1) {
            return { found: true, branch: head, prNumber: prs[i].number };
        }
    }
    return { found: false, branch: null, prNumber: null };
}

/** True when the bitriseBuild config carries appSlug AND workflowId. */
function decideBitriseBuildConfigured(bitriseBuild) {
    return !!(bitriseBuild && bitriseBuild.appSlug && bitriseBuild.workflowId);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        decideSuccessfulBuilds: decideSuccessfulBuilds,
        decideBranchBuilds: decideBranchBuilds,
        decideBuildSlug: decideBuildSlug,
        formatBuildsWarningList: formatBuildsWarningList,
        decideAppArtifact: decideAppArtifact,
        parseFindAppResult: parseFindAppResult,
        buildAppInfoMarkdown: buildAppInfoMarkdown,
        resolveEnvironmentBuildConfig: resolveEnvironmentBuildConfig,
        buildEnvironmentMarkdown: buildEnvironmentMarkdown,
        decideAppId: decideAppId,
        defaultAppId: defaultAppId,
        matchBootedSimulatorUdid: matchBootedSimulatorUdid,
        buildSimulatorInfoMarkdown: buildSimulatorInfoMarkdown,
        buildPrimaryLinkedTcJql: buildPrimaryLinkedTcJql,
        buildFallbackLinkedTcJql: buildFallbackLinkedTcJql,
        linkedTcSearchOptions: linkedTcSearchOptions,
        buildLinkedTestCasesHeader: buildLinkedTestCasesHeader,
        formatLinkedTcEntry: formatLinkedTcEntry,
        formatRecentTcComments: formatRecentTcComments,
        parseMcpDataList: parseMcpDataList,
        parseMcpPrList: parseMcpPrList,
        prHeadRef: prHeadRef,
        decideFeatureBranchFromPrs: decideFeatureBranchFromPrs,
        decideBitriseBuildConfigured: decideBitriseBuildConfigured
    };
}
