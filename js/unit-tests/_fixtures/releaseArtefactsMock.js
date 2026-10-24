/**
 * Shared releaseArtefacts mock fixtures (gh-1230 rework).
 *
 * artefactBuildTag / artefactBuildReleaseName / artefactResolveRepository were
 * duplicated byte-for-byte in test_restoreFromReleases.js and
 * test_timerAutoCommitAndSave.js; this module owns the tag/name/repository
 * normalization rules in exactly one place so the two harnesses stay in sync.
 * The per-file recording helpers (recordingDownloadArtefact vs
 * recordingUploadRawFile) genuinely differ (download vs upload contract) and
 * stay in their own test files.
 *
 * Loaded by both test files via loadModule() (available at test-file top
 * level under testRunner.js and node_testRunner.js alike). GralJS-safe: var +
 * function declarations only.
 */

function artefactBuildTag(ticketKey, template) {
    var t = (template || 'ai-{ticketKey}').replace(/\{ticketKey\}/g, ticketKey);
    return t.toLowerCase().replace(/[^a-z0-9._/-]/g, '-');
}

function artefactBuildReleaseName(ticketKey, template) {
    return (template || '[AI] [{ticketKey}] Artefacts').replace(/\{ticketKey\}/g, ticketKey);
}

function artefactResolveRepository(customParams) {
    if (!customParams) return null;
    var repo = customParams.artefactRepository || customParams.aiRepository || customParams.targetRepository;
    if (!repo || !repo.owner || !repo.repo) return null;
    return { owner: repo.owner, repo: repo.repo };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        artefactBuildTag: artefactBuildTag,
        artefactBuildReleaseName: artefactBuildReleaseName,
        artefactResolveRepository: artefactResolveRepository
    };
}
