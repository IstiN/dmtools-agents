'use strict';
/**
 * Pack-release version guard (gh-812, live incident 2026-10-09).
 *
 * Encodes the gh-812 version contract: two releases with differing pack
 * content NEVER share a version string (AC2).
 *
 * What broke: ci/release_packs.mjs derived pack versions from versions.json
 * on main — a LEDGER whose push back to main is best-effort (a rejected
 * direct push only warns). The ledger never landed, so every release
 * recomputed the same bump from the same stale base: eight consecutive
 * releases (20261008-095538 → 20261009-091304) all advertised
 * sm_github: 0.1.36 while the content changed underneath, and 091304
 * republished a DIFFERENT sm_github-0.1.36.zip than 075526 had shipped.
 * Version-keyed consumer caches then ran mixed content — every fa
 * machine-sm tick red for ~25 min.
 *
 * Decisions (each mirrors the append-only source of truth it trusts):
 *   V1 the SHIPPED version beats the ledger — a release tag, once cut,
 *      cannot be rewritten by a failed push; versions.json can (and did).
 *   V2 an affected agent bumps from the shipped base — never re-ships a
 *      version that is already out there.
 *   V3 a rebuilt-but-unbumped agent whose payload differs from what its
 *      unchanged version already shipped gets an extra patch bump.
 *   V4 the payload fingerprint covers file paths + sha256 + mode — manifest
 *      metadata (version, sourceCommit) changes on every rebuild and must
 *      not force a bump by itself; mode IS payload (zip entries carry it).
 *
 * Pure classification — no fs, no network: the caller (ci/release_packs.mjs)
 * downloads the previous release's catalog.json + same-version pack zips and
 * hands over manifest.json text. CommonJS twin of the builder, unit-testable
 * in the dmtools runner (same split as ci/pack_release_guard.cjs).
 */

/** Semver bump: 'patch' | 'minor' | 'major'. */
function bump(version, kind) {
    var parts = String(version).split('.');
    var maj = parseInt(parts[0], 10) || 0;
    var min = parseInt(parts[1], 10) || 0;
    var pat = parseInt(parts[2], 10) || 0;
    if (kind === 'major') return (maj + 1) + '.0.0';
    if (kind === 'minor') return maj + '.' + (min + 1) + '.0';
    return maj + '.' + min + '.' + (pat + 1);
}

/**
 * V1: base version for a release — what the previous release SHIPPED for
 * the agent, falling back to the ledger, falling back to 0.1.0.
 */
function resolveBaseVersion(ledgerVersion, shippedVersion) {
    if (shippedVersion) return shippedVersion;
    if (ledgerVersion) return ledgerVersion;
    return '0.1.0';
}

/** V2: version to build at — affected agents bump the base, others keep it. */
function resolveCandidateVersion(baseVersion, bumpKind, affected) {
    return affected ? bump(baseVersion, bumpKind) : baseVersion;
}

/**
 * V3: final version to ship — when the freshly built payload differs from
 * what [candidateVersion] already shipped, re-version one patch up.
 * [differsFromShipped] comes from fingerprintsDiffer(); false covers both
 * "identical payload" and "no previous artifact to compare against".
 */
function resolveShipVersion(candidateVersion, differsFromShipped) {
    return differsFromShipped ? bump(candidateVersion, 'patch') : candidateVersion;
}

/**
 * V4: stable fingerprint of a pack's PAYLOAD from its manifest.json text —
 * sorted path:sha256:mode triplets. Manifest metadata (agent, version,
 * sourceCommit) is deliberately excluded: it changes on every rebuild and
 * every commit and must never read as a content change. mode IS included
 * (gh-812 rework, review thread 5): zip entries carry the unix mode, so a
 * mode-only flip with identical bytes produces different zip bytes — the
 * same collision class. Unparseable/absent input → null (the caller treats
 * null as "cannot compare").
 */
function payloadFingerprint(manifestJson) {
    if (!manifestJson) return null;
    var manifest;
    try {
        manifest = JSON.parse(manifestJson);
    } catch (e) {
        return null;
    }
    var files = manifest.files || [];
    var entries = [];
    for (var i = 0; i < files.length; i++) {
        entries.push(files[i].path + ':' + files[i].sha256 + ':' + (files[i].mode || ''));
    }
    entries.sort();
    return entries.join('\n');
}

/**
 * True when two manifests describe DIFFERENT payloads. Missing/unparseable
 * input on either side → false: no previous artifact to compare against must
 * never force a bump from nothing.
 */
function fingerprintsDiffer(prevManifestJson, nextManifestJson) {
    var prev = payloadFingerprint(prevManifestJson);
    var next = payloadFingerprint(nextManifestJson);
    if (prev === null || next === null) return false;
    return prev !== next;
}

/**
 * gh-1325: per-agent retention window when carrying forward previous release
 * assets so pinned `pack@<version>` refs keep resolving against `latest`
 * without unbounded O(N) asset accumulation or GitHub secondary rate limits.
 */
var MAX_RETAINED_VERSIONS_PER_AGENT = 5;

var PACK_ZIP_RE = /^([A-Za-z0-9_-]+)-(\d+\.\d+\.\d+)\.zip$/;

function compareSemverDesc(a, b) {
    var pa = String(a).split('.');
    var pb = String(b).split('.');
    for (var i = 0; i < 3; i++) {
        var diff = (parseInt(pb[i], 10) || 0) - (parseInt(pa[i], 10) || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

function addAgentVersion(versionsByAgent, zipName) {
    var m = PACK_ZIP_RE.exec(zipName);
    if (!m) return;
    var list = versionsByAgent[m[1]] || (versionsByAgent[m[1]] = []);
    if (list.indexOf(m[2]) === -1) list.push(m[2]);
}

function expandWithSidecars(keptZips, prevSet) {
    var out = [];
    for (var i = 0; i < keptZips.length; i++) {
        var z = keptZips[i];
        out.push(z);
        if (prevSet[z + '.sha256']) out.push(z + '.sha256');
    }
    return out;
}

/**
 * Given [prevAssets] (filenames from the previous release) and [currentZips]
 * (filenames freshly built in `dist/`), returns the sorted list of previous
 * `.zip` and `.zip.sha256` filenames to copy forward so each agent keeps at
 * most [maxPerAgent] versions total (current + carried), never overwriting a
 * freshly built asset and never carrying `factory-setup-*`.
 */
function selectCarriedForwardAssets(prevAssets, currentZips, maxPerAgent) {
    var limit = maxPerAgent || MAX_RETAINED_VERSIONS_PER_AGENT;
    var currentSet = {};
    var prevSet = {};
    var versionsByAgent = {};
    (currentZips || []).forEach(function (cur) {
        currentSet[cur] = true;
        addAgentVersion(versionsByAgent, cur);
    });
    (prevAssets || []).forEach(function (name) {
        if (name.indexOf('factory-setup-') === 0) return;
        prevSet[name] = true;
        addAgentVersion(versionsByAgent, name);
    });
    var keptZips = [];
    Object.keys(versionsByAgent).forEach(function (agent) {
        var top = versionsByAgent[agent].slice().sort(compareSemverDesc).slice(0, limit);
        top.forEach(function (ver) {
            var z = agent + '-' + ver + '.zip';
            if (!currentSet[z] && prevSet[z]) keptZips.push(z);
        });
    });
    return expandWithSidecars(keptZips.sort(), prevSet);
}

module.exports = {
    bump: bump,
    resolveBaseVersion: resolveBaseVersion,
    resolveCandidateVersion: resolveCandidateVersion,
    resolveShipVersion: resolveShipVersion,
    payloadFingerprint: payloadFingerprint,
    fingerprintsDiffer: fingerprintsDiffer,
    MAX_RETAINED_VERSIONS_PER_AGENT: MAX_RETAINED_VERSIONS_PER_AGENT,
    selectCarriedForwardAssets: selectCarriedForwardAssets,
};
