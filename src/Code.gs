/**
 * Inbox Coach – Gmail anti-procrastination system.
 * Backend: scans Gmail, categorizes, and performs actions (done / snooze / unsubscribe / label).
 * Functions whose names do NOT end in "_" are callable from Dashboard.html via google.script.run.
 */

var SCAN_DAYS = 60;      // how far back to look in the inbox
var SCAN_LIMIT = 120;    // max inbox threads per scan (keeps within Apps Script runtime limits)
var SENT_LIMIT = 50;     // max sent threads checked for "waiting on others"
var CACHE_KEY = 'ap_scan_v1';
var CACHE_SECONDS = 300;

/* ---------- Web app entry ---------- */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Dashboard')
    .setTitle('Inbox Coach')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ---------- Scanning ---------- */

function getMyEmails_() {
  var list = [Session.getActiveUser().getEmail()];
  try { list = list.concat(GmailApp.getAliases()); } catch (e) {}
  return list.filter(String).map(function (s) { return s.toLowerCase(); });
}

function header_(msg, name) {
  try { return msg.getHeader(name) || ''; } catch (e) { return ''; }
}

function categorySets_() {
  var out = {};
  ['promotions', 'social', 'updates', 'forums'].forEach(function (c) {
    GmailApp.search('in:inbox category:' + c + ' newer_than:' + SCAN_DAYS + 'd', 0, SCAN_LIMIT)
      .forEach(function (t) { out[t.getId()] = c; });
  });
  return out;
}

function scanMailbox_() {
  var me = getMyEmails_();
  var gmailCats = categorySets_();
  var inbox = GmailApp.search('in:inbox -label:ap-snoozed newer_than:' + SCAN_DAYS + 'd', 0, SCAN_LIMIT);
  var sent = GmailApp.search('in:sent -in:inbox -label:ap-done newer_than:30d', 0, SENT_LIMIT);

  var inInbox = {}, seen = {}, threads = [];
  inbox.forEach(function (t) { inInbox[t.getId()] = true; });
  inbox.concat(sent).forEach(function (t) {
    if (!seen[t.getId()]) { seen[t.getId()] = true; threads.push(t); }
  });

  var all = GmailApp.getMessagesForThreads(threads);
  var now = Date.now();
  var items = [];

  threads.forEach(function (thread, i) {
    var msgs = all[i];
    if (!msgs || !msgs.length) return;
    var last = msgs[msgs.length - 1];
    var from = parseAddress(last.getFrom());
    var lastFromMe = me.indexOf(from.email) >= 0;
    var id = thread.getId();
    if (!inInbox[id] && !lastFromMe) return; // sent-only threads matter only if I spoke last

    var unsub = parseListUnsubscribe(header_(last, 'List-Unsubscribe'), header_(last, 'List-Unsubscribe-Post'));
    var date = last.getDate();
    var daysAgo = Math.max(0, Math.floor((now - date.getTime()) / 86400000));
    var body = null;
    var getBody = function () { if (body === null) body = last.getPlainBody().slice(0, 1500); return body; };

    var c = classifyThread({
      fromEmail: from.email, subject: last.getSubject(), hasListUnsub: unsub.method !== 'none',
      gmailCategory: gmailCats[id], lastFromMe: lastFromMe, daysAgo: daysAgo,
      unread: thread.isUnread(), getBody: getBody
    });

    var other = lastFromMe ? parseAddress(last.getTo()) : from;
    var snippetSource = c.category === 'reply' ? stripQuoted(getBody()) : (body !== null ? body : '');
    items.push({
      id: id,
      subject: last.getSubject() || '(no subject)',
      fromName: other.name, fromEmail: other.email,
      date: date.toISOString(), daysAgo: daysAgo,
      unread: thread.isUnread(), messages: msgs.length,
      category: c.category, urgent: c.urgent, quick: c.quick && c.category === 'reply',
      priority: c.priority, unsubMethod: unsub.method,
      snippet: snippetSource.replace(/\s+/g, ' ').slice(0, 160),
      url: 'https://mail.google.com/mail/u/0/#all/' + id
    });
  });

  items.sort(function (a, b) { return b.priority - a.priority || a.daysAgo - b.daysAgo; });
  return items;
}

function getDashboardData_(force) {
  var cache = CacheService.getUserCache();
  if (!force) {
    var hit = cache.get(CACHE_KEY);
    if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  }
  var items = scanMailbox_();
  var data = {
    items: items,
    senders: groupSenders(items),
    stats: getStats_(),
    generatedAt: new Date().toISOString(),
    dashboardUrl: dashboardUrl_(),
    digestOn: hasTrigger_('apSendDigest')
  };
  try { cache.put(CACHE_KEY, JSON.stringify(data), CACHE_SECONDS); } catch (e) {} // >100KB just skips cache
  return data;
}

function apGetDashboard(force) { return getDashboardData_(!!force); }

function invalidateCache_() { try { CacheService.getUserCache().remove(CACHE_KEY); } catch (e) {} }

function dashboardUrl_() {
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

/* ---------- Labels ---------- */

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function allApCategoryLabels_() {
  return Object.keys(AP_CATEGORY_META).map(function (k) { return getOrCreateLabel_(AP_CATEGORY_META[k].label); });
}

/** Mirror categories as Gmail labels (AP/...) so you can also use them in Gmail's own sidebar. */
function apSyncLabels() {
  var items = getDashboardData_(true).items;
  var labels = {};
  Object.keys(AP_CATEGORY_META).forEach(function (k) { labels[k] = getOrCreateLabel_(AP_CATEGORY_META[k].label); });
  var counts = {};
  items.forEach(function (it) {
    var thread = GmailApp.getThreadById(it.id);
    if (!thread) return;
    Object.keys(labels).forEach(function (k) {
      if (k !== it.category) thread.removeLabel(labels[k]);
    });
    thread.addLabel(labels[it.category]);
    counts[it.category] = (counts[it.category] || 0) + 1;
  });
  return { labelled: items.length, counts: counts };
}

/* ---------- Actions ---------- */

function bumpDone_(n) {
  var props = PropertiesService.getUserProperties();
  var stats = JSON.parse(props.getProperty('stats') || '{"days":{}}');
  var key = todayKey_();
  stats.days[key] = (stats.days[key] || 0) + (n || 1);
  Object.keys(stats.days).sort().slice(0, -45).forEach(function (k) { delete stats.days[k]; });
  props.setProperty('stats', JSON.stringify(stats));
}

function todayKey_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }

function getStats_() {
  var stats = JSON.parse(PropertiesService.getUserProperties().getProperty('stats') || '{"days":{}}');
  var key = todayKey_();
  return { doneToday: stats.days[key] || 0, streak: computeStreak(stats.days, key) };
}

function apMarkDone(threadId) {
  var thread = GmailApp.getThreadById(threadId);
  if (!thread) throw new Error('Thread not found');
  thread.addLabel(getOrCreateLabel_('AP/Done'));
  allApCategoryLabels_().forEach(function (l) { thread.removeLabel(l); });
  thread.markRead();
  thread.moveToArchive();
  bumpDone_(1);
  invalidateCache_();
  return getStats_();
}

function apSnooze(threadId, days) {
  days = Math.max(1, Math.min(60, Number(days) || 1));
  var thread = GmailApp.getThreadById(threadId);
  if (!thread) throw new Error('Thread not found');
  thread.addLabel(getOrCreateLabel_('AP/Snoozed'));
  thread.moveToArchive();
  var props = PropertiesService.getUserProperties();
  var snoozed = JSON.parse(props.getProperty('snoozed') || '{}');
  snoozed[threadId] = Date.now() + days * 86400000;
  props.setProperty('snoozed', JSON.stringify(snoozed));
  bumpDone_(1);
  invalidateCache_();
  return getStats_();
}

/** Hourly trigger: bring snoozed threads back to the inbox when their time is up. */
function apProcessSnoozed() {
  var props = PropertiesService.getUserProperties();
  var snoozed = JSON.parse(props.getProperty('snoozed') || '{}');
  var label = GmailApp.getUserLabelByName('AP/Snoozed');
  var now = Date.now(), changed = false;
  Object.keys(snoozed).forEach(function (id) {
    if (snoozed[id] > now) return;
    var t = GmailApp.getThreadById(id);
    if (t) { t.moveToInbox(); t.markUnread(); if (label) t.removeLabel(label); }
    delete snoozed[id];
    changed = true;
  });
  if (changed) { props.setProperty('snoozed', JSON.stringify(snoozed)); invalidateCache_(); }
}

/* ---------- Unsubscribe ---------- */

function validEmail_(s) { return /^[^\s@<>",;]+@[^\s@<>",;]+$/.test(String(s || '')); }

/** Find the newest List-Unsubscribe info for a sender by re-reading the mailbox (never trusts client-sent URLs). */
function findUnsubscribe_(email) {
  var threads = GmailApp.search('from:' + email, 0, 5);
  for (var i = 0; i < threads.length; i++) {
    var msgs = threads[i].getMessages();
    for (var j = msgs.length - 1; j >= 0; j--) {
      var h = header_(msgs[j], 'List-Unsubscribe');
      if (h) return parseListUnsubscribe(h, header_(msgs[j], 'List-Unsubscribe-Post'));
    }
  }
  return { method: 'none', url: '', mailto: '' };
}

/** Unsubscribe from a sender, archive what is in the inbox, and keep future mail out of the inbox. */
function apUnsubscribe(email) {
  email = String(email || '').toLowerCase();
  if (!validEmail_(email)) throw new Error('Invalid sender');
  var info = findUnsubscribe_(email);
  var status = 'muted', openUrl = '';

  if (info.method === 'one-click') {
    var r = UrlFetchApp.fetch(info.url, {
      method: 'post', payload: 'List-Unsubscribe=One-Click',
      contentType: 'application/x-www-form-urlencoded', muteHttpExceptions: true, followRedirects: true
    });
    status = r.getResponseCode() < 400 ? 'unsubscribed' : 'failed';
    if (status === 'failed') openUrl = info.url;
  } else if (info.method === 'mailto') {
    var m = parseMailto(info.mailto);
    if (m) { GmailApp.sendEmail(m.to, m.subject, m.body); status = 'unsubscribed'; }
    else status = 'failed';
  } else if (info.method === 'link') {
    status = 'manual';
    openUrl = info.url; // needs a human click (confirmation page)
  }

  archiveSender_(email);
  if (status !== 'failed') muteSender_(email);
  invalidateCache_();
  return { email: email, status: status, openUrl: openUrl };
}

function archiveSender_(email) {
  var label = getOrCreateLabel_('AP/Unsubscribed');
  var threads = GmailApp.search('in:inbox from:' + email, 0, 100);
  threads.forEach(function (t) { t.addLabel(label); });
  if (threads.length) GmailApp.moveThreadsToArchive(threads);
  return threads.length;
}

/** Gmail filter: skip inbox + label, so stragglers during the unsubscribe delay never reach you. */
function muteSender_(email) {
  try {
    var label = getOrCreateLabel_('AP/Unsubscribed');
    var labelId = Gmail.Users.Labels.list('me').labels.filter(function (l) { return l.name === label.getName(); })[0].id;
    Gmail.Users.Settings.Filters.create({
      criteria: { from: email },
      action: { removeLabelIds: ['INBOX'], addLabelIds: [labelId] }
    }, 'me');
  } catch (e) { /* filter may already exist or scope missing – non-fatal */ }
}

/* ---------- Triggers & daily digest ---------- */

function hasTrigger_(fn) {
  return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === fn; });
}

function apInstallTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['apSendDigest', 'apProcessSnoozed'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('apSendDigest').timeBased().everyDays(1).atHour(8).create();
  ScriptApp.newTrigger('apProcessSnoozed').timeBased().everyHours(1).create();
  return true;
}

function apRemoveTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['apSendDigest', 'apProcessSnoozed'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  return true;
}

function apSendDigest() {
  var data = getDashboardData_(true);
  apSyncLabels();
  var replies = data.items.filter(function (i) { return i.category === 'reply'; });
  var waiting = data.items.filter(function (i) { return i.category === 'waiting'; });
  var top = replies.slice(0, 5);
  var html = '<h2>Good morning – your 5-minute inbox plan</h2>' +
    '<p><b>' + replies.length + '</b> waiting for your reply · <b>' + waiting.length + '</b> waiting on others · ' +
    'streak <b>' + data.stats.streak + '</b> day(s)</p><ol>' +
    top.map(function (i) {
      return '<li><a href="' + i.url + '">' + esc_(i.subject) + '</a> – ' + esc_(i.fromName) +
        ' (' + i.daysAgo + 'd' + (i.urgent ? ', urgent' : '') + ')</li>';
    }).join('') + '</ol>' +
    (data.dashboardUrl ? '<p><a href="' + data.dashboardUrl + '">Open Inbox Coach</a></p>' : '');
  var me = Session.getActiveUser().getEmail();
  GmailApp.sendEmail(me, 'Inbox Coach: ' + replies.length + ' to reply today', 'Open this email in HTML view.', { htmlBody: html });
}

function esc_(s) {
  return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}
