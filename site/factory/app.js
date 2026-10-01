/* Factory Board v2 — reads the SM tick's state snapshots, no build step.
 *
 * v2 (owner 2026-10-01):
 *  - schema 1 AND schema 2 snapshots render (old history never breaks);
 *  - lifecycle timestamps: card age in its current lane + a mini SVG
 *    timeline of the pipeline transitions (tooltips carry the times);
 *  - tab switches clear the board to a skeleton instantly, fetches are
 *    single-flight (AbortController) and only the LAST request renders —
 *    a failed fetch can no longer leave the previous factory's lanes up.
 */
(function () {
  'use strict';
  var CFG = window.FACTORY_BOARD_CONFIG;
  var tabsEl = document.getElementById('factory-tabs');
  var lanesEl = document.getElementById('lanes');
  var errEl = document.getElementById('error');
  var statusEl = document.getElementById('statusline');
  var active = 0;
  var fetchSeq = 0;          // single-flight: only the newest request renders
  var inFlight = null;       // AbortController of the running fetch

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
  // js/factoryState.js LANE_ENTERED_AT — kept in sync deliberately)
  var LANE_ENTERED_AT = {
    development: 'devStartedAt',
    pr_created: 'prCreated',
    review: 'reviewedAt',
    approved_queue: 'approvedAt',
    validating: 'validatingAt',
    merged_recent: 'mergedAt'
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function ago(iso) {
    if (!iso) return '';
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (isNaN(s) || s < 0) return '';
    if (s < 60) return Math.max(0, Math.round(s)) + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
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
  function cardHtml(st, laneId, c) {
    var repo = st.repo || '';
    var isIssue = c.issue != null;
    var num = isIssue ? c.issue : c.pr;
    var href = isIssue
      ? (c.url || CFG.prUrl(repo, num, 'issues'))
      : CFG.prUrl(repo, num);
    var hot = CFG.badgeLabels || [];
    var badges = (c.labels || []).map(function (l) {
      return '<span class="lbl' + (hot.indexOf(l) >= 0 ? ' hot' : '') + '">' +
             esc(l) + '</span>';
    }).join('');
    var checks = c.checks
      ? '<span class="checks"><span class="dot ' + verdictClass(c.checks.verdict) +
        '"></span><span>' + esc(c.checks.verdict) + ' · ' + esc(ago(c.checks.at)) +
        '</span></span>'
      : '';
    var pos = c.queuePos ? '<span class="pos">#' + esc(c.queuePos) + '</span>' : '';
    // age in the CURRENT lane (schema 2 timestamps; null on schema 1)
    var enteredAt = c[LANE_ENTERED_AT[laneId]];
    var age = enteredAt
      ? '<span class="age" title="in this state since ' +
        esc(clockTime(enteredAt)) + '">' + esc(ago(enteredAt)) + '</span>'
      : '';
    return '<a class="card" href="' + esc(href) + '" target="_blank" rel="noopener">' +
      '<div class="card-top">' + pos +
      '<span class="pr">' + (isIssue ? '#' : '!') + esc(num) + '</span>' +
      '<span class="title">' + esc(c.title || '') + '</span>' + age + '</div>' +
      (badges ? '<div class="labels">' + badges + '</div>' : '') +
      ((checks || c.author)
        ? '<div class="meta">' + (c.author ? '<span class="author">' +
          esc(c.author) + '</span>' : '') + checks + '</div>'
        : '') +
      timelineSvg(c) +
      '</a>';
  }

  // ── skeleton + error states ────────────────────────────────────────────────
  function skeleton() {
    statusEl.hidden = true;
    errEl.hidden = true;
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

  // ── render ─────────────────────────────────────────────────────────────────
  function render(f, st) {
    if (f !== CFG.factories[active]) return;   // stale response — drop
    document.getElementById('brand-title').textContent =
      (CFG.title || 'Factory') + ' — ' + f.name;
    document.title = f.name + ' — factory board';
    statusEl.hidden = false;
    var t = st.tick || {};
    document.getElementById('tick-pill').innerHTML =
      'tick ' + esc(ago(t.at)) + (t.dryRun ? ' · <b>DRY</b>' : '');
    document.getElementById('counts-pill').textContent =
      CFG.lanes.map(function (l) {
        return (st.counts && st.counts[l.id]) || 0;
      }).join(' · ');
    document.getElementById('repo-pill').textContent = st.repo || '';
    document.getElementById('schema-pill').textContent =
      'schema ' + (st.schema || 1);

    var lanes = st.lanes || {};
    lanesEl.innerHTML = CFG.lanes.map(function (l) {
      // schema 1 snapshots: the pre-v2 lane ids map onto the v2 grid
      var list = lanes[l.id] ||
                 (LANE_ALIASES[l.id] ? (lanes[LANE_ALIASES[l.id]] || []) : []);
      var cards = list.map(function (c) { return cardHtml(st, l.id, c); }).join('');
      var n = list.length;
      return '<div class="lane" style="--accent:' + esc(f.accent) + '">' +
        '<div class="lane-head"><span>' + esc(l.title) + '</span>' +
        '<span class="count">' + n + '</span></div>' +
        '<div class="lane-body">' + (cards || '<div class="empty">—</div>') +
        '</div></div>';
    }).join('');
    errEl.hidden = true;
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
    fetch(f.stateUrl, opts)
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

  tickClock();
  setInterval(tickClock, 1000);
  renderTabs();
  skeleton();
  load();
  setInterval(load, CFG.refreshMs || 60000);
})();
