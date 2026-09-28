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
  if (update.callback_query) {
    handleCallback_(update.callback_query);
    return;
  }
  if (update.message && typeof update.message.text === 'string') {
    handleText_(update.message);
    return;
  }
  if (update.message) {
    sendMessage(String(update.message.chat.id),
      'I can only read text for now. (GoPay Split Bill screenshots arrive in a later update.)');
    return;
  }
  console.log('Ignored update type: ' + Object.keys(update).join(', '));
}

/** Handles a text message from an allowed user. */
function handleText_(message) {
  const chatId = String(message.chat.id);
  const text = message.text.trim();

  // An open password prompt comes first, so a password is never parsed as
  // a transaction. A command cancels the prompt instead.
  const pw = getPasswordState_(chatId);
  if (pw && text.charAt(0) !== '/') {
    handlePasswordInput_(message, pw);
    return;
  }
  if (pw) clearPasswordState_(chatId);

  if (text.charAt(0) === '/') {
    // "/saldo@MyBot spending" → command "/saldo", args "spending"
    const firstSpace = text.search(/\s/);
    const command = (firstSpace === -1 ? text : text.slice(0, firstSpace)).split('@')[0].toLowerCase();
    const args = firstSpace === -1 ? '' : text.slice(firstSpace + 1).trim();
    const sub = args.split(/\s+/)[0].toLowerCase();
    const user = getUserByChatId_(chatId);
    switch (command) {
      case '/start':
        sendMessage(chatId, buildStartText_(message.from));
        return;
      case '/help':
        sendMessage(chatId, buildHelpText_());
        return;
      case '/saldo':
        startSaldo_(chatId, args);
        return;
      case '/adjust':
        startAdjust_(chatId, args, message.message_id);
        return;
      case '/open':
        startOpen_(chatId, '', args);
        return;
      case '/piutang':
        startOpen_(chatId, 'Piutang', args);
        return;
      case '/hutang':
        startOpen_(chatId, 'Hutang', args);
        return;
      case '/contact':
      case '/contacts':
        if (sub === 'add') startContactAdd_(chatId, args.slice(3).trim());
        else sendMessage(chatId, buildContactListText_(loadContacts_(openMainSheet_())));
        return;
      case '/budget':
        startBudget_(chatId, args);
        return;
      case '/changepass':
        startChangePassword_(chatId);
        return;
      case '/undo':
        startUndo_(chatId, user);
        return;
      case '/wallet':
        if (sub === 'add') startWalletAdd_(chatId, args.slice(3).trim());
        else sendMessage(chatId, buildWalletListText_(loadWallets_(openMainSheet_())));
        return;
      case '/category':
      case '/cat':
        if (sub === 'add') startCategoryAdd_(chatId, args.slice(3).trim());
        else sendMessage(chatId, buildCategoryListText_(loadCategories_(openMainSheet_())));
        return;
      case '/cancel': {
        const p = getPending_(chatId);
        if (p) dropButtons_(chatId, p.msgId);
        clearPending_(chatId);
        sendMessage(chatId, 'OK, cancelled.');
        return;
      }
      default:
        sendMessage(chatId, 'Unknown command. Type /help to see what I can do.');
        return;
    }
  }

  const p = getPending_(chatId);
  if (p && p.kind === 'trx' && p.awaitText) {
    handlePendingText_(p, message);
    return;
  }
  if (p && p.kind === 'debt' && p.awaitText) {
    handleDebtText_(p, message);
    return;
  }
  startTransaction_(message);
}

function buildStartText_(from) {
  const name = from && from.first_name ? from.first_name : 'there';
  return 'Hi ' + escapeHtml_(name) + '! 👋\n\n' +
    "I'm your money tracker bot. Just type what you spent or received, e.g. " +
    '<code>50rb makan siang BCA</code>.\nType /help to see everything I can do.';
}

function buildHelpText_() {
  return [
    '📘 <b>How to log</b>',
    '• <code>50rb makan siang di KFC</code> → expense',
    '• <code>+5jt gaji BCA</code> or <code>gaji 5jt BCA</code> → income',
    '• <code>transfer 1jt BCA ke GoPay</code> → transfer between your wallets',
    '• <code>transfer 1jt BCA ke GoPay admin 2.5rb</code> → transfer + fee (taken out of the 1jt)',
    '• <code>transfer 1jt BCA ke GoPay sampai 997.500</code> → I ask what the difference was',
    '• <code>transfer 1jt BCA ke IPOT, 200rb untuk makan</code> → transfer, then 200rb spent from IPOT',
    '• <code>25rb parkir kemarin</code> (or kmrn), <code>… tgl 10</code>, <code>… 20/09</code>, <code>… 5 okt</code> → another date',
    '• <code>30rb obat #health</code> → choose the category yourself',
    '',
    '🤝 <b>Hutang / piutang</b>',
    '• <code>piutang 500rb Budi</code> (you lend) · <code>pinjam 1jt dari Andi</code> (you borrow)',
    '• <code>… jatuh tempo 30/10</code> · <code>piutang jangka panjang 10jt Budi</code>',
    '• <code>piutang 600rb Budi, Andi, Citra</code> (group) · <code>split makan. budi 100k, andi 100k, aku 200k</code>',
    '• <code>split 400rb makan Budi Andi termasuk saya</code> (commas or capital letters mark names)',
    '• <code>Budi bayar 200rb</code> (nearest due date first) · <code>bayar hutang Andi 500rb</code> · <code>Budi lunas</code>',
    '• <code>tambah piutang Budi 100rb</code> · <code>tutup piutang PTG-001</code> (turn it into an expense)',
    '',
    'Amounts: 50000 · 50.000 · 50k · 50rb · 1.5jt · 2juta',
    'Wallet: write its name anywhere (BCA, GoPay…). No wallet? I use the category\'s default or ask.',
    'Nothing is saved until you tap ✅ Yes on the preview. ✏️ Edit changes any part.',
    '',
    '📋 <b>Commands</b>',
    '/saldo — balances (password), without investments. <code>/saldo all</code> includes them',
    '/adjust — fix a wallet balance: <code>/adjust BCA 10.200.000</code>',
    '   One wallet, group or owner: <code>/saldo bca</code>, <code>/saldo spending</code>, <code>/saldo me</code>',
    '/budget — budgets this month (spent, remaining) · <code>/budget food</code>',
    '/undo — delete your last entry',
    '/open — open hutang / piutang · <code>/piutang</code> · <code>/hutang</code> · <code>/piutang budi</code>',
    '/contact — contacts and aliases · <code>/contact add Budi, Budi Santoso</code>',
    '/wallet — list wallets · <code>/wallet add Jenius</code>',
    '/category or /cat — list categories · <code>/cat add Pets</code>',
    '/changepass — change the /saldo password (default 0000)',
    '/cancel — stop what you\'re doing',
    '/help — this guide'
  ].join('\n');
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
