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
      budget: parseBudget_(r['monthly budget']),
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

// ---------------------------------------------------------------------------
// Budgets (SPEC Section 25): Monthly Budget per category in the Categories
// tab; empty or 0 = no limit; only Expense categories use it.
// ---------------------------------------------------------------------------

/** A Monthly Budget cell → whole Rupiah (number or text like "1.500.000"), 0 if empty. */
function parseBudget_(value) {
  if (typeof value === 'number') return Math.max(0, Math.round(value));
  const digits = String(value || '').replace(/[^\d]/g, '');
  return digits === '' ? 0 : Number(digits);
}

/** Sum of amounts that count as expense for a category in one month (month is 0-based). */
function spentInMonth_(rows, category, year, month) {
  return rows.reduce(function (sum, r) {
    const d = r['date'];
    if (!(d instanceof Date) || d.getFullYear() !== year || d.getMonth() !== month) return sum;
    if (!countsAsExpense_(r) || String(r['category']).trim() !== category) return sum;
    return sum + (Number(r['amount']) || 0);
  }, 0);
}

/**
 * The budget message for these { category, year, month, budget, spent }
 * items, or '' if there are none. Amounts go through the spoiler helper.
 */
function buildBudgetText_(items, hide) {
  if (items.length === 0) return '';
  return items.map(function (it) {
    const month = Utilities.formatDate(new Date(it.year, it.month, 1), Session.getScriptTimeZone(), 'MMMM yyyy');
    const pct = Math.round(it.spent / it.budget * 100);
    const over = it.spent - it.budget;
    const head = over > 0
      ? '⚠️ <b>' + escapeHtml_(it.category) + ' is OVER budget by </b>' + money_(over, hide) + ' <i>(' + month + ')</i>'
      : '📊 <b>Budget · ' + escapeHtml_(it.category) + ' · ' + month + '</b>';
    const line = 'Budget ' + money_(it.budget, hide) + ' | Spent ' + money_(it.spent, hide) + ' (' + pct + '%)' +
      (over > 0 ? '' : ' | Remaining ' + money_(it.budget - it.spent, hide));
    return head + '\n' + line;
  }).join('\n\n');
}

/** "Spent Rp60.000 of Rp100.000 (60%) · Rp40.000 left" or "… (110%) · over by Rp10.000". */
function budgetLine_(budget, spent, hide) {
  const pct = Math.round(spent / budget * 100);
  const left = budget - spent;
  return 'Spent ' + money_(spent, hide) + ' of ' + money_(budget, hide) + ' (' + pct + '%) · ' +
    (left < 0 ? 'over by ' + money_(-left, hide) : money_(left, hide) + ' left');
}

/**
 * The /budget reply for the month of `now`. filter (optional) = one
 * category (any case, unique prefix). Returns { text } or { error }.
 * Pure: categories/rows are passed in, so testBudgetCommand can check it.
 */
function buildBudgetReport_(categories, rows, now, filter, hide) {
  const year = now.getFullYear();
  const month = now.getMonth();
  const monthLabel = Utilities.formatDate(new Date(year, month, 1), Session.getScriptTimeZone(), 'MMMM yyyy');
  const f = String(filter || '').trim().replace(/^#/, '');

  if (f !== '') {
    const c = findCategoryByTag_(f, categories);
    if (!c) return { error: 'No category called "' + escapeHtml_(f) + '". See /category for the list.' };
    if (c.type !== 'Expense') {
      return { error: escapeHtml_(c.name) + ' is an ' + escapeHtml_(c.type) + ' category. Budgets are only for expense categories.' };
    }
    const spent = spentInMonth_(rows, c.name, year, month);
    if (!(c.budget > 0)) {
      return { text: '📊 <b>' + escapeHtml_(c.name) + ' · ' + monthLabel + '</b>\nNo budget set (no limit). Spent this month: ' +
        money_(spent, hide) + '\n<i>Set one in the Categories tab → Monthly Budget.</i>' };
    }
    return { text: (spent > c.budget ? '⚠️ ' : '📊 ') + '<b>' + escapeHtml_(c.name) + ' · ' + monthLabel + '</b>\n' +
      budgetLine_(c.budget, spent, hide) };
  }

  // All categories: first row wins if a name appears twice.
  const seen = [];
  const duplicates = [];
  const budgeted = [];
  const ignored = [];
  categories.forEach(function (c) {
    const key = c.name.toLowerCase();
    if (seen.indexOf(key) !== -1) { duplicates.push(c.name); return; }
    seen.push(key);
    if (c.budget > 0 && c.type !== 'Expense') ignored.push(c.name);
    else if (c.budget > 0) budgeted.push(c);
  });

  const lines = ['📊 <b>Budgets · ' + monthLabel + '</b>'];
  let totalBudget = 0;
  let totalSpent = 0;
  if (budgeted.length === 0) {
    lines.push('', 'No budgets set yet. Add a Monthly Budget to an expense category in the Categories tab.');
  } else {
    lines.push('');
    budgeted.forEach(function (c) {
      const spent = spentInMonth_(rows, c.name, year, month);
      totalBudget += c.budget;
      totalSpent += spent;
      lines.push((spent > c.budget ? '⚠️ ' : '• ') + '<b>' + escapeHtml_(c.name) + '</b>: ' + budgetLine_(c.budget, spent, hide));
    });
    lines.push('', '<b>Total budgeted</b>: ' + budgetLine_(totalBudget, totalSpent, hide));
  }

  // Spending in categories without a budget (or with no category at all).
  const budgetedNames = budgeted.map(function (c) { return c.name; });
  const other = rows.reduce(function (sum, r) {
    const d = r['date'];
    if (!(d instanceof Date) || d.getFullYear() !== year || d.getMonth() !== month || !countsAsExpense_(r)) return sum;
    return budgetedNames.indexOf(String(r['category']).trim()) === -1 ? sum + (Number(r['amount']) || 0) : sum;
  }, 0);
  lines.push('Spending without a budget: ' + money_(other, hide));

  if (ignored.length) {
    lines.push('', '<i>⚠️ Budgets on ' + escapeHtml_(ignored.join(', ')) + ' are ignored (only Expense categories use budgets).</i>');
  }
  if (duplicates.length) {
    lines.push('<i>⚠️ ' + escapeHtml_(duplicates.join(', ')) + ' appears more than once in Categories; the first row is used.</i>');
  }
  return { text: lines.join('\n') };
}

/** /budget [category] — asks for the password first if "Password for /budget" = Yes. */
function startBudget_(chatId, filter) {
  loadSettingsTab_(true); // fresh, so the switches apply right away
  if (getSettingYes_(SETTING.BUDGET_PASSWORD)) {
    askPassword_(chatId, 'budget', { filter: filter }, '🔒 Enter the password to see budgets.\n' +
      '<i>You can turn this off in Settings → Password for /budget.</i>');
    return;
  }
  showBudget_(chatId, filter, false);
}

/** Sends the /budget reply; deleted after 60s when "Budget auto-delete" = Yes. */
function showBudget_(chatId, filter, isDefaultPassword) {
  const ss = openMainSheet_();
  const result = buildBudgetReport_(loadCategories_(ss), loadTransactions_(ss), new Date(), filter);
  if (result.error) {
    sendMessage(chatId, result.error);
    return;
  }
  let text = result.text;
  if (isDefaultPassword) {
    text += '\n\n⚠️ You are still using the default password <b>0000</b>. Change it with /changepass.';
  }
  const autoDelete = getSettingYes_(SETTING.BUDGET_AUTO_DELETE);
  const triggerMissing = autoDelete && !ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'cleanupMessages';
  });
  if (autoDelete && !triggerMissing) text += '\n\n🕒 This message will be deleted in ' + formatDelay_(BUDGET_REPLY_DELETE_SECONDS) + '.';
  if (triggerMissing) text += '\n\n⚠️ Auto-delete is not set up yet (run installCleanupTrigger in the editor).';
  const sent = sendMessage(chatId, text);
  if (autoDelete && !triggerMissing) scheduleDelete_(chatId, sent.message_id, BUDGET_REPLY_DELETE_SECONDS);
}
