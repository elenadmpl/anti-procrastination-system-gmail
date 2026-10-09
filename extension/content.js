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
  var scan = [];            // items for rows currently on screen
  var filter = 'all';
  var tab = 'focus';
  var skipped = {};
  var observer = null, timer = null;

  /* ---------- storage (falls back to memory when chrome.storage is unavailable) ---------- */
  var store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) ? chrome.storage.local : null;
  function load(cb) { if (!store) return cb(); store.get('declutter', function (r) { if (r && r.declutter) state = Object.assign(state, r.declutter); cb(); }); }
  function save() { if (store) store.set({ declutter: state }); }
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
    var daysAgo = isNaN(t) ? 0 : Math.max(0, Math.floor((Date.now() - t) / 86400000));
    var lastFromMe = (me && fromEmail === me) || fromName.toLowerCase() === 'me';
    var idEl = row.querySelector(ROW_SEL.threadId);
    var threadId = idEl ? idEl.getAttribute('data-legacy-thread-id') : '';
    var c = classifyThread({
      fromEmail: fromEmail, subject: subject, gmailCategory: gcat, lastFromMe: lastFromMe, daysAgo: daysAgo,
      unread: row.classList.contains('zE'), hasListUnsub: false, getBody: function () { return snippet; }
    });
    return {
      row: row, key: threadId || (fromEmail + '|' + subject), threadId: threadId, fromEmail: fromEmail,
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
    paint();
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
      })));
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
    var n = visible('reply').length;
    var txt = n ? n + ' to reply · Focus' : 'All caught up ✓';
    if (b.textContent !== txt) b.textContent = txt;
  }
  function toggleDrawer() { var d = drawer(); d.classList.toggle('dc-open'); if (d.classList.contains('dc-open')) renderDrawer(); }

  function open(it) { if (it.threadId) location.hash = '#all/' + it.threadId; else it.row.click(); }
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
        el('span', { class: 'dc-stat' }, (state.days[dayKey()] || 0) + ' cleared today · ' + streak() + '-day streak'),
        el('button', { class: 'dc-x', 'aria-label': 'Close', onclick: toggleDrawer }, '×')),
      el('div', { class: 'dc-tabs', role: 'tablist' }, tabs.map(function (t) {
        return el('button', { class: 'dc-tab', role: 'tab', 'aria-selected': String(tab === t[0]), onclick: function () { tab = t[0]; renderDrawer(); } }, t[1]);
      })),
      el('div', { class: 'dc-body' }, body));
  }
  function empty(title, sub) { return el('div', { class: 'dc-empty' }, el('strong', {}, title), sub); }
  function focusView() {
    var q = visible('reply').filter(function (it) { return !skipped[it.key]; });
    var total = scan.filter(function (i) { return i.category === 'reply'; }).length || 1;
    var left = visible('reply').length;
    var track = el('div', { class: 'dc-bar-track' }, el('div', { class: 'dc-bar-fill', style: 'width:' + Math.round(100 * (total - left) / total) + '%' }));
    if (!q.length) return el('div', {}, track, empty(left ? 'You skipped the rest' : 'Nothing to reply to here', left ? 'They will be back next time.' : 'Scroll or change page to load more mail.'));
    var it = q[0];
    return el('div', {}, track, el('div', { class: 'dc-card' },
      el('div', { class: 'dc-hint' }, 'Just this one. ' + left + ' left in this view.'),
      el('span', { class: 'dc-badge', 'data-c': it.category }, BADGE[it.category]),
      it.urgent ? el('span', { class: 'dc-badge dc-urgent' }, 'Urgent') : null,
      el('h3', {}, it.subject),
      el('div', { class: 'dc-who' }, it.fromName + ' · ' + (it.daysAgo ? it.daysAgo + ' days ago' : 'today')),
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
    var items = visible('reply');
    if (!items.length) return empty('Nobody is waiting on you', 'In the emails loaded on this page.');
    return el('div', {}, items.map(function (it) {
      return el('div', { class: 'dc-row' },
        el('div', {}, el('b', {}, it.subject), el('small', {}, it.fromName + ' · ' + (it.daysAgo ? it.daysAgo + 'd' : 'today') + (it.urgent ? ' · urgent' : ''))),
        el('button', { class: 'dc-btn', onclick: function () { open(it); } }, 'Open'));
    }));
  }
  function unsubView() {
    var map = {};
    visible('newsletter').forEach(function (it) { var g = map[it.fromEmail] || (map[it.fromEmail] = { name: it.fromName, email: it.fromEmail, items: [] }); g.items.push(it); });
    var groups = Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.items.length - a.items.length; });
    if (!groups.length) return empty('No newsletters on this page', 'Open Promotions or Updates to find them.');
    return el('div', {},
      el('p', { class: 'dc-hint' }, 'Open the newest email: Gmail shows its own Unsubscribe link next to the sender name. Then use "Hide" to clear the rest.'),
      groups.map(function (g) {
        return el('div', { class: 'dc-row' },
          el('div', {}, el('b', {}, g.name), el('small', {}, g.email + ' · ' + g.items.length + ' on this page')),
          el('button', { class: 'dc-btn dc-primary', onclick: function () { open(g.items[0]); } }, 'Unsubscribe'),
          el('button', { class: 'dc-btn', onclick: function () { g.items.forEach(function (it) { state.done[it.key] = Date.now(); }); save(); paint(); } }, 'Hide'));
      }));
  }

  /* ---------- wiring ---------- */
  function observe() {
    if (!observer) observer = new MutationObserver(function (muts) {
      var foreign = muts.some(function (m) {
        var t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        return t && !t.closest('#dc-bar, #dc-drawer, #dc-launch, .dc-badges');
      });
      if (!foreign) return;
      clearTimeout(timer); timer = setTimeout(runScan, 350);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  window.addEventListener('hashchange', function () { clearTimeout(timer); timer = setTimeout(runScan, 500); });
  load(function () { runScan(); observe(); });
})();
