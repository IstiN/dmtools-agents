/**
 * Session Delta for Teammate Legs (gh-1064).
 *
 * Computes a deterministic change snapshot and delta across resumed teammate
 * legs so a resumed session receives an inline "what changed since your last
 * leg" composite in its resume prompt instead of re-reading everything from
 * scratch or trusting stale memory.
 *
 * Pure + GraalJS/Node dual-runtime compatible (`var`, plain functions).
 * Every helper is decomposed to keep cyclomatic complexity <= 6 (CRAP <= 8).
 */
'use strict';

var MANIFEST_FILENAME = '.session-input-manifest.json';
var PENDING_MANIFEST_FILENAME = '.pending-input-manifest.json';
var SESSION_DELTA_FILENAME = 'session_delta.md';
var EXCLUDED_SNAPSHOT_FILES = {
    '.pending-input-manifest.json': true,
    '.session-input-manifest.json': true,
    'session_delta.md': true
};
var SESSION_GROUP_MAP = {
    'story_development': 'dev-write',
    'bug_development': 'dev-write',
    'pr_rework': 'dev-write',
    'pr_review': 'dev-review',
    'test_case_automation': 'test-write',
    'pr_test_automation_rework': 'test-write',
    'pr_test_automation_review': 'test-review'
};

function readEnvOverride(name, options) {
    if (!options || !options.env) return null;
    if (!Object.prototype.hasOwnProperty.call(options.env, name)) return null;
    var val = options.env[name];
    return val === undefined || val === null ? '' : String(val);
}

function readRuntimeEnv(name) {
    try {
        var jv = java.lang.System.getenv(name);
        if (jv !== null && jv !== undefined) return String(jv);
    } catch (e) {}
    try {
        if (process.env[name] !== undefined) return String(process.env[name]);
    } catch (e2) {}
    return '';
}

function readEnv(name, options) {
    var override = readEnvOverride(name, options);
    return override !== null ? override : readRuntimeEnv(name);
}

function slugifySegment(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');
}

function stripConfigPathToStem(raw) {
    if (raw.indexOf('/.dmtools/packs/') !== -1) {
        return raw.split('/.dmtools/packs/')[1].split('/')[0].replace(/-[0-9].*$/, '');
    }
    return raw.replace(/^.*\//, '').replace(/\.json$/, '');
}

function sessionGroupForConfig(configValue) {
    var stem = stripConfigPathToStem(String(configValue || ''));
    var slug = slugifySegment(stem || 'pr_rework') || 'dev-write';
    return SESSION_GROUP_MAP[slug] || slug;
}

function padHex8(num) {
    var hex = (num >>> 0).toString(16);
    while (hex.length < 8) hex = '0' + hex;
    return hex;
}

function hashContent(content) {
    var text = String(content === null || content === undefined ? '' : content);
    var h1 = 0x811c9dc5;
    var h2 = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
        var c = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193);
        h2 = Math.imul(h2 ^ ((c >>> 8) ^ (i & 0xff)), 0x01000193);
    }
    return 'fnv1a64:' + padHex8(h1) + padHex8(h2);
}

function readFileSafe(path, options) {
    if (options && typeof options.readFile === 'function') {
        return options.readFile(path);
    }
    try {
        return file_read({ path: path });
    } catch (e) {
        return null;
    }
}

function writeFileSafe(path, content, options) {
    if (options && typeof options.writeFile === 'function') {
        return options.writeFile(path, content);
    }
    try {
        file_write({ path: path, content: content });
        return true;
    } catch (e) {
        return false;
    }
}

function parseFileListResponse(raw) {
    if (!raw) return [];
    var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) return parsed;
    return (parsed && Array.isArray(parsed.entries)) ? parsed.entries : [];
}

function listDirSafe(dirPath, options) {
    if (options && typeof options.listFiles === 'function') {
        return options.listFiles(dirPath) || [];
    }
    try {
        return parseFileListResponse(file_list({ path: dirPath }));
    } catch (e) {
        return [];
    }
}

function trimTrailingSlashes(value) {
    return String(value || '').replace(/\/+$/, '');
}

function firstNonEmptyEnv(names, ctx) {
    for (var i = 0; i < names.length; i++) {
        var val = readEnv(names[i], ctx).trim();
        if (val) return val;
    }
    return '';
}

function resolveDefaultSessionSubpath(ctx) {
    var repo = ctx.repo || firstNonEmptyEnv(['GITHUB_REPOSITORY'], ctx) || 'local';
    var key = ctx.ticketKey || firstNonEmptyEnv([
        'AI_TEAMMATE_DISPLAY_KEY', 'DISPLAY_KEY', 'AI_TEAMMATE_CONCURRENCY_KEY'
    ], ctx) || 'local';
    var cfg = ctx.configFile || firstNonEmptyEnv(['AI_TEAMMATE_CONFIG_FILE', 'CONFIG_FILE'], ctx) || 'pr_rework';
    var group = ctx.sessionGroup || sessionGroupForConfig(cfg);
    return '.dmtools/fa-sessions/' +
        slugifySegment(repo) + '/' +
        slugifySegment(key) + '/' +
        slugifySegment(group);
}

function resolveSessionStateDir(ctx) {
    ctx = ctx || {};
    if (ctx.sessionStateDir) return trimTrailingSlashes(ctx.sessionStateDir);
    var envDir = firstNonEmptyEnv([
        'FA_SESSION_ROOT', 'COPILOT_HOME', 'KIMI_CODE_HOME', 'CURSOR_SESSION_CACHE_PATH'
    ], ctx);
    if (envDir) return trimTrailingSlashes(envDir);
    var ws = trimTrailingSlashes(ctx.workspace || readEnv('GITHUB_WORKSPACE', ctx));
    var prefix = ws ? ws + '/' : '';
    return prefix + resolveDefaultSessionSubpath(ctx);
}

function isNonManifestEntry(entryPath) {
    var base = String(entryPath || '').replace(/^.*\//, '');
    return Boolean(base) && !EXCLUDED_SNAPSHOT_FILES[base];
}

function hasActiveSessionOnDisk(ctx) {
    ctx = ctx || {};
    if (typeof ctx.hasActiveSession === 'boolean') return ctx.hasActiveSession;
    var entries = listDirSafe(resolveSessionStateDir(ctx), ctx);
    if (entries.some(isNonManifestEntry)) return true;
    var claudeId = readFileSafe('.claude-session-id', ctx);
    return Boolean(claudeId && String(claudeId).trim());
}

function parseManifestJson(raw) {
    try {
        var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!parsed || typeof parsed !== 'object' || !parsed.files) {
            return { status: 'CORRUPT', manifest: null, error: 'Invalid manifest schema' };
        }
        return { status: 'OK', manifest: parsed };
    } catch (e) {
        return { status: 'CORRUPT', manifest: null, error: String(e && e.message ? e.message : e) };
    }
}

function serializeManifest(manifest) {
    return typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2);
}

function readManifestFromSessionDir(ctx) {
    ctx = ctx || {};
    if (!hasActiveSessionOnDisk(ctx)) {
        return { status: 'NO_ACTIVE_SESSION', manifest: null };
    }
    var raw = readFileSafe(resolveSessionStateDir(ctx) + '/' + MANIFEST_FILENAME, ctx);
    if (!raw || !String(raw).trim()) {
        return { status: 'MISSING', manifest: null };
    }
    return parseManifestJson(raw);
}

function writeManifestToSessionDir(ctx, manifest) {
    ctx = ctx || {};
    return writeFileSafe(resolveSessionStateDir(ctx) + '/' + MANIFEST_FILENAME, serializeManifest(manifest), ctx);
}

function writePendingManifestToInput(ctx, manifest) {
    var folder = trimTrailingSlashes(ctx && ctx.inputFolder);
    if (!folder) return false;
    return writeFileSafe(folder + '/' + PENDING_MANIFEST_FILENAME, serializeManifest(manifest), ctx);
}

function commitPendingManifestToSession(ctx) {
    var folder = trimTrailingSlashes(ctx && ctx.inputFolder);
    if (!folder) return false;
    var raw = readFileSafe(folder + '/' + PENDING_MANIFEST_FILENAME, ctx);
    if (!raw || !String(raw).trim()) return false;
    return writeManifestToSessionDir(ctx, raw);
}

var defaultDeltaStorage = {
    resolveSessionStateDir: resolveSessionStateDir,
    hasActiveSessionOnDisk: hasActiveSessionOnDisk,
    readManifest: readManifestFromSessionDir,
    writeManifest: writeManifestToSessionDir,
    writePendingManifest: writePendingManifestToInput,
    commitPendingManifest: commitPendingManifestToSession
};

function resolveStorageAdapter(options) {
    if (options && options.storageAdapter) {
        return Object.assign({}, defaultDeltaStorage, options.storageAdapter);
    }
    return defaultDeltaStorage;
}

function matchSingleGroup(regex, text) {
    var m = regex.exec(text);
    return m ? m[1].trim() : null;
}

function parseLabelsLine(text) {
    var raw = matchSingleGroup(/- \*\*Labels\*\*:\s*([^\n]+)/, text);
    if (!raw) return [];
    return raw.split(',').map(function(s) {
        return s.replace(/`/g, '').trim();
    }).filter(Boolean);
}

function parsePrInfoMd(content) {
    var text = String(content || '');
    var branchMatch = /- \*\*Branch\*\*:\s*`([^`]+)`\s*(?:→|->)\s*`([^`]+)`/.exec(text);
    return {
        headBranch: branchMatch ? branchMatch[1] : null,
        baseBranch: branchMatch ? branchMatch[2] : null,
        headSha: matchSingleGroup(/- \*\*Head SHA\*\*:\s*`?([0-9a-fA-F]{6,40})`?/i, text),
        state: matchSingleGroup(/- \*\*State\*\*:\s*([^\n]+)/, text),
        labels: parseLabelsLine(text)
    };
}

function parseReviewStateMd(content) {
    return matchSingleGroup(/\*\*Review decision:\s*`([^`]+)`\*\*/, String(content || ''));
}

function extractCommentAuthor(obj) {
    if (obj.author) return String(obj.author);
    if (obj.user && obj.user.login) return String(obj.user.login);
    return 'unknown';
}

function extractCommentDates(obj) {
    var created = String(obj.createdAt || obj.created_at || obj.date || '');
    var updated = String(obj.updatedAt || obj.updated_at || created);
    return { createdAt: created, updatedAt: updated };
}

function extractThreadId(t, idx) {
    return String(t.threadId || t.discussionId || t.rootCommentId || t.id || ('thread-' + idx));
}

function formatThreadLocation(t) {
    if (!t.path) return '';
    return t.path + (t.line ? ':' + t.line : '');
}

function normalizeReplyItem(reply, idx, parentId, location, resolved) {
    var dates = extractCommentDates(reply);
    var replyId = String(reply.id || reply.databaseId || (parentId + '#reply-' + idx));
    return {
        id: replyId,
        kind: 'thread_reply',
        parentThreadId: parentId,
        author: extractCommentAuthor(reply),
        createdAt: dates.createdAt,
        updatedAt: dates.updatedAt,
        location: location,
        resolved: resolved,
        body: String(reply.body || '').trim()
    };
}

function normalizeRawThread(t, idx) {
    if (!t || typeof t !== 'object') return [];
    var id = extractThreadId(t, idx);
    var dates = extractCommentDates(t);
    var location = formatThreadLocation(t);
    var resolved = t.resolved === true;
    var items = [{
        id: id,
        kind: 'review_thread',
        author: extractCommentAuthor(t),
        createdAt: dates.createdAt,
        updatedAt: dates.updatedAt,
        location: location,
        resolved: resolved,
        body: String(t.body || '').trim()
    }];
    var replies = Array.isArray(t.replies) ? t.replies : [];
    replies.forEach(function(r, i) {
        if (r && typeof r === 'object') {
            items.push(normalizeReplyItem(r, i + 1, id, location, resolved));
        }
    });
    return items;
}

function extractRawThreadsArray(parsed) {
    if (Array.isArray(parsed)) return parsed;
    return (parsed && Array.isArray(parsed.threads)) ? parsed.threads : [];
}

function parseDiscussionsRawJson(content) {
    if (!content) return [];
    try {
        var parsed = typeof content === 'string' ? JSON.parse(content) : content;
        var threads = extractRawThreadsArray(parsed);
        var results = [];
        threads.forEach(function(t, idx) {
            normalizeRawThread(t, idx + 1).forEach(function(item) { results.push(item); });
        });
        return results;
    } catch (e) {
        return [];
    }
}

function sliceGeneralCommentsSection(text, sourceLabel) {
    if (sourceLabel !== 'pr_discussions.md') return text;
    var marker = '## General PR Comments';
    var idx = text.indexOf(marker);
    return idx === -1 ? '' : text.substring(idx + marker.length);
}

function parseSingleMarkdownBlock(block, sourceLabel) {
    var m = /^\*\*([^\n*]+)\*\*\s*(?:\(([^)]*)\))?:\s*\n+([\s\S]*)$/.exec(block.trim());
    if (!m) return null;
    var author = m[1].trim();
    var date = (m[2] || '').trim();
    var body = m[3].trim();
    return {
        id: sourceLabel + ':' + author + ':' + date + ':' + hashContent(body).substring(8, 16),
        kind: 'comment',
        author: author,
        createdAt: date,
        updatedAt: date,
        location: sourceLabel,
        resolved: false,
        body: body
    };
}

function parseMarkdownComments(content, sourceLabel) {
    var section = sliceGeneralCommentsSection(String(content || ''), sourceLabel);
    if (!section) return [];
    return section.split(/\n---\n/).map(function(block) {
        return parseSingleMarkdownBlock(block, sourceLabel);
    }).filter(Boolean);
}

function collectInputFileMap(inputFolder, options) {
    if (options && options.inputFiles && typeof options.inputFiles === 'object') {
        return options.inputFiles;
    }
    var folder = trimTrailingSlashes(inputFolder);
    var map = {};
    listDirSafe(folder, options).forEach(function(entry) {
        var name = String(entry).replace(/^.*\//, '');
        if (!name || EXCLUDED_SNAPSHOT_FILES[name]) return;
        var content = readFileSafe(folder + '/' + name, options);
        if (content !== null && content !== undefined) map[name] = String(content);
    });
    return map;
}

function hashFileMap(fileMap) {
    var files = {};
    Object.keys(fileMap).filter(function(n) {
        return !EXCLUDED_SNAPSHOT_FILES[n];
    }).sort().forEach(function(name) {
        var text = String(fileMap[name] || '');
        files[name] = { hash: hashContent(text), size: text.length };
    });
    return files;
}

function collectSnapshotComments(fileMap, extraComments) {
    var comments = [];
    var seenIds = {};
    function pushUnique(item) {
        if (!item || !item.id || seenIds[item.id]) return;
        seenIds[item.id] = true;
        comments.push(item);
    }
    parseDiscussionsRawJson(fileMap['pr_discussions_raw.json']).forEach(pushUnique);
    parseMarkdownComments(fileMap['pr_discussions.md'], 'pr_discussions.md').forEach(pushUnique);
    parseMarkdownComments(fileMap['comments.md'], 'comments.md').forEach(pushUnique);
    (extraComments || []).forEach(function(c, i) {
        normalizeRawThread(c, i + 1).forEach(pushUnique);
    });
    return comments;
}

function firstTruthy(candidates) {
    for (var i = 0; i < candidates.length; i++) {
        if (candidates[i]) return candidates[i];
    }
    return null;
}

function resolveSnapshotMeta(inputFolder, fileMap, prInfo, options) {
    var baseHead = fileMap['rework_base_head.txt'] ? String(fileMap['rework_base_head.txt']).trim() : null;
    var rawLabels = Array.isArray(options.labels) ? options.labels : prInfo.labels;
    var folderLeaf = trimTrailingSlashes(inputFolder).split('/').pop();
    return {
        recordedAt: firstTruthy([options.recordedAt, new Date().toISOString()]),
        ticketKey: firstTruthy([options.ticketKey, folderLeaf]) || '',
        headSha: firstTruthy([options.headSha, baseHead, prInfo.headSha]),
        baseBranch: firstTruthy([options.baseBranch, prInfo.baseBranch]),
        reviewDecision: firstTruthy([options.reviewDecision, parseReviewStateMd(fileMap['review_state.md'])]),
        labels: rawLabels.slice().sort()
    };
}

function buildInputSnapshot(inputFolder, options) {
    options = options || {};
    var fileMap = collectInputFileMap(inputFolder, options);
    var prInfo = parsePrInfoMd(fileMap['pr_info.md']);
    var meta = resolveSnapshotMeta(inputFolder, fileMap, prInfo, options);
    return {
        schemaVersion: 1,
        recordedAt: meta.recordedAt,
        ticketKey: meta.ticketKey,
        headSha: meta.headSha,
        baseBranch: meta.baseBranch,
        reviewDecision: meta.reviewDecision,
        labels: meta.labels,
        files: hashFileMap(fileMap),
        comments: collectSnapshotComments(fileMap, options.comments)
    };
}

function classifySingleFile(name, prevFiles, currFiles, buckets) {
    if (!Object.prototype.hasOwnProperty.call(prevFiles, name)) {
        buckets.added.push(name);
    } else if (!prevFiles[name] || prevFiles[name].hash !== currFiles[name].hash) {
        buckets.changed.push(name);
    } else {
        buckets.unchanged.push(name);
    }
}

function classifySnapshotFiles(prevFiles, currFiles) {
    prevFiles = prevFiles || {};
    currFiles = currFiles || {};
    var buckets = { added: [], changed: [], unchanged: [], removed: [] };
    Object.keys(currFiles).sort().forEach(function(name) {
        classifySingleFile(name, prevFiles, currFiles, buckets);
    });
    Object.keys(prevFiles).sort().forEach(function(prevName) {
        if (!Object.prototype.hasOwnProperty.call(currFiles, prevName)) {
            buckets.removed.push(prevName);
        }
    });
    return buckets;
}

function computeLabelDiff(prevLabels, currLabels) {
    var prev = prevLabels || [];
    var curr = currLabels || [];
    return {
        added: curr.filter(function(l) { return prev.indexOf(l) === -1; }),
        removed: prev.filter(function(l) { return curr.indexOf(l) === -1; })
    };
}

function indexCommentsById(comments) {
    var map = {};
    (comments || []).forEach(function(c) {
        if (c && c.id) map[c.id] = c;
    });
    return map;
}

function diffSingleComment(c, prevById) {
    var prev = prevById[c.id];
    if (!prev) return c;
    if (String(prev.body || '') !== String(c.body || '')) {
        return Object.assign({}, c, { edited: true });
    }
    return null;
}

function computeNewComments(prevComments, currComments) {
    var prevById = indexCommentsById(prevComments);
    return (currComments || []).map(function(c) {
        return (c && c.id) ? diffSingleComment(c, prevById) : null;
    }).filter(Boolean);
}

function buildTransition(fromVal, toVal) {
    var fromNorm = fromVal || null;
    var toNorm = toVal || null;
    return { from: fromNorm, to: toNorm, changed: fromNorm !== toNorm };
}

function buildFallbackDelta(mode, warning, curr, filesBucket, changedFlag) {
    return {
        mode: mode,
        warning: warning,
        headTransition: { from: null, to: curr.headSha || null, changed: changedFlag },
        reviewDecisionTransition: { from: null, to: curr.reviewDecision || null, changed: Boolean(changedFlag && curr.reviewDecision) },
        labelDiff: { added: curr.labels || [], removed: [] },
        files: filesBucket,
        newComments: (curr.comments || []).slice()
    };
}

function isValidManifestObject(manifest) {
    return Boolean(manifest && typeof manifest === 'object' && manifest.files);
}

function computeSessionDelta(previousManifest, currentSnapshot, options) {
    options = options || {};
    var curr = currentSnapshot || { files: {}, comments: [], labels: [] };
    var currNames = Object.keys(curr.files || {}).sort();

    if (options.corruptManifest) {
        var reason = options.corruptReason || 'Previous session manifest was corrupt; falling back to full input read.';
        return buildFallbackDelta('CORRUPT-MANIFEST', reason, curr,
            { added: [], changed: currNames, unchanged: [], removed: [] }, true);
    }
    if (!isValidManifestObject(previousManifest)) {
        return buildFallbackDelta('FIRST-LEG', null, curr,
            { added: currNames, changed: [], unchanged: [], removed: [] }, false);
    }

    return {
        mode: 'DELTA',
        warning: null,
        headTransition: buildTransition(previousManifest.headSha, curr.headSha),
        reviewDecisionTransition: buildTransition(previousManifest.reviewDecision, curr.reviewDecision),
        labelDiff: computeLabelDiff(previousManifest.labels, curr.labels),
        files: classifySnapshotFiles(previousManifest.files, curr.files),
        newComments: computeNewComments(previousManifest.comments, curr.comments)
    };
}

function formatSingleCommentHeading(c, index) {
    var loc = c.location ? ' (`' + c.location + '`)' : '';
    var date = c.createdAt ? ' on ' + c.createdAt : '';
    var editTag = c.edited ? ' [EDITED]' : '';
    return '### ' + index + '. `' + c.id + '` — **' + (c.author || 'unknown') + '**' + loc + date + editTag;
}

function renderCommentListMd(newComments) {
    if (!newComments || newComments.length === 0) {
        return ['_No new PR/MR comments or review threads since your last leg._', ''];
    }
    var lines = [];
    newComments.forEach(function(c, i) {
        lines.push(formatSingleCommentHeading(c, i + 1));
        lines.push('');
        lines.push(c.body || '_(empty comment body)_');
        lines.push('');
    });
    return lines;
}

function formatBucketList(items) {
    if (!items || items.length === 0) return '_none_';
    return items.map(function(n) { return '`' + n + '`'; }).join(', ');
}

function renderFileBucketsMd(files) {
    var f = files || { added: [], changed: [], unchanged: [], removed: [] };
    var lines = [
        '## Input Files (`input/<ticket>/`)',
        '',
        '- **NEW** (' + f.added.length + '): ' + formatBucketList(f.added),
        '- **CHANGED** (' + f.changed.length + '): ' + formatBucketList(f.changed),
        '- **UNCHANGED** (' + f.unchanged.length + '): ' + formatBucketList(f.unchanged)
    ];
    if (f.removed && f.removed.length > 0) {
        lines.push('- **REMOVED** (' + f.removed.length + '): ' + formatBucketList(f.removed));
    }
    lines.push('');
    return lines;
}

function formatTransitionLine(label, transition, defaultName) {
    var t = transition || {};
    if (!t.from && !t.to) return null;
    var suffix = t.changed ? ' *(changed)*' : ' *(unchanged)*';
    return '- **' + label + '**: `' + (t.from || defaultName) + '` → `' + (t.to || defaultName) + '`' + suffix;
}

function formatLabelDiffLine(labelDiff) {
    var ld = labelDiff || { added: [], removed: [] };
    var parts = [];
    if (ld.added && ld.added.length) parts.push('+' + ld.added.join(', +'));
    if (ld.removed && ld.removed.length) parts.push('-' + ld.removed.join(', -'));
    return parts.length ? '- **Labels Delta**: ' + parts.join(' / ') : null;
}

function renderDeltaHeaderLines(delta) {
    var lines = ['# Session Delta — What Changed Since Your Last Leg', '', '- **Mode**: `' + delta.mode + '`'];
    if (delta.warning) lines.push('- **Warning**: ⚠️ ' + delta.warning);
    var headLine = formatTransitionLine('HEAD SHA', delta.headTransition, 'none');
    if (headLine) lines.push(headLine);
    var revLine = formatTransitionLine('Review Decision', delta.reviewDecisionTransition, 'NONE');
    if (revLine) lines.push(revLine);
    var labelLine = formatLabelDiffLine(delta.labelDiff);
    if (labelLine) lines.push(labelLine);
    lines.push('');
    return lines;
}

function renderActionGuidanceLines(mode) {
    var lines = ['## Action Guidance', ''];
    if (mode === 'CORRUPT-MANIFEST' || mode === 'FIRST-LEG') {
        lines.push('- Read all files in `input/` in full (`' + mode + '` — do not rely on prior memory).');
        return lines;
    }
    lines.push('- Act on **New Comments & Review Threads** above first.');
    lines.push('- Read every **NEW** and **CHANGED** file in `input/<ticket>/` with your file-read tool.');
    lines.push('- **UNCHANGED** files may be trusted from your prior session memory without re-reading unless needed.');
    return lines;
}

function renderSessionDeltaMd(delta) {
    delta = delta || computeSessionDelta(null, null);
    var count = delta.newComments ? delta.newComments.length : 0;
    var lines = []
        .concat(renderDeltaHeaderLines(delta))
        .concat(renderFileBucketsMd(delta.files))
        .concat(['## New Comments & Review Threads (' + count + ')', ''])
        .concat(renderCommentListMd(delta.newComments))
        .concat(renderActionGuidanceLines(delta.mode));
    return lines.join('\n') + '\n';
}

function buildCompositeResumeNotice(promptFile, deltaMdContent) {
    var trimmedDelta = String(deltaMdContent || '').trim();
    if (!trimmedDelta) {
        return [
            '**IMPORTANT — resumed session:** this is a re-run of this job for the same ticket. Do NOT rely on memory from a previous turn — the `input/` folder has been freshly re-downloaded for this run and may contain new or changed content (ticket description, comments, tracker page content, inline comments) compared to what you saw before.',
            '',
            'Your full instructions for this run are in this file (they are NOT repeated here on purpose):',
            '  ' + promptFile,
            '',
            'Use your file-read tool to open and read that file IN FULL right now — do not skip this step just because you resumed this session — then follow it exactly, including re-reading every file it references under `input/` (`request.md`, `comments.md`, `confluence_output_comments.md`, `confluence_output_current.md`, etc.) from scratch.'
        ].join('\n');
    }
    return [
        '**IMPORTANT — resumed session (Session Delta):** Since your last leg on this ticket, `input/` has been refreshed. Review the delta below before taking action:',
        '',
        trimmedDelta,
        '',
        '### Resume Instructions',
        '- Act on **New Comments & Review Threads** above first.',
        '- Open and read all **NEW** and **CHANGED** files in `input/` right now using your file-read tool.',
        '- **UNCHANGED** files may be trusted from your prior session memory.',
        '- Your full role instructions for this leg are at:',
        '  ' + promptFile,
        '  If your leg role changed (e.g. development → rework) or you need the full workflow rules, read `' + promptFile + '` in full.'
    ].join('\n');
}

function buildDeltaOptionsFromRead(readResult) {
    if (readResult && readResult.status === 'CORRUPT') {
        return { corruptManifest: true, corruptReason: readResult.error };
    }
    return {};
}

function prepareLegSessionDelta(params) {
    params = params || {};
    var inputFolder = trimTrailingSlashes(params.inputFolder);
    if (!inputFolder) return { ok: false, reason: 'missing inputFolder' };

    var storage = resolveStorageAdapter(params);
    var ctx = Object.assign({}, params, { inputFolder: inputFolder });
    var readResult = storage.readManifest(ctx);
    var snapshot = buildInputSnapshot(inputFolder, ctx);
    var prevManifest = (readResult && readResult.status === 'OK') ? readResult.manifest : null;
    var delta = computeSessionDelta(prevManifest, snapshot, buildDeltaOptionsFromRead(readResult));
    var deltaMd = renderSessionDeltaMd(delta);

    writeFileSafe(inputFolder + '/' + SESSION_DELTA_FILENAME, deltaMd, ctx);
    storage.writePendingManifest(ctx, snapshot);

    return {
        ok: true,
        mode: delta.mode,
        readStatus: readResult ? readResult.status : 'UNKNOWN',
        delta: delta,
        deltaMd: deltaMd,
        snapshot: snapshot
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        MANIFEST_FILENAME: MANIFEST_FILENAME,
        PENDING_MANIFEST_FILENAME: PENDING_MANIFEST_FILENAME,
        SESSION_DELTA_FILENAME: SESSION_DELTA_FILENAME,
        hashContent: hashContent,
        slugifySegment: slugifySegment,
        sessionGroupForConfig: sessionGroupForConfig,
        resolveSessionStateDir: resolveSessionStateDir,
        resolveDefaultSessionSubpath: resolveDefaultSessionSubpath,
        hasActiveSessionOnDisk: hasActiveSessionOnDisk,
        defaultDeltaStorage: defaultDeltaStorage,
        parsePrInfoMd: parsePrInfoMd,
        parseReviewStateMd: parseReviewStateMd,
        parseDiscussionsRawJson: parseDiscussionsRawJson,
        parseMarkdownComments: parseMarkdownComments,
        buildInputSnapshot: buildInputSnapshot,
        computeSessionDelta: computeSessionDelta,
        renderSessionDeltaMd: renderSessionDeltaMd,
        buildCompositeResumeNotice: buildCompositeResumeNotice,
        prepareLegSessionDelta: prepareLegSessionDelta
    };
}
