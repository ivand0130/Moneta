/**
 * Tests.gs — plain functions you can run from the Apps Script editor.
 * Each logs PASS/FAIL lines in the Execution log.
 */

/** Checks that the Script Properties needed so far are set (values hidden). */
function testConfig() {
  const required = [PROP.BOT_TOKEN, PROP.GEMINI_KEY, PROP.WEB_APP_URL, PROP.MAIN_SHEET_ID, PROP.TEMPLATE_ID];
  required.forEach(function (name) {
    console.log((getProp_(name) !== null ? 'PASS' : 'FAIL') + ': ' + name + ' is set');
  });
  console.log((getProp_(PROP.WEBHOOK_KEY) !== null ? 'PASS' : 'FAIL') +
    ': WEBHOOK_KEY is set (created automatically by setWebhook)');
  const ids = getAllowedChatIds_();
  console.log((ids.length > 0 ? 'PASS' : 'FAIL') + ': ' + ids.length + ' allowed chat ID(s)');
}

/** Checks the duplicate-update check: first time new, second time duplicate. */
function testDedupe() {
  const id = 'test_' + Date.now();
  const first = isDuplicateUpdate_(id);
  const second = isDuplicateUpdate_(id);
  console.log((first === false ? 'PASS' : 'FAIL') + ': first sighting is not a duplicate');
  console.log((second === true ? 'PASS' : 'FAIL') + ': second sighting is a duplicate');
}

/** Checks the allow-list: fallback parser, then the live Users table. */
function testAllowList() {
  const parsed = parseChatIdList_(' 111 , 222 ,');
  console.log((parsed.join('|') === '111|222' ? 'PASS' : 'FAIL') + ': fallback list parses to 111, 222');

  clearConfigCache();
  const users = getUsers_();
  if (users === null) {
    console.log('INFO: no main sheet yet, so the bot uses ALLOWED_CHAT_IDS.');
    return;
  }
  const active = users.filter(function (u) { return u.active; });
  console.log((active.length > 0 ? 'PASS' : 'FAIL') + ': Users table has ' + active.length + ' active user(s): ' +
    active.map(function (u) { return u.name + ' (' + u.chatId + ')'; }).join(', '));
  active.forEach(function (u) {
    console.log((isAllowedChat_(u.chatId) ? 'PASS' : 'FAIL') + ': ' + u.name + ' is allowed');
  });
  users.filter(function (u) { return !u.active; }).forEach(function (u) {
    console.log((!isAllowedChat_(u.chatId) ? 'PASS' : 'FAIL') + ': ' + u.name + ' (Active = No) is blocked');
  });
  console.log((!isAllowedChat_('1') ? 'PASS' : 'FAIL') + ': unknown chat ID 1 is blocked');
}

/**
 * Checks the main sheet: all tabs/columns exist, the formulas calculate
 * (no errors), the Settings loader works, and writing to Logs works.
 */
function testSheet() {
  const result = validateSheet();
  console.log((result.ok ? 'PASS' : 'FAIL') + ': validateSheet');

  const ss = openMainSheet_();
  const wallets = readTableByHeaders_(ss.getSheetByName(TAB.WALLETS), 'Wallet');
  const bad = wallets.filter(function (w) { return typeof w['current balance'] !== 'number'; });
  console.log((wallets.length > 0 && bad.length === 0 ? 'PASS' : 'FAIL') + ': ' + wallets.length +
    ' wallets, every Current Balance is a number' +
    (bad.length ? ' (bad: ' + bad.map(function (w) { return w['wallet'] + '=' + w['current balance']; }).join(', ') + ')' : ''));

  const settings = getSettings_();
  console.log((settings['large amount threshold'] === '5000000' ? 'PASS' : 'FAIL') +
    ': Settings loader reads Large Amount Threshold = ' + settings['large amount threshold']);

  const owners = readTableByHeaders_(ss.getSheetByName(TAB.SETTINGS), 'Owners')
    .map(function (row) { return row['owners']; });
  console.log((owners.indexOf('Shared') !== -1 ? 'PASS' : 'FAIL') + ': Owners dropdown list = ' + owners.join(', '));

  const logs = ss.getSheetByName(TAB.LOGS);
  const before = lastDataRow_(logs);
  writeLogRow_('INFO', 'testSheet', 'Test log row, safe to delete');
  console.log((lastDataRow_(logs) === before + 1 ? 'PASS' : 'FAIL') + ': wrote a test row to the Logs tab');
}

/**
 * Feeds a fake "/start" from the first allowed chat ID straight into doPost,
 * bypassing Telegram and the deployment. You should get the /start reply.
 */
function testDoPost() {
  const ids = getAllowedChatIds_();
  if (ids.length === 0) {
    console.log('FAIL: ALLOWED_CHAT_IDS is empty.');
    return;
  }
  if (getProp_(PROP.WEBHOOK_KEY) === null) {
    console.log('FAIL: WEBHOOK_KEY is not set. Run setWebhook first.');
    return;
  }
  const update = {
    update_id: 'test_' + Date.now(),
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(ids[0]), type: 'private' },
      from: { id: Number(ids[0]), first_name: 'Test' },
      text: '/start'
    }
  };
  doPost({ parameter: { key: getProp_(PROP.WEBHOOK_KEY) }, postData: { contents: JSON.stringify(update) } });
  showRecentUpdates();
  console.log('If the last line says "handled", check Telegram for the reply.');
}

/** Sends a test message to every allowed chat ID (checks the bot token). */
function testSendHello() {
  const ids = getAllowedChatIds_();
  if (ids.length === 0) {
    console.log('FAIL: ALLOWED_CHAT_IDS is empty, nobody to send to.');
    return;
  }
  ids.forEach(function (id) {
    try {
      sendMessage(id, 'Test message from the Apps Script editor ✅');
      console.log('PASS: sent to ' + id);
    } catch (err) {
      console.log('FAIL: ' + id + ' — ' + err.message);
    }
  });
}
