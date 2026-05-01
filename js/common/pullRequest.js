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
            var repoMatch = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/);
            if (repoMatch) {
                return 'https://github.com/' + repoMatch[1].replace('.git', '') + '/pull/' + prNumberMatch[1];
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
    createPullRequest: createPullRequest
};
