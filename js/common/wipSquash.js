/**
 * Shared WIP auto-save base persistence and squash helpers (gh-1472).
 *
 * Ensures interrupted and resumed development / rework legs preserve their
 * squash base across restarts, squash WIP auto-save commits cleanly (including
 * across non-fast-forward self-heal merge commits when safe), and log clear
 * warnings whenever a squash is skipped.
 */

var SHA_RE = /^[0-9a-f]{7,40}$/i;
var WIP_RE = /WIP auto-save/;

function isValidGitSha(val) {
    return SHA_RE.test(String(val || '').trim());
}

function cleanText(val) {
    return String(val || '')
        .replace(/^(warning|note):.*$/gm, '')
        .trim();
}

function readExistingBaseFile(filePath, readFn) {
    if (!filePath || typeof readFn !== 'function') return null;
    try {
        var raw = String(readFn({ path: filePath }) || '').trim();
        return raw || null;
    } catch (e) {
        return null;
    }
}

function parseLines(raw) {
    return cleanText(raw)
        .split('\n')
        .map(function (l) { return l.trim(); })
        .filter(Boolean);
}

function matchesTicketOrTarget(s, ticketKey, targetMsg) {
    if (targetMsg && s === targetMsg) return true;
    return !!(ticketKey && s.indexOf(String(ticketKey)) !== -1);
}

function isWipOrTicketSubject(subject, ticketKey, targetMsg) {
    var s = String(subject || '').trim();
    if (!s) return false;
    if (WIP_RE.test(s)) return true;
    return matchesTicketOrTarget(s, ticketKey, targetMsg);
}

function allSubjectsMatchWipOrTicket(subjects, ticketKey, targetMsg) {
    for (var i = 0; i < subjects.length; i++) {
        if (!isWipOrTicketSubject(subjects[i], ticketKey, targetMsg)) return false;
    }
    return true;
}

function rangeHasOnlyWipOrTicketCommits(runCommand, baseSha, ticketKey) {
    if (!isValidGitSha(baseSha) || typeof runCommand !== 'function') return false;
    try {
        runCommand('git merge-base --is-ancestor ' + baseSha + ' HEAD');
        var subjects = parseLines(runCommand('git log --no-merges --format=%s ' + baseSha + '..HEAD'));
        return allSubjectsMatchWipOrTicket(subjects, ticketKey, null);
    } catch (e) {
        return false;
    }
}

function parseOldestContiguousWipSha(lines) {
    var oldestWipSha = null;
    for (var i = 0; i < lines.length; i++) {
        var idx = lines[i].indexOf(':');
        if (idx === -1) break;
        if (!WIP_RE.test(lines[i].substring(idx + 1))) break;
        oldestWipSha = lines[i].substring(0, idx).trim();
    }
    return oldestWipSha;
}

function walkBackContiguousWipBase(runCommand, headSha) {
    if (!isValidGitSha(headSha) || typeof runCommand !== 'function') return headSha;
    try {
        var lines = parseLines(runCommand('git log --no-merges --format=%H:%s -50 ' + headSha));
        var oldestWipSha = parseOldestContiguousWipSha(lines);
        if (!oldestWipSha) return headSha;
        var parentSha = cleanText(runCommand('git rev-parse ' + oldestWipSha + '^'));
        return isValidGitSha(parentSha) ? parentSha : headSha;
    } catch (e) {
        return headSha;
    }
}

function canPreserveExistingBase(existing, current, runCommand, ticketKey) {
    if (!existing) return false;
    if (!current || existing === current) return true;
    return rangeHasOnlyWipOrTicketCommits(runCommand, existing, ticketKey);
}

/**
 * Resolve the base SHA to record in `<folder>/<fileName>` at setup time:
 * 1. If `<folder>/<fileName>` already exists with a valid SHA and all commits in
 *    `<existing>..HEAD` are WIP auto-save / ticket commits, preserve `<existing>`.
 * 2. Otherwise, if `currentSha` sits on top of contiguous `WIP auto-save` commits
 *    left by an interrupted run, walk back to the parent of the oldest contiguous
 *    WIP commit so the resumed run folds them too.
 * 3. Otherwise return `currentSha`.
 */
function resolvePersistedBaseHead(options) {
    var opts = options || {};
    var existing = readExistingBaseFile(opts.filePath, opts.readFn);
    var current = String(opts.currentSha || '').trim();
    if (canPreserveExistingBase(existing, current, opts.runCommand, opts.ticketKey)) {
        return existing;
    }
    if (!current) return null;
    return walkBackContiguousWipBase(opts.runCommand, current);
}

/**
 * Persist the setup base SHA into `<folder>/<fileName>` using the provided
 * runner and file hooks. Never throws; returns the written SHA or null.
 */
function persistBaseHeadFile(options) {
    var opts = options || {};
    if (!opts.folder || !opts.currentSha) return null;
    var filePath = opts.folder + '/' + (opts.fileName || 'dev_base_head.txt');
    var baseSha = resolvePersistedBaseHead({
        filePath: filePath,
        readFn: opts.readFn,
        currentSha: opts.currentSha,
        ticketKey: String(opts.folder).split('/').pop(),
        runCommand: opts.runCommand
    });
    if (baseSha && typeof opts.writeFn === 'function') {
        opts.writeFn({ path: filePath, content: String(baseSha) });
    }
    return baseSha;
}

/**
 * Rework WIP squash is enabled by default (`customParams.squashReworkWip !== false`).
 */
function isReworkWipSquashEnabled(customParams) {
    if (!customParams || customParams.squashReworkWip === undefined || customParams.squashReworkWip === null) {
        return true;
    }
    return customParams.squashReworkWip === true;
}

/**
 * True when `<base>..HEAD` contains at least one `WIP auto-save` commit and is
 * not already a single commit with `safeMessage`.
 */
function canSquashWipSubjects(subjects, safeMessage) {
    if (!subjects || subjects.length === 0) return false;
    if (subjects.length === 1 && subjects[0] === safeMessage) return false;
    for (var i = 0; i < subjects.length; i++) {
        if (WIP_RE.test(subjects[i])) return true;
    }
    return false;
}

function isSelfHealMergeSubject(subject) {
    var s = String(subject || '').trim();
    if (!s) return false;
    return /^Merge (remote-tracking )?branch /i.test(s) || WIP_RE.test(s);
}

function allMergesAreSelfHeal(runCommand, range) {
    var mergeSubjects = parseLines(runCommand('git log --merges --format=%s ' + range));
    if (mergeSubjects.length === 0) return false;
    for (var i = 0; i < mergeSubjects.length; i++) {
        if (!isSelfHealMergeSubject(mergeSubjects[i])) return false;
    }
    return true;
}

function canSquashAcrossMerges(runCommand, range, ticketKey, safeMessage) {
    try {
        if (!allMergesAreSelfHeal(runCommand, range)) return false;
        var nonMerge = parseLines(runCommand('git log --no-merges --format=%s ' + range));
        if (!allSubjectsMatchWipOrTicket(nonMerge, ticketKey, safeMessage)) return false;
        return canSquashWipSubjects(nonMerge, safeMessage);
    } catch (e) {
        return false;
    }
}

/**
 * Inspect `<range>` (`<base>..HEAD`) and return `{ subjects, skipReason }`.
 * Handles both merge-free ranges and self-heal merge ranges where every
 * non-merge commit is a WIP auto-save or belongs to `ticketKey`.
 */
function inspectSquashRange(runCommand, range, ticketKey, safeMessage) {
    var merges = cleanText(runCommand('git rev-list --merges ' + range));
    if (merges) {
        if (canSquashAcrossMerges(runCommand, range, ticketKey, safeMessage)) {
            return {
                subjects: parseLines(runCommand('git log --no-merges --format=%s ' + range)),
                skipReason: null
            };
        }
        return { subjects: [], skipReason: 'merge commit(s) present in ' + range };
    }
    var subjects = parseLines(runCommand('git log --format=%s ' + range));
    if (!canSquashWipSubjects(subjects, safeMessage)) {
        return {
            subjects: [],
            skipReason: subjects.length <= 1 ? 'no squashing needed (<= 1 commit or already clean)' : 'no WIP auto-save commit in ' + range
        };
    }
    return { subjects: subjects, skipReason: null };
}

/**
 * Inspect rework `<range>` (`<base>..HEAD`) and return `{ subjects, skipReason }`.
 */
function canSquashReworkSubjects(subjects, ticketKey, reworkMsg) {
    if (!subjects || subjects.length < 2) return false;
    if (!allSubjectsMatchWipOrTicket(subjects, ticketKey, reworkMsg)) return false;
    return canSquashWipSubjects(subjects, null);
}

function inspectReworkSquashRange(runCommand, range, ticketKey, reworkMsg) {
    var merges = cleanText(runCommand('git rev-list --merges ' + range));
    if (merges && !allMergesAreSelfHeal(runCommand, range)) {
        return { subjects: [], skipReason: 'non-self-heal merge commit in ' + range };
    }
    var cmd = merges ? 'git log --no-merges --format=%s ' + range : 'git log --format=%s ' + range;
    var subjects = parseLines(runCommand(cmd));
    if (subjects.length < 2) {
        return { subjects: [], skipReason: 'fewer than 2 commits in ' + range };
    }
    if (!canSquashReworkSubjects(subjects, ticketKey, reworkMsg)) {
        return { subjects: [], skipReason: 'foreign or non-WIP commit in ' + range };
    }
    return { subjects: subjects, skipReason: null };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        isValidGitSha: isValidGitSha,
        cleanText: cleanText,
        readExistingBaseFile: readExistingBaseFile,
        parseLines: parseLines,
        matchesTicketOrTarget: matchesTicketOrTarget,
        isWipOrTicketSubject: isWipOrTicketSubject,
        allSubjectsMatchWipOrTicket: allSubjectsMatchWipOrTicket,
        rangeHasOnlyWipOrTicketCommits: rangeHasOnlyWipOrTicketCommits,
        parseOldestContiguousWipSha: parseOldestContiguousWipSha,
        walkBackContiguousWipBase: walkBackContiguousWipBase,
        canPreserveExistingBase: canPreserveExistingBase,
        resolvePersistedBaseHead: resolvePersistedBaseHead,
        persistBaseHeadFile: persistBaseHeadFile,
        isReworkWipSquashEnabled: isReworkWipSquashEnabled,
        canSquashWipSubjects: canSquashWipSubjects,
        isSelfHealMergeSubject: isSelfHealMergeSubject,
        allMergesAreSelfHeal: allMergesAreSelfHeal,
        canSquashAcrossMerges: canSquashAcrossMerges,
        inspectSquashRange: inspectSquashRange,
        canSquashReworkSubjects: canSquashReworkSubjects,
        inspectReworkSquashRange: inspectReworkSquashRange
    };
}
