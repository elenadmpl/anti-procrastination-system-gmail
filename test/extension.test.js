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
  // ---- no flicker: Gmail sitting idle or churning must not make the extension repaint in a loop ----
  const stat = () => p.evaluate(() => ({ ...window.__declutterStats, bars: document.querySelectorAll('#dc-bar').length }));
  await p.waitForTimeout(1500);
  let f0 = await stat(); await p.waitForTimeout(2500); let f1 = await stat();
  assert.strictEqual(f1.paints - f0.paints, 0, 'idle Gmail must not trigger repaints');
  await p.evaluate(() => { window.__t = setInterval(() => { const d = document.querySelector('.top'); d.append(document.createElement('i')); d.lastChild.remove(); }, 40); });
  f0 = await stat(); await p.waitForTimeout(2500); f1 = await stat(); await p.evaluate(() => clearInterval(window.__t));
  assert.strictEqual(f1.paints - f0.paints, 0, 'unrelated page churn must not trigger repaints');
  await p.evaluate(() => { window.__r = setInterval(() => { const tb = document.getElementById('rows'), h = tb.innerHTML; tb.innerHTML = ''; tb.innerHTML = h; }, 300); });
  f0 = await stat(); await p.waitForTimeout(3000); f1 = await stat(); await p.evaluate(() => clearInterval(window.__r));
  assert.ok(f1.paints - f0.paints <= 5, 'list re-rendering is throttled, got ' + (f1.paints - f0.paints) + ' repaints in 3s');
  await p.evaluate(() => { window.__x = setInterval(() => { const x = document.getElementById('dc-bar'); if (x) x.remove(); }, 400); });
  f0 = await stat(); await p.waitForTimeout(3000); f1 = await stat(); await p.evaluate(() => clearInterval(window.__x));
  assert.ok(f1.paints - f0.paints <= 2, 'removing the bar must not cause a repaint loop, got ' + (f1.paints - f0.paints));
  await p.waitForTimeout(2500);
  assert.strictEqual((await stat()).bars, 1, 'the same bar is restored once');
  await p.waitForTimeout(700);
  const cats = await p.$$eval('tr.zA', rs => rs.map(r => r.getAttribute('data-dc-cat')));
  assert.deepStrictEqual(cats, ['reply', 'reply', 'reply', 'newsletter', 'newsletter', 'newsletter', 'receipt', 'notification', 'waiting', 'notification']);
  assert.strictEqual(await p.$$eval('.dc-badge', n => n.length) > 9, true);
  const boxes = await p.$$eval('tr.zA', rs => rs.map(r => r.getAttribute('data-dc-box')));
  // Maria 9d and Clara 10d waiting -> red; Nikos 2d -> orange; promo ends today -> orange; bill -> green
  assert.deepStrictEqual(boxes, ['p1', 'p2', 'p1', 'p3', 'p2', 'p3', 'p4', 'p3', '', 'p3']);
  const shown = async () => p.$$eval('tr.zA', rs => rs.filter(r => r.offsetParent).length);
  // Subscriptions auto-moves by default: its 3 newsletters leave the main list (All = 10 - 3)
  assert.strictEqual(await shown(), 7);
  await p.click('.dc-chip:has-text("Important & urgent")'); assert.strictEqual(await shown(), 2);
  await p.click('.dc-chip:has-text("Important, not urgent")'); assert.strictEqual(await shown(), 1);
  await p.click('.dc-chip:has-text("Not important, urgent")'); assert.strictEqual(await shown(), 1);          // promo is in Subscriptions
  await p.click('.dc-chip:has-text("Not important, not urgent")'); assert.strictEqual(await shown(), 2);
  await p.click('.dc-chip:has-text("Websites")'); assert.strictEqual(await shown(), 3);
  await p.click('.dc-chip:has-text("Subscriptions")'); assert.strictEqual(await shown(), 3);                  // moved mail lives here
  await p.click('.dc-chip:has-text("LinkedIn")'); assert.strictEqual(await shown(), 1);                         // LinkedIn group
  await p.selectOption('.dc-select[aria-label="Filter by company"]', 'GitHub'); assert.strictEqual(await shown(), 1);
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
  await p.click('.dc-chip:has-text("All")');
  await p.click('#dc-launch'); await p.waitForSelector('.dc-card');
  assert.match(await p.textContent('.dc-card h3'), /Contract draft|Quick question/); // longest-waiting first
  await p.screenshot({ path: path.join(dir, 'ext-focus.png') });
  await p.click('#dc-drawer .dc-btn:has-text("Done")'); await p.waitForTimeout(100);
  assert.match(await p.textContent('.dc-card h3'), /Quick question|Dinner|Contract/);
  assert.strictEqual(await p.$$eval('tr.zA[data-dc-gone="1"]', n => n.length), 1);
  await p.click('.dc-tab:has-text("Unsubscribe")'); await p.waitForSelector('.dc-row');
  await p.screenshot({ path: path.join(dir, 'ext-unsub.png') });
  await p.click('.dc-x[aria-label="Close"]');
  // ---- rules box: auto-move switches, custom groups, Gmail sync ----
  await p.click('.dc-chip:has-text("All")');
  await p.click('.dc-rules-btn'); await p.waitForSelector('#dc-rules');
  const swSubs = '.dc-rule[data-g="subscriptions"] .dc-switch';
  await p.click(swSubs); await p.waitForTimeout(250); assert.strictEqual(await shown(), 9, 'auto-move OFF brings the emails back (one email was marked Done earlier)');
  await p.click(swSubs); await p.waitForTimeout(250); assert.strictEqual(await shown(), 6, 'auto-move ON moves them again');
  await p.click('.dc-rules-head .dc-switch'); await p.waitForTimeout(250); assert.strictEqual(await shown(), 9, 'master switch pauses every group');
  await p.click('.dc-rules-head .dc-switch'); await p.waitForTimeout(250); assert.strictEqual(await shown(), 6);
  await p.fill('#dc-newgroup', 'Clients'); await p.click('.dc-newrow .dc-btn');
  await p.waitForSelector('.dc-rule[data-g^="c"]');
  await p.fill('.dc-rule[data-g^="c"] textarea >> nth=0', 'acme.io'); await p.press('.dc-rule[data-g^="c"] textarea >> nth=0', 'Tab');
  await p.waitForTimeout(250);
  assert.strictEqual(await p.$$eval('tr.zA[data-dc-group^="c"]', n => n.length), 1, 'custom sender rule catches Clara');
  assert.ok(await p.$('.dc-chip:has-text("Clients")'), 'the new group gets a chip');
  await p.click('.dc-rule[data-g^="c"] .dc-switch'); await p.waitForTimeout(250);
  assert.strictEqual(await shown(), 5, 'auto-move works for a custom group');
  await p.click('.dc-rule[data-g^="c"] .dc-switch'); await p.waitForTimeout(250);
  assert.strictEqual(await shown(), 6);
  // Gmail sync: label + move out of inbox for Subscriptions, label only for LinkedIn
  await p.selectOption('.dc-rule[data-g="subscriptions"] select', 'label-move');
  await p.selectOption('.dc-rule[data-g="linkedin"] select', 'label');
  await p.waitForTimeout(200);
  assert.match(await p.textContent('.dc-rules-btn'), /•/, 'changed sync settings are flagged');
  await p.click('#dc-rules .dc-btn:has-text("Gmail filters")'); await p.waitForSelector('#dc-modal');
  const [dl0] = await Promise.all([p.waitForEvent('download'), p.click('#dc-modal .dc-btn:has-text("Download file")')]);
  const gx = fs.readFileSync(await dl0.path(), 'utf8');
  assert.match(gx, /Declutter\/Subscriptions/); assert.match(gx, /shouldArchive/); assert.match(gx, /Declutter\/LinkedIn/);
  await p.waitForTimeout(250);
  assert.ok(!/•/.test(await p.textContent('.dc-rules-btn')), 'after downloading the file the flag clears');
  await p.click('#dc-modal .dc-btn:has-text("Close")'); await p.click('#dc-rules .dc-btn:has-text("Close")');

  // ---- line colors: automatic by priority or group, in colors you choose, or picked by hand ----
  const colOf = async name => p.$$eval('tr.zA', (rs, n) => { const r = rs.find(x => x.textContent.includes(n)); return r.getAttribute('data-dc-col'); }, name);
  assert.strictEqual(await colOf('Contract draft'), '#d93025');                       // important & urgent = red
  await p.click('.dc-rules-btn'); await p.waitForSelector('#dc-rules');
  await p.$eval('.dc-colorpick[data-k="p1"]', el => { el.value = '#0000ff'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await p.waitForTimeout(250);
  assert.strictEqual(await colOf('Contract draft'), '#0000ff', 'you can choose the color of the important & urgent lines');
  await p.selectOption('#dc-colorby', 'group'); await p.waitForTimeout(250);
  assert.strictEqual(await colOf('Contract draft'), '', 'no group, no color when coloring by group');
  assert.strictEqual(await colOf('805 profile views'), '#0a66c2', 'LinkedIn lines use the LinkedIn group color');
  await p.selectOption('#dc-colorby', 'priority'); await p.waitForTimeout(250);
  await p.click('#dc-rules .dc-btn:has-text("Close")');
  // one email, picked by hand
  await p.click('tr.zA:has-text("Dinner Saturday") .dc-pick');
  await p.waitForSelector('#dc-pop');
  await p.click('#dc-pop .dc-swatch[title="#8e4ec6"]');
  assert.strictEqual(await colOf('Dinner Saturday'), '#8e4ec6', 'a picked color wins for that email');
  assert.strictEqual(await colOf('Quick question'), '#0000ff', 'other emails keep their automatic color');
  await p.click('tr.zA:has-text("Dinner Saturday") .dc-pick'); await p.click('#dc-pop .dc-link:has-text("Automatic")');
  assert.strictEqual(await colOf('Dinner Saturday'), '#e8710a', 'Automatic returns to the priority color (orange)');
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
  { const a = await q.evaluate(() => window.__declutterStats.paints); await q.waitForTimeout(2000); const z = await q.evaluate(() => window.__declutterStats.paints); assert.strictEqual(z - a, 0, 'an open board must not repaint while idle'); }
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
  assert.match(await q.textContent('#dc-modal'), /No group is set to sync with Gmail/);
  assert.match(xml, /Declutter\/Urgent/); assert.match(xml, /Declutter\/Companies\/GitHub/); assert.match(xml, /<feed /);
  assert.ok(!/shouldArchive/.test(xml) && !/Declutter\/LinkedIn/.test(xml), 'groups set to Declutter only add nothing to Gmail');
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
