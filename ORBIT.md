# Orbit — your free personal visual workspace

Orbit adds a Miro-style infinite canvas to Declutter, with sticky notes, tasks, frames, connectors, drawing, a people database, a journal and follow-up sprints. No subscription or AI key is required. This is an original personal board; live team collaboration and automatic cloud sync are not included.

## Open the board

On Windows, double-click **Open Orbit.cmd**. It starts a server available only on your computer and opens a Chrome app window. It finds Node.js or the runtime bundled with Codex. Alternatively run \`node preview-server.js\` and open <http://127.0.0.1:4387>. Bookmark it or install the PWA through Chrome's menu.

Do not open index.html directly: the local starter file, offline caching and local OCR need this server or an HTTPS host. Data saves in this browser's IndexedDB database. Export a private backup regularly.

## Connect Gmail

1. Open \`chrome://extensions\`, enable Developer mode, choose **Load unpacked**, and select the **extension** folder.
2. Reload Gmail. Declutter remains, with **Orbit board** and **Save thread to Orbit** added.
3. Open a conversation and click **Save thread to Orbit**.
4. Open Orbit from the extension toolbar, then **Import & connections → Import captured Gmail threads**.

Capture saves the chosen conversation's subject, visible message text and external sender details in extension storage. It is not a mailbox audit or proof that a message is unanswered. Inspect the original thread and set its next action. If Gmail changes its layout and no sender can be identified, use Quick capture.

The browser preview and extension have different databases. Export/import a backup to move your board between them. No mail is sent, archived or deleted by Orbit.

## Arrange your board

- Select, drag and resize cards; double-click to edit.
- Shift + click selects multiple cards. Delete removes cards from the board but keeps people in the database; Undo restores recent board edits.
- Sticky, Task and Frame tools add at the point you click. Connect links two cards. Draw adds a freehand sketch.
- Space + drag pans; Ctrl + scroll zooms. Fit shows the whole board; Home returns to the starting view.
- Use **New board** to create more boards.
- Edit company, role, email, LinkedIn, meeting context, next touch date, priority, next action and status in a person's details.
- **Linked task** adds a task to Today. Completing a task or first marking a person handled earns a small win. It does not indicate an email was sent.

## LinkedIn and conference capture

Import your LinkedIn Connections CSV, or paste a profile link and a ten-second note. Imports match by email, LinkedIn URL or name + company and preserve existing notes/drafts. The app does not scrape logged-in profiles or sync your LinkedIn account. Some exports omit email addresses. [LinkedIn export instructions](https://www.linkedin.com/help/linkedin/answer/a566336).

For iCloud badge photos, download the selected images and use **Badge photo**. JPG, PNG and WebP work; export HEIC as JPG first. Bundled Tesseract OCR reads English text on your device. Confirm the suggested fields before saving: names, company lines and email punctuation can be misread. For other languages, enter details manually. The photo is attached to the profile. [Apple Windows photo instructions](https://support.apple.com/en-us/108994).

LinkedIn QR scanning works when BarcodeDetector and camera access are available. Otherwise paste the profile URL. iPhone browser support is not assumed. Camera access stops when the scanner closes.

## Journal and focus

Write, edit and pin journal entries to the current board. Follow-up sprint shows one person and an editable draft, with an optional 60-second, 5-minute or 25-minute timer. Pause or skip freely; the timer never sends anything.

Gmail-review drafts can be imported. New contacts receive a local starter message using your notes, not an AI-generated answer. This version does not call Gemini or another AI service.

**Copy draft** copies text. **Open Gmail** opens the original thread or a compose window; it does not insert or send the body. **Open LinkedIn** opens the saved profile. **Mark handled** updates this board only. Fill bracketed placeholders before sending. Timers run while the app is open; closed-app/background reminders are not implemented.

## Privacy and backups

No analytics, automatic uploads or remote AI calls. The optional starter file \`extension/workspace/private-review.json\` is ignored by Git. Never publish it or your backups on a public host. Private backups include contacts, correspondence, journal and photos.

The PWA caches app/OCR assets, but not the private starter file. Your work lives in IndexedDB. A hosted copy or another device has a separate database; move data through a private backup import. Cloud sync is not implemented.

## Tests

Run the following with Node:
- \`node test/logic.test.js\`
- \`node test/workspace.test.js\`
- \`node test/board-bridge.test.js\`
- \`node test/extension.test.js\`
- \`node test/workspace.browser.test.js\`

Browser tests require Playwright/Chrome and a running preview server. PW_PATH and CHROME can specify their locations. The workspace test creates synthetic starter data if none exists; test files and screenshots remain ignored.

Tests cover persistence, editing, undo/redo, search, journal pinning, rewards, timers, CSV deduplication, real local OCR, photo attachments and backups. Existing Declutter filters and search tests also run. Live Gmail capture and camera QR still need checks after installation in the user's browser.

## Bundled software

Tesseract.js 7.0.0 and tesseract.js-core use Apache-2.0; notices are in \`extension/workspace/vendor\`. English model data comes from [naptha/tessdata](https://github.com/naptha/tessdata). No Miro source or brand assets are included.
