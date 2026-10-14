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

  var state = { done: {}, snooze: {}, days: {}, pinned: [], notifSnooze: {}, muteUntil: 0, groups: null, assign: {}, autoPaused: false, exportedSig: '',
    colorBy: 'priority', colors: { p1: '#d93025', p2: '#e8710a', p3: '#f9ab00', p4: '#188038' }, rowColors: {} };
  var scan = [];            // items for rows currently on screen (hold DOM refs)
  var archive = {};         // key -> plain item for every email seen or scanned (survives page changes)
  var scanning = null;      // {stop, count, page} while "Scan whole inbox" is running
  var board = { q: '', age: 0, unread: false, results: null, view: 'type' };
  var MAX_PAGES = 200;
  var notifOpen = true;
  var stats = window.__declutterStats = { scans: 0, paints: 0 };   // read by tests to catch repaint loops
  var filter = 'all';
  var tab = 'focus';
  var skipped = {};
  var observer = null, barNode = null;

  /* ---------- storage (falls back to memory when chrome.storage is unavailable) ---------- */
  var store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) ? chrome.storage.local : null;
  function load(cb) {
    if (!store) { ensureGroups(); return cb(); }
    store.get(['declutter', 'declutterArchive'], function (r) {
      if (r && r.declutter) state = Object.assign(state, r.declutter);
      if (r && r.declutterArchive) archive = r.declutterArchive;
      ensureGroups();
      cb();
    });
  }
  function ensureGroups() {
    if (!state.groups || !state.groups.length) state.groups = defaultGroups();
    if (!state.assign) state.assign = {};
    if (!state.rowColors) state.rowColors = {};
    state.colors = Object.assign({ p1: '#d93025', p2: '#e8710a', p3: '#f9ab00', p4: '#188038' }, state.colors || {});
    applyColors();
    // LinkedIn now has its own group, so drop the older pinned LinkedIn chip
    if (state.groups.some(function (g) { return g.id === 'linkedin'; })) state.pinned = (state.pinned || []).filter(function (n) { return n !== 'LinkedIn'; });
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
    stats.scans++;
    lastScanAt = Date.now(); recentScans.push(lastScanAt);
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
  /* ---------- line colors: automatic (by priority or group, your colors) or picked by hand per email ---------- */
  var PALETTE = ['#d93025', '#e8710a', '#f9ab00', '#188038', '#1a73e8', '#8e4ec6', '#d81b60', '#00897b', '#546e7a'];
  function rgbOf(hex) {
    var h = String(hex || '#888888').replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    var n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgba(hex, a) { var c = rgbOf(hex); return 'rgba(' + c[0] + ', ' + c[1] + ', ' + c[2] + ', ' + a + ')'; }
  function inkFor(hex) { var c = rgbOf(hex); return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) > 160 ? '#202124' : '#ffffff'; }
  /** Pushes the four priority colors into the CSS variables used by chips, badges, alerts and the board. */
  function applyColors() {
    var root = document.documentElement;
    ['p1', 'p2', 'p3', 'p4'].forEach(function (k) {
      var c = state.colors[k];
      root.style.setProperty('--dc-' + k, c); root.style.setProperty('--dc-' + k + '-bg', c);
      root.style.setProperty('--dc-' + k + '-ink', inkFor(c)); root.style.setProperty('--dc-' + k + '-tint', rgba(c, 0.18));
    });
  }
  /** The color of one email line: a color you picked for that email, else by priority or group, else none. */
  function rowColor(it) {
    var manual = state.rowColors[it.key];
    if (manual) return manual === 'none' ? '' : manual;
    if (state.colorBy === 'priority') return state.colors[boxNow(it)] || '';
    if (state.colorBy === 'group') { var g = groupById(groupOf(it)); return g ? g.color : ''; }
    return '';
  }
  function closePalette() { var o = document.getElementById('dc-pop'); if (o) o.remove(); document.removeEventListener('mousedown', outsidePalette, true); }
  function outsidePalette(e) { var o = document.getElementById('dc-pop'); if (o && !o.contains(e.target)) closePalette(); }
  function openPalette(it, anchor) {
    closePalette();
    var r = anchor.getBoundingClientRect();
    var pick = function (v) { if (v === null) delete state.rowColors[it.key]; else state.rowColors[it.key] = v; save(); paint(); closePalette(); };
    var cur = rowColor(it) || '#888888';
    var pop = el('div', { id: 'dc-pop', role: 'dialog', 'aria-label': 'Choose a color for this email' },
      el('div', { class: 'dc-pop-title' }, 'Color of this line'),
      el('div', { class: 'dc-swatches' }, PALETTE.map(function (c) {
        return el('button', { class: 'dc-swatch', style: 'background:' + c, title: c, 'aria-label': 'Color ' + c, onclick: function (e) { e.stopPropagation(); pick(c); } }); })),
      el('div', { class: 'dc-pop-row' },
        el('label', { class: 'dc-muted' }, 'Any color ', el('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(cur) ? cur : '#888888', onchange: function (e) { pick(e.target.value); } })),
        el('button', { class: 'dc-link', onclick: function (e) { e.stopPropagation(); pick('none'); } }, 'No color'),
        el('button', { class: 'dc-link', onclick: function (e) { e.stopPropagation(); pick(null); } }, 'Automatic')));
    pop.style.top = Math.min(r.bottom + 6, window.innerHeight - 190) + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 250)) + 'px';
    document.body.append(pop);
    setTimeout(function () { document.addEventListener('mousedown', outsidePalette, true); }, 0);
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePalette(); });
  // One delegated handler (capture phase) for every line's color circle: it survives Gmail re-rendering or cloning rows,
  // and it runs before Gmail's own click handling so the email does not open.
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('.dc-pick') : null;
    if (!b) return;
    e.stopPropagation(); e.preventDefault();
    var tr = b.closest('tr.zA');
    var it = scan.filter(function (x) { return x.row === tr; })[0];
    if (it) openPalette(it, b);
  }, true);

  function groupById(id) { return (state.groups || []).filter(function (g) { return g.id === id; })[0]; }
  function groupOf(it) { return assignGroup(state.groups || [], state.assign || {}, it); }
  /** Moved = its group has automatic moving ON (and moving is not paused). It leaves the main list and lives in its group. */
  function isMoved(it) { var g = groupById(groupOf(it)); return !!(g && g.autoMove && !state.autoPaused); }
  function isWeb(it) { return it.category === 'newsletter' || it.category === 'receipt' || it.category === 'notification'; }
  /** Priority box right now: waiting time escalates mail from real people (7+ days red, 2-6 days orange). */
  function boxNow(it) { return agingBox(it.category, it.base !== undefined ? it.base : boxNow(it), age(it)); }
  function matchCat(it, cat) {
    if (cat === 'all') return true;
    if (cat === 'quick') return it.quick;
    if (cat.indexOf('g:') === 0) return groupOf(it) === cat.slice(2);
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
    // page-level counts match what the list shows: mail moved into a group is only counted under that group
    return scan.filter(function (it) { return !isGone(it) && matchCat(it, cat) && (cat.indexOf('g:') === 0 || !isMoved(it)); });
  }

  /* ---------- decorating Gmail's list ---------- */
  function paint() {
    stats.paints++;
    if (observer) observer.disconnect();
    try {
      scan.forEach(function (it) {
        var r = it.row;
        set(r, 'data-dc-cat', it.category);
        set(r, 'data-dc-quick', it.quick ? '1' : '0');
        set(r, 'data-dc-box', boxNow(it) || '');
        set(r, 'data-dc-web', isWeb(it) ? '1' : '0');
        var grp = groupOf(it);
        set(r, 'data-dc-group', grp);
        set(r, 'data-dc-moved', isMoved(it) ? '1' : '0');
        var col = rowColor(it);
        if (r.getAttribute('data-dc-col') !== col) {
          r.setAttribute('data-dc-col', col);
          if (col) { r.style.setProperty('--dc-row-tint', rgba(col, 0.18)); r.style.setProperty('--dc-row-bar', col); }
          else { r.style.removeProperty('--dc-row-tint'); r.style.removeProperty('--dc-row-bar'); }
        }
        set(r, 'data-dc-tint', col ? '1' : '0');
        set(r, 'data-dc-gsel', filter.indexOf('g:') === 0 ? (grp === filter.slice(2) ? '1' : '0') : '1');
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
          it.quick ? el('span', { class: 'dc-badge dc-quick' }, '2 min') : null,
          el('button', { class: 'dc-pick', title: 'Choose the color of this line', 'aria-label': 'Choose line color' }));
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
    return el('button', { class: 'dc-chip', 'data-id': id, 'aria-pressed': String(filter === id), onclick: function () { setFilter(filter === id && id !== 'all' ? 'all' : id); } },
      dotVar ? el('span', { class: 'dc-dot', style: 'background:var(--dc-' + dotVar + ')' }) : null,
      title, el('span', { class: 'dc-n' }, visible(id).length));
  }
  /** Build the bar once; afterwards only numbers and pressed states change, in place, so nothing flashes. */
  function renderBar() {
    var main = document.querySelector(ROW_SEL.main);
    if (!main) return;
    var bar = document.getElementById('dc-bar');
    if (!bar) {
      bar = barNode || el('div', { id: 'dc-bar' });
      barNode = bar;
      main.insertBefore(bar, main.firstChild);
    }
    var companies = companyList().slice(0, 25);
    var struct = state.pinned.join('|') + '#' + companies.map(function (c) { return c.name; }).join('|') + '#' +
      state.groups.map(function (g) { return g.id + g.name + g.color + (g.autoMove ? '1' : '0'); }).join('|');
    if (bar.getAttribute('data-struct') !== struct) {
      bar.setAttribute('data-struct', struct);
      var kids = [el('span', { class: 'dc-label' }, 'Declutter')];
      CATS.filter(function (c) { return ['newsletter', 'receipt', 'notification'].indexOf(c.id) < 0; })   // groups cover these
        .forEach(function (c) { kids.push(chip(c.id, c.title, c.id !== 'all' && c.id !== 'quick' ? c.id : null)); });
      kids.push(el('span', { class: 'dc-sep' }));
      PRIORITY.forEach(function (c) { kids.push(chip(c.id, c.title, c.id)); });
      kids.push(el('span', { class: 'dc-sep' }));
      kids.push(el('span', { class: 'dc-label' }, 'Groups'));
      state.groups.forEach(function (g) {
        var c = chip('g:' + g.id, g.name, null);
        c.insertBefore(el('span', { class: 'dc-dot', style: 'background:' + g.color }), c.firstChild);
        c.setAttribute('title', g.autoMove ? 'Auto-move is ON: matching emails are moved here' : 'Auto-move is OFF');
        if (g.autoMove) c.classList.add('dc-auto');
        kids.push(c);
      });
      kids.push(el('span', { class: 'dc-sep' }));
      kids.push(chip('websites', 'Websites', 'websites'));
      state.pinned.forEach(function (n) { kids.push(chip('co:' + n, n, 'websites')); });
      kids.push(el('select', { class: 'dc-select', 'aria-label': 'Filter by company', onchange: function (e) { if (e.target.value) setFilter('co:' + e.target.value); } },
        [el('option', { value: '' }, 'Company…')].concat(companies.map(function (c) { return el('option', { value: c.name }, c.name); }))));
      kids.push(el('button', { class: 'dc-chip dc-bell', 'data-id': 'bell', onclick: function () { notifOpen = true; state.muteUntil = 0; save(); renderNotifs(true); } }, ''));
      kids.push(el('button', { class: 'dc-chip dc-rules-btn', 'data-id': 'rules', onclick: openRules }, ''));
      kids.push(el('button', { class: 'dc-chip dc-board-btn', onclick: openBoard }, 'Open board ⤢'));
      bar.replaceChildren.apply(bar, kids);
    }
    bar.querySelectorAll('.dc-chip[data-id]').forEach(function (c) {
      var id = c.getAttribute('data-id');
      if (id === 'rules') { var rt = '⚙ Rules' + (pendingSync() ? ' •' : ''); if (c.textContent !== rt) c.textContent = rt; return; }
      if (id === 'bell') { var t = '🔔 ' + waitingOnYou().length + ' waiting for you'; if (c.textContent !== t) c.textContent = t; return; }
      var pressed = String(filter === id); if (c.getAttribute('aria-pressed') !== pressed) c.setAttribute('aria-pressed', pressed);
      var n = c.querySelector('.dc-n'), v = String(visible(id).length); if (n && n.textContent !== v) n.textContent = v;
    });
    var sel = bar.querySelector('.dc-select');
    if (sel) {
      var want = filter.indexOf('co:') === 0 ? filter.slice(3) : '';
      if (sel.value !== want && !(sel === document.activeElement)) sel.value = want;
    }
  }
  function setFilter(id) {
    filter = id;
    if (id === 'all') document.documentElement.removeAttribute('data-dc-filter');
    else document.documentElement.setAttribute('data-dc-filter', id.indexOf('co:') === 0 ? 'company' : id.indexOf('g:') === 0 ? 'group' : id);
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
      el('div', { class: 'dc-seg', role: 'tablist' }, [['type', 'By type'], ['priority', 'By priority'], ['group', 'By group'], ['company', 'By company']].map(function (v) {
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
      ? PRIORITY.map(function (x) { return { id: x.id, title: x.title, group: x.id === 'p3' }; })
      : board.view === 'group' ? state.groups.map(function (g) { return { id: 'g:' + g.id, title: g.name + (g.autoMove && !state.autoPaused ? ' (auto-move on)' : ''), group: false, color: g.color }; })
      : PANELS;
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
            moveSelect(it),
            el('button', { class: 'dc-btn', onclick: function () { finish(it); } }, 'Done')));
      }).concat(items.length > 150 ? [el('div', { class: 'dc-hint' }, '+ ' + (items.length - 150) + ' more. Narrow with search or age.')] : []);
      return el('section', { class: 'dc-panel', 'data-c': pn.id },
        el('header', {}, el('span', { class: 'dc-dot', style: 'background:' + (pn.color || 'var(--dc-' + pn.id + ')') }), el('h3', {}, pn.title), el('span', { class: 'dc-n' }, items.length)),
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
  /** Move one email to a group by hand ("Back to automatic" returns it to whatever the rules say). */
  function moveSelect(it) {
    var cur = groupOf(it);
    return el('select', { class: 'dc-select dc-move', 'aria-label': 'Move to group', onchange: function (e) {
      var v = e.target.value; if (!v) return;
      if (v === '__auto') delete state.assign[it.key]; else state.assign[it.key] = v;
      save(); paint(); } },
      [el('option', { value: '' }, 'Move to…')].concat(state.groups.map(function (g) {
        return el('option', { value: g.id }, (g.id === cur ? '✓ ' : '') + g.name); }), [el('option', { value: '__auto' }, 'Back to automatic')]));
  }
  function emailRow(it) {
    return el('div', { class: 'dc-item' },
      el('div', { class: 'dc-item-main', onclick: function () { open(it); } },
        el('b', {}, it.subject), el('small', {}, it.fromName + ' · ' + (age(it) ? age(it) + 'd' : 'today')),
        it.snippet ? el('small', { class: 'dc-clip' }, it.snippet) : null),
      el('div', { class: 'dc-item-side' }, boxNow(it) ? el('span', { class: 'dc-badge dc-p', 'data-p': boxNow(it) }, boxTitle(boxNow(it), true)) : null,
        el('span', { class: 'dc-badge', 'data-c': it.category }, BADGE[it.category]),
        moveSelect(it),
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
            save(); paint(); } }, pinned ? 'Unpin filter' : 'Pin as filter')));
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
  function exportOpts() {
    var co = document.getElementById('dc-co'), ur = document.getElementById('dc-urg');
    return { groups: state.groups, companies: co ? co.checked : true, urgent: ur ? ur.checked : true };
  }
  function pendingSync() {
    var sig = syncSignature(state.groups);
    return sig !== '[]' && sig !== state.exportedSig;
  }
  function downloadFilters() {
    var xml = filtersToXml(gmailFilterRules(filterCompanies(), exportOpts()));
    var url = URL.createObjectURL(new Blob([xml], { type: 'application/xml' }));
    var a = el('a', { href: url, download: 'declutter-gmail-filters.xml' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
    state.exportedSig = syncSignature(state.groups); save(); paint(); refreshRules();
  }
  var SYNC_MODES = [['off', 'Declutter only (Gmail is not changed)'], ['label', 'Also label it in Gmail'], ['label-move', 'Label it in Gmail and move it out of the inbox']];
  function openExport() {
    var old = document.getElementById('dc-modal'); if (old) old.remove();
    var synced = state.groups.filter(function (g) { return g.sync && g.sync !== 'off'; });
    var n = gmailFilterRules(filterCompanies(), { groups: state.groups }).length;
    var m = el('div', { id: 'dc-modal', role: 'dialog', 'aria-label': 'Gmail filters' },
      el('div', { class: 'dc-modal-card' },
        el('h3', {}, 'Make Gmail do it too'),
        el('p', {}, 'Declutter moves emails inside this page. Gmail filters make Gmail itself label and move every new email the moment it arrives, even when Gmail is closed. They are built from your group rules.'),
        synced.length
          ? el('p', {}, 'Included: ' + synced.map(function (g) { return g.name + ' (' + (g.sync === 'label-move' ? 'label + move out of inbox' : 'label') + ')'; }).join(', ') + '. ' + n + ' filters in total.')
          : el('p', { class: 'dc-warn' }, 'No group is set to sync with Gmail yet. Open Rules and choose "Also label it in Gmail" for a group first.'),
        el('label', { class: 'dc-check' }, el('input', { id: 'dc-co', type: 'checkbox', checked: 'checked' }), 'Also label each company (Declutter/Companies/…)'),
        el('label', { class: 'dc-check' }, el('input', { id: 'dc-urg', type: 'checkbox', checked: 'checked' }), 'Also label urgent words (Declutter/Urgent)'),
        el('ol', {}, el('li', {}, 'Click Download file.'),
          el('li', {}, 'In Gmail click the gear, then See all settings, then Filters and Blocked Addresses, then Import filters.'),
          el('li', {}, 'Choose the file, click Open file, tick Apply new filters to existing email, then Create filters.')),
        el('div', { class: 'dc-actions' },
          el('button', { class: 'dc-btn dc-primary', onclick: downloadFilters }, 'Download file'),
          el('button', { class: 'dc-btn', onclick: function () { m.remove(); } }, 'Close'))));
    document.body.append(m);
  }

  /* ---------- rules box: per-group auto-move switch, detection rules and Gmail sync ---------- */
  function countText(n) { return n + (n === 1 ? ' email' : ' emails'); }
  function refreshRules() {
    var box = document.getElementById('dc-rules'); if (!box) return;
    state.groups.forEach(function (g) {
      var c = box.querySelector('[data-gcount="' + g.id + '"]'); if (c) c.textContent = countText(pool('g:' + g.id).length);
    });
    var note = box.querySelector('.dc-pending'); if (note) note.hidden = !pendingSync();
  }
  function openRules() {
    var old = document.getElementById('dc-rules'); if (old) { old.remove(); return; }
    document.body.append(el('div', { id: 'dc-rules', role: 'dialog', 'aria-label': 'Group rules' }));
    renderRules();
  }
  function switchEl(checked, onchange, label) {
    return el('label', { class: 'dc-switch', title: label },
      el('input', { type: 'checkbox', 'aria-label': label, checked: checked ? 'checked' : null, onchange: function (e) { onchange(e.target.checked); } }), el('span', { class: 'dc-slider' }));
  }
  function renderRules() {
    var box = document.getElementById('dc-rules'); if (!box) return;
    var scrollTop = box.firstChild ? box.firstChild.scrollTop : 0;
    var changed = function () { save(); paint(); refreshRules(); };
    var cards = state.groups.map(function (g) {
      var custom = !g.builtin;
      return el('section', { class: 'dc-rule', 'data-g': g.id },
        el('header', {},
          el('input', { class: 'dc-colorpick', type: 'color', value: g.color, 'aria-label': 'Color of ' + g.name, title: 'Group color', onchange: function (e) { g.color = e.target.value; changed(); } }),
          el('input', { class: 'dc-rule-name', type: 'text', value: g.name, 'aria-label': 'Group name', onchange: function (e) { g.name = e.target.value.trim() || g.name; changed(); } }),
          el('span', { class: 'dc-muted', 'data-gcount': g.id }, countText(pool('g:' + g.id).length)),
          el('span', { class: 'dc-grow' }),
          el('span', { class: 'dc-muted' }, 'Auto-move'),
          switchEl(g.autoMove, function (v) { g.autoMove = v; changed(); }, 'Automatically move matching emails to ' + g.name)),
        el('div', { class: 'dc-rule-body' },
          g.builtin ? el('label', { class: 'dc-check' }, el('input', { type: 'checkbox', checked: g.useBuiltin !== false ? 'checked' : null, onchange: function (e) { g.useBuiltin = e.target.checked; changed(); } }),
            "Use Declutter's automatic detection" + ({ subscriptions: ' (newsletters, digests, anything you can unsubscribe from)', linkedin: ' (all LinkedIn emails)', receipts: ' (receipts, invoices, bills)', notifications: ' (no-reply and notification emails)' }[g.builtin] || '')) : null,
          el('label', {}, el('span', { class: 'dc-field' }, 'Always include these senders or websites'),
            el('textarea', { rows: 2, placeholder: 'acme.io, news@shop.com, Dana', onchange: function (e) { g.senders = e.target.value; changed(); } }, g.senders || '')),
          el('label', {}, el('span', { class: 'dc-field' }, 'Include emails with these words in the subject'),
            el('textarea', { rows: 2, placeholder: 'contract, "price list"', onchange: function (e) { g.keywords = e.target.value; changed(); } }, g.keywords || '')),
          el('label', {}, el('span', { class: 'dc-field' }, 'What Gmail does at the same time'),
            el('select', { class: 'dc-select', onchange: function (e) { g.sync = e.target.value; changed(); } },
              SYNC_MODES.map(function (o) { return el('option', { value: o[0], selected: g.sync === o[0] ? 'selected' : null }, o[1]); }))),
          custom ? el('button', { class: 'dc-link', onclick: function () {
            state.groups = state.groups.filter(function (x) { return x.id !== g.id; });
            Object.keys(state.assign).forEach(function (k) { if (state.assign[k] === g.id) delete state.assign[k]; });
            changed(); renderRules(); } }, 'Delete this group') : null));
    });
    var nameInput = el('input', { id: 'dc-newgroup', type: 'text', placeholder: 'New group, e.g. Clients', 'aria-label': 'New group name' });
    var card = el('div', { class: 'dc-modal-card dc-rules-card' },
      el('div', { class: 'dc-rules-head' }, el('h3', {}, 'Group rules'),
        el('span', { class: 'dc-grow' }), el('span', { class: 'dc-muted' }, 'Auto-moving for all groups'),
        switchEl(!state.autoPaused, function (v) { state.autoPaused = !v; changed(); }, 'Turn automatic moving on or off for every group')),
      el('p', { class: 'dc-hint' }, 'When Auto-move is on, emails that match a group leave your main list and show up in that group (click its chip above). Turn it off and they come back. Nothing is deleted. The Gmail setting makes Gmail itself apply the label, and optionally the move, using the filter file.'),
      el('section', { class: 'dc-rule dc-colors' },
        el('header', {}, el('b', {}, 'Line colors'), el('span', { class: 'dc-grow' }), el('span', { class: 'dc-muted' }, 'Color every email line by'),
          el('select', { id: 'dc-colorby', class: 'dc-select', 'aria-label': 'Color lines by', onchange: function (e) { state.colorBy = e.target.value; changed(); } },
            [['priority', 'Priority'], ['group', 'Group'], ['off', 'Nothing']].map(function (o) { return el('option', { value: o[0], selected: state.colorBy === o[0] ? 'selected' : null }, o[1]); }))),
        el('div', { class: 'dc-rule-body' },
          el('div', { class: 'dc-colorgrid' }, PRIORITY.map(function (pr) {
            return el('label', { class: 'dc-colorrow' }, el('input', { class: 'dc-colorpick', type: 'color', value: state.colors[pr.id], 'data-k': pr.id, 'aria-label': 'Color for ' + pr.title,
              onchange: function (e) { state.colors[pr.id] = e.target.value; applyColors(); changed(); } }), pr.title); })),
          el('p', { class: 'dc-muted' }, 'Want one email a different color? Click the small circle next to its subject in the list. It overrides these colors for that email.'))),
      cards,
      el('div', { class: 'dc-newrow' }, nameInput, el('button', { class: 'dc-btn', onclick: function () {
        var name = nameInput.value.trim(); if (!name) return;
        state.groups.push({ id: 'c' + Date.now().toString(36), name: name, color: AP_GROUP_COLORS[state.groups.length % AP_GROUP_COLORS.length], builtin: '', useBuiltin: false, senders: '', keywords: '', autoMove: false, sync: 'off' });
        changed(); renderRules(); } }, 'Add group')),
      el('p', { class: 'dc-pending', hidden: pendingSync() ? null : 'hidden' }, 'Gmail sync settings changed. Download and import the filter file again so Gmail does the same.'),
      el('div', { class: 'dc-actions' },
        el('button', { class: 'dc-btn dc-primary', onclick: openExport }, 'Gmail filters…'),
        el('button', { class: 'dc-btn', onclick: function () { box.remove(); } }, 'Close')));
    box.replaceChildren(card);
    card.scrollTop = scrollTop;
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
  /* Only real changes to Gmail's email rows start a rescan. Our own nodes, clocks, status dots and
     style churn are ignored, and rescans are throttled so a busy Gmail can never cause a repaint storm. */
  function isOurs(n) {
    return n.nodeType === 1 && ((n.id && n.id.indexOf('dc-') === 0) || (typeof n.className === 'string' && n.className.indexOf('dc-') >= 0));
  }
  function touchesRows(n) {
    if (n.nodeType !== 1 || isOurs(n)) return false;
    var t = n.nodeName;
    if (t === 'TR') return n.classList.contains('zA');
    if (t === 'TBODY' || t === 'TABLE') return true;
    return !!(n.getElementsByClassName && n.getElementsByClassName('zA').length);
  }
  var pending = null, lastScanAt = 0, recentScans = [];
  function scheduleScan(delay) {
    if (pending) return;                                   // one scan queued at a time (no starvation, no pile-up)
    var now = Date.now();
    recentScans = recentScans.filter(function (t) { return now - t < 10000; });
    var wait = Math.max(delay, lastScanAt + 700 - now);   // at most about one scan per 0.7s
    if (recentScans.length >= 5) wait = Math.max(wait, 4000); // still busy after 5 scans in 10s: back off
    pending = setTimeout(function () { pending = null; runScan(); }, wait);
  }
  function observe() {
    if (!observer) observer = new MutationObserver(function (muts) {
      var rowsChanged = muts.some(function (m) {
        return Array.prototype.some.call(m.addedNodes, touchesRows) || Array.prototype.some.call(m.removedNodes, touchesRows);
      });
      if (rowsChanged) scheduleScan(150);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  // If Gmail rebuilds its main pane and drops our bar, put the same bar back quietly (no rescan, no repaint).
  setInterval(function () {
    var main = document.querySelector(ROW_SEL.main);
    if (main && barNode && !document.getElementById('dc-bar')) main.insertBefore(barNode, main.firstChild);
  }, 2000);
  window.addEventListener('hashchange', function () { scheduleScan(500); });
  load(function () { runScan(); observe(); });
})();
