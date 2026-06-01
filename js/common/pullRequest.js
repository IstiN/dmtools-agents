/**
 * Shared GitHub PR creation helper.
 *
 * Keeps command construction, title sanitization, duplicate PR lookup, body-file
 * handling, and URL extraction in one place for all agents.
 */

function cleanCommandOutput(output) {
    if (!output) return '';
    return output.split('\n').filter(function(line) {
        return line.indexOf('Script started') === -1 &&
               line.indexOf('Script done') === -1 &&
               line.indexOf('COMMAND=') === -1 &&
               line.indexOf('COMMAND_EXIT_CODE=') === -1;
    }).join('\n').trim();
}

function sanitizeTitle(title) {
    return String(title || '')
        .replace(/\r?\n/g, ' ')
        .replace(/"/g, '\\"')
        .replace(/->/g, '→')
        .replace(/<-/g, '←')
        .replace(/[<>`|&;$]/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function extractPrUrl(output, runCommand, branchName, workingDir) {
    var cleaned = cleanCommandOutput(output);
    var urlMatch = cleaned.match(/https:\/\/github\.com\/[^\s]+/);
    if (urlMatch) return urlMatch[0];

    var prNumberMatch = cleaned.match(/#(\d+)/);
    if (prNumberMatch) {
        try {
            var remoteUrl = cleanCommandOutput(runCommand('git config --get remote.origin.url', workingDir) || '');
            var repoMatch = remoteUrl.match(/github\.com[:/]([^/?#\s]+\/[^/?#\s]+)/);
            if (repoMatch) {
                return 'https://github.com/' + repoMatch[1].replace(/\.git$/, '') + '/pull/' + prNumberMatch[1];
            }
        } catch (e) {}
    }

    try {
        var listOutput = cleanCommandOutput(
            runCommand('gh pr list --head ' + branchName + ' --json url --jq ".[0].url"', workingDir) || ''
        );
        if (listOutput && listOutput.startsWith('https://')) return listOutput;
    } catch (e) {}

    return null;
}

function defaultRunCommand(command, workingDir) {
    var args = { command: command };
    if (workingDir) args.workingDirectory = workingDir;
    return cli_execute_command(args);
}

function defaultReadFile(path) {
    try {
        var content = file_read({ path: path });
        return (content && content.trim()) ? content : null;
    } catch (e) {
        return null;
    }
}

function defaultWriteFile(path, content) {
    return file_write(path, content);
}

function quoteShellArgument(value) {
    return "'" + String(value || '').replace(/'/g, "'\"'\"'") + "'";
}

function branchContainsBase(runCommand, workingDir, baseBranch) {
    var command = 'git merge-base --is-ancestor origin/' + baseBranch + ' HEAD' +
        '; code=$?; if [ "$code" -eq 0 ]; then echo ancestor; elif [ "$code" -eq 1 ]; then echo not-ancestor; else exit "$code"; fi';
    var output = cleanCommandOutput(runCommand('bash -lc ' + quoteShellArgument(command), workingDir) || '').trim();
    var lines = output.split(/\r?\n/).map(function(line) { return line.trim(); }).filter(function(line) { return line; });
    return lines[lines.length - 1] === 'ancestor';
}

function buildOriginFetchCommand(refSpec) {
    return 'git -c fetch.recurseSubmodules=no fetch origin' + (refSpec ? ' ' + refSpec : '');
}

function readTrackedStatus(runCommand, workingDir) {
    return cleanCommandOutput(
        runCommand('git status --porcelain --ignore-submodules=dirty', workingDir) || ''
    );
}

function readStagedDiffStat(runCommand, workingDir) {
    return cleanCommandOutput(
        runCommand('git diff --cached --stat', workingDir) || ''
    );
}

function syncBranchWithBase(options) {
    options = options || {};
    var branchName = options.branchName;
    var baseBranch = options.baseBranch || 'main';
    var workingDir = options.workingDir || null;
    var runCommand = options.runCommand || defaultRunCommand;

    if (!branchName) return { success: false, error: 'branchName is required' };

    try {
        console.log('Synchronizing ' + branchName + ' with origin/' + baseBranch + ' before publishing...');
        runCommand(buildOriginFetchCommand(baseBranch), workingDir);

        var upToDate = branchContainsBase(runCommand, workingDir, baseBranch);
        if (upToDate) {
            console.log('✅ Branch already contains origin/' + baseBranch);
            return { success: true, updated: false };
        }

        var status = readTrackedStatus(runCommand, workingDir);
        if (status.trim()) {
            try {
                runCommand('git submodule update --init --recursive', workingDir);
                status = readTrackedStatus(runCommand, workingDir);
            } catch (submoduleError) {
                console.warn('Could not realign submodules before syncing with base:', submoduleError.message || submoduleError);
            }
        }
        if (status.trim()) {
            return {
                success: false,
                error: 'Cannot sync with origin/' + baseBranch + ' because the working tree is not clean:\n' + status
            };
        }

        runCommand('git merge --no-edit origin/' + baseBranch, workingDir);
        console.log('✅ Merged origin/' + baseBranch + ' into ' + branchName);
        return { success: true, updated: true };
    } catch (error) {
        var conflictFiles = [];
        try {
            var statusRaw = cleanCommandOutput(runCommand('git status --short', workingDir) || '');
            conflictFiles = statusRaw.split('\n')
                .filter(function(line) { return /^(UU|AA|DD|AU|UA|DU|UD) /.test(line.trim()); })
                .map(function(line) { return line.trim().substring(3).trim(); });
        } catch (statusError) {}

        try { runCommand('git merge --abort', workingDir); } catch (abortError) {}

        var message = error && error.message ? error.message : String(error);
        if (conflictFiles.length > 0) {
            message = 'Merge conflict while syncing with origin/' + baseBranch + ': ' + conflictFiles.join(', ');
        }
        console.warn('Could not synchronize branch with base:', message);
        return {
            success: false,
            conflict: conflictFiles.length > 0,
            conflictFiles: conflictFiles,
            error: message
        };
    }
}

function resolveBodyContent(options) {
    if (options.bodyContent) return options.bodyContent;

    var readFile = options.readFile || defaultReadFile;
    var candidates = options.bodyFileCandidates || ['outputs/response.md'];
    for (var i = 0; i < candidates.length; i++) {
        var content = readFile(candidates[i]);
        if (content) return content;
    }

    return options.defaultBody || 'Automated changes.';
}

function createPullRequest(options) {
    options = options || {};
    var branchName = options.branchName;
    var baseBranch = options.baseBranch || 'main';
    var workingDir = options.workingDir || null;
    var runCommand = options.runCommand || defaultRunCommand;
    var writeFile = options.writeFile || defaultWriteFile;

    if (!branchName) return { success: false, error: 'branchName is required' };

    try {
        var existingPr = cleanCommandOutput(
            runCommand('gh pr list --head ' + branchName + ' --json url --jq ".[0].url"', workingDir) || ''
        );
        if (existingPr && existingPr.startsWith('https://')) {
            console.log('✅ PR already exists for branch ' + branchName + ': ' + existingPr);
            return { success: true, prUrl: existingPr, alreadyExisted: true };
        }
    } catch (e) {
        console.warn('Could not check for existing PR (non-fatal):', e);
    }

    var tempBodyFile = options.tempBodyFile || 'pr_body_tmp.md';
    var tempBodyPath = workingDir ? workingDir.replace(/\/$/, '') + '/' + tempBodyFile : tempBodyFile;
    writeFile(tempBodyPath, resolveBodyContent(options));

    var command = 'gh pr create --title "' + sanitizeTitle(options.title) + '"' +
        ' --body-file "' + tempBodyFile + '"' +
        ' --base ' + baseBranch +
        ' --head ' + branchName;

    try {
        var output = runCommand(command, workingDir) || '';
        var prUrl = extractPrUrl(output, runCommand, branchName, workingDir);
        console.log('✅ Pull Request created:', prUrl || '(URL not found)');
        return { success: true, prUrl: prUrl, output: output };
    } catch (error) {
        var errMsg = error.toString();
        if (errMsg.indexOf('already exists') !== -1 || errMsg.indexOf('pull request for branch') !== -1) {
            var existingUrl = extractPrUrl('', runCommand, branchName, workingDir);
            if (existingUrl) {
                console.log('✅ Found existing PR:', existingUrl);
                return { success: true, prUrl: existingUrl, alreadyExisted: true };
            }
        }
        console.error('Failed to create Pull Request:', errMsg);
        return { success: false, error: errMsg };
    }
}

module.exports = {
    cleanCommandOutput: cleanCommandOutput,
    sanitizeTitle: sanitizeTitle,
    buildOriginFetchCommand: buildOriginFetchCommand,
    readTrackedStatus: readTrackedStatus,
    readStagedDiffStat: readStagedDiffStat,
    syncBranchWithBase: syncBranchWithBase,
    createPullRequest: createPullRequest
};
