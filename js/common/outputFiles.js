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
    if (pathOrName.indexOf('/') === 0) return pathOrName;
    if (pathOrName.indexOf('outputs/') === 0) return pathOrName;
    return 'outputs/' + pathOrName;
}

function addOutputsCandidates(candidates, outputsPath, ticketKey, workingDir) {
    candidates.push(outputsPath);
    var outputName = outputsPath.substring('outputs/'.length);
    if (ticketKey) {
        candidates.push('outputs/' + ticketKey + '/' + outputName);
    }
    if (!workingDir) return;
    candidates.push(workingDir + '/' + outputsPath);
    if (ticketKey) {
        candidates.push(workingDir + '/outputs/' + ticketKey + '/' + outputName);
    }
}

function addDirectRelativeCandidates(candidates, rawPath, normalized, workingDir) {
    if (!rawPath || rawPath === normalized) return;
    candidates.push(rawPath);
    if (workingDir) {
        candidates.push(workingDir + '/' + rawPath);
    }
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

    addOutputsCandidates(candidates, normalized, ticketKey, workingDir);
    addDirectRelativeCandidates(candidates, pathOrName, normalized, workingDir);

    return candidates;
    return candidates;
}

/** The shared candidate scan of readOutputFile/readOutputFileDetailed
 * (gh-1248): first non-empty read wins, returned with the path it hit. */
function readFirstCandidate(candidates) {
    for (var i = 0; i < candidates.length; i++) {
        var content = readRaw(candidates[i]);
        if (content) {
            return { content: content, path: candidates[i] };
        }
    }
    return null;
}

function readOutputFile(pathOrName, options) {
    var hit = readFirstCandidate(buildOutputCandidates(pathOrName, options));
    return hit ? hit.content : null;
}

/**
 * Read a description markdown file, falling back to the entry summary when the
 * file is missing, empty or unreadable (gh-1245: shared by the intake and
 * question-creation post-actions).
 */
function readDescriptionFile(filePath, fallbackSummary) {
    if (!filePath) {
        return fallbackSummary || '';
    }
    try {
        var content = file_read(filePath);
        if (content && content.trim() !== '') {
            return content;
        }
    } catch (error) {
        console.warn('Could not read description file ' + filePath + ':', error);
    }
    return fallbackSummary || '';
}

/**
 * Canonical existence/blank check over the same candidate expansion as
 * readOutputFile — callers that only need "is the deliverable present with
 * content?" use this instead of growing their own boolean read wrappers.
 */
function hasOutputFile(pathOrName, options) {
    return !!readOutputFile(pathOrName, options);
}

function readOutputFileDetailed(pathOrName, options) {
    return readFirstCandidate(buildOutputCandidates(pathOrName, options));
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        normalizeToOutputsPath: normalizeToOutputsPath,
        buildOutputCandidates: buildOutputCandidates,
        readOutputFile: readOutputFile,
        hasOutputFile: hasOutputFile,
        readDescriptionFile: readDescriptionFile,
        readOutputFileDetailed: readOutputFileDetailed
    };
}
