/**
 * Sheets.gs — open the main sheet by ID, read/write helpers, header lookup
 * by NAME (never by fixed column number), ID generators.
 */

/** Opens the main sheet, or returns null if MAIN_SHEET_ID isn't set yet. */
function openMainSheet_() {
  const id = getProp_(PROP.MAIN_SHEET_ID);
  return id === null ? null : SpreadsheetApp.openById(id);
}

/**
 * Maps header names (trimmed, lowercase) to 0-based column indexes,
 * using row 1 of the given tab.
 */
function getHeaderMap_(sheet) {
  const lastCol = sheet.getLastColumn();
  const map = {};
  if (lastCol === 0) return map;
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  headers.forEach(function (h, i) {
    const name = String(h).trim().toLowerCase();
    if (name !== '') map[name] = i;
  });
  return map;
}

/**
 * Appends one row to a tab, placing each value under the header of the same
 * name (case-insensitive). Unknown names are ignored. Returns false if the
 * tab doesn't exist.
 */
function appendRowByHeaders_(spreadsheet, tabName, values) {
  const sheet = spreadsheet.getSheetByName(tabName);
  if (sheet === null) return false;
  const headerMap = getHeaderMap_(sheet);
  const row = new Array(sheet.getLastColumn()).fill('');
  Object.keys(values).forEach(function (name) {
    const col = headerMap[name.toLowerCase()];
    if (col !== undefined) row[col] = values[name];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
  return true;
}

/**
 * Writes a row to the Logs tab. Returns false (without error) until the main
 * sheet and its Logs tab exist (Phase 1).
 */
function writeLogRow_(level, source, message, details) {
  const ss = openMainSheet_();
  if (ss === null) return false;
  return appendRowByHeaders_(ss, 'Logs', {
    'Timestamp': new Date(),
    'Level': level,
    'Source': source,
    'Message': message,
    'Details': details === undefined ? '' : (typeof details === 'string' ? details : JSON.stringify(details))
  });
}
