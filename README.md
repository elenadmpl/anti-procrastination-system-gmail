# 📬 Declutter for Gmail

A Chrome extension that adds a clean interface **inside Gmail itself**: colored labels on every email, a filter bar above your list (Needs reply · 2-minute · Waiting on others · Newsletters · Receipts · Notifications), and a Focus drawer that shows one email at a time. It runs entirely in your browser. No Google permissions, no account linking, nothing is uploaded.

## Install in Chrome or Brave (2 minutes)
1. Download `declutter-extension.zip` from this repo and unzip it (or use the `extension/` folder directly).
2. Open `chrome://extensions` (Chrome) or `brave://extensions` (Brave) and switch on **Developer mode** (top right).
3. Click **Load unpacked** and choose the unzipped folder. Edge, Opera and Arc work the same way.
4. Open (or reload) Gmail. You will see the filter bar above your inbox and a blue **Focus** button at the bottom right.

## Priority colors
Every email also gets a priority color, shown as a colored stripe and tag on the row, as filter chips above the list, and as a **By priority** view on the board:
* 🔴 **Important & urgent**: a real person writing to you, an overdue bill, or a security alert, with urgent wording ("urgent", "deadline", "due today", "final notice", "act now").
* 🟠 **Not important, urgent**: time-limited promos and notices ("ends tonight", "today only", "last chance").
* 🟡 **Not important, not urgent**: newsletters, notifications and other bulk mail.
* 🟢 **Important, not urgent**: a real person writing to you without urgent wording, or a normal bill. Plan these.
The rules are in `priorityBox()` and the regexes at the top of `src/Logic.gs`.

## Waiting time, alerts, companies and auto-sort
* **The longer someone waits, the redder it gets.** An email from a real person you have not answered turns 🟠 orange after 2 days and 🔴 red after 7 days (`agingBox()` in `src/Logic.gs`). It updates every day without a rescan.
* **"Luke is waiting for your reply."** A card appears inside Gmail (bottom left) for everyone waiting 2+ days, longest wait first, with Reply, Remind me tomorrow and Done. The 🔔 chip shows the count and brings the card back; Mute for today hides it for 12 hours.
* **Websites group.** The **Websites** chip shows every automated email (newsletters, receipts, notifications) in one place. The **Company…** drop-down filters by company (from the sender's domain, or the sender's name for Substack/Mailchimp-style newsletters), and **LinkedIn** is pinned as its own filter. Pin more from the board: **By company**, then **Pin as filter**.
* **Auto-sort filters.** On the board click **Auto-sort filters** to download a Gmail filter file, then import it once (Gmail gear, See all settings, Filters and Blocked Addresses, Import filters). From then on Gmail itself labels every new email as it arrives, even with Gmail closed: `Declutter/LinkedIn`, `Declutter/Newsletters`, `Declutter/Notifications`, `Declutter/Receipts and Bills`, `Declutter/Urgent`, and one `Declutter/Companies/<name>` per company with 3+ emails in your scan. An optional tick also skips the inbox for newsletters and notifications. Gmail may apply more than one label to the same email.

## See your whole inbox (not just 50 at a time)
Click **Open board ⤢** in the filter bar, then **Scan whole inbox**. Declutter walks through Gmail's pages by itself (page 1, 2, 3 …) and remembers every email it sees, so Focus, Newsletters and the board cover the entire inbox. About 2 to 3 seconds per page of 50. Press Stop any time. Re-scan whenever you like; results are saved in your browser.

**Search the whole mailbox:** type in the board's search box and press Enter (or **Search all mail**). Declutter runs Gmail's own search, which covers every email including archived mail and message text, then reads all result pages into one list with category labels. The box also filters the panels instantly as you type.

The board shows one panel per category (Needs reply, Waiting on others, Newsletters, Receipts & bills, Notifications) with search, an age filter (3+, 7+, 30+ days) and an unread-only switch. Newsletters and notifications are grouped by sender, with Unsubscribe and Hide all.

## How it works
It reads the email rows Gmail already shows on screen (sender, subject, snippet, date) and sorts them with the rules in `extension/logic.js`: a real person you have not answered, a thread where you spoke last, bulk senders and newsletters, bills and receipts, and automated notifications. It works on whatever list is open, so use it on Inbox, Promotions or Updates, and set Gmail to show 100 per page for wider coverage.

Limits: it only sees the emails loaded on screen. "Done" and "Snooze" hide an email in Declutter, they do not archive it in Gmail. Unsubscribe opens the newest email so you can use Gmail's own Unsubscribe link. Gmail changes its internal class names now and then; all selectors are in one object (`ROW_SEL`) at the top of `extension/content.js`.

## Develop
`node test/logic.test.js` (sorting rules) and `node test/extension.test.js` (loads the extension into a fake Gmail page, needs Playwright).
`extension/logic.js` is a copy of `src/Logic.gs`: run `cp src/Logic.gs extension/logic.js` after editing.

---

# Alternative: Google Apps Script version (sidebar add-on)
A plainer sidebar plus a web dashboard that can also unsubscribe automatically and label mail in Gmail. Setup is longer; see below.


Runs inside **your own Google account** (Google Apps Script). Nothing is sent to any third-party server.

| Piece | What it does |
|---|---|
| **Gmail sidebar add-on** | Today's plan inside Gmail: counts, top 5 emails to answer, one-click *Done / Snooze*. Open any email to unsubscribe from its sender. |
| **Full dashboard** (web app) | 🎯 **Focus mode** (one email at a time), 📨 Needs reply, ⚡ 2-minute quick wins, ⏳ Waiting on others (unanswered *sent* mail), 📰 bulk **Unsubscribe**, 🧾 Receipts, 🔔 Notifications. |
| **Auto-categorising** | Sorts mail into `AP/Needs Reply`, `AP/Waiting On Others`, `AP/Newsletters`, `AP/Receipts and Bills`, `AP/Notifications` Gmail labels (button: *Sync labels to Gmail*). |
| **Unsubscribe** | One-click (RFC 8058) or by email when the sender supports it; otherwise opens the unsubscribe page. Then archives the sender's inbox mail and adds a Gmail filter so stragglers skip the inbox. |
| **Habit loop** | Snooze (mail comes back at the time you chose), streak counter, optional 8 am digest email with your top 5. |

## Install (about 5 minutes)

1. Go to <https://script.google.com> → **New project**, name it *Inbox Coach*.
2. **Project Settings** → tick **Show "appsscript.json" manifest file**. Paste `src/appsscript.json` into it (set `timeZone` to yours, e.g. `Europe/Athens`).
3. Add files (➕ → Script / HTML) with the exact names and paste contents from `src/`: `Logic` (script), `Code` (script), `Cards` (script), `Dashboard` (HTML).
   *(Or use [clasp](https://github.com/google/clasp): `npm i -g @google/clasp && clasp login && clasp create --type standalone --rootDir src && clasp push`.)*
4. **Run it once**: select `apGetDashboard` → ▶ Run → approve the permissions (Gmail read/modify/send, filters, external requests, triggers). Google shows an "unverified app" screen because it is *your* script — Advanced → *Go to Inbox Coach*.
5. **Full dashboard**: Deploy → **New deployment** → *Web app* → Execute as *User accessing the web app*, access *Only myself* → open the URL (bookmark it / pin the tab).
6. **Gmail sidebar**: Deploy → **Test deployments** → *Install* (Type: Gmail add-on). Reload Gmail; the Inbox Coach icon appears in the right-hand side panel.
7. In the dashboard click **🔔 Daily 8am digest** to enable the morning email and hourly snooze return.

## Your daily routine (the anti-procrastination part)
1. Open **Focus**. You only ever see *one* email: **Open & reply**, **Done**, **Snooze**, or **Skip**.
2. Do the ⚡ **Quick wins** tab first when you are low on energy (short messages, answerable in 2 minutes).
3. Once a week, clear the 📰 **Unsubscribe** tab: *Select all → Unsubscribe selected*.

## How categorising works
Heuristics, no AI calls (see `src/Logic.gs`): a real person's message you have not answered → **Needs reply** (ranked by urgency words, a question, age, unread). `List-Unsubscribe` header / Gmail Promotions → **Newsletters**. "receipt/invoice/order/bill…" from automated senders → **Receipts**. `noreply@`, notifications, social → **Notifications**. You replied last → **Waiting on others**.

## Limits & notes
* Scans the latest 120 inbox threads (60 days) + 50 sent threads per refresh (cached 5 min) to stay inside Apps Script's 6-minute runtime limit. Tune `SCAN_LIMIT` / `SCAN_DAYS` in `Code.gs`.
* Gmail's *Snooze*/Inbox categories are not exposed to scripts, so snoozing is implemented with an `AP/Snoozed` label + hourly trigger.
* Unsubscribing by email sends a message *from you*; one-click unsubscribe POSTs to the sender's own URL taken from its header (never from the browser).
* Free Gmail has daily Apps Script quotas (e.g. ~100 emails sent/day, URL fetch 20k/day) – plenty for this use.

## Develop
`node test/logic.test.js` runs the pure-logic tests. Open `src/Dashboard.html` directly in a browser to preview the UI with demo data.
