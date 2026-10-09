/**
 * Gmail add-on sidebar (CardService). Shown inside Gmail on the right.
 * Homepage = today's plan; opening a message shows quick actions for it.
 */

function onHomepage() { return buildHome_(getDashboardData_(false)); }

function buildHome_(data) {
  var by = function (c) { return data.items.filter(function (i) { return i.category === c; }); };
  var replies = by('reply');

  var card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Inbox Coach')
      .setSubtitle('Done today: ' + data.stats.doneToday + '  ·  Streak: ' + data.stats.streak + 'd'));

  var counts = CardService.newCardSection().setHeader('Where things stand');
  [['reply', '📨'], ['waiting', '⏳'], ['newsletter', '📰'], ['receipt', '🧾'], ['notification', '🔔']].forEach(function (p) {
    counts.addWidget(CardService.newKeyValue().setIcon(CardService.Icon.NONE)
      .setTopLabel(AP_CATEGORY_META[p[0]].title).setContent(p[1] + '  ' + by(p[0]).length));
  });
  card.addSection(counts);

  var plan = CardService.newCardSection().setHeader('Do these first');
  if (!replies.length) plan.addWidget(CardService.newTextParagraph().setText('🎉 Nothing needs a reply. Inbox zero energy!'));
  replies.slice(0, 5).forEach(function (i) {
    plan.addWidget(CardService.newDecoratedText()
      .setTopLabel(i.fromName + ' · ' + i.daysAgo + 'd' + (i.urgent ? ' · URGENT' : ''))
      .setText(i.subject).setWrapText(true)
      .setOpenLink(CardService.newOpenLink().setUrl(i.url)));
    plan.addWidget(CardService.newButtonSet()
      .addButton(actionButton_('Done', 'cardDone', { id: i.id }))
      .addButton(actionButton_('Snooze 1d', 'cardSnooze', { id: i.id, days: '1' }))
      .addButton(actionButton_('Snooze 3d', 'cardSnooze', { id: i.id, days: '3' })));
  });
  card.addSection(plan);

  var tools = CardService.newCardSection().setHeader('Tools');
  if (data.dashboardUrl) {
    tools.addWidget(CardService.newTextButton().setText('Open full dashboard (unsubscribe, focus mode)')
      .setOpenLink(CardService.newOpenLink().setUrl(data.dashboardUrl)));
  }
  tools.addWidget(CardService.newButtonSet()
    .addButton(actionButton_('Sync AP/ labels', 'cardSyncLabels', {}))
    .addButton(actionButton_('Refresh', 'cardRefresh', {})));
  card.addSection(tools);
  return card.build();
}

function actionButton_(text, fn, params) {
  return CardService.newTextButton().setText(text)
    .setOnClickAction(CardService.newAction().setFunctionName(fn).setParameters(params));
}

function respond_(text) {
  invalidateCache_();
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(text))
    .setNavigation(CardService.newNavigation().updateCard(buildHome_(getDashboardData_(true))))
    .build();
}

function cardDone(e) { apMarkDone(e.parameters.id); return respond_('Done – nice work ✅'); }
function cardSnooze(e) { apSnooze(e.parameters.id, e.parameters.days); return respond_('Snoozed for ' + e.parameters.days + ' day(s)'); }
function cardSyncLabels() { var r = apSyncLabels(); return respond_('Labelled ' + r.labelled + ' threads under AP/'); }
function cardRefresh() { return respond_('Refreshed'); }

/** Opened a message: quick actions for just this thread. */
function onMessageOpen(e) {
  GmailApp.setCurrentMessageAccessToken(e.gmail.accessToken);
  var msg = GmailApp.getMessageById(e.gmail.messageId);
  var thread = msg.getThread();
  var from = parseAddress(msg.getFrom());
  var unsub = parseListUnsubscribe(header_(msg, 'List-Unsubscribe'), header_(msg, 'List-Unsubscribe-Post'));
  var c = classifyThread({
    fromEmail: from.email, subject: msg.getSubject(), hasListUnsub: unsub.method !== 'none',
    lastFromMe: getMyEmails_().indexOf(from.email) >= 0, daysAgo: 0,
    getBody: function () { return msg.getPlainBody().slice(0, 1500); }
  });

  var section = CardService.newCardSection()
    .addWidget(CardService.newKeyValue().setTopLabel('Category').setContent(AP_CATEGORY_META[c.category].title +
      (c.urgent ? '  ·  URGENT' : '') + (c.quick ? '  ·  quick win' : '')))
    .addWidget(CardService.newButtonSet()
      .addButton(actionButton_('Done', 'msgDone', { id: thread.getId() }))
      .addButton(actionButton_('Snooze 1d', 'msgSnooze', { id: thread.getId(), days: '1' }))
      .addButton(actionButton_('Snooze 3d', 'msgSnooze', { id: thread.getId(), days: '3' })));

  if (c.category === 'newsletter' || unsub.method !== 'none') {
    section.addWidget(CardService.newTextParagraph().setText('Sender: ' + from.email + ' (' + unsub.method + ')'));
    section.addWidget(actionButton_('Unsubscribe + archive all from sender', 'msgUnsub', { email: from.email }));
  }
  return [CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Inbox Coach'))
    .addSection(section).build()];
}

function msgNote_(text) {
  invalidateCache_();
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(text)).build();
}
function msgDone(e) { apMarkDone(e.parameters.id); return msgNote_('Marked done ✅'); }
function msgSnooze(e) { apSnooze(e.parameters.id, e.parameters.days); return msgNote_('Snoozed'); }
function msgUnsub(e) {
  var r = apUnsubscribe(e.parameters.email);
  var text = { unsubscribed: 'Unsubscribed and archived ✅', muted: 'No unsubscribe link – archived and muted', manual: 'Needs a click: use the dashboard to open the unsubscribe page', failed: 'Unsubscribe request failed – try the dashboard' }[r.status];
  return msgNote_(text);
}
