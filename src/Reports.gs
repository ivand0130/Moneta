/**
 * Reports.gs — monthly report (SPEC Section 16), /report [month] [year].
 *
 * buildReportData_ works out every number from plain lists (pure, so
 * testReport can check it). Where the lists come from:
 *   an open month   → the main sheet (live, "so far" for the current month)
 *   a closed month  → its archive sheet (Monthly Report → Archive Link), which
 *                     holds that month's complete data; budgets from
 *                     Budget_History and moved items from Closed_History in
 *                     the main sheet. If the archive can't be opened, the
 *                     saved Monthly Report row is shown instead.
 * Expense / income use the shared rules (countsAsExpense_ / countsAsIncome_),
 * so /report, /budget and the Dashboard agree. Chat amounts go through the
 * spoiler helper (money_); the Report tab in the archive is plain.
 */

const REPORT_LIST_MAX = 8; // categories / wallets shown in chat (the archive Report tab has all)

// ---------------------------------------------------------------------------
// Months (pure)
// ---------------------------------------------------------------------------

/**
 * "oktober 2026" / "okt" / "10 2026" / "10/2026" / "2026-10" / "" →
 * { year, month (0-based), given }. A month name without a year that is
 * later than this month means last year ("desember" in November 2026 → Dec 2025).
 * Returns null when it can't be read.
 */
function parseMonthArg_(text, now) {
  const t = String(text || '').toLowerCase().replace(/^(bulan|month)\s+/, '').replace(/\s+/g, ' ').trim();
  if (!t) return { year: now.getFullYear(), month: now.getMonth(), given: false };
  const ok = function (y, m) { return m >= 0 && m <= 11 && y >= 2000 && y <= 2100 ? { year: y, month: m, given: true } : null; };
  let m;
  if ((m = t.match(/^(\d{4})[-\/](\d{1,2})$/))) return ok(+m[1], +m[2] - 1);
  if ((m = t.match(/^(\d{1,2})[-\/ ](\d{4})$/))) return ok(+m[2], +m[1] - 1);
  if ((m = t.match(/^([a-z]+)\.?(?: (\d{4}))?$/)) && MONTH_WORDS[m[1]] !== undefined) {
    const mo = MONTH_WORDS[m[1]];
    return ok(m[2] ? +m[2] : (mo > now.getMonth() ? now.getFullYear() - 1 : now.getFullYear()), mo);
  }
  return null;
}

/** 2026, 9 → 202610 (the Month Key column). */
function monthKey_(year, month) {
  return year * 100 + month + 1;
}

/** 202610 → { year: 2026, month: 9 }. */
function monthOfKey_(key) {
  return { year: Math.floor(Number(key) / 100), month: Number(key) % 100 - 1 };
}

/** "October 2026" (long = true) or "Oct 2026". */
function monthLabel_(year, month, long) {
  return Utilities.formatDate(new Date(year, month, 1), Session.getScriptTimeZone(), long ? 'MMMM yyyy' : 'MMM yyyy');
}

// ---------------------------------------------------------------------------
// The numbers (pure)
// ---------------------------------------------------------------------------

/**
 * src = { trx (Transactions rows, lowercase keys), wallets (loadWallets_),
 * openings { wallet: Opening Balance }, debts (loadDebts_), investments,
 * sales, favorites, categories, investmentGroups, prev ({ income, expense,
 * portfolio, netWorth } of the month before, or null), budgetRows
 * (Budget_History rows of this month, closed months only), closedItems
 * (Closed_History rows of this month), prices (Price_History rows, lowercase
 * keys; optional) }. `now` decides "overdue" for the current month.
 * filter (optional) = { label, wallets: [wallet names] } from
 * resolveReportFilter_: income / expense / categories / top / wallets /
 * transfers then cover only rows whose Wallet is one of them (a transfer to
 * or from another wallet is listed as a transfer, never income/expense).
 */
function buildReportData_(src, year, month, now, filter) {
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 1);
  const cutoff = now && now < end ? now : end; // overdue / balances: today for the current month
  const dateOf = function (r) { return r['date'] instanceof Date ? r['date'] : null; };
  const inMonth = src.trx.filter(function (r) { const d = dateOf(r); return d && d >= start && d < end; });
  const amt = function (r) { return Number(r['amount']) || 0; };
  const sum = function (list, f) { return list.reduce(function (s, x) { return s + (f ? f(x) : x); }, 0); };
  const str = function (v) { return String(v === undefined || v === null ? '' : v).trim(); };
  const inFilter = {};
  if (filter) filter.wallets.forEach(function (w) { inFilter[w] = true; });
  const inF = function (name) { return !filter || inFilter[str(name)] === true; };
  // The rows of the filtered wallets (all rows when not filtered)
  const own = filter ? inMonth.filter(function (r) { return inF(r['wallet']); }) : inMonth;

  const incomeRows = own.filter(countsAsIncome_);
  const expenseRows = own.filter(countsAsExpense_);
  const income = sum(incomeRows, amt);
  const expense = sum(expenseRows, amt);

  // Expense by category, top 5
  const catTotals = {};
  expenseRows.forEach(function (r) { const c = str(r['category']) || '(no category)'; catTotals[c] = (catTotals[c] || 0) + amt(r); });
  const categories = Object.keys(catTotals).map(function (c) {
    return { name: c, amount: catTotals[c], pct: expense ? catTotals[c] / expense : 0 };
  }).sort(function (a, b) { return b.amount - a.amount; });
  const top = expenseRows.slice().sort(function (a, b) { return amt(b) - amt(a); }).slice(0, 5).map(function (r) {
    return { date: dateOf(r), note: str(r['note']), category: str(r['category']), amount: amt(r), wallet: str(r['wallet']) };
  });

  // Adjustments (In = +, Out = −), excluded from income / expense
  const adjRows = own.filter(function (r) { return str(r['type']) === 'Adjustment'; });
  const adjustments = sum(adjRows, function (r) { return str(r['direction']) === 'Out' ? -amt(r) : amt(r); });

  // Wallets: opening + every row before the month start / before the month end
  const cash = src.wallets.filter(function (w) { return w.type === 'Cash'; });
  const balanceBefore = function (w, until) {
    return (src.openings[w.name] || 0) + sum(src.trx.filter(function (r) { const d = dateOf(r); return d && d < until; }),
      function (r) { return walletEffect_(r, w.name); });
  };
  const wallets = cash.map(function (w) {
    const s = balanceBefore(w, start);
    const e = balanceBefore(w, end);
    return { name: w.name, group: w.group || '(no group)', start: s, end: e, change: e - s, active: w.active };
  }).filter(function (w) { return (w.active || w.start || w.end) && inF(w.name); });
  const groups = {};
  wallets.forEach(function (w) {
    const gName = filter ? filter.label : w.group; // filtered: one subtotal for the filter
    const g = groups[gName] = groups[gName] || { name: gName, start: 0, end: 0 };
    g.start += w.start;
    g.end += w.end;
  });
  const groupOf = {};
  src.wallets.forEach(function (w) { groupOf[w.name] = w.group || '(no group)'; });
  const moves = {};
  inMonth.forEach(function (r) {
    if (str(r['direction']) !== 'Transfer') return;
    if (filter) { // money moving into / out of the filtered wallets, wallet by wallet
      const a = str(r['wallet']), b = str(r['to wallet']);
      if (inF(a) === inF(b)) return;
      moves[a + ' → ' + b] = (moves[a + ' → ' + b] || 0) + amt(r);
      return;
    }
    const from = groupOf[str(r['wallet'])], to = groupOf[str(r['to wallet'])];
    if (!from || !to || from === to) return;
    moves[from + ' → ' + to] = (moves[from + ' → ' + to] || 0) + amt(r);
  });
  const transfers = Object.keys(moves).sort().map(function (k) { return { name: k, amount: moves[k] }; });

  // Hutang / piutang (group parents are skipped: their sub-records hold the amounts)
  const byId = {};
  src.debts.forEach(function (d) { byId[d.id] = d; });
  const hasKids = {};
  src.debts.forEach(function (d) { if (d.parent) hasKids[d.parent] = true; });
  const typeOfDebt = function (id) {
    const rec = byId[id];
    if (rec) return rec.type;
    return /^HTG/i.test(id) ? 'Hutang' : /^PTG/i.test(id) ? 'Piutang' : '';
  };
  const debtSummary = function (type) {
    const recs = src.debts.filter(function (d) { return d.type === type && !hasKids[d.id]; });
    const open = recs.filter(isOpenDebt_);
    const overdue = open.filter(function (d) { return d.due && d.due < cutoff; });
    const rowsOf = function (test) {
      return inMonth.filter(function (r) { const id = str(r['debt id']); return id && typeOfDebt(id) === type && test(r); });
    };
    return {
      created: sum(rowsOf(function (r) { return str(r['type']) === type; }), amt),
      paid: sum(rowsOf(function (r) { return str(r['type']) === 'Settlement'; }), amt),
      converted: sum(rowsOf(function (r) { return str(r['direction']) === 'None' && (countsAsExpense_(r) || countsAsIncome_(r)); }), amt),
      remaining: sum(open, function (d) { return d.remaining; }), open: open.length,
      overdue: overdue.length, overdueAmount: sum(overdue, function (d) { return d.remaining; })
    };
  };
  const hutang = debtSummary('Hutang');
  const piutang = debtSummary('Piutang');

  // Investments
  const invById = {};
  src.investments.forEach(function (x) { invById[x.id] = x; });
  const summary = invSummary_(src.investments, src.sales);
  const portfolio = sum(summary, function (c) { return c.value; });
  const salesInMonth = src.sales.filter(function (s) { return s.date && s.date >= start && s.date < end && invById[s.invId]; });
  // Opening value per category: Price_History Month-End rows of the previous month's last day (written by closing)
  const prevLast = new Date(year, month, 0);
  const sameDay = function (d) {
    return d instanceof Date && d.getFullYear() === prevLast.getFullYear() && d.getMonth() === prevLast.getMonth() && d.getDate() === prevLast.getDate();
  };
  const catOfInv = function (id, asset) {
    if (invById[id]) return invById[id].category;
    const same = src.investments.filter(function (x) { return asset && x.asset.toLowerCase() === asset.toLowerCase(); })[0];
    return same ? same.category : '(other)';
  };
  const openingByCat = {};
  let hasOpening = false;
  (src.prices || []).forEach(function (p) {
    if (str(p['month-end']).toLowerCase() !== 'yes' || !sameDay(p['date'])) return;
    const c = catOfInv(str(p['inv id']), str(p['asset name']));
    openingByCat[c] = (openingByCat[c] || 0) + (Number(p['value']) || 0);
    hasOpening = true;
  });
  const invCats = summary.map(function (c) {
    const opening = hasOpening ? openingByCat[c.name] || 0 : null;
    return { name: c.name, opening: opening, value: c.value, change: opening === null ? null : c.value - opening,
      cost: c.cost, unrealized: c.unrealized, unrealizedPct: c.cost ? c.unrealized / c.cost : null };
  });
  Object.keys(openingByCat).sort().forEach(function (k) { // held at the start, gone from the summary now
    if (summary.some(function (c) { return c.name === k; })) return;
    invCats.push({ name: k, opening: openingByCat[k], value: 0, change: -openingByCat[k], cost: 0, unrealized: 0, unrealizedPct: null });
  });
  const invCost = sum(summary, function (c) { return c.cost; });
  const invUnrealized = sum(summary, function (c) { return c.unrealized; });
  const prevPortfolio = src.prev && src.prev.portfolio !== null && src.prev.portfolio !== undefined ? src.prev.portfolio : null;
  const investments = {
    invested: sum(inMonth.filter(function (r) { return str(r['type']) === 'Investment Buy'; }), amt),
    sold: sum(inMonth.filter(function (r) { return str(r['type']) === 'Investment Sell'; }), amt),
    value: portfolio,
    // Opening: the Month-End rows when there are any, else last month's Monthly Report Portfolio Value (or null)
    opening: hasOpening ? sum(Object.keys(openingByCat), function (k) { return openingByCat[k]; }) : prevPortfolio,
    cost: invCost,
    unrealized: invUnrealized,
    unrealizedPct: invCost ? invUnrealized / invCost : null,
    realized: sum(salesInMonth, function (s) {
      const x = invById[s.invId];
      return s.qty * lotMult_(x.unit) * (s.price - x.price) - s.fee;
    }),
    change: prevPortfolio === null ? null : portfolio - prevPortfolio,
    categories: invCats.filter(function (c) { return c.value > 0 || c.opening; })
  };

  const cashEnd = sum(wallets, function (w) { return w.end; });
  const netWorth = cashEnd + portfolio + piutang.remaining - hutang.remaining;

  // Favorites with a schedule: logged this month / skipped / neither
  const favs = (src.favorites || []).filter(function (f) { return f.active && f.schedule; }).map(function (f) {
    const paid = inMonth.some(function (r) { return f.id && str(r['favorite id']) === f.id; });
    const skipped = !paid && f.lastSkipped && f.lastSkipped >= start && f.lastSkipped < end;
    return { name: f.name, status: paid ? 'paid' : skipped ? 'skipped' : 'not logged' };
  });

  // Budgets: Budget_History for a closed month, the Categories tab otherwise
  const budgets = src.budgetRows && src.budgetRows.length
    ? src.budgetRows.map(function (b) { return { name: str(b['category']), budget: Number(b['budget']) || 0, spent: Number(b['spent']) || 0 }; })
    : (src.categories || []).filter(function (c) { return c.type === 'Expense' && c.budget > 0; }).map(function (c) {
      return { name: c.name, budget: c.budget, spent: sum(expenseRows.filter(function (r) { return str(r['category']) === c.name; }), amt) };
    });
  budgets.forEach(function (b) { // same Under / At / Over rule as Budget_History
    b.remaining = b.budget - b.spent;
    b.status = b.spent > b.budget ? 'Over' : b.spent === b.budget ? 'At' : 'Under';
  });

  // By user (Logged By)
  const users = {};
  own.forEach(function (r) {
    const u = str(r['logged by']) || '(unknown)';
    const x = users[u] = users[u] || { name: u, income: 0, expense: 0, count: 0 };
    x.count++;
    if (countsAsIncome_(r)) x.income += amt(r);
    if (countsAsExpense_(r)) x.expense += amt(r);
  });

  return {
    year: year, month: month, key: monthKey_(year, month), label: monthLabel_(year, month, true),
    filter: filter ? { label: filter.label, wallets: filter.wallets.slice() } : null,
    income: income, expense: expense, net: income - expense,
    count: filter ? inMonth.filter(function (r) { return inF(r['wallet']) || (str(r['to wallet']) && inF(r['to wallet'])); }).length : inMonth.length,
    prev: src.prev || null, adjustments: adjustments, adjustmentCount: adjRows.length,
    categories: categories, top: top, wallets: wallets,
    groups: Object.keys(groups).sort().map(function (k) { const g = groups[k]; g.change = g.end - g.start; return g; }),
    transfers: transfers, hutang: hutang, piutang: piutang, investments: investments,
    cash: cashEnd, netWorth: netWorth, favorites: favs, budgets: budgets,
    users: Object.keys(users).sort().map(function (k) { return users[k]; }),
    closedItems: src.closedItems || []
  };
}

// ---------------------------------------------------------------------------
// Chat text, Report tab rows, Monthly Report row (pure)
// ---------------------------------------------------------------------------

/** "▲12%" / "▼5%" / "" (no previous number). */
function changePct_(now, before) {
  if (!before) return '';
  const p = Math.round((now - before) / Math.abs(before) * 100);
  return p === 0 ? '=' : (p > 0 ? '▲' : '▼') + Math.abs(p) + '%';
}

/** " (+5,2%)" / " (−3%)" for a ratio (0.052), or '' when there is none. Not an amount, so never hidden. */
function reportPct_(ratio) {
  if (ratio === null || ratio === undefined || !isFinite(ratio)) return '';
  return ' (' + (ratio < 0 ? '−' : '+') + formatNumId_(Math.abs(ratio * 100), 1) + '%)';
}

/** A budget's remaining amount (negative = over) for the chat, through the spoiler helper. */
function budgetRemainingText_(b, hide) {
  return b.remaining < 0 ? spoiler_('−' + formatRp_(-b.remaining), hide) : money_(b.remaining, hide);
}

/** The chat summary. state = 'closed' | 'live'; link = the archive Report tab (closed months). */
function formatReportText_(r, hide, state, link) {
  const m = function (n) { return money_(n, hide); };
  const signed = function (n) { return n < 0 ? spoiler_('−' + formatRp_(-n), hide) : spoiler_('+' + formatRp_(n), hide); };
  const orDash = function (n, f) { return n === null || n === undefined ? '—' : f(n); };
  const f = r.filter;
  // An earlier month that isn't closed yet: debts, investments and net worth are today's values, not its month end.
  const today = new Date();
  const asOf = state === 'live' && monthKey_(r.year, r.month) < monthKey_(today.getFullYear(), today.getMonth()) ? ' <i>(as of today)</i>' : '';
  const L = [];
  L.push('📊 <b>Report · ' + escapeHtml_(r.label) + '</b> ' + (state === 'closed' ? '🔒 closed' : '<i>(open, so far)</i>'));
  if (f) {
    L.push('🔎 <b>Filtered: ' + escapeHtml_(f.label) + '</b>' +
      (f.wallets.length !== 1 || f.wallets[0] !== f.label ? ' (' + escapeHtml_(f.wallets.join(', ')) + ')' : ''),
      '<i>Only rows of these wallets. Debts, investments, net worth, budgets and favorites are in the full /report.</i>');
  }
  L.push('💵 Income ' + m(r.income) + ' · 🧾 Expense ' + m(r.expense) + ' · Net ' + signed(r.net));
  if (r.prev && !f) {
    const prevLabel = monthLabel_(r.month === 0 ? r.year - 1 : r.year, (r.month + 11) % 12, false);
    L.push('<i>vs ' + prevLabel + ': income ' + (changePct_(r.income, r.prev.income) || '—') + ', expense ' +
      (changePct_(r.expense, r.prev.expense) || '—') + '</i>');
  }
  if (r.adjustmentCount) L.push('⚖️ Adjustments: ' + signed(r.adjustments) + ' (' + r.adjustmentCount + ', not in income/expense)');

  if (r.categories.length) {
    L.push('', '📂 <b>Expense by category</b>');
    r.categories.slice(0, REPORT_LIST_MAX).forEach(function (c) {
      L.push('• ' + escapeHtml_(c.name) + ' ' + m(c.amount) + ' (' + Math.round(c.pct * 100) + '%)');
    });
    if (r.categories.length > REPORT_LIST_MAX) L.push('• … ' + (r.categories.length - REPORT_LIST_MAX) + ' more');
  }
  if (r.top.length) {
    L.push('', '🔝 <b>Biggest expenses</b>');
    r.top.forEach(function (t) {
      L.push('• ' + (t.date ? formatDayMonth_(t.date) + ' · ' : '') + escapeHtml_((t.note || t.category).slice(0, 40)) + ' ' + m(t.amount));
    });
  }
  if (r.budgets.length && !f) {
    L.push('', '🎯 <b>Budgets</b>');
    r.budgets.forEach(function (b) {
      L.push('• ' + escapeHtml_(b.name) + ' ' + m(b.spent) + ' of ' + m(b.budget) + ' (' + Math.round(b.spent / b.budget * 100) + '%)' +
        ' · remaining ' + budgetRemainingText_(b, hide) + ' · ' + b.status + (b.spent > b.budget ? ' ⚠️' : ''));
    });
  }
  if (r.wallets.length) {
    L.push('', '👛 <b>Wallets</b> (start → end)');
    r.groups.forEach(function (g) { L.push('• <b>' + escapeHtml_(g.name) + '</b> ' + m(g.start) + ' → ' + m(g.end) + ' (' + signed(g.change) + ')'); });
    r.wallets.slice(0, REPORT_LIST_MAX * 2).forEach(function (w) {
      L.push('   ' + escapeHtml_(w.name) + ' ' + m(w.end) + (w.change ? ' (' + signed(w.change) + ')' : ''));
    });
  }
  if (f && r.transfers.length) L.push('', '🔁 <b>Transfers in / out</b> (not income or expense)');
  r.transfers.forEach(function (t) { L.push('🔁 ' + escapeHtml_(t.name) + ' ' + m(t.amount)); });
  if (!f) formatReportFullOnly_(r, hide, L, asOf, m, signed, orDash);
  if (r.users.length > 1 || (r.users.length === 1 && r.users[0].name !== '(unknown)')) {
    L.push('', '👥 <b>By person</b>');
    r.users.forEach(function (u) { L.push('• ' + escapeHtml_(u.name) + ': income ' + m(u.income) + ' · expense ' + m(u.expense) + ' (' + u.count + ' entries)'); });
  }
  if (r.closedItems.length && !f) {
    L.push('', '📦 <b>Moved to Closed_History</b>');
    r.closedItems.slice(0, REPORT_LIST_MAX).forEach(function (c) {
      L.push('• ' + escapeHtml_(c.id) + ' ' + escapeHtml_(c.name) + ' · ' + escapeHtml_(c.result) + ' ' + m(c.amount));
    });
    if (r.closedItems.length > REPORT_LIST_MAX) L.push('• … ' + (r.closedItems.length - REPORT_LIST_MAX) + ' more');
  }
  if (link) L.push('', '📄 <a href="' + escapeHtml_(link) + '">Full report (archive sheet)</a>');
  let text = L.join('\n');
  if (text.length > 4000) text = text.slice(0, 3900).replace(/<[^>]*$/, '') + '\n…(shortened — see the full report)';
  return text;
}

/** The parts of the chat text a filtered report leaves out: debts, investments, net worth, favorites. */
function formatReportFullOnly_(r, hide, L, asOf, m, signed, orDash) {
  const debtLine = function (icon, name, d) {
    return icon + ' <b>' + name + '</b>: remaining ' + m(d.remaining) + ' (' + d.open + ' open' +
      (d.overdue ? ', ' + d.overdue + ' overdue ' + m(d.overdueAmount) : '') + ')' +
      (d.created ? ' · new ' + m(d.created) : '') + (d.paid ? ' · paid ' + m(d.paid) : '') +
      (d.converted ? ' · converted ' + m(d.converted) : '');
  };
  L.push('', debtLine('🤝', 'Piutang', r.piutang) + asOf, debtLine('💳', 'Hutang', r.hutang) + asOf);

  const inv = r.investments;
  if (inv.value || inv.invested || inv.sold || inv.opening) {
    L.push('', '📈 <b>Investments</b> ' + m(inv.value) + (inv.change !== null ? ' (' + signed(inv.change) + ' vs last month)' : '') + asOf);
    L.push('   opening ' + orDash(inv.opening, m) + ' → ending ' + m(inv.value) + ' · unrealized ' + signed(inv.unrealized) +
      reportPct_(inv.unrealizedPct));
    L.push('   bought ' + m(inv.invested) + ' · sold ' + m(inv.sold) + ' · realized this month ' + signed(inv.realized));
    inv.categories.forEach(function (c) {
      L.push('   ' + escapeHtml_(c.name) + ' ' + orDash(c.opening, m) + ' → ' + m(c.value) + ' (' + orDash(c.change, signed) + ')' +
        ' · unrealized ' + signed(c.unrealized) + reportPct_(c.unrealizedPct));
    });
  }
  L.push('', '🏦 <b>Net worth</b> ' + m(r.netWorth) + ' <i>(cash + investments + piutang − hutang)</i>' + asOf);

  if (r.favorites.length) {
    const by = function (s) { return r.favorites.filter(function (f) { return f.status === s; }); };
    const names = function (list) { return list.map(function (f) { return escapeHtml_(f.name); }).join(', '); };
    L.push('', '⭐ <b>Favorites</b>: ' + by('paid').length + ' paid · ' + by('skipped').length + ' skipped' +
      (by('not logged').length ? ' · not logged: ' + names(by('not logged')) : ''));
  }
}

/** "12 Oct". */
function formatDayMonth_(date) {
  return Utilities.formatDate(new Date(date), Session.getScriptTimeZone(), 'd MMM');
}

/** Rows for the archive's Report tab: [Section, Item, Amount, Note]. */
function reportSheetRows_(r) {
  const rows = [['Section', 'Item', 'Amount', 'Note']];
  const add = function (s, i, a, n) { rows.push([s, i, a === null || a === undefined ? '' : a, n || '']); };
  const rpOrDash = function (n) { return n === null || n === undefined ? '—' : formatRp_(n); };
  const f = r.filter;
  if (f) add('Summary', 'Filtered: ' + f.label, null, f.wallets.join(', ') + ' only (debts, investments, net worth, budgets: full report)');
  add('Summary', 'Income', r.income);
  add('Summary', 'Expense', r.expense);
  add('Summary', 'Net cash flow', r.net);
  if (r.prev && !f) {
    add('Summary', 'Income vs previous month', r.income - r.prev.income, changePct_(r.income, r.prev.income));
    add('Summary', 'Expense vs previous month', r.expense - r.prev.expense, changePct_(r.expense, r.prev.expense));
  }
  add('Summary', 'Adjustments', r.adjustments, r.adjustmentCount + ' entries (not in income/expense)');
  r.categories.forEach(function (c) { add('Expense by category', c.name, c.amount, Math.round(c.pct * 1000) / 10 + '%'); });
  r.top.forEach(function (t, i) {
    add('Top 5 expenses', (i + 1) + '. ' + (t.note || t.category), t.amount, (t.date ? formatDate_(t.date) : '') + ' · ' + t.category + ' · ' + t.wallet);
  });
  if (!f) r.budgets.forEach(function (b) {
    add('Budget', b.name, b.spent, 'of ' + formatRp_(b.budget) + ' (' + Math.round(b.spent / b.budget * 100) + '%) · remaining ' +
      formatRp_(b.remaining) + ' · ' + b.status + (b.spent > b.budget ? ' ⚠️' : ''));
  });
  r.groups.forEach(function (g) { add('Wallet group', g.name, g.end, 'start ' + formatRp_(g.start) + ', change ' + formatRp_(g.change)); });
  r.wallets.forEach(function (w) { add('Wallet', w.name + ' (' + w.group + ')', w.end, 'start ' + formatRp_(w.start) + ', change ' + formatRp_(w.change)); });
  r.transfers.forEach(function (t) { add(f ? 'Transfers in / out' : 'Transfers between groups', t.name, t.amount); });
  if (f) {
    r.users.forEach(function (u) { add('By person', u.name, u.expense, 'income ' + formatRp_(u.income) + ', ' + u.count + ' entries'); });
    return rows;
  }
  [['Hutang', r.hutang], ['Piutang', r.piutang]].forEach(function (x) {
    const d = x[1];
    add(x[0], 'New this month', d.created);
    add(x[0], 'Paid this month', d.paid);
    add(x[0], 'Converted this month', d.converted);
    add(x[0], 'Remaining (open)', d.remaining, d.open + ' open');
    add(x[0], 'Overdue', d.overdueAmount, d.overdue + ' records');
  });
  const inv = r.investments;
  add('Investments', 'Bought this month', inv.invested);
  add('Investments', 'Sold this month', inv.sold);
  add('Investments', 'Opening value', inv.opening === null ? '—' : inv.opening, 'portfolio value at the start of the month');
  add('Investments', 'Portfolio value', inv.value, inv.change !== null ? 'change vs previous month ' + formatRp_(inv.change) : '');
  add('Investments', 'Unrealized gain/loss', inv.unrealized, reportPct_(inv.unrealizedPct).replace(/^ \(|\)$/g, ''));
  add('Investments', 'Realized gain/loss this month', inv.realized);
  inv.categories.forEach(function (c) {
    add('Investments by category', c.name, c.value, 'opening ' + rpOrDash(c.opening) + ', change ' + rpOrDash(c.change) +
      ', unrealized ' + formatRp_(c.unrealized) + reportPct_(c.unrealizedPct));
  });
  add('Net worth', 'Cash wallets', r.cash);
  add('Net worth', 'Investments', inv.value);
  add('Net worth', 'Piutang', r.piutang.remaining);
  add('Net worth', 'Hutang', -r.hutang.remaining);
  add('Net worth', 'Net worth', r.netWorth);
  r.favorites.forEach(function (f) { add('Favorites', f.name, null, f.status); });
  r.users.forEach(function (u) { add('By person', u.name, u.expense, 'income ' + formatRp_(u.income) + ', ' + u.count + ' entries'); });
  r.closedItems.forEach(function (c) { add('Moved to Closed_History', c.id + ' ' + c.name, c.amount, c.result); });
  return rows;
}

/** The Monthly Report tab row for this report. */
function reportRowValues_(r, status, closedAt, link, notes) {
  return {
    'Month Key': r.key, 'Month': monthLabel_(r.year, r.month, false), 'Income': r.income, 'Expense': r.expense,
    'Net Cash Flow': r.net, 'Adjustments': r.adjustments, 'Invested': r.investments.invested, 'Sold': r.investments.sold,
    'Portfolio Value': r.investments.value, 'Unrealized Gain': r.investments.unrealized, 'Realized Gain': r.investments.realized,
    'Net Worth': r.netWorth, 'Status': status, 'Closed At': closedAt || '', 'Archive Link': link || '', 'Notes': notes || ''
  };
}

// ---------------------------------------------------------------------------
// Reading the sheets
// ---------------------------------------------------------------------------

/** Every list buildReportData_ needs, from one spreadsheet (the main sheet or an archive). */
function collectReportSource_(ss) {
  const walletRows = readTableByHeaders_(ss.getSheetByName(TAB.WALLETS), 'Wallet');
  const openings = {};
  walletRows.forEach(function (r) { openings[String(r['wallet']).trim()] = Number(r['opening balance']) || 0; });
  const prices = ss.getSheetByName(TAB.PRICES);
  return {
    prices: prices === null ? [] : readTableByHeaders_(prices, 'Inv ID'), // Month-End rows → opening value per category
    trx: loadTransactions_(ss), wallets: loadWallets_(ss), openings: openings, debts: loadDebts_(ss),
    investments: loadInvestments_(ss), sales: loadSales_(ss), favorites: loadFavorites_(ss), categories: loadCategories_(ss),
    investmentGroups: getSettingList_(SETTING.INVESTMENT_GROUPS)
  };
}

/** Monthly Report rows by Month Key. */
function loadReportRows_(ss) {
  const out = {};
  const sheet = ss.getSheetByName(TAB.REPORT);
  if (sheet === null) return out;
  readTableByHeaders_(sheet, 'Month Key').forEach(function (r) { out[Number(r['month key'])] = r; });
  return out;
}

/** Rows of a history tab (Budget_History / Closed_History) for one month. */
function historyRowsOf_(ss, tab, key) {
  const sheet = ss.getSheetByName(tab);
  if (sheet === null) return [];
  return readTableByHeaders_(sheet, 'Month Key').filter(function (r) { return Number(r['month key']) === key; });
}

/** { income, expense, portfolio, netWorth } of the month before `key`, from Monthly Report or the rows. */
function previousTotals_(reportRows, trx, key) {
  const p = monthOfKey_(key);
  const prevKey = p.month === 0 ? (p.year - 1) * 100 + 12 : key - 1;
  const row = reportRows[prevKey];
  if (row) {
    return { income: Number(row['income']) || 0, expense: Number(row['expense']) || 0,
      portfolio: row['portfolio value'] === '' ? null : Number(row['portfolio value']) || 0, netWorth: Number(row['net worth']) || 0 };
  }
  const pm = monthOfKey_(prevKey);
  const start = new Date(pm.year, pm.month, 1), end = new Date(pm.year, pm.month + 1, 1);
  const rows = trx.filter(function (r) { return r['date'] instanceof Date && r['date'] >= start && r['date'] < end; });
  if (rows.length === 0) return null;
  const s = function (f) { return rows.filter(f).reduce(function (t, r) { return t + (Number(r['amount']) || 0); }, 0); };
  return { income: s(countsAsIncome_), expense: s(countsAsExpense_), portfolio: null, netWorth: null };
}

/** closedItems in the shape the report uses, from Closed_History rows. */
function closedItemsOf_(rows) {
  return rows.map(function (r) {
    return { kind: String(r['kind']), id: String(r['id']), name: String(r['name']), amount: Number(r['amount']) || 0,
      result: String(r['result']), gain: r['gain/loss'] === '' ? null : Number(r['gain/loss']) };
  });
}

/** Archive spreadsheet ID from a Monthly Report row's Archive Link. */
function archiveIdOf_(row) {
  const link = String(row && row['archive link'] || '');
  return (link.match(/\/d\/([\w-]{20,})/) || [])[1] || '';
}

// ---------------------------------------------------------------------------
// Wallet / wallet-group filter (pure)
// ---------------------------------------------------------------------------

/**
 * A wallet name or a wallet group (case-insensitive) → { label, kind, wallets:
 * [wallet names] }, or null. A wallet is in a group when any of its
 * comma-separated groups matches. A wallet name wins over a group name.
 */
function resolveReportFilter_(word, wallets) {
  const w = String(word || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!w) return null;
  const wallet = findWallet_(wallets, w);
  if (wallet) return { label: wallet.name, kind: 'wallet', wallets: [wallet.name] };
  let label = '';
  const names = wallets.filter(function (x) {
    const g = walletGroups_(x).filter(function (name) { return name.toLowerCase() === w; })[0];
    if (g && !label) label = g;
    return !!g;
  }).map(function (x) { return x.name; });
  return names.length ? { label: label, kind: 'group', wallets: names } : null;
}

/**
 * /report arguments → { ym, filter } (filter null when none), or
 * { error: 'month' } / { error: 'filter', word }. The filter is the words
 * before or after the month: "bca", "bca oktober 2026", "oktober 2026 spending".
 */
function parseReportArgs_(text, wallets, now) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const whole = parseMonthArg_(t, now);
  if (whole) return { ym: whole, filter: null };
  const words = t.split(' ');
  const n = words.length;
  const splits = []; // [filter words, month words], longest filter first, words before the month first
  for (let k = n; k >= 1; k--) {
    splits.push([words.slice(0, k).join(' '), words.slice(k).join(' ')]);
    if (k < n) splits.push([words.slice(n - k).join(' '), words.slice(0, n - k).join(' ')]);
  }
  let unknown = '';
  for (let i = 0; i < splits.length; i++) {
    const ym = parseMonthArg_(splits[i][1], now);
    if (!ym) continue;
    const filter = resolveReportFilter_(splits[i][0], wallets);
    if (filter) return { ym: ym, filter: filter };
    unknown = splits[i][0]; // the last one tried = the shortest filter words
  }
  // Only digits ("13 2026") → a month typed wrong, not a wallet
  return unknown && /[^\d\s\/-]/.test(unknown) ? { error: 'filter', word: unknown } : { error: 'month' };
}

/** Wallet names and wallet groups, for the "unknown filter" message. */
function reportFilterChoices_(wallets) {
  const groups = [];
  const names = wallets.filter(function (w) { return w.active; }).map(function (w) {
    walletGroups_(w).forEach(function (g) { if (groups.indexOf(g) === -1) groups.push(g); });
    return w.name;
  });
  return { wallets: names, groups: groups };
}

// ---------------------------------------------------------------------------
// /report
// ---------------------------------------------------------------------------

function startReport_(chatId, args) {
  const now = new Date();
  const examples = 'Examples: <code>/report</code> (this month), <code>/report oktober 2026</code>, <code>/report 10 2026</code>, ' +
    '<code>/report bca</code>, <code>/report spending oktober 2026</code>.';
  const ss = openMainSheet_();
  const wallets = loadWallets_(ss);
  const parsed = parseReportArgs_(args, wallets, now);
  if (parsed.error === 'filter') {
    const choices = reportFilterChoices_(wallets);
    return sendMessage(chatId, "I don't know a wallet or wallet group called “" + escapeHtml_(parsed.word) + '”.\n' +
      'Wallets: ' + escapeHtml_(choices.wallets.join(', ') || '—') + '\nGroups: ' + escapeHtml_(choices.groups.join(', ') || '—') + '\n' + examples);
  }
  if (parsed.error) return sendMessage(chatId, "I couldn't read the month. " + examples);
  const ym = parsed.ym;
  const filter = parsed.filter;
  const key = monthKey_(ym.year, ym.month);
  if (key > monthKey_(now.getFullYear(), now.getMonth())) return sendMessage(chatId, "That month hasn't started yet.");
  sendTyping_(chatId);
  const reportRows = loadReportRows_(ss);
  const row = reportRows[key];
  const closed = row && String(row['status']).trim().toLowerCase() === 'closed';
  const hide = getSettingYes_(SETTING.HIDE_AMOUNTS);
  if (!closed) {
    const src = collectReportSource_(ss);
    src.prev = previousTotals_(reportRows, src.trx, key);
    const data = buildReportData_(src, ym.year, ym.month, now, filter);
    if (data.count === 0 && key < monthKey_(now.getFullYear(), now.getMonth())) {
      return sendMessage(chatId, 'Nothing was logged in ' + escapeHtml_(data.label) + (filter ? ' for ' + escapeHtml_(filter.label) : '') + '.');
    }
    return sendTimed_(chatId, formatReportText_(data, hide, 'live', ''), REPORT_DELETE_SECONDS);
  }
  sendTimed_(chatId, buildClosedReportText_(ss, reportRows, key, hide, filter), REPORT_DELETE_SECONDS);
}

/** Sends a message that deletes itself after the given seconds (cleanup trigger), with a note saying so. */
function sendTimed_(chatId, text, seconds) {
  const timed = cleanupTriggerInstalled_();
  const sent = sendMessage(chatId, text + (timed ? '\n\n🕒 This message will be deleted in ' + formatDelay_(seconds) + '.' : ''));
  if (timed) scheduleDelete_(chatId, sent.message_id, seconds);
  return sent;
}

/**
 * The report of a closed month, from its archive sheet (complete data of
 * that month). If the archive can't be opened, the saved Monthly Report row.
 */
function buildClosedReportText_(ss, reportRows, key, hide, filter) {
  const row = reportRows[key];
  const ym = monthOfKey_(key);
  const link = String(row['archive link'] || '');
  const closedItems = closedItemsOf_(historyRowsOf_(ss, TAB.CLOSED_HISTORY, key));
  try {
    const archive = SpreadsheetApp.openById(archiveIdOf_(row));
    const src = collectReportSource_(archive);
    src.prev = previousTotals_(reportRows, [], key);
    src.budgetRows = historyRowsOf_(ss, TAB.BUDGET_HISTORY, key);
    src.closedItems = closedItems;
    // The filter again against the archive's wallets (what the groups were that month); the main sheet's otherwise
    const f = filter ? resolveReportFilter_(filter.label, src.wallets) || filter : null;
    const data = buildReportData_(src, ym.year, ym.month, new Date(ym.year, ym.month + 1, 1), f);
    const tab = archive.getSheetByName(ARCHIVE_REPORT_TAB);
    return formatReportText_(data, hide, 'closed', tab ? archive.getUrl() + '#gid=' + tab.getSheetId() : link);
  } catch (err) {
    logError_('buildClosedReportText_', err, link);
    const n = function (h) { return money_(Number(row[h]) || 0, hide); };
    return '📊 <b>Report · ' + escapeHtml_(monthLabel_(ym.year, ym.month, true)) + '</b> 🔒 closed\n' +
      '💵 Income ' + n('income') + ' · 🧾 Expense ' + n('expense') + ' · Net ' + n('net cash flow') + '\n' +
      '📈 Investments ' + n('portfolio value') + ' · 🏦 Net worth ' + n('net worth') + '\n' +
      "<i>(The archive sheet couldn't be opened, so this is the saved summary" + (filter ? ', without the filter' : '') + '.)</i>' +
      (link ? '\n📄 <a href="' + escapeHtml_(link) + '">Archive sheet</a>' : '');
  }
}
