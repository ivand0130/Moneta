/**
 * Transactions.gs — writing and deleting Transactions rows, duplicate
 * lookup, closed-month check, finding the entry for /undo.
 *
 * Direction drives the Current Balance formula in Wallets:
 *   Income → In, Expense → Out, Transfer → Transfer (Wallet → To Wallet).
 */

const DIRECTION_BY_TYPE = { Income: 'In', Expense: 'Out', Transfer: 'Transfer', Piutang: 'Out', Hutang: 'In' };
// Settlement / Addition get their direction from the debt (piutang or hutang); conversions use 'None'.
const CATEGORY_SOURCE_BY_HOW = { tag: 'Manual', chosen: 'Manual', keyword: 'Keyword', ai: 'AI' };

/**
 * Saves one Income / Expense / Transfer row (linkId joins the rows of a
 * linked group, e.g. transfer + fee). Must be called inside withScriptLock_
 * (the caller also re-checks the pending entry there). Returns the Trx ID.
 */
function writeTransaction_(ss, d, loggedBy, linkId) {
  const sheet = ss.getSheetByName(TAB.TRANSACTIONS);
  const id = nextId_(sheet, 'Trx ID', 'TRX');
  appendRowByHeaders_(ss, TAB.TRANSACTIONS, {
    'Trx ID': id,
    'Link ID': linkId || '',
    'Date': new Date(d.date),
    'Logged By': loggedBy,
    'Type': d.type,
    'Amount': d.amount,
    'Direction': d.direction || DIRECTION_BY_TYPE[d.type],
    'Category': d.category || '',
    'Category Source': d.category ? (CATEGORY_SOURCE_BY_HOW[d.categoryHow] || 'Manual') : '',
    'Wallet': d.wallet,
    'To Wallet': d.type === 'Transfer' ? d.toWallet : '',
    'Note': d.note,
    'Debt ID': d.debtId || '',
    'Favorite ID': d.favId || '',
    'Input Source': d.inputSource || 'Text'
  });
  return id;
}

/**
 * THE rule for "does this Transactions row count as an expense?" — used by
 * budgets now and by /report and the Dashboard later, so numbers agree.
 * Today: Type = Expense. (Conversion rows are decided in Phase 4 — change
 * it here, and in the Categories "Spent" formula in Template.gs.)
 */
function countsAsExpense_(row) {
  return String(row['type']).trim() === 'Expense';
}

/** All Transactions rows (objects with lowercase keys and _row). */
function loadTransactions_(ss) {
  return readTableByHeaders_(ss.getSheetByName(TAB.TRANSACTIONS), 'Amount');
}

/**
 * A row with the same type, amount and note whose Date is within `minutes`
 * of the draft's date, or null. (Past-dated entries keep the current clock
 * time, so this also catches "kemarin" entered twice.)
 */
function findDuplicate_(rows, d, minutes) {
  const note = normalizeForMatch_(d.note);
  const windowMs = minutes * 60000;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const date = r['date'] instanceof Date ? r['date'].getTime() : NaN;
    if (String(r['type']) === d.type && Number(r['amount']) === d.amount &&
        normalizeForMatch_(r['note']) === note && Math.abs(date - d.date) <= windowMs) {
      return r;
    }
  }
  return null;
}

/** True if the month of `date` is marked Closed in the Monthly Report tab. */
function isMonthClosed_(ss, date) {
  const d = new Date(date);
  const key = d.getFullYear() * 100 + d.getMonth() + 1;
  return readTableByHeaders_(ss.getSheetByName(TAB.REPORT), 'Month Key').some(function (r) {
    return Number(r['month key']) === key && String(r['status']).trim().toLowerCase() === 'closed';
  });
}

/**
 * The last entry logged by this user, plus every row sharing its Link ID.
 * Returns [] if there is none.
 */
function findLastEntryGroup_(rows, loggedBy) {
  let last = null;
  rows.forEach(function (r) {
    if (String(r['trx id']).trim() !== '' && String(r['logged by']).trim() === loggedBy) last = r;
  });
  if (last === null) return [];
  const link = String(last['link id'] || '').trim();
  if (link === '') return [last];
  return rows.filter(function (r) { return String(r['link id']).trim() === link; });
}

/**
 * Deletes the rows with these Trx IDs (found again by ID inside the lock,
 * since rows may have moved). Returns the IDs actually deleted.
 */
function deleteTransactions_(ss, trxIds) {
  return withScriptLock_(function () {
    const sheet = ss.getSheetByName(TAB.TRANSACTIONS);
    const rows = loadTransactions_(ss).filter(function (r) {
      return trxIds.indexOf(String(r['trx id']).trim()) !== -1;
    });
    rows.sort(function (a, b) { return b._row - a._row; }).forEach(function (r) { sheet.deleteRow(r._row); });
    return rows.map(function (r) { return String(r['trx id']).trim(); });
  });
}

/** One line describing a Transactions row, for /undo. */
function describeRow_(r) {
  const type = String(r['type']);
  const parts = [escapeHtml_(r['trx id']), type, formatRp_(r['amount'])];
  if (type === 'Transfer') parts.push(escapeHtml_(r['wallet']) + ' → ' + escapeHtml_(r['to wallet']));
  else parts.push(escapeHtml_(r['category']), escapeHtml_(r['wallet']));
  if (r['date'] instanceof Date) parts.push(formatDate_(r['date']));
  const note = String(r['note'] || '').trim();
  return parts.join(' | ') + (note ? ' | "' + escapeHtml_(note) + '"' : '');
}

/**
 * Saves an Adjustment row (SPEC Section 6): Type and Category "Adjustment",
 * Amount = |difference|, Direction In (balance goes up) or Out (down), so the
 * Current Balance formula moves by the difference. Never counts as income or
 * expense. Call inside withScriptLock_. Returns the Trx ID.
 */
function writeAdjustment_(ss, d, loggedBy) {
  const category = (loadCategories_(ss).filter(function (c) { return c.type === 'Adjustment'; })[0] || {}).name ||
    'Adjustment';
  const sheet = ss.getSheetByName(TAB.TRANSACTIONS);
  const id = nextId_(sheet, 'Trx ID', 'TRX');
  appendRowByHeaders_(ss, TAB.TRANSACTIONS, {
    'Trx ID': id,
    'Date': new Date(d.date),
    'Logged By': loggedBy,
    'Type': 'Adjustment',
    'Amount': Math.abs(d.diff),
    'Direction': d.diff > 0 ? 'In' : 'Out',
    'Category': category,
    'Category Source': 'Manual',
    'Wallet': d.wallet,
    'Note': (d.note ? d.note + ' · ' : '') + 'Balance adjustment: recorded ' + formatRp_(d.recorded) +
      ' → actual ' + formatRp_(d.actual),
    'Input Source': 'Text'
  });
  return id;
}
