// Run: node test/extension.test.js  (needs `playwright` + Chromium). Loads the content script into a fake Gmail page.
const { chromium } = require(process.env.PW_PATH || 'playwright');
const fs = require('fs'), path = require('path'), assert = require('assert');
const X = p => fs.readFileSync(path.join(__dirname, '..', 'extension', p), 'utf8');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
  const p = await b.newPage({ viewport: { width: 1280, height: 780 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('file://' + path.join(__dirname, 'mock-gmail.html'));
  await p.addScriptTag({ content: 'window.chrome=undefined;' });
  await p.addStyleTag({ content: X('content.css') });
  await p.addScriptTag({ content: X('logic.js') });
  await p.addScriptTag({ content: X('content.js') });
  await p.waitForSelector('#dc-bar .dc-chip');
  const cats = await p.$$eval('tr.zA', rs => rs.map(r => r.getAttribute('data-dc-cat')));
  assert.deepStrictEqual(cats, ['reply', 'reply', 'reply', 'newsletter', 'newsletter', 'newsletter', 'receipt', 'notification', 'waiting']);
  assert.strictEqual(await p.$$eval('.dc-badge', n => n.length) > 9, true);
  const dir = process.env.OUT || __dirname;
  await p.screenshot({ path: path.join(dir, 'ext-list.png') });
  await p.click('.dc-chip:has-text("Needs reply")');
  assert.strictEqual(await p.$$eval('tr.zA', rs => rs.filter(r => r.offsetParent).length), 3);
  await p.click('.dc-chip:has-text("Newsletters")');
  assert.strictEqual(await p.$$eval('tr.zA', rs => rs.filter(r => r.offsetParent).length), 3);
  await p.click('.dc-chip:has-text("All")');
  await p.click('#dc-launch'); await p.waitForSelector('.dc-card');
  assert.match(await p.textContent('.dc-card h3'), /Contract draft/); // urgent one first
  await p.screenshot({ path: path.join(dir, 'ext-focus.png') });
  await p.click('.dc-btn:has-text("Done")'); await p.waitForTimeout(100);
  assert.match(await p.textContent('.dc-card h3'), /Quick question|Dinner/);
  assert.strictEqual(await p.$$eval('tr.zA[data-dc-gone="1"]', n => n.length), 1);
  await p.click('.dc-tab:has-text("Unsubscribe")'); await p.waitForSelector('.dc-row');
  await p.screenshot({ path: path.join(dir, 'ext-unsub.png') });
  assert.deepStrictEqual(errs, []);

  // ---- whole-inbox scan + board, on a fake inbox of 129 emails (3 pages of 50) ----
  const q = await b.newPage({ viewport: { width: 1280, height: 780 } });
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
  assert.match(await q.textContent('.dc-status'), /129 emails known/);
  const counts = await q.$$eval('.dc-panel', ps => ps.map(p => p.getAttribute('data-c') + ':' + p.querySelector('.dc-n').textContent));
  console.log('panel counts', counts.join(' '));
  assert.ok(Number(counts[0].split(':')[1]) > 30, 'reply panel should hold people from all pages');
  await q.fill('#dc-q', 'Hello #99');
  assert.strictEqual(await q.$$eval('.dc-panel[data-c="reply"] .dc-item', n => n.length), 1);
  await q.fill('#dc-q', '');
  await q.selectOption('#dc-age', '7');
  await q.waitForTimeout(100);
  await q.screenshot({ path: path.join(dir, 'ext-board.png') });
  assert.deepStrictEqual(errs, []);
  console.log('extension tests passed'); await b.close();
})().catch(e => { console.error(e); process.exit(1); });
