/**
 * Template.gs — builds the main sheet from scratch (createTemplate) and
 * checks that a sheet has every tab and column the bot needs (validateSheet).
 *
 * One schema (getSchema_) drives both, so they can never disagree.
 *
 * Formula columns have a GREEN header. Their header cell holds the formula
 * itself, e.g. ={"Current Balance"; MAP(...)}, which fills the whole column,
 * so rows you add by hand calculate automatically and sorting can't break it.
 * These columns are protected with a warning. Everything else (IDs, statuses,
 * snapshots) is written by the script or by you.
 */

const FMT = {
  RP: '"Rp"#,##0',
  DATE: 'yyyy-mm-dd',
  DATETIME: 'yyyy-mm-dd hh:mm',
  PCT: '0.00%',
  MONTH: 'mmm yyyy',
  TEXT: '@'
};

const HEADER_BG = '#dbe5f1';
const FORMULA_HEADER_BG = '#d9ead3';

/**
 * Every tab and its columns, in order. Column options:
 *   h        header name (the bot finds columns by this name); '' = spacer
 *   w        column width in pixels
 *   fmt      number format for the data rows
 *   list     fixed dropdown values
 *   ref      dropdown from another column: [tab, header]
 *   formula  function(r) → expression that fills rows 2+. r(tab, header)
 *            returns that column's data range, e.g. 'Wallets'!A2:A
 */
function getSchema_() {
  const T = TAB;
  return [
    { name: T.DASHBOARD, columns: [] },

    { name: T.TRANSACTIONS, columns: [
      { h: 'Trx ID', w: 90 },
      { h: 'Link ID', w: 90 },
      { h: 'Date', fmt: FMT.DATETIME, w: 130 },
      { h: 'Logged By', ref: [T.SETTINGS, 'Display Name'] },
      { h: 'Type', list: LISTS.TRX_TYPES, w: 110 },
      { h: 'Amount', fmt: FMT.RP },
      { h: 'Direction', list: LISTS.DIRECTIONS, w: 90 },
      { h: 'Category', ref: [T.CATEGORIES, 'Category'], w: 140 },
      { h: 'Category Source', list: LISTS.CATEGORY_SOURCES },
      { h: 'Wallet', ref: [T.WALLETS, 'Wallet'] },
      { h: 'Wallet Group', formula: function (r) {
        return 'ARRAYFORMULA(IF(' + r(T.TRANSACTIONS, 'Wallet') + '="",,IFERROR(VLOOKUP(' +
          r(T.TRANSACTIONS, 'Wallet') + ',{' + r(T.WALLETS, 'Wallet') + ',' + r(T.WALLETS, 'Wallet Group') +
          '},2,FALSE))))';
      } },
      { h: 'To Wallet', ref: [T.WALLETS, 'Wallet'] },
      { h: 'Note', w: 250 },
      { h: 'Debt ID', w: 90 },
      { h: 'Inv ID', w: 90 },
      { h: 'Favorite ID', w: 90 },
      { h: 'Input Source', list: LISTS.INPUT_SOURCES, w: 100 },
      { h: 'Image Link', w: 150 },
      { h: 'Month Status', w: 110, formula: function (r) {
        const d = r(T.TRANSACTIONS, 'Date');
        return 'ARRAYFORMULA(IF(' + d + '="",,IFERROR(IF(COUNTIFS(' + r(T.REPORT, 'Month Key') + ',YEAR(' + d +
          ')*100+MONTH(' + d + '),' + r(T.REPORT, 'Status') + ',"Closed")>0,"Closed","Open"),"Check date")))';
      } }
    ] },

    { name: T.WALLETS, columns: [
      { h: 'Wallet' },
      { h: 'Wallet Group', ref: [T.SETTINGS, 'Wallet Groups'] },
      { h: 'Wallet Type', list: LISTS.WALLET_TYPES },
      { h: 'Opening Balance', fmt: FMT.RP },
      { h: 'Current Balance', fmt: FMT.RP, w: 140, formula: function (r) {
        // Cash wallets: opening + in − out − transfers out + transfers in.
        // Investment wallets: current value of their Investments rows.
        const W = T.WALLETS, X = T.TRANSACTIONS, I = T.INVESTMENTS;
        const amt = r(X, 'Amount'), wal = r(X, 'Wallet'), dir = r(X, 'Direction'), to = r(X, 'To Wallet');
        return 'MAP(' + r(W, 'Wallet') + ',' + r(W, 'Wallet Type') + ',' + r(W, 'Opening Balance') +
          ',LAMBDA(w,t,o,IF(w="",,IF(t="Investment",SUMIFS(' + r(I, 'Current Value') + ',' +
          r(I, 'Investment Category') + ',w),N(o)' +
          '+SUMIFS(' + amt + ',' + wal + ',w,' + dir + ',"In")' +
          '-SUMIFS(' + amt + ',' + wal + ',w,' + dir + ',"Out")' +
          '-SUMIFS(' + amt + ',' + wal + ',w,' + dir + ',"Transfer")' +
          '+SUMIFS(' + amt + ',' + to + ',w,' + dir + ',"Transfer")))))';
      } },
      { h: 'Owner', ref: [T.SETTINGS, 'Owners'] },
      { h: 'Default Transfer Fee', fmt: FMT.RP, w: 150 },
      { h: 'Active', list: LISTS.YES_NO, w: 80 }
    ] },

    { name: T.CATEGORIES, columns: [
      { h: 'Category', w: 160 },
      { h: 'Type', list: LISTS.CATEGORY_TYPES, w: 110 },
      { h: 'Monthly Budget', fmt: FMT.RP },
      { h: 'Keywords', w: 420 },
      { h: 'Default Wallet', ref: [T.WALLETS, 'Wallet'] }
    ] },

    { name: T.DEBTS, columns: [
      { h: 'Debt ID', w: 90 },
      { h: 'Parent ID', w: 90 },
      { h: 'Link ID', w: 90 },
      { h: 'Type', list: LISTS.DEBT_TYPES, w: 90 },
      { h: 'Term', list: LISTS.TERMS, w: 80 },
      { h: 'Name', ref: [T.CONTACTS, 'Name'] },
      { h: 'Start Date', fmt: FMT.DATE },
      { h: 'Due Date', fmt: FMT.DATE },
      { h: 'Wallet', ref: [T.WALLETS, 'Wallet'] },
      { h: 'Category', ref: [T.CATEGORIES, 'Category'] },
      { h: 'Original', fmt: FMT.RP },
      { h: 'Added', fmt: FMT.RP },
      { h: 'Paid', fmt: FMT.RP },
      { h: 'Remaining', fmt: FMT.RP, formula: function (r) {
        const D = T.DEBTS;
        return 'ARRAYFORMULA(IF(' + r(D, 'Original') + '="",,IFERROR(' + r(D, 'Original') + '+' +
          r(D, 'Added') + '-' + r(D, 'Paid') + ',"Check amounts")))';
      } },
      { h: 'Status', list: LISTS.DEBT_STATUSES, w: 100 },
      { h: 'Converted Trx', w: 110 },
      { h: 'Last Reminder', fmt: FMT.DATE },
      { h: 'Snoozed Until', fmt: FMT.DATE }
    ] },

    { name: T.INVESTMENTS, columns: [
      { h: 'Inv ID', w: 90 },
      { h: 'Link ID', w: 90 },
      { h: 'Investment Date', fmt: FMT.DATE },
      { h: 'Investment Category', ref: [T.SETTINGS, 'Investment Categories'], w: 150 },
      { h: 'Asset Name', w: 140 },
      { h: 'Platform' },
      { h: 'Unit', list: LISTS.UNITS, w: 80 },
      { h: 'Quantity', w: 90 },
      { h: 'Acquisition Price', fmt: FMT.RP },
      { h: 'Acquisition Cost', fmt: FMT.RP },
      { h: 'Current Price', fmt: FMT.RP },
      { h: 'Current Value', fmt: FMT.RP, formula: function (r) {
        return 'ARRAYFORMULA(IF(' + qtyOf_(r) + '="",,' + valueOf_(r) + '))';
      } },
      { h: 'Gain/Loss (Rp)', fmt: FMT.RP, formula: function (r) {
        return 'ARRAYFORMULA(IF(' + qtyOf_(r) + '="",,' + valueOf_(r) + '-' + costOf_(r) + '))';
      } },
      { h: 'Gain/Loss (%)', fmt: FMT.PCT, formula: function (r) {
        return 'ARRAYFORMULA(IF(' + qtyOf_(r) + '="",,IF(' + costOf_(r) + '=0,,(' + valueOf_(r) + '-' +
          costOf_(r) + ')/(' + costOf_(r) + '))))';
      } },
      { h: 'Last Price Update', fmt: FMT.DATE },
      { h: 'Source Wallet', ref: [T.WALLETS, 'Wallet'] },
      { h: 'Status', list: LISTS.INV_STATUSES, w: 110 }
    ] },

    { name: T.SALES, columns: [
      { h: 'Sale ID', w: 90 },
      { h: 'Inv ID', w: 90 },
      { h: 'Sale Date', fmt: FMT.DATE },
      { h: 'Quantity Sold' },
      { h: 'Sale Price', fmt: FMT.RP },
      { h: 'Proceeds', fmt: FMT.RP, formula: function (r) {
        const S = T.SALES;
        return 'ARRAYFORMULA(IF(' + r(S, 'Quantity Sold') + '="",,' + r(S, 'Quantity Sold') + '*' + r(S, 'Sale Price') + '))';
      } },
      { h: 'Fees', fmt: FMT.RP },
      { h: 'Realized Gain', fmt: FMT.RP, formula: function (r) {
        // proceeds − fees − quantity × acquisition price of the purchase row
        const S = T.SALES, I = T.INVESTMENTS, q = r(S, 'Quantity Sold');
        return 'ARRAYFORMULA(IF(' + q + '="",,IFERROR(' + q + '*' + r(S, 'Sale Price') + '-' + r(S, 'Fees') +
          '-' + q + '*VLOOKUP(' + r(S, 'Inv ID') + ',{' + r(I, 'Inv ID') + ',' + r(I, 'Acquisition Price') +
          '},2,FALSE),"Check Inv ID")))';
      } },
      { h: 'To Wallet', ref: [T.WALLETS, 'Wallet'] }
    ] },

    { name: T.PRICES, columns: [
      { h: 'Date', fmt: FMT.DATE },
      { h: 'Inv ID', w: 90 },
      { h: 'Asset Name', w: 140 },
      { h: 'Price', fmt: FMT.RP },
      { h: 'Value', fmt: FMT.RP },
      { h: 'Source', list: LISTS.PRICE_SOURCES },
      { h: 'Month-End', list: LISTS.YES_NO, w: 90 }
    ] },

    { name: T.FAVORITES, columns: [
      { h: 'Favorite ID', w: 90 },
      { h: 'Name', w: 160 },
      { h: 'Type', list: LISTS.FAV_TYPES, w: 90 },
      { h: 'Value Type', list: LISTS.VALUE_TYPES, w: 90 },
      { h: 'Amount', fmt: FMT.RP },
      { h: 'Category', ref: [T.CATEGORIES, 'Category'] },
      { h: 'Wallet', ref: [T.WALLETS, 'Wallet'] },
      { h: 'To Wallet', ref: [T.WALLETS, 'Wallet'] },
      { h: 'Default Fee', fmt: FMT.RP },
      { h: 'Schedule', list: LISTS.SCHEDULES, w: 90 },
      { h: 'Day/Date', w: 90 },
      { h: 'Last Logged', fmt: FMT.DATE },
      { h: 'Active', list: LISTS.YES_NO, w: 80 }
    ] },

    { name: T.CONTACTS, columns: [
      { h: 'Name', w: 150 },
      { h: 'Aliases', w: 300 },
      { h: 'Notes', w: 300 }
    ] },

    { name: T.REPORT, columns: [
      { h: 'Month Key', w: 90 },
      { h: 'Month', fmt: FMT.TEXT, w: 90 },
      { h: 'Income', fmt: FMT.RP },
      { h: 'Expense', fmt: FMT.RP },
      { h: 'Net Cash Flow', fmt: FMT.RP },
      { h: 'Adjustments', fmt: FMT.RP },
      { h: 'Invested', fmt: FMT.RP },
      { h: 'Sold', fmt: FMT.RP },
      { h: 'Portfolio Value', fmt: FMT.RP },
      { h: 'Unrealized Gain', fmt: FMT.RP },
      { h: 'Realized Gain', fmt: FMT.RP },
      { h: 'Net Worth', fmt: FMT.RP },
      { h: 'Status', list: LISTS.REPORT_STATUSES, w: 80 },
      { h: 'Closed At', fmt: FMT.DATETIME },
      { h: 'Archive Link', w: 200 },
      { h: 'Notes', w: 250 }
    ] },

    { name: T.SETTINGS, columns: [
      { h: 'Setting', w: 230 },
      { h: 'Value', fmt: FMT.TEXT, w: 140 },
      { h: 'Notes', w: 330 },
      { h: '' },
      { h: 'Chat ID', fmt: FMT.TEXT, w: 120 },
      { h: 'Display Name', w: 120 },
      { h: 'GoPay Name', w: 140 },
      { h: 'Active', list: LISTS.YES_NO, w: 80 },
      { h: '' },
      { h: 'Owners', w: 110, formula: function (r) {
        const n = r(T.SETTINGS, 'Display Name');
        return '{"Shared";IFERROR(FILTER(' + n + ',' + n + '<>""))}';
      } },
      { h: 'Investment Categories', w: 170, formula: function (r) {
        return 'IFERROR(FILTER(' + r(T.CATEGORIES, 'Category') + ',' + r(T.CATEGORIES, 'Type') + '="Investment"))';
      } },
      { h: 'Wallet Groups', w: 130 }
    ] },

    { name: T.LOGS, columns: [
      { h: 'Timestamp', fmt: FMT.DATETIME, w: 140 },
      { h: 'Level', w: 70 },
      { h: 'Source', w: 160 },
      { h: 'Message', w: 400 },
      { h: 'Details', w: 400 }
    ] }
  ];
}

// Investment formula pieces: remaining quantity, value at current price
// (falls back to acquisition price until a price is entered), and cost.
function qtyOf_(r) { return r(TAB.INVESTMENTS, 'Quantity'); }
function valueOf_(r) {
  const I = TAB.INVESTMENTS;
  return r(I, 'Quantity') + '*IF(' + r(I, 'Current Price') + '="",' + r(I, 'Acquisition Price') + ',' +
    r(I, 'Current Price') + ')';
}
function costOf_(r) {
  return r(TAB.INVESTMENTS, 'Quantity') + '*' + r(TAB.INVESTMENTS, 'Acquisition Price');
}

/** 1 → A, 27 → AA */
function colLetter_(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Returns r(tab, header, withHeader) → "'Tab'!X2:X" (or X1:X), using the
 * column positions in the schema. Only valid for a freshly built template.
 */
function makeRangeResolver_(schema) {
  return function (tab, header, withHeader) {
    const t = schema.filter(function (s) { return s.name === tab; })[0];
    const idx = t ? t.columns.map(function (c) { return c.h; }).indexOf(header) : -1;
    if (idx === -1) throw new Error('Schema has no column "' + header + '" in tab ' + tab);
    const L = colLetter_(idx + 1);
    return "'" + tab + "'!" + L + (withHeader ? '1' : '2') + ':' + L;
  };
}

// ---------------------------------------------------------------------------
// createTemplate
// ---------------------------------------------------------------------------

/**
 * Run once from the editor. Creates a Drive folder "MonetaBot" containing:
 *   - MonetaBot Template: clean copy with sample rows (used by /template)
 *   - MonetaBot Main: your working sheet (a copy of the template, with your
 *     chat IDs in the Users table)
 * and saves both IDs in Script Properties.
 */
function createTemplate() {
  if (getProp_(PROP.MAIN_SHEET_ID) !== null || getProp_(PROP.TEMPLATE_ID) !== null) {
    throw new Error('MAIN_SHEET_ID or TEMPLATE_ID is already set, so createTemplate stopped ' +
      'to avoid making duplicates. To rebuild, delete both Script Properties first ' +
      '(the old sheets stay in Drive).');
  }

  const folder = DriveApp.createFolder('MonetaBot');
  const template = buildTemplateSpreadsheet_('MonetaBot Template');
  const templateFile = DriveApp.getFileById(template.getId());
  templateFile.moveTo(folder);

  const main = SpreadsheetApp.openById(templateFile.makeCopy('MonetaBot Main', folder).getId());
  fillMainSheetUsers_(main);
  setSettingValue_(main, 'Main Sheet ID', main.getId());
  SpreadsheetApp.flush();

  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROP.TEMPLATE_ID, template.getId());
  props.setProperty(PROP.MAIN_SHEET_ID, main.getId());
  clearConfigCache();

  console.log('Template:   ' + template.getUrl());
  console.log('Main sheet: ' + main.getUrl());
  const result = validateSheet(main.getId());
  console.log(result.ok ? 'PASS: createTemplate finished.' : 'FAIL: see the missing items above.');
}

/** Builds a complete, clean spreadsheet with every tab, rule and chart. */
function buildTemplateSpreadsheet_(name) {
  const ss = SpreadsheetApp.create(name);
  ss.setSpreadsheetLocale('id_ID'); // Rp1.250.000, dd/mm dates
  ss.setSpreadsheetTimeZone('Asia/Jakarta');

  const schema = getSchema_();
  const r = makeRangeResolver_(schema);

  // Create every tab first, because formulas refer across tabs.
  const first = ss.getSheets()[0];
  schema.forEach(function (tab, i) {
    if (i === 0) first.setName(tab.name);
    else ss.insertSheet(tab.name, i);
  });

  schema.forEach(function (tab) {
    setupTab_(ss, ss.getSheetByName(tab.name), tab, r);
  });

  writeSampleRows_(ss);
  buildDashboard_(ss, ss.getSheetByName(TAB.DASHBOARD), r);
  ss.setActiveSheet(ss.getSheetByName(TAB.DASHBOARD));
  SpreadsheetApp.flush();
  return ss;
}

/** Headers, widths, number formats, dropdowns, formulas and protection. */
function setupTab_(ss, sheet, tab, r) {
  const cols = tab.columns;
  if (cols.length === 0) return;
  const maxRows = sheet.getMaxRows();

  sheet.getRange(1, 1, 1, cols.length)
    .setValues([cols.map(function (c) { return c.h; })])
    .setFontWeight('bold')
    .setBackground(HEADER_BG)
    .setVerticalAlignment('middle');

  cols.forEach(function (c, i) {
    const col = i + 1;
    if (c.h === '') {
      sheet.getRange(1, col).setBackground(null);
      sheet.setColumnWidth(col, 30);
      return;
    }
    sheet.setColumnWidth(col, c.w || 130);
    const data = sheet.getRange(2, col, maxRows - 1, 1);
    if (c.fmt) data.setNumberFormat(c.fmt);
    if (c.list) {
      data.setDataValidation(SpreadsheetApp.newDataValidation()
        .requireValueInList(c.list, true).setAllowInvalid(true).build());
    }
    if (c.ref) {
      data.setDataValidation(SpreadsheetApp.newDataValidation()
        .requireValueInRange(ss.getRange(r(c.ref[0], c.ref[1])), true).setAllowInvalid(true).build());
    }
    if (c.formula) {
      sheet.getRange(1, col)
        .setFormula('={"' + c.h + '";' + c.formula(r) + '}')
        .setBackground(FORMULA_HEADER_BG);
      sheet.getRange(1, col, maxRows, 1).protect()
        .setDescription('Formula column: ' + c.h)
        .setWarningOnly(true);
    }
  });

  sheet.setFrozenRows(1);
  // Protect the header row so column names (which the bot relies on) aren't renamed by accident.
  sheet.getRange(1, 1, 1, cols.length).protect()
    .setDescription('Headers (the bot finds columns by these names)')
    .setWarningOnly(true);
}

/** Sample wallets and categories, settings, wallet groups, placeholder users. */
function writeSampleRows_(ss) {
  const get = function (name) { return ss.getSheetByName(name); };

  writeRowsByHeaders_(get(TAB.WALLETS), 2, [
    ['BCA', 'Spending', 'Cash'],
    ['GoPay', 'Spending', 'Cash'],
    ['Cash', 'Spending', 'Cash'],
    ['IPOT', 'Investment', 'Cash'],
    ['Jago', 'Savings', 'Cash'],
    ['Saham', 'Investment', 'Investment'],
    ['Emas', 'Investment', 'Investment'],
    ['Reksadana', 'Investment', 'Investment'],
    ['Crypto', 'Investment', 'Investment'],
    ['Deposito/Obligasi', 'Investment', 'Investment']
  ].map(function (w) {
    return { 'Wallet': w[0], 'Wallet Group': w[1], 'Wallet Type': w[2],
      'Opening Balance': 0, 'Owner': 'Shared', 'Active': 'Yes' };
  }));

  writeRowsByHeaders_(get(TAB.CATEGORIES), 2, [
    ['Food', 'Expense', 'makan, minum, kopi, sarapan, lunch, dinner, snack, kfc, mcd, gofood, grabfood, shopeefood, resto, warung, bakso, nasi', 'GoPay'],
    ['Groceries', 'Expense', 'indomaret, alfamart, superindo, hypermart, supermarket, sayur, buah, belanja bulanan, groceries', ''],
    ['Transport', 'Expense', 'bensin, pertamax, gojek, goride, grab, grabbike, ojek, taksi, taxi, parkir, tol, krl, mrt, lrt, transjakarta, kereta', ''],
    ['Bills & Utilities', 'Expense', 'listrik, pln, token listrik, air, pdam, internet, wifi, indihome, pulsa, paket data, bpjs', ''],
    ['Housing', 'Expense', 'sewa, kos, kost, kontrakan, ipl, rent', ''],
    ['Shopping', 'Expense', 'shopee, tokopedia, lazada, baju, sepatu, tas, clothes', ''],
    ['Health', 'Expense', 'obat, apotek, kimia farma, dokter, rumah sakit, klinik, vitamin, medicine', ''],
    ['Entertainment', 'Expense', 'netflix, spotify, youtube premium, bioskop, cgv, xxi, nonton, game, movie', ''],
    ['Education', 'Expense', 'buku, kursus, sekolah, kuliah, udemy, course', ''],
    ['Personal Care', 'Expense', 'salon, cukur, potong rambut, barbershop, skincare, laundry', ''],
    ['Gifts & Donations', 'Expense', 'kado, hadiah, sumbangan, zakat, sedekah, donasi, kondangan, gift', ''],
    ['Travel', 'Expense', 'hotel, tiket pesawat, traveloka, tiket.com, liburan, holiday', ''],
    ['Admin & Bank Fees', 'Expense', 'admin, biaya admin, bi-fast, bifast, biaya transfer, fee, top up fee', ''],
    ['Other Expense', 'Expense', '', ''],
    ['Salary', 'Income', 'gaji, salary, payroll', ''],
    ['Bonus', 'Income', 'bonus, thr, insentif', ''],
    ['Interest & Dividends', 'Income', 'bunga, dividen, interest, dividend', ''],
    ['Refund & Cashback', 'Income', 'refund, cashback, pengembalian', ''],
    ['Other Income', 'Income', '', ''],
    ['Saham', 'Investment', '', ''],
    ['Emas', 'Investment', '', ''],
    ['Reksadana', 'Investment', '', ''],
    ['Crypto', 'Investment', '', ''],
    ['Deposito/Obligasi', 'Investment', '', ''],
    ['Adjustment', 'Adjustment', '', '']
  ].map(function (c) {
    return { 'Category': c[0], 'Type': c[1], 'Keywords': c[2], 'Default Wallet': c[3] };
  }));

  const settings = get(TAB.SETTINGS);
  writeRowsByHeaders_(settings, 2, [
    ['Timezone', 'Asia/Jakarta', 'Info only. The bot always uses Asia/Jakarta.'],
    ['AI Enabled', 'Yes', 'Yes = use Gemini for parsing/categories/OCR. No = keywords and manual only.'],
    ['Large Amount Threshold', '5000000', 'Amounts above this (Rp) get an extra warning in the preview.'],
    ['Duplicate Window (minutes)', '5', 'Warn if the same entry is logged again within this many minutes.'],
    ['Daily Reminder Time', '08:00', 'Hour for the daily hutang/piutang reminder (HH:MM).'],
    ['Weekly Reminder Day', 'Monday', 'Day for the weekly summary reminder.'],
    ['Monthly Reminder Date', '1', 'Day of month for the monthly reminder.'],
    ['Price Update Reminder Time', '12:00', 'Last day of the month: reminder to update investment prices.'],
    ['Closing Reminder Time', '18:00', 'Last day of the month: reminder to close the month.'],
    ['Debt Reminder Days Before Due', '3', 'Start reminding this many days before a due date.'],
    ['Main Sheet ID', '', 'Info only (written by the script). The real value is in Script Properties.'],
    ['Archive Folder ID', '', 'Info only. Set with /setarchive (later phase).']
  ].map(function (s) { return { 'Setting': s[0], 'Value': s[1], 'Notes': s[2] }; }));

  writeRowsByHeaders_(settings, 2, [
    { 'Chat ID': '', 'Display Name': 'Me', 'GoPay Name': '', 'Active': 'Yes' },
    { 'Chat ID': '', 'Display Name': 'Partner', 'GoPay Name': '', 'Active': 'Yes' }
  ]);

  writeRowsByHeaders_(settings, 2, ['Spending', 'Savings', 'Investment'].map(function (g) {
    return { 'Wallet Groups': g };
  }));
}

/** Puts the chat IDs from ALLOWED_CHAT_IDS into the main sheet's Users table. */
function fillMainSheetUsers_(ss) {
  const ids = parseChatIdList_(getProp_(PROP.ALLOWED_CHAT_IDS));
  const names = ['Me', 'Partner'];
  const rows = [];
  for (let i = 0; i < Math.max(2, ids.length); i++) {
    rows.push({
      'Chat ID': ids[i] || '',
      'Display Name': names[i] || 'User ' + (i + 1),
      'Active': 'Yes'
    });
  }
  writeRowsByHeaders_(ss.getSheetByName(TAB.SETTINGS), 2, rows);
}

/**
 * Dashboard: live summary tables (columns T onward, all formulas) and the
 * 7 charts from SPEC Section 18 on the left.
 */
function buildDashboard_(ss, sheet, r) {
  const X = TAB.TRANSACTIONS, W = TAB.WALLETS, C = TAB.CATEGORIES, I = TAB.INVESTMENTS, R = TAB.REPORT;
  const amt = r(X, 'Amount'), type = r(X, 'Type'), date = r(X, 'Date'), cat = r(X, 'Category');
  const catName = r(C, 'Category'), catType = r(C, 'Type');
  const monthStart = '(EOMONTH(TODAY(),-1)+1)', nextMonthStart = '(EOMONTH(TODAY(),0)+1)';

  sheet.getRange('A1').setValue('MonetaBot Dashboard').setFontSize(16).setFontWeight('bold');
  sheet.getRange('T1').setValue('Chart data: formulas, do not edit').setFontStyle('italic');

  // Cash flow, last 12 months (T:W)
  sheet.getRange('T2:W2').setValues([['Month', 'Income', 'Expense', 'Net']]);
  const cash = [];
  for (let i = 0; i < 12; i++) {
    const row = 3 + i;
    const sum = function (t) {
      return '=SUMIFS(' + amt + ',' + type + ',"' + t + '",' + date + ',">="&T' + row + ',' + date +
        ',"<"&EDATE(T' + row + ',1))';
    };
    cash.push(['=EDATE(' + monthStart + ',' + (i - 11) + ')', sum('Income'), sum('Expense'), '=U' + row + '-V' + row]);
  }
  sheet.getRange('T3:W14').setFormulas(cash);
  sheet.getRange('T3:T14').setNumberFormat(FMT.MONTH);
  sheet.getRange('U3:W14').setNumberFormat(FMT.RP);

  // Expenses by category, this month (Y:Z)
  sheet.getRange('Y2:Z2').setValues([['Category', 'Expense This Month']]);
  sheet.getRange('Y3').setFormula('=IFERROR(FILTER(' + catName + ',' + catType + '="Expense"))');
  sheet.getRange('Z3').setFormula('=MAP(Y3:Y60,LAMBDA(c,IF(c="",,SUMIFS(' + amt + ',' + type + ',"Expense",' +
    cat + ',c,' + date + ',">="&' + monthStart + ',' + date + ',"<"&' + nextMonthStart + '))))');
  sheet.getRange('Z3:Z60').setNumberFormat(FMT.RP);

  // Balance by wallet group, cash wallets only (AB:AC)
  sheet.getRange('AB2:AC2').setValues([['Wallet Group', 'Balance']]);
  sheet.getRange('AB3').setFormula('=IFERROR(UNIQUE(FILTER(' + r(W, 'Wallet Group') + ',' + r(W, 'Wallet Group') +
    '<>"",' + r(W, 'Wallet Type') + '<>"Investment")))');
  sheet.getRange('AC3').setFormula('=MAP(AB3:AB30,LAMBDA(g,IF(g="",,SUMIFS(' + r(W, 'Current Balance') + ',' +
    r(W, 'Wallet Group') + ',g,' + r(W, 'Wallet Type') + ',"<>Investment"))))');
  sheet.getRange('AC3:AC30').setNumberFormat(FMT.RP);

  // Investments by category (AE:AG)
  sheet.getRange('AE2:AG2').setValues([['Investment Category', 'Current Value', 'Gain/Loss']]);
  sheet.getRange('AE3').setFormula('=IFERROR(FILTER(' + catName + ',' + catType + '="Investment"))');
  sheet.getRange('AF3').setFormula('=MAP(AE3:AE30,LAMBDA(c,IF(c="",,SUMIFS(' + r(I, 'Current Value') + ',' +
    r(I, 'Investment Category') + ',c))))');
  sheet.getRange('AG3').setFormula('=MAP(AE3:AE30,LAMBDA(c,IF(c="",,SUMIFS(' + r(I, 'Gain/Loss (Rp)') + ',' +
    r(I, 'Investment Category') + ',c))))');
  sheet.getRange('AF3:AG30').setNumberFormat(FMT.RP);

  sheet.getRange('T2:AG2').setFontWeight('bold');

  // Charts: two columns (A and I), 16 rows apart.
  const addChart = function (chartType, ranges, title, row, col) {
    let b = sheet.newChart().setChartType(chartType);
    ranges.forEach(function (a1) { b = b.addRange(ss.getRange(a1)); });
    sheet.insertChart(b.setNumHeaders(1)
      .setPosition(row, col, 0, 0)
      .setOption('title', title)
      .setOption('width', 600)
      .setOption('height', 300)
      .build());
  };
  const dash = "'" + TAB.DASHBOARD + "'!";
  addChart(Charts.ChartType.COLUMN, [dash + 'T2:V14'], 'Monthly cash flow (last 12 months)', 3, 1);
  addChart(Charts.ChartType.PIE, [dash + 'Y2:Z60'], 'Expenses by category (this month)', 3, 9);
  addChart(Charts.ChartType.PIE, [dash + 'AB2:AC30'], 'Balance by wallet group', 19, 1);
  addChart(Charts.ChartType.PIE, [dash + 'AE2:AF30'], 'Investments by category', 19, 9);
  addChart(Charts.ChartType.LINE, [r(R, 'Month', true), r(R, 'Portfolio Value', true)], 'Portfolio value trend', 35, 1);
  addChart(Charts.ChartType.COLUMN, [dash + 'AE2:AE30', dash + 'AG2:AG30'], 'Gain/loss per investment category', 35, 9);
  addChart(Charts.ChartType.LINE, [r(R, 'Month', true), r(R, 'Net Worth', true)], 'Net worth trend', 51, 1);

  sheet.protect().setDescription('Dashboard (formulas and charts)').setWarningOnly(true);
}

// ---------------------------------------------------------------------------
// validateSheet
// ---------------------------------------------------------------------------

/**
 * Checks a spreadsheet has every tab and column the bot needs. Extra tabs and
 * columns are fine. Run from the editor with no argument to check the main
 * sheet. Returns {ok, name, missingTabs, missingColumns, error}.
 * Also used by /setsheet (later phase).
 */
function validateSheet(spreadsheetId) {
  const id = typeof spreadsheetId === 'string' ? spreadsheetId : requireProp_(PROP.MAIN_SHEET_ID);
  const result = { ok: false, name: '', missingTabs: [], missingColumns: {}, error: '' };

  let ss;
  try {
    ss = SpreadsheetApp.openById(id);
  } catch (err) {
    result.error = 'Cannot open the sheet (wrong link, or no access).';
    console.log('FAIL: ' + result.error);
    return result;
  }
  result.name = ss.getName();

  getSchema_().forEach(function (tab) {
    const sheet = ss.getSheetByName(tab.name);
    if (sheet === null) {
      result.missingTabs.push(tab.name);
      return;
    }
    const map = getHeaderMap_(sheet);
    const missing = tab.columns
      .filter(function (c) { return c.h !== '' && map[c.h.toLowerCase()] === undefined; })
      .map(function (c) { return c.h; });
    if (missing.length > 0) result.missingColumns[tab.name] = missing;
  });

  result.ok = result.missingTabs.length === 0 && Object.keys(result.missingColumns).length === 0;
  console.log('Checked "' + result.name + '": ' + (result.ok ? 'PASS, all tabs and columns present.' : 'FAIL'));
  if (result.missingTabs.length > 0) console.log('Missing tabs: ' + result.missingTabs.join(', '));
  Object.keys(result.missingColumns).forEach(function (t) {
    console.log('Missing columns in ' + t + ': ' + result.missingColumns[t].join(', '));
  });
  return result;
}
