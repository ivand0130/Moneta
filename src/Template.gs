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
      { h: 'Spent', fmt: FMT.RP, formula: function (r) {
        // This month's expenses per Expense category (budget or not).
        const C = T.CATEGORIES, X = T.TRANSACTIONS;
        return 'MAP(' + r(C, 'Category') + ',' + r(C, 'Type') + ',LAMBDA(c,t,IF(OR(c="",t<>"Expense"),,SUMIFS(' +
          r(X, 'Amount') + ',' + r(X, 'Type') + ',"Expense",' + r(X, 'Category') + ',c,' +
          r(X, 'Date') + ',">="&(EOMONTH(TODAY(),-1)+1),' + r(X, 'Date') + ',"<"&(EOMONTH(TODAY(),0)+1)))))';
      } },
      { h: 'Remaining', fmt: FMT.RP, redIfNegative: true, formula: function (r) {
        // Budget − Spent; blank when there is no budget (empty or 0 = no limit).
        const C = T.CATEGORIES;
        return 'MAP(' + r(C, 'Category') + ',' + r(C, 'Monthly Budget') + ',' + r(C, 'Spent') +
          ',LAMBDA(c,b,s,IF(OR(c="",N(b)=0),,N(b)-N(s))))';
      } },
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

  const folders = DriveApp.getRootFolder().getFoldersByName('MonetaBot');
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder('MonetaBot');
  const template = buildTemplateSpreadsheet_('MonetaBot Template');
  const templateFile = DriveApp.getFileById(template.getId());
  templateFile.moveTo(folder);

  // Check the template before copying it, so a broken build stops here.
  console.log('Template:   ' + template.getUrl());
  if (!validateSheet(template.getId()).ok) {
    throw new Error('The template has problems (see the log above). Nothing was saved to ' +
      'Script Properties. Send the log to Claude, then move "MonetaBot Template" to the trash.');
  }

  const main = SpreadsheetApp.openById(templateFile.makeCopy('MonetaBot Main', folder).getId());
  fillMainSheetUsers_(main);
  setSettingValue_(main, 'Main Sheet ID', main.getId());
  SpreadsheetApp.flush();

  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROP.TEMPLATE_ID, template.getId());
  props.setProperty(PROP.MAIN_SHEET_ID, main.getId());
  clearConfigCache();

  console.log('Main sheet: ' + main.getUrl());
  const result = validateSheet(main.getId());
  console.log(result.ok ? 'PASS: createTemplate finished.' : 'FAIL: see the missing items above.');
}

/**
 * Run from the editor to undo createTemplate: moves the template and main
 * sheet to the Drive trash (restorable for 30 days) and clears their Script
 * Properties, so createTemplate can run again. Refuses if the main sheet
 * already has transactions, so real data can't be thrown away by accident.
 */
function resetSheets() {
  const mainId = getProp_(PROP.MAIN_SHEET_ID);
  const templateId = getProp_(PROP.TEMPLATE_ID);
  if (mainId !== null) {
    const trx = SpreadsheetApp.openById(mainId).getSheetByName(TAB.TRANSACTIONS);
    if (trx !== null && lastDataRow_(trx) > 1) {
      throw new Error('The main sheet has transactions, so resetSheets stopped. Nothing was changed.');
    }
  }
  [mainId, templateId].forEach(function (id) {
    if (id === null) return;
    const file = DriveApp.getFileById(id);
    file.setTrashed(true);
    console.log('Moved to trash: ' + file.getName());
  });
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(PROP.MAIN_SHEET_ID);
  props.deleteProperty(PROP.TEMPLATE_ID);
  mainSheetCache_ = null;
  clearConfigCache();
  console.log('Done. MAIN_SHEET_ID and TEMPLATE_ID cleared; you can run createTemplate again.');
}

/** Builds a complete, clean spreadsheet with every tab, rule and chart. */
function buildTemplateSpreadsheet_(name) {
  const ss = SpreadsheetApp.create(name);
  // Formulas below use English syntax (commas). They must be written while
  // the sheet is en_US; in id_ID they'd be a parse error. We switch to id_ID
  // at the end, and Sheets converts the already-parsed formulas itself.
  ss.setSpreadsheetLocale('en_US');
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

  ss.setSpreadsheetLocale('id_ID'); // Rp1.250.000, dd/mm dates
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
    if (c.formula) setupFormulaColumn_(sheet, col, c, r);
  });

  sheet.setFrozenRows(1);
  // Protect the header row so column names (which the bot relies on) aren't renamed by accident.
  sheet.getRange(1, 1, 1, cols.length).protect()
    .setDescription('Headers (the bot finds columns by these names)')
    .setWarningOnly(true);
}

/**
 * Writes a formula column: the formula in the header cell (green), number
 * format, warning-only protection, and red text for negative values if
 * asked. The sheet must be in the en_US locale while the formula is written.
 */
function setupFormulaColumn_(sheet, col, c, r) {
  const maxRows = sheet.getMaxRows();
  sheet.getRange(1, col)
    .setFormula('={"' + c.h + '";' + c.formula(r) + '}')
    .setFontWeight('bold')
    .setBackground(FORMULA_HEADER_BG);
  if (c.fmt) sheet.getRange(2, col, maxRows - 1, 1).setNumberFormat(c.fmt);
  sheet.setColumnWidth(col, c.w || 130);
  sheet.getRange(1, col, maxRows, 1).protect()
    .setDescription('Formula column: ' + c.h)
    .setWarningOnly(true);
  if (c.redIfNegative) {
    const range = sheet.getRange(2, col, maxRows - 1, 1);
    const rules = sheet.getConditionalFormatRules();
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenNumberLessThan(0).setFontColor('#cc0000').setBold(true).setRanges([range]).build());
    sheet.setConditionalFormatRules(rules);
  }
}

/**
 * Like makeRangeResolver_, but uses the columns as they are NOW in an
 * existing spreadsheet (you may have moved columns), found by header name.
 */
function makeSheetResolver_(ss) {
  const maps = {};
  return function (tab, header, withHeader) {
    if (!maps[tab]) maps[tab] = getHeaderMap_(ss.getSheetByName(tab));
    const idx = maps[tab][header.toLowerCase()];
    if (idx === undefined) throw new Error('Column "' + header + '" not found in tab ' + tab);
    const L = colLetter_(idx + 1);
    return "'" + tab + "'!" + L + (withHeader ? '1' : '2') + ':' + L;
  };
}

/**
 * Adds the Spent and Remaining formula columns right after Monthly Budget in
 * an existing Categories tab (sheets built before they existed). Returns a
 * short description of what was done.
 */
function upgradeCategoryBudgetColumns_(ss) {
  const sheet = ss.getSheetByName(TAB.CATEGORIES);
  const schema = getSchema_().filter(function (t) { return t.name === TAB.CATEGORIES; })[0].columns;
  const want = ['Monthly Budget', 'Spent', 'Remaining'];
  const map = getHeaderMap_(sheet);
  const missing = want.filter(function (h) { return map[h.toLowerCase()] === undefined; });
  if (missing.length === 0) return 'Categories: already up to date';

  // Formulas use English syntax, so write them while the sheet is en_US (see PROGRESS notes).
  const locale = ss.getSpreadsheetLocale();
  ss.setSpreadsheetLocale('en_US');
  try {
    let after = map['monthly budget'] !== undefined ? map['monthly budget'] + 1 : map['type'] + 1; // 1-based
    if (map['monthly budget'] === undefined) {
      sheet.insertColumnAfter(after);
      after += 1;
      sheet.getRange(1, after).setValue('Monthly Budget').setFontWeight('bold').setBackground(HEADER_BG);
      sheet.getRange(2, after, sheet.getMaxRows() - 1, 1).setNumberFormat(FMT.RP);
    }
    ['Spent', 'Remaining'].forEach(function (h) {
      SpreadsheetApp.flush(); // so "Spent" (a formula header) is readable before Remaining refers to it
      if (getHeaderMap_(sheet)[h.toLowerCase()] !== undefined) return;
      sheet.insertColumnAfter(after);
      after += 1;
      sheet.getRange(1, after).setValue(h); // header first, so the resolver can find it
      const c = schema.filter(function (x) { return x.h === h; })[0];
      setupFormulaColumn_(sheet, after, c, makeSheetResolver_(ss));
    });
    SpreadsheetApp.flush();
  } finally {
    ss.setSpreadsheetLocale(locale);
  }
  return 'Categories: added ' + missing.join(', ');
}

/**
 * Run from the editor after an update that adds columns or settings.
 * Upgrades the main sheet and the template, then checks the main sheet.
 * Safe to run more than once; your data and values are never changed.
 */
function upgradeSheets() {
  [getProp_(PROP.MAIN_SHEET_ID), getProp_(PROP.TEMPLATE_ID)].forEach(function (id) {
    if (id === null) return;
    const ss = SpreadsheetApp.openById(id);
    console.log(ss.getName() + ' → ' + upgradeCategoryBudgetColumns_(ss));
  });
  upgradeSettings();
  validateSheet();
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
  writeRowsByHeaders_(settings, 2, SETTING_ROWS.map(function (s) {
    return { 'Setting': s[0], 'Value': s[1], 'Notes': s[2] };
  }));

  writeRowsByHeaders_(settings, 2, [
    { 'Chat ID': '', 'Display Name': 'Me', 'GoPay Name': '', 'Active': 'Yes' },
    { 'Chat ID': '', 'Display Name': 'Partner', 'GoPay Name': '', 'Active': 'Yes' }
  ]);

  writeRowsByHeaders_(settings, 2, ['Spending', 'Savings', 'Investment'].map(function (g) {
    return { 'Wallet Groups': g };
  }));
}

/**
 * Run from the editor after an update adds new settings: appends any
 * missing rows from SETTING_ROWS (with their default values) to the
 * Settings tab of the main sheet and the template. Existing rows and your
 * values are never changed. Safe to run more than once.
 */
function upgradeSettings() {
  [getProp_(PROP.MAIN_SHEET_ID), getProp_(PROP.TEMPLATE_ID)].forEach(function (id) {
    if (id === null) return;
    const ss = SpreadsheetApp.openById(id);
    const sheet = ss.getSheetByName(TAB.SETTINGS);
    const existing = readTableByHeaders_(sheet, 'Setting').map(function (r) {
      return String(r['setting']).trim().toLowerCase();
    });
    const missing = SETTING_ROWS.filter(function (s) { return existing.indexOf(s[0].toLowerCase()) === -1; });
    if (missing.length > 0) {
      writeRowsByHeaders_(sheet, lastDataRow_(sheet, 'Setting') + 1, missing.map(function (s) {
        return { 'Setting': s[0], 'Value': s[1], 'Notes': s[2] };
      }));
    }
    const removed = removeObsoleteSettings_(sheet);
    const done = [];
    if (missing.length > 0) done.push('added ' + missing.map(function (s) { return s[0]; }).join(', '));
    if (removed.length > 0) done.push('removed unused ' + removed.join(', '));
    console.log(ss.getName() + ': ' + (done.length ? done.join('; ') : 'settings already up to date'));
  });
  clearConfigCache();
}

/**
 * Removes rows listed in OBSOLETE_SETTINGS from the Setting/Value/Notes
 * table. Only those three columns move up; the Users table and helper lists
 * that share the same rows are not touched. Returns the removed names.
 */
function removeObsoleteSettings_(sheet) {
  const map = getHeaderMap_(sheet);
  const cols = ['setting', 'value', 'notes'].map(function (h) { return map[h]; });
  const last = lastDataRow_(sheet, 'Setting');
  if (last < 2 || cols.some(function (c) { return c === undefined; })) return [];
  const obsolete = OBSOLETE_SETTINGS.map(function (s) { return s.toLowerCase(); });
  const values = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  const keep = values.filter(function (row) {
    return obsolete.indexOf(String(row[cols[0]]).trim().toLowerCase()) === -1;
  });
  const removed = values.filter(function (row) { return keep.indexOf(row) === -1; })
    .map(function (row) { return String(row[cols[0]]).trim(); });
  if (removed.length === 0) return [];
  cols.forEach(function (c, i) {
    const column = keep.map(function (row) { return [row[c]]; });
    while (column.length < values.length) column.push(['']);
    sheet.getRange(2, c + 1, column.length, 1).setValues(column);
  });
  return removed;
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
