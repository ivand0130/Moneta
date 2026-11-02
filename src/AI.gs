/**
 * AI.gs — Gemini calls with JSON-only prompts and graceful fallback.
 *
 * Any failure (AI turned off, no key, rate limit, bad answer) returns null
 * and is written to the Logs tab; the caller then falls back to buttons.
 * Note: UrlFetchApp has no timeout setting, so a slow Gemini reply delays the
 * preview; the bot shows "typing…" meanwhile.
 */

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const GEMINI_TRIES = 3; // retries only for 503 / 500 / network errors

/**
 * Sends a prompt and returns the parsed JSON answer, or null on any failure.
 * The key goes in a header (not the URL) so it can never appear in logs.
 */
function callGeminiJson_(prompt, source, image, tries) {
  const maxTries = tries || GEMINI_TRIES; // photos use 2: a slow vision call shouldn't keep the user waiting minutes
  if (!getSettingYes_(SETTING.AI_ENABLED)) return null;
  const key = getProp_(PROP.GEMINI_KEY);
  if (key === null) {
    logAiFailure_(source, 'GEMINI_KEY is not set');
    return null;
  }
  const textModel = getSetting_(SETTING.GEMINI_MODEL);
  // Photos may use a lighter, faster model (Settings → Gemini Vision Model); text keeps the main one.
  let model = image ? (String(getSetting_(SETTING.GEMINI_VISION_MODEL) || '').trim() || textModel) : textModel;
  const started = Date.now();
  const trace = function (text) { if (image || source === 'ocr') recordEvent_('ocr: Gemini ' + model + ' ' + text + ' after ' + Math.round((Date.now() - started) / 1000) + 's'); };
  const body = {
    // image = { mimeType, data (base64) } for bill photos (Phase 7)
    contents: [{ role: 'user', parts: [{ text: prompt }].concat(image ? [{ inline_data: { mime_type: image.mimeType, data: image.data } }] : []) }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' }
  };
  const request = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    muteHttpExceptions: true,
    payload: JSON.stringify(body)
  };
  // Google's free tier sometimes answers 503 "high demand" (or 500): wait 1s, then 2s, and try
  // again — at most 3 tries (~3s extra), so a busy moment doesn't lose the AI answer.
  let response;
  let code = 0;
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      response = UrlFetchApp.fetch(GEMINI_URL + encodeURIComponent(model) + ':generateContent', request);
      code = response.getResponseCode();
    } catch (err) {
      response = null;
      code = 0; // network error: also worth one more try
    }
    trace('try ' + attempt + ' → ' + (code || 'network error') +
      (response && code !== 200 ? ' ' + response.getContentText().replace(/\s+/g, ' ').slice(0, 160) : ''));
    // The photo model refused the request (not available on this key, unsupported option…): use the main model instead.
    if (image && model !== textModel && code >= 400 && code < 500 && code !== 429) {
      model = textModel;
      attempt--;
      continue;
    }
    if (code === 200 || (code !== 0 && code !== 500 && code !== 503) || attempt === maxTries) break;
    Utilities.sleep(1000 * attempt);
  }
  if (response === null) {
    logAiFailure_(source, 'network error');
    return null;
  }
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

/**
 * Asks Gemini to read the message. Returns a parser-style result
 * ({ ok: true, … readByAi }), null if Gemini says it isn't one transaction,
 * or { ok: false, failed: true } if the call failed (see the Logs tab).
 */
function aiParseTransaction_(text, ctx, now) {
  const wallets = ctx.wallets.filter(function (w) { return w.active && w.type === 'Cash'; }).map(function (w) { return w.name; });
  const prompt = [
    'You read personal finance messages from a household in Indonesia (Bahasa Indonesia, English, or both).',
    'Today is ' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd') + ' (Asia/Jakarta).',
    'Message: ' + JSON.stringify(text),
    'Wallets: ' + JSON.stringify(wallets),
    'Amounts are Indonesian Rupiah: "dua puluh ribu" = 20000, "goceng" = 5000, "ceban" = 10000, "1,5 juta" = 1500000.',
    'If the message is not ONE money transaction (a greeting, a question, several transactions), set is_transaction to false.',
    'Reply with JSON only:',
    '{"is_transaction": true, "type": "Expense|Income|Transfer", "amount": 20000, "wallet": "exact wallet name or empty",',
    ' "to_wallet": "exact wallet name or empty (transfers only)", "date": "YYYY-MM-DD or empty", "note": "short note"}'
  ].join('\n');
  const answer = callGeminiJson_(prompt, 'parse');
  if (answer === null) return { ok: false, failed: true }; // the call itself failed (logged)
  return validateAiTransaction_(answer, ctx, now);
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
  // AI only reads the message; the category comes from the keywords (or buttons), as for typed messages.
  let category = null;
  let categoryHow = '';
  if (type !== 'Transfer') {
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
