/**
 * Favorites.gs — favorite / recurring transactions (SPEC Section 9).
 *
 *   /fav                      list as buttons, tap to log
 *   /fav listrik              log a favorite by name
 *   /fav add Bayar Token Listrik 100k setiap tanggal 1 September 2026
 *   /fav edit listrik jadi 150rb      /fav delete listrik
 *
 * The Favorites tab is read every time, so rows typed or edited in the sheet
 * work right away (a row without a Favorite ID gets one). Columns are found by
 * header name. Scheduled favorites are prompted by the morning reminder slot
 * (Reminders.gs) with [Yes] [Change amount] [Skip] buttons that keep working
 * for days: their data is "F|<action>|<favId>|<yyyymmdd of the due date>",
 * not tied to the 10-minute pending item.
 *
 * Logging a favorite reuses the normal transaction flow (Confirm.gs): the
 * draft carries favId, so rows get Input Source = Favorite and the Favorite
 * ID, Last Logged is updated, and expenses go through afterSave_ (budget).
 */

const WEEKDAYS = {
  minggu: 0, ahad: 0, sunday: 0, sun: 0, senin: 1, monday: 1, mon: 1, selasa: 2, tuesday: 2, tue: 2,
  rabu: 3, wednesday: 3, wed: 3, kamis: 4, thursday: 4, thu: 4, jumat: 5, "jum'at": 5, friday: 5, fri: 5,
  sabtu: 6, saturday: 6, sat: 6
};
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// How people phrase the parts of a favorite (the bot's vocabulary, not user data).
const FAV_VARIABLE_RE = /(^|\s)(?:variable|variabel|bervariasi|berubah-ubah|berubah|tidak\s+tetap|gak\s+tetap|ga\s+tetap)(?=\s|$)/i;
const FAV_FIXED_RE = /(^|\s)(?:fixed|tetap)(?=\s|$)/i;
const FAV_NO_SCHEDULE_RE = /(^|\s)(?:tanpa|no|hapus|tidak\s+ada)\s+(?:jadwal|schedule|reminder|pengingat)(?=\s|$)/i;
const FAV_NO_FEE_RE = /(^|\s)(?:tanpa|no|hapus)\s+(?:fee|admin|biaya\s+admin|biaya)(?=\s|$)/i;
const FAV_FEE_RE = /(^|\s)(?:biaya\s+)?(?:admin|adm|fee)\s+((?:rp\.?\s*)?\d[\d.,]*\s*(?:rb|ribu|k|jt|juta)?)(?=\s|$)/i;
const FAV_REMIND_RE = /(^|\s)(?:remind|ingatkan|ingetin)\s+(\S+)(?=\s|$)/i;
const FAV_RENAME_RE = /(^|\s)(?:nama|name|rename)\s+(.+)$/i;
// "keyword cicilan mobil, bayar mobil" — everything after it, comma-separated ("tanpa keyword" clears them).
const FAV_KEYWORDS_RE = /(^|\s)(?:keywords?|kata\s+kunci)\s+(.+)$/i;
const FAV_NO_KEYWORDS_RE = /(^|\s)(?:tanpa|no|hapus)\s+(?:keywords?|kata\s+kunci)(?=\s|$)/i;
const FAV_EDIT_SPLIT_RE = /\s+(?:jadi|menjadi|to|->|→)\s+/i;
const FAV_EDIT_FILLERS = ['jadi', 'dan', 'and', 'amount', 'jumlah', 'nominal', 'wallet', 'dompet', 'dari', 'ke', 'kategori',
  'category', 'pakai', 'pake', 'via'];
// A favorite logged this many days before its due date counts for that date (paid early).
const FAV_EARLY_DAYS = { Monthly: 7, Weekly: 3 };

// ---------------------------------------------------------------------------
// Parsing (pure: no sheet or Telegram calls; tested by testFavParser)
// ---------------------------------------------------------------------------

function escapeRe_(s) {
  return s.replace(/[.*+?^${}()|[\]\\']/g, '\\$&');
}

/**
 * Finds a schedule phrase and removes it from the text. Returns
 *   { text, schedule: 'Monthly' | 'Weekly' | '', day, start: Date | null } or { error }.
 * Monthly: "setiap tanggal 1 (September 2026)", "tiap bulan tgl 5", "tgl 5 setiap bulan",
 *          "tanggal 25", "monthly on the 5th", "every month on the 5th".
 * Weekly:  "setiap senin", "tiap minggu hari senin", "every monday", "weekly on friday".
 * A month (+ year) after the day is the start; without one start is null.
 */
function extractFavSchedule_(text, now) {
  const months = Object.keys(MONTH_WORDS).sort(function (a, b) { return b.length - a.length; }).join('|');
  const days = Object.keys(WEEKDAYS).sort(function (a, b) { return b.length - a.length; }).map(escapeRe_).join('|');
  const end = '(?=\\s|$|[,.])';
  const tail = '(?:\\s+(?:bulan\\s+|mulai\\s+|starting\\s+|from\\s+)?(' + months + ')(?:\\s+(\\d{4}))?)?';
  const monthly = [
    '(?:setiap|tiap|every)\\s+bulan\\s+(?:(?:tanggal|tgl\\.?|tg|on\\s+the|the)\\s*)?(\\d{1,2})(?:st|nd|rd|th)?' + tail,
    '(?:tanggal|tgl\\.?)\\s*(\\d{1,2})\\s+(?:setiap|tiap)\\s+bulan()()',
    '(?:monthly|bulanan)\\s+(?:on\\s+)?(?:the\\s+)?(?:tanggal\\s+|tgl\\.?\\s*)?(\\d{1,2})(?:st|nd|rd|th)?' + tail,
    'every\\s+month\\s+on\\s+the\\s+(\\d{1,2})(?:st|nd|rd|th)?' + tail,
    '(?:(?:setiap|tiap|every)\\s+)?(?:tanggal|tgl\\.?|tg|date)\\s*(\\d{1,2})' + tail
  ];
  for (let i = 0; i < monthly.length; i++) {
    const m = text.match(new RegExp('(^|\\s)' + monthly[i] + end, 'i'));
    if (!m) continue;
    const day = Number(m[2]);
    if (day < 1 || day > 31) return { error: 'fav_bad_day' };
    let start = null;
    if (m[3]) {
      const month = MONTH_WORDS[m[3].toLowerCase()];
      let year = m[4] ? Number(m[4]) : now.getFullYear();
      // No year: this year, unless that month is long past (then next year).
      if (!m[4] && month < now.getMonth() - 1) year += 1;
      start = new Date(year, month, favDayInMonth_(day, year, month));
    }
    return { text: removeMatch_(text, m), schedule: 'Monthly', day: day, start: start };
  }
  const weekly = [
    '(?:setiap|tiap|every)\\s+(?:minggu\\s+(?=(?:hari\\s+)?(?:' + days + ')' + end + ')|week\\s+on\\s+)?(?:hari\\s+|on\\s+)?(' + days + ')',
    '(?:weekly|mingguan)\\s+(?:on\\s+|hari\\s+)?(' + days + ')'
  ];
  for (let i = 0; i < weekly.length; i++) {
    const m = text.match(new RegExp('(^|\\s)' + weekly[i] + end, 'i'));
    if (!m) continue;
    return { text: removeMatch_(text, m), schedule: 'Weekly', day: WEEKDAY_NAMES[WEEKDAYS[m[2].toLowerCase()]], start: null };
  }
  return { text: text, schedule: '', day: '', start: null };
}

/** The text without the matched phrase (keeps the leading space group m[1]). */
function removeMatch_(text, m) {
  return (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ');
}

/** "Me" / "Partner" / "All" from a typed name; null if it isn't a user. */
function resolveRemind_(word, userNames) {
  const w = String(word || '').trim().toLowerCase();
  if (/^(all|semua|both|berdua)$/.test(w)) return 'All';
  return (userNames || []).filter(function (n) { return n.toLowerCase() === w; })[0] || null;
}

/** Pulls the default fee, "variable", and "remind X" out of the text. */
function extractFavExtras_(text, userNames) {
  const out = { text: text };
  if (FAV_NO_FEE_RE.test(out.text)) {
    out.fee = 0;
    out.text = out.text.replace(FAV_NO_FEE_RE, ' ');
  }
  const fee = out.text.match(FAV_FEE_RE);
  if (fee) {
    const a = parseAmountToken_(fee[2].replace(/\s+/g, '').toLowerCase());
    if (a === null || (a.ambiguous && a.ambiguous.reason !== 'small')) return { error: 'fav_fee_unclear' };
    out.fee = a.ambiguous ? a.ambiguous.options[0] : a.value;
    out.text = removeMatch_(out.text, fee);
  }
  if (FAV_VARIABLE_RE.test(out.text)) {
    out.valueType = 'Variable';
    out.text = out.text.replace(FAV_VARIABLE_RE, ' ');
  } else if (FAV_FIXED_RE.test(out.text)) {
    out.valueType = 'Fixed';
    out.text = out.text.replace(FAV_FIXED_RE, ' ');
  }
  const remind = out.text.match(FAV_REMIND_RE);
  if (remind) {
    out.remind = resolveRemind_(remind[2], userNames);
    if (out.remind === null) return { error: 'fav_remind_unknown', word: remind[2], names: userNames };
    out.text = removeMatch_(out.text, remind);
  }
  out.text = out.text.replace(/\s+/g, ' ').trim();
  return out;
}

/**
 * Reads "/fav add …" (the text after "add"). ctx = parser ctx + userNames.
 * Returns { ok: true, name, type, amount, amountOptions…, valueType, wallet, walletChoices,
 * toWallet, toWalletChoices, category, categoryHow, unknownTag, fee, schedule, day, start,
 * remind } or { ok: false, error, … }. No amount → Variable (asked each time).
 */
function parseFavAdd_(text, ctx) {
  const now = ctx.now || new Date();
  const kw = extractFavKeywords_(' ' + String(text || '') + ' ');
  const sch = extractFavSchedule_(kw.text, now);
  if (sch.error) return { ok: false, error: sch.error };
  const ex = extractFavExtras_(sch.text, ctx.userNames);
  if (ex.error) return Object.assign({ ok: false }, ex);
  if (ex.text === '') return { ok: false, error: 'fav_usage' };

  let parsed = parseTransaction_(ex.text, ctx);
  let noAmount = false;
  if (!parsed.ok && parsed.error === 'no_amount') {
    // No amount: read wallets / category with a stand-in amount, then drop it.
    parsed = parseTransaction_(ex.text + ' 1rb', ctx);
    noAmount = true;
  }
  if (!parsed.ok) return parsed;
  if (parsed.dateGiven) return { ok: false, error: 'fav_date', text: parsed.dateText };

  let fee = ex.fee || 0;
  if (parsed.extra) {
    if (parsed.extra.kind !== 'fee') return { ok: false, error: 'fav_extra' };
    if (!fee) fee = parsed.extra.amount;
  }
  // A transfer without other words: "Top up GoPay" / "Transfer BCA → Jago".
  const name = parsed.note || (parsed.type !== 'Transfer' ? ''
    : /(^|\s)top\s*-?\s*up(\s|$)/i.test(ex.text) && parsed.toWallet ? 'Top up ' + parsed.toWallet
      : 'Transfer ' + (parsed.wallet || '') + (parsed.toWallet ? ' → ' + parsed.toWallet : ''));
  if (name.trim() === '') return { ok: false, error: 'fav_no_name' };

  return {
    ok: true,
    name: name.trim().slice(0, 60),
    type: parsed.type,
    amount: noAmount ? null : parsed.amount,
    amountOptions: noAmount ? null : parsed.amountOptions,
    amountReason: parsed.amountReason,
    amountText: parsed.amountText,
    valueType: noAmount ? 'Variable' : (ex.valueType || 'Fixed'),
    wallet: parsed.wallet,
    walletChoices: parsed.walletChoices,
    toWallet: parsed.toWallet,
    toWalletChoices: parsed.toWalletChoices,
    category: parsed.category,
    categoryHow: parsed.categoryHow,
    unknownTag: parsed.unknownTag,
    fee: parsed.type === 'Income' ? 0 : fee,
    schedule: sch.schedule,
    day: sch.day,
    start: sch.start,
    remind: ex.remind || 'All',
    keywords: kw.keywords || []
  };
}

/**
 * Reads the change part of "/fav edit <name> jadi <change>" for favorite
 * `fav`. Returns { ok: true, changes: { field: newValue } } or { ok: false, error }.
 * Fields: name, amount, valueType, wallet, toWallet, category, fee, schedule, day, start, remind.
 */
function parseFavEdit_(text, fav, ctx) {
  const now = ctx.now || new Date();
  const ch = {};
  let rest = ' ' + String(text || '') + ' ';
  const kw = extractFavKeywords_(rest);
  if (kw.keywords) {
    ch.keywords = kw.keywords;
    rest = kw.text;
  }
  const rename = rest.match(FAV_RENAME_RE);
  if (rename) {
    ch.name = rename[2].trim().slice(0, 60);
    rest = rest.slice(0, rename.index);
  }
  if (FAV_NO_SCHEDULE_RE.test(rest)) {
    ch.schedule = '';
    ch.day = '';
    ch.start = null;
    rest = rest.replace(FAV_NO_SCHEDULE_RE, ' ');
  } else {
    const sch = extractFavSchedule_(rest, now);
    if (sch.error) return { ok: false, error: sch.error };
    if (sch.schedule) {
      ch.schedule = sch.schedule;
      ch.day = sch.day;
      ch.start = sch.start;
      rest = sch.text;
    }
  }
  const ex = extractFavExtras_(rest, ctx.userNames);
  if (ex.error) return Object.assign({ ok: false }, ex);
  ['fee', 'valueType', 'remind'].forEach(function (k) { if (ex[k] !== undefined) ch[k] = ex[k]; });

  const tokens = tokenize_(ex.text);
  let tag = null;
  tokens.forEach(function (t) { if (/^#\S+/.test(t.clean)) { tag = t.clean.slice(1); t.used = true; } });
  if (tag !== null) {
    if (fav.type === 'Transfer') return { ok: false, error: 'fav_transfer_category' };
    const c = findCategoryByTag_(tag, ctx.categories, [fav.type]);
    if (!c) return { ok: false, error: 'fav_unknown_tag', tag: tag };
    ch.category = c.name;
  }
  const mentions = extractWallets_(tokens, ctx.wallets);
  for (let i = 0; i < mentions.length; i++) {
    const m = mentions[i];
    if (m.wallets.length > 1) return { ok: false, error: 'fav_wallet_ambiguous', wallet: m.text };
    const toDest = fav.type === 'Transfer' && DEST_CONNECTORS.indexOf(m.connector) !== -1;
    ch[toDest ? 'toWallet' : 'wallet'] = m.wallets[0].name;
  }
  const amounts = extractAmounts_(tokens);
  if (amounts.length > 1) return { ok: false, error: 'multiple_amounts', amounts: amounts.map(function (a) { return a.text; }) };
  if (amounts.length === 1) {
    const a = amounts[0];
    if (a.ambiguous && a.ambiguous.reason !== 'small') return { ok: false, error: 'fav_amount_unclear', text: a.text };
    ch.amount = a.ambiguous ? a.ambiguous.options[0] : a.value;
    a.tokens.forEach(function (k) { tokens[k].used = true; });
  }
  // Other words are the new name ("jadi Token PLN"), minus filler words at either end.
  const leftover = tokens.filter(function (t) { return !t.used && t.clean !== ''; });
  while (leftover.length && FAV_EDIT_FILLERS.indexOf(leftover[0].clean) !== -1) leftover.shift();
  while (leftover.length && FAV_EDIT_FILLERS.indexOf(leftover[leftover.length - 1].clean) !== -1) leftover.pop();
  if (leftover.length) {
    if (ch.name) return { ok: false, error: 'fav_edit_leftover', words: leftover.map(function (t) { return t.raw; }) };
    ch.name = leftover.map(function (t) { return t.raw; }).join(' ').slice(0, 60);
  }
  if (Object.keys(ch).length === 0) return { ok: false, error: 'fav_edit_unclear' };
  return { ok: true, changes: ch };
}

/** Pulls "keyword a, b" (or "tanpa keyword" → []) out of the text. Returns { text, keywords? }. */
function extractFavKeywords_(text) {
  if (FAV_NO_KEYWORDS_RE.test(text)) return { text: text.replace(FAV_NO_KEYWORDS_RE, ' '), keywords: [] };
  const m = text.match(FAV_KEYWORDS_RE);
  if (!m) return { text: text };
  return { text: text.slice(0, m.index) + ' ', keywords: splitKeywords_(m[2]) };
}

/** "cicilan mobil, bayar mobil" → ['cicilan mobil', 'bayar mobil']. */
function splitKeywords_(raw) {
  return String(raw || '').split(/[,;]/).map(function (k) { return k.replace(/\s+/g, ' ').trim(); }).filter(String);
}

/** Lowercase, single spaces. */
function favKey_(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** True if the whole text is this favorite's name or one of its keywords. */
function favMatchesText_(fav, text) {
  const q = favKey_(text);
  return q !== '' && (favKey_(fav.name) === q || (fav.keywords || []).some(function (k) { return favKey_(k) === q; }));
}

/** Favorites matching a typed name: ID, exact name or keyword, else starting with it, else containing it. */
function findFavorites_(favs, query) {
  const q = favKey_(query);
  if (q === '') return [];
  const byId = favs.filter(function (f) { return f.id.toLowerCase() === q; });
  if (byId.length) return byId;
  const exact = favs.filter(function (f) { return favMatchesText_(f, q); });
  if (exact.length) return exact;
  const starts = favs.filter(function (f) { return favKey_(f.name).indexOf(q) === 0; });
  if (starts.length) return starts;
  return favs.filter(function (f) { return favKey_(f.name).indexOf(q) !== -1; });
}

/**
 * Splits "/fav edit" args into the favorite name and the change:
 * "belanja bulanan jadi 250rb" → ["belanja bulanan", "250rb"]. Without
 * "jadi", the longest favorite name the text starts with is the name.
 */
function splitFavEdit_(args, favs) {
  const m = String(args).match(FAV_EDIT_SPLIT_RE);
  if (m) return [args.slice(0, m.index).trim(), args.slice(m.index + m[0].length).trim()];
  const key = favKey_(args);
  const hit = favs.filter(function (f) { return key.indexOf(favKey_(f.name) + ' ') === 0 || key === favKey_(f.name); })
    .sort(function (a, b) { return b.name.length - a.name.length; })[0];
  if (hit) return [hit.name, args.trim().slice(hit.name.trim().length).trim()];
  return [args.trim(), ''];
}

// ---------------------------------------------------------------------------
// Schedule maths (pure; dates are local midnights)
// ---------------------------------------------------------------------------

function midnight_(date) {
  const d = new Date(date);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays_(date, n) {
  const d = new Date(date);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Day 29–31 falls on the last day of shorter months. */
function favDayInMonth_(day, year, month) {
  return Math.min(day, new Date(year, month + 1, 0).getDate());
}

/** Monthly → 1..31, Weekly → 0..6 (Sunday = 0); null if the Day/Date cell can't be read. */
function favDayNumber_(fav) {
  const raw = String(fav.day === undefined || fav.day === null ? '' : fav.day).trim().toLowerCase();
  if (fav.schedule === 'Weekly') return WEEKDAYS[raw] !== undefined ? WEEKDAYS[raw] : null;
  if (fav.schedule === 'Monthly') {
    if (/^(last|akhir|terakhir)$/.test(raw)) return 31;
    const n = Number(raw.replace(/[^\d]/g, ''));
    return raw !== '' && n >= 1 && n <= 31 ? n : null;
  }
  return null;
}

/** The latest due date on or before `day`. */
function favOccurrenceOnOrBefore_(fav, day) {
  const n = favDayNumber_(fav);
  if (n === null) return null;
  const d = midnight_(day);
  if (fav.schedule === 'Weekly') return addDays_(d, -((d.getDay() - n + 7) % 7));
  let date = new Date(d.getFullYear(), d.getMonth(), favDayInMonth_(n, d.getFullYear(), d.getMonth()));
  if (date > d) {
    const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    date = new Date(prev.getFullYear(), prev.getMonth(), favDayInMonth_(n, prev.getFullYear(), prev.getMonth()));
  }
  return date;
}

/** The first due date on or after `day`. */
function favNextOccurrence_(fav, day) {
  const n = favDayNumber_(fav);
  if (n === null) return null;
  const d = midnight_(day);
  if (fav.schedule === 'Weekly') return addDays_(d, (n - d.getDay() + 7) % 7);
  let date = new Date(d.getFullYear(), d.getMonth(), favDayInMonth_(n, d.getFullYear(), d.getMonth()));
  if (date < d) {
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    date = new Date(next.getFullYear(), next.getMonth(), favDayInMonth_(n, next.getFullYear(), next.getMonth()));
  }
  return date;
}

/** The due date to prompt for today (on/after Start Date), or null. */
function favDueOccurrence_(fav, today) {
  const occ = favOccurrenceOnOrBefore_(fav, today);
  if (!occ) return null;
  if (fav.start && occ < midnight_(fav.start)) return null;
  return occ;
}

/** True if this due date was already logged (from a few days before) or skipped. */
function favAnswered_(fav, occ) {
  const from = addDays_(occ, -(FAV_EARLY_DAYS[fav.schedule] || 0));
  if (fav.lastLogged && midnight_(fav.lastLogged) >= from) return true;
  return !!(fav.lastSkipped && midnight_(fav.lastSkipped) >= occ);
}

/** 1 → "1st", 22 → "22nd". */
function ordinal_(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** "every month on the 1st" / "every Monday" / "no schedule". */
function favScheduleText_(fav) {
  const n = favDayNumber_(fav);
  if (fav.schedule === 'Monthly' && n !== null) {
    return 'every month on the ' + ordinal_(n) + (n >= 29 ? ' (or the last day of shorter months)' : '');
  }
  if (fav.schedule === 'Weekly' && n !== null) return 'every ' + WEEKDAY_NAMES[n];
  return 'no schedule';
}

// ---------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------

function dateOrNull_(v) {
  return v instanceof Date && !isNaN(v.getTime()) ? v : null;
}

/** One Favorites row → a favorite object. Blank Type = Expense; no amount = Variable. */
function favFromRow_(r) {
  const amount = parseBudget_(r['amount']);
  const type = (String(r['type'] || '').trim().toLowerCase().replace(/^./, function (c) { return c.toUpperCase(); })) || 'Expense';
  const schedule = String(r['schedule'] || '').trim().toLowerCase();
  const day = r['day/date'];
  return {
    id: String(r['favorite id'] || '').trim(),
    name: String(r['name'] || '').trim(),
    type: type,
    valueType: /^variable$/i.test(String(r['value type'] || '').trim()) || amount === 0 ? 'Variable' : 'Fixed',
    amount: amount,
    category: String(r['category'] || '').trim(),
    wallet: String(r['wallet'] || '').trim(),
    toWallet: String(r['to wallet'] || '').trim(),
    fee: parseBudget_(r['default fee']),
    schedule: schedule === 'monthly' ? 'Monthly' : schedule === 'weekly' ? 'Weekly' : '',
    day: day instanceof Date ? day.getDate() : String(day === undefined || day === null ? '' : day).trim(),
    start: dateOrNull_(r['start date']),
    remind: String(r['remind'] || '').trim() || 'All',
    keywords: splitKeywords_(r['keywords']),
    lastLogged: dateOrNull_(r['last logged']),
    lastSkipped: dateOrNull_(r['last skipped']),
    active: String(r['active'] || '').trim().toLowerCase() !== 'no',
    row: r._row
  };
}

function loadFavorites_(ss) {
  const sheet = ss.getSheetByName(TAB.FAVORITES);
  if (sheet === null) return [];
  return readTableByHeaders_(sheet, 'Name').map(favFromRow_);
}

/**
 * Highest FAV number used so far, in Favorites AND in Transactions, so a
 * deleted favorite's ID is never given to a new one (the monthly report
 * counts favorites by ID).
 */
function maxFavoriteNumber_(ss) {
  let max = 0;
  [[TAB.FAVORITES, 'Favorite ID'], [TAB.TRANSACTIONS, 'Favorite ID']].forEach(function (t) {
    const sheet = ss.getSheetByName(t[0]);
    if (sheet === null || sheet.getLastRow() < 2) return;
    const col = getHeaderMap_(sheet)[t[1].toLowerCase()];
    if (col === undefined) return;
    sheet.getRange(2, col + 1, sheet.getLastRow() - 1, 1).getValues().forEach(function (r) {
      const m = String(r[0]).trim().match(/^FAV-(\d+)$/i);
      if (m) max = Math.max(max, Number(m[1]));
    });
  });
  return max;
}

function favIdFor_(n) {
  return 'FAV-' + String(n).padStart(3, '0');
}

/** Gives every Favorites row typed in the sheet without an ID one (FAV-001…). Call inside the lock. */
function ensureFavoriteIds_(ss) {
  const sheet = ss.getSheetByName(TAB.FAVORITES);
  if (sheet === null || sheet.getLastRow() < 2) return;
  const map = getHeaderMap_(sheet);
  if (map['name'] === undefined || map['favorite id'] === undefined) return;
  const n = sheet.getLastRow() - 1;
  const names = sheet.getRange(2, map['name'] + 1, n, 1).getValues();
  const idRange = sheet.getRange(2, map['favorite id'] + 1, n, 1);
  const ids = idRange.getValues();
  if (!ids.some(function (r, i) { return String(r[0]).trim() === '' && String(names[i][0]).trim() !== ''; })) return;
  let max = maxFavoriteNumber_(ss);
  ids.forEach(function (r, i) {
    if (String(r[0]).trim() === '' && String(names[i][0]).trim() !== '') r[0] = favIdFor_(++max);
  });
  idRange.setValues(ids);
}

/** What's wrong with a favorite (unknown wallet / category, unreadable schedule). Empty = usable. */
function favProblems_(fav, ctx) {
  const out = [];
  if (['Expense', 'Income', 'Transfer'].indexOf(fav.type) === -1) out.push('Type "' + fav.type + '" must be Expense, Income or Transfer');
  if (fav.type === 'Transfer') {
    if (!findWallet_(cashWallets_(ctx.wallets), fav.wallet)) out.push('wallet "' + (fav.wallet || '(empty)') + '" not found');
    if (!findWallet_(cashWallets_(ctx.wallets), fav.toWallet)) out.push('To Wallet "' + (fav.toWallet || '(empty)') + '" not found');
  } else {
    if (!findWallet_(everydayWallets_(ctx.wallets, ctx.investmentGroups), fav.wallet)) {
      out.push('wallet "' + (fav.wallet || '(empty)') + '" not found');
    }
    if (!ctx.categories.some(function (c) { return c.name === fav.category && c.type === fav.type; })) {
      out.push('category "' + (fav.category || '(empty)') + '" not found for ' + fav.type);
    }
  }
  if (fav.schedule && favDayNumber_(fav) === null) out.push('Day/Date "' + fav.day + '" can\'t be read');
  return out;
}

/**
 * Writes {header: value} into the favorite with this ID (found again by ID,
 * call inside the lock). Columns the sheet doesn't have yet are skipped and
 * returned, so an old sheet still works (run upgradeSheets to add them).
 */
function writeFavorite_(ss, favId, values) {
  const sheet = ss.getSheetByName(TAB.FAVORITES);
  const fav = loadFavorites_(ss).filter(function (f) { return f.id === favId; })[0];
  if (!fav) return null;
  const kept = favKnownColumns_(sheet, values);
  writeRowsByHeaders_(sheet, fav.row, [kept.values]);
  return kept.missing;
}

function favKnownColumns_(sheet, values) {
  const map = getHeaderMap_(sheet);
  const out = { values: {}, missing: [] };
  Object.keys(values).forEach(function (k) {
    if (map[k.toLowerCase()] === undefined) out.missing.push(k);
    else out.values[k] = values[k];
  });
  if (out.missing.length) logError_('Favorites', new Error('Missing columns: ' + out.missing.join(', ')), 'Run upgradeSheets');
  return out;
}

/** Sheet values for a favorite draft. */
function favRowValues_(d) {
  const transfer = d.type === 'Transfer';
  return {
    'Name': d.name,
    'Type': d.type,
    'Value Type': d.valueType,
    'Amount': d.amount || '',
    'Category': transfer ? '' : d.category,
    'Wallet': d.wallet,
    'To Wallet': transfer ? d.toWallet : '',
    'Default Fee': d.fee || '',
    'Schedule': d.schedule || '',
    'Day/Date': d.schedule ? d.day : '',
    'Start Date': d.schedule && d.start ? new Date(d.start) : '',
    'Remind': d.remind || 'All',
    'Keywords': (d.keywords || []).join(', ')
  };
}

/** Called after a favorite was logged (inside the save lock). */
function markFavoriteLogged_(ss, favId, date) {
  try {
    writeFavorite_(ss, favId, { 'Last Logged': midnight_(date) });
  } catch (err) {
    logError_('markFavoriteLogged_', err, favId);
  }
}

// ---------------------------------------------------------------------------
// /fav commands
// ---------------------------------------------------------------------------

function favCtx_() {
  const ctx = loadCtx_();
  withScriptLock_(function () { ensureFavoriteIds_(ctx.ss); });
  ctx.favorites = loadFavorites_(ctx.ss);
  ctx.userNames = (getUsers_() || []).filter(function (u) { return u.active && u.name; }).map(function (u) { return u.name; });
  ctx.now = new Date();
  return ctx;
}

function handleFavCommand_(chatId, args) {
  const firstSpace = args.search(/\s/);
  const sub = (firstSpace === -1 ? args : args.slice(0, firstSpace)).toLowerCase();
  const rest = firstSpace === -1 ? '' : args.slice(firstSpace + 1).trim();
  if (args === '' || sub === 'list') return showFavList_(chatId);
  if (sub === 'add' || sub === 'tambah') return startFavAdd_(chatId, rest);
  if (['edit', 'ubah', 'ganti'].indexOf(sub) !== -1) return startFavEdit_(chatId, rest);
  if (['delete', 'del', 'hapus', 'remove'].indexOf(sub) !== -1) return startFavDelete_(chatId, rest);
  if (['off', 'pause', 'stop', 'nonaktif', 'matikan', 'deactivate'].indexOf(sub) !== -1) return startFavActive_(chatId, rest, false);
  if (['on', 'resume', 'aktif', 'aktifkan', 'nyalakan', 'activate'].indexOf(sub) !== -1) return startFavActive_(chatId, rest, true);
  return startFavByName_(chatId, args);
}

/** "/fav": every favorite, with a button per usable active one. */
function showFavList_(chatId) {
  const ctx = favCtx_();
  const favs = ctx.favorites;
  if (favs.length === 0) {
    sendMessage(chatId, '⭐ No favorites yet. Add one, e.g.\n<code>/fav add Bayar Token Listrik 100k setiap tanggal 1</code>\n' +
      '<code>/fav add Belanja bulanan</code> (amount asked each time)');
    return;
  }
  const today = midnight_(new Date());
  const lines = ['⭐ <b>Favorites</b> — tap one to log it'];
  const usable = [];
  favs.forEach(function (f) {
    const problems = favProblems_(f, ctx);
    const twin = favs.filter(function (g) { return g !== f && favKey_(g.name) === favKey_(f.name); })[0];
    if (twin) problems.push('same name as ' + (twin.id || 'another row') + ' — rename or delete one');
    const amount = f.valueType === 'Variable' ? 'amount asked each time' : formatRp_(f.amount);
    let when = f.schedule ? favScheduleText_(f) : 'no reminder';
    const next = f.schedule ? favNextOccurrence_(f, f.start && f.start > today ? f.start : today) : null;
    if (next) when += ' · next ' + formatDate_(next);
    if (!f.active) {
      lines.push('⏸ ' + escapeHtml_(f.id) + ' ' + escapeHtml_(f.name) + ' <i>(off — /fav on ' + escapeHtml_(f.name) + ')</i>');
    } else if (problems.length) {
      lines.push('⚠️ ' + escapeHtml_(f.id) + ' ' + escapeHtml_(f.name) + ': ' + escapeHtml_(problems.join('; ')) +
        ' <i>— fix it in the Favorites tab</i>');
    } else {
      usable.push(f);
      lines.push('• ' + escapeHtml_(f.id) + ' <b>' + escapeHtml_(f.name) + '</b> · ' + amount + ' · ' + when);
    }
  });
  lines.push('', '<i>/fav add · /fav edit [name] jadi … · /fav off [name] · /fav on [name] · /fav delete [name]</i>');
  if (usable.length === 0) {
    sendMessage(chatId, lines.join('\n'));
    return;
  }
  const p = newPending_(chatId, 'fav', { mode: 'list' });
  p.opts = usable.map(function (f) { return f.id; });
  const rows = chunk_(usable.map(function (f, i) { return btn_(p, '⭐ ' + f.name.slice(0, 28), 'lg', i); }), 2);
  rows.push(cancelRow_(p));
  showStep_(p, lines.join('\n'), rows);
}

/** "/fav listrik": log that favorite. */
function startFavByName_(chatId, name) {
  const ctx = favCtx_();
  const matches = findFavorites_(ctx.favorites.filter(function (f) { return f.active; }), name);
  if (matches.length === 0) {
    sendMessage(chatId, 'No favorite called "' + escapeHtml_(name) + '". Type /fav to see the list.');
    return;
  }
  if (matches.length > 1) return askFavPick_(chatId, matches, { mode: 'log' }, 'Which favorite?');
  startFavLog_(chatId, matches[0], ctx, null, false);
}

function askFavPick_(chatId, matches, d, question) {
  const p = newPending_(chatId, 'fav', Object.assign({ mode: 'pick' }, d));
  p.opts = matches.map(function (f) { return f.id; });
  const rows = chunk_(matches.map(function (f, i) { return btn_(p, f.name.slice(0, 30), 'pk', i); }), 2);
  rows.push(cancelRow_(p));
  showStep_(p, question, rows);
}

/**
 * Starts logging a favorite as a normal transaction (preview with Yes/No/Edit).
 * msgId = a message to reuse (the scheduled prompt). askAmount = ask the amount
 * first (variable amounts, or "Change amount").
 */
function startFavLog_(chatId, fav, ctx, msgId, askAmount) {
  const problems = favProblems_(fav, ctx);
  if (problems.length) {
    const text = '⚠️ <b>' + escapeHtml_(fav.name) + '</b> can\'t be logged: ' + escapeHtml_(problems.join('; ')) +
      '.\nFix it in the Favorites tab (or with /fav edit), then try again.';
    if (msgId) editMessage(chatId, msgId, text);
    else sendMessage(chatId, text);
    return;
  }
  const p = newPending_(chatId, 'trx', favTrxDraft_(fav, ctx));
  p.msgId = msgId || null;
  p.orig = p.d.category;
  if (askAmount || fav.valueType === 'Variable') {
    p.d.amount = null;
    p.awaitText = 'amount';
    const hint = fav.amount > 0 ? ' (usually ' + formatRp_(fav.amount) + ')' : '';
    return showStep_(p, summaryLine_(p) + '\nHow much this time' + hint + '? Send the amount, e.g. <code>350rb</code>.',
      [[btn_(p, '❌ Cancel', 'n')]]);
  }
  advanceTrx_(p, ctx);
}

/** A transaction draft (Confirm.gs) from a favorite. */
function favTrxDraft_(fav, ctx) {
  const transfer = fav.type === 'Transfer';
  const d = {
    type: fav.type, amount: fav.valueType === 'Variable' ? null : fav.amount, date: Date.now(),
    wallet: fav.wallet, walletHow: 'favorite', toWallet: transfer ? fav.toWallet : null,
    category: transfer ? null : fav.category, categoryHow: transfer ? '' : 'favorite',
    note: fav.name, extra: null, feeChecked: true, favId: fav.id, anyWallet: true
  };
  if (fav.type !== 'Income') {
    // The favorite's own fee; a transfer without one gets its source wallet's default fee.
    const src = transfer ? findWallet_(ctx.wallets, fav.wallet) : null;
    const fee = fav.fee > 0 ? fav.fee : (src && src.defaultFee > 0 ? src.defaultFee : 0);
    if (fee > 0) {
      d.extra = newFeeExtra_(fee, ctx);
      d.extra.suggested = true;
      d.extra.fromFav = fav.fee > 0;
    }
  }
  return d;
}

function startFavAdd_(chatId, text) {
  const ctx = favCtx_();
  const r = parseFavAdd_(text, ctx);
  if (!r.ok) {
    sendMessage(chatId, favErrorText_(r));
    return;
  }
  const same = ctx.favorites.filter(function (f) { return favKey_(f.name) === favKey_(r.name); })[0];
  if (same) {
    sendMessage(chatId, '⭐ A favorite called <b>' + escapeHtml_(same.name) + '</b> already exists (' + escapeHtml_(same.id) +
      '). Change it with <code>/fav edit ' + escapeHtml_(same.name) + ' jadi …</code>');
    return;
  }
  const d = Object.assign({ mode: 'add', anyWallet: true }, r, { note: r.name, start: r.start ? r.start.getTime() : null,
    walletHow: r.wallet ? 'mentioned' : '' });
  advanceFav_(newPending_(chatId, 'fav', d), ctx);
}

function startFavEdit_(chatId, args) {
  const ctx = favCtx_();
  const parts = splitFavEdit_(args, ctx.favorites);
  if (parts[0] === '') {
    sendMessage(chatId, favErrorText_({ error: 'fav_edit_usage' }));
    return;
  }
  const matches = findFavorites_(ctx.favorites, parts[0]);
  if (matches.length === 0) {
    sendMessage(chatId, 'No favorite called "' + escapeHtml_(parts[0]) + '". Type /fav to see the list.');
    return;
  }
  if (parts[1] === '') {
    sendMessage(chatId, favErrorText_({ error: 'fav_edit_usage' }));
    return;
  }
  if (matches.length > 1) return askFavPick_(chatId, matches, { mode: 'edit', changeText: parts[1] }, 'Which favorite do you want to change?');
  beginFavEdit_(chatId, matches[0], parts[1], ctx, null);
}

/** The editable fields of a favorite, as a draft. */
function favToDraft_(fav) {
  return { favId: fav.id, name: fav.name, note: fav.name, type: fav.type, valueType: fav.valueType,
    amount: fav.amount || null, category: fav.category || null, categoryHow: fav.category ? 'favorite' : '',
    wallet: fav.wallet || null, walletHow: 'favorite', toWallet: fav.toWallet || null, fee: fav.fee,
    schedule: fav.schedule, day: fav.schedule ? (fav.schedule === 'Weekly' ? WEEKDAY_NAMES[favDayNumber_(fav)] || fav.day : fav.day) : '',
    start: fav.start ? fav.start.getTime() : null, remind: fav.remind, keywords: fav.keywords || [] };
}

function beginFavEdit_(chatId, fav, changeText, ctx, msgId) {
  const r = parseFavEdit_(changeText, fav, ctx);
  if (!r.ok) {
    const text = favErrorText_(r);
    if (msgId) editMessage(chatId, msgId, text);
    else sendMessage(chatId, text);
    clearPending_(chatId);
    return;
  }
  const orig = favToDraft_(fav);
  const d = Object.assign({ mode: 'edit', orig: orig, anyWallet: true }, orig, r.changes);
  if (r.changes.start !== undefined) d.start = r.changes.start ? r.changes.start.getTime() : null;
  if (r.changes.category) d.categoryHow = 'tag';
  if (r.changes.wallet) d.walletHow = 'mentioned';
  if (r.changes.name) d.note = r.changes.name;
  if (r.changes.name && ctx.favorites.some(function (f) { return f.id !== fav.id && favKey_(f.name) === favKey_(r.changes.name); })) {
    sendMessage(chatId, '⭐ Another favorite is already called <b>' + escapeHtml_(r.changes.name) + '</b>. Pick another name.');
    return;
  }
  const p = newPending_(chatId, 'fav', d);
  p.msgId = msgId || null;
  advanceFav_(p, ctx);
}

function startFavDelete_(chatId, name) {
  const ctx = favCtx_();
  if (name === '') {
    sendMessage(chatId, 'Which one? e.g. <code>/fav delete listrik</code>');
    return;
  }
  const matches = findFavorites_(ctx.favorites, name);
  if (matches.length === 0) {
    sendMessage(chatId, 'No favorite called "' + escapeHtml_(name) + '". Type /fav to see the list.');
    return;
  }
  if (matches.length > 1) return askFavPick_(chatId, matches, { mode: 'delete' }, 'Which favorite do you want to delete?');
  confirmFavDelete_(newPending_(chatId, 'fav', { mode: 'delete' }), matches[0]);
}

/** "/fav off listrik" pauses a favorite (Active = No: no prompts, not in the buttons); "/fav on listrik" resumes it. */
function startFavActive_(chatId, name, on) {
  const ctx = favCtx_();
  if (name === '') {
    sendMessage(chatId, 'Which one? e.g. <code>/fav ' + (on ? 'on' : 'off') + ' listrik</code>');
    return;
  }
  // Prefer favorites that would actually change.
  let matches = findFavorites_(ctx.favorites.filter(function (f) { return f.active !== on; }), name);
  if (matches.length === 0) matches = findFavorites_(ctx.favorites, name);
  if (matches.length === 0) {
    sendMessage(chatId, 'No favorite called "' + escapeHtml_(name) + '". Type /fav to see the list.');
    return;
  }
  if (matches.length > 1) {
    return askFavPick_(chatId, matches, { mode: on ? 'on' : 'off' }, 'Which favorite do you want to turn ' + (on ? 'on' : 'off') + '?');
  }
  setFavActive_(chatId, matches[0], on, ctx, null);
}

function setFavActive_(chatId, fav, on, ctx, msgId) {
  let text;
  if (fav.active === on) {
    text = '⭐ <b>' + escapeHtml_(fav.name) + '</b> is already ' + (on ? 'on' : 'off') + '.';
  } else {
    withScriptLock_(function () { writeFavorite_(ctx.ss, fav.id, { 'Active': on ? 'Yes' : 'No' }); });
    if (!on) closeFavPrompts_(fav.id);
    text = on ? '▶️ <b>' + escapeHtml_(fav.name) + '</b> is on again' + (fav.schedule ? ' (' + favScheduleText_(fav) + ')' : '') + '.'
      : '⏸ <b>' + escapeHtml_(fav.name) + '</b> is off: no reminders and not in /fav. Turn it back on with <code>/fav on ' +
        escapeHtml_(fav.name) + '</code>.';
  }
  if (msgId) editMessage(chatId, msgId, text);
  else sendMessage(chatId, text);
}

function confirmFavDelete_(p, fav) {
  p.d = { mode: 'delete', favId: fav.id, name: fav.name };
  showStep_(p, '🗑 Delete favorite <b>' + escapeHtml_(fav.name) + '</b> (' + escapeHtml_(fav.id) + ')?\n' +
    '<i>Entries already logged stay. To pause it instead, set Active = No in the Favorites tab.</i>',
    [[btn_(p, '🗑 Delete', 'y'), btn_(p, '❌ Cancel', 'n')]]);
}

/** Asks for whatever the favorite still needs, then shows the preview. */
function advanceFav_(p, ctx) {
  const d = p.d;
  p.awaitText = null;
  if (d.amountOptions) return askAmount_(p);
  if (d.type === 'Transfer') {
    if (!findWallet_(cashWallets_(ctx.wallets), d.wallet)) return askWallet_(p, ctx, 'from');
    if (!findWallet_(cashWallets_(ctx.wallets), d.toWallet)) return askWallet_(p, ctx, 'to');
    if (d.wallet === d.toWallet) {
      d.toWallet = null;
      return askWallet_(p, ctx, 'to', 'From and To must be different wallets.');
    }
  } else {
    if (!ctx.categories.some(function (c) { return c.name === d.category && c.type === d.type; })) {
      d.category = null;
      return askCategory_(p, ctx);
    }
    const usable = everydayWallets_(ctx.wallets, ctx.investmentGroups);
    if (!findWallet_(usable, d.wallet)) {
      if (d.walletChoices) return askWallet_(p, ctx, 'wallet');
      const cat = ctx.categories.filter(function (c) { return c.name === d.category; })[0];
      const def = cat ? findWallet_(usable, cat.defaultWallet) : null;
      if (!def) return askWallet_(p, ctx, 'wallet');
      d.wallet = def.name;
      d.walletHow = 'default';
    }
  }
  if (d.schedule && !d.start) {
    const next = favNextOccurrence_(d, new Date());
    d.start = next ? next.getTime() : null;
  }
  showStep_(p, buildFavPreview_(d), [[btn_(p, '✅ Save', 'y'), btn_(p, '❌ Cancel', 'n')]]);
}

/** The favorite preview; in edit mode, changed lines say what they were. */
function buildFavPreview_(d) {
  const o = d.orig || null;
  const was = function (now, before) {
    return o && now !== before ? ' <i>(was ' + escapeHtml_(before) + ')</i>' : '';
  };
  const amountText = function (x) {
    return x.valueType === 'Variable'
      ? 'amount asked each time' + (x.amount ? ' (usually ' + formatRp_(x.amount) + ')' : '')
      : formatRp_(x.amount);
  };
  const scheduleText = function (x) {
    return x.schedule ? favScheduleText_(x) + (x.start ? ', from ' + formatDate_(x.start) : '') : 'no schedule (no reminder)';
  };
  const icon = d.type === 'Income' ? '💵' : d.type === 'Transfer' ? '🔁' : '🧾';
  const lines = [o ? '✏️ <b>Edit favorite ' + escapeHtml_(d.favId) + '</b>' : '⭐ <b>New favorite</b>',
    '<b>' + escapeHtml_(d.name) + '</b>' + was(d.name, o && o.name)];
  lines.push(icon + ' ' + d.type + ' · <b>' + amountText(d) + '</b>' + was(amountText(d), o && amountText(o)));
  if (d.type === 'Transfer') {
    const route = function (x) { return x.wallet + ' → ' + x.toWallet; };
    lines.push('👛 ' + escapeHtml_(route(d)) + was(route(d), o && route(o)));
  } else {
    lines.push('📂 ' + escapeHtml_(d.category) + (o ? was(d.category, o.category) : ' <i>(' + (CATEGORY_HOW_LABEL[d.categoryHow] || 'you picked') + ')</i>'));
    lines.push('👛 ' + escapeHtml_(d.wallet) + (d.walletHow === 'default' ? ' <i>(default for ' + escapeHtml_(d.category) + ')</i>' : '') +
      was(d.wallet, o && o.wallet));
  }
  if (d.fee > 0 || (o && o.fee > 0)) {
    lines.push('💸 Default fee ' + (d.fee > 0 ? formatRp_(d.fee) : 'none') + was(formatRp_(d.fee || 0), o && formatRp_(o.fee || 0)));
  }
  lines.push('📅 ' + escapeHtml_(scheduleText(d)) + was(scheduleText(d), o && scheduleText(o)));
  const kws = function (x) { return (x.keywords || []).join(', ') || 'none'; };
  if ((d.keywords || []).length || (o && (o.keywords || []).length)) lines.push('🔑 Keywords: ' + escapeHtml_(kws(d)) + was(kws(d), o && kws(o)));
  if (d.schedule) lines.push('🔔 Remind: ' + escapeHtml_(d.remind || 'All') + was(d.remind || 'All', o && (o.remind || 'All')));
  lines.push('', 'Save?');
  return lines.join('\n');
}

function favCallback_(p, action, arg, user) {
  const d = p.d;
  if (action === 'n') return finishStep_(p, '❌ Cancelled. Nothing was changed.');
  const ctx = favCtx_();
  const byId = function (id) { return ctx.favorites.filter(function (f) { return f.id === id; })[0]; };
  switch (action) {
    case 'lg': { // tapped in the /fav list
      const fav = byId(p.opts[Number(arg)]);
      if (!fav) return finishStep_(p, 'That favorite no longer exists. Type /fav again.');
      return startFavLog_(p.chatId, fav, ctx, p.msgId, false);
    }
    case 'pk': { // picked one of several name matches
      const fav = byId(p.opts[Number(arg)]);
      if (!fav) return finishStep_(p, 'That favorite no longer exists. Type /fav again.');
      if (d.mode === 'log') return startFavLog_(p.chatId, fav, ctx, p.msgId, false);
      if (d.mode === 'edit') return beginFavEdit_(p.chatId, fav, d.changeText, ctx, p.msgId);
      if (d.mode === 'delete') return confirmFavDelete_(p, fav);
      if (d.mode === 'off' || d.mode === 'on') {
        clearPending_(p.chatId);
        return setFavActive_(p.chatId, fav, d.mode === 'on', ctx, p.msgId);
      }
      return;
    }
    case 'am':
      d.amount = d.amountOptions[Number(arg)];
      d.amountOptions = null;
      break;
    case 'w':
      d.wallet = p.opts[Number(arg)];
      d.walletChoices = null;
      d.walletHow = 'chosen';
      break;
    case 'tw':
      d.toWallet = p.opts[Number(arg)];
      d.toWalletChoices = null;
      break;
    case 'c':
      d.category = p.opts[Number(arg)];
      d.categoryHow = 'chosen';
      d.unknownTag = null;
      if (d.walletHow === 'default') { d.wallet = null; d.walletHow = ''; }
      break;
    case 'y':
      return saveFav_(p, ctx);
  }
  advanceFav_(p, ctx);
}

function saveFav_(p, ctx) {
  const d = p.d;
  if (!claimPending_(p)) return;
  let text;
  withScriptLock_(function () {
    const sheet = ctx.ss.getSheetByName(TAB.FAVORITES);
    const current = loadFavorites_(ctx.ss);
    if (d.mode === 'delete') {
      const fav = current.filter(function (f) { return f.id === d.favId; })[0];
      if (!fav) { text = 'That favorite was already removed.'; return; }
      sheet.deleteRow(fav.row);
      text = '🗑 Deleted favorite <b>' + escapeHtml_(fav.name) + '</b>.';
      return;
    }
    const values = favRowValues_(d);
    let missing;
    if (d.mode === 'add') {
      if (current.some(function (f) { return favKey_(f.name) === favKey_(d.name); })) {
        text = '⭐ A favorite called <b>' + escapeHtml_(d.name) + '</b> already exists.';
        return;
      }
      const id = favIdFor_(maxFavoriteNumber_(ctx.ss) + 1);
      const kept = favKnownColumns_(sheet, Object.assign({ 'Favorite ID': id }, values, { 'Active': 'Yes' }));
      writeRowsByHeaders_(sheet, lastDataRow_(sheet, 'Name') + 1, [kept.values]);
      missing = kept.missing;
      text = '⭐ Saved favorite <b>' + escapeHtml_(d.name) + '</b> as ' + id + '. Log it any time with /fav.';
    } else {
      missing = writeFavorite_(ctx.ss, d.favId, values);
      if (missing === null) { text = 'That favorite was removed in the meantime. Nothing was changed.'; return; }
      text = '✅ Updated favorite <b>' + escapeHtml_(d.name) + '</b>.';
    }
    if (d.schedule && d.start) text += '\n📅 First reminder: ' + formatDate_(d.start) + ' (morning).';
    if (missing && missing.length) {
      text += '\n⚠️ The Favorites tab has no ' + escapeHtml_(missing.join(', ')) + ' column yet, so that part wasn\'t saved. ' +
        'Run <b>upgradeSheets</b> in the Apps Script editor.';
    }
  });
  if (p.msgId) editMessage(p.chatId, p.msgId, text);
  else sendMessage(p.chatId, text);
}

function favErrorText_(r) {
  switch (r.error) {
    case 'fav_usage':
      return 'Tell me the favorite, e.g.\n• <code>/fav add Bayar Token Listrik 100k setiap tanggal 1 BCA</code>\n' +
        '• <code>/fav add Kos 2jt tiap tanggal 5</code>\n• <code>/fav add Belanja bulanan</code> (amount asked each time)\n' +
        '• <code>/fav add Top up GoPay 100k dari BCA admin 1rb setiap senin</code>';
    case 'fav_edit_usage':
      return 'Write the name, then <b>jadi</b> and what to change, e.g.\n• <code>/fav edit listrik jadi 150rb</code>\n' +
        '• <code>/fav edit belanja bulanan jadi setiap tanggal 2</code>\n• <code>/fav edit kos jadi tanpa jadwal</code>\n' +
        '• <code>/fav edit listrik jadi Token PLN</code> (new name)\n' +
        '• <code>/fav edit cicilan mobil jadi keyword bayar mobil, cicilan mobil</code>\n' +
        '• <code>/fav edit listrik jadi GoPay #utilities admin 2.5rb variable</code>';
    case 'fav_edit_unclear':
      return "I couldn't see what to change. " + favErrorText_({ error: 'fav_edit_usage' });
    case 'fav_edit_leftover':
      return "I didn't understand \"" + escapeHtml_(r.words.join(' ')) + '". ' + favErrorText_({ error: 'fav_edit_usage' });
    case 'fav_bad_day':
      return 'The day of the month must be between 1 and 31.';
    case 'fav_date':
      return 'A favorite has no fixed date. For a monthly reminder write e.g. <code>setiap tanggal 1</code>, ' +
        'for a weekly one <code>setiap senin</code>.';
    case 'fav_extra':
      return 'A favorite can carry a default fee (<code>admin 1rb</code>), but not a received or spent part.';
    case 'fav_fee_unclear':
      return "I couldn't read the fee. Write it like <code>admin 2.5rb</code>.";
    case 'fav_no_name':
      return 'Give the favorite a name, e.g. <code>/fav add Bayar Token Listrik 100k</code>.';
    case 'fav_remind_unknown':
      return '"' + escapeHtml_(r.word) + '" is not a bot user yet. Use one of: ' + escapeHtml_((r.names || []).concat('All').join(', ')) + '.\n' +
        '<i>A person becomes a user once their Chat ID is in Settings → Users (Active = Yes).</i>';
    case 'fav_unknown_tag':
      return "I don't know the category #" + escapeHtml_(r.tag) + '. Type /cat to see them.';
    case 'fav_transfer_category':
      return 'A transfer favorite has no category.';
    case 'fav_wallet_ambiguous':
      return '"' + escapeHtml_(r.wallet) + '" fits several wallets. Write the full wallet name.';
    case 'fav_amount_unclear':
      return 'The amount "' + escapeHtml_(r.text) + '" is unclear. Write it like <code>150rb</code> or <code>1.5jt</code>.';
    default:
      return parseErrorText_(r);
  }
}

// ---------------------------------------------------------------------------
// Scheduled prompts (sent by the morning reminder slot, Reminders.gs)
// ---------------------------------------------------------------------------
// FAV_PROMPTS (Script Property) = { "<favId>|<chatId>": <message_id> }: the latest
// prompt per favorite and chat, so the next one (or an answer) removes old buttons.

function readFavPrompts_() {
  try {
    return JSON.parse(getProp_(PROP.FAV_PROMPTS) || '{}');
  } catch (err) {
    return {};
  }
}

function writeFavPrompts_(state) {
  PropertiesService.getScriptProperties().setProperty(PROP.FAV_PROMPTS, JSON.stringify(state));
}

/** Removes the buttons of every other open prompt for this favorite (after it was logged or skipped). */
function closeFavPrompts_(favId, keepChatId, keepMsgId) {
  try {
    const state = readFavPrompts_();
    Object.keys(state).forEach(function (key) {
      if (key.split('|')[0] !== favId) return;
      const chatId = key.split('|')[1];
      if (!(chatId === String(keepChatId) && state[key] === keepMsgId)) dropButtons_(chatId, state[key]);
      delete state[key];
    });
    writeFavPrompts_(state);
  } catch (err) {
    logError_('closeFavPrompts_', err, favId);
  }
}

/** Chat IDs a favorite reminds: "All" / blank = every active user, else the named users. */
function favRecipients_(fav, users) {
  const active = users.filter(function (u) { return u.active; });
  const names = String(fav.remind || '').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(String);
  const picked = names.length === 0 || names.indexOf('all') !== -1 ? active
    : active.filter(function (u) { return names.indexOf(String(u.name).toLowerCase()) !== -1; });
  return uniqueChatIds_(picked.length ? picked : active);
}

/** Chat IDs of these users, each once (two Users rows with the same Chat ID = one chat). */
function uniqueChatIds_(users) {
  const out = [];
  users.forEach(function (u) { if (out.indexOf(String(u.chatId)) === -1) out.push(String(u.chatId)); });
  return out;
}

/** yyyymmdd ↔ Date (for button data). */
function ymd_(date) {
  const d = new Date(date);
  return String(d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate());
}

function fromYmd_(s) {
  const n = Number(s);
  return new Date(Math.floor(n / 10000), Math.floor(n / 100) % 100 - 1, n % 100);
}

/** Prompt text (plain amounts, like a preview). */
function buildFavPromptText_(fav, occ, today) {
  const days = Math.round((midnight_(today) - midnight_(occ)) / 86400000);
  const due = days <= 0 ? 'is due today' : 'was due ' + formatDate_(occ) + ' (' + days + ' day' + (days === 1 ? '' : 's') + ' ago)';
  const amount = fav.valueType === 'Variable'
    ? 'amount changes' + (fav.amount > 0 ? ' (usually ' + formatRp_(fav.amount) + ')' : '')
    : '<b>' + formatRp_(fav.amount) + '</b>';
  const icon = fav.type === 'Income' ? '💵' : fav.type === 'Transfer' ? '🔁' : '🧾';
  const where = fav.type === 'Transfer' ? escapeHtml_(fav.wallet) + ' → ' + escapeHtml_(fav.toWallet)
    : escapeHtml_(fav.category) + ' · ' + (fav.type === 'Income' ? 'into ' : 'from ') + escapeHtml_(fav.wallet);
  const fee = fav.fee > 0 && fav.type !== 'Income' ? ' (+ fee ' + formatRp_(fav.fee) + ')' : '';
  return '📌 <b>' + escapeHtml_(fav.name) + '</b> ' + due + '.\n' + icon + ' ' + fav.type + ' ' + amount + fee + ' · ' + where +
    '\n' + (fav.valueType === 'Variable' ? 'How much was it?' : 'Log it now?');
}

function favPromptButtons_(fav, occ) {
  const tail = '|' + fav.id + '|' + ymd_(occ);
  const rows = fav.valueType === 'Variable'
    ? [[['✏️ Enter amount', 'F|c' + tail], ['⏭ Skip', 'F|s' + tail]]]
    : [[['✅ Yes', 'F|y' + tail], ['✏️ Change amount', 'F|c' + tail], ['⏭ Skip', 'F|s' + tail]]];
  return keyboard_(rows);
}

/**
 * Morning slot: the due, unanswered, active favorites per chat
 * ({ chatId: [{ fav, occ }] }), by their Remind users. Reminders.gs puts them
 * in the one morning message. A favorite stays due each morning until it's
 * logged, skipped, or the next due date arrives. A scheduled row without a
 * Start Date (typed in the sheet) starts at its next due date.
 */
function dueFavoritesByChat_(now) {
  const ctx = loadCtx_();
  const ss = ctx.ss;
  withScriptLock_(function () { ensureFavoriteIds_(ss); });
  const today = midnight_(now);
  const users = getUsers_() || [];
  const out = {};
  loadFavorites_(ss).forEach(function (fav) {
    if (!fav.active || !fav.schedule || !fav.id) return;
    if (!fav.start && favDayNumber_(fav) !== null) {
      fav.start = favNextOccurrence_(fav, today);
      withScriptLock_(function () { writeFavorite_(ss, fav.id, { 'Start Date': fav.start }); });
    }
    const occ = favDueOccurrence_(fav, today);
    if (!occ || favAnswered_(fav, occ)) return;
    const problems = favProblems_(fav, ctx);
    if (problems.length) {
      logError_('dueFavoritesByChat_', new Error(fav.id + ' ' + fav.name + ': ' + problems.join('; ')), 'Not reminded');
      return;
    }
    favRecipients_(fav, users).forEach(function (chatId) {
      (out[chatId] = out[chatId] || []).push({ fav: fav, occ: occ });
    });
  });
  return out;
}

/** Several due favorites in one list (no buttons): log them with /fav or by typing the name. */
function buildFavListText_(items, today) {
  const lines = ['📌 <b>Favorites due</b>'];
  items.forEach(function (it) {
    const f = it.fav;
    const days = Math.round((midnight_(today) - midnight_(it.occ)) / 86400000);
    const amount = f.valueType === 'Variable' ? 'amount changes' : formatRp_(f.amount);
    lines.push('• <b>' + escapeHtml_(f.name) + '</b> · ' + amount + ' · ' +
      (days <= 0 ? 'due today' : 'was due ' + formatDate_(it.occ)));
  });
  lines.push('<i>Log one with /fav, or type its name (e.g. <code>' + escapeHtml_(items[0].fav.name) + '</code>).</i>');
  return lines.join('\n');
}

/** A tap on [Yes] / [Change amount] / [Enter amount] / [Skip] of a scheduled prompt. */
function favPromptCallback_(cq, parts) {
  const chatId = String(cq.message.chat.id);
  const msgId = cq.message.message_id;
  const action = parts[1];
  const favId = parts[2];
  const occ = fromYmd_(parts[3]);
  const ctx = loadCtx_();
  const fav = loadFavorites_(ctx.ss).filter(function (f) { return f.id === favId; })[0];
  if (!fav || !fav.active) {
    answerCallbackQuery(cq.id, 'This favorite was removed or paused.');
    dropButtons_(chatId, msgId);
    return;
  }
  if (favAnswered_(fav, occ)) {
    answerCallbackQuery(cq.id, 'Already logged or skipped ✅');
    dropButtons_(chatId, msgId);
    return;
  }
  // Two quick taps (or both of you at once) act only once.
  const claimed = withScriptLock_(function () {
    const cache = CacheService.getScriptCache();
    const key = 'favtap_' + favId + '_' + parts[3];
    if (cache.get(key) !== null) return false;
    cache.put(key, '1', 30);
    return true;
  });
  if (!claimed) {
    answerCallbackQuery(cq.id, 'Already on it…');
    return;
  }
  answerCallbackQuery(cq.id);

  if (action === 's') {
    withScriptLock_(function () { writeFavorite_(ctx.ss, favId, { 'Last Skipped': occ }); });
    editMessage(chatId, msgId, '⏭ Skipped <b>' + escapeHtml_(fav.name) + '</b> for ' + formatDate_(occ) + '.');
    closeFavPrompts_(favId, chatId, msgId);
    return;
  }
  if (action === 'c' || fav.valueType === 'Variable') return startFavLog_(chatId, fav, ctx, msgId, true);

  // [Yes]: the tap is the confirmation — save right away unless something needs a look.
  const problems = favProblems_(fav, ctx);
  if (problems.length) return startFavLog_(chatId, fav, ctx, msgId, false);
  const p = newPending_(chatId, 'trx', favTrxDraft_(fav, ctx));
  p.msgId = msgId;
  p.orig = p.d.category;
  if (!isMonthClosed_(ctx.ss, p.d.date) && previewChecks_(p, ctx, entriesOf_(p.d)).length === 0) {
    savePending_(p);
    return saveTrx_(p, ctx, getUserByChatId_(chatId));
  }
  advanceTrx_(p, ctx); // warnings (negative balance, duplicate, large amount): normal preview
}
