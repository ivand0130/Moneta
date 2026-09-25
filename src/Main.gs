/**
 * Main.gs — doPost webhook entry, update routing, dedupe, error wrapper.
 *
 * Flow for every Telegram update:
 *   1. Check the secret ?key= in the URL (ignore anything without it)
 *   2. Skip update_ids we have already processed (Telegram may resend)
 *   3. Check the sender is in the allow-list (strangers are ignored silently)
 *   4. Route to a handler
 * We always answer Telegram with 200 OK, even on errors, so it does not keep
 * resending the same update.
 */

function doPost(e) {
  let chatId = null;
  try {
    if (!isValidWebhookKey_(e)) {
      recordEvent_('rejected: missing or wrong webhook key');
      return ok_();
    }

    const update = JSON.parse(e.postData.contents);
    if (isDuplicateUpdate_(update.update_id)) {
      recordEvent_('skipped duplicate update_id ' + update.update_id);
      return ok_();
    }

    chatId = getChatId_(update);
    if (chatId === null) {
      recordEvent_('ignored: update has no chat');
      return ok_();
    }

    const from = getFrom_(update) || {};
    const who = [from.first_name, from.last_name].filter(Boolean).join(' ') +
      (from.username ? ' @' + from.username : '');

    if (!isAllowedChat_(chatId)) {
      recordEvent_('BLOCKED chat ID ' + chatId + ' (' + who + ')');
      return ok_();
    }

    routeUpdate_(update);
    recordEvent_('handled chat ID ' + chatId + ' (' + who + ')');
  } catch (err) {
    logError_('doPost', err);
    recordEvent_('ERROR: ' + (err && err.message ? err.message : String(err)));
    if (chatId !== null && isAllowedChat_(chatId)) {
      try {
        sendMessage(chatId, 'Sorry, something went wrong. Please try again.');
      } catch (sendErr) {
        logError_('doPost/notifyUser', sendErr);
      }
    }
  }
  return ok_();
}

/**
 * 200 OK response for Telegram. Uses HtmlService on purpose: ContentService
 * answers with a 302 redirect, which Telegram treats as a failed delivery and
 * keeps retrying, blocking every newer message behind it.
 */
function ok_() {
  return HtmlService.createHtmlOutput('OK');
}

/** True if the request URL carries the correct ?key= secret. */
function isValidWebhookKey_(e) {
  const expected = getProp_(PROP.WEBHOOK_KEY);
  if (expected === null) return false; // Not set up yet: accept nothing.
  const given = e && e.parameter ? e.parameter.key : null;
  return given === expected;
}

/**
 * Returns true if this update_id was already seen; otherwise remembers it
 * and returns false. The lock makes check-and-save atomic when both users
 * (or a Telegram retry) arrive at the same moment.
 */
function isDuplicateUpdate_(updateId) {
  if (updateId === undefined || updateId === null) return false;
  const key = 'upd_' + updateId;
  return withScriptLock_(function () {
    const cache = CacheService.getScriptCache();
    if (cache.get(key) !== null) return true;
    cache.put(key, '1', DEDUPE_TTL_SECONDS);
    return false;
  });
}

/**
 * Runs fn while holding the script-wide lock, and always releases it.
 * Later phases use this around every write (IDs, balances).
 */
function withScriptLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS); // Throws if the lock can't be taken in time.
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** Chat ID (as string) the update belongs to, or null. */
function getChatId_(update) {
  const msg = update.message || update.edited_message ||
    (update.callback_query && update.callback_query.message);
  return msg && msg.chat ? String(msg.chat.id) : null;
}

/** The Telegram user who sent the update, or null. */
function getFrom_(update) {
  if (update.message) return update.message.from;
  if (update.edited_message) return update.edited_message.from;
  if (update.callback_query) return update.callback_query.from;
  return null;
}

/** Sends an allowed update to the right handler. */
function routeUpdate_(update) {
  if (update.message && typeof update.message.text === 'string') {
    handleText_(update.message);
    return;
  }
  // Callback buttons, photos, etc. are handled in later phases.
  console.log('Ignored update type: ' + Object.keys(update).join(', '));
}

/** Handles a text message from an allowed user. */
function handleText_(message) {
  const chatId = String(message.chat.id);
  const text = message.text.trim();

  if (text.charAt(0) === '/') {
    // "/help@MyBot extra words" → "/help"
    const command = text.split(/\s+/)[0].split('@')[0].toLowerCase();
    switch (command) {
      case '/start':
        sendMessage(chatId, buildStartText_(message.from));
        return;
      case '/help':
        sendMessage(chatId, buildHelpText_());
        return;
      default:
        sendMessage(chatId, 'Unknown command. Type /help to see what I can do.');
        return;
    }
  }

  // Transaction logging arrives in Phase 2.
  sendMessage(chatId, "I'm still being built. For now I only understand /start and /help.");
}

function buildStartText_(from) {
  const name = from && from.first_name ? from.first_name : 'there';
  return 'Hi ' + name + '! 👋\n\n' +
    "I'm your money tracker bot. I'm set up and listening.\n" +
    'Type /help to see what I can do.';
}

function buildHelpText_() {
  // Placeholder: the full guide with examples comes in Phase 2.
  return 'Help (work in progress)\n\n' +
    '/start - check the bot is running\n' +
    '/help - show this message\n\n' +
    'Logging income, expenses and transfers is coming soon.';
}

/**
 * Remembers the last few webhook outcomes in a Script Property, because
 * Apps Script often hides console logs of web-app runs made by Telegram.
 * View them by running showRecentUpdates() from the editor. Never throws.
 */
function recordEvent_(text) {
  const line = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss') + '  ' + text;
  console.log(line);
  try {
    withScriptLock_(function () {
      const props = PropertiesService.getScriptProperties();
      let events = [];
      try { events = JSON.parse(props.getProperty(PROP.RECENT_UPDATES) || '[]'); } catch (e) {}
      events.push(line.substring(0, 300));
      props.setProperty(PROP.RECENT_UPDATES, JSON.stringify(events.slice(-RECENT_UPDATES_MAX)));
    });
  } catch (err) {
    console.error('[recordEvent_] ' + err.message);
  }
}

/** Run from the editor: shows what happened to the last few messages. */
function showRecentUpdates() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP.RECENT_UPDATES);
  const events = raw ? JSON.parse(raw) : [];
  if (events.length === 0) {
    console.log('No messages received yet. Check the webhook with getWebhookInfo.');
    return;
  }
  console.log('Last ' + events.length + ' messages (oldest first):\n' + events.join('\n'));
}

/**
 * Logs an error to the execution log, and to the Logs tab once the main
 * sheet exists (Phase 1). Never throws.
 */
function logError_(source, err, details) {
  const message = err && err.message ? err.message : String(err);
  console.error('[' + source + '] ' + message + (err && err.stack ? '\n' + err.stack : ''));
  try {
    writeLogRow_('ERROR', source, message, details);
  } catch (logErr) {
    console.error('[logError_] Could not write to Logs tab: ' + logErr.message);
  }
}
