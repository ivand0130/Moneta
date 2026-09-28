/**
 * Debts.gs — hutang/piutang, group piutang, split bill, pelunasan, add to
 * existing, convert/close, /open (SPEC Section 7).
 *
 * Records live in the Hutang_Piutang tab (Original is written by the bot;
 * Added, Paid, Converted, Remaining and Status are sheet formulas summed from
 * Transactions by Debt ID). Every money event is a Transactions row with the
 * Debt ID, so the history is complete and /undo keeps everything correct:
 *   lend (Piutang, Out) · borrow (Hutang, In) · they pay back (Settlement, In)
 *   · I pay back (Settlement, Out) · add (Addition, Out/In)
 *   · convert = an Expense (piutang) / Income (hutang) row with Direction
 *     None: it counts as expense/income but moves no money.
 */

const DEBT_PREFIX = { Piutang: 'PTG', Hutang: 'HTG' };

function loadDebts_(ss) {
  return readTableByHeaders_(ss.getSheetByName(TAB.DEBTS), 'Debt ID').map(function (r) {
    const n = function (k) { return Number(r[k]) || 0; };
    return {
      id: String(r['debt id']).trim(), parent: String(r['parent id'] || '').trim(),
      link: String(r['link id'] || '').trim(), type: String(r['type']).trim(), term: String(r['term'] || '').trim(),
      name: String(r['name'] || '').trim(), start: r['start date'] instanceof Date ? r['start date'] : null,
      due: r['due date'] instanceof Date ? r['due date'] : null, wallet: String(r['wallet'] || '').trim(),
      category: String(r['category'] || '').trim(), original: n('original'), added: n('added'), paid: n('paid'),
      converted: n('converted'), remaining: n('remaining'), status: String(r['status'] || '').trim(),
      convertedTrx: String(r['converted trx'] || '').trim(), row: r._row
    };
  });
}

function isOpenDebt_(d) {
  return d.status === 'Open' || d.status === 'Partial';
}

/** Sub-records of a group parent (PTG-010 → PTG-010-A, -B…). */
function childrenOf_(debts, parentId) {
  return debts.filter(function (d) { return d.parent === parentId; });
}

/** "PTG-001 Budi · Rp300.000 · due 30 Oct" (plain amounts, for buttons and previews). */
function debtLabel_(d) {
  return d.id + ' ' + d.name + ' · ' + formatRp_(d.remaining) + (d.due ? ' · due ' + formatDate_(d.due) : '');
}

// ---------------------------------------------------------------------------
// Start: a parsed debt message (parseDebt_) becomes a pending item
// ---------------------------------------------------------------------------

function startDebt_(chatId, parsed, ctx) {
  if (!parsed.ok) {
    sendMessage(chatId, debtErrorText_(parsed));
    return;
  }
  const p = newPending_(chatId, 'debt', Object.assign({}, parsed, {
    date: parsed.date.getTime(), due: parsed.due ? parsed.due.getTime() : null
  }));
  stepDebt_(p, ctx);
}

/** Loads what debt steps need (sheet data + contacts + debt records). */
function loadDebtCtx_() {
  const ctx = loadCtx_();
  ctx.debts = loadDebts_(ctx.ss);
  return ctx;
}

/** Asks for whatever is missing, in order, then shows the preview. */
function stepDebt_(p, ctx) {
  ctx = ctx || loadDebtCtx_();
  if (!ctx.debts) ctx.debts = loadDebts_(ctx.ss);
  const d = p.d;
  p.awaitText = null;

  if (d.amountOptions) {
    const rows = chunk_(d.amountOptions.map(function (v, i) { return btn_(p, formatRp_(v), 'dam', i); }), 2);
    rows.push([btn_(p, '✏️ Type it', 'ef', 'amount'), btn_(p, '❌ Cancel', 'n')]);
    return showStep_(p, '🤔 The amount "' + escapeHtml_(d.amountText) + '" is unclear. Which did you mean?', rows);
  }
  if (d.dateNeedsConfirm) {
    const label = formatDate_(d.date);
    return showStep_(p, '📅 I read "' + escapeHtml_(d.dateText) + '" as <b>' + label + '</b>. Is that right?',
      [[btn_(p, '✅ ' + label, 'dok'), btn_(p, '✏️ Other date', 'ef', 'date')], cancelRow_(p)]);
  }
  if (isMonthClosed_(ctx.ss, d.date)) {
    const month = Utilities.formatDate(new Date(d.date), Session.getScriptTimeZone(), 'MMMM yyyy');
    return showStep_(p, '⛔ ' + month + " is closed, so entries can't be dated in it. Use today's date?",
      [[btn_(p, '📅 Use today', 'today'), btn_(p, '❌ Cancel', 'n')]]);
  }

  if (d.kind === 'pay' || d.kind === 'add' || d.kind === 'convert') {
    const target = resolveDebtTarget_(p, ctx);
    if (target !== true) return target; // a question was shown
  }
  if (d.kind === 'new' && !d.group && !d.name) {
    p.awaitText = 'name';
    return showStep_(p, '🤝 ' + (d.debtType === 'Piutang' ? 'Who are you lending to?' : 'Who are you borrowing from?') +
      '\nSend the name.', [cancelRow_(p)]);
  }
  if (d.kind === 'split' && !d.category) return askDebtCategory_(p, ctx, 'Expense', 'Which category is your share?');
  if (d.kind === 'convert' && !d.category) {
    // Suggest the record's own category (e.g. Food from a split bill) when it fits; the preview confirms it.
    const own = findDebtById_(ctx.debts, d.recordId);
    const wantType = d.recordType === 'Piutang' ? 'Expense' : 'Income';
    if (own && own.category && ctx.categories.some(function (c) { return c.name === own.category && c.type === wantType; })) {
      d.category = own.category;
      d.categoryHow = 'keyword';
    }
  }
  if (d.kind === 'convert' && !d.category) {
    const t = d.recordType === 'Piutang' ? 'Expense' : 'Income';
    return askDebtCategory_(p, ctx, t, 'The remaining amount becomes ' + (t === 'Expense' ? 'an Expense' : 'Income') +
      '. Which category?');
  }
  if (d.kind === 'pay') {
    const rec = findDebtById_(ctx.debts, d.recordId);
    if (d.full) { d.amount = rec.remaining; d.full = false; }
    if (d.amount > rec.remaining && !d.overpay) return askOverpay_(p, rec);
    if ((d.overpay === 'income' || d.overpay === 'expense') && !d.extraCategory) {
      return askDebtCategory_(p, ctx, d.overpay === 'income' ? 'Income' : 'Expense',
        'Which category is the extra ' + formatRp_(d.amount - rec.remaining) + '?', 'xc');
    }
  }
  if (d.kind !== 'convert' && !findWallet_(everydayWallets_(ctx.wallets, ctx.investmentGroups), d.wallet)) {
    return askDebtWallet_(p, ctx);
  }
  showStep_(p, buildDebtPreview_(p, ctx), debtPreviewButtons_(p));
}

function findDebtById_(debts, id) {
  return debts.filter(function (x) { return x.id.toUpperCase() === String(id || '').toUpperCase(); })[0] || null;
}

/**
 * pay / add / convert: find the record. Returns true when d.recordId is set,
 * otherwise shows a question (pick one, which person of a group, or "no open
 * record") and returns that.
 */
function resolveDebtTarget_(p, ctx) {
  const d = p.d;
  const debts = ctx.debts;
  if (d.recordId) {
    const rec = findDebtById_(debts, d.recordId);
    if (rec && isOpenDebt_(rec)) {
      d.recordType = rec.type;
      const kids = childrenOf_(debts, rec.id).filter(isOpenDebt_);
      if (kids.length && d.kind !== 'convert') return pickDebt_(p, kids, 'Which person of ' + rec.id + '?');
      return true;
    }
    d.recordId = null;
  }
  let pool = debts.filter(function (x) { return isOpenDebt_(x) && (!d.debtType || x.type === d.debtType); });
  if (d.id) {
    const exact = findDebtById_(debts, d.id);
    if (!exact) return finishStep_(p, 'I can\'t find ' + escapeHtml_(d.id) + '. Use /open to see the open records.');
    if (!isOpenDebt_(exact)) {
      return finishStep_(p, escapeHtml_(exact.id) + ' is already ' + escapeHtml_(exact.status) +
        ' and can\'t be changed.' + (d.kind === 'add' ? ' To lend/borrow again, create a new one, e.g. <code>piutang 100rb ' +
        escapeHtml_(exact.name) + '</code>.' : ''));
    }
    pool = [exact];
  } else {
    const name = String(d.name || '').toLowerCase();
    const contact = findContact_(ctx.contacts || [], d.name);
    const names = [name].concat(contact ? [contact.name.toLowerCase()].concat(contact.aliases.map(function (a) {
      return a.toLowerCase();
    })) : []);
    // A person's own records, plus group sub-records with their name; group parents are skipped.
    pool = pool.filter(function (x) {
      return names.indexOf(x.name.toLowerCase()) !== -1 && childrenOf_(debts, x.id).length === 0;
    });
  }
  if (pool.length === 1) {
    d.recordId = pool[0].id;
    return resolveDebtTarget_(p, ctx);
  }
  if (pool.length > 1) {
    const typeWord = d.debtType ? d.debtType.toLowerCase() : 'records';
    return pickDebt_(p, pool, escapeHtml_(d.name || '') + ' has ' + pool.length + ' open ' + typeWord + ':');
  }
  // Nothing open for that name (SPEC Section 14).
  const typeLabel = d.debtType ? d.debtType.toLowerCase() : 'hutang/piutang';
  const rows = [];
  if (d.kind !== 'convert' && d.debtType && d.amount) {
    rows.push([btn_(p, '➕ New ' + typeLabel + ' for ' + d.name, 'newrec')]);
  }
  rows.push(cancelRow_(p));
  return showStep_(p, 'No open ' + typeLabel + ' for <b>' + escapeHtml_(d.name || '') + '</b>. ' +
    (rows.length > 1 ? 'Create a new one, or check the spelling?' : 'Check the spelling, or see /open.'), rows);
}

function pickDebt_(p, list, question) {
  p.opts = list.map(function (x) { return x.id; });
  const rows = list.map(function (x, i) { return [btn_(p, debtLabel_(x), 'dr', i)]; });
  rows.push(cancelRow_(p));
  showStep_(p, question, rows);
}

function askOverpay_(p, rec) {
  const d = p.d;
  const extra = d.amount - rec.remaining;
  const piutang = rec.type === 'Piutang';
  showStep_(p, '💸 ' + escapeHtml_(rec.id) + ' (' + escapeHtml_(rec.name) + ') has only ' + formatRp_(rec.remaining) +
    ' remaining, but the payment is ' + formatRp_(d.amount) + ' (' + formatRp_(extra) + ' more). What is the extra?',
    [[btn_(p, '✏️ Correct the amount', 'ef', 'amount')],
     [btn_(p, piutang ? '💵 Extra is income' : '🧾 Extra is an expense', 'op', piutang ? 'income' : 'expense')],
     [btn_(p, piutang ? '🔁 Extra: I now owe ' + rec.name : '🔁 Extra: ' + rec.name + ' now owes me', 'op', 'flip')],
     cancelRow_(p)]);
}

function askDebtWallet_(p, ctx) {
  const d = p.d;
  const list = d.walletChoices || everydayWallets_(ctx.wallets, ctx.investmentGroups).map(function (w) { return w.name; });
  p.opts = list;
  const t = debtTypeOf_(p);
  const moneyIn = ((d.kind === 'new' || d.kind === 'add') && t === 'Hutang') || (d.kind === 'pay' && t === 'Piutang');
  const q = d.kind === 'split' ? 'Paid from which wallet?' : (moneyIn ? 'Into which wallet?' : 'From which wallet?');
  const rows = chunk_(list.map(function (n, i) { return btn_(p, n, 'dw', i); }), 3);
  rows.push(cancelRow_(p));
  showStep_(p, debtSummary_(p) + '\n' + q, rows);
}

function askDebtCategory_(p, ctx, type, question, action) {
  p.opts = ctx.categories.filter(function (c) { return c.type === type; }).map(function (c) { return c.name; });
  const rows = chunk_(p.opts.map(function (n, i) { return btn_(p, n, action || 'dc', i); }), 2);
  rows.push(cancelRow_(p));
  showStep_(p, debtSummary_(p) + '\n' + question, rows);
}

/** The debt type of the flow (for pay/add/convert, from the chosen record). */
function debtTypeOf_(p) {
  if (p.d.recordType) return p.d.recordType;
  return p.d.debtType;
}

/** One line of context above a question. */
function debtSummary_(p) {
  const d = p.d;
  if (d.kind === 'split') return '🧾 Split bill <b>' + formatRp_(d.total) + '</b>' + (d.note ? ' · ' + escapeHtml_(d.note) : '');
  if (d.kind === 'new' && d.group) return '🤝 Group ' + d.debtType.toLowerCase() + ' <b>' + formatRp_(d.total) + '</b>';
  if (d.kind === 'new') return '🤝 ' + d.debtType + ' <b>' + formatRp_(d.amount) + '</b> · ' + escapeHtml_(d.name || '?');
  const verb = { pay: '💸 Payment', add: '➕ Add', convert: '🔚 Convert' }[d.kind];
  return verb + (d.amount ? ' <b>' + formatRp_(d.amount) + '</b>' : '') + ' · ' + escapeHtml_(d.recordId || d.name || '');
}

function debtPreviewButtons_(p) {
  const d = p.d;
  const rows = [[btn_(p, '✅ Yes', 'y'), btn_(p, '❌ No', 'n')]];
  if (d.kind === 'split' || d.kind === 'convert') rows[0].push(btn_(p, '📂 Category', 'ef', 'category'));
  else rows[0].push(btn_(p, '✏️ Edit', 'e'));
  return rows;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

function buildDebtPreview_(p, ctx, footer) {
  const d = p.d;
  const lines = [];
  const dateLine = '📅 ' + formatDate_(d.date) + (d.note ? '\n📝 ' + escapeHtml_(d.note) : '');
  const newContacts = [];
  if (d.kind === 'new' && !d.group) {
    const piutang = d.debtType === 'Piutang';
    lines.push('🤝 <b>Preview · ' + d.debtType + '</b> (' + (piutang ? 'you lend' : 'you borrow') + ')',
      escapeHtml_(d.name) + ' · <b>' + formatRp_(d.amount) + '</b> · ' + (piutang ? 'from ' : 'into ') + escapeHtml_(d.wallet),
      'Term: ' + d.term + (d.due ? ' · Due: ' + formatDate_(d.due) : (d.term === 'Long' ? '' : ' · No due date')),
      dateLine);
    if (!d.known) newContacts.push(d.name);
  } else if (d.kind === 'new') {
    lines.push('🤝 <b>Preview · Group ' + d.debtType.toLowerCase() + '</b> · <b>' + formatRp_(d.total) + '</b> from ' +
      escapeHtml_(d.wallet));
    d.people.forEach(function (x) { lines.push('• ' + escapeHtml_(x.name) + ': ' + formatRp_(x.amount)); if (!x.known) newContacts.push(x.name); });
    lines.push('Term: ' + d.term + (d.due ? ' · Due: ' + formatDate_(d.due) : ''), dateLine);
  } else if (d.kind === 'split') {
    lines.push('🧾 <b>Preview · Split bill</b> · <b>' + formatRp_(d.total) + '</b> paid from ' + escapeHtml_(d.wallet));
    if (d.me > 0) lines.push('• You: ' + formatRp_(d.me) + ' → Expense · ' + escapeHtml_(d.category) +
      ' <i>(' + (CATEGORY_HOW_LABEL[d.categoryHow] || 'you picked') + ')</i>');
    d.people.forEach(function (x) {
      lines.push('• ' + escapeHtml_(x.name) + ': ' + formatRp_(x.amount) + ' → Piutang');
      if (!x.known) newContacts.push(x.name);
    });
    lines.push(dateLine);
  } else {
    const rec = findDebtById_(ctx.debts, d.recordId);
    const piutang = rec.type === 'Piutang';
    if (d.kind === 'pay') {
      const paid = Math.min(d.amount, rec.remaining);
      const after = rec.remaining - paid;
      lines.push('💸 <b>Preview · Payment</b> · ' + escapeHtml_(rec.id) + ' (' + escapeHtml_(rec.name) + ')',
        (piutang ? escapeHtml_(rec.name) + ' pays you ' : 'You pay ' + escapeHtml_(rec.name) + ' ') + '<b>' + formatRp_(d.amount) +
          '</b> · ' + (piutang ? 'into ' : 'from ') + escapeHtml_(d.wallet),
        'Remaining after: ' + formatRp_(after) + ' (' + (after <= 0 ? 'Paid' : 'Partial') + ')');
      const extra = d.amount - paid;
      if (extra > 0) {
        lines.push('Extra ' + formatRp_(extra) + ' → ' + (d.overpay === 'flip'
          ? 'new ' + (piutang ? 'hutang: you owe ' : 'piutang: owes you ') + escapeHtml_(rec.name)
          : (d.overpay === 'income' ? 'Income' : 'Expense') + ' · ' + escapeHtml_(d.extraCategory)));
      }
    } else if (d.kind === 'add') {
      lines.push('➕ <b>Preview · Add to ' + escapeHtml_(rec.id) + '</b> (' + escapeHtml_(rec.name) + ')',
        '+' + formatRp_(d.amount) + ' · ' + (piutang ? 'from ' : 'into ') + escapeHtml_(d.wallet),
        'Remaining after: ' + formatRp_(rec.remaining + d.amount));
    } else {
      const recs = convertTargets_(ctx.debts, rec);
      const total = recs.reduce(function (s, x) { return s + x.remaining; }, 0);
      lines.push('🔚 <b>Preview · Convert ' + escapeHtml_(rec.id) + '</b> (' + escapeHtml_(rec.name) + ')',
        'Remaining ' + formatRp_(total) + ' → ' + (piutang ? 'Expense' : 'Income') + ' · ' + escapeHtml_(d.category),
        '<i>No money moves; it counts as ' + (piutang ? 'an expense' : 'income') + ' from now on.</i>');
      if (recs.length > 1) recs.forEach(function (x) { lines.push('• ' + escapeHtml_(x.id) + ' ' + escapeHtml_(x.name) + ': ' + formatRp_(x.remaining)); });
    }
    lines.push('📅 ' + formatDate_(d.date));
  }
  if (newContacts.length) lines.push('👤 New contact' + (newContacts.length > 1 ? 's' : '') + ': ' + escapeHtml_(newContacts.join(', ')));
  lines.push('', footer || 'Save?');
  return lines.join('\n');
}

/** A convert on a group parent converts every open sub-record. */
function convertTargets_(debts, rec) {
  const kids = childrenOf_(debts, rec.id).filter(isOpenDebt_);
  return kids.length ? kids : [rec];
}

// ---------------------------------------------------------------------------
// Buttons and typed answers
// ---------------------------------------------------------------------------

const DEBT_EDIT_PROMPTS = {
  amount: 'Send the amount, e.g. <code>500rb</code>.',
  name: 'Send the name.',
  note: 'Send the note.',
  date: 'Send the date, e.g. <code>kemarin</code> or <code>20/09</code>.',
  due: 'Send the due date, e.g. <code>30/10</code>, <code>5 hari</code> or <code>bulan depan</code>.'
};

function debtCallback_(p, action, arg, user) {
  const d = p.d;
  if (action === 'n') return finishStep_(p, '❌ Cancelled. Nothing was saved.');
  const ctx = loadDebtCtx_();
  switch (action) {
    case 'dam': d.amount = d.amountOptions[Number(arg)]; d.amountOptions = null; break;
    case 'dok': d.dateNeedsConfirm = false; break;
    case 'today': d.date = Date.now(); d.dateNeedsConfirm = false; break;
    case 'dw': d.wallet = p.opts[Number(arg)]; d.walletChoices = null; break;
    case 'dc': d.category = p.opts[Number(arg)]; d.categoryHow = 'chosen'; break;
    case 'xc': d.extraCategory = p.opts[Number(arg)]; break;
    case 'dr': {
      d.recordId = p.opts[Number(arg)];
      const rec = findDebtById_(ctx.debts, d.recordId);
      if (rec) d.recordType = rec.type;
      break;
    }
    case 'op': d.overpay = arg; break;
    case 'newrec': // "No open record — create a new one"
      Object.assign(d, { kind: 'new', group: false, recordId: null });
      break;
    case 'term': d.term = d.term === 'Long' ? 'Short' : 'Long'; if (d.term === 'Long') d.due = null; break;
    case 'nodue': d.due = null; break;
    case 'e':
      return showStep_(p, buildDebtPreview_(p, ctx, '✏️ What do you want to change?'), debtEditRows_(p));
    case 'ef':
      if (DEBT_EDIT_PROMPTS[arg]) {
        p.awaitText = arg;
        return showStep_(p, debtSummary_(p) + '\n' + DEBT_EDIT_PROMPTS[arg],
          [[btn_(p, '⬅️ Back', 'back'), btn_(p, '❌ Cancel entry', 'n')]]);
      }
      if (arg === 'wallet') { d.wallet = null; d.walletChoices = null; return askDebtWallet_(p, ctx); }
      if (arg === 'category') {
        if (d.kind === 'convert') return askDebtCategory_(p, ctx, debtTypeOf_(p) === 'Piutang' ? 'Expense' : 'Income', 'Which category?');
        return askDebtCategory_(p, ctx, 'Expense', 'Which category is your share?');
      }
      break;
    case 'y':
      return saveDebt_(p, ctx, user);
  }
  stepDebt_(p, ctx);
}

function debtEditRows_(p) {
  const d = p.d;
  const rows = [];
  if (d.kind === 'new' && !d.group) {
    rows.push([btn_(p, 'Amount', 'ef', 'amount'), btn_(p, 'Name', 'ef', 'name'), btn_(p, 'Wallet', 'ef', 'wallet')],
      [btn_(p, 'Date', 'ef', 'date'), btn_(p, 'Due date', 'ef', 'due'), btn_(p, d.term === 'Long' ? 'Make short-term' : 'Make long-term', 'term')],
      [btn_(p, 'Note', 'ef', 'note')].concat(d.due ? [btn_(p, 'No due date', 'nodue')] : []));
  } else if (d.kind === 'new') {
    rows.push([btn_(p, 'Wallet', 'ef', 'wallet'), btn_(p, 'Date', 'ef', 'date'), btn_(p, 'Due date', 'ef', 'due')],
      [btn_(p, d.term === 'Long' ? 'Make short-term' : 'Make long-term', 'term'), btn_(p, 'Note', 'ef', 'note')]);
  } else {
    rows.push([btn_(p, 'Amount', 'ef', 'amount'), btn_(p, 'Wallet', 'ef', 'wallet'), btn_(p, 'Date', 'ef', 'date')]);
  }
  rows.push([btn_(p, '⬅️ Back', 'back'), btn_(p, '❌ Cancel entry', 'n')]);
  return rows;
}

/** A typed answer while the bot waits for a debt amount / name / note / date / due date. */
function handleDebtText_(p, message) {
  const text = String(message.text).trim();
  const d = p.d;
  const now = new Date();
  if (p.awaitText === 'amount') {
    const a = parseAmountToken_(text);
    if (a === null || a.ambiguous) {
      sendMessage(p.chatId, "I couldn't read that amount. Send e.g. <code>500rb</code>, or tap Back.");
      return;
    }
    d.amount = a.value;
    d.full = false;
    d.overpay = null;
  } else if (p.awaitText === 'name') {
    const contact = findContact_(loadContacts_(openMainSheet_()), text);
    d.name = contact ? contact.name : text.slice(0, 40);
    d.known = !!contact;
  } else if (p.awaitText === 'note') {
    d.note = text.slice(0, 200);
  } else if (p.awaitText === 'date') {
    const date = parseDateOnly_(text, now);
    if (date === null) { sendMessage(p.chatId, "I couldn't read that date. Try <code>kemarin</code> or <code>20/09</code>."); return; }
    d.date = date.getTime();
    d.dateNeedsConfirm = false;
  } else if (p.awaitText === 'due') {
    const due = extractDueDate_(tokenize_('tempo ' + text), now);
    if (!due.date) { sendMessage(p.chatId, "I couldn't read that due date. Try <code>30/10</code> or <code>5 hari</code>."); return; }
    d.due = due.date.getTime();
    if (d.term === 'Long') d.term = 'Short';
  }
  dropButtons_(p.chatId, p.msgId);
  p.msgId = null;
  stepDebt_(p);
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

function writeDebtRecord_(ss, rec) {
  appendRowByHeaders_(ss, TAB.DEBTS, {
    'Debt ID': rec.id, 'Parent ID': rec.parent || '', 'Link ID': rec.link || '', 'Type': rec.type, 'Term': rec.term,
    'Name': rec.name, 'Start Date': new Date(rec.date), 'Due Date': rec.due ? new Date(rec.due) : '',
    'Wallet': rec.wallet, 'Category': rec.category || '', 'Original': rec.amount
  });
}

function saveDebt_(p, ctx, user) {
  const d = p.d;
  if (isMonthClosed_(ctx.ss, d.date)) return stepDebt_(p, ctx);
  if (!claimPending_(p)) return;
  const ss = ctx.ss;
  const loggedBy = user && user.name ? user.name : p.chatId;
  const debtSheet = ss.getSheetByName(TAB.DEBTS);
  const trxSheet = ss.getSheetByName(TAB.TRANSACTIONS);
  const saved = [];
  const entries = [];      // rows written, for afterSave_ (budget message)
  const created = [];      // debt IDs created
  const trx = function (e, link) {
    const row = Object.assign({ date: d.date, wallet: d.wallet, note: d.note, toWallet: '' }, e);
    const id = writeTransaction_(ss, row, loggedBy, link);
    entries.push(row);
    saved.push(id);
    return id;
  };
  const newContacts = [];
  let text = '';

  withScriptLock_(function () {
    if (d.kind === 'new' && !d.group) {
      const id = nextId_(debtSheet, 'Debt ID', DEBT_PREFIX[d.debtType], 3);
      writeDebtRecord_(ss, { id: id, type: d.debtType, term: d.term, name: d.name, date: d.date, due: d.due,
        wallet: d.wallet, amount: d.amount });
      trx({ type: d.debtType, amount: d.amount, debtId: id,
        note: d.note || (d.debtType === 'Piutang' ? 'Lent to ' : 'Borrowed from ') + d.name });
      created.push(id);
      if (!d.known) newContacts.push(d.name);
      text = '✅ Saved <b>' + id + '</b> · ' + escapeHtml_(d.name) + ' · ' + formatRp_(d.amount) + ' (' + saved[0] + ').';
    } else if (d.kind === 'new') {
      const parentId = nextId_(debtSheet, 'Debt ID', DEBT_PREFIX[d.debtType], 3);
      const link = nextId_(trxSheet, 'Link ID', 'LNK');
      writeDebtRecord_(ss, { id: parentId, link: link, type: d.debtType, term: d.term,
        name: d.people.map(function (x) { return x.name; }).join(', '), date: d.date, due: d.due, wallet: d.wallet, amount: d.total });
      d.people.forEach(function (x, i) {
        const id = parentId + '-' + String.fromCharCode(65 + i);
        writeDebtRecord_(ss, { id: id, parent: parentId, link: link, type: d.debtType, term: d.term, name: x.name,
          date: d.date, due: d.due, wallet: d.wallet, amount: x.amount });
        trx({ type: d.debtType, amount: x.amount, debtId: id, note: d.note || 'Group ' + d.debtType.toLowerCase() + ' ' + parentId }, link);
        created.push(id);
        if (!x.known) newContacts.push(x.name);
      });
      created.push(parentId);
      text = '✅ Saved group <b>' + parentId + '</b> (' + d.people.length + ' people, ' + formatRp_(d.total) + ', ' + link + ').';
    } else if (d.kind === 'split') {
      const link = nextId_(trxSheet, 'Link ID', 'LNK');
      if (d.me > 0) trx({ type: 'Expense', amount: d.me, category: d.category, categoryHow: d.categoryHow,
        note: d.note || 'Split bill (my share)' }, link);
      d.people.forEach(function (x) {
        const id = nextId_(debtSheet, 'Debt ID', 'PTG', 3);
        writeDebtRecord_(ss, { id: id, link: link, type: 'Piutang', term: 'Short', name: x.name, date: d.date,
          wallet: d.wallet, amount: x.amount, category: d.category });
        trx({ type: 'Piutang', amount: x.amount, debtId: id, note: 'Split bill: ' + (d.note || x.name) }, link);
        created.push(id);
        if (!x.known) newContacts.push(x.name);
      });
      text = '✅ Saved split bill (' + link + '): ' + (d.me > 0 ? 'your share ' + formatRp_(d.me) + ' + ' : '') +
        created.length + ' piutang (' + created.join(', ') + ').';
    } else {
      const rec = findDebtById_(loadDebts_(ss), d.recordId);
      if (!rec || !isOpenDebt_(rec)) { text = '⚠️ ' + escapeHtml_(d.recordId) + ' is no longer open. Nothing was saved.'; return; }
      const piutang = rec.type === 'Piutang';
      if (d.kind === 'pay') {
        const paid = Math.min(d.amount, rec.remaining);
        const extra = d.amount - paid;
        const link = extra > 0 ? nextId_(trxSheet, 'Link ID', 'LNK') : '';
        trx({ type: 'Settlement', direction: piutang ? 'In' : 'Out', amount: paid, debtId: rec.id,
          note: d.note || (piutang ? rec.name + ' paid back ' : 'Paid back ' + rec.name + ' ') + rec.id }, link);
        if (extra > 0 && d.overpay === 'flip') {
          const type = piutang ? 'Hutang' : 'Piutang';
          const id = nextId_(debtSheet, 'Debt ID', DEBT_PREFIX[type], 3);
          writeDebtRecord_(ss, { id: id, link: link, type: type, term: 'Short', name: rec.name, date: d.date,
            wallet: d.wallet, amount: extra });
          trx({ type: type, amount: extra, debtId: id, note: 'Overpayment on ' + rec.id }, link);
          created.push(id);
        } else if (extra > 0) {
          trx({ type: piutang ? 'Income' : 'Expense', amount: extra, category: d.extraCategory, categoryHow: 'chosen',
            note: 'Overpayment on ' + rec.id }, link);
        }
        text = '✅ Payment ' + formatRp_(d.amount) + ' for <b>' + rec.id + '</b> ' + (piutang ? 'into ' : 'from ') +
          escapeHtml_(d.wallet) + '.';
      } else if (d.kind === 'add') {
        trx({ type: 'Addition', direction: piutang ? 'Out' : 'In', amount: d.amount, debtId: rec.id,
          note: d.note || 'Added to ' + rec.id }, '');
        text = '✅ Added ' + formatRp_(d.amount) + ' to <b>' + rec.id + '</b>.';
      } else {
        const targets = convertTargets_(loadDebts_(ss), rec);
        const convCol = getHeaderMap_(debtSheet)['converted trx'];
        const link = targets.length > 1 ? nextId_(trxSheet, 'Link ID', 'LNK') : '';
        targets.forEach(function (x) {
          const id = trx({ type: piutang ? 'Expense' : 'Income', direction: 'None', amount: x.remaining, debtId: x.id,
            category: d.category, categoryHow: d.categoryHow || 'chosen', wallet: x.wallet || rec.wallet,
            note: 'Converted ' + x.id + ' (' + x.name + ')' }, link);
          debtSheet.getRange(x.row, convCol + 1).setValue(id);
        });
        if (targets[0].id !== rec.id) debtSheet.getRange(rec.row, convCol + 1).setValue(saved.join(', '));
        text = '✅ <b>' + rec.id + '</b> converted → ' + saved.join(', ') + ' (' + (piutang ? 'Expense' : 'Income') + ', ' +
          escapeHtml_(d.category) + ', ' + formatRp_(entries.reduce(function (s, e) { return s + e.amount; }, 0)) + ').';
      }
    }
  });

  newContacts.forEach(function (n) { addContact_(ss, n, []); });
  if (newContacts.length) text += '\n👤 Added to Contacts: ' + escapeHtml_(newContacts.join(', ')) + '.';
  if (d.kind === 'pay' || d.kind === 'add') {
    SpreadsheetApp.flush();
    const rec = findDebtById_(loadDebts_(ss), d.recordId);
    if (rec) text += ' Remaining: ' + formatRp_(rec.remaining) + ' (' + escapeHtml_(rec.status) + ')';
  }
  editMessage(p.chatId, p.msgId, text);
  afterSave_(ss, p.chatId, entries);
}

// ---------------------------------------------------------------------------
// /undo support: what else must go when a debt entry is undone
// ---------------------------------------------------------------------------

/**
 * For the Transactions rows about to be undone: which debt records to delete
 * (their creation rows are being undone), which records to reopen (their
 * conversion is being undone), or why it's blocked (payments exist).
 */
function debtUndoPlan_(ss, groupRows, allRows) {
  const ids = groupRows.map(function (r) { return String(r['trx id']).trim(); });
  const creations = groupRows.filter(function (r) {
    return (r['type'] === 'Piutang' || r['type'] === 'Hutang') && String(r['debt id'] || '').trim() !== '';
  }).map(function (r) { return String(r['debt id']).trim(); });
  const reopen = groupRows.filter(function (r) {
    return String(r['direction']) === 'None' && String(r['debt id'] || '').trim() !== '';
  }).map(function (r) { return String(r['debt id']).trim(); });
  const later = allRows.filter(function (r) {
    return ids.indexOf(String(r['trx id']).trim()) === -1 && creations.indexOf(String(r['debt id'] || '').trim()) !== -1;
  });
  if (later.length) {
    return { blocked: 'That entry created ' + creations.join(', ') + ', which already has later entries (' +
      later.map(function (r) { return r['trx id']; }).join(', ') + '). Undo those first.' };
  }
  // Group parents go too when all of their sub-records are deleted.
  const debts = loadDebts_(ss);
  const parents = [];
  creations.forEach(function (id) {
    const rec = findDebtById_(debts, id);
    if (rec && rec.parent && parents.indexOf(rec.parent) === -1 &&
        childrenOf_(debts, rec.parent).every(function (k) { return creations.indexOf(k.id) !== -1; })) {
      parents.push(rec.parent);
    }
  });
  return { deleteDebts: creations.concat(parents), reopen: reopen };
}

/** Applies a debt undo plan (inside the undo, after the Transactions rows are gone). */
function applyDebtUndo_(ss, plan) {
  if (!plan || plan.blocked) return;
  withScriptLock_(function () {
    const sheet = ss.getSheetByName(TAB.DEBTS);
    const debts = loadDebts_(ss);
    const convCol = getHeaderMap_(sheet)['converted trx'];
    plan.reopen.forEach(function (id) {
      const rec = findDebtById_(debts, id);
      if (rec) sheet.getRange(rec.row, convCol + 1).setValue('');
      if (rec && rec.parent) {
        const parent = findDebtById_(debts, rec.parent);
        if (parent) sheet.getRange(parent.row, convCol + 1).setValue('');
      }
    });
    debts.filter(function (x) { return plan.deleteDebts.indexOf(x.id) !== -1; })
      .sort(function (a, b) { return b.row - a.row; })
      .forEach(function (x) { sheet.deleteRow(x.row); });
  });
}

// ---------------------------------------------------------------------------
// /open
// ---------------------------------------------------------------------------

function startOpen_(chatId) {
  loadSettingsTab_(true);
  if (getSettingYes_(SETTING.OPEN_PASSWORD)) {
    askPassword_(chatId, 'open', {}, '🔒 Enter the password to see open hutang/piutang.\n' +
      '<i>You can turn this off in Settings → Password for /open.</i>');
    return;
  }
  showOpen_(chatId, false);
}

function showOpen_(chatId, isDefaultPassword) {
  let text = buildOpenText_(loadDebts_(openMainSheet_()), new Date());
  if (isDefaultPassword) text += '\n\n⚠️ You are still using the default password <b>0000</b>. Change it with /changepass.';
  const autoDelete = getSettingYes_(SETTING.OPEN_AUTO_DELETE);
  if (autoDelete) text += '\n\n🕒 This message will be deleted in ' + formatDelay_(OPEN_DELETE_SECONDS) + '.';
  const sent = sendMessage(chatId, text);
  if (autoDelete) scheduleDelete_(chatId, sent.message_id, OPEN_DELETE_SECONDS);
}

/** "due 30 Oct (in 32 days)" / "overdue 3 days" / "open 5 days" / "long-term". */
function debtTiming_(d, now) {
  const day = 86400000;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.due) {
    const due = new Date(d.due.getFullYear(), d.due.getMonth(), d.due.getDate()).getTime();
    const n = Math.round((due - today) / day);
    return n < 0 ? '⚠️ overdue ' + (-n) + ' day' + (n === -1 ? '' : 's') :
      'due ' + formatDate_(d.due) + (n === 0 ? ' (today)' : ' (in ' + n + ' day' + (n === 1 ? '' : 's') + ')');
  }
  if (d.term === 'Long') return 'long-term';
  if (!d.start) return '';
  const open = Math.round((today - new Date(d.start.getFullYear(), d.start.getMonth(), d.start.getDate()).getTime()) / day);
  return open <= 0 ? 'since today' : 'open ' + open + ' day' + (open === 1 ? '' : 's');
}

/** The /open reply: open piutang then hutang, groups with their people. Pure. */
function buildOpenText_(debts, now, hide) {
  const lines = ['📒 <b>Open hutang / piutang</b>'];
  let any = false;
  ['Piutang', 'Hutang'].forEach(function (type) {
    const top = debts.filter(function (d) { return d.type === type && isOpenDebt_(d) && !d.parent; });
    if (top.length === 0) return;
    any = true;
    const total = top.reduce(function (s, d) { return s + d.remaining; }, 0);
    lines.push('', '<b>' + type + '</b> ' + (type === 'Piutang' ? '(they owe you)' : '(you owe)') + ' · ' + money_(total, hide));
    top.forEach(function (d) {
      const timing = debtTiming_(d, now);
      lines.push('• ' + escapeHtml_(d.id) + ' ' + escapeHtml_(d.name) + ' — ' + money_(d.remaining, hide) +
        (timing ? ' · ' + timing : ''));
      childrenOf_(debts, d.id).filter(isOpenDebt_).forEach(function (k) {
        lines.push('   ◦ ' + escapeHtml_(k.id) + ' ' + escapeHtml_(k.name) + ' — ' + money_(k.remaining, hide));
      });
    });
  });
  if (!any) lines.push('', 'Nothing open. 🎉');
  return lines.join('\n');
}

function debtErrorText_(r) {
  switch (r.error) {
    case 'debt_no_amount':
      return 'How much? E.g. <code>piutang 500rb Budi</code>, <code>pinjam 1jt dari Andi</code>, <code>Budi bayar 200rb</code>.';
    case 'debt_no_name':
      return 'Who? E.g. <code>Budi bayar 200rb</code> or use the ID from /open (<code>bayar PTG-001 200rb</code>).';
    case 'group_few_people':
      return 'A group needs at least two people, e.g. <code>piutang grup 600rb Budi, Andi, Citra</code>.';
    case 'split_no_people':
      return 'Who shared the bill? Write their names with a capital letter, e.g. ' +
        '<code>split 400rb makan Budi Andi termasuk saya</code>.';
    case 'shares_mismatch':
      return 'The shares add up to ' + formatRp_(r.sum) + ' but the total is ' + formatRp_(r.total) +
        '. Please check the numbers.';
    case 'debt_amount_unclear':
      return 'Please write the amounts clearly, e.g. <code>200rb</code> or <code>1.5jt</code>.';
    case 'due_unclear':
      return 'I couldn\'t read the due date. Write e.g. <code>jatuh tempo 30/10</code> or <code>due 5 hari</code>.';
    default:
      return parseErrorText_(r);
  }
}
