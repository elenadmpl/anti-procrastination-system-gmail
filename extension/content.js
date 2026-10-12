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
  var WEBSITES = { id: 'websites', title: 'Websites' };
  var PRIORITY = [
    { id: 'p1', title: 'Important & urgent', badge: 'Important · Urgent' },
    { id: 'p4', title: 'Important, not urgent', badge: 'Important' },
    { id: 'p2', title: 'Not important, urgent', badge: 'Urgent' },
    { id: 'p3', title: 'Not important, not urgent', badge: 'Low' }
  ];
  var BADGE = { reply: 'Reply', waiting: 'Waiting', newsletter: 'Newsletter', receipt: 'Receipt', notification: 'Notice' };

  var state = { done: {}, snooze: {}, days: {}, pinned: ['LinkedIn'], notifSnooze: {}, muteUntil: 0 };
  var scan = [];            // items for rows currently on screen (hold DOM refs)
  var archive = {};         // key -> plain item for every email seen or scanned (survives page changes)
  var scanning = null;      // {stop, count, page} while "Scan whole inbox" is running
  var board = { q: '', age: 0, unread: false, results: null, view: 'type' };
  var MAX_PAGES = 200;
  var notifOpen = true;
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
    var co = lastFromMe ? { name: '', domain: '' } : companyOf(fromEmail, fromName);
    var c = classifyThread({
      fromEmail: fromEmail, subject: subject, gmailCategory: gcat, lastFromMe: lastFromMe, daysAgo: daysAgo,
      unread: row.classList.contains('zE'), hasListUnsub: false, getBody: function () { return snippet; }
    });
    return {
      row: row, ts: ts, key: threadId || (fromEmail + '|' + subject), threadId: threadId, fromEmail: fromEmail,
      fromName: lastFromMe ? 'You' : fromName, subject: subject || '(no subject)', snippet: snippet, daysAgo: daysAgo,
      category: c.category, urgent: c.urgent, base: c.box, company: co.name, domain: co.domain,
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
    if (inInboxView() && !(scanning && scanning.kind === 'search')) { scan.forEach(function (it) { archive[it.key] = plain(it); }); saveArchive(); }
    paint();
  }
  function plain(it) {
    return { key: it.key, threadId: it.threadId, fromEmail: it.fromEmail, fromName: it.fromName, subject: it.subject,
      snippet: it.snippet.slice(0, 140), ts: it.ts, category: it.category, urgent: it.urgent, base: it.base, company: it.company, domain: it.domain, quick: it.quick,
      priority: it.priority, unread: it.unread };
  }
  function age(it) { return Math.max(0, Math.floor((Date.now() - it.ts) / 86400000)); }
  /** Everything we know about (current page + earlier pages + full scan), minus done/snoozed. */
  function isWeb(it) { return it.category === 'newsletter' || it.category === 'receipt' || it.category === 'notification'; }
  /** Priority box right now: waiting time escalates mail from real people (7+ days red, 2-6 days orange). */
  function boxNow(it) { return agingBox(it.category, it.base !== undefined ? it.base : boxNow(it), age(it)); }
  function matchCat(it, cat) {
    if (cat === 'all') return true;
    if (cat === 'quick') return it.quick;
    if (/^p\d$/.test(cat)) return boxNow(it) === cat;
    if (cat === 'websites') return isWeb(it);
    if (cat.indexOf('co:') === 0) return isWeb(it) && it.company === cat.slice(3);
    return it.category === cat;
  }
  function pool(cat) {
    return Object.keys(archive).map(function (k) { return archive[k]; }).filter(function (it) {
      return !isGone(it) && matchCat(it, cat);
    }).sort(function (a, b) { return b.priority - a.priority || b.ts - a.ts; });
  }
  function visible(cat) {
    return scan.filter(function (it) { return !isGone(it) && matchCat(it, cat); });
  }

  /* ---------- decorating Gmail's list ---------- */
  function paint() {
    if (observer) observer.disconnect();
    try {
      scan.forEach(function (it) {
        var r = it.row;
        set(r, 'data-dc-cat', it.category);
        set(r, 'data-dc-quick', it.quick ? '1' : '0');
        set(r, 'data-dc-box', boxNow(it) || '');
        set(r, 'data-dc-web', isWeb(it) ? '1' : '0');
        set(r, 'data-dc-sel', filter.indexOf('co:') === 0 ? (isWeb(it) && it.company === filter.slice(3) ? '1' : '0') : '1');
        set(r, 'data-dc-gone', isGone(it) ? '1' : '0');
        var host = r.querySelector(ROW_SEL.badgeHost);
        if (!host) return;
        var sig = it.category + (boxNow(it) || '-') + (it.quick ? 'q' : '');
        var box = host.querySelector('.dc-badges');
        if (box && box.getAttribute('data-sig') === sig) return;
        if (box) box.remove();
        box = el('span', { class: 'dc-badges', 'data-sig': sig },
          el('span', { class: 'dc-badge', 'data-c': it.category }, BADGE[it.category]),
          boxNow(it) ? el('span', { class: 'dc-badge dc-p', 'data-p': boxNow(it) }, boxTitle(boxNow(it), true)) : null,
          it.quick ? el('span', { class: 'dc-badge dc-quick' }, '2 min') : null);
        host.insertBefore(box, host.firstChild);
      });
      renderBar();
      renderLauncher();
      if (drawer().classList.contains('dc-open')) renderDrawer();
      if (document.getElementById('dc-board')) { renderPanels(); renderBoardHead(); }
      renderNotifs();
    } finally { observe(); }
  }
  function boxTitle(id, short) { var p = PRIORITY.filter(function (x) { return x.id === id; })[0]; return p ? (short ? p.badge : p.title) : ''; }
  function set(node, a, v) { if (node.getAttribute(a) !== v) node.setAttribute(a, v); }

  function companyList() {
    var map = {};
    pool('websites').forEach(function (it) { if (it.company) { var g = map[it.company] || (map[it.company] = { name: it.company, domain: it.domain, items: [] }); g.items.push(it); } });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.items.length - a.items.length; });
  }
  function chip(id, title, dotVar) {
    return el('button', { class: 'dc-chip', 'aria-pressed': String(filter === id), onclick: function () { setFilter(filter === id && id !== 'all' ? 'all' : id); } },
      dotVar ? el('span', { class: 'dc-dot', style: 'background:var(--dc-' + dotVar + ')' }) : null,
      title, el('span', { class: 'dc-n' }, visible(id).length));
  }
  function renderBar() {
    var main = document.querySelector(ROW_SEL.main);
    if (!main) return;
    var bar = document.getElementById('dc-bar');
    if (!bar) { bar = el('div', { id: 'dc-bar' }); main.insertBefore(bar, main.firstChild); }
    var companies = companyList().slice(0, 25);
    var waiting = waitingOnYou().length;
    var sig = CATS.concat([WEBSITES], PRIORITY).map(function (c) { return visible(c.id).length; }).join(',') + filter +
      state.pinned.map(function (n) { return n + visible('co:' + n).length; }).join(',') + companies.map(function (c) { return c.name + c.items.length; }).join(',') + '|' + waiting;
    if (bar.getAttribute('data-sig') === sig) return;
    bar.setAttribute('data-sig', sig);
    var kids = [el('span', { class: 'dc-label' }, 'Declutter')];
    CATS.forEach(function (c) { kids.push(chip(c.id, c.title, c.id !== 'all' && c.id !== 'quick' ? c.id : null)); });
    kids.push(el('span', { class: 'dc-sep' }));
    PRIORITY.forEach(function (c) { kids.push(chip(c.id, c.title, c.id)); });
    kids.push(el('span', { class: 'dc-sep' }));
    kids.push(chip('websites', 'Websites', 'websites'));
    state.pinned.forEach(function (n) { kids.push(chip('co:' + n, n, 'websites')); });
    kids.push(el('select', { class: 'dc-select', 'aria-label': 'Filter by company', onchange: function (e) { if (e.target.value) setFilter('co:' + e.target.value); } },
      [el('option', { value: '' }, 'Company…')].concat(companies.map(function (c) {
        return el('option', { value: c.name, selected: filter === 'co:' + c.name ? 'selected' : null }, c.name + ' (' + c.items.length + ')'); }))));
    kids.push(el('button', { class: 'dc-chip dc-bell', onclick: function () { notifOpen = true; state.muteUntil = 0; save(); renderNotifs(true); } }, '🔔 ' + waiting + ' waiting for you'));
    kids.push(el('button', { class: 'dc-chip dc-board-btn', onclick: openBoard }, 'Open board ⤢'));
    bar.replaceChildren.apply(bar, kids);
  }
  function setFilter(id) {
    filter = id;
    if (id === 'all') document.documentElement.removeAttribute('data-dc-filter');
    else document.documentElement.setAttribute('data-dc-filter', id.indexOf('co:') === 0 ? 'company' : id);
    var bar = document.getElementById('dc-bar'); if (bar) bar.removeAttribute('data-sig');
    paint();
  }

  /* ---------- in-page notifications: "Luke is waiting for your reply" ---------- */
  function firstName(n) { var t = String(n || '').trim().split(/\s+/)[0]; return t || 'Someone'; }
  function waitingOnYou() {
    var now = Date.now();
    return pool('reply').filter(function (it) { return age(it) >= 2 && !(state.notifSnooze[it.key] > now); })
      .sort(function (a, b) { return a.ts - b.ts; });            // longest wait first
  }
  function renderNotifs(force) {
    var box = document.getElementById('dc-notifs');
    var list = waitingOnYou();
    if (!list.length || !notifOpen || state.muteUntil > Date.now() || document.getElementById('dc-board')) { if (box) box.remove(); return; }
    var sig = list.slice(0, 3).map(function (i) { return i.key + age(i); }).join('|') + list.length;
    if (box && !force && box.getAttribute('data-sig') === sig) return;
    if (!box) { box = el('div', { id: 'dc-notifs', role: 'region', 'aria-label': 'People waiting for your reply' }); document.body.append(box); }
    box.setAttribute('data-sig', sig);
    var kids = [el('div', { class: 'dc-n-head' }, el('b', {}, list.length + (list.length === 1 ? ' person is' : ' people are') + ' waiting for you'),
      el('button', { class: 'dc-x', 'aria-label': 'Hide', onclick: function () { notifOpen = false; renderNotifs(); } }, '×'))];
    list.slice(0, 3).forEach(function (it) {
      kids.push(el('div', { class: 'dc-n-card', 'data-p': boxNow(it) },
        el('b', {}, firstName(it.fromName) + ' is waiting for your reply'),
        el('small', {}, it.subject + ' · ' + age(it) + ' days'),
        el('div', { class: 'dc-actions' },
          el('button', { class: 'dc-btn dc-primary', onclick: function () { open(it); } }, 'Reply'),
          el('button', { class: 'dc-btn', onclick: function () { state.notifSnooze[it.key] = Date.now() + 86400000; save(); renderNotifs(true); } }, 'Remind me tomorrow'),
          el('button', { class: 'dc-btn', onclick: function () { finish(it); } }, 'Done'))));
    });
    if (list.length > 3) kids.push(el('button', { class: 'dc-btn', onclick: function () { board.view = 'type'; openBoard(); } }, '+' + (list.length - 3) + ' more on the board'));
    kids.push(el('button', { class: 'dc-link', onclick: function () { state.muteUntil = Date.now() + 12 * 3600000; save(); renderNotifs(); } }, 'Mute for today'));
    box.replaceChildren.apply(box, kids);
  }
  setInterval(function () { renderNotifs(); }, 5 * 60 * 1000);

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
      boxNow(it) ? el('span', { class: 'dc-badge dc-p', 'data-p': boxNow(it) }, boxTitle(boxNow(it))) : null,
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
  function inInboxView() { var h = location.hash; return h === '' || /^#(inbox|category)/.test(h); }
  /** Walk every page of a Gmail view/search (#base, #base/p2, ...) and collect plain items. */
  async function walkPages(base, maxPages, progress) {
    var out = {}, prevSig = '', firstSize = 0, completed = false;
    var me = myEmail(), gcat = activeGmailTab();
    for (var page = 1; page <= maxPages && !(scanning && scanning.stop); page++) {
      location.hash = '#' + base + (page > 1 ? '/p' + page : '');
      if (!(await waitForPage(prevSig))) { completed = true; break; }
      var rows = document.querySelectorAll(ROW_SEL.row);
      rows.forEach(function (r) { var it = parseRow(r, me, gcat); if (it) out[it.key] = plain(it); });
      prevSig = rowsSig();
      if (page === 1) firstSize = rows.length;
      progress(page, Object.keys(out).length);
      if (rows.length < firstSize) { completed = true; break; }
    }
    return { items: out, completed: completed };
  }
  async function scanAll() {
    if (scanning) return;
    scanning = { stop: false, count: 0, page: 0, kind: 'scan' };
    var base = inInboxView() ? (location.hash.replace(/^#/, '').replace(/\/p\d+$/, '') || 'inbox') : 'inbox';
    renderBoardHead();
    var r = await walkPages(base, MAX_PAGES, function (page, count) { scanning.page = page; scanning.count = count; renderBoardHead(); });
    if (r.completed) archive = r.items;       // full pass is authoritative; a stopped pass only adds
    else Object.keys(r.items).forEach(function (k) { archive[k] = r.items[k]; });
    state.lastScan = { at: Date.now(), count: Object.keys(r.items).length, full: r.completed };
    save(); saveArchive();
    scanning = null;
    location.hash = '#' + base;
    setTimeout(function () { runScan(); renderBoardHead(); renderPanels(); }, 600);
  }
  /** Search the WHOLE mailbox (incl. archived mail and message bodies) with Gmail's own search, all result pages. */
  async function searchAll(q) {
    q = String(q || '').trim();
    if (!q || scanning) return;
    var back = location.hash.replace(/^#/, '').replace(/\/p\d+$/, '') || 'inbox';
    scanning = { stop: false, count: 0, page: 0, kind: 'search' };
    board.results = { q: q, items: [], done: false };
    renderBoardHead(); renderPanels();
    var r = await walkPages('search/' + encodeURIComponent(q), 40, function (page, count) { scanning.page = page; scanning.count = count; renderBoardHead(); });
    board.results = { q: q, items: Object.keys(r.items).map(function (k) { return r.items[k]; }).sort(function (a, b) { return b.ts - a.ts; }), done: r.completed, capped: !r.completed };
    scanning = null;
    location.hash = '#' + back;
    renderBoardHead(); renderPanels();
  }

  /* ---------- board: full-screen panels ---------- */
  var PANELS = [
    { id: 'reply', title: 'Needs reply', group: false }, { id: 'waiting', title: 'Waiting on others', group: false },
    { id: 'newsletter', title: 'Newsletters', group: true }, { id: 'receipt', title: 'Receipts & bills', group: false },
    { id: 'notification', title: 'Notifications', group: true }
  ];
  function closeBoard() { var b = document.getElementById('dc-board'); if (b) b.remove(); renderNotifs(); }
  function openBoard() {
    if (document.getElementById('dc-board')) return closeBoard();
    var d = drawer(); d.classList.remove('dc-open');
    var b = el('div', { id: 'dc-board', role: 'dialog', 'aria-label': 'Declutter board' },
      el('div', { id: 'dc-board-head' }), el('div', { id: 'dc-panels' }));
    document.body.append(b);
    renderNotifs();
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
    var status = scanning ? (scanning.kind === 'search' ? 'Searching all mail, page ' : 'Scanning page ') + scanning.page + ' · ' + scanning.count + ' emails found…'
      : last ? Object.keys(archive).length + ' emails known · ' + (last.full ? 'full scan ' : 'partial scan ') + new Date(last.at).toLocaleDateString()
      : Object.keys(archive).length + ' emails seen so far. Run a scan to see everything.';
    var q = document.getElementById('dc-q'), keep = q && document.activeElement === q;
    h.replaceChildren(
      el('h2', {}, 'Declutter board'),
      el('div', { class: 'dc-seg', role: 'tablist' }, [['type', 'By type'], ['priority', 'By priority'], ['company', 'By company']].map(function (v) {
        return el('button', { class: 'dc-seg-btn', role: 'tab', 'aria-selected': String(board.view === v[0]), onclick: function () { board.view = v[0]; renderBoardHead(); renderPanels(); } }, v[1]);
      })),
      el('input', { id: 'dc-q', type: 'search', placeholder: 'Search sender, subject…', value: board.q, 'aria-label': 'Search',
        oninput: function (e) { board.q = e.target.value; if (board.results && !e.target.value) board.results = null; renderPanels(); },
        onkeydown: function (e) { if (e.key === 'Enter') searchAll(board.q); } }),
      el('button', { class: 'dc-btn', disabled: scanning ? 'disabled' : null, onclick: function () { searchAll(board.q); } }, 'Search all mail'),
      el('select', { id: 'dc-age', 'aria-label': 'Age', onchange: function (e) { board.age = Number(e.target.value); renderPanels(); } },
        [[0, 'Any age'], [3, '3+ days old'], [7, '7+ days old'], [30, '30+ days old']].map(function (o) {
          return el('option', { value: o[0], selected: board.age === o[0] ? 'selected' : null }, o[1]); })),
      el('label', { class: 'dc-check' }, el('input', { id: 'dc-unread', type: 'checkbox', checked: board.unread ? 'checked' : null,
        onchange: function (e) { board.unread = e.target.checked; renderPanels(); } }), 'Unread only'),
      el('span', { class: 'dc-status' }, status),
      el('button', { class: 'dc-btn', onclick: openExport }, 'Auto-sort filters'),
      scanning ? el('button', { class: 'dc-btn', onclick: function () { scanning.stop = true; } }, 'Stop')
        : el('button', { class: 'dc-btn dc-primary', onclick: scanAll }, 'Scan whole inbox'),
      el('button', { class: 'dc-x', 'aria-label': 'Close board', onclick: closeBoard }, '×'));
    if (keep) { var nq = document.getElementById('dc-q'); nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); }
  }
  function renderPanels() {
    var wrap = document.getElementById('dc-panels'); if (!wrap) return;
    if (board.results) { wrap.replaceChildren(resultsPanel()); return; }
    wrap.setAttribute('data-view', board.view);
    if (board.view === 'company') { wrap.replaceChildren.apply(wrap, companyView()); return; }
    var defs = board.view === 'priority'
      ? PRIORITY.map(function (x) { return { id: x.id, title: x.title, group: x.id === 'p3' }; }) : PANELS;
    wrap.replaceChildren.apply(wrap, defs.map(function (pn) {
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
          el('div', { class: 'dc-item-side' }, boxNow(it) ? el('span', { class: 'dc-badge dc-p', 'data-p': boxNow(it) }, boxTitle(boxNow(it), true)) : null,
            it.quick ? el('span', { class: 'dc-badge dc-quick' }, '2 min') : null,
            board.view === 'priority' ? el('span', { class: 'dc-badge', 'data-c': it.category }, BADGE[it.category]) : null,
            el('button', { class: 'dc-btn', onclick: function () { finish(it); } }, 'Done')));
      }).concat(items.length > 150 ? [el('div', { class: 'dc-hint' }, '+ ' + (items.length - 150) + ' more. Narrow with search or age.')] : []);
      return el('section', { class: 'dc-panel', 'data-c': pn.id },
        el('header', {}, el('span', { class: 'dc-dot', style: 'background:var(--dc-' + pn.id + ')' }), el('h3', {}, pn.title), el('span', { class: 'dc-n' }, items.length)),
        el('div', { class: 'dc-panel-body' }, body));
    }));
  }
  function resultsPanel() {
    var r = board.results, items = r.items.filter(matches);
    var body = !r.items.length && !r.done ? el('div', { class: 'dc-empty' }, 'Searching…')
      : !items.length ? el('div', { class: 'dc-empty' }, 'No emails found for "' + r.q + '"')
      : items.slice(0, 400).map(function (it) {
        return el('div', { class: 'dc-item' },
          el('div', { class: 'dc-item-main', onclick: function () { open(it); } },
            el('b', {}, it.subject), el('small', {}, it.fromName + ' · ' + (age(it) ? age(it) + 'd ago' : 'today')),
            it.snippet ? el('small', { class: 'dc-clip' }, it.snippet) : null),
          el('div', { class: 'dc-item-side' }, el('span', { class: 'dc-badge', 'data-c': it.category }, BADGE[it.category])));
      });
    return el('section', { class: 'dc-panel dc-results', 'data-c': 'results' },
      el('header', {}, el('h3', {}, 'Search results for "' + r.q + '"'), el('span', { class: 'dc-n' }, r.items.length + (r.capped ? '+' : '')),
        el('button', { class: 'dc-btn', onclick: function () { board.results = null; board.q = ''; renderBoardHead(); renderPanels(); } }, 'Clear')),
      el('div', { class: 'dc-panel-body' }, body));
  }
  function emailRow(it) {
    return el('div', { class: 'dc-item' },
      el('div', { class: 'dc-item-main', onclick: function () { open(it); } },
        el('b', {}, it.subject), el('small', {}, it.fromName + ' · ' + (age(it) ? age(it) + 'd' : 'today')),
        it.snippet ? el('small', { class: 'dc-clip' }, it.snippet) : null),
      el('div', { class: 'dc-item-side' }, boxNow(it) ? el('span', { class: 'dc-badge dc-p', 'data-p': boxNow(it) }, boxTitle(boxNow(it), true)) : null,
        el('span', { class: 'dc-badge', 'data-c': it.category }, BADGE[it.category]),
        el('button', { class: 'dc-btn', onclick: function () { finish(it); } }, 'Done')));
  }
  /** Two panels: every website/company that emails you, and the emails of the selected one. */
  function companyView() {
    var groups = {};
    pool('websites').filter(matches).forEach(function (it) {
      if (!it.company) return;
      var g = groups[it.company] || (groups[it.company] = { name: it.company, domain: it.domain, items: [] }); g.items.push(it);
    });
    var list = Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (a, b) { return b.items.length - a.items.length; });
    var sel = board.company && groups[board.company] ? board.company : (list[0] && list[0].name);
    var left = el('section', { class: 'dc-panel', 'data-c': 'companies' },
      el('header', {}, el('h3', {}, 'Companies & websites'), el('span', { class: 'dc-n' }, list.length)),
      el('div', { class: 'dc-panel-body' }, list.length ? list.map(function (g) {
        var pinned = state.pinned.indexOf(g.name) >= 0;
        return el('div', { class: 'dc-item' + (g.name === sel ? ' dc-sel' : '') },
          el('div', { class: 'dc-item-main', onclick: function () { board.company = g.name; renderPanels(); } },
            el('b', {}, g.name), el('small', {}, g.items.length + ' email' + (g.items.length > 1 ? 's' : '') + (g.domain ? ' · ' + g.domain : ''))),
          el('div', { class: 'dc-item-side' }, el('button', { class: 'dc-btn', 'aria-pressed': String(pinned), onclick: function () {
            state.pinned = pinned ? state.pinned.filter(function (n) { return n !== g.name; }) : state.pinned.concat([g.name]);
            save(); var bar = document.getElementById('dc-bar'); if (bar) bar.removeAttribute('data-sig'); paint(); } }, pinned ? 'Unpin filter' : 'Pin as filter')));
      }) : el('div', { class: 'dc-empty' }, 'Scan your inbox to see companies')));
    var g = sel ? groups[sel] : null;
    var right = el('section', { class: 'dc-panel', 'data-c': 'company-emails' },
      el('header', {}, el('h3', {}, g ? g.name : 'Emails'), el('span', { class: 'dc-n' }, g ? g.items.length : 0),
        g ? el('button', { class: 'dc-btn', onclick: function () { g.items.forEach(function (it) { state.done[it.key] = Date.now(); }); save(); paint(); } }, 'Hide all') : null),
      el('div', { class: 'dc-panel-body' }, g ? g.items.slice(0, 200).map(emailRow) : el('div', { class: 'dc-empty' }, 'Nothing here')));
    return [left, right];
  }

  /* ---------- auto-sort filters: a Gmail filter file you import once ---------- */
  function filterCompanies() {
    var map = {};
    Object.keys(archive).forEach(function (k) {
      var it = archive[k]; if (!isWeb(it) || !it.domain) return;
      var g = map[it.domain] || (map[it.domain] = { name: it.company, domain: it.domain, count: 0 }); g.count++;
    });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.count - a.count; });
  }
  function downloadFilters(skipInbox) {
    var xml = filtersToXml(gmailFilterRules(filterCompanies(), { skipInbox: skipInbox }));
    var url = URL.createObjectURL(new Blob([xml], { type: 'application/xml' }));
    var a = el('a', { href: url, download: 'declutter-gmail-filters.xml' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
  }
  function openExport() {
    var old = document.getElementById('dc-modal'); if (old) old.remove();
    var rules = gmailFilterRules(filterCompanies(), {});
    var skip = el('input', { id: 'dc-skip', type: 'checkbox' });
    var m = el('div', { id: 'dc-modal', role: 'dialog', 'aria-label': 'Auto-sort filters' },
      el('div', { class: 'dc-modal-card' },
        el('h3', {}, 'Store new emails in categories automatically'),
        el('p', {}, 'Declutter can only recolor what you open. Gmail filters work on every new email the moment it arrives, even when Gmail is closed. This file holds ' + rules.length + ' filters (LinkedIn, newsletters, notifications, receipts, urgent words, and ' + (rules.length - 5) + ' companies from your scan). Each one adds a Declutter/ label.'),
        el('ol', {}, el('li', {}, 'Click Download file.'),
          el('li', {}, 'In Gmail click the gear, then See all settings, then Filters and Blocked Addresses, then Import filters.'),
          el('li', {}, 'Choose the file, click Open file, tick Apply new filters to existing email, then Create filters.')),
        el('label', { class: 'dc-check' }, skip, 'Also skip the inbox for newsletters and notifications (they stay in their label)'),
        el('div', { class: 'dc-actions' },
          el('button', { class: 'dc-btn dc-primary', onclick: function () { downloadFilters(skip.checked); } }, 'Download file'),
          el('button', { class: 'dc-btn', onclick: function () { m.remove(); } }, 'Close'))));
    document.body.append(m);
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
        return t && !t.closest('#dc-bar, #dc-drawer, #dc-launch, #dc-board, #dc-notifs, #dc-modal, .dc-badges');
      });
      if (!foreign) return;
      clearTimeout(timer); timer = setTimeout(runScan, 350);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  window.addEventListener('hashchange', function () { clearTimeout(timer); timer = setTimeout(runScan, 500); });
  load(function () { runScan(); observe(); });
})();
