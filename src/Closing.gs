/**
 * Closing.gs — monthly closing (SPEC Section 11), /closing [month] [year].
 *
 * Owner's decisions (Phase 8): months close oldest first, from their last
 * day on; the password is asked before closing; fully paid / converted
 * hutang-piutang and fully sold purchases leave the main sheet and are
 * listed in Closed_History; old prices only warn; each held asset keeps
 * its latest price (one Price_History row) so values don't fall back to
 * the buy price. No /reopen.
 *
 * Flow: /closing → checks + summary → [🔒 Close] → password → the job is
 * queued for the 1-minute cleanup trigger (it takes longer than Telegram's
 * 60s webhook) → runClosingJob_:
 *   1. snapshot the main sheet and work out the plan (closingPlan_, pure)
 *   2. copy the whole spreadsheet into the Archive folder and check the copy
 *      (Transactions count and total) — a failure stops here, nothing changed
 *   3. write the main sheet (one lock): opening balances = month-end
 *      balances, Carried Paid on open debts, remove the closed month's rows,
 *      finished debts / sold purchases, old prices; Monthly Report row
 *      (Closed + link), Budget_History, Closed_History; check the row count
 *   4. trim the archive to that month, add its Report tab, send the report
 * Until step 3 finishes the archive is a full copy of the sheet from just
 * before closing, so it is also the backup if anything goes wrong.
 */

const ARCHIVE_REPORT_TAB = 'Report';
const CLOSING_STALE_MS = 10 * 60000; // a job still "running" after this is reported as stopped

// ---------------------------------------------------------------------------
// The plan (pure; tested by testClosing)
// ---------------------------------------------------------------------------

/**
 * What closing this month changes. snap = { trx (Transactions rows with
 * _row), walletRows (raw Wallets rows), debts (loadDebts_), investments
 * (loadInvestments_), sales (loadSales_), prices (raw Price_History rows),
 * categories }. Returns { errors, end, removeTrx, keepCount, removedCount,
 * removedSum, openings [{ row, name, value }], debtChanges { row: {...} },
 * removeDebts, removeInv, removeSales, removePrices, closedItems,
 * budgetRows }.
 */
function closingPlan_(snap, year, month) {
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 1);
  const str = function (v) { return String(v === undefined || v === null ? '' : v).trim(); };
  const amt = function (r) { return Number(r['amount']) || 0; };
  const errors = [];

  const undated = snap.trx.filter(function (r) { return !(r['date'] instanceof Date); });
  if (undated.length) {
    errors.push('These Transactions rows have no valid Date: ' + undated.slice(0, 10).map(function (r) {
      return str(r['trx id']) || 'row ' + r._row;
    }).join(', ') + (undated.length > 10 ? ' …' : '') + '. Fix them in the sheet first.');
  }
  const removed = snap.trx.filter(function (r) { return r['date'] instanceof Date && r['date'] < end; });
  const kept = snap.trx.filter(function (r) { return removed.indexOf(r) === -1; });

  // Wallets: Opening Balance + the removed rows = the balance at the end of the month
  const openings = snap.walletRows.filter(function (w) { return !walletKind_(w['wallet type']); }).map(function (w) {
    const name = str(w['wallet']);
    const value = (Number(w['opening balance']) || 0) + removed.reduce(function (s, r) { return s + walletEffect_(r, name); }, 0);
    return { row: w._row, name: name, value: value, old: Number(w['opening balance']) || 0 };
  }).filter(function (o) { return o.value !== o.old; });

  // Debts
  const refs = function (rows, id) {
    return rows.filter(function (r) { const d = str(r['debt id']); return d === id || d.indexOf(id + '-') === 0; });
  };
  const kids = {};
  snap.debts.forEach(function (d) { if (d.parent) (kids[d.parent] = kids[d.parent] || []).push(d); });
  const done = function (d) { return (d.status === 'Paid' || d.status === 'Converted') && refs(kept, d.id).length === 0; };
  const goes = {};
  snap.debts.forEach(function (d) {
    if (!d.parent && done(d) && (kids[d.id] || []).every(done)) {
      goes[d.id] = true;
      (kids[d.id] || []).forEach(function (k) { goes[k.id] = true; });
    }
  });
  const debtChanges = {};
  snap.debts.forEach(function (d) {
    if (goes[d.id]) return;
    // Paid + converted − added in the rows that leave (the same rules as the Paid / Converted / Added formulas).
    const delta = refs(removed, d.id).reduce(function (s, r) {
      const type = str(r['type']);
      if (type === 'Settlement') return s + amt(r);
      if (type === 'Addition') return s - amt(r);
      if (str(r['direction']) === 'None' && type !== 'Hutang') return s + amt(r);
      return s;
    }, 0);
    if (delta !== 0) debtChanges[d.row] = { 'Carried Paid': (d.carried || 0) + delta };
  });
  const closedItems = snap.debts.filter(function (d) { return goes[d.id]; }).map(function (d) {
    return { kind: d.type, id: d.id, name: d.name, amount: d.original + d.added, result: d.status, gain: null };
  });

  // Investments: a purchase that is fully sold, with all its sales in this month or before, leaves
  const keptLinks = {};
  kept.forEach(function (r) { if (str(r['link id'])) keptLinks[str(r['link id'])] = true; });
  const salesOf = function (x) { return snap.sales.filter(function (s) { return s.invId === x.id; }); };
  const soldOut = snap.investments.filter(function (x) {
    const sales = salesOf(x);
    return x.id && x.qty <= 1e-9 && sales.length > 0 && sales.every(function (s) { return s.date && s.date < end && !keptLinks[s.link]; }) &&
      !keptLinks[x.link];
  });
  soldOut.forEach(function (x) {
    const sales = salesOf(x);
    const m = lotMult_(x.unit);
    closedItems.push({ kind: 'Investment', id: x.id, name: x.asset + ' (' + x.category + ')',
      amount: sales.reduce(function (s, y) { return s + y.qty * m * y.price; }, 0), result: 'Sold',
      gain: sales.reduce(function (s, y) { return s + y.qty * m * (y.price - x.price) - y.fee; }, 0) });
  });
  const goneInv = {};
  soldOut.forEach(function (x) { goneInv[x.id] = true; });
  const removeSales = snap.sales.filter(function (s) { return goneInv[s.invId]; }).map(function (s) { return s.row; });

  // Prices: rows up to the month end leave, except the latest one of each purchase still held (owner: option b)
  const latest = {};
  snap.prices.forEach(function (p) {
    const id = str(p['inv id']);
    if (!latest[id] || (p['date'] instanceof Date && latest[id]['date'] instanceof Date && p['date'] >= latest[id]['date']) ||
        !(latest[id]['date'] instanceof Date)) latest[id] = p;
  });
  const removePrices = snap.prices.filter(function (p) {
    const id = str(p['inv id']);
    if (goneInv[id]) return true;
    return p['date'] instanceof Date && p['date'] < end && latest[id] !== p;
  }).map(function (p) { return p._row; });

  // Budgets of this month (Budget_History)
  const budgetRows = (snap.categories || []).filter(function (c) { return c.type === 'Expense' && c.budget > 0; }).map(function (c) {
    const spent = spentInMonth_(removed, c.name, year, month);
    return { category: c.name, budget: c.budget, spent: spent, remaining: c.budget - spent,
      status: spent > c.budget ? 'Over' : spent === c.budget ? 'At' : 'Under' };
  });

  return {
    errors: errors, start: start, end: end,
    removeTrx: removed.map(function (r) { return r._row; }), keepCount: kept.length,
    removedCount: removed.length, removedSum: removed.reduce(function (s, r) { return s + amt(r); }, 0),
    openings: openings, debtChanges: debtChanges,
    removeDebts: snap.debts.filter(function (d) { return goes[d.id]; }).map(function (d) { return d.row; }),
    removeInv: soldOut.map(function (x) { return x.row; }), removeSales: removeSales, removePrices: removePrices,
    closedItems: closedItems, budgetRows: budgetRows
  };
}

/**
 * The archive copy keeps only data up to the month end: later Transactions,
 * purchases, sales, prices and debts leave; a purchase gets back the
 * quantity of a later sale, so it shows what was held at the month end.
 */
function archiveTrimPlan_(snap, end) {
  const before = function (d) { return d instanceof Date && d < end; };
  const laterSales = snap.sales.filter(function (s) { return !(s.date && s.date < end); });
  const invChanges = {};
  snap.investments.forEach(function (x) {
    const back = laterSales.filter(function (s) { return s.invId === x.id; }).reduce(function (t, s) { return t + s.qty; }, 0);
    if (back > 0 && before(x.date)) invChanges[x.row] = { 'Quantity': roundInv_(x.qty + back), 'Status': 'Holding' };
  });
  return {
    removeTrx: snap.trx.filter(function (r) { return !before(r['date']); }).map(function (r) { return r._row; }),
    removeInv: snap.investments.filter(function (x) { return x.date && !before(x.date); }).map(function (x) { return x.row; }),
    invChanges: invChanges,
    removeSales: laterSales.map(function (s) { return s.row; }),
    removePrices: snap.prices.filter(function (p) { return p['date'] instanceof Date && !before(p['date']); }).map(function (p) { return p._row; }),
    removeDebts: snap.debts.filter(function (d) { return d.start && !before(d.start); }).map(function (d) { return d.row; })
  };
}

// ---------------------------------------------------------------------------
// Sheet writing
// ---------------------------------------------------------------------------

/** Everything closingPlan_ reads, from one spreadsheet. */
function closingSnapshot_(ss) {
  const prices = ss.getSheetByName(TAB.PRICES);
  return {
    trx: loadTransactions_(ss),
    walletRows: readTableByHeaders_(ss.getSheetByName(TAB.WALLETS), 'Wallet'),
    debts: loadDebts_(ss), investments: loadInvestments_(ss), sales: loadSales_(ss),
    prices: prices === null ? [] : readTableByHeaders_(prices, 'Inv ID'),
    categories: loadCategories_(ss)
  };
}

/**
 * Rewrites a tab without the rows in `removeRows` (1-based sheet rows) and
 * with `changes` ({ row: { header: value } }) applied: the kept rows move up
 * and the freed rows at the bottom are emptied. Only typed columns are
 * written (formula columns fill themselves); Image Link keeps its link.
 * One read and a few writes, so it is fast. Returns the number of rows kept.
 */
function rewriteTableRows_(sheet, removeRows, changes) {
  if (sheet === null) return 0;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2 || (removeRows.length === 0 && Object.keys(changes || {}).length === 0)) return Math.max(0, lastRow - 1);
  const info = getHeaderInfo_(sheet);
  const map = getHeaderMap_(sheet);
  const n = lastRow - 1;
  const values = sheet.getRange(2, 1, n, info.lastCol).getValues();
  Object.keys(changes || {}).forEach(function (row) {
    Object.keys(changes[row]).forEach(function (h) {
      const c = map[h.toLowerCase()];
      if (c !== undefined && Number(row) >= 2 && Number(row) <= lastRow) values[Number(row) - 2][c] = changes[row][h];
    });
  });
  const gone = {};
  removeRows.forEach(function (r) { gone[r] = true; });
  const keep = values.map(function (v, i) { return i; }).filter(function (i) { return !gone[i + 2]; });
  const blank = function (len) { const a = []; for (let k = 0; k < len; k++) a.push(''); return a; };
  let i = 0;
  while (i < info.lastCol) {
    if (info.formulas[i] !== '') { i++; continue; }
    let j = i;
    while (j + 1 < info.lastCol && info.formulas[j + 1] === '') j++;
    const out = keep.map(function (k) { return values[k].slice(i, j + 1); });
    while (out.length < n) out.push(blank(j - i + 1));
    sheet.getRange(2, i + 1, n, j - i + 1).setValues(out);
    i = j + 1;
  }
  return keep.length;
}

/**
 * The Image Link column holds rich-text links ("View receipt"), which
 * setValues would turn into plain text. Read them first, then put them back
 * on the moved rows after rewriteTableRows_.
 */
function readImageLinks_(sheet) {
  const col = getHeaderMap_(sheet)['image link'];
  if (col === undefined || sheet.getLastRow() < 2) return null;
  return sheet.getRange(2, col + 1, sheet.getLastRow() - 1, 1).getRichTextValues().map(function (r) { return r[0]; });
}

function restoreImageLinks_(sheet, links, removeRows) {
  if (!links) return;
  const col = getHeaderMap_(sheet)['image link'];
  const gone = {};
  removeRows.forEach(function (r) { gone[r] = true; });
  const kept = links.filter(function (l, i) { return !gone[i + 2]; });
  const empty = SpreadsheetApp.newRichTextValue().setText('').build();
  while (kept.length < links.length) kept.push(empty);
  sheet.getRange(2, col + 1, links.length, 1).setRichTextValues(kept.map(function (v) { return [v]; }));
}

/** Rewrites Transactions (keeping receipt links). */
function rewriteTransactions_(ss, removeRows) {
  const sheet = ss.getSheetByName(TAB.TRANSACTIONS);
  const links = removeRows.length ? readImageLinks_(sheet) : null;
  const kept = rewriteTableRows_(sheet, removeRows, {});
  restoreImageLinks_(sheet, links, removeRows);
  return kept;
}

/** Transactions rows (with an Amount) and their total. */
function trxCountAndSum_(ss) {
  const rows = loadTransactions_(ss);
  return { count: rows.length, sum: rows.reduce(function (s, r) { return s + (Number(r['amount']) || 0); }, 0) };
}

/** Appends objects to a tab after its last row with a value in keyHeader. */
function appendRows_(sheet, keyHeader, objects) {
  if (sheet === null || objects.length === 0) return;
  writeRowsByHeaders_(sheet, lastDataRow_(sheet, keyHeader) + 1, objects);
}

/** Writes (or replaces) the Monthly Report row of this month. */
function upsertReportRow_(ss, values) {
  const sheet = ss.getSheetByName(TAB.REPORT);
  if (sheet === null) return;
  const row = readTableByHeaders_(sheet, 'Month Key').filter(function (r) { return Number(r['month key']) === values['Month Key']; })[0];
  if (row) writeRowsByHeaders_(sheet, row._row, [values]);
  else appendRows_(sheet, 'Month Key', [values]);
}

/** The Archive folder (ARCHIVE_FOLDER_ID; MonetaBot/Archive is created when it isn't set). */
function archiveFolder_() {
  const id = getProp_(PROP.ARCHIVE_FOLDER_ID);
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) { logError_('archiveFolder_', err, id); }
  }
  const parents = DriveApp.getRootFolder().getFoldersByName('MonetaBot');
  const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const found = parent.getFoldersByName('Archive');
  const folder = found.hasNext() ? found.next() : parent.createFolder('Archive');
  PropertiesService.getScriptProperties().setProperty(PROP.ARCHIVE_FOLDER_ID, folder.getId());
  return folder;
}

/** The year subfolder inside the Archive folder ("2026"), created when missing. */
function archiveYearFolder_(year) {
  const root = archiveFolder_();
  const found = root.getFoldersByName(String(year));
  return found.hasNext() ? found.next() : root.createFolder(String(year));
}

/** Archive file name (owner's format): "September 2025 MonetaBot". */
function archiveFileName_(year, month) {
  return monthLabel_(year, month, true) + ' MonetaBot';
}

// ---------------------------------------------------------------------------
// /closing: checks, summary, confirmation
// ---------------------------------------------------------------------------

/** '', or what upgradeSheets must add first (closing writes Carried Paid and Closed_History). */
function closingSchemaMissing_(ss) {
  const missing = [];
  [TAB.CLOSED_HISTORY, TAB.BUDGET_HISTORY, TAB.REPORT].forEach(function (t) { if (ss.getSheetByName(t) === null) missing.push('tab ' + t); });
  const debts = ss.getSheetByName(TAB.DEBTS);
  if (debts !== null && getHeaderMap_(debts)['carried paid'] === undefined) missing.push('column Hutang_Piutang → Carried Paid');
  return missing.length ? 'The sheet needs an update first (' + missing.join(', ') + '): run upgradeSheets in the Apps Script editor, then /closing again.' : '';
}

/** The month /closing works on: the one asked for, or the oldest month with rows (else this month). */
function closingMonth_(args, trx, now) {
  if (String(args || '').trim()) return parseMonthArg_(args, now);
  const dates = trx.map(function (r) { return r['date']; }).filter(function (d) { return d instanceof Date; });
  if (dates.length === 0) return { year: now.getFullYear(), month: now.getMonth(), given: false };
  const first = new Date(Math.min.apply(null, dates.map(function (d) { return d.getTime(); })));
  return { year: first.getFullYear(), month: first.getMonth(), given: false };
}

/**
 * Why this month can't be closed yet (text), or '' when it can. Pure:
 * oldest first, only once it has ended or on its last day.
 */
function closingBlocker_(year, month, trx, reportRows, now) {
  const key = monthKey_(year, month);
  const label = monthLabel_(year, month, true);
  const row = reportRows[key];
  if (row && String(row['status']).trim().toLowerCase() === 'closed') return label + ' is already closed.';
  const nowKey = monthKey_(now.getFullYear(), now.getMonth());
  if (key > nowKey) return label + " hasn't started yet.";
  if (key === nowKey && !isLastDayOfMonth_(now)) {
    return label + " isn't over yet. You can close it from " + formatDate_(new Date(year, month + 1, 0)) + '.';
  }
  const start = new Date(year, month, 1);
  const older = trx.filter(function (r) { return r['date'] instanceof Date && r['date'] < start; });
  if (older.length) {
    const first = new Date(Math.min.apply(null, older.map(function (r) { return r['date'].getTime(); })));
    return 'Close ' + monthLabel_(first.getFullYear(), first.getMonth(), true) + ' first (months are closed oldest first).';
  }
  return '';
}

function startClosing_(chatId, args) {
  const now = new Date();
  const ss = openMainSheet_();
  const job = readClosingJob_();
  if (job) return sendMessage(chatId, '⏳ A closing (' + escapeHtml_(monthLabel_(job.year, job.month, true)) + ') is already running.');
  sendTyping_(chatId);
  const schema = closingSchemaMissing_(ss);
  if (schema) return sendMessage(chatId, '⚠️ ' + escapeHtml_(schema));
  const snap = closingSnapshot_(ss);
  const ym = closingMonth_(args, snap.trx, now);
  if (!ym) return sendMessage(chatId, "I couldn't read the month. Example: <code>/closing oktober 2026</code>.");
  const reportRows = loadReportRows_(ss);
  const blocker = closingBlocker_(ym.year, ym.month, snap.trx, reportRows, now);
  if (blocker) return sendMessage(chatId, '🔒 ' + escapeHtml_(blocker));
  const plan = closingPlan_(snap, ym.year, ym.month);
  if (plan.errors.length) return sendMessage(chatId, '⚠️ ' + plan.errors.map(escapeHtml_).join('\n'));

  const src = collectReportSource_(ss);
  src.prev = previousTotals_(reportRows, src.trx, monthKey_(ym.year, ym.month));
  const r = buildReportData_(src, ym.year, ym.month, plan.end);
  const label = monthLabel_(ym.year, ym.month, true);
  const oldPrices = src.investments.filter(function (x) {
    const when = x.lastUpdate || x.date;
    return x.holding && (!when || when < plan.start);
  }).map(function (x) { return x.asset; }).filter(function (a, i, list) { return list.indexOf(a) === i; });

  // One titled section each, details as bullets (plain amounts: this is a preview).
  const L = ['🔒 <b>Closing ' + escapeHtml_(label) + '</b>'];
  const section = function (title, bullets) {
    if (bullets.length) L.push('', '<b>' + title + '</b>', bullets.map(function (b) { return '• ' + b; }).join('\n'));
  };
  section('📊 Summary', ['Income ' + formatRp_(r.income), 'Expense ' + formatRp_(r.expense), 'Net ' + formatRp_(r.net)]);
  section('👛 Wallets at month end', r.wallets.map(function (w) { return escapeHtml_(w.name) + ' ' + formatRp_(w.end); })
    .concat(r.wallets.length ? ['<b>Total ' + formatRp_(r.cash) + '</b>'] : []));
  section('🎯 Budget realization vs plan', r.budgets.map(function (b) {
    const pct = Math.round(b.spent / b.budget * 100);
    return escapeHtml_(b.name) + ': ' + formatRp_(b.spent) + ' of ' + formatRp_(b.budget) + ' (' + pct + '%)' +
      (b.spent > b.budget ? ' ⚠️ over by ' + formatRp_(b.spent - b.budget) : '');
  }));
  section('📦 Moving out of the main sheet', [plan.removedCount + ' entries → the archive sheet']
    .concat(plan.closedItems.map(function (c) {
      return escapeHtml_(c.id) + ' ' + escapeHtml_(c.name) + ' (' + escapeHtml_(c.result) + ') → Closed_History';
    })));
  section('➡️ Carried over', ['Wallet balances (as opening balances)',
    r.piutang.open + ' open piutang ' + formatRp_(r.piutang.remaining) + ' · ' + r.hutang.open + ' open hutang ' + formatRp_(r.hutang.remaining),
    'Investments, favorites, categories and budgets, contacts, settings']);
  section('⭐ Favorites not logged this month', r.favorites.filter(function (f) { return f.status === 'not logged'; })
    .map(function (f) { return escapeHtml_(f.name); }));
  section('📈 No price this month (the last price is kept)', oldPrices.map(escapeHtml_));
  L.push('', '⚠️ <b>This is final</b> (there is no reopen). Entries dated in ' + escapeHtml_(label) + ' will be blocked afterwards.');

  const p = newPending_(chatId, 'close', { year: ym.year, month: ym.month });
  const rows = [[btn_(p, '🔒 Close ' + monthLabel_(ym.year, ym.month, false), 'y'), btn_(p, '❌ Cancel', 'n')]];
  if (oldPrices.length) rows.unshift([btn_(p, '📈 Update prices first', 'px')]);
  showStep_(p, L.join('\n'), rows);
}

function closingCallback_(p, action) {
  const d = p.d;
  if (action === 'n') return finishStep_(p, '❌ Cancelled. Nothing was closed.');
  if (action === 'px') {
    return finishStep_(p, '📈 OK. Send <code>/inv update</code> (it lists your assets and last prices), then <code>/closing</code> again.');
  }
  if (action !== 'y' || !claimPending_(p)) return;
  dropButtons_(p.chatId, p.msgId);
  askPassword_(p.chatId, 'closing', { year: d.year, month: d.month },
    '🔒 Enter the password to close <b>' + escapeHtml_(monthLabel_(d.year, d.month, true)) + '</b>.');
}

/** After the password: queue the job (the cleanup trigger runs it; without the trigger it runs now). */
function queueClosing_(chatId, year, month) {
  const user = getUserByChatId_(chatId);
  const msg = sendMessage(chatId, '⏳ Closing <b>' + escapeHtml_(monthLabel_(year, month, true)) + '</b>… this takes 1–2 minutes. ' +
    "I'll send the report when it's done. Please don't log anything until then.");
  const job = { chatId: String(chatId), msgId: msg.message_id, year: year, month: month, by: user && user.name ? user.name : String(chatId),
    at: Date.now(), state: 'queued' };
  const ok = withScriptLock_(function () {
    if (readClosingJob_()) return false;
    writeClosingJob_(job);
    return true;
  });
  if (!ok) return editMessage(chatId, msg.message_id, '⏳ Another closing is already running.');
  recordEvent_('closing ' + job.year + '-' + (job.month + 1) + ' queued by ' + job.by);
  if (!cleanupTriggerInstalled_()) processClosingJob_();
}

function readClosingJob_() {
  try { return JSON.parse(getProp_(PROP.CLOSING_JOB) || 'null'); } catch (err) { return null; }
}

function writeClosingJob_(job) {
  const props = PropertiesService.getScriptProperties();
  if (job) props.setProperty(PROP.CLOSING_JOB, JSON.stringify(job));
  else props.deleteProperty(PROP.CLOSING_JOB);
  CacheService.getScriptCache().put('closing_job', job ? 'x' : '[]', 21600);
}

/** Called by the 1-minute cleanup trigger: runs a queued closing. Exits at once when there is none. */
function processClosingJob_() {
  if (CacheService.getScriptCache().get('closing_job') === '[]') return;
  let job = null;
  withScriptLock_(function () {
    job = readClosingJob_();
    if (!job) { writeClosingJob_(null); return; }
    if (job.state === 'running') {
      if (Date.now() - job.startedAt > CLOSING_STALE_MS) {
        try {
          editMessage(job.chatId, job.msgId, '⚠️ The closing of ' + escapeHtml_(monthLabel_(job.year, job.month, true)) +
            ' stopped before it finished. Check the Logs tab; ' + (job.archiveUrl ? 'the archive <a href="' + escapeHtml_(job.archiveUrl) +
            '">copy</a> was taken just before.' : 'nothing was changed before the archive copy.'));
        } catch (err) { /* message gone */ }
        logError_('processClosingJob_', new Error('closing job did not finish'), JSON.stringify(job));
        writeClosingJob_(null);
      }
      job = null;
      return;
    }
    job.state = 'running';
    job.startedAt = Date.now();
    writeClosingJob_(job);
  });
  if (!job) return;
  try {
    runClosingJob_(job);
  } finally {
    writeClosingJob_(null);
  }
}

// ---------------------------------------------------------------------------
// The closing itself
// ---------------------------------------------------------------------------

function runClosingJob_(job) {
  headerCacheOff_ = true; // two spreadsheets with the same tab names are read here
  const label = monthLabel_(job.year, job.month, true);
  const key = monthKey_(job.year, job.month);
  const progress = function (text) {
    recordEvent_('closing ' + key + ': ' + text);
    try { editMessage(job.chatId, job.msgId, '⏳ Closing <b>' + escapeHtml_(label) + '</b>… ' + text); } catch (err) { /* ignore */ }
  };
  const fail = function (text, err) {
    logError_('runClosingJob_', err, key);
    editMessage(job.chatId, job.msgId, '⚠️ ' + text + '\n<i>' + escapeHtml_(err.message) + '</i>');
  };
  const ss = openMainSheet_();
  const now = new Date();
  const blocker = closingSchemaMissing_(ss) || closingBlocker_(job.year, job.month, loadTransactions_(ss), loadReportRows_(ss), now);
  if (blocker) return editMessage(job.chatId, job.msgId, '🔒 ' + escapeHtml_(blocker));
  progress('making the archive copy and updating the main sheet');
  const folder = archiveYearFolder_(job.year);
  const name = archiveFileName_(job.year, job.month);
  const closedAt = new Date();
  let plan, archive;
  let changing = false; // true once the main sheet is being written

  // 1–3 in ONE lock, so nobody can log something between the plan, the copy and the writes.
  // (No recordEvent_ / progress in here: they take the lock themselves.)
  try {
    withScriptLock_(function () {
      const before = trxCountAndSum_(ss);
      plan = closingPlan_(closingSnapshot_(ss), job.year, job.month);
      if (plan.errors.length) throw new Error(plan.errors.join(' '));
      archive = SpreadsheetApp.openById(DriveApp.getFileById(ss.getId()).makeCopy(name, folder).getId());
      const copy = trxCountAndSum_(archive);
      if (copy.count !== before.count || Math.abs(copy.sum - before.sum) > 0.5) {
        throw new Error('archive check failed: ' + copy.count + ' rows / ' + copy.sum + ' in the copy vs ' + before.count + ' / ' + before.sum);
      }
      changing = true;
      const wallets = ss.getSheetByName(TAB.WALLETS);
      plan.openings.forEach(function (o) { writeRowsByHeaders_(wallets, o.row, [{ 'Opening Balance': o.value }]); });
      rewriteTableRows_(ss.getSheetByName(TAB.DEBTS), plan.removeDebts, plan.debtChanges);
      rewriteTableRows_(ss.getSheetByName(TAB.SALES), plan.removeSales, {});
      rewriteTableRows_(ss.getSheetByName(TAB.INVESTMENTS), plan.removeInv, {});
      rewriteTableRows_(ss.getSheetByName(TAB.PRICES), plan.removePrices, {});
      const kept = rewriteTransactions_(ss, plan.removeTrx);
      const src = collectReportSource_(archive); // the full copy from just before: the month's numbers
      src.prev = previousTotals_(loadReportRows_(ss), src.trx, key);
      src.closedItems = plan.closedItems;
      const r = buildReportData_(src, job.year, job.month, plan.end);
      upsertReportRow_(ss, reportRowValues_(r, 'Closed', closedAt, archive.getUrl(), 'Closed by ' + job.by));
      appendRows_(ss.getSheetByName(TAB.BUDGET_HISTORY), 'Month Key', plan.budgetRows.map(function (b) {
        return { 'Month Key': key, 'Month': monthLabel_(job.year, job.month, false), 'Category': b.category, 'Budget': b.budget,
          'Spent': b.spent, 'Remaining': b.remaining, 'Status': b.status };
      }));
      appendRows_(ss.getSheetByName(TAB.CLOSED_HISTORY), 'Month Key', plan.closedItems.map(function (c) {
        return { 'Month Key': key, 'Month': monthLabel_(job.year, job.month, false), 'Kind': c.kind, 'ID': c.id, 'Name': c.name,
          'Amount': c.amount, 'Result': c.result, 'Gain/Loss': c.gain === null ? '' : c.gain, 'Closed At': closedAt,
          'Archive Link': archive.getUrl() };
      }));
      SpreadsheetApp.flush();
      if (kept !== plan.keepCount || trxCountAndSum_(ss).count !== plan.keepCount) {
        throw new Error('after closing the main sheet has ' + trxCountAndSum_(ss).count + ' rows, expected ' + plan.keepCount);
      }
    });
  } catch (err) {
    if (!changing) {
      // A copy that failed its check would only confuse later: move it to the Drive trash.
      if (archive) { try { DriveApp.getFileById(archive.getId()).setTrashed(true); } catch (e) { logError_('runClosingJob_ (trash copy)', e); } }
      return fail('Closing stopped before changing anything in the main sheet.', err);
    }
    return fail('Closing stopped while updating the main sheet. The archive <a href="' + escapeHtml_(archive.getUrl()) +
      '">copy</a> is the full sheet from just before closing: compare with it (or copy its tabs back) and tell me what you see.', err);
  }
  job.archiveUrl = archive.getUrl();
  writeClosingJob_(job);

  // 4. Trim the archive to this month, add its Report tab, send the report.
  progress('writing the report');
  let reportText = '';
  try {
    const trim = archiveTrimPlan_(closingSnapshot_(archive), plan.end);
    rewriteTransactions_(archive, trim.removeTrx);
    rewriteTableRows_(archive.getSheetByName(TAB.SALES), trim.removeSales, {});
    rewriteTableRows_(archive.getSheetByName(TAB.INVESTMENTS), trim.removeInv, trim.invChanges);
    rewriteTableRows_(archive.getSheetByName(TAB.PRICES), trim.removePrices, {});
    rewriteTableRows_(archive.getSheetByName(TAB.DEBTS), trim.removeDebts, {});
    SpreadsheetApp.flush();
    const reportRows = loadReportRows_(ss);
    const src = collectReportSource_(archive);
    src.prev = previousTotals_(reportRows, [], key);
    src.budgetRows = historyRowsOf_(ss, TAB.BUDGET_HISTORY, key);
    src.closedItems = plan.closedItems;
    const r = buildReportData_(src, job.year, job.month, plan.end);
    upsertReportRow_(ss, reportRowValues_(r, 'Closed', closedAt, archive.getUrl(), 'Closed by ' + job.by));
    upsertReportRow_(archive, reportRowValues_(r, 'Closed', closedAt, archive.getUrl(), 'Archive of ' + label));
    const tab = writeArchiveReportTab_(archive, r);
    reportText = formatReportText_(r, getSettingYes_(SETTING.HIDE_AMOUNTS), 'closed', archive.getUrl() + '#gid=' + tab.getSheetId());
  } catch (err) {
    logError_('runClosingJob_ (archive report)', err, key);
    reportText = '⚠️ The month is closed, but the archive report could not be finished (details in the Logs tab). ' +
      '<a href="' + escapeHtml_(archive.getUrl()) + '">Archive sheet</a>';
  }
  editMessage(job.chatId, job.msgId, '✅ <b>' + escapeHtml_(label) + ' is closed.</b> ' + plan.removedCount + ' entries are in the ' +
    '<a href="' + escapeHtml_(archive.getUrl()) + '">archive sheet</a>' +
    (plan.closedItems.length ? '; ' + plan.closedItems.length + ' finished items are in Closed_History' : '') +
    '. Opening balances now start from ' + escapeHtml_(formatDate_(new Date(job.year, job.month + 1, 0))) + '.' +
    '\n📁 <a href="' + escapeHtml_(folder.getUrl()) + '">Archive folder (' + job.year + ')</a>');
  // The report shows net worth details, so it disappears after 5 minutes (/report brings it back any time).
  uniqueChatIds_((getUsers_() || []).filter(function (u) { return u.active; })).forEach(function (chatId) {
    try { sendTimed_(chatId, reportText, NET_WORTH_DELETE_SECONDS); } catch (err) { logError_('runClosingJob_ (send report)', err, chatId); }
  });
  recordEvent_('closing ' + key + ': done');
}

/** The archive's Report tab (first tab), plain amounts. Returns the sheet. */
function writeArchiveReportTab_(archive, r) {
  let sheet = archive.getSheetByName(ARCHIVE_REPORT_TAB);
  if (sheet === null) sheet = archive.insertSheet(ARCHIVE_REPORT_TAB, 0);
  sheet.clear();
  const rows = reportSheetRows_(r);
  sheet.getRange(1, 1).setValue('MonetaBot report · ' + r.label).setFontSize(14).setFontWeight('bold');
  sheet.getRange(3, 1, rows.length, 4).setValues(rows);
  sheet.getRange(3, 1, 1, 4).setFontWeight('bold').setBackground(HEADER_BG);
  sheet.getRange(4, 3, rows.length, 1).setNumberFormat(FMT.RP);
  sheet.setColumnWidth(1, 190);
  sheet.setColumnWidth(2, 280);
  sheet.setColumnWidth(3, 140);
  sheet.setColumnWidth(4, 330);
  sheet.setFrozenRows(3);
  return sheet;
}

// ---------------------------------------------------------------------------
// Reminder (last day of the month, Closing Reminder Time)
// ---------------------------------------------------------------------------

/** The 1st of the month (Daily Reminder Time): a month that has ended but isn't closed yet → remind. */
function runClosingOverdueReminder_(now) {
  const ss = openMainSheet_();
  if (ss === null) return;
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const ym = closingMonth_('', loadTransactions_(ss).filter(function (r) { return r['date'] instanceof Date && r['date'] < start; }), now);
  if (monthKey_(ym.year, ym.month) >= monthKey_(now.getFullYear(), now.getMonth())) return; // nothing older than this month
  const text = '📅 <b>' + escapeHtml_(monthLabel_(ym.year, ym.month, true)) + "</b> isn't closed yet. When everything is logged, " +
    'close it with /closing (months are closed oldest first).';
  uniqueChatIds_((getUsers_() || []).filter(function (u) { return u.active; })).forEach(function (chatId) {
    try { sendMessage(chatId, text); } catch (err) { logError_('runClosingOverdueReminder_', err, chatId); }
  });
}

function runClosingReminder_(now) {
  const ss = openMainSheet_();
  if (ss === null) return;
  const row = loadReportRows_(ss)[monthKey_(now.getFullYear(), now.getMonth())];
  if (row && String(row['status']).trim().toLowerCase() === 'closed') return;
  const text = '📅 Today is the last day of <b>' + escapeHtml_(monthLabel_(now.getFullYear(), now.getMonth(), true)) + '</b>. ' +
    'When everything for this month is logged (and prices are updated), close it with /closing.';
  uniqueChatIds_((getUsers_() || []).filter(function (u) { return u.active; })).forEach(function (chatId) {
    try { sendMessage(chatId, text); } catch (err) { logError_('runClosingReminder_', err, chatId); }
  });
}
