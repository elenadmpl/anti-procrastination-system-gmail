# 📬 Inbox Coach – anti-procrastination system for Gmail

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
