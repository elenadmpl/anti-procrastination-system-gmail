/**
 * Declutter for Gmail – content script.
 * Reads the rows Gmail already shows on screen (nothing leaves your browser), classifies them with logic.js,
 * then decorates the list: colored labels, a filter bar, and a focus drawer.
 * Gmail's class names (tr.zA, .bog, .y2 ...) are internal and can change; every lookup below is in ROW_SEL.
 */
(function () {
  'use strict';
  if (window.__declutterLoaded) return;
  window.__declutterLoaded = true;

  var ROW_SEL = {
    row: 'tr.zA', sender: '.yW [email], .yX [email]', subject: '.bog', snippet: '.y2', date: '.xW span',
    badgeHost: '.y6', main: 'div[role="main"]', threadId: '[data-legacy-thread-id]'
  };
  var CATS = [
    { id: 'all', title: 'All' }, { id: 'reply', title: 'Needs reply' }, { id: 'quick', title: '2-minute' },
    { id: 'waiting', title: 'Waiting on others' }, { id: 'newsletter', title: 'Newsletters' },
    { id: 'receipt', title: 'Receipts & bills' }, { id: 'notification', title: 'Notifications' }
  ];
  var BADGE = { reply: 'Reply', waiting: 'Waiting', newsletter: 'Newsletter', receipt: 'Receipt', notification: 'Notice' };

  var state = { done: {}, snooze: {}, days: {} };
  var scan = [];            // items for rows currently on screen (hold DOM refs)
  var archive = {};         // key -> plain item for every email seen or scanned (survives page changes)
  var scanning = null;      // {stop, count, page} while "Scan whole inbox" is running
  var board = { q: '', age: 0, unread: false };
  var MAX_PAGES = 200;
  var filter = 'all';
  var tab = 'focus';
  var skipped = {};
  var observer = null, timer = null;

  /* ---------- storage (falls back to memory when chrome.storage is unavailable) ---------- */
  var store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) ? chrome.storage.local : null;
  function load(cb) {
    if (!store) return cb();
    store.get(['declutter', 'declutterArchive'], function (r) {
      if (r && r.declutter) state = Object.assign(state, r.declutter);
      if (r && r.declutterArchive) archive = r.declutterArchive;
      cb();
    });
  }
  function save() { if (store) store.set({ declutter: state }); }
  var saveTimer = null;
  function saveArchive() { if (!store) return; clearTimeout(saveTimer); saveTimer = setTimeout(function () { store.set({ declutterArchive: archive }); }, 1000); }
  function dayKey() { return new Date().toISOString().slice(0, 10); }

  /* ---------- helpers ---------- */
  function el(tag, props) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      var v = props[k];
      if (v == null) return;
      if (k === 'class') n.className = v;
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (Array.isArray(c)) c.forEach(function (x) { n.append(x); });
      else if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return n;
  }
  function myEmail() {
    var m = (document.title || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    return m ? m[0].toLowerCase() : '';
  }
  function activeGmailTab() {
    var t = document.querySelector('[role="tab"][aria-selected="true"]');
    var txt = t ? t.textContent.toLowerCase() : '';
    return ['promotions', 'social', 'updates', 'forums'].filter(function (c) { return txt.indexOf(c) >= 0; })[0];
  }

  /* ---------- scanning ---------- */
  function parseRow(row, me, gcat) {
    var senders = row.querySelectorAll(ROW_SEL.sender);
    if (!senders.length) return null;
    var last = senders[senders.length - 1];
    var fromEmail = (last.getAttribute('email') || '').toLowerCase();
    var fromName = last.getAttribute('name') || last.textContent || fromEmail;
    var subjectEl = row.querySelector(ROW_SEL.subject);
    var snipEl = row.querySelector(ROW_SEL.snippet);
    var dateEl = row.querySelector(ROW_SEL.date);
    var subject = subjectEl ? subjectEl.textContent.trim() : '';
    var snippet = snipEl ? snipEl.textContent.replace(/^\s*-\s*/, '').trim() : '';
    var t = dateEl ? Date.parse(dateEl.getAttribute('title') || '') : NaN;
    var ts = isNaN(t) ? Date.now() : t;
    var daysAgo = Math.max(0, Math.floor((Date.now() - ts) / 86400000));
    var lastFromMe = (me && fromEmail === me) || fromName.toLowerCase() === 'me';
    var idEl = row.querySelector(ROW_SEL.threadId);
    var threadId = idEl ? idEl.getAttribute('data-legacy-thread-id') : '';
    var c = classifyThread({
      fromEmail: fromEmail, subject: subject, gmailCategory: gcat, lastFromMe: lastFromMe, daysAgo: daysAgo,
      unread: row.classList.contains('zE'), hasListUnsub: false, getBody: function () { return snippet; }
    });
    return {
      row: row, ts: ts, key: threadId || (fromEmail + '|' + subject), threadId: threadId, fromEmail: fromEmail,
      fromName: lastFromMe ? 'You' : fromName, subject: subject || '(no subject)', snippet: snippet, daysAgo: daysAgo,
      category: c.category, urgent: c.urgent,
      // The list only shows a snippet, so "short" must mean the whole message plausibly fits in it.
      quick: c.category === 'reply' && snippet.length > 0 && snippet.length < 60, priority: c.priority,
      unread: row.classList.contains('zE')
    };
  }
  function isGone(it) {
    if (state.done[it.key]) return true;
    var s = state.snooze[it.key];
    return !!(s && s > Date.now());
  }
  function runScan() {
    var rows = document.querySelectorAll(ROW_SEL.row);
    var me = myEmail(), gcat = activeGmailTab();
    scan = [];
    rows.forEach(function (r) { var it = parseRow(r, me, gcat); if (it) scan.push(it); });
    scan.sort(function (a, b) { return b.priority - a.priority; });
    scan.forEach(function (it) { archive[it.key] = plain(it); });
    saveArchive();
    paint();
  }
  function plain(it) {
    return { key: it.key, threadId: it.threadId, fromEmail: it.fromEmail, fromName: it.fromName, subject: it.subject,
      snippet: it.snippet.slice(0, 140), ts: it.ts, category: it.category, urgent: it.urgent, quick: it.quick,
      priority: it.priority, unread: it.unread };
  }
  function age(it) { return Math.max(0, Math.floor((Date.now() - it.ts) / 86400000)); }
  /** Everything we know about (current page + earlier pages + full scan), minus done/snoozed. */
  function pool(cat) {
    return Object.keys(archive).map(function (k) { return archive[k]; }).filter(function (it) {
      if (isGone(it)) return false;
      if (cat === 'all') return true;
      if (cat === 'quick') return it.quick;
      return it.category === cat;
    }).sort(function (a, b) { return b.priority - a.priority || b.ts - a.ts; });
  }
  function visible(cat) {
    return scan.filter(function (it) {
      if (isGone(it)) return false;
      if (cat === 'all') return true;
      if (cat === 'quick') return it.quick;
      return it.category === cat;
    });
  }

  /* ---------- decorating Gmail's list ---------- */
  function paint() {
    if (observer) observer.disconnect();
    try {
      scan.forEach(function (it) {
        var r = it.row;
        set(r, 'data-dc-cat', it.category);
        set(r, 'data-dc-quick', it.quick ? '1' : '0');
        set(r, 'data-dc-gone', isGone(it) ? '1' : '0');
        var host = r.querySelector(ROW_SEL.badgeHost);
        if (!host) return;
        var sig = it.category + (it.urgent ? 'u' : '') + (it.quick ? 'q' : '');
        var box = host.querySelector('.dc-badges');
        if (box && box.getAttribute('data-sig') === sig) return;
        if (box) box.remove();
        box = el('span', { class: 'dc-badges', 'data-sig': sig },
          el('span', { class: 'dc-badge', 'data-c': it.category }, BADGE[it.category]),
          it.urgent ? el('span', { class: 'dc-badge dc-urgent' }, 'Urgent') : null,
          it.quick ? el('span', { class: 'dc-badge dc-quick' }, '2 min') : null);
        host.insertBefore(box, host.firstChild);
      });
      renderBar();
      renderLauncher();
      if (drawer().classList.contains('dc-open')) renderDrawer();
      if (document.getElementById('dc-board')) { renderPanels(); renderBoardHead(); }
    } finally { observe(); }
  }
  function set(node, a, v) { if (node.getAttribute(a) !== v) node.setAttribute(a, v); }

  function renderBar() {
    var main = document.querySelector(ROW_SEL.main);
    if (!main) return;
    var bar = document.getElementById('dc-bar');
    if (!bar) { bar = el('div', { id: 'dc-bar' }); main.insertBefore(bar, main.firstChild); }
    var sig = CATS.map(function (c) { return visible(c.id).length; }).join(',') + filter;
    if (bar.getAttribute('data-sig') === sig) return;
    bar.setAttribute('data-sig', sig);
    bar.replaceChildren.apply(bar, [el('span', { class: 'dc-label' }, 'Declutter')].concat(
      CATS.map(function (c) {
        return el('button', { class: 'dc-chip', 'aria-pressed': String(filter === c.id), onclick: function () { setFilter(c.id); } },
          c.id !== 'all' && c.id !== 'quick' ? el('span', { class: 'dc-dot', style: 'background:var(--dc-' + c.id + ')' }) : null,
          c.title, el('span', { class: 'dc-n' }, visible(c.id).length));
      }).concat([el('button', { class: 'dc-chip dc-board-btn', onclick: openBoard }, 'Open board ⤢')])));
  }
  function setFilter(id) {
    filter = id;
    if (id === 'all') document.documentElement.removeAttribute('data-dc-filter');
    else document.documentElement.setAttribute('data-dc-filter', id);
    var bar = document.getElementById('dc-bar'); if (bar) bar.removeAttribute('data-sig');
    paint();
  }

  /* ---------- launcher + drawer ---------- */
  function drawer() {
    var d = document.getElementById('dc-drawer');
    if (!d) { d = el('div', { id: 'dc-drawer', role: 'dialog', 'aria-label': 'Declutter' }); document.body.append(d); }
    return d;
  }
  function renderLauncher() {
    var b = document.getElementById('dc-launch');
    if (!b) { b = el('button', { id: 'dc-launch', onclick: toggleDrawer }); document.body.append(b); }
    var n = pool('reply').length;
    var txt = n ? n + ' to reply · Focus' : 'All caught up ✓';
    if (b.textContent !== txt) b.textContent = txt;
  }
  function toggleDrawer() { var d = drawer(); d.classList.toggle('dc-open'); if (d.classList.contains('dc-open')) renderDrawer(); }

  function open(it) {
    if (it.threadId) location.hash = '#all/' + it.threadId;
    else location.hash = '#search/' + encodeURIComponent('from:' + it.fromEmail + ' subject:(' + it.subject + ')');
    if (document.getElementById('dc-board')) closeBoard();
  }
  function finish(it, days) {
    if (days) state.snooze[it.key] = Date.now() + days * 86400000; else state.done[it.key] = Date.now();
    state.days[dayKey()] = (state.days[dayKey()] || 0) + 1;
    save(); paint();
  }
  function streak() {
    var s = 0, d = new Date();
    if (!state.days[dayKey()]) d.setDate(d.getDate() - 1);
    while (state.days[d.toISOString().slice(0, 10)]) { s++; d.setDate(d.getDate() - 1); }
    return s;
  }
  function renderDrawer() {
    var d = drawer();
    var tabs = [['focus', 'Focus'], ['list', 'Needs reply'], ['unsub', 'Unsubscribe']];
    var body = tab === 'focus' ? focusView() : tab === 'list' ? listView() : unsubView();
    d.replaceChildren(
      el('div', { class: 'dc-head' }, el('h2', {}, 'Declutter'),
        el('button', { class: 'dc-btn', onclick: openBoard }, 'Board'),
        el('span', { class: 'dc-stat' }, (state.days[dayKey()] || 0) + ' cleared today · ' + streak() + '-day streak'),
        el('button', { class: 'dc-x', 'aria-label': 'Close', onclick: toggleDrawer }, '×')),
      el('div', { class: 'dc-tabs', role: 'tablist' }, tabs.map(function (t) {
        return el('button', { class: 'dc-tab', role: 'tab', 'aria-selected': String(tab === t[0]), onclick: function () { tab = t[0]; renderDrawer(); } }, t[1]);
      })),
      el('div', { class: 'dc-body' }, body));
  }
  function empty(title, sub) { return el('div', { class: 'dc-empty' }, el('strong', {}, title), sub); }
  function focusView() {
    var q = pool('reply').filter(function (it) { return !skipped[it.key]; });
    var total = Math.max(pool('reply').length + (state.days[dayKey()] || 0), 1);
    var left = pool('reply').length;
    var track = el('div', { class: 'dc-bar-track' }, el('div', { class: 'dc-bar-fill', style: 'width:' + Math.round(100 * (total - left) / total) + '%' }));
    if (!q.length) return el('div', {}, track, empty(left ? 'You skipped the rest' : 'Nothing to reply to here', left ? 'They will be back next time.' : 'Scroll or change page to load more mail.'));
    var it = q[0];
    return el('div', {}, track, el('div', { class: 'dc-card' },
      el('div', { class: 'dc-hint' }, 'Just this one. ' + left + ' left.'),
      el('span', { class: 'dc-badge', 'data-c': it.category }, BADGE[it.category]),
      it.urgent ? el('span', { class: 'dc-badge dc-urgent' }, 'Urgent') : null,
      el('h3', {}, it.subject),
      el('div', { class: 'dc-who' }, it.fromName + ' · ' + (age(it) ? age(it) + ' days ago' : 'today')),
      el('p', { class: 'dc-snip' }, it.snippet),
      el('div', { class: 'dc-actions' },
        el('button', { class: 'dc-btn dc-primary', onclick: function () { open(it); } }, 'Open & reply'),
        el('button', { class: 'dc-btn', onclick: function () { finish(it); } }, 'Done'),
        el('button', { class: 'dc-btn', onclick: function () { finish(it, 1); } }, 'Tomorrow'),
        el('button', { class: 'dc-btn', onclick: function () { finish(it, 7); } }, 'Next week'),
        el('button', { class: 'dc-btn', onclick: function () { skipped[it.key] = 1; renderDrawer(); } }, 'Skip'))),
      el('p', { class: 'dc-hint', style: 'margin-top:12px' }, 'Done and Snooze hide the email in Declutter only. Archive it in Gmail as usual.'));
  }
  function listView() {
    var items = pool('reply');
    if (!items.length) return empty('Nobody is waiting on you', 'Among the emails Declutter has seen. Use Scan whole inbox for the full picture.');
    return el('div', {}, items.map(function (it) {
      return el('div', { class: 'dc-row' },
        el('div', {}, el('b', {}, it.subject), el('small', {}, it.fromName + ' · ' + (age(it) ? age(it) + 'd' : 'today') + (it.urgent ? ' · urgent' : ''))),
        el('button', { class: 'dc-btn', onclick: function () { open(it); } }, 'Open'));
    }));
  }
  function unsubView() {
    var map = {};
    pool('newsletter').forEach(function (it) { var g = map[it.fromEmail] || (map[it.fromEmail] = { name: it.fromName, email: it.fromEmail, items: [] }); g.items.push(it); });
    var groups = Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.items.length - a.items.length; });
    if (!groups.length) return empty('No newsletters found yet', 'Use Scan whole inbox, or open Promotions.');
    return el('div', {},
      el('p', { class: 'dc-hint' }, 'Unsubscribe opens the newest email, where Gmail shows its own Unsubscribe link next to the sender name. Then use Hide to clear the rest.'),
      groups.map(function (g) {
        return el('div', { class: 'dc-row' },
          el('div', {}, el('b', {}, g.name), el('small', {}, g.email + ' · ' + g.items.length + ' emails')),
          el('button', { class: 'dc-btn dc-primary', onclick: function () { open(g.items[0]); } }, 'Unsubscribe'),
          el('button', { class: 'dc-btn', onclick: function () { g.items.forEach(function (it) { state.done[it.key] = Date.now(); }); save(); paint(); } }, 'Hide'));
      }));
  }


  /* ---------- scan whole inbox (walks Gmail's own pages: #inbox/p2, #inbox/p3 ...) ---------- */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function rowsSig() {
    var rows = document.querySelectorAll(ROW_SEL.row);
    if (!rows.length) return '';
    var t = function (r) { var s = r.querySelector(ROW_SEL.subject); var i = r.querySelector(ROW_SEL.threadId); return (i ? i.getAttribute('data-legacy-thread-id') : '') + (s ? s.textContent : ''); };
    return rows.length + '|' + t(rows[0]) + '|' + t(rows[rows.length - 1]);
  }
  async function waitForPage(prevSig) {
    for (var i = 0; i < 40; i++) {            // up to ~6s
      await sleep(150);
      var sig = rowsSig();
      if (sig && sig !== prevSig) { await sleep(250); return true; }
    }
    return false;
  }
  async function scanAll() {
    if (scanning) return;
    scanning = { stop: false, count: 0, page: 0 };
    var base = location.hash.replace(/^#/, '').replace(/\/p\d+$/, '') || 'inbox';
    var fresh = {}, prevSig = '', firstSize = 0, completed = false;
    var me = myEmail(), gcat = activeGmailTab();
    renderBoardHead();
    for (var page = 1; page <= MAX_PAGES && !scanning.stop; page++) {
      location.hash = '#' + base + (page > 1 ? '/p' + page : '');
      if (!(await waitForPage(prevSig))) { completed = true; break; }
      var rows = document.querySelectorAll(ROW_SEL.row), n = 0;
      rows.forEach(function (r) { var it = parseRow(r, me, gcat); if (it) { fresh[it.key] = plain(it); n++; } });
      prevSig = rowsSig();
      if (page === 1) firstSize = rows.length;
      scanning.page = page; scanning.count = Object.keys(fresh).length;
      renderBoardHead();
      if (rows.length < firstSize) { completed = true; break; }
    }
    if (completed) archive = fresh;           // full pass is authoritative; a stopped pass only adds
    else Object.keys(fresh).forEach(function (k) { archive[k] = fresh[k]; });
    state.lastScan = { at: Date.now(), count: Object.keys(fresh).length, full: completed };
    save(); saveArchive();
    scanning = null;
    location.hash = '#' + base;
    setTimeout(function () { runScan(); renderBoardHead(); }, 600);
  }

  /* ---------- board: full-screen panels ---------- */
  var PANELS = [
    { id: 'reply', title: 'Needs reply', group: false }, { id: 'waiting', title: 'Waiting on others', group: false },
    { id: 'newsletter', title: 'Newsletters', group: true }, { id: 'receipt', title: 'Receipts & bills', group: false },
    { id: 'notification', title: 'Notifications', group: true }
  ];
  function closeBoard() { var b = document.getElementById('dc-board'); if (b) b.remove(); }
  function openBoard() {
    if (document.getElementById('dc-board')) return closeBoard();
    var d = drawer(); d.classList.remove('dc-open');
    var b = el('div', { id: 'dc-board', role: 'dialog', 'aria-label': 'Declutter board' },
      el('div', { id: 'dc-board-head' }), el('div', { id: 'dc-panels' }));
    document.body.append(b);
    renderBoardHead(); renderPanels();
  }
  function matches(it) {
    if (board.age && age(it) < board.age) return false;
    if (board.unread && !it.unread) return false;
    if (board.q) {
      var hay = (it.subject + ' ' + it.fromName + ' ' + it.fromEmail + ' ' + it.snippet).toLowerCase();
      if (hay.indexOf(board.q.toLowerCase()) < 0) return false;
    }
    return true;
  }
  function renderBoardHead() {
    var h = document.getElementById('dc-board-head'); if (!h) return;
    var last = state.lastScan;
    var status = scanning ? 'Scanning page ' + scanning.page + ' · ' + scanning.count + ' emails found…'
      : last ? Object.keys(archive).length + ' emails known · ' + (last.full ? 'full scan ' : 'partial scan ') + new Date(last.at).toLocaleDateString()
      : Object.keys(archive).length + ' emails seen so far. Run a scan to see everything.';
    var q = document.getElementById('dc-q'), keep = q && document.activeElement === q;
    h.replaceChildren(
      el('h2', {}, 'Declutter board'),
      el('input', { id: 'dc-q', type: 'search', placeholder: 'Search sender, subject…', value: board.q, 'aria-label': 'Search',
        oninput: function (e) { board.q = e.target.value; renderPanels(); } }),
      el('select', { id: 'dc-age', 'aria-label': 'Age', onchange: function (e) { board.age = Number(e.target.value); renderPanels(); } },
        [[0, 'Any age'], [3, '3+ days old'], [7, '7+ days old'], [30, '30+ days old']].map(function (o) {
          return el('option', { value: o[0], selected: board.age === o[0] ? 'selected' : null }, o[1]); })),
      el('label', { class: 'dc-check' }, el('input', { id: 'dc-unread', type: 'checkbox', checked: board.unread ? 'checked' : null,
        onchange: function (e) { board.unread = e.target.checked; renderPanels(); } }), 'Unread only'),
      el('span', { class: 'dc-status' }, status),
      scanning ? el('button', { class: 'dc-btn', onclick: function () { scanning.stop = true; } }, 'Stop')
        : el('button', { class: 'dc-btn dc-primary', onclick: scanAll }, 'Scan whole inbox'),
      el('button', { class: 'dc-x', 'aria-label': 'Close board', onclick: closeBoard }, '×'));
    if (keep) { var nq = document.getElementById('dc-q'); nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); }
  }
  function renderPanels() {
    var wrap = document.getElementById('dc-panels'); if (!wrap) return;
    wrap.replaceChildren.apply(wrap, PANELS.map(function (pn) {
      var items = pool(pn.id).filter(matches);
      var body;
      if (!items.length) body = el('div', { class: 'dc-empty' }, 'Nothing here');
      else if (pn.group) body = groupedRows(pn, items);
      else body = items.slice(0, 150).map(function (it) {
        return el('div', { class: 'dc-item' },
          el('div', { class: 'dc-item-main', onclick: function () { open(it); } },
            el('b', {}, it.subject),
            el('small', {}, (pn.id === 'waiting' ? 'To ' : '') + it.fromName + ' · ' + (age(it) ? age(it) + 'd' : 'today')),
            it.snippet ? el('small', { class: 'dc-clip' }, it.snippet) : null),
          el('div', { class: 'dc-item-side' }, it.urgent ? el('span', { class: 'dc-badge dc-urgent' }, 'Urgent') : null,
            it.quick ? el('span', { class: 'dc-badge dc-quick' }, '2 min') : null,
            el('button', { class: 'dc-btn', onclick: function () { finish(it); } }, 'Done')));
      }).concat(items.length > 150 ? [el('div', { class: 'dc-hint' }, '+ ' + (items.length - 150) + ' more. Narrow with search or age.')] : []);
      return el('section', { class: 'dc-panel', 'data-c': pn.id },
        el('header', {}, el('span', { class: 'dc-dot', style: 'background:var(--dc-' + pn.id + ')' }), el('h3', {}, pn.title), el('span', { class: 'dc-n' }, items.length)),
        el('div', { class: 'dc-panel-body' }, body));
    }));
  }
  function groupedRows(pn, items) {
    var map = {};
    items.forEach(function (it) { var g = map[it.fromEmail] || (map[it.fromEmail] = { name: it.fromName, email: it.fromEmail, items: [] }); g.items.push(it); });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.items.length - a.items.length; }).slice(0, 150).map(function (g) {
      return el('div', { class: 'dc-item' },
        el('div', { class: 'dc-item-main' }, el('b', {}, g.name), el('small', {}, g.email + ' · ' + g.items.length + ' email' + (g.items.length > 1 ? 's' : ''))),
        el('div', { class: 'dc-item-side' },
          el('button', { class: pn.id === 'newsletter' ? 'dc-btn dc-primary' : 'dc-btn', onclick: function () { open(g.items[0]); } }, pn.id === 'newsletter' ? 'Unsubscribe' : 'Open'),
          el('button', { class: 'dc-btn', onclick: function () { g.items.forEach(function (it) { state.done[it.key] = Date.now(); }); save(); paint(); } }, 'Hide all')));
    });
  }

  /* ---------- wiring ---------- */
  function observe() {
    if (!observer) observer = new MutationObserver(function (muts) {
      var foreign = muts.some(function (m) {
        var t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        return t && !t.closest('#dc-bar, #dc-drawer, #dc-launch, #dc-board, .dc-badges');
      });
      if (!foreign) return;
      clearTimeout(timer); timer = setTimeout(runScan, 350);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  window.addEventListener('hashchange', function () { clearTimeout(timer); timer = setTimeout(runScan, 500); });
  load(function () { runScan(); observe(); });
})();
