/**
 * Tests.gs — plain functions you can run from the Apps Script editor.
 * Each logs PASS/FAIL lines in the Execution log.
 */

/** Checks that the Script Properties needed so far are set (values hidden). */
function testConfig() {
  const required = [PROP.BOT_TOKEN, PROP.GEMINI_KEY, PROP.WEB_APP_URL, PROP.MAIN_SHEET_ID, PROP.TEMPLATE_ID];
  required.forEach(function (name) {
    console.log((getProp_(name) !== null ? 'PASS' : 'FAIL') + ': ' + name + ' is set');
  });
  console.log((getProp_(PROP.WEBHOOK_KEY) !== null ? 'PASS' : 'FAIL') +
    ': WEBHOOK_KEY is set (created automatically by setWebhook)');
  const ids = getAllowedChatIds_();
  console.log((ids.length > 0 ? 'PASS' : 'FAIL') + ': ' + ids.length + ' allowed chat ID(s)');
}

/** Checks the duplicate-update check: first time new, second time duplicate. */
function testDedupe() {
  const id = 'test_' + Date.now();
  const first = isDuplicateUpdate_(id);
  const second = isDuplicateUpdate_(id);
  console.log((first === false ? 'PASS' : 'FAIL') + ': first sighting is not a duplicate');
  console.log((second === true ? 'PASS' : 'FAIL') + ': second sighting is a duplicate');
}

/** Checks the allow-list: fallback parser, then the live Users table. */
function testAllowList() {
  const parsed = parseChatIdList_(' 111 , 222 ,');
  console.log((parsed.join('|') === '111|222' ? 'PASS' : 'FAIL') + ': fallback list parses to 111, 222');

  clearConfigCache();
  const users = getUsers_();
  if (users === null) {
    console.log('INFO: no main sheet yet, so the bot uses ALLOWED_CHAT_IDS.');
    return;
  }
  const active = users.filter(function (u) { return u.active; });
  console.log((active.length > 0 ? 'PASS' : 'FAIL') + ': Users table has ' + active.length + ' active user(s): ' +
    active.map(function (u) { return u.name + ' (' + u.chatId + ')'; }).join(', '));
  active.forEach(function (u) {
    console.log((isAllowedChat_(u.chatId) ? 'PASS' : 'FAIL') + ': ' + u.name + ' is allowed');
  });
  users.filter(function (u) { return !u.active; }).forEach(function (u) {
    console.log((!isAllowedChat_(u.chatId) ? 'PASS' : 'FAIL') + ': ' + u.name + ' (Active = No) is blocked');
  });
  console.log((!isAllowedChat_('1') ? 'PASS' : 'FAIL') + ': unknown chat ID 1 is blocked');
}

/**
 * Checks the main sheet: all tabs/columns exist, the formulas calculate
 * (no errors), the Settings loader works, and writing to Logs works.
 */
function testSheet() {
  const result = validateSheet();
  console.log((result.ok ? 'PASS' : 'FAIL') + ': validateSheet');

  const ss = openMainSheet_();
  const wallets = readTableByHeaders_(ss.getSheetByName(TAB.WALLETS), 'Wallet');
  const bad = wallets.filter(function (w) { return typeof w['current balance'] !== 'number'; });
  console.log((wallets.length > 0 && bad.length === 0 ? 'PASS' : 'FAIL') + ': ' + wallets.length +
    ' wallets, every Current Balance is a number' +
    (bad.length ? ' (bad: ' + bad.map(function (w) { return w['wallet'] + '=' + w['current balance']; }).join(', ') + ')' : ''));

  const settings = getSettings_();
  console.log((settings['large amount threshold'] === '5000000' ? 'PASS' : 'FAIL') +
    ': Settings loader reads Large Amount Threshold = ' + settings['large amount threshold']);

  const owners = readTableByHeaders_(ss.getSheetByName(TAB.SETTINGS), 'Owners')
    .map(function (row) { return row['owners']; });
  console.log((owners.indexOf('Shared') !== -1 ? 'PASS' : 'FAIL') + ': Owners dropdown list = ' + owners.join(', '));

  const logs = ss.getSheetByName(TAB.LOGS);
  const before = lastDataRow_(logs);
  writeLogRow_('INFO', 'testSheet', 'Test log row, safe to delete');
  console.log((lastDataRow_(logs) === before + 1 ? 'PASS' : 'FAIL') + ': wrote a test row to the Logs tab');
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

// ---------------------------------------------------------------------------
// Phase 2 tests
// ---------------------------------------------------------------------------

/** Fixed wallets/categories so parser tests don't depend on the sheet. */
function testCtx_() {
  const w = function (name, type) { return { name: name, type: type || 'Cash', active: true }; };
  const c = function (name, type, keywords) { return { name: name, type: type, keywords: keywords || [] }; };
  return {
    now: new Date(2026, 8, 25, 10, 30, 0), // 25 Sep 2026 10:30
    wallets: [w('BCA'), w('GoPay'), w('Cash'), w('IPOT'), w('Jago'), w('Bank Jago Syariah'),
      w('Saham', 'Investment'), { name: 'OldBank', type: 'Cash', active: false }],
    categories: [
      c('Food', 'Expense', ['makan', 'kopi', 'kfc', 'gofood']),
      c('Transport', 'Expense', ['bensin', 'parkir', 'gojek']),
      c('Health', 'Expense', ['obat', 'kimia farma']),
      c('Bills & Utilities', 'Expense', ['listrik', 'token listrik']),
      c('Admin & Bank Fees', 'Expense', ['admin']),
      c('Salary', 'Income', ['gaji', 'salary']),
      c('Other Income', 'Income', [])
    ]
  };
}

/** "2026-9-25" for a Date, anything else unchanged (for readable comparisons). */
function testValue_(v) {
  return v instanceof Date ? v.getFullYear() + '-' + (v.getMonth() + 1) + '-' + v.getDate() : v;
}

/** Compares only the fields listed in `expected`. Logs and returns true on PASS. */
function checkCase_(name, actual, expected) {
  const diffs = Object.keys(expected).filter(function (k) {
    return JSON.stringify(testValue_(actual[k])) !== JSON.stringify(expected[k]);
  }).map(function (k) {
    return k + ': got ' + JSON.stringify(testValue_(actual[k])) + ', want ' + JSON.stringify(expected[k]);
  });
  console.log((diffs.length ? 'FAIL' : 'PASS') + ': ' + name + (diffs.length ? ' → ' + diffs.join('; ') : ''));
  return diffs.length === 0;
}

function testParser() {
  const ctx = testCtx_();
  const cases = [
    // Amount formats
    ['50rb makan siang', { ok: true, amount: 50000, type: 'Expense', category: 'Food', note: 'makan siang' }],
    ['50k kopi', { amount: 50000 }],
    ['50K kopi', { amount: 50000 }],
    ['50.000 bensin', { amount: 50000, category: 'Transport' }],
    ['50000 parkir', { amount: 50000 }],
    ['50,000 parkir', { amount: 50000 }],
    ['1.250.000 sewa', { amount: 1250000 }],
    ['Rp50.000 makan', { amount: 50000 }],
    ['rp 25.000 makan', { amount: 25000, note: 'makan' }],
    ['1.5jt sewa', { amount: 1500000 }],
    ['1,5jt sewa', { amount: 1500000 }],
    ['2jt sewa', { amount: 2000000 }],
    ['2juta sewa', { amount: 2000000 }],
    ['2 juta sewa', { amount: 2000000, note: 'sewa' }],
    ['50 rb makan', { amount: 50000 }],
    ['50ribu makan', { amount: 50000 }],
    ['2.5rb admin', { amount: 2500, category: 'Admin & Bank Fees' }],
    ['1.500rb laptop', { amount: 1500000 }],
    ['makan 2 porsi 50rb', { amount: 50000, note: 'makan 2 porsi' }],
    // Ambiguous amounts → options to choose from
    ['2.00.000 makan', { ok: true, amount: null, amountOptions: [200000], amountReason: 'format' }],
    ['1,5,000 makan', { amount: null, amountOptions: [15000] }],
    ['50.5rb makan', { amount: null, amountOptions: [50500], amountReason: 'decimal' }],
    ['makan 50', { amount: null, amountOptions: [50000, 50], amountReason: 'small' }],
    ['1.5 makan', { amount: null, amountOptions: [1500, 1500000], amountReason: 'no_unit' }],
    ['1.250jt mobil', { amount: null, amountOptions: [1250000, 1250000000] }],
    // Errors
    ['hello', { ok: false, error: 'no_amount' }],
    ['50rb 20rb makan', { ok: false, error: 'multiple_amounts' }],
    ['50rb makan 31/02', { ok: false, error: 'invalid_date' }],
    ['50rb makan BCA GoPay', { ok: false, error: 'two_wallets' }],
    ['5jt Saham', { ok: false, error: 'investment_wallet' }],
    // Dates (today is 25 Sep 2026)
    ['50rb makan', { date: '2026-9-25', dateGiven: false }],
    ['50rb makan kemarin', { date: '2026-9-24', note: 'makan' }],
    ['50rb makan yesterday', { date: '2026-9-24' }],
    ['50rb makan 20/09', { date: '2026-9-20' }],
    ['50rb makan 20/09/2025', { date: '2025-9-20' }],
    ['50rb makan 20-09', { date: '2026-9-20' }],
    ['50rb makan tgl 20 sep', { date: '2026-9-20', note: 'makan' }],
    ['50rb makan 5 okt', { date: '2025-10-5' }],
    ['50rb makan 2 hari lalu', { date: '2026-9-23', note: 'makan' }],
    ['50rb makan 3 days ago', { date: '2026-9-22' }],
    // Wallets
    ['50rb makan siang di KFC BCA', { wallet: 'BCA', note: 'makan siang di KFC', category: 'Food' }],
    ['bensin 50rb kemarin pakai gopay', { wallet: 'GoPay', note: 'bensin', date: '2026-9-24' }],
    ['50rb makan', { wallet: null }],
    ['50rb makan Bank Jago Syariah', { wallet: 'Bank Jago Syariah', note: 'makan' }],
    ['50rb makan oldbank', { wallet: null, note: 'makan oldbank' }],
    // #category
    ['30rb obat #health', { category: 'Health', categoryHow: 'tag', note: 'obat' }],
    ['100rb #bills', { category: 'Bills & Utilities' }],
    ['30rb sesuatu #xyz', { category: null, unknownTag: 'xyz' }],
    ['30rb obat', { category: 'Health', categoryHow: 'keyword' }],
    ['beli obat di kimia farma 80rb', { category: 'Health', note: 'beli obat di kimia farma' }],
    ['20rb sesuatu', { category: null, categoryHow: '', type: 'Expense' }],
    // Income
    ['+5jt gaji BCA', { type: 'Income', amount: 5000000, wallet: 'BCA', category: 'Salary', note: 'gaji' }],
    ['gaji 10jt', { type: 'Income', category: 'Salary' }],
    ['terima 200rb dari Budi', { type: 'Income', category: null }],
    ['-50rb makan', { type: 'Expense', amount: 50000 }],
    // Transfers
    ['transfer 1jt BCA ke GoPay', { type: 'Transfer', amount: 1000000, wallet: 'BCA', toWallet: 'GoPay', note: '' }],
    ['tf 500rb dari BCA ke Jago', { type: 'Transfer', wallet: 'BCA', toWallet: 'Jago' }],
    ['transfer 1jt ke GoPay dari BCA', { wallet: 'BCA', toWallet: 'GoPay' }],
    ['1jt BCA ke GoPay', { type: 'Transfer', wallet: 'BCA', toWallet: 'GoPay' }],
    ['top up gopay 100rb dari bca', { type: 'Transfer', wallet: 'BCA', toWallet: 'GoPay' }],
    ['top up gopay 100rb', { type: 'Transfer', wallet: null, toWallet: 'GoPay' }],
    ['transfer 1jt BCA', { type: 'Transfer', wallet: 'BCA', toWallet: null }],
    ['transfer 1jt BCA ke GoPay admin 2.5rb', { ok: false, error: 'transfer_extras' }],
    ['transfer 1jt BCA ke IPOT, sampai 997.500', { ok: false, error: 'transfer_extras' }],
    ['transfer 1jt BCA ke BCA', { ok: false, error: 'same_wallet' }]
  ];
  let pass = 0;
  cases.forEach(function (c) {
    if (checkCase_(c[0], parseTransaction_(c[0], ctx), c[1])) pass++;
  });
  // Edit → Date step
  if (checkCase_('parseDateOnly_ kemarin', { v: parseDateOnly_('kemarin', ctx.now) }, { v: '2026-9-24' })) pass++;
  if (checkCase_('parseDateOnly_ rejects extra words', { v: parseDateOnly_('kemarin sore', ctx.now) }, { v: null })) pass++;
  const total = cases.length + 2;
  console.log((pass === total ? 'PASS' : 'FAIL') + ': testParser ' + pass + '/' + total);
  return pass === total;
}

function testCategoryMapping() {
  const ctx = testCtx_();
  let pass = 0;
  const t = function (name, actual, expected) { if (checkCase_(name, { v: actual }, { v: expected })) pass++; };
  t('keyword: longest wins', (matchKeyword_('bayar token listrik', ctx.categories) || {}).keyword, 'token listrik');
  t('keyword: whole words only', matchKeyword_('makanan kucing', ctx.categories), null);
  t('keyword: respects type', matchKeyword_('gaji', ctx.categories, ['Expense']), null);
  t('keyword: multi-word', (matchKeyword_('ke Kimia Farma tadi', ctx.categories) || {}).category, 'Health');
  t('tag: exact', (findCategoryByTag_('food', ctx.categories) || {}).name, 'Food');
  t('tag: prefix', (findCategoryByTag_('admin', ctx.categories) || {}).name, 'Admin & Bank Fees');
  t('tag: ignores symbols', (findCategoryByTag_('billsutilities', ctx.categories) || {}).name, 'Bills & Utilities');
  t('tag: unknown', findCategoryByTag_('zzz', ctx.categories), null);
  t('keyword candidates', keywordCandidates_('makan siang di KFC 2 porsi'), ['makan', 'siang', 'kfc', 'porsi']);
  console.log((pass === 9 ? 'PASS' : 'FAIL') + ': testCategoryMapping ' + pass + '/9');
  return pass === 9;
}

function testSpoiler() {
  let pass = 0;
  const t = function (name, actual, expected) { if (checkCase_(name, { v: actual }, { v: expected })) pass++; };
  t('formatRp_ thousands', formatRp_(1250000), 'Rp1.250.000');
  t('formatRp_ small', formatRp_(500), 'Rp500');
  t('formatRp_ negative', formatRp_(-50000), '−Rp50.000');
  t('formatRpSigned_', formatRpSigned_(1000000), '+Rp1.000.000');
  t('money_ hidden', money_(50000, true), '<tg-spoiler>Rp50.000</tg-spoiler>');
  t('money_ shown', money_(50000, false), 'Rp50.000');
  t('escapeHtml_', escapeHtml_('a<b>&c'), 'a&lt;b&gt;&amp;c');
  console.log((pass === 7 ? 'PASS' : 'FAIL') + ': testSpoiler ' + pass + '/7');
  return pass === 7;
}

/** Password hashing (does not touch your real password). */
function testPassword() {
  let pass = 0;
  const t = function (name, actual, expected) { if (checkCase_(name, { v: actual }, { v: expected })) pass++; };
  const stored = 'salt123:' + hashPassword_('9876', 'salt123');
  t('default 0000 accepted while unset', passwordMatches_('0000', null), true);
  t('other password rejected while unset', passwordMatches_('1111', null), false);
  t('correct password matches', passwordMatches_('9876', stored), true);
  t('wrong password rejected', passwordMatches_('0000', stored), false);
  t('stored value does not contain the password', stored.indexOf('9876') === -1, true);
  console.log((pass === 5 ? 'PASS' : 'FAIL') + ': testPassword ' + pass + '/5');
}

/** Adds a queue entry and removes it again (nothing is deleted in Telegram). */
function testDeleteQueue() {
  const before = readDeleteQueue_().length;
  scheduleDelete_('0', -1, 999999);
  const queue = readDeleteQueue_();
  const added = queue[queue.length - 1];
  console.log((queue.length === before + 1 ? 'PASS' : 'FAIL') + ': entry added to the queue');
  console.log((added.at - Date.now() <= MAX_DELETE_DELAY_SECONDS * 1000 ? 'PASS' : 'FAIL') + ': delay capped at 47 hours');
  withScriptLock_(function () {
    writeDeleteQueue_(readDeleteQueue_().filter(function (item) { return !(item.c === '0' && item.m === -1); }));
  });
  console.log((readDeleteQueue_().length === before ? 'PASS' : 'FAIL') + ': test entry removed');
  const hasTrigger = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'cleanupMessages'; });
  console.log((hasTrigger ? 'PASS' : 'FAIL') + ': cleanupMessages trigger is installed' +
    (hasTrigger ? '' : ' (run installCleanupTrigger)'));
}
