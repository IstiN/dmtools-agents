/* Factory Board v3 — reads the SM tick's state snapshots, no build step.
 *
 * v2 (owner 2026-10-01):
 *  - schema 1 AND schema 2 snapshots render (old history never breaks);
 *  - lifecycle timestamps: card age in its current lane + a mini SVG
 *    timeline of the pipeline transitions (tooltips carry the times);
 *  - tab switches clear the board to a skeleton instantly, fetches are
 *    single-flight (AbortController) and only the LAST request renders —
 *    a failed fetch can no longer leave the previous factory's lanes up.
 *
 * v3 (owner 2026-10-03):
 *  - readable progress: per-lane summary line (N total · done · in-flight ·
 *    queued · blocked) + a thin segmented progress bar per lane — the cards
 *    and dots stay as decoration;
 *  - details drawer: click any PR/issue card for an inline panel with the
 *    header (number, title, head sha, state + labels, GitHub link), the
 *    full state history (snapshot-accumulated card.history, newest first),
 *    per-state timings with proportional bars, and the OPTIONAL per-leg
 *    token table (graceful "—" when the factory doesn't report tokens);
 *  - issue backlog lanes: the snapshot's `backlog` section renders as four
 *    columns (in dev / agent:dev queued / blocked / inbox) — blocked is
 *    its own, visually distinct, owner-hold column;
 *  - ?fixture=<url> renders a bundled sample snapshot (deterministic
 *    visual-check screenshots, no network); ?drawer=pr-817 deep-links the
 *    drawer.
 *
 * gh-726 (owner 2026-10-04):
 *  - the lanes never wrap: fixed compact lane width + horizontal scroll —
 *    any lane count renders as ONE left→right strip (the 7th lane used to
 *    drop to a lone wrapped row);
 *  - dots → labeled stepper: the per-card status strip shows six NAMED
 *    steps (dev → pr → valid → review → approve → merge), each colored by
 *    state (done / current / pending / failed); the exact pipeline position
 *    reads off the strip alone. Logic lives in steps.js (unit-tested).
 *
 * v4 value stream (gh-769, owner 2026-10-06):
 *  - labeled rollups: the counts pill names each lane (dev · pr · ci · …)
 *    and a snapshot older than config.staleAfterMs announces itself as
 *    STALE — a stalled tick can no longer masquerade as repo reality;
 *  - merge-readiness: every card carries a "▸ next" line (merge / rework /
 *    approve …) with the concrete blocker (queue #1 of 3 — next on the
 *    mutex, CI red, owner hold); the approved-queue head is the board's
 *    "next up" chip. Logic lives in flow.js nextStep (unit-tested);
 *  - CI vs idle: validating chips split CI wall-time from queue wait via
 *    checks.runStartedAt/updatedAt (flow.js ciSplit);
 *  - phase rail: the drawer's history collapses rework cycles into named
 *    phases with round counts (PR created ×3) and first-pass vs rework
 *    time (flow.js phaseRail);
 *  - rework + token analytics: per-card rework ×N · time, Σ token chip on
 *    cards, and a board-level value-stream strip (flow.js flowSummary).
 */
(function () {
  'use strict';
  var CFG = window.FACTORY_BOARD_CONFIG;
  // pure analytics (flow.js) — degraded no-ops if the script is missing,
  // the board keeps rendering everything it rendered before v4
  var FLOW = window.FACTORY_FLOW || {
    tokenTotals: function () { return null; },
    ciSplit: function () { return null; },
    phaseRail: function () { return []; },
    reworkOf: function () { return { rounds: 0, ms: 0 }; },
    nextStep: function () { return null; },
    entriesOf: function () { return []; },
    flowSummary: function () { return null; }
  };
  var tabsEl = document.getElementById('factory-tabs');
  var lanesEl = document.getElementById('lanes');
  var backlogEl = document.getElementById('backlog');
  var flowEl = document.getElementById('flow');
  var errEl = document.getElementById('error');
  var statusEl = document.getElementById('statusline');
  var drawerEl = document.getElementById('drawer');
  var backdropEl = document.getElementById('drawer-backdrop');
  var active = 0;
  var fetchSeq = 0;          // single-flight: only the newest request renders
  var inFlight = null;       // AbortController of the running fetch

  // ?fixture= (visual-check mode): fetch this URL instead of the live
  // stateUrl and pin "now" to the snapshot's tick — ages, durations and
  // bars render identically no matter when the screenshot is taken.
  var FIXTURE = null;
  try { FIXTURE = new URLSearchParams(location.search).get('fixture'); } catch (eF) {}
  // same-origin only: ?fixture= must never turn this board into a renderer
  // for arbitrary remote JSON (attacker-controlled cards under our origin).
  // Relative paths (visual-check) and same-origin absolute URLs pass; any
  // other scheme/host is dropped and the live snapshot loads instead.
  try {
    if (FIXTURE && (/^[a-z][a-z0-9+.-]*:/i.test(FIXTURE) ||
                    FIXTURE.lastIndexOf('//', 0) === 0) &&
        FIXTURE.indexOf(location.origin + '/') !== 0) {
      FIXTURE = null;
    }
  } catch (eFx) { FIXTURE = null; }
  var NOW_OVERRIDE = null;   // ms; set in fixture mode after the load
  // ?drawer=pr-817 → open that card's drawer once the board renders
  var DEEP_LINK = null;
  try { DEEP_LINK = new URLSearchParams(location.search).get('drawer'); } catch (eD) {}

  // render-time index: key 'pr-817'/'issue-315' → drawer context
  var boardIndex = {};

  // schema 1 lane id → schema 2 rendering lane, as RENDER-lookup: the v2
  // lane id whose data lives under the v1 key (fresh → pr_created)
  var LANE_ALIASES = { pr_created: 'fresh' };

  // lane id → the short name the counts pill uses (gh-769: an unlabeled
  // "0 · 1 · 0 · 9" rollup is unreadable — the owner can't tell which
  // number is which lane, so the header contradicts the repo at a glance)
  var LANE_SHORT = {
    development: 'dev', pr_created: 'pr', pr_validation: 'ci',
    review: 'review', approved_queue: 'queue', validating: 'mutex',
    merged_recent: 'merged'
  };

  // ── labeled stepper (gh-726): named stages, colored by state ──────────────
  // Logic (state computation, lane→step mapping, failed-verdict detection)
  // lives in steps.js — pure and unit-tested; this file only renders.
  function stepperHtml(c, laneId) {
    var steps = (window.FACTORY_STEPS || { stepStates: function () { return []; } })
      .stepStates(c, laneId);
    if (!steps.length) return '';
    var nodes = steps.map(function (s) {
      var tip = s.at
        ? s.name + ' · ' + clockTime(s.at) + ' (' + ago(s.at) + ')'
        : s.name + ' · not reached';
      return '<span class="step st-' + s.state + '" title="' + esc(tip) + '">' +
        '<span class="step-dot"></span>' +
        '<span class="step-name">' + esc(s.name) + '</span></span>';
    }).join('');
    var cur = steps.filter(function (s) { return s.state === 'current'; });
    var pos = cur.length ? ' — now at ' + cur[0].name
      : (c.mergedAt ? ' — merged' : ' — not on the PR pipeline yet');
    return '<div class="stepper" role="img" aria-label="pipeline position' +
      esc(pos) + '">' + nodes + '</div>';
  }

  // lane → the timestamp that ENTERED it (schema 2; mirrors
  // js/factoryState.js LANE_ENTERED_AT — kept in sync deliberately).
  // pr_validation is intentionally ABSENT there (derived from an in-flight
  // CI run, not a label) — cardHtml ages those cards from their newest
  // history entry, exactly like the backlog columns.
  var LANE_ENTERED_AT = {
    development: 'devStartedAt',
    pr_created: 'prCreated',
    review: 'reviewedAt',
    approved_queue: 'approvedAt',
    validating: 'validatingAt',
    merged_recent: 'mergedAt'
  };

  // (the schema-2 → history fallback moved to flow.js entriesOf — the
  // v4 phase rail owns timeline derivation, one tested implementation)

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // href allowlist: esc() escapes markup but NOT url schemes, so a crafted
  // `javascript:`/`data:` value in a snapshot (or ?fixture= json) must fall
  // back to the config-built link — only real http(s) URLs pass through.
  function safeHref(u, fallback) {
    return /^https?:\/\//i.test(u) ? u : fallback;
  }

  function nowMs() {
    return NOW_OVERRIDE != null ? NOW_OVERRIDE : Date.now();
  }

  function ago(iso) {
    if (!iso) return '';
    var s = (nowMs() - new Date(iso).getTime()) / 1000;
    if (isNaN(s) || s < 0) return '';
    if (s < 60) return Math.max(0, Math.round(s)) + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
  }

  // human duration the way the ticket reads it: 45s · 42m · 2h13m · 3d4h
  function fmtDur(ms) {
    if (ms == null || isNaN(ms) || ms < 0) return '';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    var h = Math.floor(m / 60);
    var hm = m % 60;
    if (h < 24) return hm ? h + 'h' + hm + 'm' : h + 'h';
    var d = Math.floor(h / 24);
    var hh = h % 24;
    return hh ? d + 'd' + hh + 'h' : d + 'd';
  }

  function clockTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().slice(5, 16).replace('T', ' ') + ' UTC';
  }

  // compact token count: 940 · 115.9k · 1.2M (card chips + flow strip)
  function fmtK(n) {
    if (n == null || isNaN(n)) return '—';
    if (n >= 1e6) return (Math.round(n / 1e5) / 10) + 'M';
    if (n >= 1e3) return (Math.round(n / 100) / 10) + 'k';
    return String(n);
  }

  // ── v4 value-stream chips (gh-769) ──────────────────────────────────────────
  // Σ token spend on the card itself — a factory that reports tokens is
  // visible WITHOUT opening the drawer (the empty TOKEN SPEND drawer used
  // to be the only surface, and it rendered "not reported").
  function tokChipHtml(c) {
    var t = FLOW.tokenTotals(c);
    if (!t) return '';
    var legs = Object.keys(t.legs).map(function (k) {
      return k + ' ' + fmtK(t.legs[k].total);
    }).join(', ');
    return '<span class="tok" title="token spend — ' + esc(legs) +
      '">Σ ' + esc(fmtK(t.total)) + ' tok</span>';
  }

  // CI wall-time vs queue wait (gh-769 #6): "CI 12m · wait 35m" reads as
  // "the machine worked 12m and idled 35m" — the split the owner asked
  // for. Renders whatever parts the snapshot knows; renders nothing when
  // the run carried no timestamps.
  function ciwaitHtml(c) {
    var s = FLOW.ciSplit(c, nowMs());
    if (!s) return '';
    var bits = [];
    if (s.ciMs != null) bits.push('<b>CI ' + esc(fmtDur(s.ciMs)) + '</b>');
    if (s.queueMs != null) bits.push('wait ' + esc(fmtDur(s.queueMs)));
    return bits.length
      ? '<span class="ciwait" title="CI wall-time vs queue wait — ' +
        'queue wait is runner backlog / mutex, not work">' +
        bits.join(' · ') + '</span>'
      : '';
  }

  // what happens next / what's blocking (gh-769 #2): every non-merged card
  // names its next machine step and the concrete waiter.
  function nextHtml(c, laneId, laneLen) {
    var n = FLOW.nextStep(c, laneId, { queueLen: laneLen });
    if (!n) return '';
    var cls = n.next === 'unblock' ? ' blocked' : (n.blocking ? ' blocking' : '');
    return '<div class="next' + cls + '">' +
      '<span class="nx-arrow" aria-hidden="true">&#9656;</span>' +
      '<span class="nx-next">' + esc(n.next) + '</span>' +
      (n.detail ? '<span class="nx-detail">' + esc(n.detail) + '</span>' : '') +
      '</div>';
  }

  function verdictClass(v) {
    if (v === 'success') return 'ok';
    if (v && ['failure', 'timed_out', 'startup_failure'].indexOf(v) >= 0) return 'bad';
    return 'run';
  }

  function hasBlocked(c) {
    return (c.labels || []).indexOf('blocked') >= 0;
  }

  // ── lane summary (v3): readable "how much is left" per lane ────────────────
  // done = merged (terminal); in-flight = actively worked right now
  // (dev leg running, head validation running, mutex validating); queued =
  // waiting on the next machine step; blocked = owner hold — wins over
  // everything.
  function laneSummary(laneId, list) {
    var s = { total: list.length, done: 0, inflight: 0, queued: 0, blocked: 0 };
    list.forEach(function (c) {
      if (hasBlocked(c)) s.blocked++;
      else if (c.mergedAt) s.done++;
      else if (laneId === 'validating' || laneId === 'development' ||
               laneId === 'pr_validation') s.inflight++;
      else s.queued++;
    });
    return s;
  }

  function summaryHtml(s) {
    var parts = ['<b>' + s.total + '</b> total'];
    if (s.done) parts.push('<span class="s-done">' + s.done + ' done</span>');
    if (s.inflight) parts.push('<span class="s-inflight">' + s.inflight + ' in-flight</span>');
    if (s.queued) parts.push('<span class="s-queued">' + s.queued + ' queued</span>');
    if (s.blocked) parts.push('<span class="s-blocked">' + s.blocked + ' blocked</span>');
    return parts.join(' · ');
  }

  function barHtml(s) {
    if (!s.total) return '<div class="lane-bar" hidden></div>';
    var seg = function (n, cls) {
      return n ? '<span class="seg ' + cls + '" style="flex:' + n + '"></span>' : '';
    };
    return '<div class="lane-bar" role="img" aria-label="' + s.total + ' items: ' +
      s.done + ' done, ' + s.inflight + ' in flight, ' + s.queued + ' queued' +
      (s.blocked ? ', ' + s.blocked + ' blocked' : '') + '">' +
      seg(s.done, 'seg-done') + seg(s.inflight, 'seg-inflight') +
      seg(s.queued, 'seg-queued') + seg(s.blocked, 'seg-blocked') +
      '</div>';
  }

  function stateTitle(key) {
    var lanes = CFG.lanes || [];
    for (var i = 0; i < lanes.length; i++) {
      if (lanes[i].id === key) return lanes[i].title;
    }
    var cols = CFG.backlogColumns || [];
    for (var j = 0; j < cols.length; j++) {
      if (cols[j].id === key) return cols[j].title;
    }
    if (key === 'fresh') return 'PR created';
    return key || '—';
  }

  // ── cards ──────────────────────────────────────────────────────────────────
  function keyOf(c, laneId) {
    return (c.pr != null ? 'pr-' + c.pr : 'issue-' + c.issue) + '@' + laneId;
  }

  // badge row shared by cardHtml + drawerHeaderHtml — one styling path, so
  // label tweaks (hot set, blocked class) can never land in one and miss
  // the other.
  function badgesHtml(c) {
    var hot = CFG.badgeLabels || [];
    return (c.labels || []).map(function (l) {
      return '<span class="lbl' + (hot.indexOf(l) >= 0 ? ' hot' : '') +
             (l === 'blocked' ? ' lbl-blocked' : '') + '">' + esc(l) + '</span>';
    }).join('');
  }

  function cardHtml(c, laneId, laneLen) {
    var isIssue = c.issue != null;
    var num = isIssue ? c.issue : c.pr;
    var href = isIssue
      ? safeHref(c.url, CFG.prUrl(c.repo, num, 'issues'))
      : CFG.prUrl(c.repo, num);
    var badges = badgesHtml(c);
    var checks = c.checks
      ? '<span class="checks"><span class="dot ' + verdictClass(c.checks.verdict) +
        '"></span><span>' + esc(c.checks.verdict) + ' · ' + esc(ago(c.checks.at)) +
        '</span></span>'
      : '';
    var pos = c.queuePos ? '<span class="pos">#' + esc(c.queuePos) + '</span>' : '';
    var who = isIssue && c.assignee
      ? '<span class="author">@' + esc(c.assignee) + '</span>' : '';
    var tok = tokChipHtml(c);
    var ciwait = ciwaitHtml(c);
    // age in the CURRENT lane (schema 2 timestamps; null on schema 1).
    // Backlog columns have no LANE_ENTERED_AT field — fall back to the
    // newest history entry (stamped on every bucket transition); the
    // first-ever entry may carry no `at` — honest unknown, no chip.
    var enteredAt = c[LANE_ENTERED_AT[laneId]];
    if (!enteredAt && c.history && c.history.length) {
      var last = c.history[c.history.length - 1];
      enteredAt = last.at || null;
    }
    var age = enteredAt
      ? '<span class="age" title="in this state since ' +
        esc(clockTime(enteredAt)) + '">' + esc(ago(enteredAt)) + '</span>'
      : '';
    return '<a class="card' + (isIssue ? ' card-issue' : '') +
        '" href="' + esc(href) + '" target="_blank" rel="noopener" ' +
        'data-key="' + esc(keyOf(c, laneId)) + '">' +
      '<div class="card-top">' + pos +
      '<span class="pr">' + (isIssue ? '#' : '!') + esc(num) + '</span>' +
      '<span class="title">' + esc(c.title || '') + '</span>' + age + '</div>' +
      (badges ? '<div class="labels">' + badges + '</div>' : '') +
      ((checks || who || c.author || tok || ciwait)
        ? '<div class="meta">' + who +
          (c.author && !isIssue ? '<span class="author">' +
          esc(c.author) + '</span>' : '') + checks + ciwait + tok + '</div>'
        : '') +
      stepperHtml(c, laneId) +
      nextHtml(c, laneId, laneLen) +
      '</a>';
  }

  // ── skeleton + error states ────────────────────────────────────────────────
  function skeleton() {
    statusEl.hidden = true;
    errEl.hidden = true;
    backlogEl.innerHTML = '';
    backlogEl.hidden = true;
    lanesEl.innerHTML = CFG.lanes.map(function (l) {
      return '<div class="lane loading"><div class="lane-head"><span>' +
        esc(l.title) + '</span><span class="count">·</span></div>' +
        '<div class="lane-body">' +
        '<div class="sk card-sk"></div><div class="sk card-sk"></div>' +
        '</div></div>';
    }).join('');
  }

  function fail(f, msg) {
    skeleton();                       // clear stale lanes — never keep old data
    errEl.hidden = false;
    errEl.innerHTML = '<span class="err-dot"></span>' + esc(f.name) +
      ': ' + esc(msg) +
      ' — <a href="' + esc(f.stateUrl) + '" target="_blank" rel="noopener">state file</a>';
  }

  // ── lane column (PR pipeline) ──────────────────────────────────────────────
  function laneHtml(f, l, list) {
    var s = laneSummary(l.id, list);
    var cards = list.map(function (c) {
      c.repo = st_repo;
      return cardHtml(c, l.id, list.length);
    }).join('');
    return '<div class="lane" style="--accent:' + esc(f.accent) + '">' +
      '<div class="lane-head"><span>' + esc(l.title) + '</span>' +
      '<span class="count">' + s.total + '</span></div>' +
      '<div class="lane-sum">' + summaryHtml(s) + '</div>' +
      barHtml(s) +
      '<div class="lane-body">' + (cards || '<div class="empty">—</div>') +
      '</div></div>';
  }

  // ── backlog section (v3): issue lanes from the same snapshot ───────────────
  function backlogHtml(f, st) {
    var cols = CFG.backlogColumns || [];
    var b = st.backlog || {};
    var any = cols.some(function (c) { return (b[c.id] || []).length; });
    if (!any) return '';
    var html = '<h2 class="backlog-title">Backlog · open issues</h2>' +
      '<div class="backlog-cols">';
    cols.forEach(function (col) {
      var list = b[col.id] || [];
      var cards = list.map(function (c) {
        c.repo = st_repo;
        return cardHtml(c, col.id, list.length);
      }).join('');
      html += '<div class="lane lane-backlog' +
        (col.id === 'blocked' ? ' lane-blocked' : '') +
        '" style="--accent:' + esc(f.accent) + '">' +
        '<div class="lane-head"><span>' + esc(col.title) + '</span>' +
        '<span class="count">' + list.length + '</span></div>' +
        '<div class="lane-body">' +
        (cards || '<div class="empty">—</div>') + '</div></div>';
    });
    return html + '</div>';
  }

  // ── board-level value stream (gh-769) ──────────────────────────────────────
  // The Lean strip under the lanes: where the flow's time actually goes
  // (per phase), Σ rework, Σ token spend, average lead, and the queue head
  // ("next up") — the aggregate the per-card chips roll up into. PR-pipeline
  // lanes only: backlog twins share one story with their lane cards and
  // would double-count every phase.
  function flowHtml(f, st) {
    var lanes = st.lanes || {};
    var cards = [];
    (CFG.lanes || []).forEach(function (l) {
      (lanes[l.id] || []).forEach(function (c) { if (c) cards.push(c); });
    });
    if (!cards.length) return '';
    var s = FLOW.flowSummary(cards, nowMs());
    var chips = [];
    // next up = the approved-queue head — "this one merges next" at a glance
    var queue = lanes.approved_queue || [];
    if (queue.length && queue[0].pr != null) {
      chips.push('<span class="flow-chip fc-up"><span class="fc-next">next up !' +
        esc(queue[0].pr) + '</span>' +
        (queue[0].title ? ' · ' + esc(String(queue[0].title).slice(0, 42)) : '') +
        '</span>');
    }
    (s.phases || []).forEach(function (p) {
      if (!p.cards) return;
      chips.push('<span class="flow-chip"><b>' + esc(stateTitle(p.state)) +
        '</b> ' + p.cards + ' card' + (p.cards > 1 ? 's' : '') +
        (p.totalMs ? ' · &Sigma; ' + esc(fmtDur(p.totalMs)) +
          ' · avg ' + esc(fmtDur(Math.round(p.totalMs / p.cards))) : '') +
        '</span>');
    });
    if (s.rework.rounds) {
      chips.push('<span class="flow-chip rw"><b>rework &times;' + s.rework.rounds +
        '</b>' + (s.rework.ms ? ' · &Sigma; ' + esc(fmtDur(s.rework.ms)) : '') +
        '</span>');
    }
    if (s.tokens) {
      chips.push('<span class="flow-chip" title="' +
        Object.keys(s.tokens.legs).map(function (k) {
          return k + ' ' + fmtK(s.tokens.legs[k].total);
        }).join(', ') +
        '"><b>&Sigma; ' + esc(fmtK(s.tokens.total)) + ' tok</b> · ' +
        Object.keys(s.tokens.legs).length + ' legs</span>');
    }
    if (s.lead && s.lead.avgMs != null) {
      chips.push('<span class="flow-chip"><b>lead avg ' + esc(fmtDur(s.lead.avgMs)) +
        '</b>' + (s.lead.maxMs ? ' · max ' + esc(fmtDur(s.lead.maxMs)) : '') +
        '</span>');
    }
    if (!chips.length) return '';
    return '<h2 class="flow-title">Value stream · ' + s.cards + ' in view</h2>' +
      '<div class="flow-chips">' + chips.join('') + '</div>';
  }

  // ── details drawer (v3) ────────────────────────────────────────────────────
  function drawerHeaderHtml(ctx) {
    var c = ctx.item;
    var isIssue = c.issue != null;
    var num = isIssue ? c.issue : c.pr;
    var href = isIssue
      ? safeHref(c.url, CFG.prUrl(ctx.repo, num, 'issues'))
      : CFG.prUrl(ctx.repo, num);
    var badges = badgesHtml(c);
    return '<div class="drawer-head">' +
      '<div class="drawer-titleline">' +
      '<span class="pr">' + (isIssue ? '#' : '!') + esc(num) + '</span>' +
      '<span class="drawer-title">' + esc(c.title || '') + '</span>' +
      '<button class="drawer-x" id="drawer-x" title="close (esc)" ' +
      'aria-label="close">&#215;</button></div>' +
      '<div class="drawer-attrs">' +
      '<span class="pill pill-state">' + esc(ctx.stateName) + '</span>' +
      (!isIssue && c.head
        ? '<span class="pill" title="head sha">' + esc(String(c.head).slice(0, 7)) +
          '</span>' : '') +
      (!isIssue && c.branch ? '<span class="pill">' + esc(c.branch) + '</span>' : '') +
      (isIssue && c.assignee ? '<span class="pill">@' + esc(c.assignee) + '</span>' : '') +
      badges +
      '<a class="pill pill-link" href="' + esc(href) +
      '" target="_blank" rel="noopener">open on github &#8599;</a>' +
      '</div></div>';
  }

  // phase rail (gh-769 #4): the raw history repeats 'PR created' once per
  // rework cycle with no phase boundaries — the rail collapses repeats into
  // ONE named phase with round counts (PR created ×3) and splits first-pass
  // vs rework time. Times unknown on old snapshots stay '—' (honest).
  function drawerHistoryHtml(c) {
    var terminal = !!(c.mergedAt || (c.history || []).some(function (h) {
      return h.state === 'merged_recent';
    }));
    var rail = FLOW.phaseRail(FLOW.entriesOf(c), nowMs(), terminal);
    if (!rail.length) {
      return '<section class="drawer-sec"><h3>State history</h3>' +
        '<p class="drawer-empty">—</p></section>';
    }
    var maxDur = rail.reduce(function (m, p) {
      return (p.totalMs != null && p.totalMs > m) ? p.totalMs : m;
    }, 0);
    var rows = rail.slice().reverse().map(function (p) {
      var w = (p.totalMs != null && maxDur)
        ? Math.max(4, Math.round(100 * p.totalMs / maxDur)) : 0;
      return '<div class="hist-row">' +
        '<span class="hist-state">' + esc(stateTitle(p.state)) +
        (p.rounds > 1 ? ' <span class="hist-x" title="' + p.rounds +
          ' entries collapsed — rework rounds">×' + p.rounds + '</span>' : '') +
        '</span>' +
        '<span class="hist-time">' +
        (p.from != null ? esc(clockTime(new Date(p.from).toISOString())) : '—') +
        (p.from != null ? ' <span class="hist-ago">(' + esc(ago(new Date(p.from).toISOString())) + ')</span>' : '') +
        '</span>' +
        '<span class="hist-dur">' +
        '<span class="hist-bar"><span class="hist-fill" style="width:' + w + '%"></span></span>' +
        '<span class="hist-durnum">' + (p.totalMs != null ? esc(fmtDur(p.totalMs)) : '—') + '</span>' +
        '</span>' +
        (p.reworkRounds
          ? '<span class="hist-rw">rework ×' + p.reworkRounds +
            (p.reworkMs ? ' · ' + esc(fmtDur(p.reworkMs)) : '') + '</span>'
          : '') +
        '</div>';
    }).join('');
    return '<section class="drawer-sec"><h3>State history · phases</h3>' + rows +
      '</section>';
  }

  // per-card value stream (gh-769): lead time, rework rounds, the CI-vs-
  // wait split of the current validating stint, Σ tokens. Rendered only
  // when at least one line is known — absent data never renders as zero.
  function drawerFlowHtml(c) {
    var rows = [];
    var start = c.prCreated ? Date.parse(c.prCreated) : null;
    if (!isNaN(start) && start != null) {
      var end = c.mergedAt ? Date.parse(c.mergedAt) : nowMs();
      var lead = Math.max(0, end - start);
      rows.push(['lead time', '<b>' + esc(fmtDur(lead)) + '</b>' +
        (c.mergedAt ? ' created &#8594; merged' : ' and counting')]);
    }
    var terminal = !!(c.mergedAt || (c.history || []).some(function (h) {
      return h.state === 'merged_recent';
    }));
    var rw = FLOW.reworkOf(FLOW.phaseRail(FLOW.entriesOf(c), nowMs(), terminal));
    if (rw.rounds) {
      rows.push(['rework', '<b>&times;' + rw.rounds + '</b>' +
        (rw.ms ? ' · ' + esc(fmtDur(rw.ms)) : '') + ' in re-visited phases']);
    }
    var ci = FLOW.ciSplit(c, nowMs());
    if (ci) {
      rows.push(['validating', (ci.ciMs != null ? '<b>CI ' + esc(fmtDur(ci.ciMs)) + '</b>' : 'CI —') +
        (ci.queueMs != null ? ' · wait ' + esc(fmtDur(ci.queueMs)) : '')]);
    }
    var t = FLOW.tokenTotals(c);
    if (t) {
      var legs = Object.keys(t.legs).map(function (k) {
        return esc(k) + ' ' + esc(fmtK(t.legs[k].total));
      }).join(', ');
      rows.push(['tokens', '<b>&Sigma; ' + esc(fmtK(t.total)) + '</b> — ' + legs]);
    }
    if (!rows.length) return '';
    var body = rows.map(function (r) {
      return '<div class="vs-row"><span class="vs-k">' + r[0] + '</span>' +
        '<span class="vs-v">' + r[1] + '</span></div>';
    }).join('');
    return '<section class="drawer-sec"><h3>Value stream</h3>' + body + '</section>';
  }

  function drawerTokensHtml(c) {
    var rows = c.tokens || [];
    var body;
    if (!rows.length) {
      body = '<p class="drawer-empty">tokens — not reported by this factory</p>';
    } else {
      var tot = { prompt: 0, completion: 0, total: 0 };
      var trs = rows.map(function (t) {
        tot.prompt += t.prompt || 0;
        tot.completion += t.completion || 0;
        tot.total += t.total || 0;
        return '<tr><td>' + esc(t.leg || '—') + '</td>' +
          '<td>' + (t.at ? esc(ago(t.at)) : '—') + '</td>' +
          '<td class="num">' + (t.prompt || 0).toLocaleString() + '</td>' +
          '<td class="num">' + (t.completion || 0).toLocaleString() + '</td>' +
          '<td class="num"><b>' + (t.total || 0).toLocaleString() + '</b></td></tr>';
      }).join('');
      body = '<table class="tok-table"><thead><tr>' +
        '<th>leg</th><th>when</th><th class="num">prompt</th>' +
        '<th class="num">completion</th><th class="num">total</th>' +
        '</tr></thead><tbody>' + trs +
        '<tr class="tok-total"><td>total</td><td></td>' +
        '<td class="num">' + tot.prompt.toLocaleString() + '</td>' +
        '<td class="num">' + tot.completion.toLocaleString() + '</td>' +
        '<td class="num"><b>' + tot.total.toLocaleString() + '</b></td></tr>' +
        '</tbody></table>';
    }
    return '<section class="drawer-sec"><h3>Token spend</h3>' + body +
      '</section>';
  }

  var openCtx = null;   // drawer context of the currently open drawer

  function openDrawer(ctx) {
    openCtx = ctx;
    drawerEl.innerHTML =
      '<div class="drawer-inner">' + drawerHeaderHtml(ctx) +
      drawerHistoryHtml(ctx.item) + drawerFlowHtml(ctx.item) +
      drawerTokensHtml(ctx.item) + '</div>';
    drawerEl.hidden = false;
    backdropEl.hidden = false;
    var x = document.getElementById('drawer-x');
    if (x) x.onclick = closeDrawer;
  }

  function closeDrawer() {
    openCtx = null;
    drawerEl.hidden = true;
    backdropEl.hidden = true;
    drawerEl.innerHTML = '';
  }

  function drawerCtxFor(key) {
    var hit = boardIndex[key];
    if (!hit) return null;
    return {
      item: hit.item,
      repo: hit.repo,
      stateName: stateTitle(hit.laneId)
    };
  }

  // card clicks → drawer (delegated); plain href kept for middle-click /
  // open-in-new-tab — a plain click never leaves the page.
  function onCardClick(e) {
    var a = e.target && e.target.closest ? e.target.closest('.card') : null;
    if (!a) return;
    var key = a.getAttribute('data-key');
    var ctx = key && drawerCtxFor(key);
    if (!ctx) return;             // no context — let the link navigate
    e.preventDefault();
    openDrawer(ctx);
  }

  // ── render ─────────────────────────────────────────────────────────────────
  var st_repo = '';

  function render(f, st) {
    if (f !== CFG.factories[active]) return;   // stale response — drop
    document.getElementById('brand-title').textContent =
      (CFG.title || 'Factory') + ' — ' + f.name;
    document.title = f.name + ' — factory board';
    statusEl.hidden = false;
    if (FIXTURE && st.tick && st.tick.at) {
      var t0 = Date.parse(st.tick.at);
      if (!isNaN(t0)) NOW_OVERRIDE = t0 + 7000;  // deterministic screenshot "now"
    }
    var t = st.tick || {};
    // gh-769 #1: a stalled SM tick used to leave lanes that contradicted
    // the live repo with no hint anything was wrong. A snapshot older than
    // staleAfterMs now announces itself — STALE pill, red, with the age.
    var tickPill = document.getElementById('tick-pill');
    var tickAge = t.at ? (nowMs() - Date.parse(t.at)) : null;
    var staleAfter = CFG.staleAfterMs || 30 * 60 * 1000;
    var stale = tickAge != null && !isNaN(tickAge) && tickAge > staleAfter;
    tickPill.innerHTML = 'tick ' + esc(ago(t.at)) +
      (t.dryRun ? ' · <b>DRY</b>' : '') + (stale ? ' · <b>STALE</b>' : '');
    tickPill.classList.toggle('stale', stale);
    tickPill.title = stale
      ? 'snapshot is ' + fmtDur(Math.max(0, tickAge)) +
        ' old — these lanes may not match the repo (SM tick stalled?)'
      : 'state snapshot age';
    // gh-769 #1: the unlabeled "0 · 1 · 0 · 9" rollup was unreadable —
    // every number now names its lane.
    document.getElementById('counts-pill').textContent =
      CFG.lanes.map(function (l) {
        return (LANE_SHORT[l.id] || l.id) + ' ' +
          ((st.counts && st.counts[l.id]) || 0);
      }).join(' · ');
    var bc = st.backlogCounts || {};
    var backlogSummary = (CFG.backlogColumns || []).map(function (c) {
      return (bc[c.id] || 0) + ' ' + c.id.replace('_', '-');
    }).join(' · ');
    // pre-v3 snapshots carry no backlog section — absent data renders as
    // absent (hidden pill), never as a lying "issues: 0 …" empty backlog
    var pill = document.getElementById('backlog-pill');
    if (st.backlog) {
      pill.hidden = false;
      pill.textContent = 'issues: ' + backlogSummary;
    } else {
      pill.hidden = true;
    }
    document.getElementById('repo-pill').textContent = st.repo || '';
    document.getElementById('schema-pill').textContent =
      'schema ' + (st.schema || 1);

    st_repo = st.repo || '';
    boardIndex = {};
    var lanes = st.lanes || {};
    lanesEl.innerHTML = CFG.lanes.map(function (l) {
      // schema 1 snapshots: the pre-v2 lane ids map onto the v2 grid
      var list = lanes[l.id] ||
                 (LANE_ALIASES[l.id] ? (lanes[LANE_ALIASES[l.id]] || []) : []);
      list.forEach(function (c) {
        if (!c) return;
        // index BOTH card kinds: the development lane holds ISSUE cards
        // (data-key="issue-N@development") — they must open the drawer
        // exactly like their backlog twins, not fall through to GitHub nav
        if (c.pr != null) {
          boardIndex['pr-' + c.pr + '@' + l.id] =
            { item: c, repo: st_repo, laneId: l.id };
        } else if (c.issue != null) {
          boardIndex['issue-' + c.issue + '@' + l.id] =
            { item: c, repo: st_repo, laneId: l.id };
        }
      });
      return laneHtml(f, l, list);
    }).join('');
    (CFG.backlogColumns || []).forEach(function (col) {
      ((st.backlog || {})[col.id] || []).forEach(function (c) {
        if (c && c.issue != null) {
          boardIndex['issue-' + c.issue + '@' + col.id] =
            { item: c, repo: st_repo, laneId: col.id };
        }
      });
    });
    backlogEl.innerHTML = backlogHtml(f, st);
    backlogEl.hidden = !backlogEl.innerHTML;
    flowEl.innerHTML = flowHtml(f, st);
    flowEl.hidden = !flowEl.innerHTML;
    errEl.hidden = true;
    if (DEEP_LINK) {
      var ctx = drawerCtxFor(DEEP_LINK);
      if (ctx) { openDrawer(ctx); DEEP_LINK = null; }
    }
  }

  // ── loading (single-flight) ────────────────────────────────────────────────
  function load() {
    var f = CFG.factories[active];
    if (!f) return;
    var seq = ++fetchSeq;
    if (inFlight) { try { inFlight.abort(); } catch (e) {} }
    var ctl = ('AbortController' in window) ? new AbortController() : null;
    inFlight = ctl;
    var opts = { cache: 'no-store' };
    if (ctl) opts.signal = ctl.signal;
    fetch(FIXTURE || f.stateUrl, opts)
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (st) {
        if (seq !== fetchSeq) return;  // a newer request owns the board
        render(f, st);
      })
      .catch(function (e) {
        if (seq !== fetchSeq) return;
        if (e && e.name === 'AbortError') return;
        fail(f, 'no state yet (' + (e.message || e) + ')');
      });
  }

  function switchTo(i) {
    active = i;
    renderTabs();
    closeDrawer();
    skeleton();     // immediate feedback — no stale lanes, ever
    load();
  }

  function renderTabs() {
    tabsEl.innerHTML = CFG.factories.map(function (f, i) {
      return '<button class="tab' + (i === active ? ' on' : '') +
        '" data-i="' + i + '" style="--accent:' + esc(f.accent) + '">' +
        esc(f.name) + '</button>';
    }).join('');
    Array.prototype.forEach.call(tabsEl.querySelectorAll('.tab'), function (b) {
      b.onclick = function () {
        var i = +b.getAttribute('data-i');
        if (i !== active) switchTo(i);
      };
    });
  }

  function tickClock() {
    document.getElementById('clock').textContent =
      new Date().toLocaleTimeString();
  }

  document.getElementById('theme-btn').onclick = function () {
    var el = document.documentElement;
    var t = el.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    el.setAttribute('data-theme', t);
    try { localStorage.setItem('fb-theme', t); } catch (e) {}
  };

  lanesEl.addEventListener('click', onCardClick);
  backlogEl.addEventListener('click', onCardClick);
  backdropEl.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !drawerEl.hidden) closeDrawer();
  });

  tickClock();
  setInterval(tickClock, 1000);
  renderTabs();
  skeleton();
  load();
  setInterval(load, CFG.refreshMs || 60000);
})();
