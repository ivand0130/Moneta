/**
 * Telegram.gs — Telegram Bot API calls, message formatting (HTML, Rp,
 * spoilers), the auto-delete queue, and setup helpers you run from the
 * Apps Script editor (setWebhook, getWebhookInfo, deleteWebhook,
 * installCleanupTrigger).
 *
 * All messages use parse_mode HTML. Anything that comes from the user or
 * the sheet (notes, names) must go through escapeHtml_ before sending.
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

/** Sends an HTML message. options can add e.g. reply_markup. Returns the Message. */
function sendMessage(chatId, text, options) {
  const payload = Object.assign({
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  }, options || {});
  return tgCall_('sendMessage', payload);
}

/**
 * Replaces a message's text (and buttons: pass reply_markup, or omit to
 * remove them). "Message is not modified" is not treated as an error.
 */
function editMessage(chatId, messageId, text, options) {
  const payload = Object.assign({
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  }, options || {});
  try {
    return tgCall_('editMessageText', payload);
  } catch (err) {
    if (/message is not modified/i.test(err.message)) return null;
    throw err;
  }
}

/** Deletes a message. Returns true on success, false if Telegram refused. */
function deleteMessage(chatId, messageId) {
  try {
    tgCall_('deleteMessage', { chat_id: chatId, message_id: messageId });
    return true;
  } catch (err) {
    console.warn('deleteMessage ' + chatId + '/' + messageId + ': ' + err.message);
    return false;
  }
}

/** Stops the loading spinner on a tapped button. Never throws. */
function answerCallbackQuery(callbackQueryId, text) {
  try {
    tgCall_('answerCallbackQuery', { callback_query_id: callbackQueryId, text: text || '' });
  } catch (err) {
    console.warn('answerCallbackQuery: ' + err.message);
  }
}

/** Shows "typing…" in the chat (e.g. while waiting for Gemini). Never throws. */
function sendTyping_(chatId) {
  try {
    tgCall_('sendChatAction', { chat_id: chatId, action: 'typing' });
  } catch (err) {
    console.warn('sendChatAction: ' + err.message);
  }
}

/**
 * Builds reply_markup from rows of [label, callbackData] pairs:
 *   keyboard_([[['✅ Yes', 'p1|y'], ['❌ No', 'p1|n']]])
 */
function keyboard_(rows) {
  return {
    inline_keyboard: rows.map(function (row) {
      return row.map(function (b) { return { text: b[0], callback_data: b[1] }; });
    })
  };
}

/** Splits buttons into rows of `perRow`. */
function chunk_(buttons, perRow) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += perRow) rows.push(buttons.slice(i, i + perRow));
  return rows;
}

/** Downloads a file (photo) sent to the bot. OCR phase. */
function getFile(fileId) {
  throw new Error('getFile is not implemented yet (OCR phase).');
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Makes user/sheet text safe inside an HTML message. */
function escapeHtml_(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 1250000 → "Rp1.250.000", -50000 → "−Rp50.000" */
function formatRp_(amount) {
  const n = Math.round(Number(amount) || 0);
  const digits = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (n < 0 ? '−' : '') + 'Rp' + digits;
}

/** "+Rp1.000.000" / "−Rp50.000" for balance changes. */
function formatRpSigned_(amount) {
  return (Number(amount) > 0 ? '+' : '') + formatRp_(amount);
}

/**
 * THE spoiler helper: wraps already-escaped HTML in <tg-spoiler> when the
 * "Hide amounts" setting is Yes. Pass hide to override (used by tests).
 * Used for amounts in /saldo, /inv, /open and /report — not in previews.
 */
function spoiler_(html, hide) {
  const on = hide === undefined ? getSettingYes_(SETTING.HIDE_AMOUNTS) : hide;
  return on ? '<tg-spoiler>' + html + '</tg-spoiler>' : html;
}

/** An Rp amount through the spoiler helper. */
function money_(amount, hide) {
  return spoiler_(formatRp_(amount), hide);
}

/** Date → "24 Sep 2026" in Asia/Jakarta. */
function formatDate_(date) {
  return Utilities.formatDate(new Date(date), Session.getScriptTimeZone(), 'd MMM yyyy');
}

// ---------------------------------------------------------------------------
// Auto-delete queue (used by /saldo)
// ---------------------------------------------------------------------------
// The queue lives in CacheService (fast) with a Script Properties backup
// (survives cache eviction). cleanupMessages() runs every minute from a
// time trigger and returns immediately when the queue is empty.

const DELETE_QUEUE_CACHE_KEY = 'delete_queue';
const MAX_DELETE_DELAY_SECONDS = 169200; // 47h: Telegram allows deleting for 48h

function readDeleteQueue_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(DELETE_QUEUE_CACHE_KEY);
  if (hit !== null) return JSON.parse(hit);
  const saved = getProp_(PROP.DELETE_QUEUE);
  const queue = saved ? JSON.parse(saved) : [];
  cache.put(DELETE_QUEUE_CACHE_KEY, JSON.stringify(queue), 21600);
  return queue;
}

function writeDeleteQueue_(queue) {
  const json = JSON.stringify(queue);
  PropertiesService.getScriptProperties().setProperty(PROP.DELETE_QUEUE, json);
  CacheService.getScriptCache().put(DELETE_QUEUE_CACHE_KEY, json, 21600);
}

/** Queues a message to be deleted after `seconds` (capped at 47 hours). */
function scheduleDelete_(chatId, messageId, seconds) {
  const delay = Math.min(Math.max(0, Number(seconds) || 0), MAX_DELETE_DELAY_SECONDS);
  withScriptLock_(function () {
    const queue = readDeleteQueue_();
    queue.push({ c: String(chatId), m: messageId, at: Date.now() + delay * 1000 });
    writeDeleteQueue_(queue);
  });
}

/**
 * Time trigger handler (every minute). Exits right away when the queue is
 * empty, to save trigger quota. Messages due before the next run (within
 * 60s) are taken off the queue, and the run waits until each one's exact
 * time before deleting it, so a 60s delete happens at ~60s, not up to 2 min.
 */
function cleanupMessages() {
  if (CacheService.getScriptCache().get(DELETE_QUEUE_CACHE_KEY) === '[]') return;

  let due = [];
  withScriptLock_(function () {
    const queue = readDeleteQueue_();
    if (queue.length === 0) return;
    const horizon = Date.now() + 60000;
    due = queue.filter(function (item) { return item.at <= horizon; });
    if (due.length > 0) {
      writeDeleteQueue_(queue.filter(function (item) { return item.at > horizon; }));
    }
  });

  due.sort(function (a, b) { return a.at - b.at; }).forEach(function (item) {
    const wait = item.at - Date.now();
    if (wait > 0) Utilities.sleep(Math.min(wait, 60000));
    if (!deleteMessage(item.c, item.m)) {
      // Already deleted by hand, or older than 48h: log and move on.
      try {
        writeLogRow_('WARN', 'cleanupMessages', 'Could not delete message ' + item.m + ' in chat ' + item.c);
      } catch (err) {
        console.warn('cleanupMessages log: ' + err.message);
      }
    }
  });
}

/**
 * Run once from the editor: creates the every-minute trigger for
 * cleanupMessages (removing any old copy first, so there's never two).
 */
function installCleanupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'cleanupMessages'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('cleanupMessages').timeBased().everyMinutes(1).create();
  console.log('PASS: cleanup trigger installed. cleanupMessages will run every minute.');
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
}

/** Stops Telegram from sending updates to this web app. */
function deleteWebhook() {
  tgCall_('deleteWebhook', { drop_pending_updates: false });
  console.log('Webhook removed.');
}
