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

  const cats = readTableByHeaders_(ss.getSheetByName(TAB.CATEGORIES), 'Category');
  const badSpent = cats.filter(function (c) {
    return String(c['type']) === 'Expense' && typeof c['spent'] !== 'number';
  });
  const badRemaining = cats.filter(function (c) {
    return Number(c['monthly budget']) > 0 && typeof c['remaining'] !== 'number';
  });
  console.log((badSpent.length === 0 && badRemaining.length === 0 ? 'PASS' : 'FAIL') +
    ': Categories Spent/Remaining calculate' +
    (badSpent.length + badRemaining.length ? ' (bad: ' + badSpent.concat(badRemaining).map(function (c) {
      return c['category'];
    }).join(', ') + ')' : ''));

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
  const w = function (name, group, type) { return { name: name, group: group, type: type || 'Cash', active: true }; };
  const c = function (name, type, keywords) { return { name: name, type: type, keywords: keywords || [] }; };
  return {
    now: new Date(2026, 8, 25, 10, 30, 0), // 25 Sep 2026 10:30
    wallets: [w('BCA', 'Spending'), w('GoPay', 'Spending'), w('Cash', 'Spending'), w('IPOT (Saham)', 'Investment'),
      w('Ajaib Kripto (Kripto)', 'Investment'), w('Ajaib Kripto (Saham US)', 'Investment'),
      w('Mandiri (Payroll)', 'Spending'), w('Mandiri (Joint)', 'Spending'),
      w('Jago', 'Savings'), w('Bank Jago Syariah', 'Savings'), w('Saham', 'Investment', 'Investment'),
      { name: 'OldBank', group: 'Spending', type: 'Cash', active: false }],
    investmentGroups: ['investment'],
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
    // Phase 3: transfers with a fee, a received amount or a partial expense
    ['transfer 1jt BCA ke GoPay admin 2.5rb', { ok: true, type: 'Transfer', amount: 1000000, wallet: 'BCA',
      toWallet: 'GoPay', extra: { kind: 'fee', amount: 2500, note: '', category: 'Admin & Bank Fees', categoryHow: 'keyword' } }],
    ['transfer 1jt BCA ke IPOT, sampai 997.500', { ok: true, amount: 1000000, toWallet: 'IPOT (Saham)',
      extra: { kind: 'received', amount: 997500, note: '', category: null, categoryHow: '' } }],
    ['Transfer BCA ke IPOT 1jt dipotong admin 15k', { amount: 1000000, extra: { kind: 'fee', amount: 15000, note: '',
      category: 'Admin & Bank Fees', categoryHow: 'keyword' } }],
    ['transfer 1jt BCA ke GoPay biaya transfer 6.5rb', { amount: 1000000, extra: { kind: 'fee', amount: 6500, note: '',
      category: 'Admin & Bank Fees', categoryHow: 'keyword' } }],
    ['transfer 1jt BCA ke GoPay, 2.5rb admin', { amount: 1000000, extra: { kind: 'fee', amount: 2500, note: '',
      category: 'Admin & Bank Fees', categoryHow: 'keyword' } }],
    ['transfer 1jt admin 2.5rb BCA ke GoPay', { amount: 1000000, wallet: 'BCA', extra: { kind: 'fee', amount: 2500,
      note: '', category: 'Admin & Bank Fees', categoryHow: 'keyword' } }],
    ['top up gopay 100rb dari BCA fee 1rb', { toWallet: 'GoPay', amount: 100000, extra: { kind: 'fee', amount: 1000,
      note: '', category: 'Admin & Bank Fees', categoryHow: 'keyword' } }],
    ['transfer BCA ke GoPay 100rb admin 500', { amount: 100000, extra: { kind: 'fee', amount: 500, note: '',
      category: 'Admin & Bank Fees', categoryHow: 'keyword' } }],
    ['Transfer BCA ke IPOT 1jt, 500k untuk makan siang', { amount: 1000000, note: '', extra: { kind: 'partial',
      amount: 500000, note: 'makan siang', category: 'Food', categoryHow: 'keyword' } }],
    ['Transfer BCA ke GoPay 100k, 20k untuk beli barang', { amount: 100000, extra: { kind: 'partial', amount: 20000,
      note: 'beli barang', category: null, categoryHow: '' } }],
    ['transfer 1jt BCA ke IPOT, 200rb dipakai bayar makan', { amount: 1000000, extra: { kind: 'partial', amount: 200000,
      note: 'bayar makan', category: 'Food', categoryHow: 'keyword' } }],
    ['transfer 1jt BCA ke GoPay 50rb buat obat #health', { extra: { kind: 'partial', amount: 50000, note: 'obat',
      category: 'Health', categoryHow: 'tag' } }],
    ['transfer 1jt BCA ke GoPay diterima 999.000', { extra: { kind: 'received', amount: 999000, note: '', category: null,
      categoryHow: '' } }],
    ['transfer 1jt untuk tabungan BCA ke Jago', { ok: true, amount: 1000000, extra: null, note: 'untuk tabungan' }],
    ['transfer 1jt BCA ke Jago', { extra: null }],
    ['transfer 1jt BCA ke GoPay admin 2.5rb, 20rb untuk makan', { ok: false, error: 'transfer_two_extras' }],
    ['transfer 1jt BCA ke GoPay 20rb 30rb', { ok: false, error: 'multiple_amounts' }],
    ['transfer 1jt BCA ke BCA', { ok: false, error: 'same_wallet' }],
    // Reported cases: yesterday spellings, "tgl 10", investment wallets
    ['25rb parkir kmrn', { date: '2026-9-24', note: 'parkir' }],
    ['25rb parkir kmarin', { date: '2026-9-24' }],
    ['Parkir Kemarin 25rb', { date: '2026-9-24', note: 'Parkir', category: 'Transport' }],
    ['25rb parkir tgl 10', { date: '2026-9-10', dateNeedsConfirm: true, dateText: 'tgl 10', note: 'parkir' }],
    ['25rb parkir tanggal 30', { date: '2026-8-30', dateNeedsConfirm: true }],
    ['25rb parkir tgl 25', { date: '2026-9-25' }],
    ['25rb parkir tgl 31', { date: '2026-8-31' }],
    ['25rb parkir tgl 20 sep', { date: '2026-9-20', dateNeedsConfirm: false }],
    ['50rb makan IPOT', { ok: false, error: 'investment_wallet' }],
    ['transfer 1jt BCA ke IPOT', { ok: true, type: 'Transfer', wallet: 'BCA', toWallet: 'IPOT (Saham)' }],
    // Wallet names with brackets: the short name works; shared short names ask to choose
    ['transfer 1jt BCA ke ipot saham', { toWallet: 'IPOT (Saham)' }],
    ['transfer 1jt BCA ke Ajaib Kripto', { ok: true, toWallet: null,
      toWalletChoices: ['Ajaib Kripto (Kripto)', 'Ajaib Kripto (Saham US)'] }],
    ['transfer 1jt BCA ke Ajaib Kripto (Saham US)', { toWallet: 'Ajaib Kripto (Saham US)', toWalletChoices: null }],
    ['50rb makan Ajaib Kripto', { ok: false, error: 'investment_wallet' }],
    ['50rb makan Mandiri', { ok: true, wallet: null, walletChoices: ['Mandiri (Payroll)', 'Mandiri (Joint)'], note: 'makan' }],
    ['50rb makan mandiri (joint)', { wallet: 'Mandiri (Joint)', walletChoices: null, note: 'makan' }],
    ['transfer 1jt BCA ke Saham', { ok: false, error: 'investment_wallet' }],
    ['50rb makan Jago', { ok: true, wallet: 'Jago' }]
  ];
  let pass = 0;
  cases.forEach(function (c) {
    if (checkCase_(c[0], parseTransaction_(c[0], ctx), c[1])) pass++;
  });
  // Edit → Date step
  if (checkCase_('parseDateOnly_ kemarin', { v: parseDateOnly_('kemarin', ctx.now) }, { v: '2026-9-24' })) pass++;
  if (checkCase_('parseDateOnly_ rejects extra words', { v: parseDateOnly_('kemarin sore', ctx.now) }, { v: null })) pass++;
  if (checkCase_('parseDateOnly_ bare day', { v: parseDateOnly_('10', ctx.now) }, { v: '2026-9-10' })) pass++;
  if (checkCase_('nearest past day across new year', { v: nearestPastDay_(10, new Date(2026, 0, 5)) }, { v: '2025-12-10' })) pass++;
  const total = cases.length + 4;
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

/** Password rules, and that the Settings row can be read (the value is not logged). */
function testPassword() {
  let pass = 0;
  const t = function (name, actual, expected) { if (checkCase_(name, { v: actual }, { v: expected })) pass++; };
  t('digits accepted', isDigitsOnly_('0123'), true);
  t('space rejected', isDigitsOnly_('12 34'), false);
  t('letters rejected', isDigitsOnly_('12a4'), false);
  t('/changepass compare: same entry matches', hashPassword_('9876', 's') === hashPassword_('9876', 's'), true);
  t('/changepass compare: different entry fails', hashPassword_('9876', 's') === hashPassword_('9875', 's'), false);
  const current = readSheetPassword_();
  t('Settings → Password is readable and numbers only', current.error === undefined, true);
  console.log((pass === 6 ? 'PASS' : 'FAIL') + ': testPassword ' + pass + '/6' +
    (current.value === DEFAULT_PASSWORD ? ' (still the default 0000)' : ''));
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

/**
 * Shows every setting exactly as the bot reads it right now (fresh from the
 * main sheet), and how it understands the on/off switches. The password
 * value is never shown.
 */
function showSettings() {
  const tab = loadSettingsTab_(true);
  if (tab === null) {
    console.log('FAIL: no main sheet (MAIN_SHEET_ID is not set).');
    return;
  }
  console.log('Main sheet: ' + openMainSheet_().getName());
  Object.keys(tab.settings).forEach(function (k) {
    const v = k === SETTING.PASSWORD.toLowerCase() ? '(hidden)' : JSON.stringify(tab.settings[k]);
    console.log('  ' + k + ' = ' + v);
  });
  [SETTING.BUDGET_AUTO_DELETE, SETTING.SALDO_PASSWORD, SETTING.HIDE_AMOUNTS, SETTING.AI_ENABLED].forEach(function (name) {
    const present = tab.settings[name.toLowerCase()] !== undefined;
    console.log('→ ' + name + ': the bot reads ' + (getSettingYes_(name) ? 'YES' : 'NO') +
      (present ? '' : ' (row missing, using the default)'));
  });
}

/** Budget rules: parsing, what counts as spent, the message text (no sheet needed). */
function testBudget() {
  let pass = 0;
  const t = function (name, actual, expected) { if (checkCase_(name, { v: actual }, { v: expected })) pass++; };
  t('budget number', parseBudget_(1500000), 1500000);
  t('budget text with dots', parseBudget_('1.500.000'), 1500000);
  t('budget empty = no limit', parseBudget_(''), 0);
  const rows = [
    { type: 'Expense', category: 'Food', amount: 50000, date: new Date(2026, 8, 3) },
    { type: 'Expense', category: 'Food', amount: 25000, date: new Date(2026, 8, 20) },
    { type: 'Expense', category: 'Food', amount: 99000, date: new Date(2026, 7, 31) },   // August
    { type: 'Income', category: 'Food', amount: 70000, date: new Date(2026, 8, 5) },     // not an expense
    { type: 'Transfer', category: '', amount: 1000000, date: new Date(2026, 8, 5) },
    { type: 'Expense', category: 'Health', amount: 30000, date: new Date(2026, 8, 5) }
  ];
  t('spent: only this month, only expenses, only this category', spentInMonth_(rows, 'Food', 2026, 8), 75000);
  t('spent: previous month', spentInMonth_(rows, 'Food', 2026, 7), 99000);
  const under = buildBudgetText_([{ category: 'Food', year: 2026, month: 8, budget: 100000, spent: 75000 }], false);
  t('under budget shows remaining', /Remaining Rp25\.000/.test(under) && /75%/.test(under), true);
  const exact = buildBudgetText_([{ category: 'Food', year: 2026, month: 8, budget: 100000, spent: 100000 }], false);
  t('exactly at budget is not over', /OVER/.test(exact) === false && /Remaining Rp0/.test(exact), true);
  const over = buildBudgetText_([{ category: 'Food', year: 2026, month: 8, budget: 100000, spent: 150000 }], false);
  t('over budget says OVER by the difference', /OVER budget by <\/b>Rp50\.000/.test(over) && /150%/.test(over), true);
  const hidden = buildBudgetText_([{ category: 'Food', year: 2026, month: 8, budget: 100000, spent: 75000 }], true);
  t('amounts hidden when Hide amounts = Yes', (hidden.match(/<tg-spoiler>/g) || []).length, 3);
  t('two categories in one message', buildBudgetText_([
    { category: 'Food', year: 2026, month: 8, budget: 100000, spent: 1 },
    { category: 'Health', year: 2026, month: 8, budget: 100000, spent: 1 }]).split('📊').length - 1, 2);
  t('no items → no message', buildBudgetText_([]), '');
  console.log((pass === 11 ? 'PASS' : 'FAIL') + ': testBudget ' + pass + '/11');
}

/** /budget reply text for fixed data (no sheet needed). */
function testBudgetCommand() {
  let pass = 0;
  const t = function (name, actual, expected) { if (checkCase_(name, { v: actual }, { v: expected })) pass++; };
  const now = new Date(2026, 8, 28, 10, 0);
  const c = function (name, type, budget) { return { name: name, type: type, keywords: [], budget: budget }; };
  const cats = [c('Food', 'Expense', 100000), c('Health', 'Expense', 0), c('Transport', 'Expense', 50000),
    c('Bills & Utilities', 'Expense', 0), c('Salary', 'Income', 999), c('Food', 'Expense', 5)];
  const r = function (type, cat, amount, day, month) {
    return { type: type, category: cat, amount: amount, date: new Date(2026, month === undefined ? 8 : month, day) };
  };
  const rows = [r('Expense', 'Food', 110000, 3), r('Expense', 'Transport', 20000, 4), r('Expense', 'Health', 30000, 5),
    r('Expense', '', 5000, 6), r('Income', 'Salary', 5000000, 1), r('Expense', 'Food', 77000, 30, 7)];

  const all = buildBudgetReport_(cats, rows, now, '', false).text;
  t('header has the month', all.indexOf('Budgets · September 2026') !== -1, true);
  t('over category flagged', /⚠️ <b>Food<\/b>: Spent Rp110\.000 of Rp100\.000 \(110%\) · over by Rp10\.000/.test(all), true);
  t('under category', /• <b>Transport<\/b>: Spent Rp20\.000 of Rp50\.000 \(40%\) · Rp30\.000 left/.test(all), true);
  t('no-budget category not listed', all.indexOf('<b>Health</b>') === -1, true);
  t('total covers budgeted only', /Total budgeted<\/b>: Spent Rp130\.000 of Rp150\.000 \(87%\) · Rp20\.000 left/.test(all), true);
  t('spending without a budget (Health + blank)', all.indexOf('Spending without a budget: Rp35.000') !== -1, true);
  t('budget on Income ignored with warning', /Budgets on Salary are ignored/.test(all), true);
  t('duplicate category warned', /Food appears more than once/.test(all), true);
  t('August spending not counted', all.indexOf('77.000') === -1, true);

  t('one category (any case, prefix)', /Transport · September 2026[\s\S]*40%/.test(buildBudgetReport_(cats, rows, now, 'trans', false).text), true);
  t('one category without budget', /No budget set \(no limit\)\. Spent this month: Rp30\.000/.test(
    buildBudgetReport_(cats, rows, now, 'health', false).text), true);
  t('unknown category', /No category called "xyz"/.test(buildBudgetReport_(cats, rows, now, 'xyz', false).error), true);
  t('income category refused', /Salary is an Income category/.test(buildBudgetReport_(cats, rows, now, 'salary', false).error), true);
  t('no budgets at all', /No budgets set yet/.test(buildBudgetReport_([c('Food', 'Expense', 0)], rows, now, '', false).text), true);
  t('hidden amounts', (buildBudgetReport_(cats, rows, now, 'transport', true).text.match(/<tg-spoiler>/g) || []).length, 3);
  console.log((pass === 15 ? 'PASS' : 'FAIL') + ': testBudgetCommand ' + pass + '/15');
}

// ---------------------------------------------------------------------------
// Phase 3 tests
// ---------------------------------------------------------------------------

/** /adjust reading (no sheet needed). */
function testAdjust() {
  const ctx = testCtx_();
  let pass = 0;
  const cases = [
    ['BCA 10.200.000', { ok: true, wallet: 'BCA', actual: 10200000, note: '' }],
    ['bca 10,2jt', { ok: true, wallet: 'BCA', actual: 10200000 }],
    ['GoPay 0', { ok: true, wallet: 'GoPay', actual: 0 }],
    ['Cash -50.000', { ok: true, wallet: 'Cash', actual: -50000 }],
    ['BCA 10.200.000 kemarin salah catat', { wallet: 'BCA', actual: 10200000, date: '2026-9-24', note: 'salah catat' }],
    ['BCA tgl 10 5jt', { actual: 5000000, date: '2026-9-10', dateNeedsConfirm: true }],
    ['IPOT 500rb', { ok: true, wallet: 'IPOT (Saham)', actual: 500000 }],
    ['Mandiri 1jt', { ok: true, wallet: null, walletChoices: ['Mandiri (Payroll)', 'Mandiri (Joint)'] }],
    ['Saham 5jt', { ok: false, error: 'adjust_investment' }],
    ['10.200.000', { ok: false, error: 'adjust_no_wallet' }],
    ['BCA', { ok: false, error: 'no_amount' }],
    ['BCA 1jt 2jt', { ok: false, error: 'multiple_amounts' }],
    ['BCA GoPay 1jt', { ok: false, error: 'two_wallets' }],
    ['BCA 50', { ok: true, actual: null, amountOptions: [50000, 50] }],
    ['', { ok: false, error: 'adjust_usage' }]
  ];
  cases.forEach(function (c) { if (checkCase_('adjust: ' + c[0], parseAdjust_(c[0], ctx), c[1])) pass++; });
  console.log((pass === cases.length ? 'PASS' : 'FAIL') + ': testAdjust ' + pass + '/' + cases.length);
}

/** Linked entries and wallet effects for transfers with a fee / spent part (no sheet needed). */
function testLinkedEntries() {
  let pass = 0;
  const t = function (name, actual, expected) { if (checkCase_(name, { v: actual }, { v: expected })) pass++; };
  const base = { type: 'Transfer', amount: 1000000, wallet: 'BCA', toWallet: 'GoPay', note: '', date: 0 };
  const withExtra = function (x) { return Object.assign({}, base, { extra: x }); };
  const fee = entriesOf_(withExtra({ kind: 'fee', amount: 2500, category: 'Admin & Bank Fees', categoryHow: 'keyword' }));
  t('fee: 2 rows', fee.length, 2);
  t('fee: comes out of the amount', fee[0].amount, 997500);
  t('fee: expense from the source', fee[1].wallet + ' ' + fee[1].amount, 'BCA 2500');
  t('fee: BCA −1.000.000 in total, GoPay receives 997.500', JSON.stringify(walletDeltas_(fee)),
    JSON.stringify({ BCA: -1000000, GoPay: 997500 }));
  const src = entriesOf_(withExtra({ kind: 'partial', amount: 200000, from: 'source', category: 'Food', note: 'makan' }));
  t('partial from source: transfer shrinks', src[0].amount, 800000);
  t('partial from source: effects', JSON.stringify(walletDeltas_(src)), JSON.stringify({ BCA: -1000000, GoPay: 800000 }));
  const dst = entriesOf_(withExtra({ kind: 'partial', amount: 200000, from: 'dest', category: 'Food', note: 'makan' }));
  t('partial from destination: transfer full, expense from GoPay', dst[0].amount + ' ' + dst[1].wallet, '1000000 GoPay');
  t('partial from destination: effects', JSON.stringify(walletDeltas_(dst)), JSON.stringify({ BCA: -1000000, GoPay: 800000 }));
  t('no extra: 1 row', entriesOf_(base).length, 1);
  t('received (not yet answered): 1 row', entriesOf_(withExtra({ kind: 'received', amount: 997500 })).length, 1);
  t('expense row counts as expense', countsAsExpense_(fee[1]), true);
  t('transfer row does not', countsAsExpense_(fee[0]), false);
  console.log((pass === 12 ? 'PASS' : 'FAIL') + ': testLinkedEntries ' + pass + '/12');
}

/** AI answers are checked against the real wallets/categories (no Gemini call). */
function testAiParse() {
  const ctx = testCtx_();
  const now = ctx.now;
  let pass = 0;
  const t = function (name, actual, expected) { if (checkCase_(name, actual || { ok: null }, expected)) pass++; };
  t('good answer', validateAiTransaction_({ is_transaction: true, type: 'Expense', amount: 20000, wallet: 'gopay',
    date: '2026-09-24', note: 'kopi', category: 'Food' }, ctx, now),
    { ok: true, type: 'Expense', amount: 20000, wallet: 'GoPay', date: '2026-9-24', category: 'Food', categoryHow: 'keyword', readByAi: true });
  t('not a transaction', validateAiTransaction_({ is_transaction: false }, ctx, now), { ok: null });
  t('bad type', validateAiTransaction_({ is_transaction: true, type: 'Loan', amount: 5 }, ctx, now), { ok: null });
  t('no amount', validateAiTransaction_({ is_transaction: true, type: 'Expense', amount: 0 }, ctx, now), { ok: null });
  t('amount as text', validateAiTransaction_({ is_transaction: true, type: 'Expense', amount: '15.000' }, ctx, now), { amount: 15000 });
  t('unknown wallet dropped', validateAiTransaction_({ is_transaction: true, type: 'Expense', amount: 5000, wallet: 'Dana' }, ctx, now),
    { wallet: null });
  t('investment wallet dropped for expense', validateAiTransaction_({ is_transaction: true, type: 'Expense', amount: 5000,
    wallet: 'IPOT (Saham)' }, ctx, now), { wallet: null });
  t('unknown category → keyword from note', validateAiTransaction_({ is_transaction: true, type: 'Expense', amount: 5000,
    category: 'Snacks', note: 'kopi susu' }, ctx, now), { category: 'Food', categoryHow: 'keyword' });
  t('future date → today', validateAiTransaction_({ is_transaction: true, type: 'Expense', amount: 5000, date: '2027-01-01' },
    ctx, now), { date: '2026-9-25' });
  t('transfer to the same wallet dropped', validateAiTransaction_({ is_transaction: true, type: 'Transfer', amount: 5000,
    wallet: 'BCA', to_wallet: 'BCA' }, ctx, now), { wallet: 'BCA', toWallet: null });
  t('looksLikeMoney_ words', looksLikeMoney_('kopi dua puluh ribu') && looksLikeMoney_('goceng parkir'), true);
  t('looksLikeMoney_ greeting', looksLikeMoney_('hello bot'), false);
  console.log((pass === 12 ? 'PASS' : 'FAIL') + ': testAiParse ' + pass + '/12');
}

/**
 * Run from the editor when AI doesn't seem to work. Checks the key, the
 * setting, whether the model name exists (and lists the Flash models Google
 * offers), then reads a sample message. The key is never printed.
 */
function testGemini() {
  const key = getProp_(PROP.GEMINI_KEY);
  console.log((key ? 'PASS' : 'FAIL') + ': GEMINI_KEY is set');
  loadSettingsTab_(true);
  const model = getSetting_(SETTING.GEMINI_MODEL);
  console.log((getSettingYes_(SETTING.AI_ENABLED) ? 'PASS' : 'FAIL') + ': AI Enabled = ' + getSetting_(SETTING.AI_ENABLED));
  console.log('Gemini Model (Settings) = ' + model);
  if (!key) return;

  const list = UrlFetchApp.fetch(GEMINI_URL, { headers: { 'x-goog-api-key': key }, muteHttpExceptions: true });
  if (list.getResponseCode() !== 200) {
    console.log('FAIL: listing models → HTTP ' + list.getResponseCode() + ': ' + list.getContentText().slice(0, 300));
    return;
  }
  const names = (JSON.parse(list.getContentText()).models || []).map(function (m) { return m.name.replace('models/', ''); });
  const known = names.indexOf(model) !== -1;
  console.log((known ? 'PASS' : 'FAIL') + ': model "' + model + '" ' + (known ? 'exists' : 'is NOT offered to this key'));
  console.log('Flash models you can put in Settings → Gemini Model: ' +
    names.filter(function (n) { return /flash/.test(n); }).join(', '));

  const answer = callGeminiJson_('Reply with JSON only: {"ok": true}', 'test');
  console.log((answer && answer.ok === true ? 'PASS' : 'FAIL') + ': simple JSON call' +
    (answer ? '' : ' (see the newest WARN line in the Logs tab for the reason)'));

  const ai = aiParseTransaction_('kopi dua puluh ribu pakai gopay', loadCtx_(), new Date());
  const good = ai && ai.ok && ai.amount === 20000;
  console.log((good ? 'PASS' : 'FAIL') + ': "kopi dua puluh ribu pakai gopay" → ' +
    (ai && ai.ok ? ai.type + ' ' + ai.amount + ' ' + (ai.wallet || '(no wallet)') + ' ' + (ai.category || '(no category)')
      : JSON.stringify(ai)));
}

// ---------------------------------------------------------------------------
// Phase 4 tests
// ---------------------------------------------------------------------------

/** testCtx_ plus contacts (Budi has the alias "Budi Santoso"). */
function debtCtx_() {
  const ctx = testCtx_();
  ctx.contacts = [{ name: 'Budi', aliases: ['Budi Santoso'] }, { name: 'Andi', aliases: ['andi w'] },
    { name: 'Citra', aliases: [] }];
  return ctx;
}

function testDebtParser() {
  const ctx = debtCtx_();
  const people = function (r) { return r.people ? r.people.map(function (p) { return p.name + ' ' + p.amount; }).join(', ') : null; };
  const cases = [
    ['piutang 500rb Budi', { ok: true, kind: 'new', debtType: 'Piutang', name: 'Budi', known: true, amount: 500000, term: 'Short' }],
    ['piutang 500rb Budi jatuh tempo 30/10', { kind: 'new', due: '2026-10-30' }],
    ['pinjam 1jt dari Andi', { kind: 'new', debtType: 'Hutang', name: 'Andi', amount: 1000000 }],
    ['Budi pinjam 500rb', { kind: 'new', debtType: 'Piutang', name: 'Budi' }],
    ['hutang 1jt Doni', { kind: 'new', debtType: 'Hutang', name: 'Doni', known: false }],
    ['piutang 500rb doni', { name: 'doni', known: false }],
    ['piutang 500rb Budi Santoso', { name: 'Budi', known: true }],
    ['piutang jangka panjang 10jt Budi', { kind: 'new', term: 'Long', amount: 10000000 }],
    ['piutang 500rb Budi buat bayar kos', { kind: 'new', name: 'Budi', note: 'bayar kos' }],
    ['piutang 500rb Budi BCA', { wallet: 'BCA' }],
    ['pinjam 1jt dari Andi tempo 5 hari', { due: '2026-9-30' }],
    ['piutang 500rb Budi kemarin', { date: '2026-9-24' }],
    ['piutang grup 600rb Budi, Andi, Citra', { kind: 'new', group: true }],
    ['piutang grup Budi 200rb, Andi 250rb, Citra 150rb', { group: true, total: 600000 }],
    ['split 400rb makan Budi Andi termasuk saya', { kind: 'split', me: 133334, note: 'makan', category: 'Food' }],
    ['split makan Budi 150rb Andi 120rb saya 130rb', { kind: 'split', total: 400000, me: 130000 }],
    ['split 300rb Budi Andi tanpa saya', { kind: 'split', includeMe: false, me: 0 }],
    ['Budi bayar piutang 200rb', { ok: true, kind: 'pay', debtType: 'Piutang', name: 'Budi', amount: 200000 }],
    ['bayar hutang Andi 500rb', { kind: 'pay', debtType: 'Hutang', name: 'Andi', amount: 500000 }],
    ['Budi bayar 200rb', { kind: 'pay', debtType: 'Piutang', name: 'Budi' }],
    ['bayar Andi 500rb', { kind: 'pay', debtType: 'Hutang', name: 'Andi' }],
    ['Budi lunas', { kind: 'pay', full: true, amount: null, name: 'Budi' }],
    ['Budi bayar piutang 200rb kemarin ke BCA', { kind: 'pay', date: '2026-9-24', wallet: 'BCA' }],
    ['tambah piutang Budi 100rb', { kind: 'add', debtType: 'Piutang', name: 'Budi', amount: 100000 }],
    ['tutup piutang PTG-011 jadi pengeluaran', { kind: 'convert', debtType: 'Piutang', id: 'PTG-011' }],
    ['tutup hutang Andi', { kind: 'convert', debtType: 'Hutang', name: 'Andi' }],
    ['bayar PTG-010-A 100rb', { kind: 'pay', id: 'PTG-010-A', debtType: 'Piutang' }],
    ['piutang Budi', { ok: false, error: 'debt_no_amount' }],
    ['split 400rb makan', { ok: false, error: 'split_no_people' }],
    ['piutang grup 600rb Budi', { ok: false, error: 'group_few_people' }],
    ['split 500rb Budi 150rb Andi 120rb saya 130rb', { ok: false, error: 'shares_mismatch' }],
    ['tambah piutang 100rb', { ok: false, error: 'debt_no_name' }]
  ];
  let pass = 0;
  cases.forEach(function (c) { if (checkCase_('debt: ' + c[0], parseDebt_(c[0], ctx), c[1])) pass++; });
  // Group / split shares
  const t = function (name, actual, expected) { if (checkCase_(name, { v: actual }, { v: expected })) pass++; };
  t('group equal shares', people(parseDebt_('piutang grup 600rb Budi, Andi, Citra', ctx)), 'Budi 200000, Andi 200000, Citra 200000');
  t('group custom shares', people(parseDebt_('piutang grup Budi 200rb, Andi 250rb, Citra 150rb', ctx)),
    'Budi 200000, Andi 250000, Citra 150000');
  t('split equal: friends round down, I take the leftover', people(parseDebt_('split 400rb makan Budi Andi termasuk saya', ctx)),
    'Budi 133333, Andi 133333');
  // Not debts → the normal transaction parser handles them
  t('"bayar listrik 200rb" is not a debt', parseDebt_('bayar listrik 200rb', ctx), null);
  t('"50rb makan" is not a debt', parseDebt_('50rb makan', ctx), null);
  const total = cases.length + 5;
  console.log((pass === total ? 'PASS' : 'FAIL') + ': testDebtParser ' + pass + '/' + total);
}

/** Share maths (no sheet needed). */
function testShares() {
  let pass = 0;
  const t = function (name, actual, expected) { if (checkCase_(name, { v: actual }, { v: expected })) pass++; };
  const s = function (people, total, me) { return JSON.stringify(computeShares_(people, total, me)); };
  t('equal incl. me', s([{ name: 'A', amount: null }, { name: 'B', amount: null }], 400000, { amount: null }),
    JSON.stringify({ people: [{ name: 'A', amount: 133333 }, { name: 'B', amount: 133333 }], me: 133334, total: 400000 }));
  t('equal without me: leftover to the first person', s([{ name: 'A', amount: null }, { name: 'B', amount: null }], 100001, null),
    JSON.stringify({ people: [{ name: 'A', amount: 50001 }, { name: 'B', amount: 50000 }], me: 0, total: 100001 }));
  t('all custom, no total', s([{ name: 'A', amount: 150000 }], 0, { amount: 130000 }),
    JSON.stringify({ people: [{ name: 'A', amount: 150000 }], me: 130000, total: 280000 }));
  t('some custom, rest split', s([{ name: 'A', amount: 100000 }, { name: 'B', amount: null }], 300000, { amount: null }),
    JSON.stringify({ people: [{ name: 'A', amount: 100000 }, { name: 'B', amount: 100000 }], me: 100000, total: 300000 }));
  t('mismatch', JSON.parse(s([{ name: 'A', amount: 100000 }], 300000, { amount: 100000 })).error, 'shares_mismatch');
  console.log((pass === 5 ? 'PASS' : 'FAIL') + ': testShares ' + pass + '/5');
}
