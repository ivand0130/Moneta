/**
 * OCR.gs — bill photos (SPEC Sections 10 and 24).
 *
 * Every photo (or image file) is turned into text by Google Drive's OCR and
 * read with rules (parseOcrText_); Gemini is only the backup. Route: the issuer contains "GoPay" AND there is a participant list → GoPay
 * Split Bill flow; anything else → Receipt flow. A caption "split" / "bill"
 * forces the flow. The caption is read like a text message but the amount is
 * optional ("BCA #food", "120rb").
 *
 * Receipt → the normal transaction preview (Confirm.gs), Input Source
 * OCR-Receipt. Split bill → small steps here (which one is me, who paid,
 * shares vs total, unknown names), then:
 *   I paid            → the Phase 4 split flow (my share Expense, others Piutang)
 *   someone else paid → [Not paid back yet] Hutang to them + my Expense (net 0
 *                        on the wallet, so the meal still counts in budgets) or
 *                       [Already paid] a plain Expense
 * The pending entry keeps only Telegram's file_id; the image is downloaded
 * again and saved to Drive (Receipts/yyyy-MM/) only after Yes, then linked
 * ("View receipt") on every row of the group.
 *
 * Owner's decisions (Phase 7): ask "which one is you?" when the GoPay name
 * doesn't match and remember it in Users (👤 Not me changes it); a receipt
 * from an app picks the wallet whose Receipt Issuer matches (several →
 * buttons); low confidence = below 80%; the Receipts folder is shared with
 * the partner by hand.
 */

const OCR_LOW_CONFIDENCE = 0.8;
const OCR_SPLIT_WORDS = ['split', 'patungan', 'splitbill'];
const OCR_RECEIPT_WORDS = ['bill', 'struk', 'receipt', 'nota'];
const OCR_ME_NAMES = ['me', 'saya', 'aku', 'anda', 'you', 'kamu'];

const OCR_PROMPT = [
  'You read a photo of a bill, receipt or payment screen from Indonesia. Answer with ONE JSON object only:',
  '{"readable": true|false, "issuer": string (app or company that issued it, e.g. "GoPay", "Indomaret", "Grab"),',
  ' "merchant": string (shop / restaurant / bill title), "is_split_bill": true|false (a GoPay Split Bill style list of',
  ' people with their share), "date": "YYYY-MM-DD" or null, "date_confidence": 0..1,',
  ' "subtotal": number|null, "tax": number|null, "service": number|null, "discount": number|null, "delivery": number|null,',
  ' "total": number|null (the FINAL amount paid after tax, service, discount and delivery — "Total", "Grand Total",',
  ' "Total Bayar", "Jumlah"; NEVER the subtotal and NEVER the change "Kembalian"), "total_confidence": 0..1,',
  ' "other_totals": [numbers] (other amounts that could also be the final total, if unclear),',
  ' "items": [up to 10 short item names],',
  ' "payer": string|null (split bill: the person who paid the whole bill),',
  ' "participants": [{"name": string, "amount": number, "confidence": 0..1}] (split bill only, every person and share)}',
  'Amounts are whole Rupiah numbers without dots or "Rp" (e.g. 185500). Use null when you cannot read a value.'
].join('\n');

// ---------------------------------------------------------------------------
// Reading (pure parts are tested by testOcr)
// ---------------------------------------------------------------------------

/** Gemini's answer → clean numbers and lists. Returns null when nothing usable came back. */
function normalizeOcr_(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = function (v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseInvNumber_(String(v).replace(/\s/g, ''));
    return n === null || isNaN(n) ? null : Math.round(n);
  };
  const conf = function (v) { const n = Number(v); return isNaN(n) ? 1 : Math.max(0, Math.min(1, n > 1 ? n / 100 : n)); };
  const people = (Array.isArray(raw.participants) ? raw.participants : []).map(function (p) {
    return { name: String(p && p.name || '').trim(), amount: num(p && p.amount), confidence: conf(p && p.confidence) };
  }).filter(function (p) { return p.name && p.amount !== null; });
  return {
    readable: raw.readable !== false,
    issuer: String(raw.issuer || '').trim(),
    merchant: String(raw.merchant || raw.issuer || '').trim().slice(0, 60),
    isSplit: !!raw.is_split_bill,
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || '')) ? String(raw.date) : null,
    dateConfidence: conf(raw.date_confidence),
    subtotal: num(raw.subtotal), tax: num(raw.tax), service: num(raw.service), discount: num(raw.discount), delivery: num(raw.delivery),
    total: num(raw.total), totalConfidence: conf(raw.total_confidence),
    otherTotals: (Array.isArray(raw.other_totals) ? raw.other_totals : []).map(num).filter(function (n) { return n !== null && n > 0; }),
    items: (Array.isArray(raw.items) ? raw.items : []).map(function (s) { return String(s).trim(); }).filter(String).slice(0, 10),
    payer: raw.payer ? String(raw.payer).trim() : null,
    participants: people
  };
}

/** 'split' or 'receipt': GoPay issuer + participant list → split; the caption can force either. */
function ocrRoute_(ocr, caption) {
  const words = String(caption || '').toLowerCase().split(/[^a-z]+/);
  if (words.some(function (w) { return OCR_SPLIT_WORDS.indexOf(w) !== -1; }) && ocr.participants.length) return 'split';
  if (words.some(function (w) { return OCR_RECEIPT_WORDS.indexOf(w) !== -1; })) return 'receipt';
  // GoPay's split screen often doesn't say "GoPay" (it shows the merchant, the total and the members), so a
  // list of 2+ people that Gemini calls a split bill counts too (owner's test, 2026-11-02).
  const isGopay = /gopay/i.test(ocr.issuer + ' ' + ocr.merchant);
  return ocr.participants.length > 0 && (isGopay || (ocr.isSplit && ocr.participants.length >= 2)) ? 'split' : 'receipt';
}

/**
 * The amounts that could be the final total: one → use it; several → ask.
 * Several when Gemini gave other candidates, or when subtotal + tax + service
 * + delivery − discount doesn't match the total.
 */
function receiptTotalCandidates_(ocr) {
  const out = [];
  const add = function (n) { if (n && out.indexOf(n) === -1) out.push(n); };
  add(ocr.total);
  ocr.otherTotals.forEach(add);
  if (ocr.subtotal !== null && ocr.total !== null) {
    const built = ocr.subtotal + (ocr.tax || 0) + (ocr.service || 0) + (ocr.delivery || 0) - (ocr.discount || 0);
    if (Math.abs(built - ocr.total) > 1) add(built);
  }
  return out;
}

/** Wallets whose Receipt Issuer matches the receipt's issuer (e.g. "GoPay"). */
function issuerWallets_(wallets, issuer) {
  const text = String(issuer || '').toLowerCase();
  if (!text) return [];
  return cashWallets_(wallets).filter(function (w) {
    return splitGroups_(w.receiptIssuer || '').some(function (k) { return k && text.indexOf(k.toLowerCase()) !== -1; });
  });
}

/**
 * The caption read like a text message, amount optional: { ok, amount?,
 * amountOptions?, wallet?, walletChoices?, category?, categoryHow?,
 * unknownTag?, note, date?, dateGiven } or { ok: false, error }.
 */
function parseCaption_(caption, ctx) {
  const text = String(caption || '').replace(/(^|\s)(split|patungan|splitbill|bill|struk|receipt|nota)(?=\s|$)/gi, ' ').trim();
  if (!text) return { ok: true, note: '', dateGiven: false };
  let r = parseTransaction_(text, ctx);
  let noAmount = false;
  if (!r.ok && r.error === 'no_amount') {
    r = parseTransaction_(text + ' 1rb', ctx); // a stand-in amount, dropped below
    noAmount = true;
  }
  if (!r.ok) return r;
  return { ok: true, amount: noAmount ? null : r.amount, amountOptions: noAmount ? null : r.amountOptions,
    wallet: r.wallet, walletChoices: r.walletChoices, category: r.category, categoryHow: r.categoryHow, unknownTag: r.unknownTag,
    note: r.note, date: r.date, dateGiven: !!r.dateGiven };
}

/** "2026-09-24" → a Date at the current time of day (null if invalid or more than a day ahead). */
function ocrDate_(ymd, now) {
  if (!ymd) return null;
  const p = ymd.split('-').map(Number);
  const d = makeDate_(p[0], p[1] - 1, p[2], now);
  return d && d.getTime() <= now.getTime() + 86400000 ? d : null;
}

/**
 * A receipt → the transaction draft for Confirm.gs. Returns { ok: true, d } or
 * { ok: false, error } (a caption that can't be read).
 */
function buildReceiptDraft_(ocr, caption, ctx, now, image) {
  const cap = parseCaption_(caption, ctx);
  if (!cap.ok) return cap;
  const totals = receiptTotalCandidates_(ocr);
  const amount = cap.amount || (totals.length === 1 ? totals[0] : null);
  const date = cap.dateGiven ? cap.date : (ocrDate_(ocr.date, now) || now);
  const merchant = ocr.merchant || 'Receipt';
  let category = cap.category;
  let categoryHow = cap.categoryHow;
  if (!category) {
    const k = matchKeyword_([merchant].concat(ocr.items).join(' '), ctx.categories, ['Expense']);
    if (k) { category = k.category; categoryHow = 'keyword'; }
  }
  let wallet = cap.wallet;
  let walletChoices = cap.walletChoices;
  let walletHow = wallet ? 'mentioned' : '';
  if (!wallet && !walletChoices) {
    const byIssuer = issuerWallets_(ctx.wallets, ocr.issuer + ' ' + ocr.merchant);
    if (byIssuer.length === 1) { wallet = byIssuer[0].name; walletHow = 'issuer'; }
    else if (byIssuer.length > 1) walletChoices = byIssuer.map(function (w) { return w.name; });
  }
  const warnings = [];
  if (!cap.amount && amount && ocr.totalConfidence < OCR_LOW_CONFIDENCE) {
    warnings.push('⚠️ Total read as ' + formatRp_(amount) + ' (low confidence). If it is wrong: ✏️ Edit → Amount.');
  }
  if (!cap.dateGiven && ocr.date && ocr.dateConfidence < OCR_LOW_CONFIDENCE) {
    warnings.push('⚠️ Date read as ' + formatDate_(date) + ' (low confidence). If it is wrong: ✏️ Edit → Date.');
  }
  if (!cap.dateGiven && !ocrDate_(ocr.date, now)) warnings.push("ℹ️ No date on the receipt, so it's dated today.");
  return { ok: true, d: {
    type: 'Expense', amount: amount, amountOptions: amount ? null : (totals.length > 1 ? totals : null),
    amountReason: 'receipt', amountText: merchant, date: date.getTime(), dateNeedsConfirm: false,
    wallet: wallet, walletChoices: walletChoices, walletHow: walletHow, toWallet: null, toWalletChoices: null,
    category: category || null, categoryHow: categoryHow || '', unknownTag: cap.unknownTag || null,
    note: [merchant, cap.note].filter(String).join(' · ').slice(0, 200), extra: null, feeChecked: true,
    inputSource: 'OCR-Receipt', receipt: { merchant: merchant, date: midnight_(date).getTime() },
    ocrHeader: '🧾 Read from receipt: ' + escapeHtml_(merchant) + ' · ' + formatDate_(date) + (ocr.total ? ' · Total ' + formatRp_(ocr.total) : ''),
    ocrWarnings: warnings, image: image || null
  } };
}

/** Participant indexes whose name is this GoPay name (case and spaces ignored). */
function findMeIndexes_(participants, gopayName) {
  const key = favKey_(gopayName);
  const byName = key ? participants.map(function (p, i) { return favKey_(p.name) === key ? i : -1; }).filter(function (i) { return i !== -1; }) : [];
  if (byName.length) return byName;
  // GoPay shows the sender as "Me" (or Saya / Anda / You).
  return participants.map(function (p, i) { return OCR_ME_NAMES.indexOf(favKey_(p.name)) !== -1 ? i : -1; }).filter(function (i) { return i !== -1; });
}

/**
 * A receipt row is a duplicate when the same total, merchant and receipt date
 * were already logged — at any time (receipts are often logged hours later).
 */
function findReceiptDuplicate_(rows, d) {
  const merchant = favKey_(d.receipt.merchant);
  const day = midnight_(d.date).getTime();
  return rows.filter(function (r) {
    return Number(r['amount']) === d.amount && r['date'] instanceof Date && midnight_(r['date']).getTime() === day &&
      favKey_(r['note']).indexOf(merchant) === 0;
  })[0] || null;
}

// ---------------------------------------------------------------------------
// Reading without AI: Google Drive's OCR gives the text, rules read it
// ---------------------------------------------------------------------------
// Gemini's free tier was too often busy (503) or refused photos (400), so the
// photo is first turned into text by Google Drive's own OCR (free, a few
// seconds, uses the Drive permission the bot already has). parseOcrText_ then
// reads that text with fixed rules into the same shape Gemini answers with.
// Gemini (text only, much lighter than a photo) is asked only when the rules
// find neither a total nor a split list.

// Final-total labels on receipts and payment screens; a lower number wins.
const OCR_TOTAL_WORDS = [
  ['grand total', 1], ['total bayar', 1], ['total pembayaran', 1], ['total tagihan', 1], ['total belanja', 1],
  ['total amount', 1], ['total payment', 1], ['amount paid', 1], ['jumlah bayar', 1], ['jumlah tagihan', 1],
  ['total harga', 1], ['you paid', 1], ['total', 2], ['jumlah', 3], ['tagihan', 3]
];
// Lines that mention "total" but are not the amount paid.
const OCR_NOT_TOTAL = /sub\s*-?\s*total|kembali|change|tunai|cash|item|qty|hemat|diskon|discount|disc\b|ppn|pajak|tax|poin|point|saving|weight|berat/i;
// App screen titles and buttons, never the merchant.
const OCR_CHROME = /^(split ?bill|bill details?|details?|rincian.*|detail transaksi|transaction details?|receipt|struk|share|bagikan|back|selesai|done|close|tutup|gopay|gojek|pembayaran berhasil|payment success(ful)?|transaksi berhasil)$/i;
// Status words next to split members.
const OCR_STATUS = /^(paid|unpaid|lunas|belum.*|sudah.*|pending|waiting.*|menunggu.*|requested|dibayar|settled|remind|ingatkan)$/i;
const OCR_ISSUERS = ['GoPay', 'GoFood', 'Gojek', 'GrabFood', 'Grab', 'OVO', 'DANA', 'ShopeePay', 'ShopeeFood', 'LinkAja'];

/** "Rp80.300" / "85,500" / "1.500,00" / "85500" → whole Rupiah; null if not an amount. */
function ocrAmount_(s) {
  const t = String(s).replace(/^-?\s*rp\.?\s*/i, '').replace(/\s/g, '').replace(/[.,]$/, '');
  let m = t.match(/^(\d{1,3}(?:[.,]\d{3})+)(?:[.,]\d{1,2})?$/);
  if (m) return Number(m[1].replace(/[.,]/g, ''));
  m = t.match(/^(\d+)(?:[.,]\d{1,2})?$/);
  return m ? Number(m[1]) : null;
}

/** Amounts written on a line, left to right. */
function ocrLineAmounts_(line) {
  return (String(line).match(/(?:rp\.?\s*)?\d[\d.,]*/gi) || []).map(ocrAmount_).filter(function (n) { return n !== null; });
}

/** A line that is only an amount ("Rp80.300", "85.500"). */
function ocrAmountOnly_(line) {
  return /^-?\s*(rp\.?\s*)?\d[\d.,]*$/i.test(line) ? ocrAmount_(line) : null;
}

/** The priority of a final-total label on this line (1 strongest), or 0. */
function ocrTotalRank_(line) {
  const low = line.toLowerCase();
  if (OCR_NOT_TOTAL.test(low)) return 0;
  for (let i = 0; i < OCR_TOTAL_WORDS.length; i++) {
    if (new RegExp('(^|[^a-z])' + OCR_TOTAL_WORDS[i][0] + '([^a-z]|$)').test(low)) return OCR_TOTAL_WORDS[i][1];
  }
  return 0;
}

/** The first date in the text → { ymd: 'YYYY-MM-DD', index } or null. */
function ocrFindDate_(lines) {
  const pad = function (n) { return (n < 10 ? '0' : '') + n; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let y = null, mo = null, d = null, m;
    if ((m = l.match(/(\d{1,2})\s+([a-z]{3,9})\.?,?\s+(\d{4})/i)) && MONTH_WORDS[m[2].toLowerCase()] !== undefined) {
      d = +m[1]; mo = MONTH_WORDS[m[2].toLowerCase()]; y = +m[3];
    } else if ((m = l.match(/([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/i)) && MONTH_WORDS[m[1].toLowerCase()] !== undefined) {
      d = +m[2]; mo = MONTH_WORDS[m[1].toLowerCase()]; y = +m[3];
    } else if ((m = l.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) {
      y = +m[1]; mo = +m[2] - 1; d = +m[3];
    } else if ((m = l.match(/(^|[^\d])(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4}|\d{2})(?!\d)/))) {
      d = +m[2]; mo = +m[3] - 1; y = +m[4] < 100 ? 2000 + +m[4] : +m[4];
    }
    if (y !== null && mo >= 0 && mo <= 11 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100) {
      return { ymd: y + '-' + pad(mo + 1) + '-' + pad(d), index: i };
    }
  }
  return null;
}

/** A line that can be a person's name in a split list ("Me", "GMS Krista"); avatar initials ("GK") are not. */
function ocrNameLine_(line) {
  if (OCR_ME_NAMES.indexOf(line.toLowerCase()) !== -1) return true;
  if (!/[a-z]/i.test(line) || /^[A-Z]{1,2}$/.test(line) || /\d{2}/.test(line) || ocrAvatarLine_(line)) return false;
  return !OCR_STATUS.test(line) && !OCR_CHROME.test(line) && !ocrTotalRank_(line) && !/member|anggota|peserta|split|rp\s*\d/i.test(line);
}

/** GoPay's row of member avatar initials, e.g. "MGNKS KRR +1" (owner's screenshot). */
function ocrAvatarLine_(line) {
  return /^[A-Z][A-Z\s]*\+\s?\d+$/.test(String(line).trim());
}

/**
 * GoPay's split screen always lists the sender first, as "Me". Google OCR can
 * miss that small word or read the avatar initials in its place, so when no
 * name is a "me" word: one name short → "Me" goes first; a first name that is
 * only capitals/initials → it becomes "Me".
 */
function ocrFirstIsMe_(names, amountCount) {
  const hasMe = names.some(function (n) { return OCR_ME_NAMES.indexOf(n.toLowerCase()) !== -1; });
  if (hasMe) return names;
  if (names.length + 1 === amountCount) return ['Me'].concat(names);
  if (names.length === amountCount && names.length && /^[A-Z\s+\d]+$/.test(names[0])) return ['Me'].concat(names.slice(1));
  return names;
}

/**
 * Google OCR text → the same object Gemini answers with (normalizeOcr_ reads
 * either). Pure, so testOcr checks it with real screen texts.
 */
function parseOcrText_(text) {
  const lines = String(text || '').replace(/﻿/g, '').split(/\r?\n/)
    .map(function (l) { return l.replace(/[\t ]+/g, ' ').replace(/^[•·*\-–>]+\s*/, '').trim(); }).filter(String);
  const all = lines.join('\n');
  const used = {};

  // Total: the strongest label wins; its amount is on the same line or the next amount-only line.
  const found = [];
  let subtotal = null;
  let totalIdx = -1;
  lines.forEach(function (l, i) {
    if (/sub\s*-?\s*total/i.test(l)) {
      const a = ocrLineAmounts_(l).pop() || (i + 1 < lines.length ? ocrAmountOnly_(lines[i + 1]) : null);
      if (a) subtotal = a;
      return;
    }
    const rank = ocrTotalRank_(l);
    if (!rank) return;
    let amount = ocrLineAmounts_(l).pop();
    let at = i;
    if (!amount && i + 1 < lines.length && ocrAmountOnly_(lines[i + 1])) { amount = ocrAmountOnly_(lines[i + 1]); at = i + 1; }
    if (amount) { found.push({ rank: rank, amount: amount, at: at, i: i }); used[at] = used[i] = true; }
  });
  const best = found.length ? Math.min.apply(null, found.map(function (f) { return f.rank; })) : 0;
  const top = found.filter(function (f) { return f.rank === best; });
  const distinct = top.map(function (f) { return f.amount; }).filter(function (n, k, a) { return a.indexOf(n) === k; });
  const total = distinct.length ? Math.max.apply(null, distinct) : null;
  if (top.length) totalIdx = top[top.length - 1].at;

  const date = ocrFindDate_(lines);
  if (date) used[date.index] = true;
  const issuers = OCR_ISSUERS.filter(function (n) { return new RegExp('(^|[^a-z])' + n + '([^a-z]|$)', 'i').test(all); });
  const payerMatch = all.match(/(?:paid by|dibayar oleh|dibayarin)\s*:?\s*([^\n]+)/i);

  // Split list: "Name Rp80.300" on one line, else names and amounts in two columns read one after the other.
  const membersLine = lines.map(function (l) { return /\d+\s*(members?|anggota|peserta|orang)\b/i.test(l); }).indexOf(true);
  const membersCount = membersLine === -1 ? null : Number(lines[membersLine].match(/(\d+)/)[1]);
  let people = [];
  lines.forEach(function (l, i) {
    if (used[i] || ocrTotalRank_(l)) return;
    const m = l.match(/^(.*?[a-z].*?)[\s:]*(-?\s*rp\.?\s*\d[\d.,]*)$/i);
    const amount = m ? ocrAmount_(m[2]) : null;
    if (!m || !amount) return;
    if (ocrNameLine_(m[1].trim())) people.push({ name: m[1].trim(), amount: amount, i: i });
    else if (ocrAvatarLine_(m[1]) && !people.length) people.push({ name: m[1].trim(), amount: amount, i: i }); // first row: see below
  });
  if (membersLine !== -1 && people.length >= 2) {
    const named = ocrFirstIsMe_(people.map(function (p) { return p.name; }), people.length);
    people.forEach(function (p, k) { p.name = named[k]; });
  }
  if (people.length < 2) {
    const start = membersLine !== -1 ? membersLine + 1 : (totalIdx !== -1 ? totalIdx + 1 : 0);
    const names = [];
    const amounts = [];
    for (let i = start; i < lines.length; i++) {
      if (used[i]) continue;
      const a = ocrAmountOnly_(lines[i]);
      if (a !== null && /rp/i.test(lines[i])) amounts.push(a);
      else if (a === null && ocrNameLine_(lines[i])) names.push({ name: lines[i], i: i });
    }
    const named = membersLine !== -1 ? ocrFirstIsMe_(names.map(function (n) { return n.name; }), amounts.length)
      : names.map(function (n) { return n.name; });
    if (named.length >= 2 && named.length === amounts.length) {
      people = named.map(function (n, k) { return { name: n, amount: amounts[k] }; });
    }
  }
  const splitWords = /split|patungan|members?\b|anggota|peserta/i.test(all);
  const isSplit = people.length >= 2 && (splitWords || issuers.indexOf('GoPay') !== -1);
  const sure = membersCount === null || membersCount === people.length;

  // Merchant: on split screens the line above the date; else the first line with words.
  const textLine = function (l, i) {
    return !used[i] && (l.match(/[a-z]/gi) || []).length >= 3 && !OCR_CHROME.test(l) && !ocrTotalRank_(l) &&
      !/rp\s*\d/i.test(l) && !/member|anggota|peserta/i.test(l) && !/^\d{1,2}[:.]\d{2}/.test(l);
  };
  let merchant = '';
  if (isSplit && date && date.index > 0 && textLine(lines[date.index - 1], date.index - 1)) merchant = lines[date.index - 1];
  if (!merchant) merchant = lines.filter(textLine)[0] || '';

  return {
    readable: lines.length > 0, issuer: issuers.join(' '), merchant: merchant, is_split_bill: isSplit,
    date: date ? date.ymd : null, date_confidence: 1,
    subtotal: subtotal, tax: null, service: null, discount: null, delivery: null,
    total: total, total_confidence: distinct.length > 1 ? 0.5 : 1,
    other_totals: distinct.filter(function (n) { return n !== total; }),
    items: [], payer: payerMatch ? payerMatch[1].trim() : null,
    participants: isSplit ? people.map(function (p) { return { name: p.name, amount: p.amount, confidence: sure ? 1 : 0.6 }; }) : []
  };
}

/** True when the rules found enough to start a flow (a total, or a split list). */
function ocrRulesOk_(ocr) {
  return !!ocr && (!!ocr.total || ocr.participants.length >= 2);
}

/**
 * Photo → text with Google Drive's OCR: upload as a Google Doc (Drive converts
 * the image), export the text, delete the temporary Doc. Throws on failure.
 */
function driveOcrText_(blob, mime) {
  const auth = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
  const boundary = 'moneta' + Date.now();
  const meta = JSON.stringify({ name: 'MonetaBot OCR ' + Date.now(), mimeType: 'application/vnd.google-apps.document' });
  const head = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta +
    '\r\n--' + boundary + '\r\nContent-Type: ' + (mime || 'image/jpeg') + '\r\n\r\n';
  const payload = Utilities.newBlob(head).getBytes().concat(blob.getBytes())
    .concat(Utilities.newBlob('\r\n--' + boundary + '--').getBytes());
  const up = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&ocrLanguage=id&fields=id', {
    method: 'post', contentType: 'multipart/related; boundary=' + boundary, payload: payload, headers: auth, muteHttpExceptions: true
  });
  if (up.getResponseCode() !== 200) {
    throw new Error('Google OCR upload HTTP ' + up.getResponseCode() + ' ' + up.getContentText().replace(/\s+/g, ' ').slice(0, 160));
  }
  const id = JSON.parse(up.getContentText()).id;
  try {
    const out = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id + '/export?mimeType=text/plain',
      { headers: auth, muteHttpExceptions: true });
    if (out.getResponseCode() !== 200) throw new Error('Google OCR export HTTP ' + out.getResponseCode());
    return out.getContentText('UTF-8');
  } finally {
    // The temporary Doc is the bot's own copy of the photo text; the photo itself is saved after Yes.
    UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id, { method: 'delete', headers: auth, muteHttpExceptions: true });
  }
}

const OCR_TEXT_PROMPT = 'The text below was read by OCR from a photo of a bill, receipt or payment screen (the layout may be ' +
  'scrambled: names and amounts of one row can be on separate lines).\n' + OCR_PROMPT.replace('You read a photo of a bill, receipt or payment screen from Indonesia. ', '');

// ---------------------------------------------------------------------------
// Photo in → reading → the right flow
// ---------------------------------------------------------------------------

/**
 * A photo (or image file) arrives: reply "Reading the bill…" and read it right
 * away with Google OCR + rules (a few seconds). Only when the AI is needed is
 * the job queued for the 1-minute cleanup trigger: Telegram waits just 60s
 * for the webhook, and a slow Gemini call got cut off (owner's first test).
 */
function handlePhoto_(message) {
  const chatId = String(message.chat.id);
  const file = message.photo && message.photo.length ? message.photo[message.photo.length - 1] : message.document;
  if (!file) return;
  const job = { chatId: chatId, fileId: file.file_id, mime: (message.document && message.document.mime_type) || 'image/jpeg',
    caption: message.caption || '', at: Date.now() };
  job.msgId = sendMessage(chatId, '🔍 Reading the bill…').message_id;
  runOcrJob_(job, cleanupTriggerInstalled_());
}

/** Hands a job (with the OCR text already read) to the cleanup trigger for the AI step. */
function queueOcrJob_(job) {
  withScriptLock_(function () { writeOcrQueue_(readOcrQueue_().concat([job])); });
  editMessage(job.chatId, job.msgId, '🔍 Reading the bill… (asking the AI, about a minute)');
  recordEvent_('ocr ' + job.chatId + ': queued for the AI');
}

/** True if the 1-minute cleanup trigger exists (checked once per 6 hours). */
function cleanupTriggerInstalled_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('cleanup_trigger_ok');
  if (hit !== null) return hit === '1';
  let ok = false;
  try {
    ok = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'cleanupMessages'; });
  } catch (err) {
    logError_('cleanupTriggerInstalled_', err); // can't tell → read the photo right away
  }
  cache.put('cleanup_trigger_ok', ok ? '1' : '0', 21600);
  return ok;
}

// The photo queue: Script Property (survives) + a cache copy ("[]" = empty, so the trigger exits at once).
function readOcrQueue_() {
  try { return JSON.parse(getProp_(PROP.OCR_QUEUE) || '[]'); } catch (err) { return []; }
}

function writeOcrQueue_(queue) {
  PropertiesService.getScriptProperties().setProperty(PROP.OCR_QUEUE, JSON.stringify(queue));
  CacheService.getScriptCache().put('ocr_queue', queue.length ? 'x' : '[]', 21600);
}

/**
 * Called first by the 1-minute cleanup trigger: reads queued photos (at most
 * ~4 minutes of work per run, the rest waits for the next run). Jobs being
 * read are kept in OCR_RUNNING; one still there after 7 minutes (the run
 * died, e.g. Gemini never answered) gets its message replaced with an error.
 */
function processOcrQueue_() {
  const cache = CacheService.getScriptCache();
  if (cache.get('ocr_queue') === '[]' && cache.get('ocr_running') === '[]') return;
  const started = Date.now();
  let jobs = [];
  withScriptLock_(function () {
    jobs = readOcrQueue_();
    if (jobs.length) writeOcrQueue_([]);
    const running = JSON.parse(getProp_(PROP.OCR_RUNNING) || '[]');
    const stale = running.filter(function (j) { return started - j.startedAt > 7 * 60000; });
    stale.forEach(function (j) {
      try {
        editMessage(j.chatId, j.msgId, '⚠️ Reading this bill took too long (the AI did not answer). Send it again, or type the entry, ' +
          'e.g. <code>85rb Indomaret BCA</code>.');
      } catch (err) { /* message gone */ }
      logError_('processOcrQueue_', new Error('OCR job did not finish'), j.chatId + ' ' + j.fileId);
    });
    const keep = running.filter(function (j) { return stale.indexOf(j) === -1; })
      .concat(jobs.map(function (j) { return Object.assign({}, j, { startedAt: started }); }));
    PropertiesService.getScriptProperties().setProperty(PROP.OCR_RUNNING, JSON.stringify(keep));
    cache.put('ocr_running', keep.length ? 'x' : '[]', 21600);
  });
  jobs.forEach(function (job, i) {
    if (Date.now() - started > 4 * 60000) {
      withScriptLock_(function () { writeOcrQueue_(readOcrQueue_().concat(jobs.slice(i))); }); // next minute
      jobs.length = i;
      return;
    }
    runOcrJob_(job);
    withScriptLock_(function () {
      const running = JSON.parse(getProp_(PROP.OCR_RUNNING) || '[]').filter(function (j) { return j.msgId !== job.msgId || j.chatId !== job.chatId; });
      PropertiesService.getScriptProperties().setProperty(PROP.OCR_RUNNING, JSON.stringify(running));
      cache.put('ocr_running', running.length ? 'x' : '[]', 21600);
    });
  });
}

/**
 * Reads one photo and starts the receipt or split-bill flow (edits the
 * "Reading the bill…" message). Order: Google OCR text → rules → Gemini with
 * the text (or the photo, if OCR failed) → the receipt flow asks for the
 * amount. mayQueue: the AI step goes to the cleanup trigger (webhook run).
 */
function runOcrJob_(job, mayQueue) {
  const chatId = job.chatId;
  const msgId = job.msgId;
  const image = { fileId: job.fileId, mime: job.mime };
  const caption = job.caption || '';
  // Progress goes to the recent-updates record (run showRecentUpdates), so a stuck run shows where it stopped.
  const t0 = Date.now();
  const step = function (text) { recordEvent_('ocr ' + chatId + ': ' + text + ' (' + Math.round((Date.now() - t0) / 1000) + 's)'); };
  try {
    step(job.text === undefined ? 'photo received' : 'AI step');
    let text = job.text;
    if (text === undefined) {
      text = '';
      try {
        const blob = downloadTelegramFile_(image.fileId);
        step('downloaded ' + Math.round(blob.getBytes().length / 1024) + ' KB');
        text = driveOcrText_(blob, image.mime).trim();
        step('Google OCR: ' + text.split('\n').length + ' lines · ' + text.replace(/\s+/g, ' ').slice(0, 120));
      } catch (err) {
        step('Google OCR failed: ' + err.message);
        logError_('driveOcrText_', err);
      }
    }
    let ocr = text ? normalizeOcr_(parseOcrText_(text)) : null;
    if (ocr) step('rules: total ' + ocr.total + ' · ' + ocr.participants.length + ' people · ' + ocr.merchant);
    if (!ocrRulesOk_(ocr) && getSettingYes_(SETTING.AI_ENABLED)) {
      if (mayQueue) return queueOcrJob_(Object.assign({}, job, { text: text }));
      let ai = null;
      try {
        if (text) {
          ai = normalizeOcr_(callGeminiJson_(OCR_TEXT_PROMPT + '\n\nText:\n' + text.slice(0, 6000), 'ocr', null, 2));
        } else {
          const blob = downloadTelegramFile_(image.fileId);
          ai = normalizeOcr_(callGeminiJson_(OCR_PROMPT, 'ocr', { mimeType: image.mime, data: Utilities.base64Encode(blob.getBytes()) }, 2));
        }
      } catch (err) {
        logError_('runOcrJob_', err);
      }
      step(ai ? 'AI answered · total ' + ai.total + ' · ' + ai.participants.length + ' people' : 'AI gave no answer (see Logs)');
      if (ai && ai.readable && (ai.total || ai.participants.length)) ocr = ai;
    }
    if (!ocr || !ocr.readable) {
      return editMessage(chatId, msgId, "😕 I couldn't read this bill. Send a clearer photo, or type it, e.g. <code>85rb Indomaret BCA</code>." +
        '\n<i>(The reason is in the Logs tab.)</i>');
    }
    const ctx = loadCtx_();
    const route = ocrRoute_(ocr, caption);
    step('route ' + route + ' · ' + ocr.merchant + ' · total ' + ocr.total);
    if (route === 'split') return startOcrSplit_(chatId, msgId, ocr, caption, image, ctx);
    startOcrReceipt_(chatId, msgId, ocr, caption, image, ctx);
  } catch (err) {
    // Never leave "Reading the bill…" hanging: say what went wrong.
    step('error: ' + err.message);
    logError_('handlePhoto_', err);
    try {
      editMessage(chatId, msgId, '⚠️ Something went wrong while reading the bill: ' + escapeHtml_(err.message) +
        '\nTry again, or type the entry instead.');
    } catch (e) { /* the doPost error message still goes out */ }
  }
}

function startOcrReceipt_(chatId, msgId, ocr, caption, image, ctx) {
  const r = buildReceiptDraft_(ocr, caption, ctx, new Date(), image);
  if (!r.ok) return editMessage(chatId, msgId, parseErrorText_(r));
  const p = newPending_(chatId, 'trx', r.d);
  p.msgId = msgId;
  p.orig = r.d.category;
  if (!r.d.amount && !r.d.amountOptions) {
    p.awaitText = 'amount';
    return showStep_(p, r.d.ocrHeader + "\n😕 I couldn't find the total. Send the amount, e.g. <code>85rb</code>.", [[btn_(p, '❌ Cancel', 'n')]]);
  }
  advanceTrx_(p, ctx);
}

// ---------------------------------------------------------------------------
// GoPay Split Bill steps (pending kind 'ocr')
// ---------------------------------------------------------------------------

function startOcrSplit_(chatId, msgId, ocr, caption, image, ctx) {
  const cap = parseCaption_(caption, ctx);
  if (!cap.ok) return editMessage(chatId, msgId, parseErrorText_(cap));
  const now = new Date();
  const date = cap.dateGiven ? cap.date : (ocrDate_(ocr.date, now) || now);
  const p = newPending_(chatId, 'ocr', {
    merchant: ocr.merchant || 'Split bill', issuer: ocr.issuer, date: date.getTime(), total: ocr.total, payer: ocr.payer,
    people: ocr.participants.map(function (x) { return { raw: x.name, amount: x.amount, confidence: x.confidence, name: null, known: false }; }),
    totalConfidence: ocr.totalConfidence, meIdx: null, meHow: '', payerIdx: null, mismatchOk: false, dupOk: false, paidBack: null,
    wallet: cap.wallet, walletChoices: cap.walletChoices, walletHow: cap.wallet ? 'mentioned' : '', category: cap.category || null,
    categoryHow: cap.categoryHow || '', capNote: cap.note || '', image: image, type: 'Expense', note: ocr.merchant || 'Split bill'
  });
  p.msgId = msgId;
  advanceOcrSplit_(p, ctx);
}

function ocrSplitTitle_(d) {
  return '🧾 <b>GoPay Split Bill</b> · ' + escapeHtml_(d.merchant) + ' · ' + formatDate_(d.date) +
    (d.total ? ' · Total ' + formatRp_(d.total) : '');
}

function advanceOcrSplit_(p, ctx) {
  const d = p.d;
  p.awaitText = null;
  const title = ocrSplitTitle_(d);
  const list = d.people.map(function (x, i) { return (i + 1) + '. ' + escapeHtml_(x.raw) + ' · ' + formatRp_(x.amount); }).join('\n');

  // 1. Which participant is me (my GoPay name from Users; asked and remembered otherwise).
  if (d.meIdx === null) {
    const user = getUserByChatId_(p.chatId);
    const hits = findMeIndexes_(d.people.map(function (x) { return { name: x.raw }; }), user ? user.gopayName : '');
    if (hits.length === 1) { d.meIdx = hits[0]; d.meHow = 'auto'; }
    else {
      p.opts = d.people.map(function (x) { return x.raw; });
      const rows = chunk_(d.people.map(function (x, i) { return btn_(p, x.raw, 'me', i); }), 2);
      rows.push([btn_(p, "🙅 I'm not in this bill", 'me', -1)], cancelRow_(p));
      return showStep_(p, title + '\n' + list + '\n\n👤 Which one is you?' +
        (hits.length > 1 ? ' (several have your GoPay name)' : '\n<i>I\'ll remember it as your GoPay name.</i>'), rows);
    }
  }
  // 2. Who paid the whole bill.
  if (d.payerIdx === null) {
    const user = getUserByChatId_(p.chatId);
    const byName = d.payer ? d.people.map(function (x, i) { return favKey_(x.raw) === favKey_(d.payer) ? i : -1; })
      .filter(function (i) { return i !== -1; }) : [];
    if (byName.length === 1) d.payerIdx = byName[0];
    else if (d.payer && user && favKey_(d.payer) === favKey_(user.gopayName) && d.meIdx !== -1) d.payerIdx = d.meIdx;
    else {
      const rows = chunk_(d.people.map(function (x, i) { return btn_(p, (i === d.meIdx ? '🙋 Me' : x.raw), 'pay', i); }), 2);
      if (d.meIdx === -1) rows.push([btn_(p, '🙋 Me', 'pay', -1)]);
      rows.push(cancelRow_(p));
      return showStep_(p, title + '\n' + list + '\n\n💳 Who paid the whole bill?', rows);
    }
  }
  const iPaid = d.payerIdx === d.meIdx;
  if (d.meIdx === -1 && !iPaid) return finishStep_(p, title + "\nYou're not in this bill and didn't pay it, so there's nothing to log. 👍");

  // 3. Shares vs total.
  const sum = d.people.reduce(function (s, x) { return s + x.amount; }, 0);
  if (!d.total) d.total = sum;
  if (Math.abs(sum - d.total) > 1 && !d.mismatchOk) {
    const diff = d.total - sum;
    const rows = [[btn_(p, 'Total = shares (' + formatRp_(sum) + ')', 'mm', 'sum')]];
    if (d.meIdx !== -1) rows.push([btn_(p, (diff > 0 ? 'Add ' : 'Take ') + formatRp_(Math.abs(diff)) + (diff > 0 ? ' to' : ' from') + ' my share', 'mm', 'me')]);
    rows.push(cancelRow_(p));
    return showStep_(p, title + '\n' + list + '\n\n⚠️ The shares add up to ' + formatRp_(sum) + ', the total is ' + formatRp_(d.total) +
      ' (difference ' + formatRp_(Math.abs(diff)) + '). Which is right?', rows);
  }
  // 4. Names → contacts (only the people that become records: everyone else when I paid, the payer otherwise).
  const needNames = iPaid ? d.people.map(function (x, i) { return i; }).filter(function (i) { return i !== d.meIdx; }) : [d.payerIdx];
  // Known contacts (or aliases) first; several unknown names → one question for all of them.
  needNames.forEach(function (i) {
    const x = d.people[i];
    const c = x.name ? null : findContact_(ctx.contacts, x.raw);
    if (c) { x.name = c.name; x.known = true; }
  });
  const unknown = needNames.filter(function (i) { return !d.people[i].name; });
  if (unknown.length > 1 && !d.oneByOne) {
    return showStep_(p, title + '\n\n👥 New names: <b>' + escapeHtml_(unknown.map(function (i) { return d.people[i].raw; }).join(', ')) + '</b>',
      [[btn_(p, '👤 Add all as new contacts', 'nmall')], [btn_(p, '🔗 Match one by one', 'nm1')], cancelRow_(p)]);
  }
  for (let k = 0; k < needNames.length; k++) {
    const x = d.people[needNames[k]];
    if (x.name) continue;
    const c = findContact_(ctx.contacts, x.raw);
    if (c) { x.name = c.name; x.known = true; continue; }
    p.opts = [x.raw].concat(ctx.contacts.map(function (c2) { return c2.name; }).slice(0, 8));
    d.askIdx = needNames[k];
    const rows = [[btn_(p, '👤 New contact: ' + x.raw.slice(0, 30), 'nm', 0)]]
      .concat(chunk_(p.opts.slice(1).map(function (n, i) { return btn_(p, n, 'nm', i + 1); }), 3));
    rows.push(cancelRow_(p));
    return showStep_(p, title + '\n\n👥 Who is <b>' + escapeHtml_(x.raw) + '</b>? Pick a contact (I\'ll remember the GoPay name) or make a new one.', rows);
  }
  // 5. Already logged?
  if (!d.dupOk) {
    const dup = findSplitDuplicate_(loadTransactions_(ctx.ss), d);
    if (dup) {
      return showStep_(p, title + '\n\n⚠️ This looks already logged (' + escapeHtml_(dup['trx id']) + ', same merchant and date). Save it again?',
        [[btn_(p, '💾 Save again', 'dup'), btn_(p, '❌ Cancel', 'n')]]);
    }
  }
  const myShare = d.meIdx === -1 ? 0 : d.people[d.meIdx].amount;
  const note = [d.merchant, d.capNote].filter(String).join(' · ');
  if (!d.category && myShare > 0) {
    const k = matchKeyword_(d.merchant, ctx.categories, ['Expense']);
    if (k) { d.category = k.category; d.categoryHow = 'keyword'; }
  }

  // 6a. I paid → the Phase 4 split flow (my share Expense, the others Piutang).
  if (iPaid) {
    const others = d.people.filter(function (x, i) { return i !== d.meIdx; });
    const q = newPending_(p.chatId, 'debt', {
      ok: true, kind: 'split', debtType: 'Piutang', term: 'Short', date: d.date, due: null, dateNeedsConfirm: false,
      wallet: d.wallet, walletChoices: d.walletChoices, note: note, id: null, full: false, group: false, includeMe: d.meIdx !== -1,
      category: d.category, categoryHow: d.categoryHow, total: d.total, me: myShare, needsTotal: false,
      people: others.map(function (x) { return { name: x.name, known: x.known, amount: x.amount }; }),
      inputSource: 'OCR-GoPay', image: d.image, ocrHeader: title + (d.meHow === 'auto' ? '' : '\n👤 You: ' + escapeHtml_(d.people[d.meIdx] ? d.people[d.meIdx].raw : '—'))
    });
    q.msgId = p.msgId;
    return stepDebt_(q, Object.assign(ctx, { debts: loadDebts_(ctx.ss) }));
  }
  // 6b. Someone else paid: not paid back yet (Hutang) or already paid (Expense)?
  const payer = d.people[d.payerIdx];
  if (!d.paidBack) {
    return showStep_(p, title + '\n\n' + escapeHtml_(payer.name || payer.raw) + ' paid the bill. Your share: <b>' + formatRp_(myShare) + '</b>.',
      [[btn_(p, '⏳ Not paid back yet → Hutang', 'pb', 'no')], [btn_(p, '✅ Already paid them → Expense', 'pb', 'yes')], cancelRow_(p)]);
  }
  if (d.paidBack === 'yes') {
    const q = newPending_(p.chatId, 'trx', {
      type: 'Expense', amount: myShare, date: d.date, wallet: d.wallet, walletChoices: d.walletChoices, walletHow: d.walletHow,
      category: d.category, categoryHow: d.categoryHow, note: note + ' (paid back to ' + (payer.name || payer.raw) + ')',
      extra: null, feeChecked: true, inputSource: 'OCR-GoPay', image: d.image, ocrHeader: title
    });
    q.msgId = p.msgId;
    q.orig = d.category;
    return advanceTrx_(q, ctx);
  }
  // Only a Hutang to the payer: no money moved, so no wallet change and no expense yet (owner, 2026-11-02).
  // The category is kept on the Hutang record; paying it back counts my share as an Expense then (saveDebt_ 'pay').
  d.amount = myShare;
  d.note = note;
  if (!d.category) return askCategory_(p, ctx);
  if (!findWallet_(everydayWallets_(ctx.wallets, ctx.investmentGroups), d.wallet)) return askWallet_(p, ctx, 'wallet');
  if (isMonthClosed_(ctx.ss, d.date)) {
    return showStep_(p, "⛔ That month is closed, so entries can't be dated in it. Use today's date?",
      [[btn_(p, '📅 Use today', 'today'), btn_(p, '❌ Cancel', 'n')]]);
  }
  showStep_(p, [title, '',
    '🤝 <b>Preview · Hutang</b> <b>' + formatRp_(myShare) + '</b> to ' + escapeHtml_(payer.name) + (payer.known ? '' : ' <i>(new contact)</i>'),
    '📂 Category: ' + escapeHtml_(d.category) + ' <i>(counted as Expense when you pay it back)</i>',
    '👛 Wallet: ' + escapeHtml_(d.wallet) + ' <i>(nothing moves now; paying back takes it from here)</i>',
    '📅 ' + formatDate_(d.date), '', 'Save?'].join('\n'),
    [[btn_(p, '✅ Yes', 'y'), btn_(p, '❌ No', 'n')], [btn_(p, '📂 Category', 'cat'), btn_(p, '👛 Wallet', 'wal')]]);
}

function ocrCallback_(p, action, arg, user) {
  const d = p.d;
  if (action === 'n') return finishStep_(p, '❌ Cancelled. Nothing was saved.');
  const ctx = loadCtx_();
  switch (action) {
    case 'me':
      d.meIdx = Number(arg);
      d.meHow = 'chosen';
      // Remembered for next time (not "Me" — that one is recognised anyway).
      if (d.meIdx >= 0 && OCR_ME_NAMES.indexOf(favKey_(d.people[d.meIdx].raw)) === -1) setUserGopayName_(p.chatId, d.people[d.meIdx].raw);
      break;
    case 'pay': d.payerIdx = Number(arg); break;
    case 'mm':
      if (arg === 'sum') d.total = d.people.reduce(function (s, x) { return s + x.amount; }, 0);
      else d.people[d.meIdx].amount += d.total - d.people.reduce(function (s, x) { return s + x.amount; }, 0);
      d.mismatchOk = true;
      break;
    case 'nm': {
      const x = d.people[d.askIdx];
      const i = Number(arg);
      if (i === 0) { x.name = x.raw; x.known = false; }
      else {
        x.name = p.opts[i];
        x.known = true;
        try { addContactAlias_(ctx.ss, x.name, x.raw); } catch (err) { logError_('addContactAlias_', err); }
        ctx.contacts = loadContacts_(ctx.ss);
      }
      break;
    }
    case 'dup': d.dupOk = true; break;
    case 'nmall': d.people.forEach(function (x, i) { if (!x.name && i !== d.meIdx) { x.name = x.raw; x.known = false; } }); break;
    case 'nm1': d.oneByOne = true; break;
    case 'pb': d.paidBack = arg; break;
    case 'c': d.category = p.opts[Number(arg)]; d.categoryHow = 'chosen'; break;
    case 'w': d.wallet = p.opts[Number(arg)]; d.walletChoices = null; d.walletHow = 'chosen'; break;
    case 'cat': return askCategory_(p, ctx);
    case 'wal': return askWallet_(p, ctx, 'wallet');
    case 'today': d.date = Date.now(); break;
    case 'y': return saveOcrHutang_(p, ctx, user);
  }
  advanceOcrSplit_(p, ctx);
}

/**
 * Someone else paid and I owe them: a Hutang record (with my share's category)
 * + one Hutang row with Direction None (no wallet change, not an expense; the
 * Debts "Converted" formula skips Hutang rows). Paying it back is the Expense.
 */
function saveOcrHutang_(p, ctx, user) {
  const d = p.d;
  if (!claimPending_(p)) return;
  const ss = ctx.ss;
  const payer = d.people[d.payerIdx];
  const loggedBy = user && user.name ? user.name : p.chatId;
  const saved = withScriptLock_(function () {
    const id = nextId_(ss.getSheetByName(TAB.DEBTS), 'Debt ID', DEBT_PREFIX.Hutang, 3);
    writeDebtRecord_(ss, { id: id, type: 'Hutang', term: 'Short', name: payer.name, date: d.date, due: null,
      wallet: d.wallet, amount: d.amount, category: d.category });
    const trxId = writeTransaction_(ss, { type: 'Hutang', direction: 'None', amount: d.amount, wallet: d.wallet, debtId: id,
      date: d.date, inputSource: 'OCR-GoPay', note: 'Split bill ' + d.note + ', paid by ' + payer.name }, loggedBy, '');
    return { id: id, trxId: trxId };
  });
  if (!payer.known) addContact_(ss, payer.name, []);
  let text = '✅ Saved <b>' + saved.id + '</b>: hutang ' + formatRp_(d.amount) + ' to ' + escapeHtml_(payer.name) + ' (' + saved.trxId + ').' +
    '\nNothing left your wallet yet. When you pay it back (e.g. <code>bayar hutang ' + escapeHtml_(payer.name) + ' ' +
    formatRp_(d.amount).replace('Rp', '') + ' ' + escapeHtml_(d.wallet) + '</code>), it counts as Expense · ' + escapeHtml_(d.category) + '.' +
    (payer.known ? '' : '\n👤 Added to Contacts: ' + escapeHtml_(payer.name) + '.');
  text += attachReceiptText_(ss, [saved.trxId], d.image, d.date, d.merchant);
  editMessage(p.chatId, p.msgId, text);
}

/** Same merchant + date already logged from a split bill (Input Source OCR-GoPay). */
function findSplitDuplicate_(rows, d) {
  const merchant = favKey_(d.merchant);
  const day = midnight_(d.date).getTime();
  return rows.filter(function (r) {
    return String(r['input source']).trim() === 'OCR-GoPay' && r['date'] instanceof Date && midnight_(r['date']).getTime() === day &&
      favKey_(r['note']).indexOf(merchant) !== -1;
  })[0] || null;
}

/** Writes the sender's GoPay Name into Settings → Users (the row with their Chat ID). */
function setUserGopayName_(chatId, name) {
  try {
    const sheet = openMainSheet_().getSheetByName(TAB.SETTINGS);
    const row = readTableByHeaders_(sheet, 'Chat ID').filter(function (r) { return String(r['chat id']).trim() === String(chatId); })[0];
    if (!row) return;
    withScriptLock_(function () { writeRowsByHeaders_(sheet, row._row, [{ 'GoPay Name': name }]); });
    clearConfigCache();
  } catch (err) {
    logError_('setUserGopayName_', err);
  }
}

// ---------------------------------------------------------------------------
// Saving the image (after Yes only)
// ---------------------------------------------------------------------------

/**
 * Downloads the photo again, saves it as Receipts/yyyy-MM/[TrxID]_[date]_[merchant].ext
 * and links it on every row (Image Link → "View receipt"). Returns the text to
 * add to the success message. Never throws: a failure keeps the entry, is
 * logged, and the message says so.
 */
function attachReceiptText_(ss, trxIds, image, date, merchant) {
  if (!image) return '';
  try {
    const blob = downloadTelegramFile_(image.fileId);
    const day = Utilities.formatDate(new Date(date), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const ext = /png/i.test(image.mime) ? '.png' : /webp/i.test(image.mime) ? '.webp' : /heic|heif/i.test(image.mime) ? '.heic' : '.jpg';
    const safe = String(merchant || 'receipt').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'receipt';
    blob.setName(trxIds[0] + '_' + day + '_' + safe + ext);
    const file = receiptsMonthFolder_(date).createFile(blob);
    setImageLinks_(ss, trxIds, file.getUrl());
    return ' <a href="' + escapeHtml_(file.getUrl()) + '">🧾 View receipt</a>';
  } catch (err) {
    logError_('attachReceiptText_', err, trxIds.join(', '));
    return "\n⚠️ The entry is saved, but the image couldn't be saved to Drive (details in the Logs tab).";
  }
}

/** The Receipts folder (Script Property RECEIPTS_FOLDER_ID; created as MonetaBot/Receipts if not set) → its yyyy-MM subfolder. */
function receiptsMonthFolder_(date) {
  let root = null;
  const id = getProp_(PROP.RECEIPTS_FOLDER_ID);
  if (id) {
    try { root = DriveApp.getFolderById(id); } catch (err) { root = null; }
  }
  if (!root) {
    const parents = DriveApp.getRootFolder().getFoldersByName('MonetaBot');
    const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
    const found = parent.getFoldersByName('Receipts');
    root = found.hasNext() ? found.next() : parent.createFolder('Receipts');
    PropertiesService.getScriptProperties().setProperty(PROP.RECEIPTS_FOLDER_ID, root.getId());
  }
  const month = Utilities.formatDate(new Date(date), Session.getScriptTimeZone(), 'yyyy-MM');
  const sub = root.getFoldersByName(month);
  return sub.hasNext() ? sub.next() : root.createFolder(month);
}

/** Image Link = a clickable "View receipt" on these Transactions rows (rich text: no locale trouble with formulas). */
function setImageLinks_(ss, trxIds, url) {
  const sheet = ss.getSheetByName(TAB.TRANSACTIONS);
  const map = getHeaderMap_(sheet);
  if (map['image link'] === undefined) return;
  const n = sheet.getLastRow() - 1;
  if (n < 1) return;
  const ids = sheet.getRange(2, map['trx id'] + 1, n, 1).getValues();
  const link = SpreadsheetApp.newRichTextValue().setText('View receipt').setLinkUrl(url).build();
  ids.forEach(function (r, i) {
    if (trxIds.indexOf(String(r[0]).trim()) !== -1) sheet.getRange(i + 2, map['image link'] + 1).setRichTextValue(link);
  });
}

/** The Drive link on any of these Transactions rows (for /undo), or ''. */
function imageUrlOfRows_(ss, rows) {
  const sheet = ss.getSheetByName(TAB.TRANSACTIONS);
  const col = getHeaderMap_(sheet)['image link'];
  if (col === undefined) return '';
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i]['image link'] || '').trim() === '') continue;
    try {
      const url = sheet.getRange(rows[i]._row, col + 1).getRichTextValue().getLinkUrl();
      if (url) return url;
    } catch (err) {
      logError_('imageUrlOfRows_', err);
    }
  }
  return '';
}

/** Drive file ID from a link (…/d/<id>/… or …?id=<id>). */
function driveIdFromUrl_(url) {
  const m = String(url || '').match(/\/d\/([\w-]{10,})/) || String(url || '').match(/[?&]id=([\w-]{10,})/);
  return m ? m[1] : '';
}

/** After an /undo removed a receipt entry: also trash the image? */
function askUndoImage_(chatId, url) {
  const p = newPending_(chatId, 'undoimg', { url: url });
  showStep_(p, '🧾 Also delete the receipt image?', [[btn_(p, '🗑️ Yes, delete it', 'y'), btn_(p, '📁 Keep it', 'n')]]);
}

function undoImageCallback_(p, action) {
  if (action !== 'y') return finishStep_(p, '📁 Kept the receipt image in Drive.');
  try {
    DriveApp.getFileById(driveIdFromUrl_(p.d.url)).setTrashed(true);
    finishStep_(p, '🗑️ The receipt image is in the Drive trash (you can restore it there for 30 days).');
  } catch (err) {
    logError_('undoImageCallback_', err);
    finishStep_(p, "⚠️ I couldn't delete the image (details in the Logs tab). It's still in the Receipts folder.");
  }
}

/** /setreceipts <folder link>: use that Drive folder for receipt images. */
function setReceiptsFolder_(chatId, args) {
  const id = driveIdFromUrl_(args) || (String(args).match(/folders\/([\w-]{10,})/) || [])[1] || '';
  if (!id) {
    const cur = getProp_(PROP.RECEIPTS_FOLDER_ID);
    return sendMessage(chatId, 'Send the folder link: <code>/setreceipts https://drive.google.com/drive/folders/…</code>' +
      (cur ? '\nNow using: https://drive.google.com/drive/folders/' + escapeHtml_(cur) : '\nNow: not set (a MonetaBot/Receipts folder is made on the first receipt).'));
  }
  try {
    const folder = DriveApp.getFolderById(id);
    PropertiesService.getScriptProperties().setProperty(PROP.RECEIPTS_FOLDER_ID, id);
    sendMessage(chatId, '✅ Receipt images now go to <b>' + escapeHtml_(folder.getName()) + '</b> (one subfolder per month).');
  } catch (err) {
    sendMessage(chatId, "⚠️ I can't open that folder. Make sure the link is a Drive folder that your Google account (the bot's owner) can edit.");
  }
}
