/**
 * Security.gs — password hashing, the password prompt for /saldo,
 * /changepass, deleting password messages, wrong-password lockout.
 *
 * One password for both users. Stored in Script Properties as
 * "salt:hash" (SHA-256), never in plain text. Until /changepass is used the
 * password is the default 0000, and /saldo reminds you to change it.
 */

const DEFAULT_PASSWORD = '0000';
const PASSWORD_STATE_TTL_SECONDS = 300;
const MAX_PASSWORD_FAILS = 5;
const PASSWORD_LOCK_SECONDS = 900;

function hashPassword_(password, salt) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + password,
    Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes);
}

/** True if `password` matches a stored "salt:hash" (null = default 0000). */
function passwordMatches_(password, stored) {
  if (stored === null) return password === DEFAULT_PASSWORD;
  const parts = stored.split(':');
  return hashPassword_(password, parts[0]) === parts.slice(1).join(':');
}

function isDefaultPassword_() {
  return getProp_(PROP.PASSWORD_HASH) === null;
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
  const prompt = sendMessage(chatId, promptText + '\n<i>(Your message will be deleted right away.)</i>');
  setPasswordState_(chatId, Object.assign({ purpose: purpose, promptId: prompt.message_id }, extra || {}));
}

/** /saldo [group or owner] */
function startSaldo_(chatId, filter) {
  askPassword_(chatId, 'saldo', { filter: filter }, '🔒 Enter the password to see balances.');
}

/** /changepass */
function startChangePassword_(chatId) {
  askPassword_(chatId, 'cp_old', {}, '🔑 Enter your <b>current</b> password.');
}

/**
 * Handles a message sent while a password prompt is open. The message and
 * the prompt are deleted first, whatever happens next.
 */
function handlePasswordInput_(message, state) {
  const chatId = String(message.chat.id);
  const text = String(message.text || '').trim();
  deleteMessage(chatId, message.message_id);
  if (state.promptId) deleteMessage(chatId, state.promptId);
  clearPasswordState_(chatId);

  if (state.purpose === 'saldo' || state.purpose === 'cp_old') {
    if (!passwordMatches_(text, getProp_(PROP.PASSWORD_HASH))) {
      const fails = recordPasswordFail_(chatId);
      sendMessage(chatId, fails >= MAX_PASSWORD_FAILS
        ? '❌ Wrong password. Locked for 15 minutes.'
        : '❌ Wrong password. (' + (MAX_PASSWORD_FAILS - fails) + ' tries left)');
      return;
    }
    resetPasswordFails_(chatId);
    if (state.purpose === 'saldo') {
      showSaldo_(chatId, state.filter);
    } else {
      askPassword_(chatId, 'cp_new', {}, '🔑 Send the <b>new</b> password (at least 4 characters).');
    }
    return;
  }

  if (state.purpose === 'cp_new') {
    if (text.length < 4 || text === DEFAULT_PASSWORD || text.charAt(0) === '/') {
      sendMessage(chatId, '❌ The new password must be at least 4 characters, not 0000, and not start with /. ' +
        'Run /changepass again.');
      return;
    }
    const salt = newSalt_();
    askPassword_(chatId, 'cp_confirm', { salt: salt, hash: hashPassword_(text, salt) },
      '🔑 Send the new password <b>again</b> to confirm.');
    return;
  }

  if (state.purpose === 'cp_confirm') {
    if (hashPassword_(text, state.salt) !== state.hash) {
      sendMessage(chatId, "❌ The passwords didn't match. Run /changepass again.");
      return;
    }
    PropertiesService.getScriptProperties().setProperty(PROP.PASSWORD_HASH, state.salt + ':' + state.hash);
    sendMessage(chatId, '✅ Password changed. Use it for /saldo from now on (for both of you).');
  }
}

/** Sends the /saldo reply (spoilers + auto-delete). */
function showSaldo_(chatId, filter) {
  const ss = openMainSheet_();
  const result = buildSaldoText_(loadWallets_(ss), filter);
  if (result.error) {
    sendMessage(chatId, result.error);
    return;
  }
  let text = result.text;
  if (isDefaultPassword_()) {
    text += '\n\n⚠️ You are still using the default password <b>0000</b>. Change it with /changepass.';
  }
  const delay = Math.min(getSettingInt_(SETTING.SALDO_DELETE_SECONDS), MAX_DELETE_DELAY_SECONDS);
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
