/**
 * Fork-leg checkout + push-back (gh-1096) — the consumption half of the
 * gh-1075 fork dispatch. A fork PR's head branch never exists on origin
 * (the base repo), so the rework leg checks the PR head out through the
 * always-fetchable pull ref (refs/pull/<N>/head — from the dispatch's
 * inputs.checkout_ref, exported as env CHECKOUT_REF, or derived from the PR
 * number) and pushes the rework back to the FORK's token URL (gh-1070
 * maintainer-edit contract), never to origin. Same-repo PRs never reach
 * any of these paths (byte-identical).
 */
var validationLiveness = require('./validationLiveness.js');

var PULL_REF_RE = /^refs\/pull\/\d+\/head$/;
var FORK_HEAD_RE = /\*\*Fork Head\*\*:\s*`([^`\/\s]+\/[^`\s]+)`/;

// env CHECKOUT_REF (GraalJS only; '' under node / when unset).
function envCheckoutRef() {
    if (typeof java === 'undefined') return '';
    return String(java.lang.System.getenv('CHECKOUT_REF') || '');
}

// Explicit pull ref wins; otherwise a well-formed env ref; else null.
function resolvePullRef(explicitRef, envRef) {
    if (explicitRef) return explicitRef;
    return PULL_REF_RE.test(String(envRef || '')) ? envRef : null;
}

// The fork 'owner/repo' of a PR (null for same-repo / unknown head repo).
function prForkFull(prDetails) {
    var head = (prDetails && prDetails.head && prDetails.head.repo) || {};
    var base = (prDetails && prDetails.base && prDetails.base.repo) || {};
    var baseFull = String(base.full_name || '/');
    var parts = baseFull.split('/');
    return validationLiveness.forkHeadFull(head.full_name, parts[0], parts[1]);
}

// refs/pull/<N>/head for a fork PR, null for same-repo PRs.
function prPullRef(prDetails) {
    return prForkFull(prDetails) ? 'refs/pull/' + prDetails.number + '/head' : null;
}

// pr_info.md line carrying the fork head (empty for same-repo PRs).
function forkHeadInfoLine(prDetails) {
    var fork = prForkFull(prDetails);
    return fork ? '- **Fork Head**: `' + fork + '`\n' : '';
}

function readForkHead(prInfo) {
    var m = FORK_HEAD_RE.exec(String(prInfo || ''));
    return m ? m[1] : null;
}

// Push commands for the rework branch: origin for same-repo (unchanged
// strings), the fork token URL + HEAD:<branch> for a fork head.
function reworkPushPlan(forkFull, branchName, squashed) {
    if (!forkFull) {
        return {
            fork: false,
            push: squashed ? 'git push -u --force-with-lease origin ' + branchName : 'git push -u origin ' + branchName,
            fetch: 'git -c fetch.recurseSubmodules=no fetch origin ' + branchName + ':refs/remotes/origin/' + branchName,
            merge: 'git merge --no-edit origin/' + branchName,
            retry: 'git push -u origin ' + branchName
        };
    }
    var url = validationLiveness.forkPushTokenUrl(forkFull);
    return {
        fork: true,
        push: 'git push ' + (squashed ? '--force ' : '') + url + ' HEAD:' + branchName,
        fetch: 'git -c fetch.recurseSubmodules=no fetch ' + url + ' ' + branchName,
        merge: 'git merge --no-edit FETCH_HEAD',
        retry: 'git push ' + url + ' HEAD:' + branchName
    };
}

module.exports = {
    envCheckoutRef: envCheckoutRef,
    resolvePullRef: resolvePullRef,
    prForkFull: prForkFull,
    prPullRef: prPullRef,
    forkHeadInfoLine: forkHeadInfoLine,
    readForkHead: readForkHead,
    reworkPushPlan: reworkPushPlan
};
