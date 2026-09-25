/**
 * Telegram.gs — Telegram Bot API calls, plus webhook setup helpers you run
 * from the Apps Script editor (setWebhook, getWebhookInfo, deleteWebhook).
 */

/**
 * Calls a Telegram Bot API method and returns its result.
 * Errors never include the bot token.
 */
function tgCall_(method, payload) {
  const token = requireProp_(PROP.BOT_TOKEN);
  let response;
  try {
    response = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload || {}),
      muteHttpExceptions: true
    });
  } catch (err) {
    // The raw error can contain the URL (and so the token); keep it out.
    throw new Error('Telegram ' + method + ': network error');
  }
  let body;
  try {
    body = JSON.parse(response.getContentText());
  } catch (err) {
    throw new Error('Telegram ' + method + ': bad response (HTTP ' + response.getResponseCode() + ')');
  }
  if (!body.ok) {
    throw new Error('Telegram ' + method + ' failed: ' + body.description);
  }
  return body.result;
}

/** Sends a text message. options can add e.g. reply_markup, parse_mode. */
function sendMessage(chatId, text, options) {
  const payload = Object.assign({ chat_id: chatId, text: text }, options || {});
  return tgCall_('sendMessage', payload);
}

/** Edits a message's text (e.g. after a button press). Phase 2. */
function editMessage(chatId, messageId, text, options) {
  throw new Error('editMessage is not implemented yet (Phase 2).');
}

/** Deletes a message, e.g. one containing a password. Phase 2. */
function deleteMessage(chatId, messageId) {
  throw new Error('deleteMessage is not implemented yet (Phase 2).');
}

/** Acknowledges an inline button press. Phase 2. */
function answerCallbackQuery(callbackQueryId, text) {
  throw new Error('answerCallbackQuery is not implemented yet (Phase 2).');
}

/** Builds an inline keyboard from rows of {text, data}. Phase 2. */
function buildInlineKeyboard_(rows) {
  throw new Error('buildInlineKeyboard_ is not implemented yet (Phase 2).');
}

/** Downloads a file (photo) sent to the bot. Phase 5 (OCR). */
function getFile(fileId) {
  throw new Error('getFile is not implemented yet (OCR phase).');
}

// ---------------------------------------------------------------------------
// Setup helpers — run these from the editor (select in the dropdown → Run).
// ---------------------------------------------------------------------------

/**
 * Points Telegram at this web app. Run once after the first deployment, and
 * again only if WEB_APP_URL changes. Creates WEBHOOK_KEY if it doesn't exist.
 */
function setWebhook() {
  const url = requireProp_(PROP.WEB_APP_URL);
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) {
    throw new Error('WEB_APP_URL must be the web app URL that ends with /exec.');
  }
  let key = getProp_(PROP.WEBHOOK_KEY);
  if (key === null) {
    key = Utilities.getUuid().replace(/-/g, '');
    PropertiesService.getScriptProperties().setProperty(PROP.WEBHOOK_KEY, key);
    console.log('Created a new WEBHOOK_KEY in Script Properties.');
  }
  tgCall_('setWebhook', {
    url: url + '?key=' + encodeURIComponent(key),
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true
  });
  console.log('PASS: webhook set. Now send /start to your bot in Telegram.');
}

/** Logs Telegram's view of the webhook (URL shown with the key hidden). */
function getWebhookInfo() {
  const info = tgCall_('getWebhookInfo', {});
  const key = getProp_(PROP.WEBHOOK_KEY);
  if (key !== null && info.url) info.url = info.url.split(key).join('***');
  console.log(JSON.stringify(info, null, 2));
  if (info.last_error_message && /302/.test(info.last_error_message)) {
    console.log('Note: "302" errors are normal for Apps Script (it redirects). ' +
      'Messages are still delivered.');
  }
}

/** Stops Telegram from sending updates to this web app. */
function deleteWebhook() {
  tgCall_('deleteWebhook', { drop_pending_updates: false });
  console.log('Webhook removed.');
}
