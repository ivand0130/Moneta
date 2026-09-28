/**
 * AI.gs — Gemini calls with JSON-only prompts and graceful fallback.
 *
 * Any failure (AI turned off, no key, rate limit, bad answer) returns null
 * and is written to the Logs tab; the caller then falls back to buttons.
 * Note: UrlFetchApp has no timeout setting, so a slow Gemini reply delays the
 * preview; the bot shows "typing…" meanwhile.
 */

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';

/**
 * Sends a prompt and returns the parsed JSON answer, or null on any failure.
 * The key goes in a header (not the URL) so it can never appear in logs.
 */
function callGeminiJson_(prompt, source) {
  if (!getSettingYes_(SETTING.AI_ENABLED)) return null;
  const key = getProp_(PROP.GEMINI_KEY);
  if (key === null) {
    logAiFailure_(source, 'GEMINI_KEY is not set');
    return null;
  }
  const model = getSetting_(SETTING.GEMINI_MODEL);
  let response;
  try {
    response = UrlFetchApp.fetch(GEMINI_URL + encodeURIComponent(model) + ':generateContent', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      muteHttpExceptions: true,
      payload: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' }
      })
    });
  } catch (err) {
    logAiFailure_(source, 'network error');
    return null;
  }
  const code = response.getResponseCode();
  if (code !== 200) {
    logAiFailure_(source, code === 429 ? 'rate limit (HTTP 429)' : 'HTTP ' + code,
      response.getContentText().slice(0, 300));
    return null;
  }
  try {
    const body = JSON.parse(response.getContentText());
    const text = body.candidates[0].content.parts[0].text;
    return JSON.parse(text);
  } catch (err) {
    logAiFailure_(source, 'unreadable answer', response.getContentText().slice(0, 300));
    return null;
  }
}

function logAiFailure_(source, message, details) {
  console.warn('[AI ' + source + '] ' + message);
  try {
    writeLogRow_('WARN', 'AI/' + source, message, details);
  } catch (err) {
    console.warn('logAiFailure_: ' + err.message);
  }
}

/**
 * Asks Gemini to pick one category from the list for this note.
 * Returns a category name from the list, or null.
 */
function aiSuggestCategory_(note, type, categoryNames) {
  if (!note || categoryNames.length === 0) return null;
  const prompt = [
    'You categorize personal finance transactions for a household in Indonesia.',
    'The note may be in Bahasa Indonesia, English, or both.',
    'Transaction type: ' + type,
    'Note: ' + JSON.stringify(note),
    'Choose exactly one category from this list: ' + JSON.stringify(categoryNames),
    'If none fits reasonably, use an empty string.',
    'Reply with JSON only, like {"category": "Food", "confidence": 0.9}'
  ].join('\n');
  const answer = callGeminiJson_(prompt, 'category');
  if (answer === null || typeof answer.category !== 'string' || answer.category === '') return null;
  if (typeof answer.confidence === 'number' && answer.confidence < 0.5) return null;
  const match = categoryNames.filter(function (n) { return n.toLowerCase() === answer.category.toLowerCase(); })[0];
  if (!match) {
    logAiFailure_('category', 'answer not in category list', answer.category);
    return null;
  }
  return match;
}

// ---------------------------------------------------------------------------
// AI parsing fallback (deferred item from Phase 2, built in Phase 3)
// ---------------------------------------------------------------------------
// Used only when the rule-based parser finds no clear amount (no_amount /
// multiple_amounts) and the text looks like it mentions money. Gemini's
// answer is checked field by field against the real wallets and categories,
// and always ends in the normal preview (marked "read by AI"), so nothing
// unclear is ever saved. Transfers with fees etc. stay with the rules.

/** True if the text has a digit or a number word, so asking Gemini is worth it ("hello" is not). */
function looksLikeMoney_(text) {
  return /\d/.test(text) ||
    /(^|[^a-z])(ribu|rb|juta|jt|ratus|puluh|belas|seribu|sejuta|seratus|sepuluh|goceng|gocap|ceban|cepek|thousand|million|hundred)([^a-z]|$)/i.test(text);
}

/** Asks Gemini to read the message. Returns a parser-style result ({ ok: true, … readByAi }) or null. */
function aiParseTransaction_(text, ctx, now) {
  const wallets = ctx.wallets.filter(function (w) { return w.active && w.type === 'Cash'; }).map(function (w) { return w.name; });
  const cats = function (type) {
    return ctx.categories.filter(function (c) { return c.type === type; }).map(function (c) { return c.name; });
  };
  const prompt = [
    'You read personal finance messages from a household in Indonesia (Bahasa Indonesia, English, or both).',
    'Today is ' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd') + ' (Asia/Jakarta).',
    'Message: ' + JSON.stringify(text),
    'Wallets: ' + JSON.stringify(wallets),
    'Expense categories: ' + JSON.stringify(cats('Expense')),
    'Income categories: ' + JSON.stringify(cats('Income')),
    'Amounts are Indonesian Rupiah: "dua puluh ribu" = 20000, "goceng" = 5000, "ceban" = 10000, "1,5 juta" = 1500000.',
    'If the message is not ONE money transaction (a greeting, a question, several transactions), set is_transaction to false.',
    'Reply with JSON only:',
    '{"is_transaction": true, "type": "Expense|Income|Transfer", "amount": 20000, "wallet": "exact wallet name or empty",',
    ' "to_wallet": "exact wallet name or empty (transfers only)", "date": "YYYY-MM-DD or empty", "note": "short note",',
    ' "category": "exact category name or empty"}'
  ].join('\n');
  const answer = callGeminiJson_(prompt, 'parse');
  return answer === null ? null : validateAiTransaction_(answer, ctx, now);
}

/**
 * Checks Gemini's answer against the real data. Anything doubtful becomes
 * empty (the normal flow then asks for it); a missing amount or type rejects
 * the whole answer. Pure, so testAiParse can check it.
 */
function validateAiTransaction_(a, ctx, now) {
  if (!a || a.is_transaction !== true) return null;
  const type = ['Expense', 'Income', 'Transfer'].filter(function (t) { return t === a.type; })[0];
  const amount = typeof a.amount === 'number' ? Math.round(a.amount) : Number(String(a.amount || '').replace(/[^\d]/g, ''));
  if (!type || !(amount > 0) || amount > 1e12) return null;

  const walletBy = function (name, forTransfer) {
    if (!name) return null;
    const w = ctx.wallets.filter(function (x) { return x.active && x.name.toLowerCase() === String(name).toLowerCase(); })[0];
    if (!w) return null;
    const allowed = forTransfer ? w.type !== 'Investment' : !isInvestmentWallet_(w, ctx.investmentGroups);
    return allowed ? w.name : null;
  };
  const wallet = walletBy(a.wallet, type === 'Transfer');
  let toWallet = type === 'Transfer' ? walletBy(a.to_wallet, true) : null;
  if (toWallet && toWallet === wallet) toWallet = null;

  let date = new Date(now.getTime());
  const m = String(a.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const d = makeDate_(Number(m[1]), Number(m[2]) - 1, Number(m[3]), now);
    if (d && d.getTime() <= now.getTime() + 86400000 && d.getTime() >= now.getTime() - 366 * 86400000) date = d;
  }

  const note = String(a.note || '').trim().slice(0, 200);
  let category = null;
  let categoryHow = '';
  if (type !== 'Transfer' && a.category) {
    const c = ctx.categories.filter(function (x) {
      return x.type === type && x.name.toLowerCase() === String(a.category).toLowerCase();
    })[0];
    if (c) { category = c.name; categoryHow = 'ai'; }
  }
  if (type !== 'Transfer' && !category) {
    const k = matchKeyword_(note, ctx.categories, [type]);
    if (k) { category = k.category; categoryHow = 'keyword'; }
  }
  return {
    ok: true, type: type, amount: amount, amountOptions: null, amountReason: null, amountText: String(amount),
    date: date, dateGiven: !!m, dateNeedsConfirm: false, dateText: '',
    wallet: wallet, walletChoices: null, toWallet: toWallet, toWalletChoices: null,
    category: category, categoryHow: categoryHow, unknownTag: null, note: note, extra: null, readByAi: true
  };
}
