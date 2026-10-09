/**
 * Pure logic (no Google services) so it can be unit-tested with Node.
 * Everything here is deterministic: headers/strings in, classification out.
 */

var AP_CATEGORY_META = {
  reply:        { label: 'AP/Needs Reply',        title: 'Needs reply' },
  waiting:      { label: 'AP/Waiting On Others',  title: 'Waiting on others' },
  newsletter:   { label: 'AP/Newsletters',        title: 'Newsletters & promos' },
  receipt:      { label: 'AP/Receipts and Bills', title: 'Receipts & bills' },
  notification: { label: 'AP/Notifications',      title: 'Notifications' }
};

var AP_RE_AUTOMATED_SENDER = /(^|[._+-])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster|newsletter|marketing|alerts?|digest|bounce|automated)([._+-]|@)/i;
// Role mailboxes (billing@, support@...) are never "a person waiting on you".
var AP_RE_ROLE_SENDER = /^(accounts?-?payable|accounts?-?receivable|billing|invoices?|receipts?|orders?|support|helpdesk|team|info)@/i;
// Bulk-mail platforms and newsletter-style mailboxes: fallback when no List-Unsubscribe header is visible.
var AP_RE_BULK_SENDER = /(@|\.)(substack\.com|mailchimp(app)?\.com|beehiiv\.com|convertkit|list-manage|sendgrid|mailgun|constantcontact|hubspot|medium\.com)$|^(news|newsletter|newsletters|digest|hello|marketing|mail|updates|weekly|promo|promos|promotions|offers?|deals?|sales|store|shop|rewards|events?)@/i;
var AP_RE_REACTION = /(reacted via gmail|αντέδρασε μέσω gmail)/i;
var AP_RE_RECEIPT = /\b(receipt|invoice|your order|order (confirmation|#|number|shipped)|payment (received|confirmation|failed)|unpaid|statement is|billing|bill is ready|subscription (renewal|renewed)|refund|booking confirmation|e-?ticket|itinerary)\b/i;
var AP_RE_URGENT = /\b(urgent|asap|deadline|due (today|tomorrow|soon|by)|action required|final notice|expires?( today| soon)?|by (eod|end of day)|time[- ]sensitive|overdue|last chance to respond)\b/i;

/** '"Jane Doe" <jane@x.com>' -> {name, email} (email lower-cased). */
function parseAddress(from) {
  var s = String(from || '');
  var m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  var email = (m ? m[2] : s).trim().toLowerCase();
  var name = m ? m[1].trim() : '';
  return { name: name || email.split('@')[0], email: email };
}

/** Drop quoted replies / signatures-by-client so "short" and "?" checks look only at new text. */
function stripQuoted(body) {
  var s = String(body || '').replace(/\r/g, '');
  var cut = s.search(/\n\s*(>|On .{5,120} wrote:|-{2,}\s*Original Message|From: .+\nSent: )/);
  return (cut >= 0 ? s.slice(0, cut) : s).trim();
}

/**
 * Parse List-Unsubscribe (+ optional List-Unsubscribe-Post) headers.
 * Returns {method: 'one-click'|'mailto'|'link'|'none', url, mailto}.
 */
function parseListUnsubscribe(header, postHeader) {
  var out = { method: 'none', url: '', mailto: '' };
  var parts = String(header || '').match(/<[^>]+>/g) || [];
  parts.forEach(function (p) {
    var v = p.slice(1, -1).trim();
    if (/^https:\/\//i.test(v) && !out.url) out.url = v;
    else if (/^mailto:/i.test(v) && !out.mailto) out.mailto = v;
  });
  var oneClick = /one-click/i.test(String(postHeader || ''));
  if (out.url && oneClick) out.method = 'one-click';
  else if (out.mailto) out.method = 'mailto';
  else if (out.url) out.method = 'link';
  return out;
}

/** 'mailto:a@b.com?subject=Unsub&body=x' -> {to, subject, body} or null if the address looks wrong. */
function parseMailto(mailto) {
  var m = String(mailto || '').match(/^mailto:([^?]+)(?:\?(.*))?$/i);
  if (!m) return null;
  var to = decodeURIComponent(m[1]).trim();
  if (!/^[^\s@<>",;]+@[^\s@<>",;]+$/.test(to)) return null;
  var q = {};
  (m[2] || '').split('&').forEach(function (kv) {
    var i = kv.indexOf('=');
    if (i > 0) q[kv.slice(0, i).toLowerCase()] = decodeURIComponent(kv.slice(i + 1));
  });
  return { to: to, subject: q.subject || 'unsubscribe', body: q.body || 'unsubscribe' };
}

/**
 * Classify one thread (looking at its latest message).
 * t: {fromEmail, subject, hasListUnsub, gmailCategory, lastFromMe, daysAgo, unread, getBody()}
 */
function classifyThread(t) {
  var res = { category: 'notification', urgent: false, quick: false, hasQuestion: false, priority: 0 };
  var subject = String(t.subject || '');

  if (t.lastFromMe) {
    res.category = 'waiting';
    res.priority = Math.min(t.daysAgo || 0, 30) * 5;
    return res;
  }

  var autoCats = ['promotions', 'social', 'updates', 'forums'];
  var automated = !!t.hasListUnsub ||
    AP_RE_AUTOMATED_SENDER.test(t.fromEmail || '') ||
    AP_RE_ROLE_SENDER.test(t.fromEmail || '') ||
    AP_RE_BULK_SENDER.test(t.fromEmail || '') ||
    autoCats.indexOf(t.gmailCategory) >= 0;

  if (automated) {
    if (AP_RE_RECEIPT.test(subject)) res.category = 'receipt';
    else if (t.hasListUnsub || AP_RE_BULK_SENDER.test(t.fromEmail || '') || t.gmailCategory === 'promotions' || t.gmailCategory === 'forums') res.category = 'newsletter';
    else res.category = 'notification';
    return res;
  }

  // A real person wrote to me and I have not answered.
  res.category = 'reply';
  var body = stripQuoted(t.getBody ? t.getBody() : '');
  res.urgent = AP_RE_URGENT.test(subject + ' ' + body.slice(0, 300));
  res.hasQuestion = body.indexOf('?') >= 0 || subject.indexOf('?') >= 0;
  res.quick = body.length > 0 && body.length < 280;
  res.priority = priorityScore(res, t);
  return res;
}

function priorityScore(res, t) {
  var s = Math.min(t.daysAgo || 0, 14) * 3;
  if (res.urgent) s += 40;
  if (t.unread) s += 10;
  if (res.hasQuestion) s += 15;
  if (res.quick) s += 5;
  return s;
}

/** Group newsletter items by sender for the unsubscribe screen. */
function groupSenders(items) {
  var map = {};
  items.forEach(function (it) {
    if (it.category !== 'newsletter') return;
    var g = map[it.fromEmail] || (map[it.fromEmail] = {
      email: it.fromEmail, name: it.fromName, count: 0, lastDate: it.date, method: 'none'
    });
    g.count += 1;
    if (it.date > g.lastDate) g.lastDate = it.date;
    var rank = { 'one-click': 3, mailto: 2, link: 1, none: 0 };
    if (rank[it.unsubMethod] > rank[g.method]) g.method = it.unsubMethod;
  });
  return Object.keys(map).map(function (k) { return map[k]; })
    .sort(function (a, b) { return b.count - a.count; });
}

/** Streak = consecutive days (ending today or yesterday) with at least one item cleared. */
function computeStreak(daysMap, todayKey) {
  var streak = 0;
  var d = new Date(todayKey + 'T00:00:00Z');
  if (!(daysMap[todayKey] > 0)) d.setUTCDate(d.getUTCDate() - 1);
  while (daysMap[d.toISOString().slice(0, 10)] > 0) {
    streak++;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return streak;
}

/** Gmail "reacted with an emoji" messages are not real replies. */
function isReaction(text) { return AP_RE_REACTION.test(String(text || '')); }
