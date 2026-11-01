/**
 * Parser.gs — turns a chat message into a transaction draft.
 *
 * Pure logic: no sheet or Telegram calls. Wallets and categories are passed
 * in (ctx), so the same code is tested by testParser() with fixed data.
 *
 *   parseTransaction_('50rb makan siang di KFC BCA', ctx) →
 *     { ok: true, type: 'Expense', amount: 50000, wallet: 'BCA',
 *       note: 'makan siang di KFC', date: Date, category: 'Food',
 *       categoryHow: 'keyword', ... }
 *
 * ctx = { wallets: [{name, type, group, active}], categories: [{name, type, keywords}],
 *         investmentGroups: ['investment'], now: Date }
 *
 * The word lists below are the bot's own vocabulary (how people phrase a
 * message), not user data, so they live in code.
 */

const AMOUNT_UNITS = { k: 1000, rb: 1000, ribu: 1000, jt: 1000000, juta: 1000000 };

const MONTH_WORDS = {
  jan: 0, januari: 0, january: 0,
  feb: 1, februari: 1, february: 1,
  mar: 2, maret: 2, march: 2,
  apr: 3, april: 3,
  mei: 4, may: 4,
  jun: 5, juni: 5, june: 5,
  jul: 6, juli: 6, july: 6,
  agu: 7, agt: 7, agus: 7, agustus: 7, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  okt: 9, oct: 9, oktober: 9, october: 9,
  nov: 10, nopember: 10, november: 10,
  des: 11, dec: 11, desember: 11, december: 11
};

const TRANSFER_WORDS = ['transfer', 'tf', 'trf', 'pindah', 'pindahkan', 'topup', 'top-up'];
const INCOME_WORDS = ['terima', 'diterima', 'masuk', 'pemasukan', 'income', 'received'];
// Words that attach an extra amount to a transfer (SPEC Section 6):
//   fee:      "admin 2.5rb", "dipotong admin 15k", "biaya transfer 6.5rb", "2.5rb admin"
//   received: "sampai 997.500", "diterima 997.500"
//   partial:  "200rb untuk makan", "20k buat beli barang", "200rb dipakai bayar makan"
const FEE_WORDS = ['admin', 'adm', 'fee', 'biaya', 'dipotong', 'potong', 'potongan'];
const RECEIVED_WORDS = ['sampai', 'sampe', 'nyampe', 'diterima', 'received'];
const PARTIAL_WORDS = ['untuk', 'utk', 'buat', 'dipakai', 'dipake', 'for'];
// SPEC Section 6: the default category for transfer fees.
const DEFAULT_FEE_CATEGORY = 'Admin & Bank Fees';
// Small words that link a wallet to the sentence ("pakai BCA", "ke GoPay").
const WALLET_CONNECTORS = ['dari', 'ke', 'pakai', 'pake', 'via', 'lewat', 'from', 'to', 'using', 'dengan', 'dgn', '->', '→'];
const DEST_CONNECTORS = ['ke', 'to', '->', '→'];
const SOURCE_CONNECTORS = ['dari', 'from'];
const DATE_FILLERS = ['tgl', 'tanggal', 'on'];
const YESTERDAY_WORDS = ['kemarin', 'kmarin', 'kmrn', 'kmrin', 'kemaren', 'kmren', 'yesterday'];

/** Lowercase, without surrounding punctuation. */
function cleanToken_(raw) {
  return raw.toLowerCase().replace(/^[("'“]+/, '').replace(/[)"'”,;:!?]+$/, '').replace(/\.+$/, '');
}

/**
 * Reads one amount token such as "50rb", "1.5jt", "50.000", "Rp25.000".
 * Returns null if it isn't a number, otherwise
 *   { value, strong, ambiguous: null | { reason, options: [values] } }
 * strong = clearly an amount (has a unit, "Rp", separators, or ≥ 1000).
 */
function parseAmountToken_(token) {
  let s = String(token).toLowerCase().replace(/\s+/g, '');
  let hadRp = false;
  if (/^rp\.?/.test(s)) { s = s.replace(/^rp\.?/, ''); hadRp = true; }
  const m = s.match(/^(\d+(?:[.,]\d+)*)(k|rb|ribu|jt|juta)?$/);
  if (!m) return null;
  const num = m[1];
  const unit = m[2];
  const groups = num.split(/[.,]/);
  const seps = num.replace(/\d/g, '');
  const oneKindOfSep = seps === '' || /^\.+$/.test(seps) || /^,+$/.test(seps);
  const digitsOnly = Number(groups.join(''));
  const ok = function (value, strong) { return { value: value, strong: strong, ambiguous: null }; };
  const unclear = function (reason, options) {
    const opts = options.filter(function (v, i, a) { return v > 0 && Number.isInteger(v) && a.indexOf(v) === i; });
    return { value: opts[0] || 0, strong: true, ambiguous: { reason: reason, options: opts } };
  };

  if (!unit) {
    if (seps === '') {
      const v = Number(num);
      if (v === 0) return null;
      if (v >= 1000 || hadRp) return ok(v, true);
      return { value: v, strong: false, ambiguous: { reason: 'small', options: [v * 1000, v] } };
    }
    const grouped = oneKindOfSep && groups[0].length >= 1 && groups[0].length <= 3 &&
      groups.slice(1).every(function (g) { return g.length === 3; });
    if (grouped) return ok(digitsOnly, true);
    if (groups.length === 2 && oneKindOfSep) {
      // "1.5" or "1,5": a decimal without a unit — rb or jt?
      const f = Number(groups[0] + '.' + groups[1]);
      return unclear('no_unit', [Math.round(f * 1000), Math.round(f * 1000000)]);
    }
    return unclear('format', [digitsOnly]);
  }

  const mult = AMOUNT_UNITS[unit];
  if (seps === '') return ok(Number(num) * mult, true);
  if (groups.length === 2 && oneKindOfSep) {
    const intPart = groups[0];
    const frac = groups[1];
    if (frac.length === 3) {
      if (mult === 1000) return ok(Number(intPart + frac) * mult, true);          // "1.500rb" = 1.500.000
      return unclear('format', [Number(intPart + '.' + frac) * mult, Number(intPart + frac) * mult]); // "1.250jt"
    }
    const value = Math.round(Number(intPart + '.' + frac) * mult);
    if (Math.abs(Number(intPart + '.' + frac) * mult - value) > 1e-6) return unclear('format', [value]);
    if (mult === 1000 && Number(intPart) >= 10) return unclear('decimal', [value]);  // "50.5rb"
    return ok(value, true);
  }
  const grouped = oneKindOfSep && groups.slice(1).every(function (g) { return g.length === 3; });
  return grouped ? ok(digitsOnly * mult, true) : unclear('format', [digitsOnly * mult]);
}

/** Builds a Date (script time zone) on the given day, keeping now's clock time. */
function dayWithTime_(y, m, d, now) {
  return new Date(y, m, d, now.getHours(), now.getMinutes(), now.getSeconds());
}

/** The most recent date with this day of the month, today or earlier ("tgl 31" on 25 Sep → 31 Aug). */
function nearestPastDay_(day, now) {
  for (let back = 0; back < 12; back++) {
    const month = new Date(now.getFullYear(), now.getMonth() - back, 1); // handles Jan → Dec of last year
    const date = makeDate_(month.getFullYear(), month.getMonth(), day, now);
    if (date && date.getTime() <= now.getTime() + 60000) return date;
  }
  return null;
}

/** Validates a day/month/year and returns a Date, or null if it doesn't exist. */
function makeDate_(y, m, d, now) {
  const date = dayWithTime_(y, m, d, now);
  return date.getFullYear() === y && date.getMonth() === m && date.getDate() === d ? date : null;
}

/**
 * Finds a date in tokens (marks them used). Returns
 *   { date } | { error: 'invalid_date' | 'multiple_dates', text } | {} (none).
 */
function extractDate_(tokens, now) {
  const found = [];
  const mark = function (from, count) {
    for (let k = from; k < from + count; k++) tokens[k].used = true;
    if (from > 0 && !tokens[from - 1].used && DATE_FILLERS.indexOf(tokens[from - 1].clean) !== -1) {
      tokens[from - 1].used = true;
    }
  };
  const resolve = function (d, m, y, text) {
    let year = y;
    if (year === null) {
      year = now.getFullYear();
      const candidate = makeDate_(year, m, d, now);
      if (candidate && candidate.getTime() > now.getTime() + 60000) year -= 1;
    } else if (year < 100) {
      year += 2000;
    }
    const date = makeDate_(year, m, d, now);
    found.push(date ? { date: date } : { error: 'invalid_date', text: text });
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.used) continue;
    const next = tokens[i + 1] ? tokens[i + 1].clean : '';
    const next2 = tokens[i + 2] ? tokens[i + 2].clean : '';
    const next3 = tokens[i + 3] ? tokens[i + 3].clean : '';

    if (YESTERDAY_WORDS.indexOf(t.clean) !== -1) {
      mark(i, 1);
      found.push({ date: dayWithTime_(now.getFullYear(), now.getMonth(), now.getDate() - 1, now) });
    } else if ((t.clean === 'tgl' || t.clean === 'tanggal') && /^\d{1,2}$/.test(next) &&
        MONTH_WORDS[next2] === undefined && Number(next) >= 1 && Number(next) <= 31) {
      // "tgl 10" without a month: the nearest 10th that is not in the future (confirmed by the user).
      mark(i, 2);
      found.push({ date: nearestPastDay_(Number(next), now), needsConfirm: true, text: t.raw + ' ' + tokens[i + 1].raw });
    } else if (t.clean === 'today' || (t.clean === 'hari' && next === 'ini')) {
      mark(i, t.clean === 'today' ? 1 : 2);
      found.push({ date: new Date(now.getTime()) });
    } else if (/^\d{1,2}$/.test(t.clean) && next === 'hari' && (next2 === 'lalu' || (next2 === 'yang' && next3 === 'lalu'))) {
      mark(i, next2 === 'lalu' ? 3 : 4);
      found.push({ date: dayWithTime_(now.getFullYear(), now.getMonth(), now.getDate() - Number(t.clean), now) });
    } else if (/^\d{1,2}$/.test(t.clean) && (next === 'days' || next === 'day') && next2 === 'ago') {
      mark(i, 3);
      found.push({ date: dayWithTime_(now.getFullYear(), now.getMonth(), now.getDate() - Number(t.clean), now) });
    } else {
      const dm = t.clean.match(/^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2}|\d{4}))?$/);
      if (dm) {
        mark(i, 1);
        resolve(Number(dm[1]), Number(dm[2]) - 1, dm[3] ? Number(dm[3]) : null, t.raw);
      } else if (/^\d{1,2}$/.test(t.clean) && MONTH_WORDS[next] !== undefined) {
        const hasYear = /^(19|20)\d{2}$/.test(next2);
        mark(i, hasYear ? 3 : 2);
        resolve(Number(t.clean), MONTH_WORDS[next], hasYear ? Number(next2) : null,
          t.raw + ' ' + tokens[i + 1].raw + (hasYear ? ' ' + tokens[i + 2].raw : ''));
      }
    }
  }
  if (found.length > 1) return { error: 'multiple_dates' };
  return found[0] || {};
}

/**
 * Finds wallet names in tokens (whole words, case-insensitive, multi-word
 * names supported). Marks them used, plus a connector word right before
 * ("pakai BCA", "ke GoPay"). Returns [{ wallet, index, connector }].
 */
function extractWallets_(tokens, wallets) {
  // Each wallet can be written as its full name ("IPOT (Saham)" or "ipot saham") or just the
  // part before the brackets ("IPOT"). A short name shared by several wallets
  // ("Ajaib Kripto" → Ajaib Kripto (Kripto), Ajaib Kripto (Saham US)) matches all of them,
  // and the user picks one; an exact full name always wins over a short one.
  const words = function (s) { return s.toLowerCase().replace(/[()]/g, ' ').trim().split(/\s+/).filter(String); };
  const phrases = {};
  const add = function (w, list, exact) {
    const key = list.join(' ');
    if (key === '') return;
    phrases[key] = phrases[key] || { words: list, exact: [], short: [] };
    phrases[key][exact ? 'exact' : 'short'].push(w);
  };
  wallets.filter(function (w) { return w.active !== false; }).forEach(function (w) {
    add(w, words(w.name), true);
    const base = w.name.replace(/\s*\([^)]*\)\s*$/, '');
    if (base !== w.name) add(w, words(base), false);
  });
  const entries = Object.keys(phrases).map(function (k) {
    const p = phrases[k];
    return { words: p.words, wallets: p.exact.length ? p.exact : p.short };
  }).sort(function (a, b) { return b.words.length - a.words.length || b.words.join(' ').length - a.words.join(' ').length; });

  const found = [];
  entries.forEach(function (entry) {
    for (let i = 0; i + entry.words.length <= tokens.length; i++) {
      let match = true;
      for (let k = 0; k < entry.words.length; k++) {
        const t = tokens[i + k];
        if (t.used || t.clean !== entry.words[k]) { match = false; break; }
      }
      if (!match) continue;
      const text = tokens.slice(i, i + entry.words.length).map(function (t) { return t.raw; }).join(' ');
      for (let k = 0; k < entry.words.length; k++) tokens[i + k].used = true;
      let connector = '';
      if (i > 0 && !tokens[i - 1].used && WALLET_CONNECTORS.indexOf(tokens[i - 1].clean) !== -1) {
        connector = tokens[i - 1].clean;
        tokens[i - 1].used = true;
      }
      found.push({ wallets: entry.wallets.slice(), index: i, connector: connector, text: text });
    }
  });
  found.sort(function (a, b) { return a.index - b.index; });
  return found;
}

/** Wallet name for a mention: the wallet if there's one, otherwise what was typed. */
function mentionLabel_(m) {
  return m.wallets.length === 1 ? m.wallets[0].name : m.text;
}

function mentionKey_(m) {
  return m.wallets.map(function (w) { return w.name; }).sort().join('|');
}

/** Finds amounts in the unused tokens ("Rp 50.000" and "50 rb" are joined). */
function extractAmounts_(tokens) {
  const amounts = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.used) continue;
    let text = t.clean.replace(/^[+-]/, '');
    const used = [i];
    if ((text === 'rp' || text === 'rp.') && tokens[i + 1] && !tokens[i + 1].used) {
      text = 'rp' + tokens[i + 1].clean;
      used.push(i + 1);
    }
    const nextIdx = used[used.length - 1] + 1;
    if (tokens[nextIdx] && !tokens[nextIdx].used && AMOUNT_UNITS[tokens[nextIdx].clean] !== undefined &&
        /\d$/.test(text)) {
      text += tokens[nextIdx].clean;
      used.push(nextIdx);
    }
    const parsed = parseAmountToken_(text);
    if (parsed === null) continue;
    parsed.tokens = used;
    parsed.text = used.map(function (k) { return tokens[k].raw; }).join(' ');
    amounts.push(parsed);
    i = used[used.length - 1];
  }
  return amounts;
}

/**
 * Parses one transaction message. Returns { ok: true, ... } or
 * { ok: false, error, ...details }. Errors: no_amount, multiple_amounts,
 * invalid_date, multiple_dates, two_wallets, too_many_wallets,
 * investment_wallet, same_wallet, transfer_extras.
 */
function parseTransaction_(text, ctx) {
  const now = ctx.now || new Date();
  const tokens = String(text).trim().split(/\s+/).filter(String).map(function (raw) {
    return { raw: raw, clean: cleanToken_(raw), used: false };
  });

  let sign = '';
  if (tokens.length && /^[+-]\d/.test(tokens[0].clean)) sign = tokens[0].clean.charAt(0);

  const dateResult = extractDate_(tokens, now);
  if (dateResult.error) return { ok: false, error: dateResult.error, text: dateResult.text };

  // #category
  let tag = null;
  tokens.forEach(function (t) {
    if (!t.used && /^#\S+/.test(t.clean)) { tag = t.clean.slice(1); t.used = true; }
  });

  const allMentions = extractWallets_(tokens, ctx.wallets);
  // The same wallet written twice counts once, except "BCA ke BCA" (checked below).
  let mentions = allMentions.filter(function (f, i) {
    return allMentions.findIndex(function (g) { return mentionKey_(g) === mentionKey_(f); }) === i;
  });
  const repeatedWallet = allMentions.length > mentions.length;

  // Transfer words ("transfer", "tf", "top up")
  let transferWord = false;
  let topUp = false;
  tokens.forEach(function (t, i) {
    if (t.used) return;
    if (TRANSFER_WORDS.indexOf(t.clean) !== -1) {
      t.used = true;
      transferWord = true;
      if (t.clean === 'topup' || t.clean === 'top-up') topUp = true;
    } else if (t.clean === 'top' && tokens[i + 1] && tokens[i + 1].clean === 'up') {
      t.used = true;
      tokens[i + 1].used = true;
      transferWord = true;
      topUp = true;
    }
  });
  const hasDestConnector = allMentions.some(function (m) { return DEST_CONNECTORS.indexOf(m.connector) !== -1; });
  const isTransfer = transferWord || (allMentions.length >= 2 && hasDestConnector);
  if (isTransfer && repeatedWallet && mentions.length === 1 && mentions[0].wallets.length === 1) {
    return { ok: false, error: 'same_wallet', wallet: mentionLabel_(mentions[0]) };
  }

  // Investment wallets: never for expenses/income. Transfers may use investment-group cash
  // wallets (e.g. BCA ke IPOT) but not Wallet Type = Investment (purchases come later).
  // A name matching several wallets keeps only the allowed ones; none left = blocked.
  const allowed = function (w) {
    return isTransfer ? w.type !== 'Investment' : !isInvestmentWallet_(w, ctx.investmentGroups);
  };
  for (let k = 0; k < mentions.length; k++) {
    const kept = mentions[k].wallets.filter(allowed);
    if (kept.length === 0) return { ok: false, error: 'investment_wallet', wallet: mentionLabel_(mentions[k]) };
    mentions[k] = Object.assign({}, mentions[k], { wallets: kept });
  }

  let amounts = extractAmounts_(tokens);

  // Transfers may carry ONE extra amount: a fee, a received amount, or a partial expense.
  let extra = null;
  if (isTransfer) {
    const found = extractTransferExtra_(tokens, amounts, ctx, tag);
    if (found.error) return { ok: false, error: found.error };
    extra = found.extra;
    amounts = amounts.filter(function (a) { return !a.tokens.some(function (k) { return tokens[k].used; }); });
  }

  // A mention is either one wallet (a name) or several to pick from (a list of names).
  const pick = function (m) { return m.wallets.length === 1 ? m.wallets[0].name : null; };
  const choices = function (m) { return m.wallets.length > 1 ? m.wallets.map(function (w) { return w.name; }) : null; };
  let from = null;
  let to = null;
  if (isTransfer) {
    if (mentions.length > 2) {
      return { ok: false, error: 'too_many_wallets', wallets: mentions.map(mentionLabel_) };
    }
    const dest = mentions.filter(function (m) { return DEST_CONNECTORS.indexOf(m.connector) !== -1; })[0];
    const src = mentions.filter(function (m) { return SOURCE_CONNECTORS.indexOf(m.connector) !== -1; })[0];
    if (mentions.length === 2) {
      to = dest || (src ? mentions.filter(function (m) { return m !== src; })[0] : mentions[1]);
      from = mentions.filter(function (m) { return m !== to; })[0];
    } else if (mentions.length === 1) {
      if (dest === mentions[0] || (!src && topUp)) to = mentions[0];
      else from = mentions[0];
    }
    if (from && to && pick(from) !== null && pick(from) === pick(to)) {
      return { ok: false, error: 'same_wallet', wallet: pick(from) };
    }
  } else {
    if (mentions.length > 1) {
      return { ok: false, error: 'two_wallets', wallets: mentions.map(mentionLabel_) };
    }
    from = mentions[0] || null;
  }
  const wallet = from ? pick(from) : null;
  const walletChoices = from ? choices(from) : null;
  const toWallet = to ? pick(to) : null;
  const toWalletChoices = to ? choices(to) : null;

  // Amount: exactly one clear amount wins; small bare numbers ("2 porsi") stay in the note.
  const strong = amounts.filter(function (a) { return a.strong; });
  const weak = amounts.filter(function (a) { return !a.strong; });
  let amount;
  if (strong.length > 1) {
    return { ok: false, error: 'multiple_amounts', amounts: strong.map(function (a) { return a.text; }) };
  } else if (strong.length === 1) {
    amount = strong[0];
  } else if (weak.length === 1) {
    amount = weak[0];
  } else if (weak.length > 1) {
    return { ok: false, error: 'multiple_amounts', amounts: weak.map(function (a) { return a.text; }) };
  } else {
    return { ok: false, error: 'no_amount' };
  }
  amount.tokens.forEach(function (k) { tokens[k].used = true; });

  const incomeWord = tokens.some(function (t) { return !t.used && INCOME_WORDS.indexOf(t.clean) !== -1; });
  const note = tokens.filter(function (t) { return !t.used; })
    .map(function (t) { return t.raw; }).join(' ')
    .replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '');

  // Type and category: explicit #tag → keyword → (AI / buttons later).
  let type = isTransfer ? 'Transfer' : (sign === '+' || incomeWord ? 'Income' : (sign === '-' ? 'Expense' : ''));
  let category = null;
  let categoryHow = '';
  let unknownTag = null;
  if (!isTransfer) {
    const allowed = type === '' ? ['Expense', 'Income'] : [type];
    if (tag !== null) {
      const c = findCategoryByTag_(tag, ctx.categories, allowed);
      if (c) { category = c.name; categoryHow = 'tag'; type = type || c.type; }
      else unknownTag = tag;
    }
    if (category === null) {
      const k = matchKeyword_(note, ctx.categories, allowed);
      if (k) { category = k.category; categoryHow = 'keyword'; type = type || k.type; }
    }
    type = type || 'Expense';
  }

  return {
    ok: true,
    type: type,
    amount: amount.ambiguous ? null : amount.value,
    amountOptions: amount.ambiguous ? amount.ambiguous.options : null,
    amountReason: amount.ambiguous ? amount.ambiguous.reason : null,
    amountText: amount.text,
    date: dateResult.date || new Date(now.getTime()),
    dateGiven: !!dateResult.date,
    dateNeedsConfirm: !!dateResult.needsConfirm,
    dateText: dateResult.text || '',
    wallet: wallet,
    walletChoices: walletChoices,
    toWallet: toWallet,
    toWalletChoices: toWalletChoices,
    category: category,
    categoryHow: categoryHow,
    unknownTag: unknownTag,
    note: note,
    extra: extra
  };
}

/**
 * Finds the one extra amount of a transfer and marks its words used.
 * Returns { extra: null | { kind, amount, note, category, categoryHow } } or
 * { error: 'transfer_two_extras' | 'extra_unclear' }.
 *   kind 'fee'      — "admin 2.5rb" / "dipotong admin 15k" (same meaning: paid on top by the source)
 *   kind 'received' — "sampai 997.500" (the bot asks what the difference was)
 *   kind 'partial'  — "200rb untuk makan" (the bot asks: spent from source or destination?)
 */
function extractTransferExtra_(tokens, amounts, ctx, tag) {
  const isWord = function (k, list) { return tokens[k] && !tokens[k].used && list.indexOf(tokens[k].clean) !== -1; };
  const isTransferWord = function (k) { return tokens[k] && TRANSFER_WORDS.indexOf(tokens[k].clean) !== -1; };
  // An extra needs a main amount too ("transfer 1jt untuk tabungan" has no extra).
  if (amounts.length < 2) return { extra: null };
  const starts = amounts.map(function (a) { return a.tokens[0]; });
  const found = [];
  amounts.forEach(function (a) {
    const first = a.tokens[0];
    const last = a.tokens[a.tokens.length - 1];
    // Fee words right before the amount ("dipotong admin 15k", "biaya transfer 6.5rb") or right after ("2.5rb admin").
    const before = [];
    for (let k = first - 1; k >= 0; k--) {
      if (isWord(k, FEE_WORDS)) before.push(k);
      else if (isTransferWord(k) && before.length === 0) continue;
      else break;
    }
    // A fee word followed by another amount belongs to that amount ("1jt admin 2.5rb").
    let runEnd = last + 1;
    while (isWord(runEnd, FEE_WORDS)) runEnd++;
    const feeAfter = runEnd > last + 1 && starts.indexOf(runEnd) === -1;
    if (before.length || feeAfter) {
      const words = before.length ? before : [last + 1];
      found.push({ a: a, kind: 'fee', words: words, note: words.slice().sort(function (x, y) { return x - y; }).map(function (k) { return tokens[k].raw; }).join(' ') });
    } else if (isWord(first - 1, RECEIVED_WORDS)) {
      found.push({ a: a, kind: 'received', words: [first - 1], note: '' });
    } else if (isWord(last + 1, PARTIAL_WORDS)) {
      // Everything after "untuk" is what the money was spent on.
      const words = [];
      for (let k = last + 1; k < tokens.length; k++) if (!tokens[k].used) words.push(k);
      found.push({ a: a, kind: 'partial', words: words,
        note: words.slice(1).map(function (k) { return tokens[k].raw; }).join(' ').replace(/[\s,.;:-]+$/, '') });
    }
  });
  if (found.length === 0) return { extra: null };
  if (found.length > 1) return { error: 'transfer_two_extras' };

  const f = found[0];
  // A small bare number next to a fee word is taken literally ("admin 500" = Rp500).
  let value = f.a.value;
  if (f.a.ambiguous && f.a.ambiguous.reason !== 'small') return { error: 'extra_unclear' };
  f.a.tokens.concat(f.words).forEach(function (k) { tokens[k].used = true; });

  const expenseOnly = ['Expense'];
  let category = null;
  let categoryHow = '';
  if (f.kind === 'partial' && tag !== null) {
    const c = findCategoryByTag_(tag, ctx.categories, expenseOnly);
    if (c) { category = c.name; categoryHow = 'tag'; }
  }
  if (category === null && f.kind !== 'received') {
    const k = matchKeyword_(f.note, ctx.categories, expenseOnly);
    if (k) { category = k.category; categoryHow = 'keyword'; }
  }
  if (category === null && f.kind === 'fee') {
    // SPEC Section 6: fees default to "Admin & Bank Fees" (if that category exists).
    const c = ctx.categories.filter(function (x) { return x.type === 'Expense' && x.name === DEFAULT_FEE_CATEGORY; })[0];
    if (c) { category = c.name; categoryHow = 'keyword'; }
  }
  return { extra: { kind: f.kind, amount: value, note: f.kind === 'partial' ? f.note : '', category: category,
    categoryHow: categoryHow } };
}

/**
 * Reads just a date ("kemarin", "20/09", "5 okt 2025"), for the Edit → Date
 * step. Returns a Date or null.
 */
function parseDateOnly_(text, now) {
  if (/^\s*\d{1,2}\s*$/.test(text) && Number(text) >= 1 && Number(text) <= 31) {
    return nearestPastDay_(Number(text), now); // just "10" → the nearest past 10th
  }
  const tokens = String(text).trim().split(/\s+/).filter(String).map(function (raw) {
    return { raw: raw, clean: cleanToken_(raw), used: false };
  });
  const result = extractDate_(tokens, now);
  const leftover = tokens.some(function (t) { return !t.used; });
  return result.date && !leftover ? result.date : null;
}

/**
 * Reads "/adjust BCA 10.200.000 [date] [note]" (the text after /adjust).
 * Returns { ok: true, wallet | walletChoices, actual | amountOptions, date,
 * dateNeedsConfirm, dateText, note } or { ok: false, error } with errors
 * adjust_usage, adjust_no_wallet, adjust_investment, two_wallets,
 * no_amount, multiple_amounts, invalid_date, multiple_dates.
 * A balance of 0 and negative balances ("-50.000") are allowed.
 */
function parseAdjust_(text, ctx) {
  const now = ctx.now || new Date();
  const tokens = String(text || '').trim().split(/\s+/).filter(String).map(function (raw) {
    return { raw: raw, clean: cleanToken_(raw), used: false };
  });
  if (tokens.length === 0) return { ok: false, error: 'adjust_usage' };

  const dateResult = extractDate_(tokens, now);
  if (dateResult.error) return { ok: false, error: dateResult.error, text: dateResult.text };

  const all = extractWallets_(tokens, ctx.wallets);
  const mentions = all.filter(function (f, i) {
    return all.findIndex(function (g) { return mentionKey_(g) === mentionKey_(f); }) === i;
  });
  if (mentions.length === 0) return { ok: false, error: 'adjust_no_wallet' };
  if (mentions.length > 1) return { ok: false, error: 'two_wallets', wallets: mentions.map(mentionLabel_) };
  // Investment category wallets (Saham, Emas…) get their value from the Investments tab.
  const kept = mentions[0].wallets.filter(function (w) { return w.type !== 'Investment'; });
  if (kept.length === 0) return { ok: false, error: 'adjust_investment', wallet: mentionLabel_(mentions[0]) };

  // "0" / "Rp0" is a valid balance (parseAmountToken_ treats 0 as "not an amount").
  let actual = null;
  let amountOptions = null;
  let amountText = '';
  const zero = tokens.filter(function (t) { return !t.used && /^(rp\.?)?0+$/.test(t.clean); })[0];
  const amounts = extractAmounts_(tokens);
  if (zero && amounts.length === 0) {
    zero.used = true;
    actual = 0;
    amountText = zero.raw;
  } else {
    const strong = amounts.filter(function (a) { return a.strong; });
    const pool = strong.length ? strong : amounts;
    if (pool.length === 0) return { ok: false, error: 'no_amount' };
    if (pool.length > 1) return { ok: false, error: 'multiple_amounts', amounts: pool.map(function (a) { return a.text; }) };
    const a = pool[0];
    a.tokens.forEach(function (k) { tokens[k].used = true; });
    const firstTok = tokens[a.tokens[0]];
    const prev = tokens[a.tokens[0] - 1];
    const negative = /^-/.test(firstTok.clean) || (prev && !prev.used && (prev.clean === '-' || prev.clean === 'minus'));
    if (prev && !prev.used && (prev.clean === '-' || prev.clean === 'minus')) prev.used = true;
    const sign = negative ? -1 : 1;
    amountText = a.text;
    if (a.ambiguous) amountOptions = a.ambiguous.options.map(function (v) { return v * sign; });
    else actual = a.value * sign;
  }

  const note = tokens.filter(function (t) { return !t.used; }).map(function (t) { return t.raw; }).join(' ')
    .replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '');
  return {
    ok: true,
    wallet: kept.length === 1 ? kept[0].name : null,
    walletChoices: kept.length > 1 ? kept.map(function (w) { return w.name; }) : null,
    actual: actual,
    amountOptions: amountOptions,
    amountText: amountText,
    date: dateResult.date || new Date(now.getTime()),
    dateNeedsConfirm: !!dateResult.needsConfirm,
    dateText: dateResult.text || '',
    note: note
  };
}

// ---------------------------------------------------------------------------
// Hutang / piutang / split bill (Phase 4, SPEC Section 7)
// ---------------------------------------------------------------------------
// parseDebt_ returns null when the message isn't about a debt (the normal
// transaction parser handles it), otherwise { ok: true, kind, … } or
// { ok: false, error }. kind: 'new' (piutang/hutang, single or group),
// 'split', 'pay', 'add', 'convert'. Pure: contacts, wallets, categories in ctx.

const LEND_WORDS = ['piutang', 'pinjamin', 'pinjemin', 'minjemin', 'pinjamkan', 'meminjamkan', 'lend', 'lent', 'loan'];
const BORROW_WORDS = ['hutang', 'utang', 'pinjam', 'minjam', 'minjem', 'ngutang', 'borrow', 'borrowed'];
const DEBT_TYPE_WORDS = ['piutang', 'hutang', 'utang'];
const GROUP_WORDS = ['grup', 'group', 'bareng'];
const SPLIT_WORDS = ['split', 'patungan', 'splitbill'];
const PAY_WORDS = ['bayar', 'bayarin', 'membayar', 'dibayar', 'balikin', 'kembalikan', 'ngembaliin', 'paid', 'pay', 'pays',
  'repaid', 'repay', 'cicil', 'nyicil'];
const FULL_WORDS = ['lunas', 'lunasin', 'melunasi', 'pelunasan', 'settled'];
const ADD_WORDS = ['tambah', 'nambah', 'tambahin', 'add'];
const CONVERT_WORDS = ['tutup', 'close', 'convert', 'ikhlasin', 'ikhlaskan'];
const ME_WORDS = ['saya', 'aku', 'gue', 'gw', 'me', 'myself'];
const NOT_ME_WORDS = ['tanpa', 'without', 'excluding', 'kecuali'];
const DUE_WORDS = ['tempo', 'due', 'deadline'];
const NOTE_START_WORDS = ['untuk', 'utk', 'buat', 'for', 'keperluan'];
// Small words that are never a name.
const DEBT_FILLER_WORDS = ['jatuh', 'jadi', 'pengeluaran', 'pemasukan', 'expense', 'income', 'termasuk', 'incl',
  'including', 'dan', 'and', '&', 'dari', 'ke', 'sama', 'dengan', 'dgn', 'to', 'from', 'with', 'by', 'jangka', 'panjang',
  'long', 'term', 'longterm', 'yang', 'si', 'semua', 'all', 'uang', 'duit', 'sebesar', 'orang', 'bill'];
const DEBT_ID_RE = /^(ptg|htg)-\d+(-[a-z]+)?$/i;

function tokenize_(text) {
  return String(text || '').trim().split(/\s+/).filter(String).map(function (raw) {
    return { raw: raw, clean: cleanToken_(raw), used: false };
  });
}

/**
 * A due date after "jatuh tempo" / "due" / "deadline": dd/mm(/yyyy), "30 okt",
 * "tgl 10", "N hari" / "N days", "minggu depan" / "next week", "bulan depan" /
 * "next month". Always today or later (no year → the next such date).
 */
function extractDueDate_(tokens, now) {
  const at = tokens.findIndex(function (t) { return !t.used && DUE_WORDS.indexOf(t.clean) !== -1; });
  if (at === -1) return {};
  tokens[at].used = true;
  if (at > 0 && tokens[at - 1].clean === 'jatuh') tokens[at - 1].used = true;
  const t = function (k) { return tokens[at + k] ? tokens[at + k].clean : ''; };
  const use = function (n) { for (let k = 1; k <= n; k++) tokens[at + k].used = true; };
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const future = function (y, m, d, yearGiven) {
    let date = makeDate_(y, m, d, now);
    if (date && !yearGiven && date < today) date = makeDate_(y + 1, m, d, now);
    return date;
  };
  let date = null;
  let k = 1;
  if (t(1) === 'tgl' || t(1) === 'tanggal') k = 2;
  const dm = t(k).match(/^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2}|\d{4}))?$/);
  if (dm) {
    const y = dm[3] ? (dm[3].length === 2 ? 2000 + Number(dm[3]) : Number(dm[3])) : now.getFullYear();
    date = future(y, Number(dm[2]) - 1, Number(dm[1]), !!dm[3]);
    use(k);
  } else if (/^\d{1,2}$/.test(t(k)) && MONTH_WORDS[t(k + 1)] !== undefined) {
    const yearGiven = /^(19|20)\d{2}$/.test(t(k + 2));
    date = future(yearGiven ? Number(t(k + 2)) : now.getFullYear(), MONTH_WORDS[t(k + 1)], Number(t(k)), yearGiven);
    use(k + (yearGiven ? 2 : 1));
  } else if (k === 2 && /^\d{1,2}$/.test(t(2))) {
    // "tempo tgl 10": the next 10th (this month if still ahead, else next month)
    date = makeDate_(now.getFullYear(), now.getMonth(), Number(t(2)), now);
    if (!date || date < today) {
      const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      date = makeDate_(next.getFullYear(), next.getMonth(), Number(t(2)), now);
    }
    use(2);
  } else if (/^\d{1,3}$/.test(t(1)) && ['hari', 'days', 'day'].indexOf(t(2)) !== -1) {
    date = dayWithTime_(now.getFullYear(), now.getMonth(), now.getDate() + Number(t(1)), now);
    use(t(3) === 'lagi' ? 3 : 2);
  } else if ((t(1) === 'minggu' && t(2) === 'depan') || (t(1) === 'next' && t(2) === 'week')) {
    date = dayWithTime_(now.getFullYear(), now.getMonth(), now.getDate() + 7, now);
    use(2);
  } else if ((t(1) === 'bulan' && t(2) === 'depan') || (t(1) === 'next' && t(2) === 'month')) {
    date = dayWithTime_(now.getFullYear(), now.getMonth() + 1, now.getDate(), now);
    use(2);
  }
  return date ? { date: date } : { error: 'due_unclear' };
}

/**
 * Splits a bill / group amount. people = [{ name, amount|null }], me = null
 * (not included) or { amount|null }. Equal parts are rounded down to whole
 * Rupiah; the leftover goes to me (or to the first person if I'm not in it).
 * Returns { people: [{name, amount}], me: amount|0, total } or { error }.
 */
function computeShares_(people, total, me) {
  const slots = people.map(function (p) { return { name: p.name, amount: p.amount }; });
  if (me) slots.push({ name: null, amount: me.amount, isMe: true });
  const given = slots.filter(function (s) { return s.amount !== null && s.amount !== undefined; });
  const open = slots.filter(function (s) { return s.amount === null || s.amount === undefined; });
  const givenSum = given.reduce(function (a, s) { return a + s.amount; }, 0);
  if (open.length === 0) {
    if (total && total !== givenSum) return { error: 'shares_mismatch', sum: givenSum, total: total };
    total = givenSum;
  } else {
    if (!total) return { error: 'debt_no_amount' };
    const rest = total - givenSum;
    if (rest <= 0) return { error: 'shares_mismatch', sum: givenSum, total: total };
    const each = Math.floor(rest / open.length);
    if (each <= 0) return { error: 'shares_mismatch', sum: givenSum, total: total };
    open.forEach(function (s) { s.amount = each; });
    const leftover = rest - each * open.length;
    const taker = open.filter(function (s) { return s.isMe; })[0] || open[0];
    taker.amount += leftover;
  }
  const mine = slots.filter(function (s) { return s.isMe; })[0];
  return {
    people: slots.filter(function (s) { return !s.isMe; }).map(function (s) { return { name: s.name, amount: s.amount }; }),
    me: mine ? mine.amount : 0,
    total: total
  };
}

function parseDebt_(text, ctx) {
  const now = ctx.now || new Date();
  const tokens = tokenize_(text);
  if (tokens.length === 0) return null;
  const isIn = function (t, list) { return list.indexOf(t.clean) !== -1; };
  // Command words only count before the note ("piutang 500rb Budi buat bayar kos" is not a payment).
  const noteStart = tokens.findIndex(function (t) { return isIn(t, NOTE_START_WORDS); });
  const head = noteStart === -1 ? tokens : tokens.slice(0, noteStart);
  const has = function (list) { return head.some(function (t) { return isIn(t, list); }); };
  const idTok = tokens.filter(function (t) { return DEBT_ID_RE.test(t.clean); })[0] || null;
  const typeTok = tokens.filter(function (t) { return isIn(t, DEBT_TYPE_WORDS); })[0] || null;
  // Contacts are only looked at when a pay word is present (they may be read lazily from the sheet).
  let probed = null;
  const contactProbe = function () {
    if (probed === null) {
      probed = extractContacts_(tokens.map(function (t) { return { raw: t.raw, clean: t.clean, used: false }; }), ctx.contacts || []);
    }
    return probed;
  };

  let kind = null;
  if (isIn(tokens[0], SPLIT_WORDS)) kind = 'split';
  else if (isIn(tokens[0], CONVERT_WORDS) && (typeTok || idTok)) kind = 'convert';
  else if (isIn(tokens[0], ADD_WORDS) && (typeTok || idTok)) kind = 'add';
  else if ((has(PAY_WORDS) || has(FULL_WORDS)) && (typeTok || idTok || contactProbe().length)) kind = 'pay';
  else if (has(LEND_WORDS) || has(BORROW_WORDS)) kind = 'new';
  if (kind === null) return null;

  // Piutang or hutang?
  let debtType = null;
  if (idTok) debtType = /^ptg/i.test(idTok.clean) ? 'Piutang' : 'Hutang';
  else if (typeTok) debtType = typeTok.clean === 'piutang' ? 'Piutang' : 'Hutang';
  const firstVerb = head.findIndex(function (t) { return isIn(t, PAY_WORDS) || isIn(t, FULL_WORDS); });
  if (kind === 'new' && debtType === null) {
    const lend = tokens.findIndex(function (t) { return isIn(t, LEND_WORDS); });
    const borrow = tokens.findIndex(function (t) { return isIn(t, BORROW_WORDS); });
    // "Budi pinjam 500rb" = Budi borrows from me → piutang; "pinjam 1jt dari Andi" → hutang.
    debtType = lend !== -1 ? 'Piutang' : (borrow > 0 && !isIn(tokens[0], ME_WORDS) ? 'Piutang' : 'Hutang');
  }
  if (kind === 'pay' && debtType === null && contactProbe().length && firstVerb !== -1) {
    // "Budi bayar 200rb" (they pay me) vs "bayar Andi 500rb" (I pay them)
    debtType = contactProbe()[0].index < firstVerb ? 'Piutang' : 'Hutang';
  }
  if (kind === 'split') debtType = 'Piutang';

  // "piutang grup …" or "piutang split …" = a group piutang (several names also make a group, below).
  let group = has(GROUP_WORDS) || (kind === 'new' && has(SPLIT_WORDS));
  const full = has(FULL_WORDS);
  let term = 'Short';
  tokens.forEach(function (t, i) {
    const next = tokens[i + 1] ? tokens[i + 1].clean : '';
    if ((t.clean === 'jangka' && next === 'panjang') || (t.clean === 'long' && next === 'term') || t.clean === 'longterm') {
      term = 'Long';
    }
  });
  const notMe = tokens.some(function (t, i) {
    return isIn(t, NOT_ME_WORDS) && tokens[i + 1] && isIn(tokens[i + 1], ME_WORDS);
  });

  // Mark the command words; remember where the note starts.
  const keywordLists = [LEND_WORDS, BORROW_WORDS, DEBT_TYPE_WORDS, GROUP_WORDS, SPLIT_WORDS, PAY_WORDS, FULL_WORDS,
    ADD_WORDS, CONVERT_WORDS, NOT_ME_WORDS];
  head.forEach(function (t) {
    if (keywordLists.some(function (l) { return isIn(t, l); })) t.used = true;
  });
  if (idTok) idTok.used = true;

  const due = extractDueDate_(tokens, now);
  if (due.error) return { ok: false, error: 'due_unclear' };
  const start = extractDate_(tokens, now);
  if (start.error) return { ok: false, error: start.error, text: start.text };

  let tag = null;
  tokens.forEach(function (t) { if (!t.used && /^#\S+/.test(t.clean)) { tag = t.clean.slice(1); t.used = true; } });

  const walletMentions = extractWallets_(tokens, ctx.wallets);
  const walletNames = walletMentions.map(mentionLabel_).filter(function (n, i, a) { return a.indexOf(n) === i; });
  if (walletNames.length > 1) return { ok: false, error: 'two_wallets', wallets: walletNames };
  let wallet = null;
  let walletChoices = null;
  if (walletMentions.length) {
    const kept = walletMentions[0].wallets.filter(function (w) { return !isInvestmentWallet_(w, ctx.investmentGroups); });
    if (kept.length === 0) return { ok: false, error: 'investment_wallet', wallet: mentionLabel_(walletMentions[0]) };
    if (kept.length === 1) wallet = kept[0].name; else walletChoices = kept.map(function (w) { return w.name; });
  }

  const contacts = extractContacts_(tokens, ctx.contacts || []);
  const meTokens = [];
  tokens.forEach(function (t, i) { if (!t.used && isIn(t, ME_WORDS)) { t.used = true; meTokens.push(i); } });
  tokens.forEach(function (t) { if (!t.used && isIn(t, DEBT_FILLER_WORDS)) t.used = true; });
  const amounts = extractAmounts_(tokens);
  amounts.forEach(function (a) { a.tokens.forEach(function (k) { tokens[k].used = true; }); });

  // Where the note starts ("untuk …", "buat …"): everything after it is the note.
  let noteAt = tokens.findIndex(function (t) { return !t.used && isIn(t, NOTE_START_WORDS); });
  if (noteAt === -1) noteAt = tokens.length;
  const wordy = function (t) { return /[a-zÀ-ɏ]/i.test(t.clean) && !/\d/.test(t.clean); };
  const cleanName = function (raw) { return raw.replace(/^[("'“]+/, '').replace(/[,;.:!?)"'”]+$/, ''); };
  const noteWords = [];
  const slots = [];     // { name, known, index, amount } or { isMe, index, amount }
  const totals = [];

  // --- Comma / full-stop mode: "split makan. budi 100k, andi 100k, aku 200k",
  //     "piutang 600rb Budi, Andi, Citra", "split 500k, budi, andi, aku".
  // A full stop ends the header (category / note words); commas separate people, in any case.
  const periodAt = tokens.findIndex(function (t, i) {
    return i < tokens.length - 1 && /[a-zÀ-ɏ]\.$/i.test(t.raw) && !/\d/.test(t.raw);
  });
  const commaMode = periodAt !== -1 || tokens.some(function (t, i) { return i < tokens.length - 1 && /,$/.test(t.raw); });
  if (commaMode && (kind === 'split' || kind === 'new')) {
    const segOf = [];
    let seg = 0;
    tokens.forEach(function (t, i) {
      segOf[i] = periodAt !== -1 && i <= periodAt ? 'H' : seg;
      if (!(periodAt !== -1 && i <= periodAt) && /,$/.test(t.raw)) seg++;
    });
    const segs = [];
    segOf.forEach(function (s) { if (segs.indexOf(s) === -1) segs.push(s); });
    segs.forEach(function (s) {
      const idx = segOf.map(function (x, i) { return x === s ? i : -1; }).filter(function (i) { return i !== -1; });
      const inSeg = function (i) { return idx.indexOf(i) !== -1; };
      const contact = contacts.filter(function (c) { return inSeg(c.index); })[0];
      const me = meTokens.filter(inSeg)[0];
      let words = idx.filter(function (i) { return !tokens[i].used && wordy(tokens[i]) && i < noteAt; });
      const segAmounts = amounts.filter(function (a) { return inSeg(a.tokens[0]); });
      // Before a full stop = the header (note / category). Without a full stop, a word in the first
      // part is the note only if it is a category keyword ("split 300rb bakso, Budi, Andi");
      // any other word there is a person ("split ivan, budi" → ivan and budi).
      if (s === 0 && periodAt === -1 && !contact) {
        const noteLike = words.filter(function (i) { return matchKeyword_(tokens[i].clean, ctx.categories, ['Expense']); });
        noteLike.forEach(function (i) { noteWords.push(tokens[i].raw); });
        words = words.filter(function (i) { return noteLike.indexOf(i) === -1; });
      }
      if (s === 'H' || (!contact && me === undefined && words.length === 0)) {
        words.forEach(function (i) { noteWords.push(tokens[i].raw); });
        segAmounts.forEach(function (a) { totals.push(a); });
        return;
      }
      const slot = me !== undefined && !contact && words.length === 0
        ? { isMe: true, index: me, amount: null }
        : { name: contact ? contact.name : words.map(function (i) { return cleanName(tokens[i].raw); }).join(' '),
            known: !!contact, index: contact ? contact.index : words[0], amount: null };
      if (contact) words.forEach(function (i) { noteWords.push(tokens[i].raw); });
      // An amount after the name is that person's share; one before it is the total ("piutang 600rb Budi, …").
      segAmounts.forEach(function (a) {
        if (a.tokens[0] > slot.index && slot.amount === null) slot.amount = a; else totals.push(a);
      });
      slots.push(slot);
    });
    tokens.forEach(function (t, i) {
      if (!t.used && i >= noteAt && (!isIn(t, NOTE_START_WORDS) || i > noteAt)) noteWords.push(t.raw);
    });
  } else {
    // --- Plain mode. In a split, only Capitalized words are names (lowercase leftovers like
    //     "makan" are the note); otherwise leftovers before the note are the name.
    const unknown = [];
    tokens.forEach(function (t, i) {
      if (t.used) return;
      if (i >= noteAt) { if (!isIn(t, NOTE_START_WORDS) || i > noteAt) noteWords.push(t.raw); return; }
      if (!wordy(t)) { noteWords.push(t.raw); return; }
      const capital = /^[A-Z]/.test(t.raw.replace(/^[("'“]+/, ''));
      if (kind === 'split' && !capital) { noteWords.push(t.raw); return; }
      unknown.push({ name: cleanName(t.raw), index: i });
    });
    let names;
    if (kind === 'split' || group) {
      names = contacts.map(function (c) { return { name: c.name, index: c.index, known: true }; })
        .concat(unknown.map(function (u) { return { name: u.name, index: u.index, known: false }; }));
    } else if (contacts.length) {
      names = contacts.map(function (c) { return { name: c.name, index: c.index, known: true }; });
      unknown.forEach(function (u) { noteWords.push(u.name); });
    } else if (unknown.length) {
      // For one person, neighbouring unknown words form one name ("Budi Santoso").
      const run = [unknown[0]];
      for (let k = 1; k < unknown.length && run.length < 3; k++) {
        if (unknown[k].index === run[run.length - 1].index + 1) run.push(unknown[k]); else break;
      }
      names = [{ name: run.map(function (u) { return u.name; }).join(' '), index: run[0].index, known: false }];
      unknown.slice(run.length).forEach(function (u) { noteWords.push(u.name); });
    } else {
      names = [];
    }
    names.forEach(function (n) { slots.push({ name: n.name, known: n.known, index: n.index, amount: null }); });
    meTokens.forEach(function (i) { slots.push({ isMe: true, index: i, amount: null }); });
    slots.sort(function (a, b) { return a.index - b.index; });
    // Pair amounts with the name (or "saya") right before them; the rest is the total.
    amounts.forEach(function (a) {
      const at = a.tokens[0];
      const owner = slots.filter(function (s) { return s.index < at; }).pop();
      const nextSlot = slots.filter(function (s) { return s.index > (owner ? owner.index : -1) && s.index < at; })[0];
      if (owner && owner.amount === null && !nextSlot && (kind === 'split' || group)) owner.amount = a;
      else totals.push(a);
    });
  }
  slots.sort(function (a, b) { return a.index - b.index; });
  const people = slots.filter(function (s) { return !s.isMe; });
  // Several people in a piutang/hutang = a group ("piutang 600rb Budi, Andi, Citra").
  if (kind === 'new' && people.length >= 2) group = true;
  // Including myself ("piutang 500k aku, budi, ahok") makes it a split bill: my share is an expense.
  if (kind === 'new' && debtType === 'Piutang' && slots.some(function (s) { return s.isMe; }) && people.length >= 1) {
    kind = 'split';
    group = false;
  }

  if (totals.length > 1) return { ok: false, error: 'multiple_amounts', amounts: totals.map(function (a) { return a.text; }) };
  const totalAmt = totals[0] || null;
  const unclear = function (a) { return a && a.ambiguous; };

  const note = noteWords.join(' ').replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '');
  const base = {
    ok: true, kind: kind, debtType: debtType, term: term, date: start.date || new Date(now.getTime()),
    dateNeedsConfirm: !!start.needsConfirm, dateText: start.text || '', due: due.date || null,
    wallet: wallet, walletChoices: walletChoices, note: note, id: idTok ? idTok.clean.toUpperCase() : null, full: full
  };

  if (kind === 'split' || (kind === 'new' && group)) {
    if (people.length === 0) return { ok: false, error: kind === 'split' ? 'split_no_people' : 'debt_no_name' };
    if (kind === 'new' && people.length < 2) return { ok: false, error: 'group_few_people' };
    if (unclear(totalAmt) || slots.some(function (s) { return unclear(s.amount); })) return { ok: false, error: 'debt_amount_unclear' };
    const meSlot = slots.filter(function (s) { return s.isMe; })[0];
    // I'm only in the split when I write aku / saya (e.g. "termasuk saya") — owner's rule.
    const includeMe = kind === 'split' && !notMe && !!meSlot;
    let category = null;
    let categoryHow = '';
    if (kind === 'split') {
      const c = tag !== null ? findCategoryByTag_(tag, ctx.categories, ['Expense']) : null;
      if (c) { category = c.name; categoryHow = 'tag'; }
      else {
        const k = matchKeyword_(note, ctx.categories, ['Expense']);
        if (k) { category = k.category; categoryHow = 'keyword'; }
      }
    }
    // The shares; if the total is still missing, the bot asks for it and splits then.
    const raw = {
      people: people.map(function (s) { return { name: s.name, known: s.known, amount: s.amount ? s.amount.value : null }; }),
      me: includeMe ? { amount: meSlot && meSlot.amount ? meSlot.amount.value : null } : null
    };
    const result = Object.assign(base, { group: kind === 'new', includeMe: includeMe, category: category,
      categoryHow: categoryHow, rawShares: raw });
    const shares = computeShares_(raw.people, totalAmt ? totalAmt.value : 0, raw.me);
    if (shares.error === 'debt_no_amount') return Object.assign(result, { needsTotal: true, people: raw.people, total: 0, me: 0 });
    if (shares.error) return { ok: false, error: shares.error, sum: shares.sum, total: shares.total };
    return Object.assign(result, sharesToDraft_(shares, raw));
  }

  const person = people[0] || null;
  const single = Object.assign(base, {
    name: person ? person.name : null, known: person ? person.known : false,
    amount: totalAmt && !totalAmt.ambiguous ? totalAmt.value : null,
    amountOptions: totalAmt && totalAmt.ambiguous ? totalAmt.ambiguous.options : null,
    amountText: totalAmt ? totalAmt.text : ''
  });
  if (kind === 'convert') {
    const c = tag !== null ? findCategoryByTag_(tag, ctx.categories, ['Expense', 'Income']) : null;
    single.category = c ? c.name : null;
  }
  // A missing amount is asked for (the entry is kept), not an error.
  single.needsAmount = (kind === 'new' || kind === 'add' || (kind === 'pay' && !full)) && !totalAmt;
  if ((kind === 'pay' || kind === 'add' || kind === 'convert') && !single.id && !single.name) {
    return { ok: false, error: 'debt_no_name' };
  }
  return single;
}

/** computeShares_ result → the draft's people / me / total (keeping "new contact" flags). */
function sharesToDraft_(shares, raw) {
  return {
    total: shares.total, me: shares.me, needsTotal: false,
    people: shares.people.map(function (p, i) { return { name: p.name, known: raw.people[i].known, amount: p.amount }; })
  };
}
