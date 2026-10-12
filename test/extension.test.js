// Run: node test/extension.test.js  (needs `playwright` + Chromium). Loads the content script into a fake Gmail page.
const { chromium } = require(process.env.PW_PATH || 'playwright');
const fs = require('fs'), path = require('path'), assert = require('assert');
const X = p => fs.readFileSync(path.join(__dirname, '..', 'extension', p), 'utf8');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
  const p = await b.newPage({ viewport: { width: 1280, height: 780 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  // freeze "now" so waiting times are deterministic: 2026-10-10 12:00 UTC
  const FREEZE = () => { const R = Date.now.bind(Date), off = Date.parse('2026-10-11T12:00:00Z') - R(); Date.now = () => R() + off; };
  await p.addInitScript(FREEZE);
  await p.goto('file://' + path.join(__dirname, 'mock-gmail.html'));
  await p.addScriptTag({ content: 'window.chrome=undefined;' });
  await p.addStyleTag({ content: X('content.css') });
  await p.addScriptTag({ content: X('logic.js') });
  await p.addScriptTag({ content: X('content.js') });
  await p.waitForSelector('#dc-bar .dc-chip');
  const cats = await p.$$eval('tr.zA', rs => rs.map(r => r.getAttribute('data-dc-cat')));
  assert.deepStrictEqual(cats, ['reply', 'reply', 'reply', 'newsletter', 'newsletter', 'newsletter', 'receipt', 'notification', 'waiting', 'notification']);
  assert.strictEqual(await p.$$eval('.dc-badge', n => n.length) > 9, true);
  const boxes = await p.$$eval('tr.zA', rs => rs.map(r => r.getAttribute('data-dc-box')));
  // Maria 9d and Clara 10d waiting -> red; Nikos 2d -> orange; promo ends today -> orange; bill -> green
  assert.deepStrictEqual(boxes, ['p1', 'p2', 'p1', 'p3', 'p2', 'p3', 'p4', 'p3', '', 'p3']);
  const shown = async () => p.$$eval('tr.zA', rs => rs.filter(r => r.offsetParent).length);
  await p.click('.dc-chip:has-text("Important & urgent")'); assert.strictEqual(await shown(), 2);
  await p.click('.dc-chip:has-text("Important, not urgent")'); assert.strictEqual(await shown(), 1);
  await p.click('.dc-chip:has-text("Not important, urgent")'); assert.strictEqual(await shown(), 2);
  await p.click('.dc-chip:has-text("Not important, not urgent")'); assert.strictEqual(await shown(), 4);
  await p.click('.dc-chip:has-text("Websites")'); assert.strictEqual(await shown(), 6);          // every website/service email
  await p.click('.dc-chip:has-text("LinkedIn")'); assert.strictEqual(await shown(), 1);           // pinned LinkedIn filter
  await p.selectOption('.dc-select', 'GitHub'); assert.strictEqual(await shown(), 1);            // company drop-down
  // in-page notification: longest wait first
  assert.match(await p.textContent('#dc-notifs .dc-n-card'), /Clara is waiting for your reply/);
  assert.match(await p.textContent('#dc-notifs .dc-n-card'), /10 days/);
  await p.click('#dc-notifs .dc-btn:has-text("Remind me tomorrow")');
  assert.match(await p.textContent('#dc-notifs .dc-n-card'), /Maria is waiting for your reply/);
  await p.click('.dc-chip:has-text("All")');
  const dir = process.env.OUT || __dirname;
  await p.screenshot({ path: path.join(dir, 'ext-list.png') });
  await p.click('.dc-chip:has-text("Needs reply")');
  assert.strictEqual(await p.$$eval('tr.zA', rs => rs.filter(r => r.offsetParent).length), 3);
  await p.click('.dc-chip:has-text("Newsletters")');
  assert.strictEqual(await p.$$eval('tr.zA', rs => rs.filter(r => r.offsetParent).length), 3);
  await p.click('.dc-chip:has-text("All")');
  await p.click('#dc-launch'); await p.waitForSelector('.dc-card');
  assert.match(await p.textContent('.dc-card h3'), /Contract draft|Quick question/); // longest-waiting first
  await p.screenshot({ path: path.join(dir, 'ext-focus.png') });
  await p.click('#dc-drawer .dc-btn:has-text("Done")'); await p.waitForTimeout(100);
  assert.match(await p.textContent('.dc-card h3'), /Quick question|Dinner|Contract/);
  assert.strictEqual(await p.$$eval('tr.zA[data-dc-gone="1"]', n => n.length), 1);
  await p.click('.dc-tab:has-text("Unsubscribe")'); await p.waitForSelector('.dc-row');
  await p.screenshot({ path: path.join(dir, 'ext-unsub.png') });
  assert.deepStrictEqual(errs, []);

  // ---- whole-inbox scan + board, on a fake inbox of 129 emails (3 pages of 50) ----
  const q = await b.newPage({ viewport: { width: 1280, height: 780 }, acceptDownloads: true });
  await q.addInitScript(FREEZE);
  q.on('pageerror', e => errs.push(e.message));
  await q.goto('file://' + path.join(__dirname, 'mock-gmail.html') + '?big=1');
  await q.addStyleTag({ content: X('content.css') });
  await q.addScriptTag({ content: X('logic.js') });
  await q.addScriptTag({ content: X('content.js') });
  await q.waitForSelector('.dc-board-btn');
  await q.click('.dc-board-btn');
  await q.waitForSelector('#dc-board');
  assert.strictEqual(await q.$$eval('tr.zA', r => r.length), 50); // Gmail only shows one page
  await q.click('#dc-board-head .dc-btn:has-text("Scan whole inbox")');
  await q.waitForFunction(() => /full scan/.test(document.querySelector('.dc-status').textContent), null, { timeout: 40000 });
  assert.match(await q.textContent('.dc-status'), /130 emails known/);
  const counts = await q.$$eval('.dc-panel', ps => ps.map(p => p.getAttribute('data-c') + ':' + p.querySelector('.dc-n').textContent));
  console.log('panel counts', counts.join(' '));
  assert.ok(Number(counts[0].split(':')[1]) > 30, 'reply panel should hold people from all pages');
  await q.fill('#dc-q', 'Hello #99');
  assert.strictEqual(await q.$$eval('.dc-panel[data-c="reply"] .dc-item', n => n.length), 1);
  await q.fill('#dc-q', '');
  await q.selectOption('#dc-age', '7');
  await q.waitForTimeout(100);
  await q.screenshot({ path: path.join(dir, 'ext-board.png') });
  await q.click('.dc-seg-btn:has-text("By priority")');
  const pc = await q.$$eval('.dc-panel', ps => ps.map(p => p.getAttribute('data-c') + ':' + p.querySelector('.dc-n').textContent));
  console.log('priority panels', pc.join(' '));
  assert.deepStrictEqual(pc.map(x => x.split(':')[0]), ['p1', 'p4', 'p2', 'p3']);
  await q.screenshot({ path: path.join(dir, 'ext-priority.png') });
  await q.click('.dc-seg-btn:has-text(\"By company\")');
  await q.waitForSelector('.dc-panel[data-c="companies"] .dc-item');
  const nCompanies = await q.$$eval('.dc-panel[data-c="companies"] .dc-item', n => n.length);
  assert.ok(nCompanies >= 5, 'companies listed: ' + nCompanies);
  await q.screenshot({ path: path.join(dir, 'ext-company.png') });
  await q.click('.dc-panel[data-c="companies"] .dc-item >> nth=1');
  assert.ok(await q.$$eval('.dc-panel[data-c="company-emails"] .dc-item', n => n.length) > 0);
  // auto-sort filters: downloadable Gmail import file
  await q.click('#dc-board-head .dc-btn:has-text("Auto-sort filters")');
  await q.waitForSelector('#dc-modal');
  await q.screenshot({ path: path.join(dir, 'ext-filters.png') });
  const [dl] = await Promise.all([q.waitForEvent('download'), q.click('#dc-modal .dc-btn:has-text("Download file")')]);
  const xml = fs.readFileSync(await dl.path(), 'utf8');
  assert.match(xml, /Declutter\/LinkedIn/); assert.match(xml, /Declutter\/Companies\/GitHub/); assert.match(xml, /<feed /);
  assert.ok(!/shouldArchive/.test(xml), 'inbox is kept unless the box is ticked');
  await q.click('#dc-modal .dc-btn:has-text("Close")');
  await q.click('.dc-seg-btn:has-text("By type")');
  // whole-mailbox search through Gmail's own search, across result pages
  await q.selectOption('#dc-age', '0');
  await q.fill('#dc-q', 'essay');
  await q.click('#dc-board-head .dc-btn:has-text("Search all mail")');
  await q.waitForSelector('.dc-results .dc-item', { timeout: 30000 });
  await q.waitForFunction(() => !document.querySelector('.dc-status').textContent.startsWith('Searching'), null, { timeout: 30000 });
  const found = Number(await q.textContent('.dc-results header .dc-n'));
  assert.ok(found >= 30, 'search should find every matching email, got ' + found);
  assert.match(await q.textContent('.dc-status'), /130 emails known/); // search must not pollute the inbox archive
  await q.screenshot({ path: path.join(dir, 'ext-search.png') });
  await q.click('.dc-results .dc-btn:has-text("Clear")');
  assert.strictEqual(await q.$$eval('.dc-panel[data-c="reply"]', n => n.length), 1);
  assert.deepStrictEqual(errs, []);
  console.log('extension tests passed'); await b.close();
})().catch(e => { console.error(e); process.exit(1); });
