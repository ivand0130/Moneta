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
// Words that mean a transfer has a fee / partial expense / received amount (Phase 3).
const TRANSFER_EXTRA_WORDS = ['admin', 'fee', 'biaya', 'dipotong', 'potong', 'potongan', 'sampai', 'diterima', 'untuk', 'dipakai'];
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
  const list = wallets
    .filter(function (w) { return w.active !== false; })
    .map(function (w) { return { wallet: w, words: w.name.toLowerCase().split(/\s+/) }; })
    .sort(function (a, b) { return b.words.length - a.words.length || b.wallet.name.length - a.wallet.name.length; });
  const found = [];
  list.forEach(function (entry) {
    for (let i = 0; i + entry.words.length <= tokens.length; i++) {
      let match = true;
      for (let k = 0; k < entry.words.length; k++) {
        const t = tokens[i + k];
        if (t.used || t.clean !== entry.words[k]) { match = false; break; }
      }
      if (!match) continue;
      for (let k = 0; k < entry.words.length; k++) tokens[i + k].used = true;
      let connector = '';
      if (i > 0 && !tokens[i - 1].used && WALLET_CONNECTORS.indexOf(tokens[i - 1].clean) !== -1) {
        connector = tokens[i - 1].clean;
        tokens[i - 1].used = true;
      }
      found.push({ wallet: entry.wallet, index: i, connector: connector });
    }
  });
  found.sort(function (a, b) { return a.index - b.index; });
  return found;
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
  const mentions = allMentions.filter(function (f, i) {
    return allMentions.findIndex(function (g) { return g.wallet.name === f.wallet.name; }) === i;
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
  if (isTransfer && repeatedWallet && mentions.length === 1) {
    return { ok: false, error: 'same_wallet', wallet: mentions[0].wallet.name };
  }

  // Investment wallets: never for expenses/income. Transfers may use investment-group cash
  // wallets (e.g. BCA ke IPOT) but not Wallet Type = Investment (purchases come later).
  const invest = mentions.filter(function (m) {
    return isTransfer ? m.wallet.type === 'Investment' : isInvestmentWallet_(m.wallet, ctx.investmentGroups);
  })[0];
  if (invest) return { ok: false, error: 'investment_wallet', wallet: invest.wallet.name };

  const amounts = extractAmounts_(tokens);

  let wallet = null;
  let toWallet = null;
  if (isTransfer) {
    const extras = tokens.some(function (t) { return !t.used && TRANSFER_EXTRA_WORDS.indexOf(t.clean) !== -1; });
    if (extras || amounts.filter(function (a) { return a.strong; }).length > 1) {
      return { ok: false, error: 'transfer_extras' };
    }
    if (mentions.length > 2) {
      return { ok: false, error: 'too_many_wallets', wallets: mentions.map(function (m) { return m.wallet.name; }) };
    }
    const dest = mentions.filter(function (m) { return DEST_CONNECTORS.indexOf(m.connector) !== -1; })[0];
    const src = mentions.filter(function (m) { return SOURCE_CONNECTORS.indexOf(m.connector) !== -1; })[0];
    if (mentions.length === 2) {
      const d = dest || (src ? mentions.filter(function (m) { return m !== src; })[0] : mentions[1]);
      const s = mentions.filter(function (m) { return m !== d; })[0];
      wallet = s.wallet.name;
      toWallet = d.wallet.name;
    } else if (mentions.length === 1) {
      const only = mentions[0];
      if (dest === only || (!src && topUp)) toWallet = only.wallet.name;
      else wallet = only.wallet.name;
    }
    if (wallet !== null && wallet === toWallet) return { ok: false, error: 'same_wallet', wallet: wallet };
  } else {
    if (mentions.length > 1) {
      return { ok: false, error: 'two_wallets', wallets: mentions.map(function (m) { return m.wallet.name; }) };
    }
    if (mentions.length === 1) wallet = mentions[0].wallet.name;
  }

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
    toWallet: toWallet,
    category: category,
    categoryHow: categoryHow,
    unknownTag: unknownTag,
    note: note
  };
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
