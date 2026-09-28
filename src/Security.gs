/**
 * Security.gs — the /saldo password, /changepass, deleting password
 * messages, wrong-password lockout.
 *
 * One password for both users, kept in the Settings tab ("Password" row,
 * numbers only) so you can reset it in the sheet if you forget it. It is
 * read fresh from the sheet every time (never from the cache). Default 0000;
 * /saldo reminds you to change it. Every message containing a password is
 * deleted right after it's read.
 */

const DEFAULT_PASSWORD = '0000';
const PASSWORD_STATE_TTL_SECONDS = 300;
const MAX_PASSWORD_FAILS = 5;
const PASSWORD_LOCK_SECONDS = 900;

/** Used only to compare the two /changepass entries without keeping the new password in the cache. */
function hashPassword_(password, salt) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + password,
    Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes);
}

function isDigitsOnly_(text) {
  return /^\d+$/.test(String(text));
}

/**
 * The current password, read fresh from Settings (this also refreshes the
 * cached settings, so /saldo uses the latest delay and Hide amounts).
 * Returns { value } or { error } if the cell isn't numbers only.
 */
function readSheetPassword_() {
  const tab = loadSettingsTab_(true);
  const raw = tab ? tab.settings[SETTING.PASSWORD.toLowerCase()] : undefined;
  const value = raw === undefined || raw === '' ? DEFAULT_PASSWORD : String(raw).trim();
  if (!isDigitsOnly_(value)) {
    return { error: '⚠️ The Password in the Settings tab must be numbers only. Please fix it in the sheet.' };
  }
  return { value: value };
}

/** Writes a new password into Settings (adds the row if it's missing). */
function writeSheetPassword_(password) {
  const ss = openMainSheet_();
  if (!setSettingValue_(ss, SETTING.PASSWORD, password)) {
    const sheet = ss.getSheetByName(TAB.SETTINGS);
    const row = SETTING_ROWS.filter(function (r) { return r[0] === SETTING.PASSWORD; })[0];
    writeRowsByHeaders_(sheet, lastDataRow_(sheet, 'Setting') + 1,
      [{ 'Setting': SETTING.PASSWORD, 'Value': password, 'Notes': row[2] }]);
  }
}

function newSalt_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

// --- Prompt state: "the next message from this chat is a password" -------

function getPasswordState_(chatId) {
  const v = CacheService.getScriptCache().get('pw_' + chatId);
  return v === null ? null : JSON.parse(v);
}

function setPasswordState_(chatId, state) {
  CacheService.getScriptCache().put('pw_' + chatId, JSON.stringify(state), PASSWORD_STATE_TTL_SECONDS);
}

function clearPasswordState_(chatId) {
  CacheService.getScriptCache().remove('pw_' + chatId);
}

// --- Lockout after too many wrong passwords ------------------------------

function isPasswordLocked_(chatId) {
  return Number(CacheService.getScriptCache().get('pwfail_' + chatId) || 0) >= MAX_PASSWORD_FAILS;
}

function recordPasswordFail_(chatId) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('pwfail_' + chatId) || 0) + 1;
  cache.put('pwfail_' + chatId, String(fails), PASSWORD_LOCK_SECONDS);
  return fails;
}

function resetPasswordFails_(chatId) {
  CacheService.getScriptCache().remove('pwfail_' + chatId);
}

/** Sends a password prompt and remembers what the password is for. */
function askPassword_(chatId, purpose, extra, promptText) {
  if (isPasswordLocked_(chatId)) {
    sendMessage(chatId, '🔒 Too many wrong passwords. Try again in 15 minutes.');
    return;
  }
  const prompt = sendMessage(chatId, promptText +
    '\n<i>(Numbers only. Your message will be deleted right away. /cancel to stop.)</i>');
  setPasswordState_(chatId, Object.assign({ purpose: purpose, promptId: prompt.message_id }, extra || {}));
}

/** /saldo [wallet, group, owner or "all"] */
function startSaldo_(chatId, filter) {
  loadSettingsTab_(true); // fresh, so turning the password on/off in Settings applies right away
  if (!getSettingYes_(SETTING.SALDO_PASSWORD)) {
    showSaldo_(chatId, filter, false);
    return;
  }
  askPassword_(chatId, 'saldo', { filter: filter }, '🔒 Enter the password to see balances.\n' +
    '<i>You can turn this off in Settings → Password for /saldo.</i>');
}

/** /changepass */
function startChangePassword_(chatId) {
  askPassword_(chatId, 'cp_old', {}, '🔑 Enter your <b>current</b> password.');
}

/**
 * Handles a message sent while a password prompt is open. The message and
 * the prompt are deleted first, whatever happens next. Wrong or invalid
 * input asks again (until the lockout), so a retry is never read as a
 * transaction.
 */
function handlePasswordInput_(message, state) {
  const chatId = String(message.chat.id);
  const text = String(message.text || '').trim();
  deleteMessage(chatId, message.message_id);
  if (state.promptId) deleteMessage(chatId, state.promptId);
  clearPasswordState_(chatId);
  const extra = { filter: state.filter, salt: state.salt, hash: state.hash };

  if (state.purpose === 'saldo' || state.purpose === 'cp_old') {
    const current = readSheetPassword_();
    if (current.error) {
      sendMessage(chatId, current.error);
      return;
    }
    if (text !== current.value) {
      const fails = recordPasswordFail_(chatId);
      if (fails >= MAX_PASSWORD_FAILS) {
        sendMessage(chatId, '❌ Wrong password. Locked for 15 minutes.');
        return;
      }
      const why = isDigitsOnly_(text) ? 'Wrong password' : 'The password is numbers only';
      askPassword_(chatId, state.purpose, extra,
        '❌ ' + why + ' (' + (MAX_PASSWORD_FAILS - fails) + ' tries left). Try again:');
      return;
    }
    resetPasswordFails_(chatId);
    if (state.purpose === 'saldo') {
      showSaldo_(chatId, state.filter, current.value === DEFAULT_PASSWORD);
    } else {
      askPassword_(chatId, 'cp_new', {}, '🔑 Send the <b>new</b> password (numbers only, at least 4 digits).');
    }
    return;
  }

  if (state.purpose === 'cp_new') {
    if (!isDigitsOnly_(text) || text.length < 4 || text === DEFAULT_PASSWORD) {
      askPassword_(chatId, 'cp_new', {},
        '❌ The new password must be numbers only, at least 4 digits, and not 0000. Try again:');
      return;
    }
    const salt = newSalt_();
    askPassword_(chatId, 'cp_confirm', { salt: salt, hash: hashPassword_(text, salt) },
      '🔑 Send the new password <b>again</b> to confirm.');
    return;
  }

  if (state.purpose === 'cp_confirm') {
    if (hashPassword_(text, state.salt) !== state.hash) {
      askPassword_(chatId, 'cp_new', {}, "❌ The passwords didn't match. Send the <b>new</b> password again:");
      return;
    }
    writeSheetPassword_(text);
    sendMessage(chatId, '✅ Password changed (it is also in Settings → Password). Use it for /saldo from now on, ' +
      'for both of you.');
  }
}

/** Sends the /saldo reply (spoilers + auto-delete). Settings were just read fresh. */
function showSaldo_(chatId, filter, isDefaultPassword) {
  const ss = openMainSheet_();
  const result = buildSaldoText_(loadWallets_(ss), filter, getSettingList_(SETTING.INVESTMENT_GROUPS));
  if (result.error) {
    sendMessage(chatId, result.error);
    return;
  }
  let text = result.text;
  if (isDefaultPassword) {
    text += '\n\n⚠️ You are still using the default password <b>0000</b>. Change it with /changepass.';
  }
  const delay = SALDO_DELETE_SECONDS;
  const triggerMissing = delay > 0 && !ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'cleanupMessages';
  });
  if (delay > 0 && !triggerMissing) text += '\n\n🕒 This message will be deleted in ' + formatDelay_(delay) + '.';
  if (triggerMissing) text += '\n\n⚠️ Auto-delete is not set up yet (run installCleanupTrigger in the editor).';

  const sent = sendMessage(chatId, text);
  if (delay > 0 && !triggerMissing) scheduleDelete_(chatId, sent.message_id, delay);
}

/** 60 → "60s", 300 → "5 min", 7200 → "2 h" */
function formatDelay_(seconds) {
  if (seconds < 120) return seconds + 's';
  if (seconds < 7200) return Math.round(seconds / 60) + ' min';
  return Math.round(seconds / 3600) + ' h';
}
