/**
 * GitHub state source for the SM rule engine.
 *
 * On GitHub the tracker IS the state machine: issue labels carry the
 * machine-loop state (agent:dev / ai_developed / pr_approved / …) and PR
 * facts carry CI/merge observations. Two carrier modes, mirroring how the
 * loop actually spawns work:
 *
 *   query: { type: 'issue', labels, notLabels, assignee, prChecks, … }
 *     The issue is the state carrier; the linked PR (branch
 *     <branchPrefix><n> or a "#n" reference in the PR body) ENRICHES the
 *     observation (guards on prChecks / prMergeState apply only when a PR
 *     is linked — the Jira-era shape).
 *
 *   query: { type: 'pr', labels, notLabels, checks, mergeState, … }
 *     The PR itself is the state carrier — covers PRs born without an
 *     issue. Guards read PR labels + checks + merge state directly.
 *
 * All I/O goes through common/smProvider.js (bridge tools; gitlab twin
 * speaks the same contract), so this source is forge-portable as-is.
 *
 * Item shape:
 *   { key: 'gh-125' | 'pr-127', labels, pr: {number,state,checks,mergeState,
 *     mergeable} | null, issueNumber, prNumber }
 */
'use strict';

var smProviderModule = require('../../common/smProvider.js');
var machineAuthorModule = require('../../common/machineAuthor.js');
var smAsyncModule = require('../../common/smAsync.js');

// runAsync worker sources — STRING literals of CLOSURE-FREE functions.
// The Dart runtime serializes them via fn.toString() and runs each on a
// fresh, fully-wired worker engine; EVERYTHING they need travels via args
// (the per-tick ioCache snapshot rides args.preseed — worker isolates
// cannot see the main isolate's module-level cache). require() resolves
// against the main script's directory snapshot, so './common/smProvider.js'
// lands on js/common/smProvider.js. Without runAsync (Java/GraalJS parity,
// unit-test harness) smAsync falls back to sequential in-process eval of
// the same source — one code path, two execution strategies. READ fan-out
// only: rule sequencing, mutex and all actions stay on the main engine.
var PR_STATUS_WORKER_SOURCE = [
    'function(args) {',
    "    var mod = require('./common/smProvider.js');",
    "    var p = mod.createSmProvider({ scm: { provider: 'github' }, repository: args.repo, preseed: args.preseed });",
    '    return p.prStatus(args.n);',
    '}'
].join('\n');

var ISSUE_ENRICH_WORKER_SOURCE = [
    'function(args) {',
    "    var mod = require('./common/smProvider.js');",
    "    var p = mod.createSmProvider({ scm: { provider: 'github' }, repository: args.repo, preseed: args.preseed });",
    '    var prRef = p.findPr(args.n, args.prefix);',
    '    var pr = null;',
    "    if (prRef && prRef.state === 'OPEN') {",
    '        pr = p.prStatus(prRef.number);',
    '    }',
    '    return { prRef: prRef, pr: pr };',
    '}'
].join('\n');

var ISSUE_SEARCH_WORKER_SOURCE = [
    'function(args) {',
    '    function parseMcp(result) {',
    '        if (!result) return null;',
    "        if (typeof result === 'string') {",
    '            try { return JSON.parse(result); } catch (e) { return null; }',
    '        }',
    '        return result;',
    '    }',
    '    function asList(parsed) {',
    '        if (!parsed) return [];',
    '        if (Array.isArray(parsed)) return parsed;',
    '        if (Array.isArray(parsed.data)) return parsed.data;',
    '        if (Array.isArray(parsed.items)) return parsed.items;',
    '        return [];',
    '    }',
    '    var d = args.descriptor;',
    "    var query = 'repo:' + args.repo.owner + '/' + args.repo.repo +",
    "        ' is:issue is:open ' +",
    "        (d.kind === 'label' ? 'label:\"' + d.label + '\"' : 'assignee:' + args.assignee);",
    '    return { descriptor: d, items: asList(parseMcp(github_search_issues({ query: query }))) };',
    '}'
].join('\n');

function parseMcp(result) {
    if (!result) return null;
    if (typeof result === 'string') {
        try { return JSON.parse(result); } catch (e) { return null; }
    }
    return result;
}

function asList(parsed) {
    if (!parsed) return [];
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.data)) return parsed.data;
    if (Array.isArray(parsed.items)) return parsed.items; // github_search_issues shape
    return [];
}

function issueLabels(it) {
    return (it.labels || []).map(function (l) { return l.name || l; });
}

function prLabels(p) {
    return (p.labels || []).map(function (l) { return (l && l.name) || l; });
}

// `owner` (repoInfo.owner) rides through for the release-bump form of the
// machine-authorship gate (#1104): chore/release-v* | chore(release): from
// the repo owner counts as machine — see common/machineAuthor.js.
function matchesGuards(item, rule, provider, machineAuthor, owner) {
    var q = rule.query || {};
    var labels = item.labels || [];
    if (q.notLabels && q.notLabels.some(function (l) { return labels.indexOf(l) !== -1; })) {
        return false;
    }
    // 'blocked' = human hold (fa #939): the machine skips the item
    // ENTIRELY — all rules, all legs (no dispatch, no merge, no review, no
    // branch updates) — until a human removes the label. Engine-level, not
    // per-rule: applies to every rule incl. future ones. Both carriers:
    // the issue's own labels AND the linked PR's labels freeze an
    // issue-carrier item (an issue whose PR a human parked must not keep
    // receiving review/rework dispatches).
    if (labels.indexOf('blocked') !== -1) {
        return false;
    }
    // The live provider reports `checkConclusion`; older stubs (and the
    // issue-path placeholder) use `checks`. Accept both everywhere.
    // Array form (like mergeState): the dispatch-CI bridge reports a
    // PENDING check run on every fresh head, so "no CI yet" is either
    // 'none' or 'pending' — validate-fresh matches both.
    var rollup = function (pr) { return pr ? (pr.checkConclusion || pr.checks) : undefined; };
    var rollupWant = function (want) {
        return Array.isArray(want) ? want : (want ? [want] : null);
    };
    if (q.prChecks && rollupWant(q.prChecks).indexOf(rollup(item.pr)) === -1) return false;
    if (q.prMergeState && (!item.pr || item.pr.mergeState !== q.prMergeState)) return false;
    var msWant = Array.isArray(q.mergeState) ? q.mergeState : (q.mergeState ? [q.mergeState] : null);
    if (msWant && (!item.pr || msWant.indexOf(item.pr.mergeState) === -1)) return false;
    // PR-carrier guards (issue #687 lifecycle rules): `checks` reads the
    // provider's check rollup (green/red/pending/none); `notMergeState`
    // excludes one state (e.g. BEHIND while a silent update lands).
    if (q.checks && rollupWant(q.checks).indexOf(rollup(item.pr)) === -1) return false;
    // Array form (owner FIFO rule 2026-09-22): exclude PRs in ANY of the
    // listed states — validate-armed must skip BEHIND (refresh first) AND
    // DIRTY (conflict-rework owns the oldest; a newer approved proceeds
    // while the conflicted one reworks — no wasted validation on a head
    // that can never merge).
    var nmsWant = Array.isArray(q.notMergeState) ? q.notMergeState : (q.notMergeState ? [q.notMergeState] : null);
    if (nmsWant && (!item.pr || nmsWant.indexOf(item.pr.mergeState) !== -1)) return false;
    // Stale review verdict (PR #690): CHANGES_REQUESTED pinned to an older
    // commit while fixes landed on a newer green head — a re-review is
    // owed. Lazily resolved via provider.lastReview; without a provider
    // (defensive stubs) the guard never matches.
    if (q.reviewStale) {
        var lr = (provider && provider.lastReview)
            ? provider.lastReview(item.prNumber) : null;
        var stale = !!(lr && lr.state === 'CHANGES_REQUESTED' && item.pr &&
                       item.pr.headSha && lr.commitId &&
                       lr.commitId !== item.pr.headSha);
        if (!stale) return false;
    }
    // ANY verdict (not just CHANGES_REQUESTED) rendered on an older commit
    // — pairs with threadsResolved so a re-review fires once per head
    // change and never loops (the re-review's verdict lands on the
    // current head, clearing the staleness).
    if (q.staleVerdict) {
        var lv = (provider && provider.lastReview)
            ? provider.lastReview(item.prNumber) : null;
        if (!(lv && lv.commitId && item.pr && item.pr.headSha &&
              lv.commitId !== item.pr.headSha)) return false;
    }
    // All review threads resolved (at least one exists): the rework leg
    // resolved the review's findings — a fresh verdict is owed.
    if (q.threadsResolved) {
        var th = (provider && provider.reviewThreads)
            ? provider.reviewThreads(item.prNumber) : null;
        if (!(th && th.total > 0 && th.unresolved === 0)) return false;
    }
    // Machine-author gate (owner rule): auto legs (rework, review, …) only
    // fire on machine-authored PRs — the deployment's machine login, or a
    // release-bump PR authored by the repo owner (#1104: auto_release.sh
    // runs on the owner's RELEASE_PAT, so GitHub records the owner as the
    // PR author; the machine login never matches those). Fail-closed: no
    // machineAuthor configured AND not a release bump → matches nothing.
    // PR-carrier items carry `author` from the list call (free);
    // issue-carrier items read it from the enriched prStatus.
    if (q.prMachineAuthor) {
        if (!machineAuthorModule.isMachineAuthored(item, machineAuthor, owner)) {
            return false;
        }
    }
    if (q.mergeable === true && (!item.pr || item.pr.mergeable !== true)) return false;
    if (q.prState && (!item.pr || item.pr.state !== q.prState)) return false;
    // PR-side label guards (issue-anchored rules): the machine loop pins
    // ai_pr_reviewed and agent:review on the PR while the rule's type is
    // issue — match/not-match must read the linked PR's labels.
    var prLs = (item.pr && item.pr.labels) || [];
    // 'blocked' on the PR side of an issue-carrier item freezes it too —
    // see the item-labels check at the top of this guard.
    if (prLs.indexOf('blocked') !== -1) return false;
    if (q.prLabels && !q.prLabels.some(function (l) { return prLs.indexOf(l) !== -1; })) return false;
    if (q.notPrLabels && q.notPrLabels.some(function (l) { return prLs.indexOf(l) !== -1; })) return false;
    return true;
}

/**
 * Queries GitHub state for the rule.
 * @param {Object} rule - SM rule with rule.query (see module doc)
 * @param {Object} ctx  - { config, repoInfo: {owner, repo}, provider? }
 * @returns {Array<Object>} state items
 */
function query(rule, ctx) {
    var q = rule.query || {};
    var repoInfo = ctx.repoInfo || {};
    var provider = ctx.provider || smProviderModule.createSmProvider({
        scm: { provider: 'github' },
        repository: repoInfo
    });
    var branchPrefix = rule.branchPrefix || 'ai/gh-';
    var limit = rule.limit || 50;

    var machineAuthor = machineAuthorModule.resolveMachineAuthor(ctx, ctx && ctx.config);
    var owner = repoInfo.owner || '';
    if (q.type === 'pr') {
        return queryPrs(rule, provider, repoInfo, limit, machineAuthor, owner);
    }
    return queryIssues(rule, provider, repoInfo, branchPrefix, limit, machineAuthor, owner);
}

function queryIssues(rule, provider, repoInfo, branchPrefix, limit, machineAuthor, owner) {
    var q = rule.query || {};
    var full = repoInfo.owner + '/' + repoInfo.repo;
    var seen = {};
    var items = [];

    // Per-label OR search (GitHub ANDs multi-label queries). Collect ALL
    // matches — the FIFO sort at the end picks the oldest, so an early
    // per-label cut at `limit` would drop old issues behind newer ones.
    // The scans fan out through smAsync: one runAsync worker round when
    // parallelWorkers is wired, the identical sequential order otherwise.
    // Merging iterates descriptor order — labels in rule order, then the
    // assignee scan — and dedupes by number, exactly like the old inline
    // sequence.
    var descriptors = (q.labels || []).map(function (ml) {
        return { kind: 'label', label: ml };
    });
    if (q.assignee) descriptors.push({ kind: 'assignee' });

    var searchOne = function (d) {
        var queryStr = 'repo:' + full + ' is:issue is:open ' +
            (d.kind === 'label' ? 'label:"' + d.label + '"' : 'assignee:' + q.assignee);
        var res = parseMcp(github_search_issues({ query: queryStr }));
        return { descriptor: d, items: asList(res) };
    };

    var searchResults;
    if (descriptors.length > 1) {
        searchResults = smAsyncModule.map(descriptors, ISSUE_SEARCH_WORKER_SOURCE, function (d) {
            return { repo: repoInfo, descriptor: d, assignee: q.assignee };
        });
    } else {
        searchResults = descriptors.map(searchOne);
    }

    searchResults.forEach(function (r) {
        r.items.forEach(function (it) {
            if (seen[it.number]) return;
            seen[it.number] = true;
            var item = {
                key: 'gh-' + it.number,
                labels: issueLabels(it),
                pr: null,
                issueNumber: it.number,
                prNumber: null
            };
            // label-scan items keep the raw payload (today's shape);
            // assignee items never carried it.
            if (r.descriptor.kind === 'label') item._raw = it;
            items.push(item);
        });
    });

    // Linked-PR enrichment: the issue carries the state, the PR carries
    // the CI/merge observation. Multi-item batches fan out through
    // smAsync with ONE cache snapshot fetched up front and shipped to
    // every worker via args.preseed; single-item lists keep today's
    // sequential path with NO snapshot fetch (avoids the extra
    // github_list_branches call for the common single-issue case).
    var enriched;
    if (items.length > 1) {
        var snapshot = (typeof runAsync === 'function' && provider &&
            typeof provider.snapshot === 'function') ? provider.snapshot() : null;
        var enrichResults = smAsyncModule.map(items, ISSUE_ENRICH_WORKER_SOURCE, function (item) {
            return { repo: repoInfo, n: item.issueNumber, prefix: branchPrefix, preseed: snapshot };
        });
        enriched = enrichResults.map(function (r, i) {
            var item = items[i];
            var prRef = r.prRef;
            if (prRef && prRef.state === 'OPEN') {
                item.pr = r.pr;
                item.prNumber = prRef.number;
                item.branch = (item.pr && item.pr.branch) || '';
                // Write-back — same cross-rule memo contract as the
                // queryPrs batch above.
                if (provider && typeof provider.memoPrStatus === 'function') {
                    provider.memoPrStatus(prRef.number, r.pr);
                }
            } else if (prRef) {
                item.pr = { number: prRef.number, state: prRef.state,
                            checks: 'none', mergeState: 'UNKNOWN', mergeable: null };
                item.prNumber = prRef.number;
            }
            return item;
        });
    } else {
        enriched = items.map(function (item) {
            var prRef = provider.findPr(item.issueNumber, branchPrefix);
            if (prRef && prRef.state === 'OPEN') {
                item.pr = provider.prStatus(prRef.number);
                item.prNumber = prRef.number;
                item.branch = (item.pr && item.pr.branch) || '';
            } else if (prRef) {
                item.pr = { number: prRef.number, state: prRef.state,
                            checks: 'none', mergeState: 'UNKNOWN', mergeable: null };
                item.prNumber = prRef.number;
            }
            return item;
        });
    }

    var matched = enriched.filter(function (item) { return matchesGuards(item, rule, provider, machineAuthor, owner); });

    // FIFO: oldest issue first — github_search_issues returns newest-first,
    // which starves the oldest ticket under limit:1 rules (the oldest
    // machine-loop PR rots at the bottom of the queue). Same starvation fix
    // as the PR-carrier path below; issue number order == creation order.
    matched.sort(function (a, b) { return (a.issueNumber || 0) - (b.issueNumber || 0); });
    return matched.slice(0, limit);
}

// Linked-issue resolution (pr-carrier → issue anchor): issue-anchored legs
// dispatched for a PR (manual rework via the agent:rework PR label) need the
// issue number for the {issueNumber} input. Closing keywords first (GitHub's
// own linking semantics), then a bare #N mention — the same body convention
// findPr() relies on in the issue→pr direction. null when unlinked.
//
// #544: a '#N' preceded by a REPO QUALIFIER is a cross-repo reference, never
// a local issue anchor — 'dm.ai #601', 'org/repo#N', 'org/repo #N' must NOT
// resolve against the current repo (live: dmtools-dart PR #266 body 'Dart
// port of dm.ai #601' scraped #601 → 'gh issue view 601' 404 → guard exit 1
// → the whole SM cycle red every 15 min). Qualified mentions are stripped
// before scraping; existence of what remains is verified at dispatch time
// (smAgent localIssueExists), so dangling bare refs degrade the same way.
function linkedIssueNumber(body) {
    var text = String(body || '');
    // Strip repo-qualified mentions: a qualifier token (owner, repo, or
    // owner/repo — word chars/dots/dashes, optionally slash-separated)
    // before '#'. Only REAL qualifiers count — the token must contain a
    // '.' or '/' ('dm.ai #601', 'org/repo#N', 'org/repo #603') or attach
    // directly to the '#' ('word#N' is not autolinked by GitHub either);
    // a plain English word followed by a spaced '#N' ('Related to #45')
    // stays a LOCAL bare-mention ref. The boundary class keeps closing
    // keywords ('Closes #123') intact — and the keyword check below is
    // belt-and-suspenders for 'closes repo#N'.
    text = text.replace(/(^|[^A-Za-z0-9_.\-/])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)([ \t]*)(#\d+)/g,
        function (m0, boundary, qualifier, gap) {
            if (/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)/i.test(qualifier)) {
                return m0; // closing keyword, not a repo qualifier
            }
            if (gap === '' || qualifier.indexOf('.') !== -1 || qualifier.indexOf('/') !== -1) {
                return boundary + ' '; // cross-repo mention — drop it
            }
            return m0; // spaced plain word — the #N stays a local ref
        });
    var m = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i.exec(text);
    if (m) return parseInt(m[1], 10);
    m = /(^|[^0-9])#(\d+)([^0-9]|$)/.exec(text);
    return m ? parseInt(m[2], 10) : null;
}

function queryPrs(rule, provider, repoInfo, limit, machineAuthor, owner) {    var q = rule.query || {};
    // The open-PR list rides the provider's per-tick ioCache — this site
    // fired github_list_prs once PER RULE (measured: 18 calls, one idle
    // tick, all the same payload). Providers without the cache contract
    // (gitlab stub returns null) keep the direct fetch.
    var prs = (provider && typeof provider.listOpenPrs === 'function'
        ? provider.listOpenPrs() : null) ||
        asList(parseMcp(github_list_prs({
            workspace: repoInfo.owner, repository: repoInfo.repo, state: 'open'
        })));

    var items = prs.map(function (p) {
        return {
            key: 'pr-' + p.number,
            labels: prLabels(p),
            pr: null,
            issueNumber: linkedIssueNumber(p.body),
            prNumber: p.number,
            draft: !!p.draft,
            branch: (p.head && p.head.ref) || p.headRefName || '',
            title: p.title || '',
            // REST /pulls carries the creator under `user` (no `author`
            // key at all — live-verified); GraphQL and the unit fixtures
            // use `author`. Read both.
            author: (p.user && p.user.login) ||
                (p.author && (p.author.login || p.author.name)) || ''
        };
    });

    // 'blocked' = human hold (fa #939 — documented in matchesGuards): the
    // item is invisible to EVERY rule, so it must not even act as a mutex
    // holder — a frozen PR's stale ai_validating arm would otherwise
    // serialize the whole queue forever. Filtered before the mutex scan;
    // the matchesGuards check remains the engine-level guard.
    items = items.filter(function (it) { return it.labels.indexOf('blocked') === -1; });

    // Mutex (q.mutex = label): if ANY open PR holds the label, this rule
    // defers entirely. Serializes one-dispatch stages — validate-armed/
    // validate-fresh both arm ai_validating + dispatch CI; without the
    // mutex multiple approved PRs validate in parallel and every merge
    // (base move) re-invalidates the others: N merges = N×N validation
    // runs. One at a time, oldest-first (FIFO sort below) = each head
    // validates exactly once. Owner rule 2026-09-22 (live: fa #778/#779
    // both ai_validating while older #762 waited).
    //
    // q.mutexAmong = [labels]: scope the mutex to holders that ALSO carry
    // one of these labels. Owner priority rule 2026-09-22 (live: fa #801
    // pr_approved+ai_validated starved behind dev-lane ai_validating arms
    // on #831/#832/#834 — validate-armed deferred every tick while the
    // parallel dev wave re-occupied the label): the dev lane is
    // non-blocking by design, so its arms must NOT block the approved
    // merge window. Only approved-PR arms serialize the merge window
    // (the N×N re-validation invariant is a merge-window property).
    // q.mutexExcludeSelf = true (recovery-rule form): the rule's own target
    // carries the mutex label by definition (it re-dispatches CI on an
    // ALREADY armed PR), so the global scan would self-block it 100% of the
    // time — which is exactly why the recovery rules shipped with NO mutex
    // and leaked (live multi-arm, fa 2026-09-26: 7 approved PRs held
    // ai_validating at once, +1 arm per tick, while their descriptions
    // claimed validate-armed's mutex made the arm a singleton — false once
    // heads move: silent-update / BEHIND unarm races / guest pushes keep
    // feeding checks=none states). With exclude-self the mutex is evaluated
    // PER CANDIDATE (#577): a candidate defers only while ANOTHER PR holds
    // the arm AND the candidate itself does not (mutexAmong still scopes
    // the holders). One armed approved PR = the candidate itself = fires;
    // with several arms the self-holding candidates drain the stack
    // oldest-first (a stack can also freeze the drain rules themselves —
    // live: fa #1068+#1088 2026-09-30, both heads green-with-missing-CI +
    // BLOCKED, so merge-validated/fail-validation/unarm-stale matched
    // nothing and the old all-defer form deadlocked the queue ~40 min).
    // Arming stays serialized: only the global (non-exclude-self) form
    // adds the label, and it defers on ANY holder within mutexAmong.
    if (q.mutex) {
        var among = q.mutexAmong;
        var holdsMutex = function (it) {
            if (it.labels.indexOf(q.mutex) === -1) return false;
            if (!among) return true;
            return among.some(function (l) { return it.labels.indexOf(l) !== -1; });
        };
        if (q.mutexExcludeSelf) {
            items = items.filter(function (candidate) {
                // #577 (fa 2026-09-30, live #1068+#1088): a candidate that
                // itself holds the mutex occupies its own serialization slot.
                // The old 'another holder exists' test made two armed PRs
                // block each other forever whenever every drain rule was
                // inapplicable (both heads green-with-missing-CI + BLOCKED +
                // not BEHIND: revalidate-armed and dead-zone each deferred on
                // the other, while merge-validated / fail-validation /
                // unarm-stale could not complete the stack — the whole queue
                // froze ~40 min until a manual unarm). Defer only when the
                // candidate does NOT hold the mutex itself; recovery-rule
                // candidates always self-hold (their query carries the arm
                // label), so a leaked stack drains oldest-first instead of
                // deadlocking. New arms still cannot leak: only the global
                // (non-exclude-self) form arms, and it still defers on ANY
                // holder within mutexAmong.
                var selfHolds = holdsMutex(candidate);
                var blocked = !selfHolds && items.some(function (it) {
                    return it.prNumber !== candidate.prNumber && holdsMutex(it);
                });
                if (blocked) {
                    console.log('   🔒 mutex "' + q.mutex + '" held by another PR — candidate pr-' +
                        candidate.prNumber + ' defers (serial FIFO, exclude-self)');
                }
                return !blocked;
            });
        } else {
            var held = items.some(holdsMutex);
            if (held) {
                console.log('   🔒 mutex "' + q.mutex + '" held by another PR — rule defers (serial FIFO)');
                return [];
            }
        }
    }

    // PR guards that need per-PR facts (checks/merge state) resolve lazily:
    // only when the rule actually filters on them. Multi-PR batches fan
    // out through smAsync with ONE cache snapshot fetched up front and
    // shipped to every worker via args.preseed; single-PR lists keep
    // today's sequential path with NO snapshot fetch (avoids the extra
    // github_list_branches call for the common single-PR rule).
    var needsStatus = q.checks || q.mergeState || q.notMergeState ||
        q.mergeable !== undefined || q.prChecks;
    if (needsStatus) {
        if (items.length > 1) {
            // PR-rule batch: only the open-PR list + branch heads are
            // needed by the prStatus worker — skip the merged-PR leg (was
            // ~1.8s on a busy repo, zero uses in this path).
            var prSnapshot = (typeof runAsync === 'function' && provider &&
                typeof provider.snapshot === 'function')
                ? provider.snapshot(['openPrs', 'branchHeads', 'prStatus']) : null;
            var prStatuses = smAsyncModule.map(items, PR_STATUS_WORKER_SOURCE, function (item) {
                return { repo: repoInfo, n: item.prNumber, preseed: prSnapshot };
            });
            items.forEach(function (item, i) {
                item.pr = prStatuses[i];
                // Workers cannot write back to the main isolate's cache —
                // absorb each computed status so the NEXT batch's snapshot
                // preseed hits instead of re-fetching the same PR per rule.
                if (provider && typeof provider.memoPrStatus === 'function') {
                    provider.memoPrStatus(item.prNumber, prStatuses[i]);
                }
            });
        } else {
            items = items.map(function (item) {
                item.pr = provider.prStatus(item.prNumber);
                return item;
            });
        }
    }

    var matched = items.filter(function (item) {
        var labels = item.labels;
        var q2 = rule.query || {};
        if (labels.indexOf('blocked') !== -1) return false; // #939: human hold — filtered pre-mutex too; see matchesGuards
        if (q2.labels && !q2.labels.some(function (l) { return labels.indexOf(l) !== -1; })) return false;
        if (q2.notLabels && q2.notLabels.some(function (l) { return labels.indexOf(l) !== -1; })) return false;
        if (q2.draft === false && item.draft) return false;
        if (q2.branchPrefix && String(item.branch || '').indexOf(q2.branchPrefix) !== 0) return false;
        // Author guards: `notAuthors` excludes machine-authored PRs (the
        // external one-time review rule) or vice versa.
        if (q2.notAuthors && q2.notAuthors.indexOf(item.author) !== -1) return false;
        // `notMachine` excludes machine-authored PRs without naming the
        // login — the deployment knob (machineAuthor) or a release-bump
        // PR authored by the repo owner (#1104: the auto-release flow
        // commits through the owner's RELEASE_PAT, so GitHub records the
        // owner as the author — the review-external rules must not claim
        // those; the prMachineAuthor rules own them). No machineAuthor
        // configured and no owner → inert (every green PR is reviewable).
        if (q2.notMachine &&
            machineAuthorModule.isMachineAuthored(item, machineAuthor, owner)) return false;
        if (q2.authors && q2.authors.indexOf(item.author) === -1) return false;
        return matchesGuards(item, rule, provider, machineAuthor, owner);
    });

    // FIFO: oldest PR first. github_list_prs returns newest-first (API
    // default), which would starve older approved PRs under limit:1 merge
    // rules — the queue drains oldest-to-newest. Blocked candidates
    // (conflicts, red/pending checks) never reach here: guards already
    // filtered them, so the head of this list is the oldest mergeable PR.
    matched.sort(function (a, b) { return (a.prNumber || 0) - (b.prNumber || 0); });

    return matched.slice(0, limit);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { query: query, matchesGuards: matchesGuards };
}
