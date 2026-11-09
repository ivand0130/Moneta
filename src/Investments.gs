/**
 * Investments.gs — investment purchases, price updates, FIFO sales, /inv (SPEC Section 8).
 *
 *   beli emas 2gr 1.350rb/gr            beli BBCA 2 lot 9.800/lembar dari IPOT fee 3rb
 *   jual BBCA 5 lot harga 10.200 ke BCA /inv update BBCA 9.800  (or one asset per line)
 *   /inv  /inv emas  /inv sell
 *
 * Owner's decisions (Phase 6):
 * - The category wallet's Wallet Type sets the unit: Emas → gram, Saham →
 *   lot (Quantity in LOTS, prices per LEMBAR as on IDX: value = lot × 100 ×
 *   price; "200 lembar" / "200 lbr" = 2 lot), Others → what was typed (unit,
 *   coin, nominal…), default unit. lotMult_() is the ×100.
 * - Buying pays from, and selling pays into, a wallet in an "Investment
 *   Source Groups" group (default "Investment Wallet"); a wallet can be in
 *   several groups ("Spending, Investment Wallet").
 * - A value on its own ("10jt") is the TOTAL; a value with a unit ("10jt/gr",
 *   "5000/lembar", "harga 5000", "@5000") is the price per unit.
 * - A buy fee goes into the cost: Acquisition Cost = qty × price + fee and
 *   Acquisition Price = cost / (qty × lotMult), so gain/loss includes it. A sale fee is in
 *   Investment_Sales → Fees (reduces Realized Gain); the wallet gets proceeds − fee.
 * - No source wallet written → the one of the last purchase of that asset
 *   (else category), shown in the preview; asked only if there is none.
 * - "nominal" assets (deposito, SBR): Quantity = the Rupiah amount, price 1;
 *   in /inv update the number is the asset's new TOTAL value.
 * - Quantity is the REMAINING quantity (sales reduce it); Acquisition Cost
 *   keeps the original total. Current Value / Gain formulas use Quantity.
 *
 * Money moves: a buy is a Transactions row "Investment Buy" (Direction
 * Transfer, source wallet → category wallet); a sale is "Investment Sell"
 * (category wallet → destination). Neither is income or expense. The category
 * wallet's balance comes from the Investments tab (Wallets formula).
 */

const INV_BUY_WORDS = ['beli', 'buy', 'invest', 'investasi'];
const INV_SELL_WORDS = ['jual', 'sell', 'cairkan', 'redeem'];
const INV_UNIT_WORDS = { lot: 'lot', lots: 'lot', lembar: 'share', lbr: 'share', share: 'share', shares: 'share', gr: 'gram', g: 'gram',
  gram: 'gram', grams: 'gram', unit: 'unit', units: 'unit', up: 'unit', coin: 'coin', coins: 'coin', koin: 'coin', nominal: 'nominal' };
const INV_PRICE_WORDS = ['harga', 'price', 'at', '@', 'seharga_per'];
const INV_TOTAL_WORDS = ['total', 'senilai', 'sebesar', 'seharga', 'sejumlah'];
const INV_FEE_WORDS = ['fee', 'admin', 'biaya', 'komisi'];
const INV_PLATFORM_WORDS = ['via', 'lewat', 'platform', 'di'];
const INV_ALL_WORDS = ['semua', 'all', 'semuanya'];
const INV_FILLERS = ['ke', 'dari', 'to', 'from', 'pakai', 'pake', 'broker', 'per', 'sebanyak', 'aset', 'asset'];
const SHARES_PER_LOT = 100;

/** Shares per stored unit: a lot is 100 lembar (prices are per lembar), everything else 1. */
function lotMult_(unit) {
  return unit === 'lot' ? SHARES_PER_LOT : 1;
}
const INV_PRICE_JUMP = 0.3; // warn when a new price is more than 30% away from the last one

// ---------------------------------------------------------------------------
// Numbers (pure)
// ---------------------------------------------------------------------------

/**
 * "1.234,56" / "150,5" / "0.005" / "1.000" / "50,000" → number; null if unreadable.
 * A dot (or comma) followed by groups of exactly 3 digits = thousands, unless it
 * starts with 0; otherwise it is a decimal point.
 */
function parseDecimalId_(s) {
  s = String(s);
  if (!/^\d[\d.,]*$/.test(s) || /[.,]$/.test(s)) return null;
  const dots = (s.match(/\./g) || []).length;
  const commas = (s.match(/,/g) || []).length;
  if (dots && commas) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      return /^\d{1,3}(\.\d{3})+,\d+$/.test(s) ? Number(s.replace(/\./g, '').replace(',', '.')) : null;
    }
    return /^\d{1,3}(,\d{3})+\.\d+$/.test(s) ? Number(s.replace(/,/g, '')) : null;
  }
  if (!dots && !commas) return Number(s);
  const sep = dots ? '.' : ',';
  const thousands = sep === '.' ? /^[1-9]\d{0,2}(\.\d{3})+$/ : /^[1-9]\d{0,2}(,\d{3})+$/;
  if (thousands.test(s)) return Number(s.split(sep).join(''));
  return s.split(sep).length === 2 ? Number(s.replace(sep, '.')) : null;
}

/** "rp1.350rb" / "1,5jt" / "9.800" / "1.520,35" → number (Rupiah, may have decimals); null if not a number. */
function parseInvNumber_(s) {
  const m = String(s).toLowerCase().replace(/^rp\.?/, '').match(/^([\d.,]+)(k|rb|ribu|jt|juta)?$/);
  if (!m) return null;
  const n = parseDecimalId_(m[1]);
  if (n === null) return null;
  return roundInv_(n * (m[2] ? AMOUNT_UNITS[m[2]] : 1));
}

function roundInv_(n) {
  return Math.round(n * 1e8) / 1e8;
}

/** Indonesian number: 1234.5 → "1.234,5" (up to `dec` decimals, default 4). */
function formatNumId_(n, dec) {
  const v = roundInv_(Number(n) || 0);
  const fixed = Math.abs(v).toFixed(dec === undefined ? 4 : dec).replace(/\.?0+$/, '');
  const parts = fixed.split('.');
  return (v < 0 ? '−' : '') + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (parts[1] ? ',' + parts[1] : '');
}

/** Rp with up to 2 decimals (NAV prices): "Rp1.520,35". */
function formatRpDec_(n) {
  return 'Rp' + formatNumId_(n, 2);
}

function unitLabel_(unit) {
  return { gram: 'gr', share: 'lembar', lot: 'lot', unit: 'unit', coin: 'coin', nominal: '' }[unit] || unit || '';
}

/** "2 lot" / "0,5 gr" / "Rp5.000.000" (nominal). */
function formatQty_(qty, unit) {
  if (unit === 'nominal') return formatRp_(qty);
  return formatNumId_(qty, 8) + (unit ? ' ' + unitLabel_(unit) : '');
}

/** Price per stored unit as text: "Rp9.800/lembar" / "Rp1.350.000/gr" / "" (nominal). Old lot rows: per share + per lot. */
function formatInvPrice_(price, unit) {
  if (unit === 'nominal') return '';
  if (unit === 'lot' || unit === 'share') return formatRpDec_(price) + '/lembar';
  return formatRpDec_(price) + '/' + unitLabel_(unit);
}

/** A price as you would type it in /inv update (lot assets: per lembar). */
function typedPrice_(price, unit) {
  return formatNumId_(price, 2);
}

/** A typed price → the stored price (stocks: per lembar, so "/lot" ÷100). */
function storedPrice_(typed, suffix, unit) {
  if (typed === null || typed === undefined) return null;
  if ((unit === 'lot' || unit === 'share') && suffix === 'lot') return roundInv_(typed / SHARES_PER_LOT); // "980rb/lot" = Rp9.800/lembar
  return typed;
}

/** "Emas 3 jt/ gr" → "Emas 3jt/gr", "Rp 10jt" → "Rp10jt", "1.350 rb" → "1.350rb" (before tokenizing). */
function normalizeInvText_(text) {
  return String(text || '')
    .replace(/[ \t]*\/[ \t]*/g, '/')
    .replace(/\b(rp\.?)[ \t]+(?=\d)/gi, '$1')
    .replace(/(\d)[ \t]+(rb|ribu|k|jt|juta)(?=\/|\s|$)/gi, '$1$2');
}

/** The unit an investment wallet's type implies: Emas → gram, Saham → lot, Others → '' (typed / default unit). */
function kindUnit_(kind) {
  return kind === 'Emas' ? 'gram' : kind === 'Saham' ? 'lot' : '';
}

/**
 * The unit of a buy: from the category's Wallet Type (Emas, Saham), else the
 * asset's earlier rows, else what was typed ("lot" → share), else "unit".
 */
function unitFor_(wallets, category, assetUnit, typedUnit) {
  const w = findWallet_(wallets || [], category);
  const byKind = kindUnit_(w ? w.kind : '');
  if (byKind) return byKind;
  if (assetUnit === 'share' || assetUnit === 'lot') return 'lot';
  if (assetUnit) return assetUnit;
  if (typedUnit === 'lot' || typedUnit === 'share') return 'lot';
  return typedUnit || (w ? 'unit' : '');
}

// ---------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------

/** Investments rows. holding = still has quantity (Status not Sold). */
function loadInvestments_(ss) {
  const sheet = ss.getSheetByName(TAB.INVESTMENTS);
  if (sheet === null) return [];
  return readTableByHeaders_(sheet, 'Asset Name').map(invFromRow_);
}

function invFromRow_(r) {
  const n = function (k) { const v = r[k]; return typeof v === 'number' ? v : (parseDecimalId_(String(v || '').trim()) || 0); };
  const unitRaw = String(r['unit'] || '').trim().toLowerCase();
  const qty = n('quantity');
  const status = String(r['status'] || '').trim();
  const cur = r['current price'];
  return {
    id: String(r['inv id'] || '').trim(), link: String(r['link id'] || '').trim(),
    date: dateOrNull_(r['investment date']), category: String(r['investment category'] || '').trim(),
    // The investment wallet holding it (drives the wallet balance); rows from before have only the category = wallet.
    invWallet: String(r['investment wallet'] || r['investment category'] || '').trim(),
    asset: String(r['asset name'] || '').trim(), platform: String(r['platform'] || '').trim(),
    unit: INV_UNIT_WORDS[unitRaw] || unitRaw, qty: qty, price: n('acquisition price'), cost: n('acquisition cost'),
    current: cur === '' || cur === null || cur === undefined ? null : n('current price'),
    lastUpdate: dateOrNull_(r['last price update']), source: String(r['source wallet'] || '').trim(),
    status: status, holding: qty > 0 && !/^sold$/i.test(status), row: r._row
  };
}

/** The price the value uses: current price, else acquisition price (same rule as the sheet formula). */
function invPriceNow_(x) {
  return x.current !== null ? x.current : x.price;
}

/**
 * Rows typed in the sheet: missing Inv ID → INV-xxxx, missing Status →
 * Holding, missing Acquisition Cost → qty × price. Call inside the lock.
 */
function ensureInvestmentRows_(ss) {
  const sheet = ss.getSheetByName(TAB.INVESTMENTS);
  if (sheet === null || sheet.getLastRow() < 2) return;
  const rows = loadInvestments_(ss);
  const fix = rows.filter(function (x) { return !x.id || !x.status || (!x.cost && x.qty && x.price); });
  if (fix.length === 0) return;
  let max = 0;
  rows.forEach(function (x) { const m = x.id.match(/^INV-(\d+)$/i); if (m) max = Math.max(max, Number(m[1])); });
  fix.forEach(function (x) {
    const values = {};
    if (!x.id) values['Inv ID'] = 'INV-' + String(++max).padStart(4, '0');
    if (!x.status) values['Status'] = x.qty > 0 ? 'Holding' : 'Sold';
    if (!x.cost && x.qty && x.price) values['Acquisition Cost'] = roundInv_(x.qty * lotMult_(x.unit) * x.price);
    writeRowsByHeaders_(sheet, x.row, [values]);
  });
}

/** Latest Price_History price per Inv ID: { 'INV-0001': price }. */
function lastHistoryPrices_(ss) {
  const sheet = ss.getSheetByName(TAB.PRICES);
  const out = {};
  if (sheet === null) return out;
  readTableByHeaders_(sheet, 'Inv ID').forEach(function (r) { out[String(r['inv id']).trim()] = Number(r['price']); });
  return out;
}

/**
 * Prices typed directly in the Investments tab: a holding row whose Current
 * Price differs from its last Price_History price gets a history row (Source
 * "Sheet Edit") and Last Price Update = today. Rows typed without an Inv ID /
 * Status / Acquisition Cost get them. Reads the tab once and takes the lock
 * only when something must be written. Returns the Investments rows. Never throws.
 */
function syncSheetPrices_(ss) {
  try {
    let invs = loadInvestments_(ss);
    const needsFix = function (list) {
      return list.some(function (x) { return !x.id || !x.status || (!x.cost && x.qty && x.price); });
    };
    const priced = function (list) { return list.filter(function (x) { return x.holding && x.id && x.current !== null; }); };
    if (!needsFix(invs) && priced(invs).length === 0) return invs;
    const hist = lastHistoryPrices_(ss);
    const changedIn = function (list) {
      return priced(list).filter(function (x) { return hist[x.id] === undefined || Math.abs(hist[x.id] - x.current) > 1e-9; });
    };
    if (!needsFix(invs) && changedIn(invs).length === 0) return invs;
    return withScriptLock_(function () {
      if (needsFix(invs)) {
        ensureInvestmentRows_(ss);
        invs = loadInvestments_(ss);
      }
      const changed = changedIn(invs);
      if (changed.length === 0) return invs;
      const today = midnight_(new Date());
      writePriceHistory_(ss, changed.map(function (x) { return { inv: x, price: x.current }; }), 'Sheet Edit', today);
      const byId = {};
      changed.forEach(function (x) { byId[x.id] = today; x.lastUpdate = today; });
      setColumnById_(ss.getSheetByName(TAB.INVESTMENTS), 'Inv ID', 'Last Price Update', byId);
      return invs;
    });
  } catch (err) {
    logError_('syncSheetPrices_', err);
    return loadInvestments_(ss);
  }
}

/** Appends Price_History rows: items = [{ inv, price, qty? }]. Call inside the lock. */
function writePriceHistory_(ss, items, source, date) {
  preparePriceHistory_(ss, items, source, date).commit();
}

/** Price_History rows in two steps: the next row is read now, the rows are written on commit(). */
function preparePriceHistory_(ss, items, source, date) {
  const sheet = ss.getSheetByName(TAB.PRICES);
  if (sheet === null || items.length === 0) return { commit: function () {} };
  const row = lastDataRow_(sheet, 'Inv ID') + 1;
  return { commit: function () {
    writeRowsByHeaders_(sheet, row, items.map(function (it) {
      const qty = it.qty !== undefined ? it.qty : it.inv.qty;
      return { 'Date': date, 'Inv ID': it.inv.id, 'Asset Name': it.inv.asset, 'Price': it.price,
        'Value': roundInv_(qty * lotMult_(it.inv.unit) * it.price), 'Source': source };
    }));
  } };
}

/** Sets Current Price (+ Last Price Update) on these rows and logs them. Call inside the lock. */
function applyPrices_(ss, items, source, date) {
  preparePrices_(ss, items, items, source, date).commit();
}

/**
 * New prices in two steps (reads now, writes on commit): Current Price and
 * Last Price Update for `items` (rows already in the sheet) and a
 * Price_History row for each of `historyItems`.
 */
function preparePrices_(ss, items, historyItems, source, date) {
  const sheet = ss.getSheetByName(TAB.INVESTMENTS);
  const prices = {};
  const dates = {};
  items.forEach(function (it) { prices[it.inv.id] = it.price; dates[it.inv.id] = date; });
  const steps = [prepareColumnById_(sheet, 'Inv ID', 'Current Price', prices),
    prepareColumnById_(sheet, 'Inv ID', 'Last Price Update', dates), preparePriceHistory_(ss, historyItems, source, date)];
  return { commit: function () { steps.forEach(function (s) { s.commit(); }); } };
}

/** Sheet data for investment steps. sync = also pick up prices typed in the sheet (only when a flow starts). */
function invCtx_(sync) {
  const ctx = loadCtx_();
  ctx.investments = sync ? syncSheetPrices_(ctx.ss) : loadInvestments_(ctx.ss);
  ctx.now = new Date();
  return ctx;
}

// ---------------------------------------------------------------------------
// Parsing buy / sell messages (pure; tested by testInvParser)
// ---------------------------------------------------------------------------

/** Distinct assets: [{ name, category, unit, source }] (latest row wins for unit/source). */
function knownAssets_(investments) {
  const map = {};
  investments.forEach(function (x) {
    if (!x.asset) return;
    const k = x.asset.toLowerCase();
    map[k] = { name: x.asset, category: x.category || (map[k] && map[k].category) || '', invWallet: x.invWallet || (map[k] && map[k].invWallet) || '',
      unit: x.unit || (map[k] && map[k].unit) || '',
      source: x.source || (map[k] && map[k].source) || '' };
  });
  return Object.keys(map).map(function (k) { return map[k]; });
}

/** Marks the longest known asset name in tokens as used; returns it or null. */
function matchAsset_(tokens, assets) {
  const sorted = assets.slice().sort(function (a, b) { return b.name.length - a.name.length; });
  for (let a = 0; a < sorted.length; a++) {
    const words = sorted[a].name.toLowerCase().split(/\s+/);
    for (let i = 0; i + words.length <= tokens.length; i++) {
      let ok = true;
      for (let k = 0; k < words.length; k++) {
        if (tokens[i + k].used || tokens[i + k].clean !== words[k]) { ok = false; break; }
      }
      if (!ok) continue;
      for (let k = 0; k < words.length; k++) tokens[i + k].used = true;
      return sorted[a];
    }
  }
  return null;
}

/**
 * Reads the numbers of a buy/sell message (or a reply): quantity (+unit),
 * price (+ "/unit" suffix), total, fee, "semua"; marks tokens used. Money
 * that isn't marked (no harga/total/@) is returned in `bare`.
 */
function readInvNumbers_(tokens) {
  const out = { qty: null, qtyUnit: '', price: null, priceSuffix: '', total: null, fee: null, all: false, bare: [], plain: [] };
  const num = function (i) {
    // A number token, joined with a following "rb"/"jt" token ("1.350 rb").
    const t = tokens[i];
    if (!t || t.used) return null;
    let text = t.clean.replace(/^@/, '');
    let len = 1;
    if (tokens[i + 1] && !tokens[i + 1].used && AMOUNT_UNITS[tokens[i + 1].clean] !== undefined && /\d$/.test(text)) {
      text += tokens[i + 1].clean;
      len = 2;
    }
    const v = parseInvNumber_(text);
    return v === null ? null : { value: v, len: len, money: /(k|rb|ribu|jt|juta)$/.test(text) || /^rp/.test(t.clean) };
  };
  const use = function (i, len) { for (let k = 0; k < len; k++) tokens[i + k].used = true; };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.used) continue;
    const c = t.clean;
    if (INV_ALL_WORDS.indexOf(c) !== -1) { out.all = true; t.used = true; continue; }
    // "2gr" / "0,5gr" / "2lot"
    let m = c.match(/^([\d.,]+)(lot|lots|lembar|lbr|share|shares|gr|g|gram|unit|units|up|coin|coins|koin)$/);
    if (m && parseDecimalId_(m[1]) !== null) { out.qty = parseDecimalId_(m[1]); out.qtyUnit = INV_UNIT_WORDS[m[2]]; t.used = true; continue; }
    // "1.350rb/gr" / "9.800/lembar"
    m = c.replace(/^@/, '').match(/^(.+)\/(lot|lembar|lbr|share|gr|g|gram|unit|coin|koin)$/);
    if (m && parseInvNumber_(m[1]) !== null) {
      out.price = parseInvNumber_(m[1]);
      out.priceSuffix = INV_UNIT_WORDS[m[2]];
      t.used = true;
      continue;
    }
    const marker = INV_PRICE_WORDS.indexOf(c) !== -1 ? 'price' : INV_TOTAL_WORDS.indexOf(c) !== -1 ? 'total' :
      INV_FEE_WORDS.indexOf(c) !== -1 ? 'fee' : '';
    if (marker) {
      let j = i + 1;
      while (tokens[j] && !tokens[j].used && ['broker', 'admin', 'per', 'transaksi'].indexOf(tokens[j].clean) !== -1) j++;
      const v = num(j);
      if (v) {
        t.used = true;
        for (let k = i + 1; k < j; k++) tokens[k].used = true;
        use(j, v.len);
        // "harga 1.350rb/gr" was caught above; a "/unit" written after: "harga 1.350rb per gr"
        if (marker === 'price') out.price = v.value;
        else if (marker === 'total') out.total = v.value;
        else out.fee = (out.fee || 0) + v.value;
        i = j + v.len - 1;
        continue;
      }
    }
    if (/^@[\d]/.test(c)) {
      const v = num(i);
      if (v) { out.price = v.value; use(i, v.len); i += v.len - 1; continue; }
    }
    const v = num(i);
    if (v) {
      const next = tokens[i + v.len];
      if (!v.money && next && !next.used && INV_UNIT_WORDS[next.clean]) {
        out.qty = v.value;
        out.qtyUnit = INV_UNIT_WORDS[next.clean];
        use(i, v.len + 1);
        i += v.len;
        continue;
      }
      // "1.350rb per gr"
      if (next && !next.used && next.clean === 'per' && tokens[i + v.len + 1] && INV_UNIT_WORDS[tokens[i + v.len + 1].clean]) {
        out.price = v.value;
        out.priceSuffix = INV_UNIT_WORDS[tokens[i + v.len + 1].clean];
        use(i, v.len + 2);
        i += v.len + 1;
        continue;
      }
      (v.money ? out.bare : out.plain).push(v.value);
      use(i, v.len);
      i += v.len - 1;
    }
  }
  return out;
}

/**
 * Parses "beli …" / "jual …". Returns null when it isn't an investment
 * message (e.g. "beli kopi 20rb"), else { ok: true, kind: 'buy' | 'sell', … }
 * or { ok: false, error }.
 * ctx = { wallets, investments, investmentGroups, now }.
 */
function parseInvestment_(text, ctx) {
  const tokens = tokenize_(normalizeInvText_(text));
  if (tokens.length === 0) return null;
  const first = tokens[0].clean;
  const kind = INV_BUY_WORDS.indexOf(first) !== -1 ? 'buy' : INV_SELL_WORDS.indexOf(first) !== -1 ? 'sell' : '';
  if (!kind) return null;
  tokens[0].used = true;
  const now = ctx.now || new Date();

  const assets = knownAssets_(ctx.investments || []);
  const asset = matchAsset_(tokens, assets);
  const invWallets = (ctx.wallets || []).filter(function (w) { return w.type === 'Investment' && w.active !== false; });
  const catMentions = extractWallets_(tokens, invWallets);
  // A category name ("beli saham …") points at the investment wallet(s) of that category.
  const catNames = unique_([].concat.apply([], invWallets.map(walletCategories_))).map(function (n) { return { name: n, active: true }; });
  const catWords = extractWallets_(tokens, catNames); // also with a wallet named ("beli crypto BTC … bibit")
  // Investment words: "lot" / "lembar" / "coin", or a price per investment unit ("15jt/coin", "1.350rb/gr").
  // A plain "250gr" is not enough ("beli kopi 250gr 50rb" stays an expense).
  const hasLot = tokens.some(function (t) {
    return !t.used && (/^([\d.,]+)?(lots?|lembar|lbr|coins?|koin)$/.test(t.clean) || /\/(lot|lembar|lbr|share|gr|g|gram|unit|coin|koin)$/.test(t.clean));
  });
  if (!asset && catMentions.length === 0 && catWords.length === 0 && !hasLot) return null; // a normal purchase ("beli kopi 20rb")

  const dateResult = extractDate_(tokens, now);
  if (dateResult.error) return { ok: false, error: dateResult.error, text: dateResult.text };
  const cashMentions = extractWallets_(tokens, cashWallets_(ctx.wallets || []));
  if (cashMentions.length > 1) return { ok: false, error: 'two_wallets', wallets: cashMentions.map(mentionLabel_) };
  // Platform: "via Bibit" / "di Pegadaian" (a word that isn't a wallet).
  let platform = '';
  tokens.forEach(function (t, i) {
    if (!platform && !t.used && INV_PLATFORM_WORDS.indexOf(t.clean) !== -1 && tokens[i + 1] && !tokens[i + 1].used &&
        parseInvNumber_(tokens[i + 1].clean) === null) {
      platform = tokens[i + 1].raw.replace(/[,.]$/, '');
      t.used = true;
      tokens[i + 1].used = true;
    }
  });
  const nums = readInvNumbers_(tokens);
  const rest = tokens.filter(function (t) {
    return !t.used && INV_FILLERS.indexOf(t.clean) === -1 && INV_UNIT_WORDS[t.clean] === undefined && t.clean !== '';
  }).map(function (t) { return t.raw.replace(/[,.]$/, ''); });

  const pickedWallet = catMentions.length ? catMentions[0].wallets[0] : null;
  const catWallets = catWords.length
    ? invWallets.filter(function (w) { return walletCategories_(w).indexOf(catWords[0].wallets[0].name) !== -1; }) : [];
  const invWallet = pickedWallet ? pickedWallet.name : catWallets.length === 1 ? catWallets[0].name : (asset ? asset.invWallet : '');
  const iw = findWallet_(invWallets, invWallet);
  // The category: the one named, else the asset's, else the wallet's when it has only one (several → asked).
  const iwCats = walletCategories_(iw);
  const category = catWords.length ? catWords[0].wallets[0].name : asset ? asset.category : (iwCats.length === 1 ? iwCats[0] : '');
  let assetName = asset ? asset.name : rest.join(' ').trim();
  if (!assetName && category) assetName = category; // "beli emas 2gr …" → asset "Emas"
  if (!assetName) return { ok: false, error: 'inv_no_asset', kind: kind };
  if (kind === 'buy' && rest.length && asset) return { ok: false, error: 'inv_extra_words', words: rest };
  const wallet = cashMentions.length ? cashMentions[0] : null;
  const out = {
    ok: true, kind: kind, asset: assetName, assetKnown: !!asset, category: category, invWallet: invWallet, invWalletGiven: !!pickedWallet,
    invWalletChoices: !invWallet && catWallets.length > 1 ? catWallets.map(function (w) { return w.name; }) : null,
    unit: unitFor_(ctx.wallets, invWallet, asset ? asset.unit : '', nums.qtyUnit),
    qty: nums.qty, qtyUnit: nums.qtyUnit, price: nums.price, priceSuffix: nums.priceSuffix, total: nums.total,
    fee: nums.fee || 0, all: nums.all, bare: nums.bare, plain: nums.plain, platform: platform,
    wallet: wallet && wallet.wallets.length === 1 ? wallet.wallets[0].name : null,
    walletChoices: wallet && wallet.wallets.length > 1 ? wallet.wallets.map(function (w) { return w.name; }) : null,
    date: dateResult.date || new Date(now.getTime()), dateGiven: !!dateResult.date
  };
  if (kind === 'sell' && !asset) {
    // A category with exactly one held asset ("jual emas 1gr …") is fine.
    const held = (ctx.investments || []).filter(function (x) {
      return x.holding && (invWallet ? x.invWallet === invWallet : x.category === category);
    });
    const names = held.map(function (x) { return x.asset; }).filter(function (n, i, a) { return a.indexOf(n) === i; });
    if (names.length === 1) {
      out.asset = names[0];
      out.unit = held[0].unit;
    } else {
      return { ok: false, error: names.length ? 'inv_which_asset' : 'inv_unknown_asset', asset: assetName, names: names };
    }
  }
  return out;
}

/**
 * Works out quantity / price per stored unit / total from what was typed
 * (d.in = { qty, qtyUnit, price, priceSuffix, total, bare, plain }), once the
 * unit is known. Recomputed from d.in every time, so answers to follow-up
 * questions never mix with earlier results. Unmarked numbers: a plain number
 * is the quantity (if missing); money is the price or the total (a lot asset's
 * money with a quantity = price per share; otherwise moneyChoice is set and the
 * bot asks). Sets d.qty, d.priceStored, d.total (null when still missing).
 */
function resolveInvNumbers_(d) {
  const x = d.in;
  let qty = x.qty;
  let price = x.price;
  let total = x.total;
  if (qty !== null && d.unit === 'lot' && x.qtyUnit === 'share') qty = roundInv_(qty / SHARES_PER_LOT); // "200 lembar" = 2 lot
  const m = lotMult_(d.unit);
  const plain = (x.plain || []).slice();
  while (plain.length && qty === null) qty = plain.shift();
  const money = (x.bare || []).concat(plain);
  d.moneyChoice = null;
  d.tooMany = false;
  if (d.unit === 'nominal') {
    if (total === null && money.length) total = money.shift();
    if (total === null) total = qty;
    d.qty = total;
    d.priceStored = total === null ? null : 1;
    d.total = total;
    return d;
  }
  // Owner's rule: a value on its own is the total; the price needs a unit ("/gr", "harga", "@").
  money.forEach(function (v) {
    if (total === null) total = v;
    else if (price === null) price = v;
    else d.tooMany = true;
  });
  let ps = storedPrice_(price, x.priceSuffix, d.unit);
  if (qty !== null && ps !== null) { if (total === null) total = roundInv_(qty * m * ps); }
  else if (qty !== null && total !== null) ps = roundInv_(total / (qty * m));
  else if (total !== null && ps !== null) qty = roundInv_(total / (ps * m));
  d.qty = qty;
  d.priceStored = ps;
  d.total = total;
  return d;
}

/** Freezes what was worked out so far into d.in (before merging a reply). */
function freezeInvNumbers_(d) {
  d.in = { qty: d.qty, qtyUnit: '', price: d.priceStored, priceSuffix: '', total: d.total, bare: [], plain: [] };
  // (the stored price is already per stored unit)
}

/**
 * Splits a sale over holding rows: FIFO (oldest first) or one picked row.
 * Returns { parts: [{ inv, qty }] } or { error: 'inv_too_much', held }.
 */
function allocateSale_(rows, qty, pickedId) {
  const held = rows.filter(function (x) { return x.holding; }).sort(function (a, b) {
    return (a.date ? a.date.getTime() : 0) - (b.date ? b.date.getTime() : 0) || a.row - b.row;
  });
  const pool = pickedId ? held.filter(function (x) { return x.id === pickedId; }) : held;
  const total = roundInv_(pool.reduce(function (s, x) { return s + x.qty; }, 0));
  if (qty > total + 1e-9) return { error: 'inv_too_much', held: total };
  const parts = [];
  let left = qty;
  pool.forEach(function (x) {
    if (left <= 1e-9) return;
    const q = roundInv_(Math.min(x.qty, left));
    parts.push({ inv: x, qty: q });
    left = roundInv_(left - q);
  });
  return { parts: parts };
}

/** Realized gain of a sale: Σ qty × (sale price − acquisition price) − fee. */
function saleGain_(parts, price, fee) {
  return roundInv_(parts.reduce(function (s, p) { return s + p.qty * lotMult_(p.inv.unit) * (price - p.inv.price); }, 0) - (fee || 0));
}

// ---------------------------------------------------------------------------
// /inv update (pure parsing; tested by testInvParser)
// ---------------------------------------------------------------------------

/**
 * "BBCA 9.800\nemas 1.380rb/gr" → { items: [{ name, rows, unit, price, old }], unknown: [line], bad: [line] }.
 * A name is an asset (all its holding rows) or a category (all its holding rows,
 * same unit). Lot assets: per share ×100 unless "/lot". Nominal: the number is the
 * new total value of that asset.
 */
function parseInvUpdate_(text, investments) {
  const out = { items: [], unknown: [], bad: [] };
  const holding = investments.filter(function (x) { return x.holding && x.id; });
  String(text || '').split(/\n|;/).map(function (l) { return l.trim(); }).filter(String).forEach(function (line) {
    const tokens = tokenize_(normalizeInvText_(line));
    // The price is the last token(s): "1.380rb/gr", "1.380 rb", "9.800".
    let suffix = '';
    let price = null;
    let used = 0;
    const last = tokens[tokens.length - 1];
    let m = last ? last.clean.match(/^(.+)\/(lot|lembar|lbr|share|gr|g|gram|unit|coin|koin)$/) : null;
    if (m && parseInvNumber_(m[1]) !== null) { price = parseInvNumber_(m[1]); suffix = INV_UNIT_WORDS[m[2]]; used = 1; }
    if (price === null && last && parseInvNumber_(last.clean) !== null) { price = parseInvNumber_(last.clean); used = 1; }
    if (price === null && tokens.length >= 2 && AMOUNT_UNITS[last.clean] !== undefined) {
      price = parseInvNumber_(tokens[tokens.length - 2].clean + last.clean);
      used = 2;
    }
    const name = tokens.slice(0, tokens.length - used).map(function (t) { return t.raw; }).join(' ').replace(/[:=]$/, '').trim();
    if (price === null || name === '') { out.bad.push(line); return; }
    const key = name.toLowerCase();
    let rows = holding.filter(function (x) { return x.asset.toLowerCase() === key; });
    if (rows.length === 0) rows = holding.filter(function (x) { return x.category.toLowerCase() === key; });
    if (rows.length === 0) { out.unknown.push(name); return; }
    const units = rows.map(function (x) { return x.unit; }).filter(function (u, i, a) { return a.indexOf(u) === i; });
    if (units.length > 1) { out.bad.push(line + ' (mixed units: write the asset names)'); return; }
    const unit = units[0];
    const qty = rows.reduce(function (s, x) { return s + x.qty; }, 0);
    const stored = unit === 'nominal' ? roundInv_(price / qty) : storedPrice_(price, suffix, unit);
    const old = rows.map(invPriceNow_).reduce(function (a, b) { return Math.max(a, b); }, 0);
    out.items.push({ name: rows[0].asset.toLowerCase() === key ? rows[0].asset : rows[0].category, rows: rows, unit: unit,
      price: stored, old: old, qty: qty });
  });
  return out;
}

// ---------------------------------------------------------------------------
// /inv report (pure; tested by testInvReport)
// ---------------------------------------------------------------------------

/** Investment_Sales rows: [{ saleId, invId, date, qty, price, fee, link }]. */
function loadSales_(ss) {
  const sheet = ss.getSheetByName(TAB.SALES);
  if (sheet === null) return [];
  return readTableByHeaders_(sheet, 'Inv ID').map(function (r) {
    return { saleId: String(r['sale id'] || '').trim(), invId: String(r['inv id']).trim(), date: dateOrNull_(r['sale date']),
      qty: Number(r['quantity sold']) || 0, price: Number(r['sale price']) || 0, fee: Number(r['fees']) || 0,
      link: String(r['link id'] || '').trim(), row: r._row };
  });
}

/**
 * Per category → per asset (several purchases = one line, average prices):
 * held quantity, cost and value of what is held (floating / unrealized gain),
 * sold quantity, sold value (average sell price) and realized gain, and the
 * total gain = realized + unrealized (same numbers as the Investments tab).
 */
function invSummary_(investments, sales) {
  const byId = {};
  investments.forEach(function (x) { byId[x.id] = x; });
  const cats = {};
  const assetOf = function (x) {
    const c = cats[x.category] = cats[x.category] || { name: x.category, assets: {} };
    return c.assets[x.asset] = c.assets[x.asset] || { name: x.asset, category: x.category, unit: x.unit, qty: 0, cost: 0, value: 0,
      boughtCost: 0, soldQty: 0, soldValue: 0, realized: 0, last: null, lastDate: null, wallets: {} };
  };
  investments.forEach(function (x) {
    if (!x.asset) return;
    const a = assetOf(x);
    const m = lotMult_(x.unit);
    a.boughtCost += x.cost || x.qty * m * x.price;
    if (!x.holding) return;
    a.qty += x.qty;
    a.cost += x.qty * m * x.price;
    // Each investment wallet keeps its own average for the same asset (sales are FIFO inside one wallet).
    const w = a.wallets[x.invWallet || ''] = a.wallets[x.invWallet || ''] || { qty: 0, cost: 0 };
    w.qty += x.qty;
    w.cost += x.qty * m * x.price;
    a.value += x.qty * m * invPriceNow_(x);
    const when = x.lastUpdate || x.date;
    if (a.last === null || (when && (!a.lastDate || when > a.lastDate))) { a.last = invPriceNow_(x); a.lastDate = when; }
  });
  (sales || []).forEach(function (sale) {
    const x = byId[sale.invId];
    if (!x) return;
    const a = assetOf(x);
    a.soldQty += sale.qty;
    a.soldValue += sale.qty * lotMult_(x.unit) * sale.price;
    a.realized += sale.qty * lotMult_(x.unit) * (sale.price - x.price) - sale.fee;
  });
  return Object.keys(cats).sort().map(function (k) {
    const assets = Object.keys(cats[k].assets).sort().map(function (n) {
      const a = cats[k].assets[n];
      a.unrealized = a.value - a.cost;
      a.total = a.unrealized + a.realized;
      return a;
    }).filter(function (a) { return a.qty > 1e-9 || a.soldQty > 1e-9; });
    const sum = function (f) { return assets.reduce(function (t, a) { return t + a[f]; }, 0); };
    return { name: k, assets: assets, cost: sum('cost'), value: sum('value'), unrealized: sum('unrealized'), realized: sum('realized'),
      total: sum('total'), boughtCost: sum('boughtCost') };
  }).filter(function (c) { return c.assets.length > 0; });
}

function gainText_(gain, base, hide) {
  const g = Math.round(gain);
  const pct = base ? (g / base) * 100 : 0;
  return (g >= 0 ? '+' : '') + money_(g, hide) + (base ? ' (' + (pct >= 0 ? '+' : '') + formatNumId_(pct, 1) + '%)' : '');
}

/**
 * /inv text. filter = '' (all) or a category / asset name. realized = this
 * month's realized gain (number) or null. Amounts via the spoiler helper.
 */
function buildInvText_(investments, filter, hide) {
  const f = String(filter || '').trim().toLowerCase();
  let cats = invSummary_(investments, []).map(function (c) {
    const assets = c.assets.filter(function (a) { return a.qty > 1e-9 && (!f || c.name.toLowerCase() === f || a.name.toLowerCase() === f); });
    const sum = function (k) { return assets.reduce(function (t, a) { return t + a[k]; }, 0); };
    return { name: c.name, assets: assets, cost: sum('cost'), value: sum('value') };
  }).filter(function (c) { return c.assets.length > 0; });
  if (f && cats.length === 0) return { error: 'inv_filter', filter: filter };
  const lines = ['📈 <b>Investments</b>' + (f ? ' — ' + escapeHtml_(filter) : '')];
  if (cats.length === 0) {
    lines.push('', 'Nothing held yet. Buy with e.g. <code>beli emas 2gr 1.350rb/gr dari BCA</code>.');
    return { text: lines.join('\n') };
  }
  // Per unit of quantity: per lembar for stocks, per gr / unit / coin otherwise.
  const per = function (v, a) { return a.unit === 'nominal' ? '' : formatRpDec_(v / (a.qty * lotMult_(a.unit))); };
  const unit = function (a) { return a.unit === 'nominal' ? '' : '/' + (a.unit === 'lot' || a.unit === 'share' ? 'lembar' : unitLabel_(a.unit)); };
  cats.forEach(function (c) {
    lines.push('', '<b>' + escapeHtml_(c.name) + '</b> · ' + money_(Math.round(c.value), hide) + ' · ' + gainText_(c.value - c.cost, c.cost, hide));
    c.assets.forEach(function (a) {
      lines.push('• <b>' + escapeHtml_(a.name) + '</b> · ' + formatQty_(a.qty, a.unit) + ' · ' + money_(Math.round(a.value), hide));
      lines.push('   ' + (a.unit === 'nominal' ? '' : 'avg ' + per(a.cost, a) + ' → now ' + per(a.value, a) + unit(a) + ' · ') +
        gainText_(a.value - a.cost, a.cost, hide));
      const ws = Object.keys(a.wallets || {}).filter(function (k) { return a.wallets[k].qty > 1e-9; });
      if (ws.length > 1) {
        ws.forEach(function (k) {
          const w = a.wallets[k];
          lines.push('   ◦ ' + escapeHtml_(k || '(no wallet)') + ' · ' + formatQty_(w.qty, a.unit) +
            (a.unit === 'nominal' ? '' : ' · avg ' + formatRpDec_(w.cost / (w.qty * lotMult_(a.unit)))));
        });
      }
    });
  });
  if (cats.length > 1) {
    const cost = cats.reduce(function (t, c) { return t + c.cost; }, 0);
    const value = cats.reduce(function (t, c) { return t + c.value; }, 0);
    lines.push('', '<b>Total</b> ' + money_(Math.round(value), hide) + ' · ' + gainText_(value - cost, cost, hide));
  }
  return { text: lines.join('\n') };
}


// ---------------------------------------------------------------------------
// /inv command
// ---------------------------------------------------------------------------

function handleInvCommand_(message, args) {
  const chatId = String(message.chat.id);
  const firstSpace = args.search(/\s/);
  const sub = (firstSpace === -1 ? args : args.slice(0, firstSpace)).toLowerCase();
  const rest = firstSpace === -1 ? '' : args.slice(firstSpace + 1).trim();
  if (sub === 'update' || sub === 'harga') return startInvUpdate_(chatId, rest);
  if (sub === 'sell' || sub === 'jual') return rest ? startInvestment_(chatId, 'jual ' + rest) : startGuidedSell_(chatId);
  if (sub === 'buy' || sub === 'beli') {
    if (!rest) return sendMessage(chatId, invErrorText_({ error: 'inv_buy_usage' }));
    return startInvestment_(chatId, 'beli ' + rest);
  }
  showInv_(chatId, args);
}

function showInv_(chatId, filter) {
  const ctx = invCtx_(true);
  loadSettingsTab_(true); // fresh: "Hide amounts" / "Inv auto-delete" changes apply right away
  const r = buildInvText_(ctx.investments, filter, getSettingYes_(SETTING.HIDE_AMOUNTS));
  if (r.error) return sendMessage(chatId, invErrorText_(r));
  const autoDelete = getSettingYes_(SETTING.INV_AUTO_DELETE);
  const sent = sendMessage(chatId, r.text + (autoDelete ? '\n\n🕒 This message will be deleted in ' + formatDelay_(INV_DELETE_SECONDS) + '.' : ''));
  if (autoDelete) scheduleDelete_(chatId, sent.message_id, INV_DELETE_SECONDS);
}

// ---------------------------------------------------------------------------
// Buy / sell flow (pending kind 'inv')
// ---------------------------------------------------------------------------

/** Returns true if the text was an investment message and was handled. */
function maybeStartInvestment_(chatId, text, ctx) {
  if (!/^\s*(beli|buy|invest|investasi|jual|sell|cairkan|redeem)\b/i.test(text)) return false;
  ctx.investments = syncSheetPrices_(ctx.ss);
  const r = parseInvestment_(text, { wallets: ctx.wallets, investments: ctx.investments, investmentGroups: ctx.investmentGroups,
    now: new Date() });
  if (r === null) return false;
  if (!r.ok) {
    sendMessage(chatId, invErrorText_(r));
    return true;
  }
  beginInvestment_(chatId, r, ctx, null);
  return true;
}

function startInvestment_(chatId, text) {
  const ctx = loadCtx_();
  if (!maybeStartInvestment_(chatId, text, ctx)) sendMessage(chatId, invErrorText_({ error: 'inv_buy_usage' }));
}

function beginInvestment_(chatId, r, ctx, msgId) {
  const d = Object.assign({ mode: r.kind, moneyChoice: null, tooMany: false, picked: null }, r,
    { date: r.date.getTime(), walletHow: r.wallet ? 'mentioned' : '' });
  // Selling an asset held in several wallets without naming one: advanceSell_ asks which.
  if (d.mode === 'sell' && !r.invWalletGiven) d.invWallet = null;
  if (d.mode === 'buy') {
    d.in = { qty: r.qty, qtyUnit: r.qtyUnit, price: r.price, priceSuffix: r.priceSuffix, total: r.total, bare: r.bare, plain: r.plain };
  }
  const p = newPending_(chatId, 'inv', d);
  p.msgId = msgId || null;
  if (d.mode === 'buy') advanceBuy_(p, ctx);
  else advanceSell_(p, ctx);
}

/** The asset's rows (all), and the last source wallet used for it (else its category). */
function lastSourceFor_(investments, asset, invWallet) {
  const own = investments.filter(function (x) { return x.asset.toLowerCase() === String(asset).toLowerCase() && x.source; });
  const cat = investments.filter(function (x) { return x.invWallet === invWallet && x.source; });
  const list = own.length ? own : cat;
  return list.length ? list[list.length - 1].source : '';
}

function advanceBuy_(p, ctx) {
  const d = p.d;
  p.awaitText = null;
  const invWallets = ctx.wallets.filter(function (w) { return w.type === 'Investment' && w.active !== false; });
  if (!d.invWallet || !findWallet_(invWallets, d.invWallet)) {
    const choices = (d.invWalletChoices || []).map(function (n) { return findWallet_(invWallets, n); }).filter(Boolean);
    const list = choices.length ? choices : invWallets;
    p.opts = list.map(function (w) { return w.name; });
    if (p.opts.length === 0) return finishStep_(p, invErrorText_({ error: 'inv_no_categories' }));
    const rows = chunk_(list.map(function (w, i) {
      const cats = walletCategories_(w).join(', ');
      return btn_(p, w.name + (cats && cats !== w.name ? ' · ' + cats : ''), 'ic', i);
    }), 2);
    rows.push(cancelRow_(p));
    return showStep_(p, '📈 ' + escapeHtml_(d.asset) + (d.assetKnown ? '' : ' is new.') + ' Which investment wallet holds it?', rows);
  }
  const iw = findWallet_(invWallets, d.invWallet);
  const cats = walletCategories_(iw);
  if (!d.category || cats.indexOf(d.category) === -1) {
    if (cats.length === 1) d.category = cats[0];
    else {
      p.opts = cats;
      const rows = chunk_(cats.map(function (c, i) { return btn_(p, c, 'icat', i); }), 3);
      rows.push(cancelRow_(p));
      return showStep_(p, invSummaryLine_(d) + '\n' + escapeHtml_(d.invWallet) + ' has several categories. Which one is ' +
        escapeHtml_(d.asset) + '?', rows);
    }
  }
  // The category's Wallet Type sets the unit (Emas → gr, Saham → lembar); Others: typed, else "unit".
  const asset = knownAssets_(ctx.investments).filter(function (a) { return a.name.toLowerCase() === d.asset.toLowerCase(); })[0];
  d.unit = unitFor_(ctx.wallets, d.invWallet, asset ? asset.unit : '', d.in.qtyUnit) || 'unit';
  resolveInvNumbers_(d);
  if (d.tooMany) return finishStep_(p, invErrorText_({ error: 'inv_too_many_numbers' }));
  if (d.qty === null || d.total === null || d.priceStored === null) return askInvNumbers_(p);
  if (!(d.qty > 0) || !(d.total > 0)) return finishStep_(p, invErrorText_({ error: 'inv_zero' }));
  const sources = invSourceWallets_(ctx);
  if (!d.wallet) {
    const last = lastSourceFor_(ctx.investments, d.asset, d.invWallet);
    if (last && findWallet_(sources, last)) { d.wallet = last; d.walletHow = 'last'; }
    else if (sources.length === 1) { d.wallet = sources[0].name; d.walletHow = 'only'; } // the only investment wallet
  }
  if (!findWallet_(sources, d.wallet)) {
    const typed = d.wallet;
    d.wallet = null;
    return askInvWallet_(p, ctx, (typed ? '⚠️ ' + escapeHtml_(typed) + " isn't in an investment wallet group.\n" : '') + 'Paid from which wallet?');
  }
  if (!d.platform) {
    const w = findWallet_(ctx.wallets, d.wallet);
    if (w && isInvestmentWallet_(w, ctx.investmentGroups)) d.platform = w.name.replace(/\s*\(.*\)\s*$/, '');
    else {
      const prev = ctx.investments.filter(function (x) { return x.asset.toLowerCase() === d.asset.toLowerCase() && x.platform; });
      if (prev.length) d.platform = prev[prev.length - 1].platform;
    }
  }
  if (isMonthClosed_(ctx.ss, d.date)) {
    return showStep_(p, '⛔ That month is closed, so entries can\'t be dated in it. Use today\'s date instead?',
      [[btn_(p, '📅 Use today', 'today'), btn_(p, '❌ Cancel', 'n')]]);
  }
  // Change either side of the move: 👛 From (the paying wallet), 📈 To (the investment wallet), 🏷 its category.
  const edits = [btn_(p, '👛 From', 'ew'), btn_(p, '📈 To', 'et')];
  if (cats.length > 1) edits.push(btn_(p, '🏷 Category', 'ec'));
  showStep_(p, buildBuyPreview_(d, ctx), [[btn_(p, '✅ Yes', 'y'), btn_(p, '❌ No', 'n')], edits, [btn_(p, '📅 Date', 'ed')]]);
}

function invSummaryLine_(d) {
  return '📈 ' + (d.mode === 'sell' ? 'Sell ' : 'Buy ') + escapeHtml_(d.asset) + (d.qty !== null ? ' · ' + formatQty_(d.qty, d.unit) : '');
}

function askInvNumbers_(p) {
  const d = p.d;
  const u = unitLabel_(d.unit);
  const ex = d.unit === 'lot' ? '9.800/lembar' : d.unit === 'gram' ? '1.350rb/gr' : '1.520/' + (u || 'unit');
  let q;
  if (d.qty === null && d.priceStored === null && d.total === null) {
    q = 'How much? e.g. <code>' + (d.unit === 'lot' ? '2 lot' : '2 ' + (u || 'unit')) + ' ' + ex + '</code>, or quantity + total: <code>' +
      (d.unit === 'lot' ? '1 lot 980rb' : '2 ' + (u || 'unit') + ' 2.7jt') + '</code>.';
  } else if (d.qty === null) {
    q = 'How many ' + (u || 'units') + '?' + (d.unit === 'lot' ? ' (or lembar: <code>200 lbr</code> = 2 lot)' : '');
  } else {
    q = 'Send the <b>total</b> (e.g. <code>2.7jt</code>) or the price per ' + (d.unit === 'lot' ? 'lembar' : u || 'unit') +
      ' (e.g. <code>' + ex + '</code>).';
  }
  p.awaitText = 'numbers';
  showStep_(p, invSummaryLine_(d) + '\n' + q, [cancelRow_(p)]);
}

function askInvWallet_(p, ctx, question) {
  const sources = invSourceWallets_(ctx);
  const list = p.d.walletChoices && p.d.walletChoices.length
    ? p.d.walletChoices.map(function (n) { return findWallet_(sources, n); }).filter(Boolean) : sources;
  p.opts = (list.length ? list : sources).map(function (w) { return w.name; });
  if (p.opts.length === 0) return finishStep_(p, invErrorText_({ error: 'inv_no_source' }));
  const rows = chunk_(p.opts.map(function (n, i) { return btn_(p, n, 'iw', i); }), 3);
  rows.push(cancelRow_(p));
  showStep_(p, invSummaryLine_(p.d) + '\n' + question, rows);
}

/**
 * Wallets that can pay for (or receive) investments: cash wallets in one of
 * the "Investment Source Groups" (default "Investment Wallet"). A wallet can be
 * in several groups ("Spending, Investment Wallet").
 */
function invSourceWallets_(ctx) {
  const groups = getSettingList_(SETTING.INV_SOURCE_GROUPS);
  return cashWallets_(ctx.wallets).filter(function (w) {
    return walletGroups_(w).some(function (g) { return groups.indexOf(g.toLowerCase()) !== -1; });
  });
}

function buildBuyPreview_(d, ctx) {
  const cost = roundInv_(d.total + (d.fee || 0));
  const lines = ['📈 <b>Preview · Buy</b>', escapeHtml_(d.category) + ' · <b>' + escapeHtml_(d.asset) + '</b>' +
    (d.assetKnown ? '' : ' <i>(new asset)</i>')];
  if (d.unit === 'nominal') lines.push('Amount <b>' + formatRp_(d.total) + '</b>');
  else lines.push(formatQty_(d.qty, d.unit) + ' × ' + formatInvPrice_(d.priceStored, d.unit) + ' = <b>' + formatRp_(d.total) + '</b>');
  if (d.fee) lines.push('Fee ' + formatRp_(d.fee) + ' → cost <b>' + formatRp_(cost) + '</b>' +
    (d.unit === 'nominal' ? '' : ' (' + formatInvPrice_(cost / (d.qty * lotMult_(d.unit)), d.unit) + ')'));
  lines.push('👛 ' + escapeHtml_(d.wallet) + ' → ' + escapeHtml_(d.invWallet) +
    (d.walletHow === 'last' ? ' <i>(last used)</i>' : d.walletHow === 'only' ? ' <i>(your only investment wallet)</i>' : ''));
  if (d.platform) lines.push('🏦 ' + escapeHtml_(d.platform));
  lines.push('📅 ' + formatDate_(d.date));
  const warn = [];
  const w = findWallet_(ctx.wallets, d.wallet);
  if (w && w.balance - cost < 0) warn.push('⚠️ ' + escapeHtml_(d.wallet) + ' would go negative (' + formatRp_(w.balance - cost) + ').');
  const large = getSettingInt_(SETTING.LARGE_AMOUNT);
  if (large > 0 && cost > large) warn.push('⚠️ Large amount (over ' + formatRp_(large) + ').');
  if (d.unit === 'lot' && Math.abs(d.qty - Math.round(d.qty)) > 1e-9) warn.push('⚠️ ' + formatQty_(d.qty, d.unit) + ' is not a whole number of lots.');
  const prev = ctx.investments.filter(function (x) { return x.asset.toLowerCase() === d.asset.toLowerCase(); });
  if (prev.length && d.unit !== 'nominal') {
    const last = invPriceNow_(prev[prev.length - 1]);
    if (last && Math.abs(d.priceStored - last) / last > INV_PRICE_JUMP) {
      warn.push('⚠️ Price is far from the last one (' + formatInvPrice_(last, d.unit) + '). Is that right?');
    }
  }
  if (warn.length) lines.push('', warn.join('\n'));
  lines.push('', 'Save?');
  return lines.join('\n');
}

function advanceSell_(p, ctx) {
  const d = p.d;
  p.awaitText = null;
  const all = ctx.investments.filter(function (x) { return x.asset.toLowerCase() === d.asset.toLowerCase() && x.holding; });
  if (all.length === 0) return finishStep_(p, invErrorText_({ error: 'inv_nothing_held', asset: d.asset }));
  // Held in several investment wallets → sell from one of them (📈 From).
  const holders = unique_(all.map(function (x) { return x.invWallet; }));
  if (!d.invWallet || holders.indexOf(d.invWallet) === -1) {
    if (holders.length === 1) d.invWallet = holders[0];
    else {
      p.opts = holders;
      const btns = chunk_(holders.map(function (h, i) {
        const mine = all.filter(function (x) { return x.invWallet === h; });
        const q = mine.reduce(function (s, x) { return s + x.qty; }, 0);
        const cost = mine.reduce(function (s, x) { return s + x.qty * x.price; }, 0); // this wallet's own average
        return btn_(p, h + ' · ' + formatQty_(q, all[0].unit) + (all[0].unit === 'nominal' ? '' : ' · avg ' + formatRpDec_(cost / q)), 'sw', i);
      }), 2);
      btns.push(cancelRow_(p));
      return showStep_(p, '📉 ' + escapeHtml_(all[0].asset) + ' is in several wallets. Sell from which?', btns);
    }
  }
  const rows = all.filter(function (x) { return x.invWallet === d.invWallet; });
  d.asset = rows[0].asset;
  d.unit = rows[0].unit;
  d.category = rows[0].category;
  d.holders = holders.length;
  const held = roundInv_(rows.reduce(function (s, x) { return s + x.qty; }, 0));
  if (d.qty !== null && !d.lotFixed) {
    if (d.unit === 'lot' && d.qtyUnit === 'share') d.qty = roundInv_(d.qty / SHARES_PER_LOT); // "200 lembar" = 2 lot
    d.lotFixed = true;
  }
  const m = lotMult_(d.unit);
  if (d.all) d.qty = held;
  // Unmarked numbers: a plain number is the quantity, money is the price (a sale names its price).
  (d.plain || []).forEach(function (v) { if (d.qty === null) d.qty = v; else (d.bare = d.bare || []).push(v); });
  d.plain = [];
  if (d.unit === 'nominal') {
    if (d.qty === null && d.total !== null) d.qty = d.total;
    if (d.qty === null && (d.bare || []).length) d.qty = d.bare.shift();
    d.priceStored = 1;
    if (d.total === null && d.qty !== null) d.total = d.qty;
  } else {
    // A value on its own is the total; a price needs a unit ("/lembar", "harga", "@").
    if (d.total === null && (d.bare || []).length) d.total = d.bare.shift();
    d.priceStored = storedPrice_(d.price, d.priceSuffix, d.unit);
    if (d.priceStored === null && d.total !== null && d.qty) d.priceStored = roundInv_(d.total / (d.qty * m));
    if (d.qty === null && d.total !== null && d.priceStored) d.qty = roundInv_(d.total / (d.priceStored * m));
  }
  if (d.qty === null) {
    p.awaitText = 'sellqty';
    return showStep_(p, invSummaryLine_(d) + '\nYou hold ' + formatQty_(held, d.unit) + '. How much do you sell? e.g. <code>' +
      (d.unit === 'nominal' ? '5jt' : '1 ' + unitLabel_(d.unit)) + '</code>', [[btn_(p, 'All ' + formatQty_(held, d.unit), 'sa')], cancelRow_(p)]);
  }
  if (d.qty > held + 1e-9) {
    p.awaitText = 'sellqty';
    d.qty = null;
    return showStep_(p, '⚠️ You only hold ' + formatQty_(held, d.unit) + ' of ' + escapeHtml_(d.asset) + '. How much do you sell?',
      [[btn_(p, 'All ' + formatQty_(held, d.unit), 'sa')], cancelRow_(p)]);
  }
  if (d.priceStored === null) {
    p.awaitText = 'sellprice';
    const last = rows.map(invPriceNow_).reduce(function (a, b) { return Math.max(a, b); }, 0);
    return showStep_(p, invSummaryLine_(d) + '\nSend the <b>total</b> you got (e.g. <code>5jt</code>) or the price per ' +
      (d.unit === 'lot' ? 'lembar' : unitLabel_(d.unit)) + ' (e.g. <code>' + typedPrice_(last, d.unit) + '/' +
      (d.unit === 'lot' ? 'lbr' : unitLabel_(d.unit)) + '</code>).',
      [[btn_(p, 'Last price ' + formatInvPrice_(last, d.unit), 'sp')], cancelRow_(p)]);
  }
  d.total = roundInv_(d.qty * m * d.priceStored);
  const sources = invSourceWallets_(ctx);
  if (!d.wallet) {
    const last = lastSourceFor_(ctx.investments, d.asset, d.invWallet);
    if (last && findWallet_(sources, last)) { d.wallet = last; d.walletHow = 'last'; }
    else if (sources.length === 1) { d.wallet = sources[0].name; d.walletHow = 'only'; } // the only investment wallet
  }
  if (!findWallet_(sources, d.wallet)) {
    const typed = d.wallet;
    d.wallet = null;
    return askInvWallet_(p, ctx, (typed ? '⚠️ ' + escapeHtml_(typed) + " isn't in an investment wallet group.\n" : '') + 'Into which wallet?');
  }
  const alloc = allocateSale_(rows, d.qty, d.picked);
  if (alloc.error) {
    d.picked = null;
    return showStep_(p, '⚠️ That row holds only ' + formatQty_(alloc.held, d.unit) + '. Pick another row or use FIFO.',
      [[btn_(p, '🔀 Choose rows', 'pr'), btn_(p, '↩️ FIFO', 'fifo')], cancelRow_(p)]);
  }
  if (isMonthClosed_(ctx.ss, d.date)) {
    return showStep_(p, '⛔ That month is closed, so entries can\'t be dated in it. Use today\'s date instead?',
      [[btn_(p, '📅 Use today', 'today'), btn_(p, '❌ Cancel', 'n')]]);
  }
  d.parts = alloc.parts.map(function (x) { return { id: x.inv.id, qty: x.qty }; });
  // 📈 From = the investment wallet (only when the asset is in several), 👛 To = where the money goes.
  const buttons = [[btn_(p, '✅ Yes', 'y'), btn_(p, '❌ No', 'n')], [btn_(p, '👛 To', 'ew'), btn_(p, '📅 Date', 'ed')]];
  if (d.holders > 1) buttons[1].unshift(btn_(p, '📈 From', 'es'));
  if (rows.length > 1) buttons[1].push(d.picked ? btn_(p, '↩️ FIFO', 'fifo') : btn_(p, '🔀 Choose rows', 'pr'));
  showStep_(p, buildSellPreview_(d, alloc.parts, held), buttons);
}

function buildSellPreview_(d, parts, held) {
  const fee = d.fee || 0;
  const gain = saleGain_(parts, d.priceStored, fee);
  const lines = ['📉 <b>Preview · Sell</b>', escapeHtml_(d.category) + ' · <b>' + escapeHtml_(d.asset) + '</b>'];
  if (d.unit === 'nominal') lines.push('Amount <b>' + formatRp_(d.total) + '</b> of ' + formatRp_(held));
  else lines.push(formatQty_(d.qty, d.unit) + ' of ' + formatQty_(held, d.unit) + ' × ' + formatInvPrice_(d.priceStored, d.unit) +
    ' = <b>' + formatRp_(d.total) + '</b>');
  lines.push((d.picked ? 'From the row you chose:' : 'From (FIFO, oldest first):'));
  parts.forEach(function (x) {
    lines.push('• ' + escapeHtml_(x.inv.id) + ' · ' + (x.inv.date ? formatDate_(x.inv.date) + ' · ' : '') + formatQty_(x.qty, d.unit) +
      (d.unit === 'nominal' ? '' : ' bought at ' + formatInvPrice_(x.inv.price, d.unit)));
  });
  if (fee) lines.push('Fee ' + formatRp_(fee));
  lines.push('👛 ' + escapeHtml_(d.invWallet) + ' → ' + escapeHtml_(d.wallet) + ' <b>' + formatRpSigned_(d.total - fee) + '</b>' +
    (d.walletHow === 'last' ? ' <i>(last used)</i>' : d.walletHow === 'only' ? ' <i>(your only investment wallet)</i>' : ''));
  lines.push('💹 Realized gain: <b>' + formatRpSigned_(Math.round(gain)) + '</b>');
  lines.push('📅 ' + formatDate_(d.date), '', 'Save?');
  return lines.join('\n');
}

function invCallback_(p, action, arg, user) {
  const d = p.d;
  if (action === 'n') return finishStep_(p, '❌ Cancelled. Nothing was saved.');
  const ctx = invCtx_(false);
  switch (action) {
    case 'ic': d.invWallet = p.opts[Number(arg)]; d.invWalletChoices = null; break;
    case 'icat': d.category = p.opts[Number(arg)]; break;
    case 'et': d.invWallet = null; d.invWalletChoices = null; break;        // buy: choose another investment wallet
    case 'ec': {                                                            // buy: choose another category of the wallet
      const w = findWallet_(ctx.wallets, d.invWallet);
      p.opts = walletCategories_(w);
      const rows = chunk_(p.opts.map(function (c, i) { return btn_(p, c, 'icat', i); }), 3);
      rows.push(cancelRow_(p));
      return showStep_(p, invSummaryLine_(d) + '\nWhich category?', rows);
    }
    case 'sw': d.invWallet = p.opts[Number(arg)]; d.picked = null; break;   // sell: which wallet it comes from
    case 'es': d.invWallet = null; d.picked = null; break;
    case 'iu': d.unit = p.opts[Number(arg)]; break;
    case 'mc': {
      const v = d.moneyChoice;
      freezeInvNumbers_(d);
      if (arg === 'price') { d.in.price = v; d.in.priceSuffix = ''; } else d.in.total = v;
      break;
    }
    case 'sv': // /inv sell: asset picked
      p.d = { mode: 'sell', asset: p.opts[Number(arg)], qty: null, qtyUnit: '', price: null, priceSuffix: '', total: null, fee: 0,
        all: false, bare: [], plain: [], wallet: null, walletChoices: null, walletHow: '', picked: null, date: Date.now() };
      return advanceSell_(p, ctx);
    case 'iw': d.wallet = p.opts[Number(arg)]; d.walletChoices = null; d.walletHow = 'chosen'; break;
    case 'ew': d.walletChoices = null; return askInvWallet_(p, ctx, d.mode === 'sell' ? 'Into which wallet?' : 'Paid from which wallet?');
    case 'ed':
      p.awaitText = 'date';
      return showStep_(p, invSummaryLine_(d) + '\n' + EDIT_PROMPTS.date, [cancelRow_(p)]);
    case 'today': d.date = Date.now(); break;
    case 'sa': d.all = true; d.qty = null; break;
    case 'sp': {
      const rows = ctx.investments.filter(function (x) { return x.asset === d.asset && x.holding && (!d.invWallet || x.invWallet === d.invWallet); });
      d.priceStored = rows.map(invPriceNow_).reduce(function (a, b) { return Math.max(a, b); }, 0);
      d.price = d.priceStored;
      d.priceSuffix = '';
      break;
    }
    case 'pr': {
      const rows = ctx.investments.filter(function (x) { return x.asset === d.asset && x.holding && (!d.invWallet || x.invWallet === d.invWallet); });
      p.opts = rows.map(function (x) { return x.id; });
      const btns = rows.map(function (x, i) {
        return btn_(p, x.id + ' · ' + (x.date ? formatDate_(x.date) + ' · ' : '') + formatQty_(x.qty, x.unit) +
          (x.unit === 'nominal' ? '' : ' @ ' + formatRpDec_(x.price)), 'pk', i);
      });
      return showStep_(p, invSummaryLine_(d) + '\nSell from which purchase?', chunk_(btns, 1).concat([[btn_(p, '↩️ FIFO', 'fifo')], cancelRow_(p)]));
    }
    case 'pk': d.picked = p.opts[Number(arg)]; break;
    case 'fifo': d.picked = null; break;
    case 'y':
      return d.mode === 'sell' ? saveSell_(p, ctx, user) : d.mode === 'update' ? saveInvUpdate_(p, ctx) : saveBuy_(p, ctx, user);
    case 'fix':
      return finishStep_(p, '✏️ OK. Send <code>/inv update</code> again with the corrected names. Names I know: ' +
        escapeHtml_(knownAssets_(ctx.investments.filter(function (x) { return x.holding; })).map(function (a) { return a.name; }).join(', ')) + '.');
  }
  if (d.mode === 'sell') advanceSell_(p, ctx);
  else advanceBuy_(p, ctx);
}

/** Text sent while an investment step waits for it. */
function handleInvText_(p, message) {
  const d = p.d;
  const text = String(message.text).trim();
  const tokens = tokenize_(text);
  if (p.awaitText === 'date') {
    const date = parseDateOnly_(text, new Date());
    if (date === null) return sendMessage(p.chatId, "I couldn't read that date. Try <code>kemarin</code> or <code>20/09</code>.");
    d.date = date.getTime();
  } else {
    const nums = readInvNumbers_(tokenize_(normalizeInvText_(text)));
    const loose = nums.plain.concat(nums.bare);
    if (nums.qty === null && nums.price === null && nums.total === null && !nums.all && loose.length === 0) {
      return sendMessage(p.chatId, "I couldn't read a number there. Try again, or /cancel.");
    }
    if (d.mode === 'buy') {
      // Answer to "how many / what price / total?": merge into what was typed before.
      const hadQty = d.qty !== null;
      const hadPriceOrTotal = d.priceStored !== null || d.total !== null;
      freezeInvNumbers_(d);
      const x = d.in;
      if (nums.qty !== null) { x.qty = nums.qty; x.qtyUnit = nums.qtyUnit; }
      if (nums.price !== null) { x.price = nums.price; x.priceSuffix = nums.priceSuffix; x.total = nums.total; }
      if (nums.total !== null) { x.total = nums.total; if (nums.price === null) x.price = null; }
      if (loose.length) {
        // Asked "how many?" → a number is the quantity. Asked "total or price?" → a lone value is the total.
        if (!hadQty && hadPriceOrTotal) x.qty = loose[0];
        else if (hadQty && !hadPriceOrTotal) x.total = loose[0];
        else { x.plain = nums.plain; x.bare = nums.bare; }
      }
    } else {
      if (nums.qty !== null) { d.qty = nums.qty; d.qtyUnit = nums.qtyUnit; d.lotFixed = false; }
      if (nums.price !== null) { d.price = nums.price; d.priceSuffix = nums.priceSuffix; }
      if (nums.total !== null) d.total = nums.total;
      if (nums.all) d.all = true;
      if (loose.length) {
        if (p.awaitText === 'sellprice') d.total = loose[0]; // a lone value is the total
        else d.qty = loose[0];
      }
    }
  }
  dropButtons_(p.chatId, p.msgId);
  p.msgId = null;
  const ctx = invCtx_(false);
  if (d.mode === 'sell') advanceSell_(p, ctx);
  else advanceBuy_(p, ctx);
}

function saveBuy_(p, ctx, user) {
  const d = p.d;
  if (isMonthClosed_(ctx.ss, d.date)) return advanceBuy_(p, ctx);
  const loggedBy = user && user.name ? user.name : p.chatId;
  const cost = roundInv_(d.total + (d.fee || 0));
  const date = new Date(d.date);
  const saved = withScriptLock_(function () {
    const current = getPending_(p.chatId);
    if (!current || current.pid !== p.pid) return null;
    const ss = ctx.ss;
    // Every read first (IDs, rows, the price columns), then the writes.
    const link = nextId_(ss.getSheetByName(TAB.TRANSACTIONS), 'Link ID', 'LNK');
    const slot = nextTransactionSlot_(ss);
    const invSheet = ss.getSheetByName(TAB.INVESTMENTS);
    const invId = nextId_(invSheet, 'Inv ID', 'INV');
    const invRow = lastDataRow_(invSheet, 'Asset Name') + 1;
    // The purchase price becomes the asset's latest price: its other holding rows get it too.
    const others = ctx.investments.filter(function (x) { return x.asset.toLowerCase() === d.asset.toLowerCase() && x.holding && x.id; });
    const newRow = { id: invId, asset: d.asset, qty: d.qty, unit: d.unit };
    const prices = d.unit === 'nominal' ? null : preparePrices_(ss,
      others.map(function (x) { return { inv: x, price: d.priceStored }; }),
      others.concat([newRow]).map(function (x) { return { inv: x, price: d.priceStored }; }), 'Manual', midnight_(date));
    // (favKnownColumns_ skips columns an old sheet doesn't have yet, e.g. Investment Wallet before upgradeSheets)
    writeRowsByHeaders_(invSheet, invRow, [favKnownColumns_(invSheet, {
      'Inv ID': invId, 'Link ID': link, 'Investment Date': midnight_(date), 'Investment Category': d.category,
      'Investment Wallet': d.invWallet,
      'Asset Name': d.asset, 'Platform': d.platform || '', 'Unit': d.unit, 'Quantity': d.qty,
      'Acquisition Price': roundInv_(cost / (d.qty * lotMult_(d.unit))), 'Acquisition Cost': cost,
      'Current Price': d.unit === 'nominal' ? 1 : d.priceStored, 'Last Price Update': midnight_(date),
      'Source Wallet': d.wallet, 'Status': 'Holding'
    }).values]);
    const trx = writeTransaction_(ss, { type: 'Investment Buy', direction: 'Transfer', amount: cost, wallet: d.wallet,
      toWallet: d.invWallet, category: invCategoryName_(ctx, d.category), categoryHow: 'chosen', date: d.date,
      note: 'Buy ' + formatQty_(d.qty, d.unit) + ' ' + d.asset }, loggedBy, link, slot);
    if (prices) prices.commit();
    clearPending_(p.chatId);
    return { invId: invId, trx: trx, link: link };
  });
  if (saved === null) return;
  editMessage(p.chatId, p.msgId, '✅ Bought <b>' + escapeHtml_(d.asset) + '</b>: ' + saved.invId + ' + ' + saved.trx + ' (' + saved.link + ').');
}

/** The Transactions category of an investment: its investment category (the Categories spelling if it is there). */
function invCategoryName_(ctx, category) {
  const c = ctx.categories.filter(function (x) { return x.name.toLowerCase() === String(category).toLowerCase(); })[0];
  return c ? c.name : category;
}

function saveSell_(p, ctx, user) {
  const d = p.d;
  if (isMonthClosed_(ctx.ss, d.date)) return advanceSell_(p, ctx);
  const loggedBy = user && user.name ? user.name : p.chatId;
  const fee = d.fee || 0;
  const date = new Date(d.date);
  const saved = withScriptLock_(function () {
    const current = getPending_(p.chatId);
    if (!current || current.pid !== p.pid) return null;
    const ss = ctx.ss;
    // Re-check against the sheet as it is now.
    const rows = loadInvestments_(ss).filter(function (x) {
      return x.asset === d.asset && x.holding && (!d.invWallet || x.invWallet === d.invWallet); // only the wallet it is sold from
    });
    const alloc = allocateSale_(rows, d.qty, d.picked);
    if (alloc.error) return { error: 'inv_too_much', held: alloc.held };
    const link = nextId_(ss.getSheetByName(TAB.TRANSACTIONS), 'Link ID', 'LNK');
    const slot = nextTransactionSlot_(ss);
    const salesSheet = ss.getSheetByName(TAB.SALES);
    const salesRow = lastDataRow_(salesSheet, 'Sale ID') + 1;
    let saleNo = Number(String(nextId_(salesSheet, 'Sale ID', 'SAL')).replace(/\D/g, ''));
    const saleRows = alloc.parts.map(function (x, i) {
      return { 'Sale ID': 'SAL-' + String(saleNo++).padStart(4, '0'), 'Inv ID': x.inv.id, 'Sale Date': midnight_(date),
        'Quantity Sold': x.qty, 'Sale Price': d.priceStored, 'Fees': i === 0 ? fee : 0, 'To Wallet': d.wallet, 'Link ID': link };
    });
    const kept = favKnownColumns_(salesSheet, saleRows[0]); // an old sheet without "Link ID" still works
    const invSheet = ss.getSheetByName(TAB.INVESTMENTS);
    const qtys = {};
    const statuses = {};
    alloc.parts.forEach(function (x) {
      const left = roundInv_(x.inv.qty - x.qty);
      qtys[x.inv.id] = left;
      statuses[x.inv.id] = left > 1e-9 ? 'Partially Sold' : 'Sold';
    });
    // Every read first (rows, IDs, columns), then the writes.
    const after = rows.map(function (x) { return { id: x.id, asset: x.asset, unit: x.unit, qty: qtys[x.id] !== undefined ? qtys[x.id] : x.qty }; })
      .filter(function (x) { return x.qty > 1e-9; }).map(function (x) { return { inv: x, price: d.priceStored }; });
    const steps = [prepareColumnById_(invSheet, 'Inv ID', 'Quantity', qtys), prepareColumnById_(invSheet, 'Inv ID', 'Status', statuses)];
    if (d.unit !== 'nominal') steps.push(preparePrices_(ss, after, after, 'Manual', midnight_(date)));
    writeRowsByHeaders_(salesSheet, salesRow, saleRows.map(function (r) {
      const o = {};
      Object.keys(kept.values).forEach(function (k) { o[k] = r[k]; });
      return o;
    }));
    const trx = writeTransaction_(ss, { type: 'Investment Sell', direction: 'Transfer', amount: roundInv_(d.total - fee),
      wallet: d.invWallet, toWallet: d.wallet, category: invCategoryName_(ctx, d.category), categoryHow: 'chosen', date: d.date,
      note: 'Sell ' + formatQty_(d.qty, d.unit) + ' ' + d.asset }, loggedBy, link, slot);
    steps.forEach(function (s) { s.commit(); });
    clearPending_(p.chatId);
    return { trx: trx, link: link, sales: saleRows.map(function (r) { return r['Sale ID']; }), gain: saleGain_(alloc.parts, d.priceStored, fee) };
  });
  if (saved === null) return;
  if (saved.error) {
    d.picked = null;
    return advanceSell_(p, invCtx_(false));
  }
  editMessage(p.chatId, p.msgId, '✅ Sold <b>' + escapeHtml_(d.asset) + '</b>: ' + saved.sales.join(', ') + ' + ' + saved.trx +
    ' (' + saved.link + '). Realized gain ' + formatRpSigned_(Math.round(saved.gain)) + '.');
}

/** "/inv sell" without details: pick the asset, then type quantity and price. */
function startGuidedSell_(chatId) {
  const ctx = invCtx_(true);
  const assets = knownAssets_(ctx.investments.filter(function (x) { return x.holding; }));
  if (assets.length === 0) return sendMessage(chatId, 'You hold no investments to sell.');
  const p = newPending_(chatId, 'inv', { mode: 'sellpick' });
  p.opts = assets.map(function (a) { return a.name; });
  const rows = chunk_(p.opts.map(function (n, i) { return btn_(p, n, 'sv', i); }), 3);
  rows.push(cancelRow_(p));
  showStep_(p, '📉 Which asset do you sell?', rows);
}

// ---------------------------------------------------------------------------
// /inv update
// ---------------------------------------------------------------------------

function startInvUpdate_(chatId, text) {
  const ctx = invCtx_(true);
  if (!text) {
    return sendMessage(chatId, 'Send the new prices, one asset per line:\n<pre>/inv update\n' +
      priceTemplateLines_(ctx.investments).join('\n') + '</pre>' +
      (ctx.investments.some(function (x) { return x.holding; }) ? '' : '\n(You hold nothing yet.)'));
  }
  const r = parseInvUpdate_(text, ctx.investments);
  if (r.items.length === 0 && r.unknown.length === 0) {
    return sendMessage(chatId, invErrorText_({ error: 'inv_update_usage', bad: r.bad }));
  }
  const p = newPending_(chatId, 'inv', { mode: 'update', bulk: text.split(/\n|;/).filter(function (l) { return l.trim(); }).length > 1,
    items: r.items.map(function (it) { return { name: it.name, ids: it.rows.map(function (x) { return x.id; }), unit: it.unit, price: it.price,
      old: it.old, qty: it.qty }; }) });
  const lines = ['📈 <b>Price update</b>'];
  r.items.forEach(function (it) {
    const change = it.old ? (it.price - it.old) / it.old : 0;
    lines.push('• <b>' + escapeHtml_(it.name) + '</b>' + (it.rows.length > 1 ? ' (' + it.rows.length + ' rows)' : '') + ': ' +
      (it.unit === 'nominal' ? formatRp_(it.old * it.qty) + ' → ' + formatRp_(it.price * it.qty)
        : formatInvPrice_(it.old, it.unit) + ' → <b>' + formatInvPrice_(it.price, it.unit) + '</b>') +
      ' (' + (change >= 0 ? '+' : '') + formatNumId_(change * 100, 1) + '%)' +
      (Math.abs(change) > INV_PRICE_JUMP ? ' ⚠️ big change' : ''));
  });
  if (r.bad.length) lines.push('', "⚠️ Couldn't read: " + escapeHtml_(r.bad.join(' | ')));
  const rows = [];
  if (r.unknown.length) {
    lines.push('', '❓ Not found: <b>' + escapeHtml_(r.unknown.join(', ')) + '</b>');
    if (r.items.length) rows.push([btn_(p, '✅ Skip those, save the rest', 'y'), btn_(p, '✏️ Correct it', 'fix')]);
    else rows.push([btn_(p, '✏️ Correct it', 'fix')]);
  } else {
    rows.push([btn_(p, '✅ Save', 'y'), btn_(p, '❌ Cancel', 'n')]);
  }
  if (r.unknown.length) rows.push(cancelRow_(p));
  showStep_(p, lines.join('\n'), rows);
}

function saveInvUpdate_(p, ctx) {
  const d = p.d;
  if (!claimPending_(p)) return;
  const today = midnight_(new Date());
  let count = 0;
  withScriptLock_(function () {
    const byId = {};
    loadInvestments_(ctx.ss).forEach(function (x) { byId[x.id] = x; });
    const items = [];
    d.items.forEach(function (it) {
      it.ids.forEach(function (id) { if (byId[id] && byId[id].holding) items.push({ inv: byId[id], price: it.price }); });
    });
    applyPrices_(ctx.ss, items, d.bulk ? 'Bulk' : 'Manual', today);
    count = items.length;
  });
  finishStep_(p, '✅ Updated ' + d.items.length + ' asset' + (d.items.length === 1 ? '' : 's') + ' (' + count + ' row' + (count === 1 ? '' : 's') +
    '). Saved to Price_History. /inv shows the new values.');
}

/** "BBCA 9.800" lines for every held asset (latest price), for copying. */
function priceTemplateLines_(investments) {
  return invSummary_(investments, []).reduce(function (lines, c) {
    return lines.concat(c.assets.filter(function (a) { return a.qty > 1e-9; }).map(function (a) {
      return escapeHtml_(a.name) + ' ' + (a.unit === 'nominal' ? formatNumId_(Math.round(a.value), 0) : typedPrice_(a.last, a.unit) +
        (a.unit === 'lot' || a.unit === 'share' ? '' : '/' + unitLabel_(a.unit)));
    }));
  }, []);
}

// ---------------------------------------------------------------------------
// Last-day 12:00 reminder (a slot in Reminders.gs)
// ---------------------------------------------------------------------------

function isLastDayOfMonth_(now) {
  return addDays_(now, 1).getDate() === 1;
}

/** The price reminder text, or null when nothing is held. */
function buildPriceReminderText_(investments) {
  const lines = priceTemplateLines_(investments);
  if (lines.length === 0) return null;
  return '📈 <b>Time to update investment prices</b> (last day of the month). Last prices:\n<pre>/inv update\n' + lines.join('\n') +
    '</pre>\nCopy it, change the numbers, send it. (Prices you typed in the Investments tab count too.)';
}

function runPriceReminder_(now) {
  const ss = openMainSheet_();
  if (ss === null) return;
  const text = buildPriceReminderText_(syncSheetPrices_(ss));
  if (!text) return;
  uniqueChatIds_((getUsers_() || []).filter(function (u) { return u.active; })).forEach(function (chatId) {
    try {
      sendMessage(chatId, text);
    } catch (err) {
      logError_('runPriceReminder_', err, chatId);
    }
  });
}

// ---------------------------------------------------------------------------
// /undo
// ---------------------------------------------------------------------------

/**
 * What else an /undo of these Transactions rows must change: a buy removes its
 * Investments row (blocked once something of it was sold); a sale gives the
 * quantities back and removes its Investment_Sales rows.
 */
function invUndoPlan_(ss, groupRows) {
  const plan = { deleteInv: [], restore: [], deleteSales: [] };
  const links = groupRows.filter(function (r) { return /^Investment (Buy|Sell)$/.test(String(r['type'])); })
    .map(function (r) { return String(r['link id'] || '').trim(); }).filter(String);
  if (links.length === 0) return plan;
  const invs = loadInvestments_(ss);
  const salesSheet = ss.getSheetByName(TAB.SALES);
  const sales = salesSheet ? readTableByHeaders_(salesSheet, 'Inv ID') : [];
  const bought = invs.filter(function (x) { return links.indexOf(x.link) !== -1; });
  const soldFrom = sales.filter(function (s) { return bought.some(function (x) { return x.id === String(s['inv id']).trim(); }); });
  if (soldFrom.length) {
    plan.blocked = 'Part of ' + bought.map(function (x) { return x.id; }).join(', ') + ' was already sold. Undo the sale first.';
    return plan;
  }
  plan.deleteInv = bought.map(function (x) { return x.id; });
  sales.filter(function (s) { return links.indexOf(String(s['link id'] || '').trim()) !== -1; }).forEach(function (s) {
    plan.deleteSales.push(String(s['sale id']).trim());
    plan.restore.push({ id: String(s['inv id']).trim(), qty: Number(s['quantity sold']) || 0 });
  });
  return plan;
}

function applyInvUndo_(ss, plan) {
  if (!plan || plan.blocked || (plan.deleteInv.length + plan.deleteSales.length === 0)) return;
  withScriptLock_(function () {
    const invSheet = ss.getSheetByName(TAB.INVESTMENTS);
    if (plan.restore.length) {
      const invs = loadInvestments_(ss);
      const salesLeft = readTableByHeaders_(ss.getSheetByName(TAB.SALES), 'Inv ID').filter(function (s) {
        return plan.deleteSales.indexOf(String(s['sale id']).trim()) === -1;
      });
      const qtys = {};
      const statuses = {};
      plan.restore.forEach(function (r) {
        const x = invs.filter(function (i) { return i.id === r.id; })[0];
        if (!x) return;
        qtys[r.id] = roundInv_((qtys[r.id] !== undefined ? qtys[r.id] : x.qty) + r.qty);
        statuses[r.id] = salesLeft.some(function (s) { return String(s['inv id']).trim() === r.id; }) ? 'Partially Sold' : 'Holding';
      });
      setColumnById_(invSheet, 'Inv ID', 'Quantity', qtys);
      setColumnById_(invSheet, 'Inv ID', 'Status', statuses);
    }
    if (plan.deleteSales.length) {
      const salesSheet = ss.getSheetByName(TAB.SALES);
      readTableByHeaders_(salesSheet, 'Inv ID').filter(function (s) { return plan.deleteSales.indexOf(String(s['sale id']).trim()) !== -1; })
        .sort(function (a, b) { return b._row - a._row; }).forEach(function (s) { salesSheet.deleteRow(s._row); });
    }
    loadInvestments_(ss).filter(function (x) { return plan.deleteInv.indexOf(x.id) !== -1; })
      .sort(function (a, b) { return b.row - a.row; }).forEach(function (x) { invSheet.deleteRow(x.row); });
  });
}

function invErrorText_(r) {
  switch (r.error) {
    case 'inv_buy_usage':
      return 'Write it like:\n• <code>beli emas 2gr 1.350rb/gr dari BCA</code>\n• <code>beli BBCA 2 lot 9.800/lembar dari IPOT fee 3rb</code>\n' +
        '• <code>beli RDPU X 150,5 unit @1.520 via Bibit</code>\n• <code>jual BBCA 1 lot harga 10.200 ke BCA</code>';
    case 'inv_no_asset':
      return 'Which asset? e.g. <code>' + (r.kind === 'sell' ? 'jual BBCA 1 lot 10.200' : 'beli BBCA 2 lot 9.800') + '</code>';
    case 'inv_extra_words':
      return "I didn't understand \"" + escapeHtml_(r.words.join(' ')) + '". ' + invErrorText_({ error: 'inv_buy_usage' });
    case 'inv_unknown_asset':
      return 'You don\'t hold "' + escapeHtml_(r.asset) + '". /inv shows what you hold.';
    case 'inv_which_asset':
      return 'Which one? You hold ' + escapeHtml_(r.names.join(', ')) + '. e.g. <code>jual ' + escapeHtml_(r.names[0]) + ' …</code>';
    case 'inv_nothing_held':
      return 'You hold no ' + escapeHtml_(r.asset) + ' any more.';
    case 'inv_no_source':
      return 'No wallet can pay for investments yet. In the Wallets tab, add the group <b>Investment Wallet</b> to the ' +
        'wallets you buy from, e.g. Wallet Group = <code>Spending, Investment Wallet</code> (several groups, comma-separated).';
    case 'inv_no_categories':
      return 'There is no investment wallet yet. Add one with <code>/wallet add IPOT Saham</code> (type Saham, then pick its ' +
        'investment category), or set Wallet Type to Emas / Saham / Others and Investment Category in the Wallets tab.';
    case 'inv_too_many_numbers':
      return 'I found too many amounts. Mark them, e.g. <code>2gr harga 1.350rb</code> or <code>2gr total 2.7jt</code>.';
    case 'inv_zero':
      return 'The quantity and amount must be more than 0.';
    case 'inv_update_usage':
      return "I couldn't read that" + (r.bad && r.bad.length ? ' (' + escapeHtml_(r.bad.join(' | ')) + ')' : '') +
        '. One asset per line: <code>BBCA 9.800</code>, <code>emas 1.380rb/gr</code>.';
    case 'inv_filter':
      return 'No category or asset called "' + escapeHtml_(r.filter) + '". /inv shows everything.';
    default:
      return parseErrorText_(r);
  }
}
