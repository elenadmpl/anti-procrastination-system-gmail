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
var AP_RE_URGENT = /\b(urgent|asap|deadline|due (today|tomorrow|soon|by)|action required|final notice|expires?( today| soon)?|ends? (today|tonight|soon|tomorrow)|today only|last chance|hurry|act (now|today)|immediately|within 24 hours|by (eod|end of day)|time[- ]sensitive|overdue|past due)\b/i;
var AP_RE_MONEY = /\b(bill|invoice|unpaid|overdue|payment|statement|due)\b/i;
var AP_RE_SECURITY = /\b(security alert|password|suspended|locked|unauthori[sz]ed|verify your (account|identity)|fraud)\b/i;

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

/** Priority boxes (Eisenhower matrix): p1 red, p2 orange, p3 yellow, p4 green. */
var AP_PRIORITY_META = {
  p1: { title: 'Important & urgent',       color: 'red' },
  p2: { title: 'Not important, urgent',    color: 'orange' },
  p3: { title: 'Not important, not urgent', color: 'yellow' },
  p4: { title: 'Important, not urgent',    color: 'green' }
};

/** Eisenhower-style box for a classified email. Returns 'p1' | 'p2' | 'p3' | '' */
function priorityBox(category, urgent, text) {
  if (category === 'waiting') return '';
  var important = category === 'reply' ||
    (category === 'receipt' && AP_RE_MONEY.test(text || '')) ||
    AP_RE_SECURITY.test(text || '');
  if (important && urgent) return 'p1';
  if (!important && urgent) return 'p2';
  if (!important) return 'p3';
  return 'p4';
}

/**
 * Classify one thread (looking at its latest message).
 * t: {fromEmail, subject, hasListUnsub, gmailCategory, lastFromMe, daysAgo, unread, getBody()}
 * Returns {category, urgent, quick, hasQuestion, priority (score), box}
 */
function classifyThread(t) {
  var res = classifyBase_(t);
  if (res.category !== 'reply') res.urgent = AP_RE_URGENT.test(String(t.subject || ''));
  res.box = priorityBox(res.category, res.urgent, String(t.subject || ''));
  return res;
}

function classifyBase_(t) {
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

/* ---------- waiting-time escalation ---------- */

/**
 * Someone is waiting for YOUR reply: the longer it sits, the hotter it gets.
 * 7+ days -> p1 (red). 2-6 days -> p2 (orange) unless it is already p1. Fresher mail keeps its normal box.
 */
function agingBox(category, baseBox, daysAgo) {
  if (category !== 'reply') return baseBox;
  if (daysAgo >= 7) return 'p1';
  if (daysAgo >= 2 && baseBox !== 'p1') return 'p2';
  return baseBox;
}

/* ---------- companies (who the website/sender is) ---------- */

var AP_SECOND_LEVEL = /^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/i;
var AP_BULK_PLATFORMS = /(^|\.)(substack\.com|mailchimp\.com|mailchimpapp\.com|list-manage\.com|sendgrid\.net|mailgun\.org|beehiiv\.com|convertkit\.com|hubspotemail\.net|constantcontact\.com|amazonses\.com|mandrillapp\.com|e\.read\.ai)$/i;
var AP_BRANDS = {
  linkedin: 'LinkedIn', github: 'GitHub', youtube: 'YouTube', paypal: 'PayPal', wetransfer: 'WeTransfer',
  imdbpro: 'IMDbPro', imdb: 'IMDb', otter: 'Otter.ai', pinterest: 'Pinterest', medium: 'Medium', pitch: 'Pitch',
  acm: 'ACM', mit: 'MIT', google: 'Google', microsoft: 'Microsoft', microsoftadvertising: 'Microsoft Advertising',
  amazon: 'Amazon', apple: 'Apple', facebook: 'Facebook', facebookmail: 'Facebook', instagram: 'Instagram',
  twitter: 'X (Twitter)', x: 'X (Twitter)', slack: 'Slack', zoom: 'Zoom', notion: 'Notion', figma: 'Figma',
  canva: 'Canva', adobe: 'Adobe', spotify: 'Spotify', uber: 'Uber', airbnb: 'Airbnb', booking: 'Booking.com',
  accredible: 'Accredible', lucidlink: 'LucidLink', atomos: 'Atomos', vodafone: 'Vodafone'
};

/** 'no-reply@mailsvc.sloan.mit.edu' -> 'mit.edu'; 'x@foo.co.uk' -> 'foo.co.uk' */
function registrableDomain(email) {
  var host = String(email || '').split('@')[1] || '';
  var labels = host.toLowerCase().split('.').filter(String);
  if (labels.length <= 2) return labels.join('.');
  var last2 = labels.slice(-2).join('.');
  return AP_SECOND_LEVEL.test(last2) ? labels.slice(-3).join('.') : last2;
}

/** {name, domain}. Bulk-mail platforms (Substack, Mailchimp...) use the sender's display name instead. */
function companyOf(email, displayName) {
  var host = (String(email || '').split('@')[1] || '').toLowerCase();
  var domain = registrableDomain(email);
  if (!domain) return { name: displayName || 'Unknown', domain: '' };
  if (AP_BULK_PLATFORMS.test(host)) return { name: displayName || domain, domain: '' }; // domain '' = do not filter by domain
  var label = domain.split('.')[0];
  var brand = AP_BRANDS[label];
  if (!brand) brand = label.charAt(0).toUpperCase() + label.slice(1);
  return { name: brand, domain: domain };
}

/* ---------- Gmail filters (import once, then Gmail files new mail itself) ---------- */

/**
 * Rules for Gmail's own filter engine. companies: [{name, domain, count}] from the user's scanned mail.
 * opts: {skipInbox: bool} archive low-priority groups on arrival.
 */
function gmailFilterRules(companies, opts) {
  opts = opts || {};
  var skip = !!opts.skipInbox;
  var rules = [
    { from: 'linkedin.com', label: 'Declutter/LinkedIn', archive: false },
    { from: 'substack.com OR mailchimpapp.com OR list-manage.com OR beehiiv.com OR convertkit.com OR sendgrid.net OR newsletter OR digest',
      label: 'Declutter/Newsletters', archive: skip },
    { from: 'noreply OR no-reply OR donotreply OR notifications OR mailer-daemon', label: 'Declutter/Notifications', archive: skip },
    { subject: 'receipt OR invoice OR "your order" OR payment OR "your bill" OR statement', from: 'noreply OR no-reply OR billing OR orders OR invoice OR accountspayable',
      label: 'Declutter/Receipts and Bills', archive: false },
    { subject: 'urgent OR "action required" OR "final notice" OR overdue OR "due today" OR "last chance"', label: 'Declutter/Urgent', archive: false }
  ];
  (companies || []).filter(function (c) { return c.domain && c.count >= 3 && c.domain !== 'linkedin.com'; })
    .slice(0, 60).forEach(function (c) {
      rules.push({ from: c.domain, label: 'Declutter/Companies/' + c.name.replace(/[\/\\]/g, '-'), archive: false });
    });
  return rules;
}

function xmlEsc_(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;').replace(/"/g, '&quot;'); }

/** Gmail "Import filters" file (Settings > Filters and Blocked Addresses > Import filters). */
function filtersToXml(rules) {
  var out = ["<?xml version='1.0' encoding='UTF-8'?>",
    "<feed xmlns='http://www.w3.org/2005/Atom' xmlns:apps='http://schemas.google.com/apps/2006'>",
    '\t<title>Mail Filters</title>'];
  rules.forEach(function (r) {
    out.push("\t<entry>", "\t\t<category term='filter'></category>", '\t\t<title>Mail Filter</title>', '\t\t<content></content>');
    if (r.from) out.push("\t\t<apps:property name='from' value='" + xmlEsc_(r.from) + "'/>");
    if (r.subject) out.push("\t\t<apps:property name='subject' value='" + xmlEsc_(r.subject) + "'/>");
    out.push("\t\t<apps:property name='label' value='" + xmlEsc_(r.label) + "'/>");
    if (r.archive) out.push("\t\t<apps:property name='shouldArchive' value='true'/>");
    out.push("\t\t<apps:property name='sizeOperator' value='s_sl'/>", "\t\t<apps:property name='sizeUnit' value='s_smb'/>", '\t</entry>');
  });
  out.push('</feed>');
  return out.join('\n');
}
