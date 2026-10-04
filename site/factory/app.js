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
 */
(function () {
  'use strict';
  var CFG = window.FACTORY_BOARD_CONFIG;
  var tabsEl = document.getElementById('factory-tabs');
  var lanesEl = document.getElementById('lanes');
  var backlogEl = document.getElementById('backlog');
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

  // pipeline stages for the mini timeline, in order; `k` = card field
  var STAGES = [
    { k: 'devStartedAt', cls: 'st-dev',  name: 'dev started' },
    { k: 'prCreated',    cls: 'st-pr',   name: 'PR created' },
    { k: 'reviewedAt',   cls: 'st-rev',  name: 'reviewed' },
    { k: 'approvedAt',   cls: 'st-app',  name: 'approved' },
    { k: 'validatingAt', cls: 'st-val',  name: 'validating' },
    { k: 'mergedAt',     cls: 'st-mrg',  name: 'merged' }
  ];

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

  // schema-2 timestamp field → lane key — the drawer's history fallback
  // for snapshots accumulated before card.history existed (v3 additive
  // schema: old snapshots must still yield a usable timeline)
  var TS_TO_STATE = [
    { k: 'devStartedAt', state: 'development' },
    { k: 'prCreated',    state: 'pr_created' },
    { k: 'reviewedAt',   state: 'review' },
    { k: 'approvedAt',   state: 'approved_queue' },
    { k: 'validatingAt', state: 'validating' },
    { k: 'mergedAt',     state: 'merged_recent' }
  ];

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

  // ── card history + timings (drawer) ────────────────────────────────────────
  // Prefer the snapshot-accumulated card.history (v3); fall back to the
  // schema-2 timestamp fields so old snapshots still yield a timeline.
  // Returns [{state, at}] oldest first (times as ms or null when unknown).
  function cardHistory(c) {
    var entries = (c.history && c.history.length)
      ? c.history.map(function (h) {
          return { state: h.state, at: h.at ? Date.parse(h.at) : null };
        })
      : TS_TO_STATE.filter(function (m) { return c[m.k]; })
          .map(function (m) {
            return { state: m.state, at: Date.parse(c[m.k]) };
          });
    return entries.sort(function (a, b) {
      return (a.at == null ? 0 : a.at) - (b.at == null ? 0 : b.at);
    });
  }

  // per-state durations: ms spent in each entry up to the next transition;
  // the live (last) entry runs until now — unless terminal (merged)
  function stateTimings(entries, terminal) {
    return entries.map(function (e, i) {
      var next = entries[i + 1];
      var dur;
      if (e.at == null) dur = null;
      else if (next && next.at != null) dur = next.at - e.at;
      else if (next) dur = null;
      else dur = terminal ? null : Math.max(0, nowMs() - e.at);
      return { state: e.state, at: e.at, dur: dur };
    });
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

  // ── mini timeline (SVG): transition dots on a proportional axis ────────────
  function timelineSvg(c) {
    var pts = STAGES.filter(function (s) { return c[s.k]; })
      .map(function (s) {
        return { t: new Date(c[s.k]).getTime(), cls: s.cls,
                 name: s.name, raw: c[s.k] };
      })
      .filter(function (p) { return !isNaN(p.t); })
      .sort(function (a, b) { return a.t - b.t; });
    if (pts.length < 1) return '';
    var min = pts[0].t, max = pts[pts.length - 1].t;
    var span = Math.max(max - min, 1);
    var dots = pts.map(function (p, i) {
      var x = pts.length === 1 ? 50 : 3 + (94 * (p.t - min) / span);
      var first = i === 0, last = i === pts.length - 1;
      return '<circle class="' + p.cls + (first ? ' first' : '') +
             (last ? ' last' : '') + '" cx="' + x.toFixed(1) +
             '" cy="5" r="' + (first || last ? 3 : 2.5) + '">' +
             '<title>' + esc(p.name) + ' · ' + esc(clockTime(p.raw)) +
             ' (' + esc(ago(p.raw)) + ')</title></circle>';
    }).join('');
    return '<svg class="tl" viewBox="0 0 100 10" preserveAspectRatio="none" ' +
      'role="img" aria-label="pipeline timeline">' +
      '<line class="tl-axis" x1="3" y1="5" x2="97" y2="5"></line>' +
      (pts.length === 1 ? '' : dots) +
      (pts.length === 1
        ? '<circle class="' + pts[0].cls + ' first last" cx="50" cy="5" r="3">' +
          '<title>' + esc(pts[0].name) + ' · ' + esc(clockTime(pts[0].raw)) +
          ' (' + esc(ago(pts[0].raw)) + ')</title></circle>'
        : '') +
      '</svg>';
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

  function cardHtml(c, laneId) {
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
      ((checks || who || c.author)
        ? '<div class="meta">' + who +
          (c.author && !isIssue ? '<span class="author">' +
          esc(c.author) + '</span>' : '') + checks + '</div>'
        : '') +
      timelineSvg(c) +
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
      return cardHtml(c, l.id);
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
        return cardHtml(c, col.id);
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

  function drawerHistoryHtml(c) {
    var terminal = !!(c.mergedAt || (c.history || []).some(function (h) {
      return h.state === 'merged_recent';
    }));
    var timings = stateTimings(cardHistory(c), terminal);
    var maxDur = timings.reduce(function (m, t) {
      return (t.dur != null && t.dur > m) ? t.dur : m;
    }, 0);
    if (!timings.length) {
      return '<section class="drawer-sec"><h3>State history</h3>' +
        '<p class="drawer-empty">—</p></section>';
    }
    var rows = timings.slice().reverse().map(function (t) {
      var w = (t.dur != null && maxDur)
        ? Math.max(4, Math.round(100 * t.dur / maxDur)) : 0;
      return '<div class="hist-row">' +
        '<span class="hist-state">' + esc(stateTitle(t.state)) + '</span>' +
        '<span class="hist-time">' +
        (t.at != null ? esc(clockTime(new Date(t.at).toISOString())) : '—') +
        (t.at != null ? ' <span class="hist-ago">(' + esc(ago(new Date(t.at).toISOString())) + ')</span>' : '') +
        '</span>' +
        '<span class="hist-dur">' +
        '<span class="hist-bar"><span class="hist-fill" style="width:' + w + '%"></span></span>' +
        '<span class="hist-durnum">' + (t.dur != null ? esc(fmtDur(t.dur)) : '—') + '</span>' +
        '</span></div>';
    }).join('');
    return '<section class="drawer-sec"><h3>State history</h3>' + rows +
      '</section>';
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
      drawerHistoryHtml(ctx.item) + drawerTokensHtml(ctx.item) + '</div>';
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
    document.getElementById('tick-pill').innerHTML =
      'tick ' + esc(ago(t.at)) + (t.dryRun ? ' · <b>DRY</b>' : '');
    document.getElementById('counts-pill').textContent =
      CFG.lanes.map(function (l) {
        return (st.counts && st.counts[l.id]) || 0;
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
