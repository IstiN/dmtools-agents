/**
 * Shared helpers for reading agent output artifacts.
 *
 * Normalization order for output files:
 * 1) outputs/<name>
 * 2) outputs/<ticketKey>/<name>                (if ticketKey provided)
 * 3) <workingDir>/outputs/<name>               (if workingDir provided)
 * 4) <workingDir>/outputs/<ticketKey>/<name>   (if workingDir + ticketKey provided)
 *
 * For absolute paths we read the path as-is.
 */

function readRaw(path) {
    if (!path) return null;
    try {
        var content = file_read({ path: path });
        if (content && content.toString().trim()) {
            return content;
        }
    } catch (e) {}
    return null;
}

function normalizeToOutputsPath(pathOrName) {
    if (!pathOrName) return '';
    if (pathOrName.indexOf('outputs/') === 0) return pathOrName;
    if (pathOrName.indexOf('/') === -1) return 'outputs/' + pathOrName;
    return pathOrName;
}

function buildOutputCandidates(pathOrName, options) {
    var opts = options || {};
    var ticketKey = opts.ticketKey;
    var workingDir = opts.workingDir;
    var normalized = normalizeToOutputsPath(pathOrName);
    var candidates = [];

    // Absolute path: use as-is first, then (optionally) also workingDir prefix if provided by caller path.
    if (normalized.indexOf('/') === 0) {
        candidates.push(normalized);
        return candidates;
    }

    candidates.push(normalized);

    if (normalized.indexOf('outputs/') === 0 && ticketKey) {
        var outputName = normalized.substring('outputs/'.length);
        candidates.push('outputs/' + ticketKey + '/' + outputName);
    }

    if (workingDir) {
        candidates.push(workingDir + '/' + normalized);
        if (normalized.indexOf('outputs/') === 0 && ticketKey) {
            var outputNameInWd = normalized.substring('outputs/'.length);
            candidates.push(workingDir + '/outputs/' + ticketKey + '/' + outputNameInWd);
        }
    }

    return candidates;
}

function readOutputFile(pathOrName, options) {
    var candidates = buildOutputCandidates(pathOrName, options);
    for (var i = 0; i < candidates.length; i++) {
        var content = readRaw(candidates[i]);
        if (content) {
            return content;
        }
    }
    return null;
}

function readOutputFileDetailed(pathOrName, options) {
    var candidates = buildOutputCandidates(pathOrName, options);
    for (var i = 0; i < candidates.length; i++) {
        var content = readRaw(candidates[i]);
        if (content) {
            return { content: content, path: candidates[i] };
        }
    }
    return null;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        normalizeToOutputsPath: normalizeToOutputsPath,
        buildOutputCandidates: buildOutputCandidates,
        readOutputFile: readOutputFile,
        readOutputFileDetailed: readOutputFileDetailed
    };
}
