/**
 * Tests.gs — plain functions you can run from the Apps Script editor.
 * Each logs PASS/FAIL lines in the Execution log.
 */

/** Checks that the Script Properties needed so far are set (values hidden). */
function testConfig() {
  const required = [PROP.BOT_TOKEN, PROP.GEMINI_KEY, PROP.WEB_APP_URL];
  required.forEach(function (name) {
    console.log((getProp_(name) !== null ? 'PASS' : 'FAIL') + ': ' + name + ' is set');
  });
  console.log((getProp_(PROP.WEBHOOK_KEY) !== null ? 'PASS' : 'FAIL') +
    ': WEBHOOK_KEY is set (created automatically by setWebhook)');
  const ids = getAllowedChatIds_();
  console.log((ids.length > 0 ? 'PASS' : 'FAIL') + ': ALLOWED_CHAT_IDS has ' + ids.length + ' chat ID(s)');
}

/** Checks the duplicate-update check: first time new, second time duplicate. */
function testDedupe() {
  const id = 'test_' + Date.now();
  const first = isDuplicateUpdate_(id);
  const second = isDuplicateUpdate_(id);
  console.log((first === false ? 'PASS' : 'FAIL') + ': first sighting is not a duplicate');
  console.log((second === true ? 'PASS' : 'FAIL') + ': second sighting is a duplicate');
}

/** Checks the allow-list logic, without Telegram. */
function testAllowList() {
  const saved = getProp_(PROP.ALLOWED_CHAT_IDS);
  const props = PropertiesService.getScriptProperties();
  try {
    props.setProperty(PROP.ALLOWED_CHAT_IDS, ' 111 , 222 ');
    console.log((isAllowedChat_(111) ? 'PASS' : 'FAIL') + ': 111 is allowed');
    console.log((isAllowedChat_('222') ? 'PASS' : 'FAIL') + ': 222 is allowed');
    console.log((!isAllowedChat_(333) ? 'PASS' : 'FAIL') + ': 333 is blocked');
  } finally {
    if (saved === null) props.deleteProperty(PROP.ALLOWED_CHAT_IDS);
    else props.setProperty(PROP.ALLOWED_CHAT_IDS, saved);
  }
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
