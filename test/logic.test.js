// Run: node test/logic.test.js  — loads src/Logic.gs in a sandbox and checks the pure logic.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(__dirname + '/../src/Logic.gs', 'utf8'), ctx);
const L = n => vm.runInContext(n, ctx);
const j = x => JSON.parse(JSON.stringify(x)); // strip cross-realm prototypes

assert.deepStrictEqual(j(L('parseAddress')('"Jane Doe" <Jane@X.com>')), { name: 'Jane Doe', email: 'jane@x.com' });
assert.deepStrictEqual(j(L('parseAddress')('bob@x.com')), { name: 'bob', email: 'bob@x.com' });

const u = L('parseListUnsubscribe');
assert.strictEqual(u('<https://x.com/u?id=1>, <mailto:u@x.com>', 'List-Unsubscribe=One-Click').method, 'one-click');
assert.strictEqual(u('<https://x.com/u>, <mailto:u@x.com>', '').method, 'mailto');
assert.strictEqual(u('<https://x.com/u>', '').method, 'link');
assert.strictEqual(u('<http://insecure.com/u>', '').method, 'none'); // https only
assert.strictEqual(u('', '').method, 'none');

const mt = L('parseMailto');
assert.deepStrictEqual(j(mt('mailto:u@x.com?subject=Please%20remove')), { to: 'u@x.com', subject: 'Please remove', body: 'unsubscribe' });
assert.strictEqual(mt('mailto:a@b.com,evil@c.com'), null);

const C = L('classifyThread');
const base = { daysAgo: 4, unread: true, getBody: () => 'Hi, can you review this by Friday? It is urgent.\n\nOn Mon, Bob wrote:\n> old' };
assert.strictEqual(C({ ...base, fromEmail: 'maria@studio.gr', subject: 'Contract' }).category, 'reply');
const r = C({ ...base, fromEmail: 'maria@studio.gr', subject: 'Contract' });
assert.ok(r.urgent && r.hasQuestion && r.priority > 60, 'urgent question should rank high');
assert.ok(C({ ...base, fromEmail: 'nikos@gmail.com', subject: 'Hi', getBody: () => 'Dinner Sat?' }).quick);
assert.strictEqual(C({ ...base, fromEmail: 'a@b.com', subject: 'x', lastFromMe: true }).category, 'waiting');
assert.strictEqual(C({ ...base, fromEmail: 'news@shop.com', subject: '50% off', hasListUnsub: true }).category, 'newsletter');
assert.strictEqual(C({ ...base, fromEmail: 'orders@shop.com', subject: 'Your order #123', hasListUnsub: true }).category, 'receipt');
assert.strictEqual(C({ ...base, fromEmail: 'notifications@github.com', subject: 'New comment' }).category, 'notification');
assert.strictEqual(C({ ...base, fromEmail: 'x@y.com', subject: 'Sale', gmailCategory: 'promotions' }).category, 'newsletter');
assert.strictEqual(C({ ...base, fromEmail: 'friend@gmail.com', subject: 'Invoice attached' }).category, 'reply'); // humans stay humans

// regressions found on a real mailbox
assert.strictEqual(C({ ...base, fromEmail: 'promo@fashiondeals.com', subject: '50% off', gmailCategory: undefined }).category, 'newsletter');
assert.strictEqual(C({ ...base, fromEmail: 'ruben@substack.com', subject: 'Certified.', gmailCategory: 'updates' }).category, 'newsletter');
assert.strictEqual(C({ ...base, fromEmail: 'accountspayable@bdainc.com', subject: 'AP Validated and Unpaid Report', gmailCategory: 'personal' }).category, 'receipt');
assert.strictEqual(C({ ...base, fromEmail: 'no-reply@otter.ai', subject: 'Meeting Summary', gmailCategory: 'updates' }).category, 'notification');
assert.ok(L('isReaction')('😊 Ο χρήστης Elena αντέδρασε μέσω Gmail') && L('isReaction')('Elena reacted via Gmail') && !L('isReaction')('thanks!'));
// priority boxes: p1 red, p2 orange, p3 yellow, p4 green
const box = o => C({ daysAgo: 2, getBody: () => '', ...o }).box;
assert.strictEqual(box({ fromEmail: 'a@gmail.com', subject: 'Contract – please sign today, urgent' }), 'p1');
assert.strictEqual(box({ fromEmail: 'billing@x.com', subject: 'Invoice overdue – final notice' }), 'p1');
assert.strictEqual(box({ fromEmail: 'no-reply@bank.com', subject: 'Security alert: new sign-in, act today' }), 'p1');
assert.strictEqual(box({ fromEmail: 'promo@shop.com', subject: '50% off ends tonight' }), 'p2');
assert.strictEqual(box({ fromEmail: 'news@x.com', subject: 'This week in tech' }), 'p3');
assert.strictEqual(box({ fromEmail: 'notifications@github.com', subject: 'New comment' }), 'p3');
assert.strictEqual(box({ fromEmail: 'a@gmail.com', subject: 'Dinner?' }), 'p4');          // important, not urgent
assert.strictEqual(box({ fromEmail: 'billing@x.com', subject: 'Your bill is ready' }), 'p4');
assert.strictEqual(box({ fromEmail: 'a@b.com', subject: 'x', lastFromMe: true }), '');     // waiting on others: no color
const g = L('groupSenders')([
  { category: 'newsletter', fromEmail: 'a@x.com', fromName: 'A', date: '2026-01-01', unsubMethod: 'link' },
  { category: 'newsletter', fromEmail: 'a@x.com', fromName: 'A', date: '2026-02-01', unsubMethod: 'one-click' },
  { category: 'reply', fromEmail: 'h@x.com', fromName: 'H', date: '2026-02-01', unsubMethod: 'none' }]);
assert.strictEqual(g.length, 1); assert.strictEqual(g[0].count, 2); assert.strictEqual(g[0].method, 'one-click');

const s = L('computeStreak');
assert.strictEqual(s({ '2026-10-09': 2, '2026-10-08': 1, '2026-10-07': 1, '2026-10-05': 4 }, '2026-10-09'), 3);
assert.strictEqual(s({ '2026-10-08': 1 }, '2026-10-09'), 1); // today not yet started: streak survives
assert.strictEqual(s({}, '2026-10-09'), 0);
// waiting-time escalation: a person waiting 7+ days is red, 2-6 days orange
const A = L('agingBox');
assert.strictEqual(A('reply', 'p4', 9), 'p1');
assert.strictEqual(A('reply', 'p4', 3), 'p2');
assert.strictEqual(A('reply', 'p1', 3), 'p1');
assert.strictEqual(A('reply', 'p4', 1), 'p4');
assert.strictEqual(A('newsletter', 'p3', 30), 'p3'); // only people waiting on you escalate

// companies
const K = L('companyOf');
assert.deepStrictEqual(j(K('messages-noreply@linkedin.com', 'LinkedIn')), { name: 'LinkedIn', domain: 'linkedin.com' });
assert.deepStrictEqual(j(K('executive_education@mailsvc.sloan.mit.edu', 'MIT Sloan')), { name: 'MIT', domain: 'mit.edu' });
assert.deepStrictEqual(j(K('x@shop.co.uk', 'Shop')), { name: 'Shop', domain: 'shop.co.uk' });
assert.deepStrictEqual(j(K('ruben@substack.com', 'Ruben Hassid')), { name: 'Ruben Hassid', domain: '' }); // platforms use the writer's name

// Gmail filter import file
const rules = L('gmailFilterRules')([{ name: 'Vodafone', domain: 'vodafone.gr', count: 5 }, { name: 'Rare', domain: 'rare.io', count: 1 }], { skipInbox: true });
assert.ok(rules.some(r => r.label === 'Declutter/LinkedIn'));
assert.ok(rules.some(r => r.label === 'Declutter/Companies/Vodafone' && r.from === 'vodafone.gr'));
assert.ok(!rules.some(r => r.label.includes('Rare')), 'companies with fewer than 3 emails get no filter');
assert.strictEqual(rules.find(r => r.label === 'Declutter/Newsletters').archive, true);
assert.strictEqual(L('gmailFilterRules')([], {}).find(r => r.label === 'Declutter/Newsletters').archive, false); // inbox kept by default
const xml = L('filtersToXml')([{ from: 'a&b.com', label: 'X/Y', archive: true }]);
assert.match(xml, /name='from' value='a&amp;b.com'/); assert.match(xml, /shouldArchive/); assert.match(xml, /<\/feed>$/);
console.log('all logic tests passed');
