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
    ['piutang Budi', { ok: true, kind: 'new', name: 'Budi', amount: null, needsAmount: true }],
    // Owner's rules (Phase 4 feedback): several names = group; "piutang split" = group; commas and a
    // full stop separate people and the note in any case; a missing amount is asked, not an error
    ['piutang 600rb Budi, Andi, Citra', { ok: true, kind: 'new', group: true, total: 600000 }],
    ['piutang split 500k melvern, kia', { ok: true, kind: 'new', group: true, total: 500000 }],
    ['piutang split kia, melvern', { ok: true, kind: 'new', group: true, needsTotal: true }],
    ['split 500k, budi, andi, aku', { ok: true, kind: 'split', total: 500000, me: 166668, category: null }],
    ['split makan. budi 100k, andi 100k, aku 200k', { ok: true, kind: 'split', note: 'makan', category: 'Food',
      total: 400000, me: 200000 }],
    ['split 300rb makan, Budi, Andi', { kind: 'split', note: 'makan', includeMe: false, total: 300000, me: 0 }],
    ['split 300rb makan, Budi, Andi, aku', { kind: 'split', includeMe: true, total: 300000, me: 100000 }],
    ['split 1jt ivan, budi', { kind: 'split', note: '', includeMe: false, total: 1000000, me: 0 }],
    ['piutang 500k aku, budi, ahok', { ok: true, kind: 'split', includeMe: true, total: 500000, me: 166668 }],
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
  t('comma names: piutang split 500k melvern, kia', people(parseDebt_('piutang split 500k melvern, kia', ctx)),
    'melvern 250000, kia 250000');
  t('comma names: split makan. budi 100k, andi 100k, aku 200k',
    people(parseDebt_('split makan. budi 100k, andi 100k, aku 200k', ctx)), 'Budi 100000, Andi 100000'); // known contacts keep their saved names
  t('first comma part is a person unless it is a keyword', people(parseDebt_('split 1jt ivan, budi', ctx)),
    'ivan 500000, Budi 500000'); // no aku/saya → I am not in the split
  t('piutang incl. me = split bill', people(parseDebt_('piutang 500k aku, budi, ahok', ctx)), 'Budi 166666, ahok 166666');
  t('several names = group', people(parseDebt_('piutang 600rb Budi, Andi, Citra', ctx)), 'Budi 200000, Andi 200000, Citra 200000');
  t('"bayar listrik 200rb" is not a debt', parseDebt_('bayar listrik 200rb', ctx), null);
  t('"50rb makan" is not a debt', parseDebt_('50rb makan', ctx), null);
  const recs = [{ id: 'HTG-001', name: 'Budi' }, { id: 'HTG-002', name: 'GMS Krista' }, { id: 'HTG-003', name: 'Kristo' }];
  t('no match: closest names first (a whole word, then typos)', sortByNameMatch_(recs, 'kriesta').map(function (r) { return r.id; }),
    ['HTG-002', 'HTG-003', 'HTG-001']);
  t('no match: "krista" is a word of "GMS Krista"', sortByNameMatch_(recs, 'krista')[0].id, 'HTG-002');
  const total = cases.length + 12;
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

/** /fav add and /fav edit parsing (no sheet needed). */
function testFavParser() {
  const ctx = testCtx_();
  ctx.userNames = ['Me', 'Partner'];
  const a = function (r) {
    if (!r.ok) return r;
    return Object.assign({}, r, { start: r.start ? testValue_(r.start) : null });
  };
  const cases = [
    ['Bayar Token Listrik 100k setiap tanggal 1 September 2026', { ok: true, name: 'Bayar Token Listrik', type: 'Expense',
      amount: 100000, valueType: 'Fixed', category: 'Bills & Utilities', schedule: 'Monthly', day: 1, start: '2026-9-1' }],
    ['Bayar cicilan mobil 100k', { ok: true, name: 'Bayar cicilan mobil', amount: 100000, schedule: '', start: null }],
    ['Belanja bulanan 200k', { ok: true, name: 'Belanja bulanan', amount: 200000, schedule: '' }],
    ['Belanja bulanan', { ok: true, name: 'Belanja bulanan', amount: null, valueType: 'Variable' }],
    ['Listrik BCA tiap bulan tgl 5', { ok: true, name: 'Listrik', wallet: 'BCA', valueType: 'Variable', schedule: 'Monthly', day: 5,
      category: 'Bills & Utilities' }],
    ['Kos 2jt tgl 31 setiap bulan', { ok: true, name: 'Kos', amount: 2000000, schedule: 'Monthly', day: 31 }],
    ['Kos 2jt tanggal 5', { ok: true, schedule: 'Monthly', day: 5 }],
    ['Token listrik 350rb variable setiap tanggal 20', { ok: true, valueType: 'Variable', amount: 350000, day: 20 }],
    ['Top up GoPay 100k dari BCA admin 1rb setiap senin', { ok: true, type: 'Transfer', name: 'Top up GoPay', wallet: 'BCA', toWallet: 'GoPay',
      fee: 1000, schedule: 'Weekly', day: 'Monday' }],
    ['Tabungan 1jt BCA ke Jago tiap tanggal 26', { ok: true, type: 'Transfer', name: 'Tabungan', wallet: 'BCA', toWallet: 'Jago', day: 26 }],
    ['Infaq 50rb every friday', { ok: true, schedule: 'Weekly', day: 'Friday', name: 'Infaq' }],
    ['Arisan 100rb tiap minggu hari sabtu', { ok: true, schedule: 'Weekly', day: 'Saturday', name: 'Arisan' }],
    ['Bayar cicilan mobil 2jt BCA keyword bayar mobil, cicilan mobil', { ok: true, name: 'Bayar cicilan mobil', amount: 2000000,
      keywords: ['bayar mobil', 'cicilan mobil'] }],
    ['Tabungan rumah 500rb Jago tiap tanggal 1', { ok: true, wallet: 'Jago', name: 'Tabungan rumah' }],
    ['Gaji 10jt BCA setiap tanggal 25', { ok: true, type: 'Income', category: 'Salary', schedule: 'Monthly', day: 25 }],
    ['Internet 300rb monthly on the 10th remind Partner', { ok: true, name: 'Internet', day: 10, remind: 'Partner' }],
    ['Internet 300rb remind Budi', { ok: false, error: 'fav_remind_unknown' }],
    ['Listrik 100k setiap tanggal 32', { ok: false, error: 'fav_bad_day' }],
    ['Listrik 100k kemarin', { ok: false, error: 'fav_date' }],
    ['100k setiap tanggal 1', { ok: false, error: 'fav_no_name' }],
    ['', { ok: false, error: 'fav_usage' }]
  ];
  let pass = 0;
  cases.forEach(function (c) { if (checkCase_('fav add: ' + c[0], a(parseFavAdd_(c[0], ctx)), c[1])) pass++; });

  const fav = { id: 'FAV-001', name: 'Bayar Token Listrik', type: 'Expense' };
  const tfav = { id: 'FAV-002', name: 'Top up GoPay', type: 'Transfer' };
  const e = function (text, f) {
    const r = parseFavEdit_(text, f || fav, ctx);
    if (!r.ok) return r;
    const ch = Object.assign({}, r.changes);
    if (ch.start) ch.start = testValue_(ch.start);
    return Object.assign({ ok: true }, ch);
  };
  const edits = [
    ['2jt', { ok: true, amount: 2000000 }],
    ['setiap tanggal 2 September', { ok: true, schedule: 'Monthly', day: 2, start: '2026-9-2' }],
    ['tanpa jadwal', { ok: true, schedule: '', day: '' }],
    ['GoPay #health admin 2.5rb', { ok: true, wallet: 'GoPay', category: 'Health', fee: 2500 }],
    ['variable', { ok: true, valueType: 'Variable' }],
    ['tanpa admin', { ok: true, fee: 0 }],
    ['remind all', { ok: true, remind: 'All' }],
    ['nama Token PLN', { ok: true, name: 'Token PLN' }],
    ['setiap rabu', { ok: true, schedule: 'Weekly', day: 'Wednesday' }],
    ['ke Cash', { ok: true, toWallet: 'Cash' }, tfav],
    ['#food', { ok: false, error: 'fav_transfer_category' }, tfav],
    ['Token PLN', { ok: true, name: 'Token PLN' }],
    ['Token PLN 150rb', { ok: true, name: 'Token PLN', amount: 150000 }],
    ['keyword bayar mobil, cicilan mobil', { ok: true, keywords: ['bayar mobil', 'cicilan mobil'] }],
    ['tanpa keyword', { ok: true, keywords: [] }],
    ['nama Token PLN plus', { ok: true, name: 'Token PLN plus' }],
    ['jadi', { ok: false, error: 'fav_edit_unclear' }]
  ];
  edits.forEach(function (c) { if (checkCase_('fav edit: ' + c[0], e(c[0], c[2]), c[1])) pass++; });

  const favs = [{ id: 'FAV-001', name: 'Belanja bulanan' }, { id: 'FAV-002', name: 'Belanja' }, { id: 'FAV-003', name: 'Listrik' },
    { id: 'FAV-004', name: 'Bayar cicilan mobil', keywords: ['bayar mobil', 'cicilan mobil'] }];
  const t = function (name, actual, expected) { if (checkCase_(name, { v: actual }, { v: expected })) pass++; };
  t('split with jadi', splitFavEdit_('belanja bulanan jadi 250rb', favs), ['belanja bulanan', '250rb']);
  t('split without jadi: longest name', splitFavEdit_('belanja bulanan 250rb', favs), ['Belanja bulanan', '250rb']);
  t('find exact beats prefix', findFavorites_(favs, 'belanja').map(function (f) { return f.id; }), ['FAV-002']);
  t('find by part', findFavorites_(favs, 'bulanan').map(function (f) { return f.id; }), ['FAV-001']);
  t('find by ID', findFavorites_(favs, 'fav-003').map(function (f) { return f.id; }), ['FAV-003']);
  t('find by keyword', findFavorites_(favs, 'Bayar  Mobil').map(function (f) { return f.id; }), ['FAV-004']);
  t('typed text = keyword', favMatchesText_(favs[3], 'cicilan mobil'), true);
  t('typed text = part of a keyword is not a match', favMatchesText_(favs[3], 'mobil'), false);
  const total = cases.length + edits.length + 8;
  console.log((pass === total ? 'PASS' : 'FAIL') + ': testFavParser ' + pass + '/' + total);
}

/** Due dates, "already answered" and the prompt window (no sheet needed). */
function testFavSchedule() {
  let pass = 0;
  const t = function (name, actual, expected) { if (checkCase_(name, { v: testValue_(actual) }, { v: expected })) pass++; };
  const D = function (y, m, d) { return new Date(y, m - 1, d); };
  const monthly = function (day, extra) { return Object.assign({ schedule: 'Monthly', day: day }, extra || {}); };
  const weekly = function (day, extra) { return Object.assign({ schedule: 'Weekly', day: day }, extra || {}); };
  const users = [{ chatId: '1', name: 'Me', active: true }, { chatId: '2', name: 'Partner', active: true }];
  t('monthly 1st, on 1 Nov', favOccurrenceOnOrBefore_(monthly(1), D(2026, 11, 1)), '2026-11-1');
  t('monthly 5th, on 1 Nov → 5 Oct', favOccurrenceOnOrBefore_(monthly(5), D(2026, 11, 1)), '2026-10-5');
  t('monthly 31st in Nov → 30 Nov', favOccurrenceOnOrBefore_(monthly(31), D(2026, 11, 30)), '2026-11-30');
  t('monthly 31st in Feb → 28 Feb', favNextOccurrence_(monthly(31), D(2027, 2, 1)), '2027-2-28');
  t('monthly "last"', favNextOccurrence_(monthly('last'), D(2026, 9, 3)), '2026-9-30');
  t('next monthly 5th from 6 Nov', favNextOccurrence_(monthly(5), D(2026, 11, 6)), '2026-12-5');
  t('weekly Monday, on Sun 1 Nov 2026 → 26 Oct', favOccurrenceOnOrBefore_(weekly('Monday'), D(2026, 11, 1)), '2026-10-26');
  t('weekly senin next from Sun 1 Nov', favNextOccurrence_(weekly('senin'), D(2026, 11, 1)), '2026-11-2');
  t('bad day → null', favOccurrenceOnOrBefore_(monthly('abc'), D(2026, 11, 1)), null);
  t('before start → nothing due', favDueOccurrence_(monthly(1, { start: D(2026, 12, 1) }), D(2026, 11, 15)), null);
  t('from start → due', favDueOccurrence_(monthly(1, { start: D(2026, 11, 1) }), D(2026, 11, 3)), '2026-11-1');
  const occ = D(2026, 11, 1);
  t('not answered', favAnswered_(monthly(1), occ), false);
  t('logged 3 days early counts', favAnswered_(monthly(1, { lastLogged: D(2026, 10, 29) }), occ), true);
  t('logged for last month does not count', favAnswered_(monthly(1, { lastLogged: D(2026, 10, 2) }), occ), false);
  t('logged late counts', favAnswered_(monthly(1, { lastLogged: D(2026, 11, 4) }), occ), true);
  t('skipped this one', favAnswered_(monthly(1, { lastSkipped: D(2026, 11, 1) }), occ), true);
  t('skipped last month only', favAnswered_(monthly(1, { lastSkipped: D(2026, 10, 1) }), occ), false);
  t('ordinal', [1, 2, 3, 4, 11, 12, 13, 21, 22, 31].map(ordinal_).join(' '), '1st 2nd 3rd 4th 11th 12th 13th 21st 22nd 31st');
  t('recipients: All', favRecipients_({ remind: 'All' }, users), ['1', '2']);
  t('recipients: Partner', favRecipients_({ remind: 'partner' }, users), ['2']);
  t('ymd round trip', fromYmd_(ymd_(D(2026, 11, 1))), '2026-11-1');
  t('same Chat ID on two Users rows → reminded once', favRecipients_({ remind: 'All' },
    [{ chatId: '1', name: 'Me', active: true }, { chatId: '1', name: 'Partner', active: true }]), ['1']);
  console.log((pass === 22 ? 'PASS' : 'FAIL') + ': testFavSchedule ' + pass + '/22');
}

/** Which debt reminders go out on which day, and to whom (no sheet needed). */
function testReminders() {
  let pass = 0;
  const t = function (name, actual, expected) { if (checkCase_(name, { v: actual }, { v: expected })) pass++; };
  const D = function (y, m, d) { return new Date(y, m - 1, d, 8, 15); };
  const plan = function (date) {
    const p = reminderPlan_(date, 'Monday', 1);
    return (p.daily ? 'D' : '') + (p.weekly ? 'W' : '') + (p.monthly ? 'M' : '');
  };
  t('Tue 3 Nov 2026 = daily', plan(D(2026, 11, 3)), 'D');
  t('Mon 2 Nov 2026 = weekly', plan(D(2026, 11, 2)), 'W');
  t('Sun 1 Nov 2026 = monthly', plan(D(2026, 11, 1)), 'M');
  t('Mon 1 Feb 2027 = weekly + monthly merged', plan(D(2027, 2, 1)), 'WM');
  t('monthly date 31 in Nov → the 30th', reminderPlan_(D(2026, 11, 30), 'Monday', 31).monthly, true);

  const now = D(2026, 11, 3);
  const rec = function (id, extra) {
    return Object.assign({ id: id, parent: '', type: 'Piutang', term: 'Short', name: 'Budi', status: 'Open', remaining: 100000,
      start: D(2026, 10, 25), due: null, snoozed: null }, extra || {});
  };
  const debts = [
    rec('PTG-001'),                                            // open 9 days, no due date → weekly only
    rec('PTG-002', { start: D(2026, 11, 2) }),                 // open 1 day → no
    rec('PTG-003', { due: D(2026, 11, 5) }),                   // due in 2 days → yes
    rec('PTG-004', { due: D(2026, 11, 30) }),                  // due in 27 days → no
    rec('HTG-001', { type: 'Hutang', due: D(2026, 10, 30) }),  // overdue → yes
    rec('PTG-005', { term: 'Long' }),                          // long-term → monthly only
    rec('PTG-006', { snoozed: D(2026, 11, 3) }),               // snoozed until today → no
    rec('PTG-007', { snoozed: D(2026, 11, 2), due: D(2026, 11, 4) }), // snooze over → yes
    rec('PTG-008', { status: 'Paid' }),                        // closed → no
    rec('PTG-010', { name: 'Budi, Andi' }),                    // group parent → monthly only
    rec('PTG-010-A', { parent: 'PTG-010', name: 'Budi' }),
    rec('PTG-010-B', { parent: 'PTG-010', name: 'Andi', status: 'Paid' })
  ];
  const due = debts.filter(function (d) { return dailyDue_(d, debts, now, 3); }).map(function (d) { return d.id; });
  t('daily picks due-soon and overdue only, not snoozed', due, ['PTG-003', 'HTG-001', 'PTG-007']);
  const top = debts.filter(function (d) { return !d.parent; });
  const daily = buildDailyReminder_(top, debts, now, 3, false);
  t('daily message ids', daily.ids, ['PTG-003', 'HTG-001', 'PTG-007']);
  t('overdue shown', daily.text.indexOf('overdue 4 days') !== -1, true);
  const monthly = buildSummaryReminder_(top, debts, now, { weekly: false, monthly: true }, false);
  t('monthly = long-term + groups', monthly.ids, ['PTG-005', 'PTG-010']);
  t('monthly lists open group members only', monthly.text.indexOf('PTG-010-A') !== -1 && monthly.text.indexOf('PTG-010-B') === -1, true);
  const weekly = buildSummaryReminder_(top, debts, now, { weekly: true, monthly: false }, false);
  t('weekly = every open record', weekly.ids.length, 9);
  t('nothing open → no message', buildSummaryReminder_([], debts, now, { weekly: true }, false), null);

  const owners = debtOwners_([{ 'debt id': 'PTG-001', 'logged by': 'Me' }, { 'debt id': 'PTG-010-A', 'logged by': 'Partner' },
    { 'debt id': 'PTG-001', 'logged by': 'Partner' }]);
  t('owner = first row', owners['PTG-001'], 'Me');
  t('group owner from a sub-record row', owners['PTG-010'], 'Partner');
  const users = [{ chatId: '1', name: 'Me', active: true }, { chatId: '2', name: 'Partner', active: true }];
  const per = debtsByRecipient_([rec('PTG-001'), rec('PTG-010'), rec('PTG-099')], owners, users);
  t('records go to their owner; unknown → both', [per['1'].map(function (d) { return d.id; }), per['2'].map(function (d) { return d.id; })],
    [['PTG-001', 'PTG-099'], ['PTG-010', 'PTG-099']]);
  t('hour parse', [parseHour_('08:00'), parseHour_('18'), parseHour_('x')], [8, 18, 8]);
  const dup = debtsByRecipient_([rec('PTG-099')], owners, [{ chatId: '1', name: 'Me', active: true }, { chatId: '1', name: 'Partner', active: true }]);
  t('same Chat ID twice → record listed once', dup['1'].map(function (d) { return d.id; }), ['PTG-099']);
  // One morning message: one item keeps its buttons, two or more = plain list
  const fav1 = { fav: { id: 'FAV-001', name: 'Listrik', type: 'Expense', valueType: 'Fixed', amount: 150000, category: 'Bills', wallet: 'BCA', fee: 0 }, occ: D(2026, 11, 3) };
  const fav2 = { fav: { id: 'FAV-002', name: 'Kos', type: 'Expense', valueType: 'Fixed', amount: 2000000, category: 'Bills', wallet: 'BCA', fee: 0 }, occ: D(2026, 11, 1) };
  const one = buildMorningMessage_([fav1], null, now);
  t('one favorite → its buttons', [!!one.markup, one.favButtons], [true, true]);
  const oneDebt = buildMorningMessage_([], { kind: 'daily', text: 'x', ids: ['PTG-003'] }, now);
  t('one daily debt → snooze button', oneDebt.markup.inline_keyboard[0][0].callback_data, 'S|PTG-003');
  const two = buildMorningMessage_([fav1, fav2], { kind: 'daily', text: '⏰ due', ids: ['PTG-003'] }, now);
  t('several → one list, no buttons', [two.markup, two.text.indexOf('Listrik') !== -1 && two.text.indexOf('Kos') !== -1 && two.text.indexOf('⏰ due') !== -1], [undefined, true]);
  t('nothing → no message', buildMorningMessage_([], null, now), null);
  console.log((pass === 21 ? 'PASS' : 'FAIL') + ': testReminders ' + pass + '/21');
}

/** Investment test data: wallets typed Saham / Emas / Others, and purchase rows (stocks in lots, prices per lembar). */
function invTestCtx_() {
  const ctx = testCtx_();
  ctx.wallets = ctx.wallets.map(function (w) { return w.name === 'Saham' ? Object.assign({}, w, { kind: 'Saham' }) : w; })
    .concat([{ name: 'Emas', group: 'Investment', type: 'Investment', kind: 'Emas', active: true },
      { name: 'Reksadana', group: 'Investment', type: 'Investment', kind: 'Others', active: true }]);
  const row = function (id, asset, cat, unit, qty, price, extra) {
    const m = unit === 'lot' ? 100 : 1;
    return Object.assign({ id: id, link: '', date: new Date(2026, 0, Number(id.slice(-2))), category: cat, invWallet: cat, asset: asset, platform: '',
      unit: unit, qty: qty, price: price, cost: qty * m * price, current: null, lastUpdate: null, source: 'BCA', status: 'Holding',
      holding: qty > 0, row: Number(id.slice(-2)) + 1 }, extra || {});
  };
  ctx.investments = [
    row('INV-0001', 'BBCA', 'Saham', 'lot', 3, 9500, { source: 'IPOT (Saham)', cost: 4 * 100 * 9500, status: 'Partially Sold' }),
    row('INV-0002', 'BBCA', 'Saham', 'lot', 2, 9800, { current: 9900 }),
    row('INV-0003', 'Antam', 'Emas', 'gram', 2, 1350000),
    row('INV-0004', 'RDPU X', 'Reksadana', 'unit', 1000.5, 1520.35),
    row('INV-0005', 'TLKM', 'Saham', 'lot', 0, 3000, { status: 'Sold', holding: false, cost: 5 * 100 * 3000 })
  ];
  ctx.sales = [
    { saleId: 'SAL-0001', invId: 'INV-0001', date: new Date(2026, 8, 20), qty: 1, price: 10000, fee: 0 },
    { saleId: 'SAL-0002', invId: 'INV-0005', date: new Date(2026, 7, 1), qty: 5, price: 3200, fee: 5000 }
  ];
  return ctx;
}

/** Investment numbers, buy/sell parsing and /inv update parsing (no sheet needed). */
function testInvParser() {
  const ctx = invTestCtx_();
  let pass = 0;
  const t = function (name, actual, expected) { if (checkCase_(name, { v: actual }, { v: expected })) pass++; };
  // Numbers, formats and spacing
  t('numbers', ['1.350rb', '1,5jt', '9.800', '1.520,35', '150,5', '0.005', '1.000', '50,000', 'rp2.700rb', '0,5'].map(parseInvNumber_),
    [1350000, 1500000, 9800, 1520.35, 150.5, 0.005, 1000, 50000, 2700000, 0.5]);
  t('format', [formatNumId_(1520.35, 2), formatQty_(150.5, 'unit'), formatQty_(2, 'lot'), formatInvPrice_(9800, 'lot'),
    formatInvPrice_(1350000, 'gram')], ['1.520,35', '150,5 unit', '2 lot', 'Rp9.800/lembar', 'Rp1.350.000/gr']);
  t('spacing', [normalizeInvText_('Emas 3 jt/ gr'), normalizeInvText_('beli emas 2 gr Rp 1,4 jt / gr')],
    ['Emas 3jt/gr', 'beli emas 2 gr Rp1,4jt/gr']);
  t('unit from the wallet type', [unitFor_(ctx.wallets, 'Emas', '', ''), unitFor_(ctx.wallets, 'Saham', '', 'share'),
    unitFor_(ctx.wallets, 'Reksadana', '', ''), unitFor_(ctx.wallets, 'Reksadana', '', 'coin'), unitFor_(ctx.wallets, '', '', 'share')],
    ['gram', 'lot', 'unit', 'coin', 'lot']);

  // Buy: parse, then work out the numbers (as advanceBuy_ does)
  const buy = function (text) {
    const r = parseInvestment_(text, ctx);
    if (!r || !r.ok) return r;
    const d = Object.assign({}, r, { in: { qty: r.qty, qtyUnit: r.qtyUnit, price: r.price, priceSuffix: r.priceSuffix, total: r.total,
      bare: r.bare, plain: r.plain } });
    d.unit = d.unit || 'unit';
    resolveInvNumbers_(d);
    return { kind: d.kind, asset: d.asset, category: d.category, unit: d.unit, qty: d.qty, price: d.priceStored, total: d.total,
      fee: d.fee, wallet: d.wallet, platform: d.platform };
  };
  const cases = [
    ['beli emas 2gr 1.350rb/gr', { asset: 'Emas', category: 'Emas', unit: 'gram', qty: 2, price: 1350000, total: 2700000 }],
    ['beli emas 2gr total 2.700rb', { qty: 2, price: 1350000, total: 2700000 }],
    ['beli emas 2.700rb harga 1.350rb/gr', { qty: 2, price: 1350000, total: 2700000 }],
    ['beli emas 2gr 2.7jt', { qty: 2, price: 1350000, total: 2700000 }],                 // a value on its own = total
    ['beli emas 2 gr 1,4 jt/ gr', { qty: 2, price: 1400000, total: 2800000 }],           // spaces around the unit
    ['beli Antam 0,5gr 1.4jt/gr dari BCA', { asset: 'Antam', category: 'Emas', unit: 'gram', qty: 0.5, total: 700000, wallet: 'BCA' }],
    ['beli BBCA 2 lot 9.800/lembar', { asset: 'BBCA', unit: 'lot', qty: 2, price: 9800, total: 1960000 }],
    ['beli BBCA 2 lot 1.960rb', { unit: 'lot', qty: 2, price: 9800, total: 1960000 }],
    ['beli BBCA 200 lembar harga 9.800 fee 3rb dari IPOT', { qty: 2, price: 9800, total: 1960000, fee: 3000, wallet: 'IPOT (Saham)' }],
    ['beli BBCA 200 lbr @9.800', { qty: 2, price: 9800, total: 1960000 }],               // lbr = lembar
    ['beli BBCA 1 lot 9.800/lbr', { qty: 1, price: 9800, total: 980000 }],
    ['beli BBCA 1 lot 980rb/lot', { qty: 1, price: 9800, total: 980000 }],
    ['beli RDPU X 150,5 unit @1.520 via Bibit', { asset: 'RDPU X', unit: 'unit', qty: 150.5, price: 1520, total: 228760, platform: 'Bibit' }],
    ['beli RDPU X 1jt harga 1.520,35', { qty: 657.7432828, total: 1000000 }],
    ['beli GOTO 10 lot @70 dari BCA', { asset: 'GOTO', category: '', unit: 'lot', qty: 10, price: 70, total: 70000 }],
    ['beli emas kemarin 1gr 1.4jt/gr', { qty: 1, total: 1400000 }]
  ];
  cases.forEach(function (c) { if (checkCase_('buy: ' + c[0], buy(c[0]) || {}, c[1])) pass++; });
  t('"beli kopi 20rb" is not an investment', parseInvestment_('beli kopi 20rb', ctx), null);
  t('"50rb makan" is not an investment', parseInvestment_('50rb makan', ctx), null);
  t('beli BBCA without numbers asks later', buy('beli BBCA').qty, null);
  t('"beli kopi 250gr 50rb" stays an expense', parseInvestment_('beli kopi 250gr 50rb', ctx), null);
  t('a new coin with a price per coin is an investment', [buy('beli BTC 0,01 coin 15jt/coin').qty, buy('beli BTC 0,01 coin 15jt/coin').asset],
    [0.01, 'BTC']);

  // Investment wallets with a category from Settings: two stock wallets share "Saham"
  const ctx2 = invTestCtx_();
  ctx2.wallets = ctx2.wallets.filter(function (w) { return w.name !== 'Saham'; }).concat([{ name: 'IPOT Saham', group: 'Investment', type: 'Investment', kind: 'Saham', invCategory: 'Saham', active: true },
    { name: 'Ajaib', group: 'Investment', type: 'Investment', kind: 'Saham', invCategory: 'Saham', active: true }]);
  const byWallet = parseInvestment_('beli BBRI 1 lot 4.000/lbr ajaib', ctx2);
  t('wallet named → category from the wallet', [byWallet.invWallet, byWallet.category, byWallet.unit], ['Ajaib', 'Saham', 'lot']);
  const byCat = parseInvestment_('beli saham BBRI 1 lot 4.000/lbr', ctx2);
  t('category named → asks which of its wallets', [byCat.invWallet, byCat.category, byCat.invWalletChoices], ['', 'Saham', ['IPOT Saham', 'Ajaib']]);
  ctx2.wallets.push({ name: 'Bibit', group: 'Investment', type: 'Investment', kind: 'Others', invCategory: 'Reksadana, Crypto',
    invCategories: ['Reksadana', 'Crypto'], active: true });
  t('a wallet with several categories → the category is asked', parseInvestment_('beli RDPU Y 100 unit @1.000 bibit', ctx2).category, '');
  t('…unless the message names it', parseInvestment_('beli crypto BTC 0,01 coin 15jt/coin bibit', ctx2).category, 'Crypto');
  t('a known asset keeps its wallet and category', [parseInvestment_('beli BBCA 1 lot 9.800/lbr', ctx2).invWallet, parseInvestment_('beli BBCA 1 lot 9.800/lbr', ctx2).category], ['Saham', 'Saham']);

  // Sell
  const sell = function (text) {
    const r = parseInvestment_(text, ctx);
    return r && r.ok ? { kind: r.kind, asset: r.asset, unit: r.unit, qty: r.qty, qtyUnit: r.qtyUnit, price: r.price, bare: r.bare, all: r.all,
      wallet: r.wallet } : r;
  };
  t('sell parse', sell('jual BBCA 5 lot harga 10.200 ke BCA'), { kind: 'sell', asset: 'BBCA', unit: 'lot', qty: 5, qtyUnit: 'lot',
    price: 10200, bare: [], all: false, wallet: 'BCA' });
  t('sell in lbr with a total', [sell('jual BBCA 100 lbr 1jt ke BCA').qtyUnit, sell('jual BBCA 100 lbr 1jt ke BCA').bare], ['share', [1000000]]);
  t('sell all of a category with one asset', sell('jual semua emas 1.4jt/gr ke BCA').asset, 'Antam');
  t('sell unknown asset', sell('jual XYZ 1 lot 100').error, 'inv_unknown_asset');

  // FIFO (lots; prices per lembar)
  const bbca = ctx.investments.filter(function (x) { return x.asset === 'BBCA'; });
  const fifo = allocateSale_(bbca, 4, null);
  t('FIFO takes the oldest first', fifo.parts.map(function (p) { return p.inv.id + ':' + p.qty; }), ['INV-0001:3', 'INV-0002:1']);
  t('picked row', allocateSale_(bbca, 1, 'INV-0002').parts.map(function (p) { return p.inv.id + ':' + p.qty; }), ['INV-0002:1']);
  t('too much', allocateSale_(bbca, 6, null).error, 'inv_too_much');
  t('picked row too small', allocateSale_(bbca, 3, 'INV-0002').held, 2);
  t('realized gain (lot × 100 × price)', saleGain_(fifo.parts, 10200, 5000), 3 * 100 * 700 + 1 * 100 * 400 - 5000);

  // /inv update
  const up = parseInvUpdate_('BBCA 10.200\nEmas 3 jt/ gr\nRDPU X 1.530,5\nXYZ 100\nnonsense', ctx.investments);
  t('update items', up.items.map(function (it) { return it.name + ' ' + it.price + ' x' + it.rows.length; }),
    ['BBCA 10200 x2', 'Emas 3000000 x1', 'RDPU X 1530.5 x1']);
  t('update unknown / unreadable', [up.unknown, up.bad], [['XYZ'], ['nonsense']]);
  t('sold assets are not updated', parseInvUpdate_('TLKM 3.100', ctx.investments).unknown, ['TLKM']);
  t('price "/lot" ÷100, "/lbr" as is', [parseInvUpdate_('BBCA 1.020rb/lot', ctx.investments).items[0].price,
    parseInvUpdate_('BBCA 10.200/lbr', ctx.investments).items[0].price], [10200, 10200]);
  const total = 27 + cases.length;
  console.log((pass === total ? 'PASS' : 'FAIL') + ': testInvParser ' + pass + '/' + total);
}

/** /inv text (held items only), the Investments-tab numbers, the price reminder and wallet groups (no sheet needed). */
function testInvReport() {
  const ctx = invTestCtx_();
  let pass = 0;
  const t = function (name, actual, expected) { if (checkCase_(name, { v: actual }, { v: expected })) pass++; };
  const sum = invSummary_(ctx.investments, ctx.sales);
  t('categories', sum.map(function (c) { return c.name; }), ['Emas', 'Reksadana', 'Saham']);
  const bbca = sum[2].assets.filter(function (a) { return a.name === 'BBCA'; })[0];
  t('BBCA held lots / value (lot × 100 × price)', [bbca.qty, Math.round(bbca.value)], [5, 3 * 100 * 9500 + 2 * 100 * 9900]);
  t('BBCA sold / realized', [bbca.soldQty, bbca.realized], [1, 1 * 100 * 500]);
  const tlkm = sum[2].assets.filter(function (a) { return a.name === 'TLKM'; })[0];
  t('fully sold asset keeps its realized gain (Investments tab)', [tlkm.qty, tlkm.realized], [0, 5 * 100 * 200 - 5000]);
  const text = buildInvText_(ctx.investments, '', false).text;
  t('/inv: held items, avg buy → now per lembar', [text.indexOf('<b>BBCA</b> · 5 lot') !== -1,
    text.indexOf('avg Rp9.620 → now Rp9.660/lembar') !== -1, text.indexOf('<b>Antam</b> · 2 gr') !== -1], [true, true, true]);
  t('/inv: no sold / realized lines, sold-out items hidden', [text.indexOf('sold') === -1, text.indexOf('TLKM') === -1,
    text.indexOf('realized') === -1], [true, true, true]);
  t('filter by asset', buildInvText_(ctx.investments, 'antam', false).text.indexOf('<b>Antam</b> · 2 gr') !== -1, true);
  t('unknown filter', buildInvText_(ctx.investments, 'xyz', false).error, 'inv_filter');
  t('hidden amounts', buildInvText_(ctx.investments, '', true).text.indexOf('<tg-spoiler>') !== -1, true);
  const rem = buildPriceReminderText_(ctx.investments);
  t('reminder lists held assets with typeable prices', [rem.indexOf('BBCA 9.900') !== -1, rem.indexOf('BBCA 9.900/') === -1,
    rem.indexOf('Antam 1.350.000/gr') !== -1, rem.indexOf('TLKM') === -1], [true, true, true, true]);
  t('nothing held → no reminder', buildPriceReminderText_([]), null);
  t('last day of month', [isLastDayOfMonth_(new Date(2026, 10, 30)), isLastDayOfMonth_(new Date(2026, 10, 29)), isLastDayOfMonth_(new Date(2027, 1, 28))],
    [true, false, true]);
  t('wallet types', ['Emas', 'saham', 'Others', 'Investment', 'Cash', ''].map(walletKind_), ['Emas', 'Saham', 'Others', 'Others', '', '']);
  // Several groups per wallet
  const bca = { name: 'BCA', type: 'Cash', active: true, group: 'Spending', groups: splitGroups_('Spending, Investment Wallet') };
  const ipot = { name: 'IPOT', type: 'Cash', active: true, group: 'Investment', groups: splitGroups_('Investment, Investment Wallet') };
  t('groups split', bca.groups, ['Spending', 'Investment Wallet']);
  t('"Spending, Investment Wallet" still spends; IPOT stays an investment wallet',
    [isInvestmentWallet_(bca, ['investment']), isInvestmentWallet_(ipot, ['investment']),
      spendingWallets_([bca, ipot], ['investment'], ['spending']).map(function (w) { return w.name; })], [false, true, ['BCA']]);
  console.log((pass === 15 ? 'PASS' : 'FAIL') + ': testInvReport ' + pass + '/15');
}

/** Bill photo logic: reading Gemini's answer, routing, receipts, split-bill helpers (no sheet or AI needed). */
function testOcr() {
  const ctx = testCtx_();
  ctx.wallets = ctx.wallets.map(function (w) { return w.name === 'GoPay' ? Object.assign({}, w, { receiptIssuer: 'GoPay' }) : w; });
  const now = ctx.now; // 25 Sep 2026 10:30
  let pass = 0;
  const t = function (name, actual, expected) { if (checkCase_(name, { v: actual }, { v: expected })) pass++; };
  const receipt = normalizeOcr_({ readable: true, issuer: 'Indomaret', merchant: 'Indomaret Kemang', date: '2026-09-24',
    date_confidence: 0.95, subtotal: 170000, tax: 15500, total: '185.500', total_confidence: 0.92, items: ['Beras', 'Minyak'] });
  t('normalize: "185.500" → 185500, numbers rounded', [receipt.total, receipt.subtotal, receipt.items.length], [185500, 170000, 2]);
  t('normalize: nothing usable', normalizeOcr_(null), null);
  const split = normalizeOcr_({ issuer: 'GoPay', merchant: 'Sate Khas Senayan', is_split_bill: true, total: 300000, payer: 'Daniel Ivan',
    participants: [{ name: 'Daniel Ivan', amount: 100000, confidence: 0.9 }, { name: 'Budi Santoso', amount: 120000 }, { name: 'Citra', amount: 80000 }] });
  t('route: GoPay + participants → split', ocrRoute_(split, ''), 'split');
  t('route: a plain receipt → receipt', ocrRoute_(receipt, ''), 'receipt');
  const gofood = normalizeOcr_({ issuer: 'GoPay', merchant: 'GoFood · Bakmi GM', total: 65000 });
  t('route: GoPay payment receipt (no participants) → receipt', ocrRoute_(gofood, ''), 'receipt');
  t('route: caption "bill" forces the receipt flow', ocrRoute_(split, 'bill BCA'), 'receipt');
  t('route: caption "split" needs a participant list', ocrRoute_(receipt, 'split'), 'receipt');
  // Totals
  t('one total when subtotal + tax = total', receiptTotalCandidates_(receipt), [185500]);
  t('several totals when they do not add up', receiptTotalCandidates_(normalizeOcr_({ subtotal: 100000, tax: 11000, total: 121000 })),
    [121000, 111000]);
  t('other candidates from Gemini', receiptTotalCandidates_(normalizeOcr_({ total: 50000, other_totals: [55000, 50000] })), [50000, 55000]);
  // Wallet by receipt issuer
  t('issuer → wallet', issuerWallets_(ctx.wallets, 'GoPay GoFood').map(function (w) { return w.name; }), ['GoPay']);
  t('no issuer match', issuerWallets_(ctx.wallets, 'Indomaret'), []);
  // Receipt draft
  const d1 = buildReceiptDraft_(receipt, '', ctx, now, { fileId: 'F1' }).d;
  t('receipt draft', [d1.type, d1.amount, d1.note, testValue_(new Date(d1.date)), d1.inputSource, d1.ocrWarnings.length, d1.image.fileId],
    ['Expense', 185500, 'Indomaret Kemang', '2026-9-24', 'OCR-Receipt', 0, 'F1']);
  const d2 = buildReceiptDraft_(receipt, 'BCA #health 150rb kemarin obat', ctx, now).d;
  t('caption overrides amount, wallet, category, date, adds to the note',
    [d2.amount, d2.wallet, d2.category, testValue_(new Date(d2.date)), d2.note], [150000, 'BCA', 'Health', '2026-9-24', 'Indomaret Kemang · obat']);
  const d3 = buildReceiptDraft_(gofood, '', ctx, now).d;
  t('GoPay receipt → GoPay wallet from Receipt Issuer, dated today', [d3.wallet, d3.walletHow, testValue_(new Date(d3.date))],
    ['GoPay', 'issuer', '2026-9-25']);
  const low = buildReceiptDraft_(normalizeOcr_({ merchant: 'Toko', total: 99000, total_confidence: 0.6, date: '2026-09-20', date_confidence: 0.5 }),
    '', ctx, now).d;
  t('low confidence (< 80%) warnings for total and date', low.ocrWarnings.length, 2);
  const many = buildReceiptDraft_(normalizeOcr_({ merchant: 'Resto', subtotal: 100000, tax: 11000, total: 121000 }), '', ctx, now).d;
  t('several totals → asked', [many.amount, many.amountOptions], [null, [121000, 111000]]);
  t('caption with an unknown tag keeps the receipt', buildReceiptDraft_(receipt, '#zzz', ctx, now).d.unknownTag, 'zzz');
  const kw = buildReceiptDraft_(normalizeOcr_({ merchant: 'Apotek K-24', items: ['obat batuk'], total: 30000 }), '', ctx, now).d;
  t('category from items keywords', kw.category, 'Health');
  // Split helpers
  t('find me by GoPay name', findMeIndexes_(split.participants, 'daniel  ivan'), [0]);
  t('nobody matches', findMeIndexes_(split.participants, ''), []);
  t('\"Me\" in the list is me', findMeIndexes_([{ name: 'GMS Krista' }, { name: 'Me' }], ''), [1]);
  t('a split screen without the GoPay name → split', ocrRoute_(normalizeOcr_({ merchant: 'BANG ALI SIMP', is_split_bill: true, total: 400400,
    participants: [{ name: 'Me', amount: 80300 }, { name: 'kia', amount: 71500 }] }), ''), 'split');
  const rows = [{ 'trx id': 'TRX-0001', amount: 185500, date: new Date(2026, 8, 24, 9), note: 'Indomaret Kemang' }];
  t('receipt duplicate: same total + merchant + date, any time', (findReceiptDuplicate_(rows, d1) || {})['trx id'], 'TRX-0001');
  t('different date → not a duplicate', findReceiptDuplicate_(rows, Object.assign({}, d1, { date: now.getTime() })), null);
  t('Drive id from a link', [driveIdFromUrl_('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view'), driveIdFromUrl_('x')],
    ['1AbCdEfGhIjKlMnOp', '']);
  // Google OCR text read by rules (the owner's split screen, in both layouts the OCR can return)
  const shares = [['Me', 80300], ['GMS Krista', 8800], ['natan', 61600], ['kia', 71500], ['sarrel', 22000],
    ['kelun', 67100], ['rani', 33000], ['resting', 40700], ['valen', 15400]];
  const rp = formatRp_;
  const rowsText = ['19:42', 'Split bill', 'BANG ALI SIMP', '29 Oct 2026, 19:30', 'Total amount Rp400.400', '9 members']
    .concat(shares.map(function (s) { return s[0].charAt(0).toUpperCase() + '\n' + s[0] + ' ' + rp(s[1]); })).join('\n');
  const s1 = normalizeOcr_(parseOcrText_(rowsText));
  t('rules: split screen, one row per line', [s1.merchant, s1.date, s1.total, s1.participants.length, s1.participants[1].name,
    s1.participants[1].amount, ocrRoute_(s1, '')], ['BANG ALI SIMP', '2026-10-29', 400400, 9, 'GMS Krista', 8800, 'split']);
  const colText = ['Split bill', 'BANG ALI SIMP', '29 Oct 2026', 'Total amount', 'Rp400.400', '9 members', 'M']
    .concat(shares.map(function (s) { return s[0]; })).concat(shares.map(function (s) { return rp(s[1]); })).join('\n');
  const s2 = normalizeOcr_(parseOcrText_(colText));
  t('rules: split screen, names and amounts in two columns', [s2.total, s2.participants.length, s2.participants[0].name,
    s2.participants[8].name, s2.participants[8].amount, s2.participants[0].confidence], [400400, 9, 'Me', 'valen', 15400, 1]);
  const r1 = normalizeOcr_(parseOcrText_(['INDOMARET', 'JL. KEMANG RAYA 12', '24/09/2026 18:02', 'BERAS 5KG 1 70.000',
    'MINYAK 2L 1 35.500', 'SUB TOTAL 105.500', 'PPN 11.605', 'TOTAL 117.105', 'TUNAI 150.000', 'KEMBALI 32.895'].join('\n')));
  t('rules: receipt → TOTAL, not subtotal / cash / change', [r1.merchant, r1.date, r1.total, r1.subtotal, r1.participants.length,
    ocrRoute_(r1, '')], ['INDOMARET', '2026-09-24', 117105, 105500, 0, 'receipt']);
  const r2 = normalizeOcr_(parseOcrText_('Kopi Kenangan\nTotal Item 2\nGrand Total\nRp 56,000.00\nTotal 50.000\nGoPay'));
  t('rules: Grand Total beats Total, label and amount on two lines, issuer', [r2.total, r2.issuer], [56000, 'GoPay']);
  t('rules: nothing found → AI / ask for the amount', ocrRulesOk_(normalizeOcr_(parseOcrText_('Terima kasih\nSelamat datang'))), false);
  t('amounts', ['Rp80.300', '85,500', '1.500,00', '85500', 'Rp 9.800.000', 'abc'].map(ocrAmount_), [80300, 85500, 1500, 85500, 9800000, null]);
  // Owner's real read: the avatar initials "MGNKS KRR +1" came through, "Me" did not → the first row is Me (GoPay's fixed layout)
  const others = shares.slice(1);
  const s3 = normalizeOcr_(parseOcrText_(['BANG ALI SIMP', '29 Oct 2026', 'Total amount', 'Rp400.400', '9 members', 'MGNKS KRR +1']
    .concat(others.map(function (s) { return s[0]; })).concat(shares.map(function (s) { return rp(s[1]); })).join('\n')));
  t('rules: avatar initials skipped, missing "Me" is the first row', [s3.participants.length, s3.participants[0].name,
    s3.participants[0].amount, s3.participants[1].name, findMeIndexes_(s3.participants, '')], [9, 'Me', 80300, 'GMS Krista', [0]]);
  const s4 = normalizeOcr_(parseOcrText_(['BANG ALI SIMP', '29 Oct 2026', 'Total amount Rp400.400', '9 members', 'MGNKS KRR +1 Rp80.300']
    .concat(others.map(function (s) { return s[0] + ' ' + rp(s[1]); })).join('\n')));
  t('rules: avatar initials on the first row (one line per row) → Me', [s4.participants.length, s4.participants[0].name], [9, 'Me']);
  console.log((pass === 34 ? 'PASS' : 'FAIL') + ': testOcr ' + pass + '/34');
}
