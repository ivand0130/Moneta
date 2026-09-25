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
  GEMINI_KEY: 'GEMINI_KEY',             // Gemini API key
  WEB_APP_URL: 'WEB_APP_URL',           // Deployed web app URL ending in /exec
  WEBHOOK_KEY: 'WEBHOOK_KEY',           // Random secret, created by setWebhook()
  ALLOWED_CHAT_IDS: 'ALLOWED_CHAT_IDS', // Fallback only, used if the main sheet
                                        // can't be opened (normally: Users table)
  MAIN_SHEET_ID: 'MAIN_SHEET_ID',       // Main Google Sheet ID (set by createTemplate)
  ARCHIVE_FOLDER_ID: 'ARCHIVE_FOLDER_ID',
  TEMPLATE_ID: 'TEMPLATE_ID',           // Clean template sheet (set by createTemplate)
  RECENT_UPDATES: 'RECENT_UPDATES',     // Written by the bot; see showRecentUpdates()
  DELETE_QUEUE: 'DELETE_QUEUE'          // Backup of the auto-delete queue
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

/** Setting names used by the code (rows in the Settings key/value table). */
const SETTING = {
  AI_ENABLED: 'AI Enabled',
  GEMINI_MODEL: 'Gemini Model',
  LARGE_AMOUNT: 'Large Amount Threshold',
  DUPLICATE_MINUTES: 'Duplicate Window (minutes)',
  HIDE_AMOUNTS: 'Hide amounts',
  SALDO_DELETE_SECONDS: 'Saldo auto-delete (seconds)',
  PASSWORD: 'Password',
  SPENDING_GROUPS: 'Spending Wallet Groups',
  INVESTMENT_GROUPS: 'Investment Wallet Groups'
};

/**
 * Every row of the Settings key/value table: [name, default, notes].
 * createTemplate writes these; upgradeSettings() adds missing ones to an
 * existing sheet. The default is only used if the row is missing or blank.
 */
const SETTING_ROWS = [
  ['Timezone', 'Asia/Jakarta', 'Info only. The bot always uses Asia/Jakarta.'],
  [SETTING.AI_ENABLED, 'Yes', 'Yes = use Gemini for category suggestions (and OCR later). No = keywords and buttons only.'],
  [SETTING.GEMINI_MODEL, 'gemini-flash-latest', 'Gemini model name. Change it here if Google renames models.'],
  [SETTING.LARGE_AMOUNT, '5000000', 'Amounts above this (Rp) get a warning in the preview.'],
  [SETTING.DUPLICATE_MINUTES, '5', 'Warn if the same type + amount + note was logged within this many minutes.'],
  [SETTING.HIDE_AMOUNTS, 'Yes', 'Yes = amounts in /saldo, /inv, /open, /report are hidden until tapped.'],
  [SETTING.SALDO_DELETE_SECONDS, '60', 'Delete the /saldo reply after this many seconds. 0 = never. Max 169200 (47 hours).'],
  [SETTING.PASSWORD, '0000', 'Password for /saldo. Numbers only. Change it here or with /changepass. 0000 = default (the bot reminds you to change it).'],
  [SETTING.SPENDING_GROUPS, 'Spending', 'Wallet groups offered as buttons for expenses (comma-separated).'],
  [SETTING.INVESTMENT_GROUPS, 'Investment', 'Wallet groups that hold investment money: not usable for expenses/income, hidden in /saldo (shown in /saldo all). Transfers are fine.'],
  ['Daily Reminder Time', '08:00', 'Hour for the daily hutang/piutang reminder (HH:MM).'],
  ['Weekly Reminder Day', 'Monday', 'Day for the weekly summary reminder.'],
  ['Monthly Reminder Date', '1', 'Day of month for the monthly reminder.'],
  ['Price Update Reminder Time', '12:00', 'Last day of the month: reminder to update investment prices.'],
  ['Closing Reminder Time', '18:00', 'Last day of the month: reminder to close the month.'],
  ['Debt Reminder Days Before Due', '3', 'Start reminding this many days before a due date.'],
  ['Main Sheet ID', '', 'Info only (written by the script). The real value is in Script Properties.'],
  ['Archive Folder ID', '', 'Info only. Set with /setarchive (later phase).']
];

/** How many recent webhook outcomes to keep for showRecentUpdates(). */
const RECENT_UPDATES_MAX = 10;

/** How long a processed update_id is remembered (seconds, max 6 hours). */
const DEDUPE_TTL_SECONDS = 21600;

/** How long to wait for the script lock before giving up (ms). */
const LOCK_TIMEOUT_MS = 10000;

/** Settings tab (users + settings) is cached this long: edits apply within 5 min. */
const SETTINGS_CACHE_SECONDS = 300;
const CACHE_KEY_SETTINGS_TAB = 'settings_tab_v2';

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
 * Reads the whole Settings tab once and returns
 *   { settings: {'name lowercase': 'value'}, users: [...], owners: [...], walletGroups: [...] }
 * Cached for SETTINGS_CACHE_SECONDS; fresh = true skips the cache (and
 * refreshes it). The Password is never kept in the cache.
 * Returns null if there is no main sheet.
 */
function loadSettingsTab_(fresh) {
  const cache = CacheService.getScriptCache();
  const hit = fresh ? null : cache.get(CACHE_KEY_SETTINGS_TAB);
  if (hit !== null) return JSON.parse(hit);

  const ss = openMainSheet_();
  if (ss === null) return null;
  const sheet = ss.getSheetByName(TAB.SETTINGS);
  if (sheet === null) throw new Error('Settings tab not found in the main sheet.');

  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
  const col = function (name) { return headers.indexOf(name); };
  const cell = function (row, name) {
    const i = col(name);
    return i === -1 ? '' : String(row[i]).trim();
  };

  const result = { settings: {}, users: [], owners: [], walletGroups: [] };
  values.slice(1).forEach(function (row) {
    const key = cell(row, 'setting');
    if (key !== '') result.settings[key.toLowerCase()] = cell(row, 'value');
    if (cell(row, 'chat id') !== '') {
      result.users.push({
        chatId: cell(row, 'chat id'),
        name: cell(row, 'display name'),
        gopayName: cell(row, 'gopay name'),
        // Anything except "No" counts as active, so a blank cell doesn't lock anyone out.
        active: cell(row, 'active').toLowerCase() !== 'no'
      });
    }
    if (cell(row, 'owners') !== '') result.owners.push(cell(row, 'owners'));
    if (cell(row, 'wallet groups') !== '') result.walletGroups.push(cell(row, 'wallet groups'));
  });

  const cached = JSON.parse(JSON.stringify(result));
  delete cached.settings[SETTING.PASSWORD.toLowerCase()];
  cache.put(CACHE_KEY_SETTINGS_TAB, JSON.stringify(cached), SETTINGS_CACHE_SECONDS);
  return result;
}

/**
 * Users from the Users table in Settings: [{chatId, name, gopayName, active}].
 * Returns null if no main sheet is set up yet.
 */
function getUsers_() {
  const tab = loadSettingsTab_();
  return tab === null ? null : tab.users;
}

/** The Users-table entry for this chat ID, or null. */
function getUserByChatId_(chatId) {
  const users = getUsers_() || [];
  return users.filter(function (u) { return u.chatId === String(chatId); })[0] || null;
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
 * Run from the editor after editing the Settings tab (users, settings) if
 * you don't want to wait up to 5 minutes for the change to take effect.
 */
function clearConfigCache() {
  CacheService.getScriptCache().remove(CACHE_KEY_SETTINGS_TAB);
  console.log('Cache cleared. The bot will re-read the Settings tab on the next message.');
}

/** Settings key/value table → {'setting name in lowercase': 'value'}. */
function getSettings_() {
  const tab = loadSettingsTab_();
  return tab === null ? {} : tab.settings;
}

/** Default value for a setting from SETTING_ROWS ('' if unknown). */
function settingDefault_(name) {
  const row = SETTING_ROWS.filter(function (r) { return r[0].toLowerCase() === name.toLowerCase(); })[0];
  return row ? row[1] : '';
}

/** A setting as a string; falls back to the default if missing or blank. */
function getSetting_(name) {
  const value = getSettings_()[name.toLowerCase()];
  return value === undefined || value === '' ? settingDefault_(name) : value;
}

/** A whole-number setting ("5.000.000" and "5000000" both work). */
function getSettingInt_(name) {
  const digits = String(getSetting_(name)).replace(/[^\d]/g, '');
  return digits === '' ? Number(settingDefault_(name)) : Number(digits);
}

/** A comma-separated setting as a lowercase list ("Spending, Daily" → ['spending', 'daily']). */
function getSettingList_(name) {
  return String(getSetting_(name)).split(',')
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(String);
}

/** A yes/no setting. */
function getSettingYes_(name) {
  return /^(yes|y|ya|true|on|1)$/i.test(String(getSetting_(name)).trim());
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
