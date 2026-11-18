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
// Wallet Types whose balance comes from Investment_Details: the same names walletKind_ (Wallets.gs) accepts,
// any case, spaces ignored (the old "Investment" counts as Others).
const INV_WALLET_TYPE_RE = '(?i)^\\s*(emas|gold|saham|stocks?|others?|lainnya|investment|investasi)\\s*$';
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
      // Investment wallets only: every investment held in this wallet gets this category.
      { h: 'Investment Category', ref: [T.SETTINGS, 'Investment Categories'], w: 150 },
      { h: 'Opening Balance', fmt: FMT.RP },
      { h: 'Current Balance', fmt: FMT.RP, w: 140, formula: function (r) {
        // Cash wallets: opening + in − out − transfers out + transfers in.
        // Investment wallets (Emas / Saham / Others): current value of the Investment_Details rows they hold.
        const W = T.WALLETS, X = T.TRANSACTIONS, I = T.INVESTMENTS;
        const amt = r(X, 'Amount'), wal = r(X, 'Wallet'), dir = r(X, 'Direction'), to = r(X, 'To Wallet');
        return 'MAP(' + r(W, 'Wallet') + ',' + r(W, 'Wallet Type') + ',' + r(W, 'Opening Balance') +
          ',LAMBDA(w,t,o,IF(w="",,IF(REGEXMATCH(t&"","' + INV_WALLET_TYPE_RE + '"),SUMIFS(' + r(I, 'Current Value') + ',' +
          r(I, 'Investment Wallet') + ',w),N(o)' +
          '+SUMIFS(' + amt + ',' + wal + ',w,' + dir + ',"In")' +
          '-SUMIFS(' + amt + ',' + wal + ',w,' + dir + ',"Out")' +
          '-SUMIFS(' + amt + ',' + wal + ',w,' + dir + ',"Transfer")' +
          '+SUMIFS(' + amt + ',' + to + ',w,' + dir + ',"Transfer")))))';
      } },
      { h: 'Owner', ref: [T.SETTINGS, 'Owners'] },
      { h: 'Default Transfer Fee', fmt: FMT.RP, w: 150 },
      // Receipts from this app suggest this wallet (e.g. GoPay, OVO, DANA). Several wallets with the same issuer → asked.
      { h: 'Receipt Issuer', w: 120 },
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
      // Added / Paid / Converted are summed from Transactions by Debt ID (a group parent also
      // sums its sub-records PTG-010-A, -B…), so /undo and sheet edits always stay correct.
      { h: 'Added', fmt: FMT.RP, formula: function (r) { return debtSumFormula_(r, 'Type', 'Addition'); } },
      { h: 'Paid', fmt: FMT.RP, formula: function (r) { return debtSumFormula_(r, 'Type', 'Settlement'); } },
      // A Hutang row with Direction None is a split share someone else paid (nothing moved yet), not a conversion.
      { h: 'Converted', fmt: FMT.RP, formula: function (r) { return debtSumFormula_(r, 'Direction', 'None', ',' + r(TAB.TRANSACTIONS, 'Type') + ',"<>Hutang"'); } },
      // Paid + converted − added in months already closed (their Transactions rows are in the archive). Written by closing.
      { h: 'Carried Paid', fmt: FMT.RP, w: 110 },
      { h: 'Remaining', fmt: FMT.RP, formula: function (r) {
        const D = T.DEBTS;
        return 'MAP(' + r(D, 'Debt ID') + ',' + r(D, 'Original') + ',' + r(D, 'Added') + ',' + r(D, 'Paid') + ',' +
          r(D, 'Converted') + ',' + r(D, 'Carried Paid') + ',LAMBDA(id,o,a,p,c,k,IF(id="",,N(o)+N(a)-N(p)-N(c)-N(k))))';
      } },
      { h: 'Status', w: 100, formula: function (r) {
        // Remaining ≤ 0 → Converted (if any part was converted) or Paid; otherwise Partial / Open.
        const D = T.DEBTS;
        return 'MAP(' + r(D, 'Debt ID') + ',' + r(D, 'Remaining') + ',' + r(D, 'Paid') + ',' + r(D, 'Converted') +
          ',' + r(D, 'Carried Paid') +
          ',LAMBDA(id,m,p,c,k,IF(id="",,IF(N(m)<=0,IF(N(c)>0,"Converted","Paid"),IF(N(p)+N(c)+N(k)>0,"Partial","Open")))))';
      } },
      { h: 'Converted Trx', w: 110 },
      { h: 'Last Reminder', fmt: FMT.DATE },
      { h: 'Snoozed Until', fmt: FMT.DATE }
    ] },

    // One row per asset (several purchases → one line, average prices). All formulas from Investment_Details.
    { name: T.INV_SUMMARY, columns: [
      { h: 'Investment Category', w: 150, formula: function (r) { return 'IFERROR(INDEX(' + invAssetPairs_(r) + ',,1))'; } },
      { h: 'Asset Name', w: 140, formula: function (r) { return 'IFERROR(INDEX(' + invAssetPairs_(r) + ',,2))'; } },
      { h: 'Unit', w: 70, formula: function (r) {
        const I = T.INVESTMENTS;
        return perAsset_(r, 'IFERROR(INDEX(FILTER(' + r(I, 'Unit') + ',' + r(I, 'Asset Name') + '=a),1))');
      } },
      { h: 'Qty Bought', w: 90, formula: function (r) {
        const A = T.INV_SUMMARY;
        return 'MAP(' + r(A, 'Asset Name') + ',' + r(A, 'Qty Held') + ',' + r(A, 'Qty Sold') + ',LAMBDA(a,h,s,IF(a="",,N(h)+N(s))))';
      } },
      { h: 'Qty Sold', w: 90, formula: function (r) { return detailSumOf_(r, 'Qty Sold'); } },
      { h: 'Qty Held', w: 90, formula: function (r) { return detailSumOf_(r, 'Quantity'); } },
      { h: 'Avg Buy Price', fmt: FMT.RP, formula: function (r) { return perPrice_(r, 'Total Cost', 'Qty Bought'); } },
      { h: 'Total Cost', fmt: FMT.RP, formula: function (r) { return detailSumOf_(r, 'Acquisition Cost'); } },
      { h: 'Avg Sell Price', fmt: FMT.RP, formula: function (r) { return perPrice_(r, 'Sold Value', 'Qty Sold'); } },
      { h: 'Sold Value', fmt: FMT.RP, formula: function (r) { return detailSumOf_(r, 'Sold Value'); } },
      { h: 'Current Price', fmt: FMT.RP, formula: function (r) { return perPrice_(r, 'Current Value', 'Qty Held'); } },
      { h: 'Current Value', fmt: FMT.RP, formula: function (r) { return detailSumOf_(r, 'Current Value'); } },
      { h: 'Floating Gain', fmt: FMT.RP, redIfNegative: true, formula: function (r) { return detailSumOf_(r, 'Gain/Loss (Rp)'); } },
      { h: 'Realized Gain', fmt: FMT.RP, redIfNegative: true, formula: function (r) { return detailSumOf_(r, 'Realized Gain'); } },
      { h: 'Total Gain/Loss (Rp)', fmt: FMT.RP, redIfNegative: true, formula: function (r) {
        const A = T.INV_SUMMARY;
        return 'MAP(' + r(A, 'Asset Name') + ',' + r(A, 'Floating Gain') + ',' + r(A, 'Realized Gain') +
          ',LAMBDA(a,u,x,IF(a="",,N(u)+N(x))))';
      } },
      { h: 'Total Gain/Loss (%)', fmt: FMT.PCT, formula: function (r) { return perUnit_(r, 'Total Gain/Loss (Rp)', 'Total Cost'); } }
    ] },

    { name: T.INVESTMENTS, columns: [
      { h: 'Inv ID', w: 90 },
      { h: 'Link ID', w: 90 },
      { h: 'Investment Date', fmt: FMT.DATE },
      { h: 'Investment Category', ref: [T.SETTINGS, 'Investment Categories'], w: 150 },
      { h: 'Investment Wallet', ref: [T.WALLETS, 'Wallet'], w: 140 }, // holds it: the wallet's balance sums these rows
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
      // Sold part (from Investment_Sales by Inv ID). Quantity above = what is still held.
      { h: 'Qty Sold', w: 90, formula: function (r) { return salesSumOf_(r, 'Quantity Sold'); } },
      { h: 'Sold Value', fmt: FMT.RP, formula: function (r) { return salesSumOf_(r, 'Proceeds'); } },
      { h: 'Avg Sell Price', fmt: FMT.RP, formula: function (r) {
        const I = T.INVESTMENTS;
        return 'MAP(' + r(I, 'Inv ID') + ',' + r(I, 'Qty Sold') + ',' + r(I, 'Sold Value') + ',' + r(I, 'Unit') +
          ',LAMBDA(i,q,v,u,IF(OR(i="",N(q)=0),,N(v)/(N(q)*IF(u="lot",100,1)))))';
      } },
      { h: 'Realized Gain', fmt: FMT.RP, redIfNegative: true, formula: function (r) { return salesSumOf_(r, 'Realized Gain'); } },
      // Total = realized (sold part) + unrealized (held part at the current price), vs the whole acquisition cost.
      { h: 'Total Gain/Loss (Rp)', fmt: FMT.RP, redIfNegative: true, formula: function (r) {
        const I = T.INVESTMENTS;
        return 'MAP(' + r(I, 'Inv ID') + ',' + r(I, 'Gain/Loss (Rp)') + ',' + r(I, 'Realized Gain') +
          ',LAMBDA(i,g,x,IF(i="",,N(g)+N(x))))';
      } },
      { h: 'Total Gain/Loss (%)', fmt: FMT.PCT, formula: function (r) {
        const I = T.INVESTMENTS;
        return 'MAP(' + r(I, 'Inv ID') + ',' + r(I, 'Total Gain/Loss (Rp)') + ',' + r(I, 'Acquisition Cost') +
          ',LAMBDA(i,t,c,IF(OR(i="",N(c)=0),,N(t)/N(c))))';
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
        return 'ARRAYFORMULA(IF(' + r(S, 'Quantity Sold') + '="",,' + r(S, 'Quantity Sold') + '*' + saleLotMult_(r) + '*' +
          r(S, 'Sale Price') + '))';
      } },
      { h: 'Fees', fmt: FMT.RP },
      { h: 'Realized Gain', fmt: FMT.RP, formula: function (r) {
        // proceeds − fees − quantity × acquisition price of the purchase row (×100 for lots)
        const S = T.SALES, I = T.INVESTMENTS, q = r(S, 'Quantity Sold') + '*' + saleLotMult_(r);
        return 'ARRAYFORMULA(IF(' + r(S, 'Quantity Sold') + '="",,IFERROR(' + q + '*' + r(S, 'Sale Price') + '-' + r(S, 'Fees') +
          '-' + q + '*VLOOKUP(' + r(S, 'Inv ID') + ',{' + r(I, 'Inv ID') + ',' + r(I, 'Acquisition Price') +
          '},2,FALSE),"Check Inv ID")))';
      } },
      { h: 'To Wallet', ref: [T.WALLETS, 'Wallet'] },
      { h: 'Link ID', w: 90 }
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
      { h: 'Keywords', w: 200 },
      { h: 'Type', list: LISTS.FAV_TYPES, w: 90 },
      { h: 'Value Type', list: LISTS.VALUE_TYPES, w: 90 },
      { h: 'Amount', fmt: FMT.RP },
      { h: 'Category', ref: [T.CATEGORIES, 'Category'] },
      { h: 'Wallet', ref: [T.WALLETS, 'Wallet'] },
      { h: 'To Wallet', ref: [T.WALLETS, 'Wallet'] },
      { h: 'Default Fee', fmt: FMT.RP },
      { h: 'Schedule', list: LISTS.SCHEDULES, w: 90 },
      { h: 'Day/Date', w: 90 },
      { h: 'Start Date', fmt: FMT.DATE },
      { h: 'Remind', w: 90 },
      { h: 'Last Logged', fmt: FMT.DATE },
      { h: 'Last Skipped', fmt: FMT.DATE },
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
      { h: 'Investment Categories', w: 170 }, // typed list; each investment wallet picks one (Wallets → Investment Category)
      { h: 'Wallet Groups', w: 130 }
    ] },

    // Filled at monthly closing (Phase 8): one row per budgeted category per month.
    { name: T.BUDGET_HISTORY, columns: [
      { h: 'Month Key', w: 90 },
      { h: 'Month', fmt: FMT.TEXT, w: 90 },
      { h: 'Category', w: 160 },
      { h: 'Budget', fmt: FMT.RP },
      { h: 'Spent', fmt: FMT.RP },
      { h: 'Remaining', fmt: FMT.RP },
      { h: 'Status', list: LISTS.BUDGET_STATUSES, w: 80 }
    ] },

    // Written at monthly closing: each fully paid / converted hutang-piutang and fully sold purchase it moved out.
    { name: T.CLOSED_HISTORY, columns: [
      { h: 'Month Key', w: 90 },
      { h: 'Month', fmt: FMT.TEXT, w: 90 },
      { h: 'Kind', w: 90 },
      { h: 'ID', w: 100 },
      { h: 'Name', w: 220 },
      { h: 'Amount', fmt: FMT.RP },
      { h: 'Result', w: 90 },
      { h: 'Gain/Loss', fmt: FMT.RP, redIfNegative: true },
      { h: 'Closed At', fmt: FMT.DATETIME },
      { h: 'Archive Link', w: 200 }
    ] },

    // Written at monthly closing: each category's expense / income of the closed month (the Dashboard's
    // category trends, because a closed month's Transactions rows move to its archive).
    { name: T.CATEGORY_HISTORY, columns: [
      { h: 'Month Key', w: 90 },
      { h: 'Month', fmt: FMT.TEXT, w: 90 },
      { h: 'Category', w: 160 },
      { h: 'Type', w: 90 },
      { h: 'Amount', fmt: FMT.RP }
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

/**
 * Per debt row: sum of Transactions amounts with this Debt ID (and its
 * sub-records "ID-*") where column `col` equals `value`.
 */
function debtSumFormula_(r, col, value, more) {
  const D = TAB.DEBTS, X = TAB.TRANSACTIONS;
  const sum = function (idExpr) {
    return 'SUMIFS(' + r(X, 'Amount') + ',' + r(X, 'Debt ID') + ',' + idExpr + ',' + r(X, col) + ',"' + value + '"' + (more || '') + ')';
  };
  return 'MAP(' + r(D, 'Debt ID') + ',LAMBDA(id,IF(id="",,' + sum('id') + '+' + sum('id&"-*"') + ')))';
}

// Investment formula pieces: remaining quantity, value at current price
// (falls back to acquisition price until a price is entered), and cost.
function qtyOf_(r) { return r(TAB.INVESTMENTS, 'Quantity'); }
/** ×100 for stock rows (Unit "lot": quantity in lots, prices per lembar), else ×1. */
function lotMultOf_(r) {
  return 'IF(' + r(TAB.INVESTMENTS, 'Unit') + '="lot",100,1)';
}
function valueOf_(r) {
  const I = TAB.INVESTMENTS;
  return r(I, 'Quantity') + '*' + lotMultOf_(r) + '*IF(' + r(I, 'Current Price') + '="",' + r(I, 'Acquisition Price') + ',' +
    r(I, 'Current Price') + ')';
}
function costOf_(r) {
  return r(TAB.INVESTMENTS, 'Quantity') + '*' + lotMultOf_(r) + '*' + r(TAB.INVESTMENTS, 'Acquisition Price');
}

/** Investment_Sales: ×100 when the purchase row (by Inv ID) is a lot row. */
function saleLotMult_(r) {
  const I = TAB.INVESTMENTS, S = TAB.SALES;
  return 'IF(IFERROR(VLOOKUP(' + r(S, 'Inv ID') + ',{' + r(I, 'Inv ID') + ',' + r(I, 'Unit') + '},2,FALSE))="lot",100,1)';
}

/** Per Inv ID: the sum of an Investment_Sales column for that purchase. */
function salesSumOf_(r, salesHeader) {
  const I = TAB.INVESTMENTS, S = TAB.SALES;
  return 'MAP(' + r(I, 'Inv ID') + ',LAMBDA(i,IF(i="",,SUMIFS(' + r(S, salesHeader) + ',' + r(S, 'Inv ID') + ',i))))';
}

/** The distinct (category, asset) pairs of Investment_Details, sorted. */
function invAssetPairs_(r) {
  const I = TAB.INVESTMENTS;
  return 'SORT(UNIQUE(FILTER({' + r(I, 'Investment Category') + ',' + r(I, 'Asset Name') + '},' + r(I, 'Asset Name') + '<>"")))';
}

/** A formula per asset row of the Investments summary (a = the asset name). */
function perAsset_(r, expr) {
  return 'MAP(' + r(TAB.INV_SUMMARY, 'Asset Name') + ',LAMBDA(a,IF(a="",,' + expr + ')))';
}

/** Per asset: the sum of an Investment_Details column over all its purchases. */
function detailSumOf_(r, header) {
  const I = TAB.INVESTMENTS;
  return perAsset_(r, 'SUMIFS(' + r(I, header) + ',' + r(I, 'Asset Name') + ',a)');
}

/** Per asset: one summary column divided by another (blank when the divisor is 0). */
function perUnit_(r, top, bottom) {
  const A = TAB.INV_SUMMARY;
  return 'MAP(' + r(A, 'Asset Name') + ',' + r(A, top) + ',' + r(A, bottom) + ',LAMBDA(a,t,b,IF(OR(a="",N(b)=0),,N(t)/N(b))))';
}

/** Per asset: a money column ÷ a quantity column = price per lembar (lots ×100) / gr / unit. */
function perPrice_(r, top, bottom) {
  const A = TAB.INV_SUMMARY;
  return 'MAP(' + r(A, 'Asset Name') + ',' + r(A, top) + ',' + r(A, bottom) + ',' + r(A, 'Unit') +
    ',LAMBDA(a,t,b,u,IF(OR(a="",N(b)=0),,N(t)/(N(b)*IF(u="lot",100,1)))))';
}

/** Dashboard AE3: the investment categories (Settings list). */
function dashboardInvCategoriesFormula_(r) {
  const list = r(TAB.SETTINGS, 'Investment Categories');
  return '=IFERROR(FILTER(' + list + ',' + list + '<>""))';
}

/** Dashboard: wallet groups of cash wallets and their balance (AB3 / AC3). */
function dashboardGroupFormulas_(r) {
  const W = TAB.WALLETS;
  // (REGEXMATCH(…)=FALSE) works element by element inside FILTER / SUMPRODUCT; NOT() may not.
  const cash = '(REGEXMATCH(' + r(W, 'Wallet Type') + '&"","' + INV_WALLET_TYPE_RE + '")=FALSE)';
  // A wallet can be in several groups ("Spending, Investment Wallet"); it counts in the first one.
  const home = 'TRIM(REGEXEXTRACT(' + r(W, 'Wallet Group') + '&"","^[^,]*"))';
  return {
    groups: '=IFERROR(UNIQUE(FILTER(' + home + ',' + r(W, 'Wallet Group') + '<>"",' + cash + ')))',
    balances: '=MAP(AB3:AB30,LAMBDA(g,IF(g="",,SUMPRODUCT((' + home + '=g)*' + cash + ',' + r(W, 'Current Balance') + '))))'
  };
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
  headerCacheOff_ = true; // this function changes or checks headers: always read them fresh
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
  headerCacheOff_ = true; // this function changes or checks headers: always read them fresh
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
 * Phase 4: turns Added / Paid / Status of an existing Hutang_Piutang tab into
 * formula columns, adds Converted (after Paid) and replaces the old
 * Remaining formula. A column that already has typed values is left alone
 * and reported, so no data is ever overwritten.
 */
function upgradeDebtColumns_(ss) {
  const sheet = ss.getSheetByName(TAB.DEBTS);
  const schema = getSchema_().filter(function (t) { return t.name === TAB.DEBTS; })[0].columns;
  const col = function (h) { return getHeaderMap_(sheet)[h.toLowerCase()]; };
  const hasData = function (c) {
    const last = sheet.getLastRow();
    if (last < 2) return false;
    return sheet.getRange(2, c + 1, last - 1, 1).getValues().some(function (r) { return String(r[0]).trim() !== ''; });
  };
  const done = [];
  const skipped = [];
  const locale = ss.getSpreadsheetLocale();
  ss.setSpreadsheetLocale('en_US'); // formulas use English syntax
  try {
    if (col('converted') === undefined && col('paid') !== undefined) {
      sheet.insertColumnAfter(col('paid') + 1);
      sheet.getRange(1, col('paid') + 2).setValue('Converted');
      done.push('added Converted');
    }
    ['Added', 'Paid', 'Converted', 'Remaining', 'Status'].forEach(function (h) {
      SpreadsheetApp.flush(); // earlier formula headers must be readable before later ones refer to them
      const c = col(h);
      if (c === undefined) return;
      const formula = sheet.getRange(1, c + 1).getFormula();
      const wanted = schema.filter(function (x) { return x.h === h; })[0];
      const expected = '={"' + h + '";' + wanted.formula(makeSheetResolver_(ss)) + '}';
      if (formula === expected) return;
      if (formula === '' && hasData(c)) { skipped.push(h + ' (has typed values)'); return; }
      const data = sheet.getRange(2, c + 1, sheet.getMaxRows() - 1, 1);
      data.clearDataValidations();
      if (formula === '') data.clearContent();
      sheet.getRange(1, c + 1).setValue(h);
      setupFormulaColumn_(sheet, c + 1, wanted, makeSheetResolver_(ss));
      done.push(h + ' → formula');
    });
    SpreadsheetApp.flush();
  } finally {
    ss.setSpreadsheetLocale(locale);
  }
  return 'Hutang_Piutang: ' + (done.length ? done.join(', ') : 'already up to date') +
    (skipped.length ? '. NOT changed: ' + skipped.join(', ') + ' — clear those cells and run again' : '');
}

/**
 * Creates any tab from the schema that an existing spreadsheet doesn't have
 * yet (e.g. Budget_History), with headers, formats, dropdowns and
 * protection, at the end. Existing tabs are never touched.
 */
function upgradeMissingTabs_(ss) {
  const added = [];
  getSchema_().forEach(function (tab) {
    if (ss.getSheetByName(tab.name) !== null || tab.columns.length === 0) return;
    const locale = ss.getSpreadsheetLocale();
    ss.setSpreadsheetLocale('en_US'); // in case the tab has formula columns
    try {
      const details = tab.name === TAB.INV_SUMMARY ? ss.getSheetByName(TAB.INVESTMENTS) : null;
      const sheet = ss.insertSheet(tab.name, details ? details.getIndex() - 1 : ss.getSheets().length);
      setupTab_(ss, sheet, tab, makeSheetResolver_(ss));
      SpreadsheetApp.flush();
    } finally {
      ss.setSpreadsheetLocale(locale);
    }
    added.push(tab.name);
  });
  return added.length ? 'added tab ' + added.join(', ') : 'tabs already up to date';
}

/**
 * Adds schema columns an existing tab doesn't have yet (plain columns only,
 * e.g. Favorites → Start Date, Remind, Last Skipped), each right after the
 * column it follows in the schema, with header style, format and dropdown.
 * Existing columns and data are never changed.
 */
function upgradeMissingColumns_(ss, tabName) {
  const sheet = ss.getSheetByName(tabName);
  if (sheet === null) return tabName + ': tab not found';
  const cols = getSchema_().filter(function (t) { return t.name === tabName; })[0].columns;
  const added = [];
  const locale = ss.getSpreadsheetLocale();
  ss.setSpreadsheetLocale('en_US'); // formula columns use English syntax
  try {
  cols.forEach(function (c, i) {
    SpreadsheetApp.flush(); // earlier formula headers must be readable before later ones refer to them
    const map = getHeaderMap_(sheet);
    if (c.h === '' || map[c.h.toLowerCase()] !== undefined) return;
    let after = sheet.getLastColumn(); // 1-based column to insert after
    for (let k = i - 1; k >= 0; k--) {
      if (map[cols[k].h.toLowerCase()] !== undefined) { after = map[cols[k].h.toLowerCase()] + 1; break; }
    }
    sheet.insertColumnAfter(after);
    const col = after + 1;
    sheet.getRange(1, col).setValue(c.h).setFontWeight('bold').setBackground(HEADER_BG).setVerticalAlignment('middle');
    sheet.setColumnWidth(col, c.w || 130);
    const data = sheet.getRange(2, col, sheet.getMaxRows() - 1, 1);
    data.clearDataValidations();
    data.setNumberFormat(c.fmt || 'General');
    if (c.list) {
      data.setDataValidation(SpreadsheetApp.newDataValidation()
        .requireValueInList(c.list, true).setAllowInvalid(true).build());
    }
    if (c.formula) {
      SpreadsheetApp.flush();
      setupFormulaColumn_(sheet, col, c, makeSheetResolver_(ss));
    }
    added.push(c.h);
  });
  SpreadsheetApp.flush();
  } finally {
    ss.setSpreadsheetLocale(locale);
  }
  return tabName + ': ' + (added.length ? 'added ' + added.join(', ') : 'columns already up to date');
}

/**
 * Phase 6: the old "Investments" tab (one row per purchase) becomes
 * "Investment_Details"; a new "Investments" tab (one row per asset) is then
 * added by upgradeMissingTabs_. Formulas that refer to the tab follow the
 * rename automatically.
 */
function renameInvestmentDetails_(ss) {
  if (ss.getSheetByName(TAB.INVESTMENTS) !== null) return 'Investment_Details: already there';
  const old = ss.getSheetByName(TAB.INV_SUMMARY);
  if (old === null || getHeaderMap_(old)['inv id'] === undefined) return 'Investment_Details: nothing to rename';
  old.setName(TAB.INVESTMENTS);
  SpreadsheetApp.flush();
  return 'renamed "' + TAB.INV_SUMMARY + '" → "' + TAB.INVESTMENTS + '"';
}

/**
 * Phase 6 wallet types: Wallet Type dropdown = Cash / Emas / Saham / Others;
 * wallets with the old type "Investment" get Emas / Saham by name, else Others;
 * the Current Balance formula and the Dashboard wallet-group formulas learn
 * the new types.
 */
function upgradeWalletTypes_(ss) {
  const sheet = ss.getSheetByName(TAB.WALLETS);
  const done = [];
  const locale = ss.getSpreadsheetLocale();
  ss.setSpreadsheetLocale('en_US');
  try {
    const map = getHeaderMap_(sheet);
    const typeCol = map['wallet type'] + 1;
    sheet.getRange(2, typeCol, sheet.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(LISTS.WALLET_TYPES, true).setAllowInvalid(true).build());
    const last = sheet.getLastRow();
    if (last >= 2) {
      const names = sheet.getRange(2, map['wallet'] + 1, last - 1, 1).getValues();
      const range = sheet.getRange(2, typeCol, last - 1, 1);
      const types = range.getValues();
      let changed = 0;
      types.forEach(function (t, i) {
        if (!/^investment$/i.test(String(t[0]).trim())) return;
        const n = String(names[i][0]).toLowerCase();
        t[0] = /emas|gold|antam/.test(n) ? 'Emas' : /saham|stock/.test(n) ? 'Saham' : 'Others';
        changed++;
      });
      if (changed) { range.setValues(types); done.push(changed + ' wallet type(s) set'); }
    }
    const balance = getSchema_().filter(function (t) { return t.name === TAB.WALLETS; })[0].columns
      .filter(function (c) { return c.h === 'Current Balance'; })[0];
    const balCol = map['current balance'] + 1;
    const expected = '={"Current Balance";' + balance.formula(makeSheetResolver_(ss)) + '}';
    if (sheet.getRange(1, balCol).getFormula() !== expected) {
      sheet.getRange(1, balCol).setFormula(expected);
      done.push('Current Balance formula updated');
    }
    const dash = ss.getSheetByName(TAB.DASHBOARD);
    if (dash !== null && dash.getRange('AB2').getValue() === 'Wallet Group') {
      const f = dashboardGroupFormulas_(makeSheetResolver_(ss));
      dash.getRange('AB3').setFormula(f.groups);
      dash.getRange('AC3').setFormula(f.balances);
      if (dash.getRange('AE2').getValue() === 'Investment Category') dash.getRange('AE3').setFormula(dashboardInvCategoriesFormula_(makeSheetResolver_(ss)));
      done.push('Dashboard wallet groups and investment categories updated');
    }
    SpreadsheetApp.flush();
  } finally {
    ss.setSpreadsheetLocale(locale);
  }
  return 'Wallets: ' + (done.length ? done.join(', ') : 'already up to date');
}

/**
 * Phase 6 (owner, final): stocks are kept in LOTS with prices per LEMBAR.
 * - Unit share/lembar rows → lot: Quantity ÷100 (Investment_Sales too);
 *   prices stay per lembar.
 * - Unit lot rows whose prices are per lot (Acquisition Cost ≈ qty × price,
 *   from the very first Phase 6 version) → prices ÷100 (Investment_Sales and
 *   Price_History too).
 * Values and Acquisition Cost don't change. Safe to run again (a converted
 * row no longer matches either case).
 */
function convertStockRows_(ss) {
  const inv = ss.getSheetByName(TAB.INVESTMENTS);
  if (inv === null) return 'stocks: no Investment_Details tab';
  const num = function (v) { return Number(v) || 0; };
  const toLots = [];
  const perLot = [];
  readTableByHeaders_(inv, 'Asset Name').forEach(function (r) {
    const unit = String(r['unit']).trim().toLowerCase();
    const q = num(r['quantity']);
    const p = num(r['acquisition price']);
    const cost = num(r['acquisition cost']);
    if (/^(share|shares|lembar|lbr)$/.test(unit)) toLots.push(r);
    else if (/^lots?$/.test(unit) && q > 0 && p > 0 && Math.abs(cost - q * p) < Math.abs(cost - q * 100 * p)) perLot.push(r);
  });
  if (toLots.length + perLot.length === 0) return 'stocks: already in lots';
  toLots.forEach(function (r) { writeRowsByHeaders_(inv, r._row, [{ 'Unit': 'lot', 'Quantity': num(r['quantity']) / 100 }]); });
  perLot.forEach(function (r) {
    const v = { 'Unit': 'lot', 'Acquisition Price': num(r['acquisition price']) / 100 };
    if (r['current price'] !== '' && r['current price'] !== null) v['Current Price'] = num(r['current price']) / 100;
    writeRowsByHeaders_(inv, r._row, [v]);
  });
  const ids = function (list) { return list.map(function (r) { return String(r['inv id']).trim(); }); };
  const lotIds = ids(toLots);
  const priceIds = ids(perLot);
  const sales = ss.getSheetByName(TAB.SALES);
  if (sales !== null) {
    readTableByHeaders_(sales, 'Inv ID').forEach(function (r) {
      const id = String(r['inv id']).trim();
      if (lotIds.indexOf(id) !== -1) writeRowsByHeaders_(sales, r._row, [{ 'Quantity Sold': num(r['quantity sold']) / 100 }]);
      if (priceIds.indexOf(id) !== -1) writeRowsByHeaders_(sales, r._row, [{ 'Sale Price': num(r['sale price']) / 100 }]);
    });
  }
  const prices = ss.getSheetByName(TAB.PRICES);
  if (prices !== null && priceIds.length) {
    readTableByHeaders_(prices, 'Inv ID').filter(function (r) { return priceIds.indexOf(String(r['inv id']).trim()) !== -1; })
      .forEach(function (r) { writeRowsByHeaders_(prices, r._row, [{ 'Price': num(r['price']) / 100 }]); });
  }
  return 'stocks: ' + [lotIds.length ? lotIds.join(', ') + ' lembar → lot' : '', priceIds.length ? priceIds.join(', ') + ' prices → per lembar' : '']
    .filter(String).join('; ');
}

/**
 * Rewrites the header formula of every formula column of a tab whose formula
 * changed in the schema (e.g. the lot ×100 in Phase 6). Data is untouched.
 */
function refreshFormulas_(ss, tabName) {
  const sheet = ss.getSheetByName(tabName);
  if (sheet === null) return tabName + ': tab not found';
  const cols = getSchema_().filter(function (t) { return t.name === tabName; })[0].columns.filter(function (c) { return c.formula; });
  const done = [];
  const locale = ss.getSpreadsheetLocale();
  ss.setSpreadsheetLocale('en_US'); // formulas use English syntax
  try {
    cols.forEach(function (c) {
      SpreadsheetApp.flush();
      const col = getHeaderMap_(sheet)[c.h.toLowerCase()];
      if (col === undefined) return;
      const expected = '={"' + c.h + '";' + c.formula(makeSheetResolver_(ss)) + '}';
      if (sheet.getRange(1, col + 1).getFormula() === expected) return;
      sheet.getRange(1, col + 1).setFormula(expected);
      done.push(c.h);
    });
    SpreadsheetApp.flush();
  } finally {
    ss.setSpreadsheetLocale(locale);
  }
  return tabName + ': ' + (done.length ? 'formulas updated (' + done.join(', ') + ')' : 'formulas up to date');
}

/**
 * Settings → Investment Categories used to be a formula (Categories with Type
 * Investment). It becomes a list you type: the current values stay as typed
 * values, the formula and its protection go.
 */
function settingsInvCategoriesToList_(ss) {
  const sheet = ss.getSheetByName(TAB.SETTINGS);
  const col = getHeaderMap_(sheet)['investment categories'];
  if (col === undefined) return 'Investment Categories: column not found';
  const head = sheet.getRange(1, col + 1);
  if (head.getFormula() === '') return 'Investment Categories: already a typed list';
  const last = sheet.getLastRow();
  const values = last >= 2 ? sheet.getRange(2, col + 1, last - 1, 1).getValues().filter(function (r) { return String(r[0]).trim() !== ''; }) : [];
  head.setValue('Investment Categories').setBackground(HEADER_BG);
  SpreadsheetApp.flush();
  if (last >= 2) sheet.getRange(2, col + 1, last - 1, 1).clearContent();
  if (values.length) sheet.getRange(2, col + 1, values.length, 1).setValues(values);
  sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (pr) {
    if (pr.getDescription() === 'Formula column: Investment Categories') pr.remove();
  });
  return 'Investment Categories: now a typed list (' + values.map(function (r) { return r[0]; }).join(', ') + ')';
}

/**
 * Fills the new columns for data from before: an investment wallet without an
 * Investment Category gets its own name (that was its category until now) and
 * the name is added to the Settings list; an Investment_Details row without an
 * Investment Wallet gets the wallet named in its Investment Category.
 */
function fillInvestmentWallets_(ss) {
  const done = [];
  const wallets = ss.getSheetByName(TAB.WALLETS);
  const settings = ss.getSheetByName(TAB.SETTINGS);
  const listed = readTableByHeaders_(settings, 'Investment Categories').map(function (r) { return String(r['investment categories']).trim().toLowerCase(); });
  const toList = [];
  if (getHeaderMap_(wallets)['investment category'] !== undefined) {
    readTableByHeaders_(wallets, 'Wallet').forEach(function (r) {
      if (!walletKind_(r['wallet type'])) return;
      let cat = String(r['investment category'] || '').trim();
      if (!cat) {
        cat = String(r['wallet']).trim();
        writeRowsByHeaders_(wallets, r._row, [{ 'Investment Category': cat }]);
        done.push(cat + ' → category ' + cat);
      }
      if (listed.indexOf(cat.toLowerCase()) === -1 && toList.indexOf(cat) === -1) toList.push(cat);
    });
  }
  if (toList.length) {
    writeRowsByHeaders_(settings, lastDataRow_(settings, 'Investment Categories') + 1, toList.map(function (c) { return { 'Investment Categories': c }; }));
    done.push('listed ' + toList.join(', '));
  }
  const inv = ss.getSheetByName(TAB.INVESTMENTS);
  if (inv !== null && getHeaderMap_(inv)['investment wallet'] !== undefined) {
    let n = 0;
    readTableByHeaders_(inv, 'Asset Name').forEach(function (r) {
      if (String(r['investment wallet'] || '').trim() !== '' || String(r['investment category'] || '').trim() === '') return;
      writeRowsByHeaders_(inv, r._row, [{ 'Investment Wallet': String(r['investment category']).trim() }]);
      n++;
    });
    if (n) done.push(n + ' Investment_Details row(s) got their Investment Wallet');
  }
  return 'investment wallets: ' + (done.length ? done.join('; ') : 'already filled');
}

/** Phase 7: the Input Source dropdown becomes Text / OCR-GoPay / OCR-Receipt / Favorite / Sheet. */
function upgradeInputSources_(ss) {
  const sheet = ss.getSheetByName(TAB.TRANSACTIONS);
  const col = getHeaderMap_(sheet)['input source'];
  if (col === undefined) return 'Input Source: column not found';
  sheet.getRange(2, col + 1, sheet.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(LISTS.INPUT_SOURCES, true).setAllowInvalid(true).build());
  return 'Input Source: dropdown = ' + LISTS.INPUT_SOURCES.join(' / ');
}

/** Adds a name to the Settings → Wallet Groups helper list (the dropdown source) if it's missing. */
function addWalletGroupOption_(ss, name) {
  const sheet = ss.getSheetByName(TAB.SETTINGS);
  const have = readTableByHeaders_(sheet, 'Wallet Groups').map(function (r) { return String(r['wallet groups']).trim().toLowerCase(); });
  if (have.indexOf(name.toLowerCase()) !== -1) return 'Wallet Groups: "' + name + '" already listed';
  writeRowsByHeaders_(sheet, lastDataRow_(sheet, 'Wallet Groups') + 1, [{ 'Wallet Groups': name }]);
  return 'Wallet Groups: added "' + name + '"';
}

/**
 * Run from the editor after an update that adds columns or settings.
 * Upgrades the main sheet and the template, then checks the main sheet.
 * Safe to run more than once; your data and values are never changed.
 */
function upgradeSheets() {
  headerCacheOff_ = true; // this function changes or checks headers: always read them fresh
  [getProp_(PROP.MAIN_SHEET_ID), getProp_(PROP.TEMPLATE_ID)].forEach(function (id) {
    if (id === null) return;
    const ss = SpreadsheetApp.openById(id);
    console.log(ss.getName() + ' → ' + renameInvestmentDetails_(ss));
    if (ss.getSheetByName(TAB.INVESTMENTS) !== null) {
      console.log(ss.getName() + ' → ' + upgradeMissingColumns_(ss, TAB.SALES));
      console.log(ss.getName() + ' → ' + upgradeMissingColumns_(ss, TAB.INVESTMENTS));
      console.log(ss.getName() + ' → ' + convertStockRows_(ss));
    }
    console.log(ss.getName() + ' → ' + upgradeMissingTabs_(ss));
    console.log(ss.getName() + ' → ' + settingsInvCategoriesToList_(ss));
    console.log(ss.getName() + ' → ' + upgradeMissingColumns_(ss, TAB.WALLETS));
    console.log(ss.getName() + ' → ' + fillInvestmentWallets_(ss));
    console.log(ss.getName() + ' → ' + upgradeWalletTypes_(ss));
    console.log(ss.getName() + ' → ' + upgradeMissingColumns_(ss, TAB.DEBTS)); // Carried Paid (Phase 8), before its formulas
    [TAB.INVESTMENTS, TAB.SALES, TAB.INV_SUMMARY, TAB.DEBTS].forEach(function (t) { console.log(ss.getName() + ' → ' + refreshFormulas_(ss, t)); });
    console.log(ss.getName() + ' → ' + addWalletGroupOption_(ss, 'Investment Wallet'));
    console.log(ss.getName() + ' → ' + upgradeInputSources_(ss));
    console.log(ss.getName() + ' → ' + upgradeCategoryBudgetColumns_(ss));
    console.log(ss.getName() + ' → ' + upgradeDebtColumns_(ss));
    console.log(ss.getName() + ' → ' + upgradeMissingColumns_(ss, TAB.FAVORITES));
    console.log(ss.getName() + ' → ' + upgradeMissingColumns_(ss, TAB.PRICES)); // Month-End (the Dashboard reads it)
    console.log(ss.getName() + ' → ' + backfillCategoryHistory_(ss));
    console.log(ss.getName() + ' → ' + rebuildDashboard_(ss));
  });
  upgradeSettings();
  validateSheet();
}

/** Sample wallets and categories, settings, wallet groups, placeholder users. */
function writeSampleRows_(ss) {
  const get = function (name) { return ss.getSheetByName(name); };

  writeRowsByHeaders_(get(TAB.WALLETS), 2, [
    ['BCA', 'Spending, Investment Wallet', 'Cash'],
    ['GoPay', 'Spending', 'Cash'],
    ['Cash', 'Spending', 'Cash'],
    ['IPOT', 'Investment, Investment Wallet', 'Cash'],
    ['Jago', 'Savings', 'Cash'],
    ['Saham', 'Investment', 'Saham'],
    ['Emas', 'Investment', 'Emas'],
    ['Reksadana', 'Investment', 'Others'],
    ['Crypto', 'Investment', 'Others'],
    ['Deposito/Obligasi', 'Investment', 'Others']
  ].map(function (w) {
    return { 'Wallet': w[0], 'Wallet Group': w[1], 'Wallet Type': w[2], 'Investment Category': w[2] === 'Cash' ? '' : w[0],
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

  writeRowsByHeaders_(settings, 2, ['Spending', 'Savings', 'Investment', 'Investment Wallet'].map(function (g) {
    return { 'Wallet Groups': g };
  }));

  writeRowsByHeaders_(settings, 2, ['Saham', 'Emas', 'Reksadana', 'Crypto', 'Deposito/Obligasi'].map(function (c) {
    return { 'Investment Categories': c };
  }));
}

/**
 * Run from the editor after an update adds new settings: appends any
 * missing rows from SETTING_ROWS (with their default values) to the
 * Settings tab of the main sheet and the template. Existing rows and your
 * values are never changed. Safe to run more than once.
 */
function upgradeSettings() {
  headerCacheOff_ = true; // this function changes or checks headers: always read them fresh
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
    // Info rows show the folder IDs kept in Script Properties (only on the main sheet; the template stays clean).
    if (id === getProp_(PROP.MAIN_SHEET_ID)) {
      [['Archive Folder ID', PROP.ARCHIVE_FOLDER_ID], ['Receipts Folder ID', PROP.RECEIPTS_FOLDER_ID]].forEach(function (x) {
        const v = getProp_(x[1]);
        if (v) setSettingValue_(ss, x[0], v);
      });
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
 * Cash flow of the last 12 months (Dashboard T3:W14, newest in row 14). A closed month's rows are gone from
 * Transactions (they are in its archive), so its Income / Expense come from the Monthly Report tab.
 */
function dashboardCashFormulas_(r) {
  const X = TAB.TRANSACTIONS, R = TAB.REPORT;
  const out = [];
  for (let i = 0; i < 12; i++) {
    const row = 3 + i;
    const key = 'YEAR(T' + row + ')*100+MONTH(T' + row + ')';
    const sum = function (t) {
      return '=IF(COUNTIFS(' + r(R, 'Month Key') + ',' + key + ',' + r(R, 'Status') + ',"Closed")>0,SUMIFS(' +
        r(R, t) + ',' + r(R, 'Month Key') + ',' + key + '),SUMIFS(' + r(X, 'Amount') + ',' + r(X, 'Type') + ',"' + t + '",' +
        r(X, 'Date') + ',">="&T' + row + ',' + r(X, 'Date') + ',"<"&EDATE(T' + row + ',1)))';
    };
    out.push(['=EDATE((EOMONTH(TODAY(),-1)+1),' + (i - 11) + ')', sum('Income'), sum('Expense'), '=U' + row + '-V' + row,
      '=IF(N(U' + row + ')=0,,W' + row + '/U' + row + ')']);
  }
  return out;
}

/**
 * Rebuilds the Dashboard tab of an existing sheet (it holds only formulas and charts, never data), so a
 * new Dashboard design reaches the main sheet and the template. Run by upgradeSheets.
 */
function rebuildDashboard_(ss) {
  let sheet = ss.getSheetByName(TAB.DASHBOARD);
  if (sheet === null) sheet = ss.insertSheet(TAB.DASHBOARD, 0);
  const locale = ss.getSpreadsheetLocale();
  ss.setSpreadsheetLocale('en_US'); // formulas use English syntax
  try {
    sheet.getCharts().forEach(function (c) { sheet.removeChart(c); });
    sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (p) { p.remove(); });
    sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) { p.remove(); });
    sheet.clearConditionalFormatRules();
    sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).breakApart();
    sheet.clear();
    buildDashboard_(ss, sheet, makeSheetResolver_(ss));
    SpreadsheetApp.flush();
  } finally {
    ss.setSpreadsheetLocale(locale);
  }
  return 'Dashboard rebuilt';
}

/**
 * The Dashboard (owner's request, 2026-11-18): a readable summary on the left — this month, where the
 * money is, spending pace, budget health, category trends, top expenses, who logged what, debts coming
 * up — and the charts below it. Everything is a live formula over the other tabs; the helper tables the
 * charts and summaries use are in columns T onward. Expense / income use the shared rule (Type =
 * Expense / Income, like countsAsExpense_ / countsAsIncome_); closed months come from Monthly Report and
 * Category_History. The sheet must be en_US while this runs.
 */
function buildDashboard_(ss, sheet, r) {
  const X = TAB.TRANSACTIONS, W = TAB.WALLETS, C = TAB.CATEGORIES, I = TAB.INVESTMENTS, R = TAB.REPORT, D = TAB.DEBTS,
    H = TAB.CATEGORY_HISTORY;
  const amt = r(X, 'Amount'), type = r(X, 'Type'), date = r(X, 'Date'), cat = r(X, 'Category');
  const catName = r(C, 'Category'), catType = r(C, 'Type'), budget = r(C, 'Monthly Budget');
  const ms = '(EOMONTH(TODAY(),-1)+1)', nx = '(EOMONTH(TODAY(),0)+1)';
  const days = 'DAY(EOMONTH(TODAY(),0))', dayNow = 'DAY(TODAY())';
  const thisMonth = ',' + date + ',">="&' + ms + ',' + date + ',"<"&' + nx;
  const RP = FMT.RP, PCT0 = '0%';
  const UPDOWN_PCT = '▲ 0%;▼ 0%;"="';
  const UPDOWN_RP = '▲ "Rp"#,##0;▼ "Rp"#,##0;"="';

  if (sheet.getMaxColumns() < 45) sheet.insertColumnsAfter(sheet.getMaxColumns(), 45 - sheet.getMaxColumns());
  if (sheet.getMaxRows() < 160) sheet.insertRowsAfter(sheet.getMaxRows(), 160 - sheet.getMaxRows());
  sheet.setHiddenGridlines(true);
  sheet.setColumnWidth(1, 20);
  for (let c = 2; c <= 17; c++) sheet.setColumnWidth(c, 115);
  sheet.setColumnWidth(10, 30); // gap between the left and right tables

  const section = function (a1, text) {
    sheet.getRange(a1).setValue(text).setFontSize(12).setFontWeight('bold').setFontColor('#1f3864');
  };
  const header = function (a1, values) {
    sheet.getRange(a1).setValues([values]).setFontWeight('bold').setBackground(HEADER_BG);
  };
  const labels = function (a1, values) {
    sheet.getRange(a1).setValues([values]).setFontColor('#666666').setFontSize(9);
  };
  const values = function (a1) { return sheet.getRange(a1).setFontSize(14).setFontWeight('bold'); };

  sheet.getRange('B1').setValue('MonetaBot Dashboard').setFontSize(18).setFontWeight('bold');
  sheet.getRange('B2').setFormula('="Live from the sheet · today is "&TEXT(TODAY(),"d mmm yyyy")').setFontColor('#666666');

  // ---- Helper tables (columns T onward; formulas only) -------------------------------------------------
  sheet.getRange('T1').setValue('Chart and summary data: formulas, do not edit').setFontStyle('italic');

  // Cash flow + savings rate, last 12 months (T:X; row 14 = this month, row 13 = last month)
  sheet.getRange('T2:X2').setValues([['Month', 'Income', 'Expense', 'Net', 'Savings Rate']]);
  sheet.getRange('T3:X14').setFormulas(dashboardCashFormulas_(r));
  sheet.getRange('T3:T14').setNumberFormat(FMT.MONTH);
  sheet.getRange('U3:W14').setNumberFormat(RP);
  sheet.getRange('X3:X14').setNumberFormat(PCT0);

  // Expenses by category, this month (Y:Z)
  sheet.getRange('Y2:Z2').setValues([['Category', 'Expense This Month']]);
  sheet.getRange('Y3').setFormula('=IFERROR(FILTER(' + catName + ',' + catType + '="Expense"))');
  sheet.getRange('Z3').setFormula('=MAP(Y3:Y60,LAMBDA(c,IF(c="",,SUMIFS(' + amt + ',' + type + ',"Expense",' +
    cat + ',c' + thisMonth + '))))');
  sheet.getRange('Z3:Z60').setNumberFormat(RP);

  // Balance by wallet group, cash wallets only (AB:AC)
  sheet.getRange('AB2:AC2').setValues([['Wallet Group', 'Balance']]);
  const groupFormulas = dashboardGroupFormulas_(r);
  sheet.getRange('AB3').setFormula(groupFormulas.groups);
  sheet.getRange('AC3').setFormula(groupFormulas.balances);
  sheet.getRange('AC3:AC30').setNumberFormat(RP);

  // Investments by category (AE:AG)
  sheet.getRange('AE2:AG2').setValues([['Investment Category', 'Current Value', 'Gain/Loss']]);
  sheet.getRange('AE3').setFormula(dashboardInvCategoriesFormula_(r));
  sheet.getRange('AF3').setFormula('=MAP(AE3:AE30,LAMBDA(c,IF(c="",,SUMIFS(' + r(I, 'Current Value') + ',' +
    r(I, 'Investment Category') + ',c))))');
  sheet.getRange('AG3').setFormula('=MAP(AE3:AE30,LAMBDA(c,IF(c="",,SUMIFS(' + r(I, 'Gain/Loss (Rp)') + ',' +
    r(I, 'Investment Category') + ',c))))');
  sheet.getRange('AF3:AG30').setNumberFormat(RP);

  // Expense per category, last 6 months (AI:AO; AO = this month). Closed months from Category_History.
  sheet.getRange('AI2').setValue('Category');
  const monthCols = ['AJ', 'AK', 'AL', 'AM', 'AN', 'AO'];
  sheet.getRange('AJ2:AO2').setFormulas([monthCols.map(function (c, i) { return '=EDATE(' + ms + ',' + (i - 5) + ')'; })])
    .setNumberFormat(FMT.MONTH);
  sheet.getRange('AI3').setFormula('=IFERROR(FILTER(' + catName + ',' + catType + '="Expense"))');
  sheet.getRange('AJ3:AO3').setFormulas([monthCols.map(function (c) {
    const m = c + '$2', key = 'YEAR(' + m + ')*100+MONTH(' + m + ')';
    return '=MAP($AI$3:$AI$60,LAMBDA(c,IF(c="",,IF(COUNTIFS(' + r(R, 'Month Key') + ',' + key + ',' + r(R, 'Status') +
      ',"Closed")>0,SUMIFS(' + r(H, 'Amount') + ',' + r(H, 'Month Key') + ',' + key + ',' + r(H, 'Category') + ',c,' +
      r(H, 'Type') + ',"Expense"),SUMIFS(' + amt + ',' + type + ',"Expense",' + cat + ',c,' + date + ',">="&' + m + ',' +
      date + ',"<"&EDATE(' + m + ',1))))))';
  })]);
  sheet.getRange('AJ3:AO60').setNumberFormat(RP);
  sheet.getRange('T2:AO2').setFontWeight('bold');

  // Investment categories: value at the start of this month (AH), from the month-end snapshot closing writes
  // into Price_History (Month-End = Yes, dated the last day of last month). Blank when there is none.
  const P = TAB.PRICES, S = TAB.SALES;
  const lastEom = 'EOMONTH(TODAY(),-1)';
  const snapOn = 'COUNTIFS(' + r(P, 'Month-End') + ',"Yes",' + r(P, 'Date') + ',' + lastEom + ')';
  sheet.getRange('AH2').setValue('Month Start');
  sheet.getRange('AH3').setFormula('=MAP(AE3:AE30,LAMBDA(c,IF(OR(c="",' + snapOn + '=0),,SUMPRODUCT((' + r(P, 'Month-End') +
    '="Yes")*(' + r(P, 'Date') + '=' + lastEom + ')*(IFERROR(VLOOKUP(' + r(P, 'Inv ID') + ',{' + r(I, 'Inv ID') + ',' +
    r(I, 'Investment Category') + '},2,FALSE),"")=c),IF(ISNUMBER(' + r(P, 'Value') + '),' + r(P, 'Value') + ',0)))))');
  sheet.getRange('AH3:AH30').setNumberFormat(RP);

  // ---- 📈 Investments this month (K:P, top right) --------------------------------------------------------
  section('K4', '📈 Investments this month');
  labels('K5:O5', ['Bought', 'Sold', 'Realized gain', 'Portfolio now', 'Change since month start']);
  values('K6:O6').setFormulas([[
    '=SUMIFS(' + amt + ',' + type + ',"Investment Buy"' + thisMonth + ')',
    '=SUMIFS(' + amt + ',' + type + ',"Investment Sell"' + thisMonth + ')',
    '=SUMIFS(' + r(S, 'Realized Gain') + ',' + r(S, 'Sale Date') + ',">="&' + ms + ',' + r(S, 'Sale Date') + ',"<"&' + nx + ')',
    '=SUM(' + r(I, 'Current Value') + ')',
    '=IF(' + snapOn + '=0,"—",N6-SUMIFS(' + r(P, 'Value') + ',' + r(P, 'Month-End') + ',"Yes",' + r(P, 'Date') + ',' + lastEom + '))'
  ]]).setNumberFormat(RP);
  sheet.getRange('O7').setValue('incl. money added or taken out').setFontColor('#999999').setFontSize(9);
  header('K9:O9', ['Category', 'Month Start', 'Now', 'Change', 'Gain/Loss %']);
  sheet.getRange('K10').setFormula('=IFERROR(ARRAY_CONSTRAIN(FILTER(AE3:AE30,AE3:AE30<>""),7,1),"No investments yet")');
  sheet.getRange('L10:O10').setFormulas([[
    '=MAP(K10:K16,LAMBDA(c,IF(OR(c="",c="No investments yet"),,IFERROR(INDEX(AH3:AH30,MATCH(c,AE3:AE30,0)),""))))',
    '=MAP(K10:K16,LAMBDA(c,IF(OR(c="",c="No investments yet"),,SUMIFS(AF3:AF30,AE3:AE30,c))))',
    '=MAP(L10:L16,M10:M16,LAMBDA(a,b,IF(OR(a="",b=""),,b-a)))',
    '=MAP(K10:K16,M10:M16,LAMBDA(c,v,IF(OR(c="",v=""),,IFERROR(SUMIFS(AG3:AG30,AE3:AE30,c)/(v-SUMIFS(AG3:AG30,AE3:AE30,c)),""))))']]);
  sheet.getRange('L10:N16').setNumberFormat(RP);
  sheet.getRange('O10:O16').setNumberFormat('0.0%');
  sheet.getRange('K5:O7').setBackground('#f3f6fb');
  sheet.getRange('K17').setValue('Month Start comes from the closing snapshot of last month (blank before the first closing).')
    .setFontColor('#999999').setFontSize(9);

  // ---- 📅 This month ----------------------------------------------------------------------------------
  section('B4', '📅 This month');
  labels('B5:F5', ['Income', 'Expense', 'Net saved', 'Savings rate', 'Spent per day']);
  values('B6:F6').setFormulas([['=U14', '=V14', '=W14', '=IF(N(U14)=0,"—",W14/U14)', '=V14/' + dayNow]]);
  sheet.getRange('B6:D6').setNumberFormat(RP);
  sheet.getRange('E6').setNumberFormat(PCT0);
  sheet.getRange('F6').setNumberFormat(RP);
  sheet.getRange('B7:F7').setFormulas([['=IF(N(U13)=0,"",U14/U13-1)', '=IF(N(V13)=0,"",V14/V13-1)', '=W14-W13',
    '=IF(OR(N(U14)=0,N(U13)=0),"",(X14-X13)*100)', '=IF(N(V13)=0,"",(V14/' + dayNow + ')/(V13/DAY(EOMONTH(TODAY(),-1)))-1)']])
    .setFontColor('#666666').setFontSize(9);
  sheet.getRange('B7:C7').setNumberFormat(UPDOWN_PCT);
  sheet.getRange('D7').setNumberFormat(UPDOWN_RP);
  sheet.getRange('E7').setNumberFormat('▲ 0" pts";▼ 0" pts";"="');
  sheet.getRange('F7').setNumberFormat(UPDOWN_PCT);
  sheet.getRange('G7').setValue('← vs last month (whole month; spent per day is a fair comparison)').setFontColor('#999999').setFontSize(9);

  // ---- 🏦 Where your money is -------------------------------------------------------------------------
  const wType = r(W, 'Wallet Type');
  const cashMask = '(REGEXMATCH(' + wType + '&"","' + INV_WALLET_TYPE_RE + '")=FALSE)*(' + r(W, 'Wallet') + '<>"")';
  // Records with sub-records (group piutang) are counted through their sub-records only, like /report.
  const debtLeft = function (t) {
    const rem = r(D, 'Remaining');
    return '=SUMPRODUCT((' + r(D, 'Type') + '="' + t + '")*(COUNTIF(' + r(D, 'Parent ID') + ',' + r(D, 'Debt ID') + '&"")=0)*(' +
      r(D, 'Debt ID') + '<>""),IF(ISNUMBER(' + rem + '),IF(' + rem + '>0,' + rem + ',0),0))';
  };
  const bal = r(W, 'Current Balance');
  section('B9', '🏦 Where your money is');
  labels('B10:F10', ['Cash (all wallets)', 'Investments', 'Piutang (owed to you)', 'Hutang (you owe)', 'Net worth']);
  values('B11:F11').setFormulas([[
    '=SUMPRODUCT(' + cashMask + ',IF(ISNUMBER(' + bal + '),' + bal + ',0))',
    '=SUM(' + r(I, 'Current Value') + ')',
    debtLeft('Piutang'), debtLeft('Hutang'),
    '=B11+C11+D11-E11']]).setNumberFormat(RP);
  sheet.getRange('F12').setFormula('=IFERROR(F11-INDEX(SORT(FILTER({' + r(R, 'Month Key') + ',' + r(R, 'Net Worth') + '},' +
    r(R, 'Status') + '="Closed"),1,FALSE),1,2),"")').setNumberFormat('▲ "Rp"#,##0" since last closing";▼ "Rp"#,##0" since last closing";"="')
    .setFontColor('#666666').setFontSize(9);
  sheet.getRange('B12').setValue('Net worth = cash + investments + piutang − hutang (same as /report)').setFontColor('#999999').setFontSize(9);

  // ---- ⏱ Spending pace --------------------------------------------------------------------------------
  const budgetTotal = 'SUMIFS(' + budget + ',' + catType + ',"Expense",' + budget + ',">0")';
  const budgetSpent = 'SUMIFS(' + r(C, 'Spent') + ',' + catType + ',"Expense",' + budget + ',">0")';
  const projBudgeted = '(' + budgetSpent + '/' + dayNow + '*' + days + ')';
  section('B14', '⏱ Spending pace');
  labels('B15:F15', ['Day of month', 'Spent so far', 'Month-end at this pace', 'Total budget', 'Budgeted spent so far']);
  values('B16:F16').setFormulas([['=' + dayNow + '&" of "&' + days, '=V14', '=V14/' + dayNow + '*' + days,
    '=' + budgetTotal, '=' + budgetSpent]]);
  sheet.getRange('C16:F16').setNumberFormat(RP);
  sheet.getRange('B17').setFormula('=IF(' + budgetTotal + '=0,"Add a Monthly Budget to your expense categories ' +
    '(Categories tab) to see whether you are on track.",IF(' + projBudgeted + '<=' + budgetTotal + ',"✅ On track. Expected left ' +
    'in your budgets at month end:","⚠️ At this pace your budgeted categories go over by:"))').setFontWeight('bold').setWrap(true);
  sheet.getRange('B17:D17').merge();
  sheet.getRange('E17').setFormula('=IF(' + budgetTotal + '=0,"",ABS(' + budgetTotal + '-' + projBudgeted + '))')
    .setNumberFormat(RP).setFontWeight('bold');
  sheet.getRange('F17').setValue('(fixed costs paid early in the month make the pace look high)').setFontColor('#999999').setFontSize(9);

  // ---- 🎯 Budget health (B:I) -------------------------------------------------------------------------
  section('B19', '🎯 Budget health');
  header('B20:I20', ['Category', 'Budget', 'Spent', '% Used', 'Should Be', 'Remaining', 'Status', 'Progress']);
  sheet.getRange('B21').setFormula('=IFERROR(FILTER(' + catName + ',' + catType + '="Expense",ISNUMBER(' + budget + '),' +
    budget + '>0),"No budgets yet: add a Monthly Budget in the Categories tab")');
  sheet.getRange('C21:I21').setFormulas([[
    '=MAP(B21:B45,LAMBDA(c,IF(OR(c="",LEFT(c,3)="No "),,SUMIFS(' + budget + ',' + catName + ',c))))',
    '=MAP(B21:B45,LAMBDA(c,IF(OR(c="",LEFT(c,3)="No "),,SUMIFS(' + r(C, 'Spent') + ',' + catName + ',c))))',
    '=MAP(C21:C45,D21:D45,LAMBDA(b,s,IF(N(b)=0,,s/b)))',
    '=MAP(C21:C45,LAMBDA(b,IF(N(b)=0,,' + dayNow + '/' + days + ')))',
    '=MAP(C21:C45,D21:D45,LAMBDA(b,s,IF(N(b)=0,,b-s)))',
    '=MAP(E21:E45,F21:F45,LAMBDA(u,x,IF(u="",,IF(u>1,"🔴 Over",IF(u>x+0.1,"⚠️ Too fast","✅ On track")))))',
    '=MAP(E21:E45,LAMBDA(u,IF(u="",,REPT("█",MIN(10,ROUND(u*10)))&REPT("░",MAX(0,10-ROUND(u*10))))))']]);
  sheet.getRange('C21:D45').setNumberFormat(RP);
  sheet.getRange('E21:F45').setNumberFormat(PCT0);
  sheet.getRange('G21:G45').setNumberFormat(RP);
  sheet.getRange('I21:I45').setFontFamily('Courier New').setFontColor('#5b8def');
  sheet.getRange('B46').setValue('Should Be = how much of the budget would be used by today at an even pace.').setFontColor('#999999').setFontSize(9);

  // ---- 📈 Category trends (K:P) ------------------------------------------------------------------------
  section('K19', '📈 Category trends (expense)');
  header('K20:P20', ['Category', 'This Month', 'Last Month', 'Usual (3-mo avg)', '% of Usual', 'Last 6 Months']);
  sheet.getRange('K21').setFormula('=IFERROR(ARRAY_CONSTRAIN(SORT(FILTER({AI3:AI60,AO3:AO60,AN3:AN60,(AK3:AK60+AL3:AL60+AM3:AM60)/3},' +
    'AI3:AI60<>"",(AJ3:AJ60+AK3:AK60+AL3:AL60+AM3:AM60+AN3:AN60+AO3:AO60)>0),2,FALSE),25,4),"No expenses in the last 6 months")');
  sheet.getRange('O21').setFormula('=MAP(K21:K45,L21:L45,N21:N45,LAMBDA(c,t,a,IF(OR(c="",N(a)=0),,t/a)))');
  const spark = [];
  for (let row = 21; row <= 45; row++) {
    spark.push(['=IF(N(L' + row + ')+N(M' + row + ')+N(N' + row + ')=0,"",SPARKLINE(FILTER($AJ$3:$AO$60,$AI$3:$AI$60=K' + row +
      '),{"charttype","column";"color","#5b8def"}))']);
  }
  sheet.getRange('P21:P45').setFormulas(spark);
  sheet.getRange('L21:N45').setNumberFormat(RP);
  sheet.getRange('O21:O45').setNumberFormat(PCT0);
  sheet.getRange('K46').setValue('Usual = average of the 3 months before last month. This month is still running, so compare % of Usual with how far ' +
    'into the month we are.').setFontColor('#999999').setFontSize(9);

  // ---- 🔝 Biggest expenses (B:F) and 👥 who logged what (K:M) ----------------------------------------
  section('B48', '🔝 Biggest expenses this month');
  header('B49:F49', ['Date', 'Category', 'Note', 'Logged By', 'Amount']);
  sheet.getRange('B50').setFormula('=IFERROR(SORTN(FILTER({' + date + ',' + cat + ',' + r(X, 'Note') + ',' + r(X, 'Logged By') + ',' + amt +
    '},' + type + '="Expense",' + date + '>=' + ms + ',' + date + '<' + nx + '),5,0,5,FALSE),"No expenses yet this month")');
  sheet.getRange('B50:B54').setNumberFormat(FMT.DATE);
  sheet.getRange('F50:F54').setNumberFormat(RP);

  section('K48', '👥 Expense this month by who logged it');
  header('K49:M49', ['Logged By', 'Expense', 'Share']);
  sheet.getRange('K50').setFormula('=IFERROR(SORT(UNIQUE(FILTER(' + r(X, 'Logged By') + ',' + type + '="Expense",' + date + '>=' + ms + ',' +
    date + '<' + nx + ',' + r(X, 'Logged By') + '<>""))),"—")');
  sheet.getRange('L50').setFormula('=MAP(K50:K56,LAMBDA(p,IF(OR(p="",p="—"),,SUMIFS(' + amt + ',' + r(X, 'Logged By') + ',p,' + type +
    ',"Expense"' + thisMonth + '))))');
  sheet.getRange('M50').setFormula('=MAP(L50:L56,LAMBDA(v,IF(OR(v="",SUM(L50:L56)=0),,v/SUM(L50:L56))))');
  sheet.getRange('L50:L56').setNumberFormat(RP);
  sheet.getRange('M50:M56').setNumberFormat(PCT0);

  // ---- 📌 Hutang / piutang due (B:G) -------------------------------------------------------------------
  section('B58', '📌 Hutang / piutang due in the next 14 days (and overdue)');
  header('B59:G59', ['Due Date', 'Type', 'Name', 'Debt ID', 'Remaining', 'Days Left']);
  const due = r(D, 'Due Date'), rem = r(D, 'Remaining');
  sheet.getRange('B60').setFormula('=IFERROR(ARRAY_CONSTRAIN(SORT(FILTER({' + due + ',' + r(D, 'Type') + ',' + r(D, 'Name') + ',' +
    r(D, 'Debt ID') + ',' + rem + ',' + due + '-TODAY()},ISNUMBER(' + rem + '),' + rem + '>0,ISNUMBER(' + due + '),' + due +
    '<=TODAY()+14,COUNTIF(' + r(D, 'Parent ID') + ',' + r(D, 'Debt ID') + '&"")=0),1,TRUE),10,6),"Nothing due in the next 14 days 🎉")');
  sheet.getRange('B60:B69').setNumberFormat(FMT.DATE);
  sheet.getRange('F60:F69').setNumberFormat(RP);
  sheet.getRange('G60:G69').setNumberFormat('0" days";"overdue "0" days";"today"');

  // ---- Colours -------------------------------------------------------------------------------------------
  const red = '#cc0000', green = '#38761d', orange = '#b45f06';
  const rule = function () { return SpreadsheetApp.newConditionalFormatRule(); };
  sheet.setConditionalFormatRules([
    rule().whenNumberLessThan(0).setFontColor(red).setRanges([sheet.getRange('D6'), sheet.getRange('G21:G45')]).build(),
    rule().whenNumberGreaterThan(0).setFontColor(green).setRanges([sheet.getRange('D6')]).build(),
    rule().whenTextContains('🔴').setBackground('#f4cccc').setRanges([sheet.getRange('H21:H45')]).build(),
    rule().whenTextContains('⚠️').setBackground('#fce5cd').setRanges([sheet.getRange('H21:H45'), sheet.getRange('B17')]).build(),
    rule().whenTextContains('✅').setBackground('#d9ead3').setRanges([sheet.getRange('H21:H45'), sheet.getRange('B17')]).build(),
    rule().whenNumberGreaterThan(1).setFontColor(red).setBold(true).setRanges([sheet.getRange('E21:E45'), sheet.getRange('O21:O45')]).build(),
    rule().whenFormulaSatisfied('=AND(ISNUMBER($O21),$O21>DAY(TODAY())/DAY(EOMONTH(TODAY(),0))+0.15)').setFontColor(orange)
      .setRanges([sheet.getRange('O21:O45')]).build(),
    rule().whenNumberLessThan(0).setFontColor(red).setRanges([sheet.getRange('M6:O6'), sheet.getRange('N10:O16')]).build(),
    rule().whenNumberGreaterThan(0).setFontColor(green).setRanges([sheet.getRange('M6'), sheet.getRange('O6'), sheet.getRange('N10:O16')]).build(),
    rule().whenNumberLessThan(0).setFontColor(red).setBold(true).setRanges([sheet.getRange('G60:G69')]).build(),
    rule().whenNumberBetween(0, 3).setFontColor(orange).setRanges([sheet.getRange('G60:G69')]).build()
  ]);
  sheet.getRange('B5:F7').setBackground('#f3f6fb');
  sheet.getRange('B10:F12').setBackground('#f3f6fb');
  sheet.getRange('B15:F17').setBackground('#f3f6fb');

  // ---- Charts (below the summary, two per row) -----------------------------------------------------------
  section('B71', '📊 Charts');
  const addChart = function (chartType, ranges, title, row, col, options) {
    let b = sheet.newChart().setChartType(chartType);
    ranges.forEach(function (a1) { b = b.addRange(ss.getRange(a1)); });
    b = b.setNumHeaders(1).setPosition(row, col, 0, 0).setOption('title', title).setOption('width', 600).setOption('height', 300);
    Object.keys(options || {}).forEach(function (k) { b = b.setOption(k, options[k]); });
    sheet.insertChart(b.build());
  };
  const dash = "'" + TAB.DASHBOARD + "'!";
  addChart(Charts.ChartType.COLUMN, [dash + 'T2:V14'], 'Monthly cash flow (last 12 months)', 72, 2);
  addChart(Charts.ChartType.LINE, [dash + 'T2:T14', dash + 'X2:X14'], 'Savings rate (share of income kept)', 72, 9,
    { 'legend.position': 'none', 'vAxis.format': 'percent' });
  addChart(Charts.ChartType.PIE, [dash + 'Y2:Z60'], 'Expenses by category (this month)', 88, 2);
  addChart(Charts.ChartType.BAR, [dash + 'B20:B45', dash + 'C20:D45'], 'Budget vs spent (this month)', 88, 9);
  addChart(Charts.ChartType.PIE, [dash + 'AB2:AC30'], 'Balance by wallet group', 104, 2);
  addChart(Charts.ChartType.PIE, [dash + 'AE2:AF30'], 'Investments by category', 104, 9);
  addChart(Charts.ChartType.LINE, [r(R, 'Month', true), r(R, 'Portfolio Value', true)], 'Portfolio value trend', 120, 2);
  addChart(Charts.ChartType.COLUMN, [dash + 'AE2:AE30', dash + 'AG2:AG30'], 'Gain/loss per investment category', 120, 9);
  addChart(Charts.ChartType.LINE, [r(R, 'Month', true), r(R, 'Net Worth', true)], 'Net worth trend', 136, 2);

  sheet.setFrozenRows(0);
  sheet.protect().setDescription('Dashboard (formulas and charts)').setWarningOnly(true);
}

/**
 * Category_History for months closed before it existed: each closed month's expense / income per category,
 * read from its archive sheet (the Archive Link in Monthly Report). Months it already has are skipped.
 */
function backfillCategoryHistory_(ss) {
  const sheet = ss.getSheetByName(TAB.CATEGORY_HISTORY);
  if (sheet === null) return 'Category_History: tab not found';
  const have = {};
  readTableByHeaders_(sheet, 'Month Key').forEach(function (row) { have[Number(row['month key'])] = true; });
  const reportRows = loadReportRows_(ss);
  const done = [], failed = [];
  Object.keys(reportRows).map(Number).sort().forEach(function (key) {
    const row = reportRows[key];
    if (have[key] || String(row['status']).trim().toLowerCase() !== 'closed') return;
    const ym = monthOfKey_(key);
    try {
      const archive = SpreadsheetApp.openById(archiveIdOf_(row));
      const rows = categoryTotals_(loadTransactions_(archive), new Date(ym.year, ym.month, 1), new Date(ym.year, ym.month + 1, 1));
      appendRows_(sheet, 'Month Key', rows.map(function (c) {
        return { 'Month Key': key, 'Month': monthLabel_(ym.year, ym.month, false), 'Category': c.category, 'Type': c.type, 'Amount': c.amount };
      }));
      done.push(key);
    } catch (err) {
      logError_('backfillCategoryHistory_', err, String(key));
      failed.push(key);
    }
  });
  return 'Category_History: ' + (done.length ? 'filled ' + done.join(', ') : 'up to date') +
    (failed.length ? '; archive not readable for ' + failed.join(', ') + ' (see Logs)' : '');
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
  headerCacheOff_ = true; // this function changes or checks headers: always read them fresh
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

// ---------------------------------------------------------------------------
// Sheet management from Telegram (SPEC Section 12): /setsheet, /setarchive,
// /settemplate, /template. The IDs live in Script Properties.
// ---------------------------------------------------------------------------

/** A spreadsheet or Drive file ID from a link (…/d/ID/…) or the bare ID. */
function sheetIdFromText_(text) {
  const t = String(text || '').trim();
  return (t.match(/\/d\/([\w-]{20,})/) || [])[1] || (/^[\w-]{25,}$/.test(t) ? t : '');
}

/** /setsheet <url>: always asks the password first. */
function setSheetCommand_(chatId, args) {
  const id = sheetIdFromText_(args);
  if (!id) {
    const ss = openMainSheet_();
    return sendMessage(chatId, 'Send the sheet link: <code>/setsheet https://docs.google.com/spreadsheets/d/…</code>' +
      (ss ? '\nNow using: <a href="' + escapeHtml_(ss.getUrl()) + '">' + escapeHtml_(ss.getName()) + '</a>' : ''));
  }
  askPassword_(chatId, 'setsheet', { sheetId: id }, '🔒 Enter the password to change the main sheet.');
}

/** After the password: check the sheet and show what was found. */
function checkNewSheet_(chatId, sheetId, p) {
  const result = validateSheet(sheetId);
  if (result.error) {
    const text = "⚠️ I can't open that sheet. Check the link, and that your Google account (the bot's owner) can edit it.";
    return p ? finishStep_(p, text) : sendMessage(chatId, text);
  }
  const ss = SpreadsheetApp.openById(sheetId);
  let userOk = false;
  const settings = ss.getSheetByName(TAB.SETTINGS);
  if (settings !== null) {
    try {
      userOk = readTableByHeaders_(settings, 'Chat ID').some(function (r) { return String(r['chat id']).trim() === String(chatId); });
    } catch (err) { userOk = false; }
  }
  const L = ['📄 <b>' + escapeHtml_(result.name) + '</b>'];
  if (result.ok) L.push('✅ All tabs and columns the bot needs are there.');
  else {
    if (result.missingTabs.length) L.push('Missing tabs: ' + escapeHtml_(result.missingTabs.join(', ')));
    Object.keys(result.missingColumns).forEach(function (t) {
      L.push('Missing in ' + escapeHtml_(t) + ': ' + escapeHtml_(result.missingColumns[t].join(', ')));
    });
  }
  if (!userOk) L.push("⚠️ Your chat ID isn't in this sheet's Settings → Users table, so after switching the bot would stop " +
    'answering you. Add both of you there first.');
  if (!p) p = newPending_(chatId, 'sheet', { id: sheetId });
  const rows = [];
  if (!result.ok) rows.push([btn_(p, "🛠 Add what's missing", 'fix')]);
  if (result.ok && userOk) rows.push([btn_(p, '✅ Switch to this sheet', 'sw')]);
  rows.push(cancelRow_(p));
  showStep_(p, L.join('\n'), rows);
}

function sheetCallback_(p, action) {
  const id = p.d.id;
  if (action === 'n') return finishStep_(p, '❌ Cancelled. The bot keeps using the same sheet.');
  if (action === 'fix') {
    headerCacheOff_ = true;
    const ss = SpreadsheetApp.openById(id);
    upgradeMissingTabs_(ss);
    getSchema_().forEach(function (t) { if (t.columns.length && ss.getSheetByName(t.name) !== null) upgradeMissingColumns_(ss, t.name); });
    return checkNewSheet_(p.chatId, id, p);
  }
  if (action !== 'sw' || !claimPending_(p)) return;
  const ss = SpreadsheetApp.openById(id);
  PropertiesService.getScriptProperties().setProperty(PROP.MAIN_SHEET_ID, id);
  mainSheetCache_ = null;
  clearConfigCache();
  try { setSettingValue_(ss, 'Main Sheet ID', id); } catch (err) { /* info row only */ }
  finishStep_(p, '✅ The bot now uses <a href="' + escapeHtml_(ss.getUrl()) + '">' + escapeHtml_(ss.getName()) + '</a> for both of you.');
}

/** /setarchive <folder url> */
function setArchiveCommand_(chatId, args) {
  const id = (String(args).match(/folders\/([\w-]{10,})/) || [])[1] || sheetIdFromText_(args);
  if (!id) {
    const cur = getProp_(PROP.ARCHIVE_FOLDER_ID);
    return sendMessage(chatId, 'Send the folder link: <code>/setarchive https://drive.google.com/drive/folders/…</code>' +
      (cur ? '\nNow using: https://drive.google.com/drive/folders/' + escapeHtml_(cur) : '\nNow: not set (a MonetaBot/Archive folder is made at the first closing).'));
  }
  try {
    const folder = DriveApp.getFolderById(id);
    PropertiesService.getScriptProperties().setProperty(PROP.ARCHIVE_FOLDER_ID, id);
    try { setSettingValue_(openMainSheet_(), 'Archive Folder ID', id); } catch (err) { /* info row only */ }
    sendMessage(chatId, '✅ Closing archives now go to <b>' + escapeHtml_(folder.getName()) + '</b>.');
  } catch (err) {
    sendMessage(chatId, "⚠️ I can't open that folder. Make sure the link is a Drive folder that your Google account (the bot's owner) can edit.");
  }
}

/** /settemplate <url> */
function setTemplateCommand_(chatId, args) {
  const id = sheetIdFromText_(args);
  if (!id) return sendMessage(chatId, 'Send the template sheet link: <code>/settemplate https://docs.google.com/spreadsheets/d/…</code>');
  const result = validateSheet(id);
  if (result.error) return sendMessage(chatId, "⚠️ I can't open that sheet. Check the link and that the bot's owner can open it.");
  PropertiesService.getScriptProperties().setProperty(PROP.TEMPLATE_ID, id);
  sendMessage(chatId, '✅ Template set to <b>' + escapeHtml_(result.name) + '</b>.' +
    (result.ok ? '' : '\n⚠️ It is missing some tabs or columns (' + escapeHtml_(result.missingTabs.concat(Object.keys(result.missingColumns)).join(', ')) +
      '). Copies of it will need upgradeSheets / "Add what\'s missing" in /setsheet.'));
}

/** /template: the link of the template sheet in use. */
function templateCommand_(chatId) {
  const id = getProp_(PROP.TEMPLATE_ID);
  if (!id) return sendMessage(chatId, 'No template is set. Set one with <code>/settemplate &lt;sheet link&gt;</code>.');
  try {
    const file = DriveApp.getFileById(id);
    sendMessage(chatId, '📄 Template: <a href="' + escapeHtml_(file.getUrl()) + '">' + escapeHtml_(file.getName()) + '</a>');
  } catch (err) {
    sendMessage(chatId, "⚠️ I can't open the template sheet any more. Set it again with /settemplate.");
  }
}

/** /links: the main sheet and the Drive folders the bot uses now (archive, receipts) and the template. */
function linksCommand_(chatId) {
  const line = function (label, getter, missing) {
    try {
      const x = getter();
      return x ? '• ' + label + ': <a href="' + escapeHtml_(x.getUrl()) + '">' + escapeHtml_(x.getName()) + '</a>' : '• ' + label + ': ' + missing;
    } catch (err) {
      return '• ' + label + ": ⚠️ can't be opened (check the link with the matching /set command)";
    }
  };
  const byProp = function (prop, kind) {
    return function () { const id = getProp_(prop); return id ? (kind === 'folder' ? DriveApp.getFolderById(id) : DriveApp.getFileById(id)) : null; };
  };
  sendMessage(chatId, ['🔗 <b>Links in use</b>',
    line('📄 Main sheet', openMainSheet_, 'not set'),
    line('📁 Archive folder', byProp(PROP.ARCHIVE_FOLDER_ID, 'folder'), 'not set yet (made at the first /closing)'),
    line('🧾 Receipts folder', byProp(PROP.RECEIPTS_FOLDER_ID, 'folder'), 'not set yet (made with the first bill photo)'),
    line('📋 Template', byProp(PROP.TEMPLATE_ID, 'file'), 'not set'),
    '', 'Change them with /setsheet, /setarchive, /setreceipts, /settemplate.'].join('\n'));
}
