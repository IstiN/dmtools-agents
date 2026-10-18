function addManySubmodules(target, value) {
    if (!value) return;
    if (typeof value === 'string') {
        target.push({ path: value });
    } else if (Array.isArray(value)) {
        value.forEach(function(item) {
            addManySubmodules(target, item);
        });
    } else if (typeof value === 'object' && value.path !== undefined && value.path !== null) {
        var module = { path: String(value.path) };
        if (value.branch !== undefined && value.branch !== null) {
            module.branch = String(value.branch);
        }
        if (value.targetBranch !== undefined && value.targetBranch !== null) {
            module.targetBranch = String(value.targetBranch);
        }
        if (value.commitMessage !== undefined && value.commitMessage !== null) {
            module.commitMessage = String(value.commitMessage);
        }
        if (value.tagPrefix !== undefined && value.tagPrefix !== null) {
            module.tagPrefix = String(value.tagPrefix);
        }
        target.push(module);
    }
}

function collectManagedSubmodules(config, customParams) {
    var modules = [];
    addManySubmodules(modules, customParams && customParams.managedSubmodules);
    addManySubmodules(modules, customParams && customParams.pushSubmodules);
    addManySubmodules(modules, config && config.git && config.git.managedSubmodules);
    addManySubmodules(modules, config && config.git && config.git.pushSubmodules);

    var seen = {};
    return modules.filter(function(module) {
        if (!module || !module.path || seen[module.path]) return false;
        seen[module.path] = true;
        return true;
    });
}

function isSafeRelativePath(path) {
    return path &&
        typeof path === 'string' &&
        path !== '.' &&
        path[0] !== '/' &&
        path.indexOf('..') === -1 &&
        path.split('/').every(function(segment) {
            return segment && segment[0] !== '.';
        }) &&
        /^[A-Za-z0-9._/-]+$/.test(path);
}

function isSafeRefName(ref) {
    return ref &&
        typeof ref === 'string' &&
        ref[0] !== '-' &&
        ref.indexOf('..') === -1 &&
        /^[A-Za-z0-9._/-]+$/.test(ref);
}

function isSafeSubmoduleFilePath(path) {
    return path &&
        typeof path === 'string' &&
        path[0] !== '/' &&
        path[0] !== '-' &&
        path.indexOf('..') === -1 &&
        path.split('/').every(function(segment) { return segment; }) &&
        /^[A-Za-z0-9._/-]+$/.test(path);
}

function quoteCommitMessage(message) {
    return '"' + String(message || '')
        .replace(/"/g, '\\"')
        .replace(/[><|;`$\r\n]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() + '"';
}

function resolveStashPopConflicts(run, cleanOutput, path) {
    var unmerged = cleanOutput(run('git -C ' + path + ' diff --name-only --diff-filter=U') || '')
        .split('\n')
        .map(function(file) { return file.trim(); })
        .filter(function(file) { return file; });

    if (unmerged.length === 0) {
        var statusAfterFailedPop = cleanOutput(run('git -C ' + path + ' status --porcelain') || '');
        if (!statusAfterFailedPop.trim()) {
            try { run('git -C ' + path + ' stash drop'); } catch (dropError) {}
            return '';
        }
        throw new Error('Managed submodule stash pop failed without merge conflicts; status:\n' + statusAfterFailedPop);
    }

    unmerged.forEach(function(file) {
        if (!isSafeSubmoduleFilePath(file)) {
            throw new Error('Unsafe conflicted managed submodule file path: ' + file);
        }
        run('git -C ' + path + ' checkout --theirs -- ' + file);
        run('git -C ' + path + ' add ' + file);
    });

    try { run('git -C ' + path + ' stash drop'); } catch (dropError) {}
    return cleanOutput(run('git -C ' + path + ' status --porcelain') || '');
}

function isAncestor(run, cleanOutput, path, ancestor, descendant) {
    if (!isSafeRefName(ancestor)) {
        throw new Error('Unsafe managed submodule ancestor ref for ' + path + ': ' + ancestor);
    }
    if (!isSafeRefName(descendant)) {
        throw new Error('Unsafe managed submodule descendant ref for ' + path + ': ' + descendant);
    }

    var ancestorSha = cleanOutput(run('git -C ' + path + ' rev-parse ' + ancestor) || '').trim().split(/\r?\n/).pop();
    if (!ancestorSha) {
        throw new Error('Could not resolve managed submodule ancestor ref for ' + path + ': ' + ancestor);
    }

    var descendantSha = cleanOutput(run('git -C ' + path + ' rev-parse ' + descendant) || '').trim().split(/\r?\n/).pop();
    if (!descendantSha) {
        throw new Error('Could not resolve managed submodule descendant ref for ' + path + ': ' + descendant);
    }

    var notReachable = cleanOutput(run('git -C ' + path + ' rev-list -1 ' + ancestorSha + ' --not ' + descendantSha) || '').trim();
    return !notReachable;
}

function prepareDirtySubmoduleBranch(run, cleanOutput, path, branch) {
    var stashed = false;
    run('git -C ' + path + ' stash push -u -m ' + quoteCommitMessage('dmtools managed submodule changes'));
    stashed = true;

    try {
        run('git -C ' + path + ' checkout -B ' + branch + ' origin/' + branch);
    } finally {
        if (stashed) {
            try {
                run('git -C ' + path + ' stash pop');
            } catch (stashPopError) {
                console.warn('Managed submodule stash pop had conflicts in ' + path + ', accepting stashed agent changes:', stashPopError.message || stashPopError);
                return resolveStashPopConflicts(run, cleanOutput, path);
            }
        }
    }

    return cleanOutput(run('git -C ' + path + ' status --porcelain') || '');
}

// ── gh-1041: publish decision helpers ────────────────────────────────────────
// Extraction of the per-module publish body of pushManagedSubmodules into
// small helpers (CRAP 50.5 → split). Behaviour-preserving: the same git
// commands run in the same order with the same log lines — pinned by
// test_submodules.js characterization tests.

// branch wins over targetBranch; both missing falls back to 'main'.
function resolveModuleBranch(module) {
    return module.branch || module.targetBranch || 'main';
}

// The three publish guards: an unsafe path/branch/tagPrefix throws BEFORE any
// git command runs (same messages as the original inline checks).
function assertSafeManagedSubmoduleSpec(path, branch, tagPrefix) {
    if (!isSafeRelativePath(path)) {
        throw new Error('Unsafe managed submodule path: ' + path);
    }
    if (!isSafeRefName(branch)) {
        throw new Error('Unsafe managed submodule branch for ' + path + ': ' + branch);
    }
    if (tagPrefix && !isSafeRefName(tagPrefix)) {
        throw new Error('Unsafe managed submodule tag prefix for ' + path + ': ' + tagPrefix);
    }
}

// Pure parse of the `git config --file .gitmodules --get-regexp` capture into
// the list of registered submodule paths (second whitespace field per line).
function parseRegisteredSubmodulePaths(gitConfigOutput) {
    return (gitConfigOutput || '')
        .split('\n')
        .map(function(line) { return line.trim().split(/\s+/)[1]; })
        .filter(function(path) { return !!path; });
}

// Fetch failure is non-fatal: the publish decision works off local state.
function tryFetchManagedSubmoduleBranch(run, path, branch) {
    try {
        run('git -C ' + path + ' fetch origin ' + branch);
    } catch (e) {
        console.warn('Could not fetch managed submodule branch ' + path + ' origin/' + branch + ':', e.message || e);
    }
}

// Count of local commits not on origin/<branch>; a failing probe counts as 0.
function countCommitsAhead(run, cleanOutput, path, branch) {
    try {
        var aheadOutput = cleanOutput(run('git -C ' + path + ' rev-list --count origin/' + branch + '..HEAD') || '');
        return parseInt(aheadOutput, 10) || 0;
    } catch (e) {
        console.warn('Could not check managed submodule commits ahead for ' + path + ':', e.message || e);
        return 0;
    }
}

// Pure-ish publish decision: returns 'none' | 'included' | 'divergent' |
// 'publish' and logs the skip reason. The two ancestor probes run ONLY for a
// clean tree with commits ahead, in the original order (HEAD→remote, then
// remote→HEAD).
function decideSubmodulePublish(run, cleanOutput, path, branch, hasDirtyChanges, aheadCount) {
    if (!hasDirtyChanges && aheadCount === 0) {
        console.log('No managed submodule changes detected in', path);
        return 'none';
    }
    if (!hasDirtyChanges) {
        var remoteRef = 'origin/' + branch;
        var localIncludedInRemote = isAncestor(run, cleanOutput, path, 'HEAD', remoteRef);
        var remoteIncludedInLocal = isAncestor(run, cleanOutput, path, remoteRef, 'HEAD');

        if (localIncludedInRemote) {
            console.log('Managed submodule HEAD is already included in origin/' + branch + ', skipping publish:', path);
            return 'included';
        }

        if (aheadCount > 0 && !remoteIncludedInLocal) {
            console.log('Managed submodule has clean divergent gitlink state; skipping publish to avoid rebasing stale generated commits:', path);
            return 'divergent';
        }
    }
    return 'publish';
}

// Optional author identity for the generated commit; absent config → no calls.
function configureSubmoduleAuthor(run, path, config) {
    if (config.git && config.git.authorName) {
        run('git -C ' + path + ' config user.name ' + quoteCommitMessage(config.git.authorName));
    }
    if (config.git && config.git.authorEmail) {
        run('git -C ' + path + ' config user.email ' + quoteCommitMessage(config.git.authorEmail));
    }
}

// Stage everything and commit when staging produced committable changes.
function stageAndCommitIfNeeded(run, cleanOutput, path, commitMessage) {
    run('git -C ' + path + ' add .');
    var stagedStatus = cleanOutput(run('git -C ' + path + ' status --porcelain') || '');
    if (!stagedStatus.trim()) {
        console.log('Managed submodule had no committable changes after staging:', path);
        return;
    }
    run('git -C ' + path + ' commit -m ' + quoteCommitMessage(commitMessage));
}

// Force-tag HEAD with <tagPrefix>-<short HEAD sha> and push the tag.
function publishSubmoduleTag(run, cleanOutput, path, tagPrefix) {
    var headSha = cleanOutput(run('git -C ' + path + ' rev-parse --short=12 HEAD') || '').trim();
    if (!headSha) {
        throw new Error('Could not resolve managed submodule HEAD for tag publishing: ' + path);
    }
    var tagName = tagPrefix + '-' + headSha;
    if (!isSafeRefName(tagName)) {
        throw new Error('Unsafe managed submodule tag name for ' + path + ': ' + tagName);
    }
    run('git -C ' + path + ' tag -f ' + tagName + ' HEAD');
    run('git -C ' + path + ' push origin refs/tags/' + tagName + ':refs/tags/' + tagName + ' --force');
    console.log('Managed submodule tag pushed:', path, '->', tagName);
}

// Per-module publish body — same git commands, same order, same log lines as
// the original pushManagedSubmodules forEach body.
function pushOneManagedSubmodule(run, cleanOutput, config, ticketKey, module) {
    var path = module.path;
    var branch = resolveModuleBranch(module);
    var tagPrefix = module.tagPrefix || null;

    assertSafeManagedSubmoduleSpec(path, branch, tagPrefix);

    var registeredPaths = parseRegisteredSubmodulePaths(
        cleanOutput(run('git config --file .gitmodules --get-regexp "^submodule\\..*\\.path$"') || '')
    );
    if (registeredPaths.indexOf(path) === -1) {
        throw new Error('Managed submodule path is not registered in .gitmodules: ' + path);
    }

    tryFetchManagedSubmoduleBranch(run, path, branch);

    var status = cleanOutput(run('git -C ' + path + ' status --porcelain') || '');
    var aheadCount = countCommitsAhead(run, cleanOutput, path, branch);
    var hasDirtyChanges = !!status.trim();

    if (decideSubmodulePublish(run, cleanOutput, path, branch, hasDirtyChanges, aheadCount) !== 'publish') {
        return;
    }

    console.log('Publishing managed submodule changes:', path, '-> origin/' + branch);
    if (hasDirtyChanges) {
        status = prepareDirtySubmoduleBranch(run, cleanOutput, path, branch);
    } else if (aheadCount > 0) {
        run('git -C ' + path + ' checkout -B ' + branch + ' HEAD');
    }

    configureSubmoduleAuthor(run, path, config);

    if (status.trim()) {
        var commitMessage = module.commitMessage || (ticketKey + ' Update ' + path + ' assets');
        stageAndCommitIfNeeded(run, cleanOutput, path, commitMessage);
    }

    run('git -C ' + path + ' push origin HEAD:' + branch);
    console.log('Managed submodule pushed:', path, '-> origin/' + branch);

    if (tagPrefix) {
        publishSubmoduleTag(run, cleanOutput, path, tagPrefix);
    }
}

function pushManagedSubmodules(options) {
    var run = options.run;
    var cleanOutput = options.cleanOutput || function(output) { return output || ''; };
    var config = options.config || {};
    var customParams = options.customParams || {};
    var ticketKey = options.ticketKey || 'Agent';

    collectManagedSubmodules(config, customParams).forEach(function(module) {
        pushOneManagedSubmodule(run, cleanOutput, config, ticketKey, module);
    });
}

module.exports = {
    collectManagedSubmodules: collectManagedSubmodules,
    pushManagedSubmodules: pushManagedSubmodules,
    isSafeRelativePath: isSafeRelativePath,
    isSafeSubmoduleFilePath: isSafeSubmoduleFilePath,
    // gh-1041: publish decision helpers exposed as testable pure helpers
    resolveModuleBranch: resolveModuleBranch,
    parseRegisteredSubmodulePaths: parseRegisteredSubmodulePaths,
    decideSubmodulePublish: decideSubmodulePublish,
    countCommitsAhead: countCommitsAhead,
    configureSubmoduleAuthor: configureSubmoduleAuthor,
    stageAndCommitIfNeeded: stageAndCommitIfNeeded,
    publishSubmoduleTag: publishSubmoduleTag,
    tryFetchManagedSubmoduleBranch: tryFetchManagedSubmoduleBranch,
    assertSafeManagedSubmoduleSpec: assertSafeManagedSubmoduleSpec,
    pushOneManagedSubmodule: pushOneManagedSubmodule
};
