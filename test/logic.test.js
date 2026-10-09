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
const g = L('groupSenders')([
  { category: 'newsletter', fromEmail: 'a@x.com', fromName: 'A', date: '2026-01-01', unsubMethod: 'link' },
  { category: 'newsletter', fromEmail: 'a@x.com', fromName: 'A', date: '2026-02-01', unsubMethod: 'one-click' },
  { category: 'reply', fromEmail: 'h@x.com', fromName: 'H', date: '2026-02-01', unsubMethod: 'none' }]);
assert.strictEqual(g.length, 1); assert.strictEqual(g[0].count, 2); assert.strictEqual(g[0].method, 'one-click');

const s = L('computeStreak');
assert.strictEqual(s({ '2026-10-09': 2, '2026-10-08': 1, '2026-10-07': 1, '2026-10-05': 4 }, '2026-10-09'), 3);
assert.strictEqual(s({ '2026-10-08': 1 }, '2026-10-09'), 1); // today not yet started: streak survives
assert.strictEqual(s({}, '2026-10-09'), 0);
console.log('all logic tests passed');
