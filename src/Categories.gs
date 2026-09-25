/**
 * Categories.gs — categories and keywords read from the Categories tab,
 * category matching (#tag, keyword), saving new keywords, /category.
 *
 * Mapping order (SPEC Section 5): #tag → keyword → Gemini (AI.gs) → buttons.
 */

// Words never offered as keywords ("save 'di' as a keyword?" makes no sense).
const KEYWORD_STOPWORDS = ['di', 'ke', 'dari', 'yang', 'untuk', 'buat', 'beli', 'bayar', 'pakai', 'pake',
  'dan', 'atau', 'sama', 'dengan', 'dgn', 'via', 'lagi', 'tadi', 'aja', 'saja', 'nya', 'the', 'for',
  'at', 'in', 'on', 'of', 'to', 'from', 'with', 'and', 'buy', 'pay', 'paid', 'bought'];

/** Loads categories: [{name, type, keywords: [], defaultWallet, row}] */
function loadCategories_(ss) {
  return readTableByHeaders_(ss.getSheetByName(TAB.CATEGORIES), 'Category').map(function (r) {
    return {
      name: String(r['category']).trim(),
      type: String(r['type']).trim(),
      keywords: String(r['keywords'] || '').split(',')
        .map(function (k) { return k.trim(); })
        .filter(String),
      defaultWallet: String(r['default wallet'] || '').trim(),
      row: r._row
    };
  });
}

/** Lowercase, punctuation → spaces (keeps . - & / inside words like "tiket.com"). */
function normalizeForMatch_(text) {
  return String(text || '').toLowerCase()
    .replace(/[^\p{L}\p{N}.\-&\/]+/gu, ' ')
    .replace(/(^|\s)[.\-]+|[.\-]+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Finds the category for a #tag: exact name first (ignoring case, spaces
 * and symbols), then a unique prefix ("#bills" → "Bills & Utilities").
 * types limits the search (e.g. ['Expense']). Returns the category or null.
 */
function findCategoryByTag_(tag, categories, types) {
  const norm = function (s) { return String(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); };
  const t = norm(tag);
  if (t === '') return null;
  const pool = categories.filter(function (c) { return !types || types.indexOf(c.type) !== -1; });
  const exact = pool.filter(function (c) { return norm(c.name) === t; });
  if (exact.length) return exact[0];
  const prefix = pool.filter(function (c) { return norm(c.name).indexOf(t) === 0; });
  return prefix.length === 1 ? prefix[0] : null;
}

/**
 * Keyword match: the longest keyword found as whole word(s) in the text
 * wins. Returns { category, type, keyword } or null.
 */
function matchKeyword_(text, categories, types) {
  const hay = ' ' + normalizeForMatch_(text) + ' ';
  let best = null;
  categories.forEach(function (c) {
    if (types && types.indexOf(c.type) === -1) return;
    c.keywords.forEach(function (k) {
      const kw = normalizeForMatch_(k);
      if (kw === '' || hay.indexOf(' ' + kw + ' ') === -1) return;
      if (best === null || kw.length > best.keyword.length) {
        best = { category: c.name, type: c.type, keyword: kw };
      }
    });
  });
  return best;
}

/** Up to 4 words from a note worth offering as a new keyword. */
function keywordCandidates_(note) {
  const seen = [];
  normalizeForMatch_(note).split(' ').forEach(function (w) {
    if (w.length < 3 || /^\d/.test(w) || KEYWORD_STOPWORDS.indexOf(w) !== -1 || seen.indexOf(w) !== -1) return;
    seen.push(w);
  });
  return seen.slice(0, 4);
}

/**
 * Adds a keyword to a category and removes it from any other category, so
 * the same word never maps two ways. Returns the names it was removed from.
 */
function addKeywordToCategory_(ss, categoryName, keyword) {
  return withScriptLock_(function () {
    const sheet = ss.getSheetByName(TAB.CATEGORIES);
    const col = getHeaderMap_(sheet)['keywords'];
    const kw = normalizeForMatch_(keyword);
    const removedFrom = [];
    loadCategories_(ss).forEach(function (c) {
      const has = c.keywords.some(function (k) { return normalizeForMatch_(k) === kw; });
      let list = c.keywords;
      if (c.name === categoryName) {
        if (has) return;
        list = list.concat([kw]);
      } else if (has) {
        list = list.filter(function (k) { return normalizeForMatch_(k) !== kw; });
        removedFrom.push(c.name);
      } else {
        return;
      }
      sheet.getRange(c.row, col + 1).setValue(list.join(', '));
    });
    return removedFrom;
  });
}

/** Adds a category row. Throws if the name already exists. */
function addCategory_(ss, name, type) {
  withScriptLock_(function () {
    if (loadCategories_(ss).some(function (c) { return c.name.toLowerCase() === name.toLowerCase(); })) {
      throw new Error('Category "' + name + '" already exists.');
    }
    appendRowByHeaders_(ss, TAB.CATEGORIES, { 'Category': name, 'Type': type });
  });
}

/** /category → list grouped by type. */
function buildCategoryListText_(categories) {
  const order = ['Expense', 'Income', 'Investment', 'Adjustment'];
  const lines = ['📂 <b>Categories</b>'];
  order.forEach(function (type) {
    const names = categories.filter(function (c) { return c.type === type; })
      .map(function (c) { return escapeHtml_(c.name) + (c.defaultWallet ? ' <i>(' + escapeHtml_(c.defaultWallet) + ')</i>' : ''); });
    if (names.length) lines.push('', '<b>' + type + '</b>', names.join(' · '));
  });
  lines.push('', 'Use one in a message with #, e.g. <code>30rb obat #health</code>.',
    'Add one: <code>/category add Pets</code>. Keywords are edited in the Categories tab.');
  return lines.join('\n');
}
