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

/**
 * Maps header names (trimmed, lowercase) to 0-based column indexes,
 * using row 1 of the given tab. Blank headers are skipped.
 */
function getHeaderMap_(sheet) {
  const lastCol = sheet.getLastColumn();
  const map = {};
  if (lastCol === 0) return map;
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  headers.forEach(function (h, i) {
    const name = String(h).trim().toLowerCase();
    if (name !== '' && map[name] === undefined) map[name] = i;
  });
  return map;
}

/**
 * Reads a tab (or one table inside it, like Users in Settings) as objects
 * keyed by lowercase header name. Rows where keyHeader is blank are skipped.
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
    const row = {};
    headers.forEach(function (h, j) {
      if (h !== '' && row[h] === undefined) row[h] = values[i][j];
    });
    rows.push(row);
  }
  return rows;
}

/**
 * Last row (1-based) that has a value in the given column (default: the
 * first column). Returns 1 when only the header exists.
 */
function lastDataRow_(sheet, keyHeader) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 1;
  let col = 0;
  if (keyHeader) {
    col = getHeaderMap_(sheet)[keyHeader.toLowerCase()];
    if (col === undefined) throw new Error('Column "' + keyHeader + '" not found in tab ' + sheet.getName());
  }
  const values = sheet.getRange(1, col + 1, lastRow, 1).getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (String(values[i][0]).trim() !== '') return i + 1;
  }
  return 1;
}

/**
 * Writes rows of {header: value} objects starting at startRow. Only the
 * columns named in the objects are written (so other tables on the same tab,
 * and formula columns, are left alone). Throws if a name has no matching
 * header, so data is never silently dropped.
 */
function writeRowsByHeaders_(sheet, startRow, objects) {
  if (objects.length === 0) return;
  const lastCol = sheet.getLastColumn();
  const headerRange = sheet.getRange(1, 1, 1, lastCol);
  const headers = headerRange.getValues()[0].map(function (h) { return String(h).trim().toLowerCase(); });
  const formulas = headerRange.getFormulas()[0];

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
