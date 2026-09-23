/* Factory board — reads the SM tick's state snapshots, no build step. */
(function () {
  'use strict';
  var CFG = window.FACTORY_BOARD_CONFIG;
  var tabsEl = document.getElementById('factory-tabs');
  var lanesEl = document.getElementById('lanes');
  var errEl = document.getElementById('error');
  var statusEl = document.getElementById('statusline');
  var active = 0;
  var cache = {};

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function ago(iso) {
    if (!iso) return '';
    var s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (isNaN(s)) return '';
    if (s < 60) return Math.max(0, Math.round(s)) + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  function verdictClass(v) {
    if (v === 'success') return 'ok';
    if (v && ['failure', 'timed_out', 'startup_failure'].indexOf(v) >= 0) return 'bad';
    return 'run';
  }

  function card(f, c) {
    var badges = (c.labels || []).map(function (l) {
      var hot = CFG.badgeLabels.indexOf(l) >= 0;
      return '<span class="lbl' + (hot ? ' hot' : '') + '">' + esc(l) + '</span>';
    }).join('');
    var checks = c.checks
      ? '<div class="checks"><span class="dot ' + verdictClass(c.checks.verdict) + '">' +
        '</span><span>' + esc(c.checks.verdict) + ' · ' + esc(ago(c.checks.at)) + '</span></div>'
      : '';
    var pos = c.queuePos ? '<span class="pos">#' + c.queuePos + '</span>' : '';
    return '<a class="card" href="' + CFG.prUrl(f.repo, c.pr) + '" target="_blank" rel="noopener">' +
      '<div class="card-top">' + pos + '<span class="pr">!' + esc(c.pr) + '</span>' +
      '<span class="title">' + esc(c.title || '') + '</span></div>' +
      '<div class="labels">' + badges + '</div>' + checks + '</a>';
  }

  function render(f, st) {
    cache[f.id] = st;
    if (active !== CFG.factories.indexOf(f)) return;
    document.getElementById('brand-title').textContent =
      (CFG.title || 'Factory') + ' — ' + f.name;
    document.title = f.name + ' — factory board';
    statusEl.hidden = false;
    var t = st.tick || {};
    document.getElementById('tick-pill').innerHTML =
      'tick ' + esc(ago(t.at)) + (t.dryRun ? ' · <b>DRY</b>' : '');
    document.getElementById('counts-pill').textContent =
      CFG.lanes.map(function (l) {
        return (st.counts && st.counts[l.id]) || 0 + ' ';
      }).map(function (_, i) {
        return (st.counts ? (st.counts[CFG.lanes[i].id] || 0) : 0) +
               ' ' + CFG.lanes[i].title.split(' ')[0].toLowerCase();
      }).join(' · ');
    document.getElementById('repo-pill').textContent = st.repo || '';
    lanesEl.innerHTML = CFG.lanes.map(function (l) {
      var cards = ((st.lanes || {})[l.id] || []).map(function (c) {
        return card(f, c);
      }).join('');
      var n = (st.counts || {})[l.id] || 0;
      return '<div class="lane"><div class="lane-head"><span>' + esc(l.title) +
        '</span><span class="count">' + n + '</span></div>' +
        '<div class="lane-body">' + (cards || '<div class="empty">—</div>') +
        '</div></div>';
    }).join('');
    errEl.hidden = true;
  }

  function fail(f, msg) {
    if (active === CFG.factories.indexOf(f)) {
      errEl.hidden = false;
      errEl.textContent = f.name + ': ' + msg;
    }
  }

  function load() {
    var f = CFG.factories[active];
    if (!f) return;
    fetch(f.stateUrl, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (st) { render(f, st); })
      .catch(function (e) { fail(f, 'no state yet (' + e.message + ')'); });
    tabs();
  }

  function tabs() {
    tabsEl.innerHTML = CFG.factories.map(function (f, i) {
      return '<button class="tab' + (i === active ? ' on' : '') +
        '" data-i="' + i + '" style="--accent:' + esc(f.accent) + '">' +
        esc(f.name) + '</button>';
    }).join('');
    Array.prototype.forEach.call(tabsEl.querySelectorAll('.tab'), function (b) {
      b.onclick = function () { active = +b.getAttribute('data-i'); load(); };
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
  tabs();
  load();
  setInterval(load, CFG.refreshMs || 60000);
})();
