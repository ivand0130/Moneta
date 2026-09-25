/**
 * Config.gs — Script Properties access, Settings tab loader, constants.
 *
 * Secrets and IDs live in Script Properties (Project Settings → Script
 * Properties in the Apps Script editor). Nothing here is hardcoded that
 * belongs in the sheet: users, wallets, categories etc. are read at runtime.
 */

/** Names of Script Properties used by the bot. */
const PROP = {
  BOT_TOKEN: 'BOT_TOKEN',               // Telegram bot token from @BotFather
  GEMINI_KEY: 'GEMINI_KEY',             // Gemini API key (used from Phase 2)
  WEB_APP_URL: 'WEB_APP_URL',           // Deployed web app URL ending in /exec
  WEBHOOK_KEY: 'WEBHOOK_KEY',           // Random secret, created by setWebhook()
  ALLOWED_CHAT_IDS: 'ALLOWED_CHAT_IDS', // Fallback only, used if the main sheet
                                        // can't be opened (normally: Users table)
  MAIN_SHEET_ID: 'MAIN_SHEET_ID',       // Main Google Sheet ID (set by createTemplate)
  ARCHIVE_FOLDER_ID: 'ARCHIVE_FOLDER_ID',
  TEMPLATE_ID: 'TEMPLATE_ID',           // Clean template sheet (set by createTemplate)
  PASSWORD_HASH: 'PASSWORD_HASH',
  RECENT_UPDATES: 'RECENT_UPDATES'      // Written by the bot; see showRecentUpdates()
};

/** Tab names in the main sheet. */
const TAB = {
  DASHBOARD: 'Dashboard',
  TRANSACTIONS: 'Transactions',
  WALLETS: 'Wallets',
  CATEGORIES: 'Categories',
  DEBTS: 'Hutang_Piutang',
  INVESTMENTS: 'Investments',
  SALES: 'Investment_Sales',
  PRICES: 'Price_History',
  FAVORITES: 'Favorites',
  CONTACTS: 'Contacts',
  REPORT: 'Monthly Report',
  SETTINGS: 'Settings',
  LOGS: 'Logs'
};

/**
 * Fixed dropdown values. These are the bot's own vocabulary (not user data),
 * so they live in code; wallets, categories, users etc. come from the sheet.
 */
const LISTS = {
  TRX_TYPES: ['Income', 'Expense', 'Transfer', 'Adjustment', 'Piutang', 'Hutang',
    'Settlement', 'Addition', 'Conversion', 'Investment Buy', 'Investment Sell'],
  DIRECTIONS: ['In', 'Out', 'Transfer'],
  CATEGORY_SOURCES: ['Manual', 'Keyword', 'AI'],
  INPUT_SOURCES: ['Text', 'OCR', 'Favorite', 'Sheet'],
  CATEGORY_TYPES: ['Income', 'Expense', 'Investment', 'Adjustment'],
  WALLET_TYPES: ['Cash', 'Investment'],
  DEBT_TYPES: ['Hutang', 'Piutang'],
  TERMS: ['Short', 'Long'],
  DEBT_STATUSES: ['Open', 'Partial', 'Paid', 'Converted'],
  INV_STATUSES: ['Holding', 'Partially Sold', 'Sold'],
  UNITS: ['lot', 'share', 'gram', 'unit', 'coin', 'nominal'],
  FAV_TYPES: ['Income', 'Expense', 'Transfer'],
  VALUE_TYPES: ['Fixed', 'Variable'],
  SCHEDULES: ['Weekly', 'Monthly'],
  REPORT_STATUSES: ['Open', 'Closed'],
  PRICE_SOURCES: ['Manual', 'Bulk', 'Sheet Edit', 'Auto', 'Closing'],
  YES_NO: ['Yes', 'No']
};

/** How many recent webhook outcomes to keep for showRecentUpdates(). */
const RECENT_UPDATES_MAX = 10;

/** How long a processed update_id is remembered (seconds, max 6 hours). */
const DEDUPE_TTL_SECONDS = 21600;

/** How long to wait for the script lock before giving up (ms). */
const LOCK_TIMEOUT_MS = 10000;

/** Users table is cached this long, so edits take effect within 5 minutes. */
const USERS_CACHE_SECONDS = 300;
const CACHE_KEY_USERS = 'users_v1';

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

/** "111, 222" → ['111', '222'] */
function parseChatIdList_(raw) {
  if (raw === null || raw === undefined) return [];
  return String(raw).split(',')
    .map(function (id) { return id.trim(); })
    .filter(function (id) { return id !== ''; });
}

/**
 * Users from the Users table in Settings:
 * [{chatId, name, gopayName, active}]. Cached for USERS_CACHE_SECONDS.
 * Returns null if no main sheet is set up yet.
 */
function getUsers_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(CACHE_KEY_USERS);
  if (hit !== null) return JSON.parse(hit);

  const ss = openMainSheet_();
  if (ss === null) return null;
  const sheet = ss.getSheetByName(TAB.SETTINGS);
  if (sheet === null) throw new Error('Settings tab not found in the main sheet.');

  const users = readTableByHeaders_(sheet, 'Chat ID').map(function (row) {
    return {
      chatId: String(row['chat id']).trim(),
      name: String(row['display name'] || '').trim(),
      gopayName: String(row['gopay name'] || '').trim(),
      // Anything except "No" counts as active, so a blank cell doesn't lock anyone out.
      active: String(row['active'] || '').trim().toLowerCase() !== 'no'
    };
  });
  cache.put(CACHE_KEY_USERS, JSON.stringify(users), USERS_CACHE_SECONDS);
  return users;
}

/**
 * Chat IDs allowed to use the bot, as strings: active rows of the Users
 * table. Falls back to the ALLOWED_CHAT_IDS Script Property only when there
 * is no main sheet yet or it can't be read.
 */
function getAllowedChatIds_() {
  try {
    const users = getUsers_();
    if (users !== null) {
      return users
        .filter(function (u) { return u.active; })
        .map(function (u) { return u.chatId; });
    }
  } catch (err) {
    logError_('getAllowedChatIds_', err, 'Using ALLOWED_CHAT_IDS fallback');
  }
  return parseChatIdList_(getProp_(PROP.ALLOWED_CHAT_IDS));
}

/** True if this chat ID may use the bot. */
function isAllowedChat_(chatId) {
  return getAllowedChatIds_().indexOf(String(chatId)) !== -1;
}

/**
 * Run from the editor after editing the Users table if you don't want to
 * wait up to 5 minutes for the change to take effect.
 */
function clearConfigCache() {
  CacheService.getScriptCache().remove(CACHE_KEY_USERS);
  console.log('Cache cleared. The bot will re-read the Users table on the next message.');
}

/**
 * Settings key/value table → {'setting name in lowercase': 'value'}.
 * Values are returned as trimmed strings; callers convert them.
 */
function getSettings_() {
  const ss = openMainSheet_();
  if (ss === null) return {};
  const sheet = ss.getSheetByName(TAB.SETTINGS);
  if (sheet === null) return {};
  const settings = {};
  readTableByHeaders_(sheet, 'Setting').forEach(function (row) {
    settings[String(row['setting']).trim().toLowerCase()] = String(row['value']).trim();
  });
  return settings;
}

/** Writes one value into the Settings key/value table (row found by name). */
function setSettingValue_(ss, settingName, value) {
  const sheet = ss.getSheetByName(TAB.SETTINGS);
  const map = getHeaderMap_(sheet);
  const keyCol = map['setting'];
  const valueCol = map['value'];
  const keys = sheet.getRange(1, keyCol + 1, sheet.getLastRow(), 1).getValues();
  for (let i = 1; i < keys.length; i++) {
    if (String(keys[i][0]).trim().toLowerCase() === settingName.toLowerCase()) {
      sheet.getRange(i + 1, valueCol + 1).setValue(value);
      return true;
    }
  }
  return false;
}
