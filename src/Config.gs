/**
 * Config.gs — Script Properties access, Settings tab loader, constants.
 *
 * Secrets and IDs live in Script Properties (Project Settings → Script
 * Properties in the Apps Script editor). Nothing here is hardcoded that
 * belongs in the sheet.
 */

/** Names of Script Properties used by the bot. */
const PROP = {
  BOT_TOKEN: 'BOT_TOKEN',               // Telegram bot token from @BotFather
  GEMINI_KEY: 'GEMINI_KEY',             // Gemini API key (used from Phase 2)
  WEB_APP_URL: 'WEB_APP_URL',           // Deployed web app URL ending in /exec
  WEBHOOK_KEY: 'WEBHOOK_KEY',           // Random secret, created by setWebhook()
  ALLOWED_CHAT_IDS: 'ALLOWED_CHAT_IDS', // Comma-separated chat IDs (Phase 0 only;
                                        // Phase 1 switches to the Users table)
  MAIN_SHEET_ID: 'MAIN_SHEET_ID',       // Main Google Sheet ID (Phase 1)
  ARCHIVE_FOLDER_ID: 'ARCHIVE_FOLDER_ID',
  TEMPLATE_ID: 'TEMPLATE_ID',
  PASSWORD_HASH: 'PASSWORD_HASH',
  RECENT_UPDATES: 'RECENT_UPDATES'      // Written by the bot; see showRecentUpdates()
};

/** How many recent webhook outcomes to keep for showRecentUpdates(). */
const RECENT_UPDATES_MAX = 10;

/** How long a processed update_id is remembered (seconds, max 6 hours). */
const DEDUPE_TTL_SECONDS = 21600;

/** How long to wait for the script lock before giving up (ms). */
const LOCK_TIMEOUT_MS = 10000;

/** Returns a Script Property value, or null if it is not set. */
function getProp_(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  return value === null || value.trim() === '' ? null : value.trim();
}

/** Returns a Script Property value, or throws a clear error if missing. */
function requireProp_(name) {
  const value = getProp_(name);
  if (value === null) {
    throw new Error('Script Property "' + name + '" is not set. ' +
      'Add it in Project Settings → Script Properties.');
  }
  return value;
}

/**
 * Chat IDs allowed to use the bot, as strings.
 * Phase 0: read from the ALLOWED_CHAT_IDS Script Property.
 * Phase 1: replace this with a read of the Users table in Settings.
 */
function getAllowedChatIds_() {
  const raw = getProp_(PROP.ALLOWED_CHAT_IDS);
  if (raw === null) return [];
  return raw.split(',')
    .map(function (id) { return id.trim(); })
    .filter(function (id) { return id !== ''; });
}

/** True if this chat ID may use the bot. */
function isAllowedChat_(chatId) {
  return getAllowedChatIds_().indexOf(String(chatId)) !== -1;
}
