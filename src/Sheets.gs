/**
 * Sheets.gs — open the main sheet by ID, read/write helpers, header lookup
 * by NAME (never by fixed column number), ID generators.
 *
 * Formula columns: some headers are themselves formulas like
 * ={"Current Balance"; ...} that fill the whole column. The writers below
 * never write into those columns, so the formulas keep working.
 */

let mainSheetCache_ = null; // Opened once per execution.

/** Opens the main sheet, or returns null if MAIN_SHEET_ID isn't set yet. */
function openMainSheet_() {
  if (mainSheetCache_ !== null) return mainSheetCache_;
  const id = getProp_(PROP.MAIN_SHEET_ID);
  if (id === null) return null;
  mainSheetCache_ = SpreadsheetApp.openById(id);
  return mainSheetCache_;
}

// Speed: each tab's header row is read once per execution (one message) and remembered here.
// The editor setup/upgrade functions add columns, so they switch this off (headerCacheOff_ = true).
let headerCache_ = {};
let headerCacheOff_ = false;

/** Header row of a tab: { lastCol, headers (trimmed, lowercase), formulas }. Cached per execution. */
function getHeaderInfo_(sheet) {
  const key = headerCacheOff_ ? null : sheet.getName();
  if (key !== null && headerCache_[key]) return headerCache_[key];
  const lastCol = sheet.getLastColumn();
  const info = { lastCol: lastCol, headers: [], formulas: [] };
  if (lastCol > 0) {
    const range = sheet.getRange(1, 1, 1, lastCol);
    info.headers = range.getValues()[0].map(function (h) { return String(h).trim().toLowerCase(); });
    info.formulas = range.getFormulas()[0];
  }
  if (key !== null) headerCache_[key] = info;
  return info;
}

/**
 * Maps header names (trimmed, lowercase) to 0-based column indexes,
 * using row 1 of the given tab. Blank headers are skipped.
 */
function getHeaderMap_(sheet) {
  const info = getHeaderInfo_(sheet);
  if (info.map) return info.map;
  const map = {};
  info.headers.forEach(function (name, i) {
    if (name !== '' && map[name] === undefined) map[name] = i;
  });
  if (!headerCacheOff_) info.map = map;
  return map;
}

/**
 * Reads a tab (or one table inside it, like Users in Settings) as objects
 * keyed by lowercase header name, plus _row (the 1-based sheet row).
 * Rows where keyHeader is blank are skipped.
 */
function readTableByHeaders_(sheet, keyHeader) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol === 0) return [];
  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
  const keyIdx = headers.indexOf(keyHeader.toLowerCase());
  if (keyIdx === -1) {
    throw new Error('Column "' + keyHeader + '" not found in tab ' + sheet.getName());
  }
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][keyIdx]).trim() === '') continue;
    const row = { _row: i + 1 };
    headers.forEach(function (h, j) {
      if (h !== '' && row[h] === undefined) row[h] = values[i][j];
    });
    rows.push(row);
  }
  return rows;
}

/**
 * Last row (1-based) that has a value. With keyHeader, only that column is
 * checked (used for one table inside a shared tab, like Settings). Without
 * it, every non-formula column is checked, so a row typed by hand without
 * an ID is never overwritten. Returns 1 when only the header exists.
 */
function lastDataRow_(sheet, keyHeader) {
  const lastRow = sheet.getLastRow();
  const lastCol = getHeaderInfo_(sheet).lastCol;
  if (lastRow < 2 || lastCol === 0) return 1;
  let cols;
  if (keyHeader) {
    const col = getHeaderMap_(sheet)[keyHeader.toLowerCase()];
    if (col === undefined) throw new Error('Column "' + keyHeader + '" not found in tab ' + sheet.getName());
    cols = [col];
  } else {
    const formulas = getHeaderInfo_(sheet).formulas;
    cols = formulas.map(function (f, i) { return f === '' ? i : -1; }).filter(function (i) { return i !== -1; });
  }
  // Speed: read only the last rows (the last value is almost always near getLastRow); the whole
  // tab only if they are all empty.
  const scan = function (from) {
    const values = sheet.getRange(from, 1, lastRow - from + 1, lastCol).getValues();
    for (let i = values.length - 1; i >= 0; i--) {
      if (from + i < 2) break;
      for (let k = 0; k < cols.length; k++) {
        if (String(values[i][cols[k]]).trim() !== '') return from + i;
      }
    }
    return 1;
  };
  const tailStart = Math.max(1, lastRow - 49);
  const found = scan(tailStart);
  return found > 1 || tailStart === 1 ? found : scan(1);
}

/**
 * Next ID like TRX-0124 (or PTG-001 with digits = 3): highest existing
 * number in the column + 1. Sub-records like PTG-010-A are not counted.
 * Call inside withScriptLock_ so two users can't get the same ID.
 */
function nextId_(sheet, header, prefix, digits) {
  const col = getHeaderMap_(sheet)[header.toLowerCase()];
  if (col === undefined) throw new Error('Column "' + header + '" not found in tab ' + sheet.getName());
  let max = 0;
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const pattern = new RegExp('^' + prefix + '-(\\d+)$', 'i');
    sheet.getRange(2, col + 1, lastRow - 1, 1).getValues().forEach(function (r) {
      const m = String(r[0]).trim().match(pattern);
      if (m) max = Math.max(max, Number(m[1]));
    });
  }
  return prefix + '-' + String(max + 1).padStart(digits || 4, '0'); // debts use 3 digits (PTG-001)
}

/**
 * Writes rows of {header: value} objects starting at startRow. Only the
 * columns named in the objects are written (so other tables on the same tab,
 * and formula columns, are left alone). Throws if a name has no matching
 * header, so data is never silently dropped.
 */
function writeRowsByHeaders_(sheet, startRow, objects) {
  if (objects.length === 0) return;
  const info = getHeaderInfo_(sheet);
  const lastCol = info.lastCol;
  const headers = info.headers;
  const formulas = info.formulas;

  const rows = objects.map(function (obj) {
    const row = {};
    Object.keys(obj).forEach(function (k) { row[k.trim().toLowerCase()] = obj[k]; });
    return row;
  });

  const used = headers.map(function () { return false; });
  rows.forEach(function (row) {
    Object.keys(row).forEach(function (name) {
      const col = headers.indexOf(name);
      if (col === -1) throw new Error('Column "' + name + '" not found in tab ' + sheet.getName());
      if (formulas[col] !== '') throw new Error('Column "' + name + '" is a formula column and cannot be written.');
      used[col] = true;
    });
  });

  const lastNeededRow = startRow + rows.length - 1;
  if (lastNeededRow > sheet.getMaxRows()) {
    sheet.insertRowsAfter(sheet.getMaxRows(), lastNeededRow - sheet.getMaxRows());
  }

  // Write each run of neighbouring used columns in one setValues call.
  let i = 0;
  while (i < lastCol) {
    if (!used[i]) { i++; continue; }
    let j = i;
    while (j + 1 < lastCol && used[j + 1]) j++;
    const block = rows.map(function (row) {
      const out = [];
      for (let k = i; k <= j; k++) {
        const v = row[headers[k]];
        out.push(v === undefined || v === null ? '' : v);
      }
      return out;
    });
    sheet.getRange(startRow, i + 1, rows.length, j - i + 1).setValues(block);
    i = j + 1;
  }
}

/**
 * Sets one column for the rows whose idHeader value is a key of `byId`
 * ({ 'PTG-001': value }): reads the ID and target columns once and writes
 * the target column back in one call. Returns how many rows were set.
 * Call inside withScriptLock_.
 */
function setColumnById_(sheet, idHeader, targetHeader, byId) {
  const step = prepareColumnById_(sheet, idHeader, targetHeader, byId);
  step.commit();
  return step.count;
}

/**
 * setColumnById_ in two steps: reads now, writes on commit(). A save reads
 * everything first and writes afterwards, because a read after a write makes
 * the sheet recalculate its formulas first (slow).
 */
function prepareColumnById_(sheet, idHeader, targetHeader, byId) {
  const map = getHeaderMap_(sheet);
  const idCol = map[idHeader.toLowerCase()];
  const col = map[targetHeader.toLowerCase()];
  if (idCol === undefined || col === undefined) throw new Error('Column "' + (idCol === undefined ? idHeader : targetHeader) +
    '" not found in tab ' + sheet.getName());
  const n = sheet.getLastRow() - 1;
  if (n < 1 || Object.keys(byId).length === 0) return { count: 0, commit: function () {} };
  const ids = sheet.getRange(2, idCol + 1, n, 1).getValues();
  const range = sheet.getRange(2, col + 1, n, 1);
  const values = range.getValues();
  let count = 0;
  ids.forEach(function (r, i) {
    const id = String(r[0]).trim();
    if (id !== '' && Object.prototype.hasOwnProperty.call(byId, id)) { values[i][0] = byId[id]; count++; }
  });
  return { count: count, commit: function () { if (count) range.setValues(values); } };
}

/**
 * Appends one row to a tab below the last row that has a value in keyHeader
 * (default: first column). Returns false if the tab doesn't exist.
 */
function appendRowByHeaders_(spreadsheet, tabName, values, keyHeader) {
  const sheet = spreadsheet.getSheetByName(tabName);
  if (sheet === null) return false;
  writeRowsByHeaders_(sheet, lastDataRow_(sheet, keyHeader) + 1, [values]);
  return true;
}

/**
 * Writes a row to the Logs tab. Returns false (without error) if there is no
 * main sheet or Logs tab.
 */
function writeLogRow_(level, source, message, details) {
  const ss = openMainSheet_();
  if (ss === null) return false;
  return appendRowByHeaders_(ss, TAB.LOGS, {
    'Timestamp': new Date(),
    'Level': level,
    'Source': source,
    'Message': message,
    'Details': details === undefined ? '' : (typeof details === 'string' ? details : JSON.stringify(details))
  });
}
