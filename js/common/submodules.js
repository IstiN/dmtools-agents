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

function quoteCommitMessage(message) {
    return '"' + String(message || '')
        .replace(/"/g, '\\"')
        .replace(/[><|;`$\r\n]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() + '"';
}

function pushManagedSubmodules(options) {
    var run = options.run;
    var cleanOutput = options.cleanOutput || function(output) { return output || ''; };
    var config = options.config || {};
    var customParams = options.customParams || {};
    var ticketKey = options.ticketKey || 'Agent';

    collectManagedSubmodules(config, customParams).forEach(function(module) {
        var path = module.path;
        var branch = module.branch || module.targetBranch || 'main';

        if (!isSafeRelativePath(path)) {
            throw new Error('Unsafe managed submodule path: ' + path);
        }
        if (!isSafeRefName(branch)) {
            throw new Error('Unsafe managed submodule branch for ' + path + ': ' + branch);
        }

        var registeredPath = cleanOutput(run('git config --file .gitmodules --get-regexp "^submodule\\..*\\.path$"') || '')
            .split('\n')
            .some(function(line) {
                return line.trim().split(/\s+/)[1] === path;
            });
        if (!registeredPath) {
            throw new Error('Managed submodule path is not registered in .gitmodules: ' + path);
        }

        try {
            run('git -C ' + path + ' fetch origin ' + branch);
        } catch (e) {
            console.warn('Could not fetch managed submodule branch ' + path + ' origin/' + branch + ':', e.message || e);
        }

        var status = cleanOutput(run('git -C ' + path + ' status --porcelain') || '');
        var aheadCount = 0;
        try {
            var aheadOutput = cleanOutput(run('git -C ' + path + ' rev-list --count origin/' + branch + '..HEAD') || '');
            aheadCount = parseInt(aheadOutput, 10) || 0;
        } catch (e) {
            console.warn('Could not check managed submodule commits ahead for ' + path + ':', e.message || e);
        }

        if (!status.trim() && aheadCount === 0) {
            console.log('No managed submodule changes detected in', path);
            return;
        }

        console.log('Publishing managed submodule changes:', path, '-> origin/' + branch);
        if (config.git && config.git.authorName) {
            run('git -C ' + path + ' config user.name ' + quoteCommitMessage(config.git.authorName));
        }
        if (config.git && config.git.authorEmail) {
            run('git -C ' + path + ' config user.email ' + quoteCommitMessage(config.git.authorEmail));
        }

        if (status.trim()) {
            run('git -C ' + path + ' add .');
            var stagedStatus = cleanOutput(run('git -C ' + path + ' status --porcelain') || '');
            if (!stagedStatus.trim()) {
                console.log('Managed submodule had no committable changes after staging:', path);
            } else {
                var commitMessage = module.commitMessage || (ticketKey + ' Update ' + path + ' assets');
                run('git -C ' + path + ' commit -m ' + quoteCommitMessage(commitMessage));
            }
        }

        run('git -C ' + path + ' push origin HEAD:' + branch);
        console.log('Managed submodule pushed:', path, '-> origin/' + branch);
    });
}

module.exports = {
    collectManagedSubmodules: collectManagedSubmodules,
    pushManagedSubmodules: pushManagedSubmodules,
    isSafeRelativePath: isSafeRelativePath
};
