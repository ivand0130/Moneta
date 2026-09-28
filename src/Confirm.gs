/**
 * Confirm.gs — pending confirmations in CacheService (10 min), preview
 * builder, button (callback) handling, Edit, /undo, and the guided
 * /wallet add and /category add flows.
 *
 * One pending item per chat: { pid, chatId, kind, msgId, awaitText, opts, d }
 *   kind  'trx' (a transaction), 'kw' (keyword offer), 'undo', 'wadd', 'cadd'
 *   pid   random id put in every button, so old buttons can't act on a newer item
 *   msgId the bot message being edited step by step
 *   opts  the labels behind numbered buttons (callback data stays short)
 *   d     the draft
 * Button data: "<pid>|<action>|<arg>".
 */

const PENDING_TTL_SECONDS = 600;

function getPending_(chatId) {
  const v = CacheService.getScriptCache().get('pend_' + chatId);
  return v === null ? null : JSON.parse(v);
}

function savePending_(p) {
  CacheService.getScriptCache().put('pend_' + p.chatId, JSON.stringify(p), PENDING_TTL_SECONDS);
}

function clearPending_(chatId) {
  CacheService.getScriptCache().remove('pend_' + chatId);
}

function newPid_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 6);
}

/** Removes the buttons from an old message. Never throws. */
function dropButtons_(chatId, messageId) {
  if (!messageId) return;
  try {
    tgCall_('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
  } catch (err) {
    console.warn('dropButtons_: ' + err.message);
  }
}

/** Starts a new pending item, replacing (and disarming) any older one. */
function newPending_(chatId, kind, d) {
  const old = getPending_(chatId);
  if (old) dropButtons_(chatId, old.msgId);
  return { pid: newPid_(), chatId: String(chatId), kind: kind, msgId: null, awaitText: null, opts: [], d: d };
}

/** Shows a step: edits the pending's message (or sends one) and saves the pending. */
function showStep_(p, text, rows) {
  const options = rows ? { reply_markup: keyboard_(rows) } : {};
  if (p.msgId) {
    editMessage(p.chatId, p.msgId, text, options);
  } else {
    p.msgId = sendMessage(p.chatId, text, options).message_id;
  }
  savePending_(p);
}

/** Ends the flow: final text on the same message, no buttons. */
function finishStep_(p, text) {
  clearPending_(p.chatId);
  if (p.msgId) editMessage(p.chatId, p.msgId, text);
  else sendMessage(p.chatId, text);
}

/**
 * Takes ownership of the pending item before acting on a final tap, so a
 * double tap can only act once. Returns false for the second tap.
 */
function claimPending_(p) {
  return withScriptLock_(function () {
    const current = getPending_(p.chatId);
    if (!current || current.pid !== p.pid) return false;
    clearPending_(p.chatId);
    return true;
  });
}

function btn_(p, label, action, arg) {
  return [label, p.pid + '|' + action + (arg === undefined ? '' : '|' + arg)];
}

function cancelRow_(p) {
  return [btn_(p, '❌ Cancel', 'n')];
}

/** Sheet data every transaction step needs. */
function loadCtx_() {
  const ss = openMainSheet_();
  return {
    ss: ss,
    wallets: loadWallets_(ss),
    categories: loadCategories_(ss),
    investmentGroups: getSettingList_(SETTING.INVESTMENT_GROUPS),
    spendingGroups: getSettingList_(SETTING.SPENDING_GROUPS)
  };
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/** A new message that isn't a command: parse it and start the flow. */
function startTransaction_(message) {
  const chatId = String(message.chat.id);
  const ctx = loadCtx_();
  let parsed = parseTransaction_(message.text, {
    wallets: ctx.wallets, categories: ctx.categories, investmentGroups: ctx.investmentGroups, now: new Date()
  });
  // AI fallback (only when the rules found no clear amount and the text looks like it has one).
  if (!parsed.ok && (parsed.error === 'no_amount' || parsed.error === 'multiple_amounts') &&
      looksLikeMoney_(message.text) && getSettingYes_(SETTING.AI_ENABLED)) {
    sendTyping_(chatId);
    const ai = aiParseTransaction_(message.text, ctx, new Date());
    if (ai && ai.ok) parsed = ai;
    else if (ai && ai.failed) parsed.aiFailed = true;
  }
  if (!parsed.ok) {
    sendMessage(chatId, parseErrorText_(parsed) + (parsed.aiFailed
      ? '\n\n🤖 <i>I also asked the AI to read it, but that failed. The reason is in the Logs tab ' +
        '(or run testGemini in the editor).</i>' : ''));
    return;
  }
  const p = newPending_(chatId, 'trx', {
    type: parsed.type,
    amount: parsed.amount,
    amountOptions: parsed.amountOptions,
    amountReason: parsed.amountReason,
    amountText: parsed.amountText,
    date: parsed.date.getTime(),
    dateNeedsConfirm: parsed.dateNeedsConfirm,
    dateText: parsed.dateText,
    wallet: parsed.wallet,
    walletChoices: parsed.walletChoices,
    walletHow: parsed.wallet ? 'mentioned' : '',
    toWallet: parsed.toWallet,
    toWalletChoices: parsed.toWalletChoices,
    category: parsed.category,
    categoryHow: parsed.categoryHow,
    unknownTag: parsed.unknownTag,
    note: parsed.note,
    extra: parsed.extra || null,   // transfer fee / received amount / partial expense (SPEC Section 6)
    readByAi: !!parsed.readByAi
  });
  if (p.d.type !== 'Transfer' && !p.d.category) aiCategory_(p, ctx);
  p.orig = p.d.category; // to spot a correction later (→ offer to save a keyword)
  advanceTrx_(p, ctx);
}

/** Step 3 of category mapping: ask Gemini. Failures just leave it empty. */
function aiCategory_(p, ctx) {
  if (!p.d.note || !getSettingYes_(SETTING.AI_ENABLED)) return;
  sendTyping_(p.chatId);
  const names = ctx.categories.filter(function (c) { return c.type === p.d.type; })
    .map(function (c) { return c.name; });
  const pick = aiSuggestCategory_(p.d.note, p.d.type, names);
  if (pick) {
    p.d.category = pick;
    p.d.categoryHow = 'ai';
  }
}

/** Asks for whatever is still missing, in order, then shows the preview. */
function advanceTrx_(p, ctx) {
  const d = p.d;
  p.awaitText = null;
  if (d.amountOptions) return askAmount_(p);
  if (d.dateNeedsConfirm) return askDateConfirm_(p);

  if (d.type === 'Transfer') {
    if (!findWallet_(cashWallets_(ctx.wallets), d.wallet)) return askWallet_(p, ctx, 'from');
    if (!findWallet_(cashWallets_(ctx.wallets), d.toWallet)) return askWallet_(p, ctx, 'to');
    if (d.wallet === d.toWallet) {
      d.toWallet = null;
      return askWallet_(p, ctx, 'to', 'From and To must be different wallets.');
    }
    // The source wallet's Default Transfer Fee is suggested once (removable in the preview).
    if (!d.feeChecked) {
      d.feeChecked = true;
      const src = findWallet_(ctx.wallets, d.wallet);
      if (!d.extra && src && src.defaultFee > 0) {
        d.extra = newFeeExtra_(src.defaultFee, ctx);
        d.extra.suggested = true;
      }
    }
    if (d.extra) {
      const x = d.extra;
      if (x.kind === 'received') return askReceived_(p);
      if (x.amount >= d.amount) {
        return showStep_(p, '⚠️ The ' + (x.kind === 'fee' ? 'fee' : 'spent part') + ' (' + formatRp_(x.amount) +
          ') must be smaller than the transfer (' + formatRp_(d.amount) + '). Please correct it.',
          [[btn_(p, '✏️ Edit', 'e'), btn_(p, '❌ Cancel', 'n')]]);
      }
      if (x.kind === 'partial' && !x.from) x.from = 'dest'; // owner's rule: spent from the destination after arriving
      if (!ctx.categories.some(function (c) { return c.name === x.category && c.type === 'Expense'; })) {
        x.category = null;
        if (!x.aiTried) {
          x.aiTried = true;
          aiExtraCategory_(p, ctx);
        }
        if (!x.category) return askCategory_(p, ctx, 'extra');
      }
    }
  } else {
    if (!ctx.categories.some(function (c) { return c.name === d.category && c.type === d.type; })) {
      d.category = null;
      return askCategory_(p, ctx);
    }
    const usable = everydayWallets_(ctx.wallets, ctx.investmentGroups);
    if (!findWallet_(usable, d.wallet)) {
      if (d.walletChoices) return askWallet_(p, ctx, 'wallet'); // a name that fits several wallets
      // Wallet rule 2: the category's default wallet, shown in the preview.
      const cat = ctx.categories.filter(function (c) { return c.name === d.category; })[0];
      const def = cat ? findWallet_(usable, cat.defaultWallet) : null;
      if (!def) return askWallet_(p, ctx, 'wallet'); // Wallet rule 3: ask.
      d.wallet = def.name;
      d.walletHow = 'default';
    }
  }

  if (isMonthClosed_(ctx.ss, d.date)) {
    const month = Utilities.formatDate(new Date(d.date), Session.getScriptTimeZone(), 'MMMM yyyy');
    return showStep_(p, '⛔ ' + month + " is closed, so entries can't be dated in it.\nUse today's date instead?",
      [[btn_(p, "📅 Use today", 'today'), btn_(p, '❌ Cancel', 'n')]]);
  }

  const rows = [[btn_(p, '✅ Yes', 'y'), btn_(p, '❌ No', 'n'), btn_(p, '✏️ Edit', 'e')]];
  if (d.extra && d.extra.suggested) rows.push([btn_(p, '🚫 No fee', 'xr')]);
  showStep_(p, buildPreviewText_(p, ctx, 'Save?'), rows);
}

// ---------------------------------------------------------------------------
// Transfers with a fee, a received amount or a partial expense (SPEC Section 6)
// ---------------------------------------------------------------------------
// d.extra = { kind: 'fee' | 'partial' | 'received', amount, category,
//             categoryHow, note, from: 'source' | 'dest' (partial only), suggested }
//   fee      "admin X" / "dipotong X" / default fee / fee added in Edit: the fee comes OUT OF the
//            amount — Transfer = amount − fee, expense from the source (source −amount in total)
//   partial  "Y untuk makan": by default spent from the destination after arriving (Transfer =
//            amount, expense from the destination); Edit can switch it to the source
//            (Transfer = amount − Y, expense from the source)
//   received "sampai R": asked first, then becomes a fee, a partial (source) or nothing

/** A fee extra with the fee category (keyword "admin", else "Admin & Bank Fees", else asked). */
function newFeeExtra_(amount, ctx) {
  const k = matchKeyword_('admin', ctx.categories, ['Expense']);
  const byName = ctx.categories.filter(function (c) { return c.type === 'Expense' && c.name === DEFAULT_FEE_CATEGORY; })[0];
  const category = byName ? byName.name : (k ? k.category : null);
  return { kind: 'fee', amount: amount, category: category, categoryHow: category ? 'keyword' : '', note: '' };
}

/**
 * The rows a draft saves: one row normally, or Transfer + Expense for a
 * transfer with an extra. Each: { type, amount, wallet, toWallet, category,
 * categoryHow, note, date }.
 */
function entriesOf_(d) {
  const main = { type: d.type, amount: d.amount, wallet: d.wallet, toWallet: d.type === 'Transfer' ? d.toWallet : '',
    category: d.type === 'Transfer' ? '' : d.category, categoryHow: d.type === 'Transfer' ? '' : d.categoryHow,
    note: d.note, date: d.date };
  const x = d.extra;
  if (d.type !== 'Transfer' || !x || x.kind === 'received') return [main];
  const fromSource = x.kind === 'fee' || x.from === 'source';
  if (fromSource) main.amount = d.amount - x.amount; // fee or source-spent part comes out of the amount
  const note = x.note || (x.kind === 'fee' ? 'Transfer fee ' : 'Spent during transfer ') + d.wallet + ' → ' + d.toWallet;
  return [main, { type: 'Expense', amount: x.amount, wallet: fromSource ? d.wallet : d.toWallet, toWallet: '',
    category: x.category, categoryHow: x.categoryHow, note: note, date: d.date }];
}

/** How much each wallet changes: { walletName: +/- amount }. */
function walletDeltas_(entries) {
  const out = {};
  const add = function (name, v) { out[name] = (out[name] || 0) + v; };
  entries.forEach(function (e) {
    if (e.type === 'Income') add(e.wallet, e.amount);
    else add(e.wallet, -e.amount);
    if (e.type === 'Transfer') add(e.toWallet, e.amount);
  });
  return out;
}

/** "sampai R": ask what the difference between sent and received was. */
function askReceived_(p) {
  const d = p.d;
  const received = d.extra.amount;
  if (received === d.amount) {
    d.extra = null;
    return advanceTrx_(p, loadCtx_());
  }
  if (received > d.amount) {
    return showStep_(p, summaryLine_(p) + '\nYou wrote that ' + formatRp_(received) + ' arrived, which is MORE than ' +
      formatRp_(d.amount) + '. Was the transfer actually ' + formatRp_(received) + '?',
      [[btn_(p, '✏️ Yes, it was ' + formatRp_(received), 'rx', 'typo')], cancelRow_(p)]);
  }
  const diff = d.amount - received;
  showStep_(p, summaryLine_(p) + '\nSent ' + formatRp_(d.amount) + ', received ' + formatRp_(received) + ': ' +
    '<b>' + formatRp_(diff) + '</b> difference. What was it?',
    [[btn_(p, '💸 A fee', 'rx', 'fee'), btn_(p, '🛒 Spent on something', 'rx', 'spent')],
     [btn_(p, '✏️ Typo: the transfer was ' + formatRp_(received), 'rx', 'typo')], cancelRow_(p)]);
}

/** Gemini guess for the extra part's category (partial expenses with a note). */
function aiExtraCategory_(p, ctx) {
  const x = p.d.extra;
  if (x.kind !== 'partial' || !x.note || !getSettingYes_(SETTING.AI_ENABLED)) return;
  sendTyping_(p.chatId);
  const names = ctx.categories.filter(function (c) { return c.type === 'Expense'; }).map(function (c) { return c.name; });
  const pick = aiSuggestCategory_(x.note, 'Expense', names);
  if (pick) {
    x.category = pick;
    x.categoryHow = 'ai';
  }
}

/** "tgl 10" was read as the nearest past 10th: confirm it or pick another date. */
function askDateConfirm_(p) {
  const label = formatDate_(p.d.date);
  showStep_(p, summaryLine_(p) + '\n📅 I read "' + escapeHtml_(p.d.dateText) + '" as <b>' + label + '</b>. Is that right?',
    [[btn_(p, '✅ ' + label, 'dok'), btn_(p, '✏️ Other date', 'ef', 'date')], cancelRow_(p)]);
}

const AMOUNT_REASONS = {
  small: 'has no unit',
  no_unit: 'has a decimal but no unit (rb or jt?)',
  format: "doesn't look like a normal amount",
  decimal: 'has a decimal'
};

function askAmount_(p) {
  const d = p.d;
  const rows = chunk_(d.amountOptions.map(function (v, i) { return btn_(p, formatRp_(v), 'am', i); }), 2);
  rows.push([btn_(p, '✏️ Type it', 'ef', 'amount'), btn_(p, '❌ Cancel', 'n')]);
  showStep_(p, '🤔 The amount "' + escapeHtml_(d.amountText) + '" ' + (AMOUNT_REASONS[d.amountReason] || 'is unclear') +
    '. Which did you mean?', rows);
}

/**
 * which: 'wallet' (expense/income), 'from' or 'to' (transfer).
 * Expense buttons: wallets in the Spending Wallet Groups. Income: every
 * non-investment cash wallet. Transfers: every cash wallet (e.g. BCA → IPOT).
 */
function askWallet_(p, ctx, which, warning) {
  const exclude = which === 'to' ? p.d.wallet : (which === 'from' ? p.d.toWallet : null);
  let list;
  const typed = which === 'to' ? p.d.toWalletChoices : p.d.walletChoices;
  if (typed && typed.length) {
    list = typed.map(function (n) { return findWallet_(ctx.wallets, n); }).filter(Boolean);
  } else if (which !== 'wallet') {
    list = cashWallets_(ctx.wallets);
  } else if (p.d.type === 'Expense') {
    list = spendingWallets_(ctx.wallets, ctx.investmentGroups, ctx.spendingGroups);
    if (list.length === 0) list = everydayWallets_(ctx.wallets, ctx.investmentGroups); // no match: don't strand the user
  } else {
    list = everydayWallets_(ctx.wallets, ctx.investmentGroups);
  }
  p.opts = list.filter(function (w) { return w.name !== exclude; }).map(function (w) { return w.name; });
  const question = which === 'from' ? 'From which wallet?' : which === 'to' ? 'To which wallet?' :
    (p.d.type === 'Income' ? 'Into which wallet?' : 'Paid from which wallet?');
  const rows = chunk_(p.opts.map(function (n, i) { return btn_(p, n, which === 'to' ? 'tw' : 'w', i); }), 3);
  rows.push(cancelRow_(p));
  showStep_(p, (warning ? '⚠️ ' + escapeHtml_(warning) + '\n' : '') + summaryLine_(p) + '\n' + question, rows);
}

/** target 'extra' = the category of a transfer's fee / spent part. */
function askCategory_(p, ctx, target) {
  const forExtra = target === 'extra';
  const type = forExtra ? 'Expense' : p.d.type;
  p.opts = ctx.categories.filter(function (c) { return c.type === type; }).map(function (c) { return c.name; });
  const rows = chunk_(p.opts.map(function (n, i) { return btn_(p, n, forExtra ? 'xc' : 'c', i); }), 2);
  rows.push(cancelRow_(p));
  if (forExtra) {
    const x = p.d.extra;
    return showStep_(p, summaryLine_(p) + '\nWhich category is the ' + formatRp_(x.amount) +
      (x.kind === 'fee' ? ' fee' : (x.note ? ' (' + escapeHtml_(x.note) + ')' : ' spent part')) + '?', rows);
  }
  const intro = p.d.unknownTag ? "I don't know the category #" + escapeHtml_(p.d.unknownTag) + '.\n' : '';
  showStep_(p, intro + summaryLine_(p) + '\nWhich category?', rows);
}

/** "🧾 Expense Rp50.000 · makan siang" */
function summaryLine_(p) {
  const d = p.d;
  const icon = d.type === 'Income' ? '💵' : d.type === 'Transfer' ? '🔁' : '🧾';
  return icon + ' ' + d.type + (d.amount ? ' <b>' + formatRp_(d.amount) + '</b>' : '') +
    (d.note ? ' · ' + escapeHtml_(d.note) : '');
}

const CATEGORY_HOW_LABEL = { tag: 'your #tag', keyword: 'keyword', ai: 'AI', chosen: 'you picked' };

function buildPreviewText_(p, ctx, footer) {
  const d = p.d;
  const w = findWallet_(ctx.wallets, d.wallet);
  const entries = entriesOf_(d);
  const lines = [];
  const how = function (h) { return ' <i>(' + (CATEGORY_HOW_LABEL[h] || 'you picked') + ')</i>'; };
  if (d.type === 'Transfer') {
    const tw = findWallet_(ctx.wallets, d.toWallet);
    const route = escapeHtml_(w.name) + ' (' + escapeHtml_(w.group) + ') → ' + escapeHtml_(tw.name) + ' (' + escapeHtml_(tw.group) + ')';
    if (entries.length === 1) {
      lines.push('🔁 <b>Preview</b>', 'Transfer <b>' + formatRp_(d.amount) + '</b>', '👛 ' + route);
    } else {
      const x = d.extra;
      lines.push('🔁 <b>Preview</b> · linked entries',
        '1. Transfer <b>' + formatRp_(entries[0].amount) + '</b> · ' + route,
        '2. Expense <b>' + formatRp_(x.amount) + '</b> · ' + escapeHtml_(x.category) + how(x.categoryHow) +
          ' · from ' + escapeHtml_(entries[1].wallet) +
          (x.suggested ? ' <i>(default fee for ' + escapeHtml_(d.wallet) + ')</i>' : '') +
          (x.kind === 'partial' && x.note ? ' · "' + escapeHtml_(x.note) + '"' : ''));
    }
    const deltas = walletDeltas_(entries);
    lines.push(Object.keys(deltas).map(function (name) {
      return escapeHtml_(name) + ' ' + formatRpSigned_(deltas[name]);
    }).join(' | '));
  } else {
    lines.push((d.type === 'Income' ? '💵' : '🧾') + ' <b>Preview</b>',
      d.type + ' <b>' + formatRp_(d.amount) + '</b>',
      '📂 ' + escapeHtml_(d.category) + how(d.categoryHow),
      '👛 ' + escapeHtml_(w.name) + ' → ' + escapeHtml_(w.group) +
        (d.walletHow === 'default' ? ' <i>(default for ' + escapeHtml_(d.category) + ')</i>' : ''));
  }
  lines.push('📅 ' + formatDate_(d.date));
  if (d.note) lines.push('📝 ' + escapeHtml_(d.note));
  if (d.readByAi) lines.push('🤖 <i>Read by AI — please check the details.</i>');
  const warnings = previewChecks_(p, ctx, entries);
  if (warnings.length) lines.push('', warnings.join('\n'));
  lines.push('', footer);
  return lines.join('\n');
}

/** Large amount, possible duplicate, negative balance (per wallet), future date. */
function previewChecks_(p, ctx, entries) {
  const d = p.d;
  const out = [];
  const large = getSettingInt_(SETTING.LARGE_AMOUNT);
  if (large > 0 && d.amount > large) out.push('⚠️ Large amount (over ' + formatRp_(large) + ').');
  const dup = findDuplicate_(loadTransactions_(ctx.ss), d, getSettingInt_(SETTING.DUPLICATE_MINUTES));
  if (dup) {
    out.push('⚠️ Possible duplicate of ' + escapeHtml_(dup['trx id'] || 'an existing row') +
      ' (same type, amount and note). Save it again?');
  }
  const deltas = walletDeltas_(entries);
  Object.keys(deltas).forEach(function (name) {
    const w = findWallet_(ctx.wallets, name);
    if (w && deltas[name] < 0 && w.balance + deltas[name] < 0) {
      out.push('⚠️ ' + escapeHtml_(name) + ' would go negative (' + formatRp_(w.balance + deltas[name]) + ').');
    }
  });
  if (d.date > Date.now() + 60000) out.push('⚠️ This date is in the future.');
  return out;
}

function showEditMenu_(p, ctx) {
  const d = p.d;
  let rows;
  if (d.type === 'Transfer') {
    rows = [[btn_(p, 'Amount', 'ef', 'amount'), btn_(p, 'From', 'ef', 'wallet'), btn_(p, 'To', 'ef', 'to')],
      [btn_(p, 'Date', 'ef', 'date'), btn_(p, 'Note', 'ef', 'note'), btn_(p, 'Type', 'ef', 'type')]];
    if (d.extra) {
      rows.push([btn_(p, (d.extra.kind === 'fee' ? 'Fee' : 'Spent') + ' amount', 'ef', 'xamount'),
        btn_(p, (d.extra.kind === 'fee' ? 'Fee' : 'Spent') + ' category', 'ef', 'xcategory'),
        btn_(p, '🚫 Remove ' + (d.extra.kind === 'fee' ? 'fee' : 'spent part'), 'xr')]);
      if (d.extra.kind === 'partial') {
        const other = d.extra.from === 'source' ? d.toWallet : d.wallet;
        rows.push([btn_(p, '🔄 Spent from ' + other + ' instead', 'pf', d.extra.from === 'source' ? 'dest' : 'source')]);
      }
    } else {
      rows.push([btn_(p, '➕ Add fee', 'ef', 'xamount')]);
    }
  } else {
    rows = [[btn_(p, 'Amount', 'ef', 'amount'), btn_(p, 'Category', 'ef', 'category'), btn_(p, 'Wallet', 'ef', 'wallet')],
      [btn_(p, 'Date', 'ef', 'date'), btn_(p, 'Note', 'ef', 'note'), btn_(p, 'Type', 'ef', 'type')]];
  }
  rows.push([btn_(p, '⬅️ Back', 'back'), btn_(p, '❌ Cancel entry', 'n')]);
  showStep_(p, buildPreviewText_(p, ctx, '✏️ What do you want to change?'), rows);
}

const EDIT_PROMPTS = {
  amount: 'Send the new amount, e.g. <code>75rb</code>.',
  xamount: 'Send the fee / spent amount, e.g. <code>2.5rb</code>.',
  date: 'Send the new date, e.g. <code>kemarin</code>, <code>10</code> (the last 10th), <code>20/09</code> or <code>5 okt</code>.',
  note: 'Send the new note.'
};

function trxCallback_(p, action, arg, user) {
  const d = p.d;
  if (action === 'n') return finishStep_(p, '❌ Cancelled. Nothing was saved.');
  const ctx = loadCtx_();
  switch (action) {
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
      if (d.walletHow === 'default') { d.wallet = null; d.walletHow = ''; } // re-apply the new category's default
      break;
    case 'xc': // category of the fee / spent part
      if (d.extra) { d.extra.category = p.opts[Number(arg)]; d.extra.categoryHow = 'chosen'; }
      break;
    case 'xr': // remove the fee / spent part
      d.extra = null;
      break;
    case 'pf': // partial expense spent from the source or the destination
      if (d.extra) d.extra.from = arg === 'dest' ? 'dest' : 'source';
      break;
    case 'rx': // answer to "sampai R": what was the difference?
      if (d.extra && d.extra.kind === 'received') {
        const received = d.extra.amount;
        const diff = d.amount - received;
        if (arg === 'fee') {
          d.extra = newFeeExtra_(diff, ctx); // Transfer = sent − fee = what arrived
        } else if (arg === 'spent') {
          d.extra = { kind: 'partial', amount: diff, from: 'source', note: '', category: null, categoryHow: '' };
        } else {
          d.amount = received; // typo: the transfer was the received amount
          d.extra = null;
        }
      }
      break;
    case 'dok':
      d.dateNeedsConfirm = false;
      break;
    case 'today':
      d.date = Date.now();
      d.dateNeedsConfirm = false;
      break;
    case 'e':
      return showEditMenu_(p, ctx);
    case 'ef':
      if (EDIT_PROMPTS[arg]) {
        p.awaitText = arg;
        return showStep_(p, summaryLine_(p) + '\n' + EDIT_PROMPTS[arg],
          [[btn_(p, '⬅️ Back', 'back'), btn_(p, '❌ Cancel entry', 'n')]]);
      }
      if (arg === 'category') return askCategory_(p, ctx);
      if (arg === 'xcategory') return askCategory_(p, ctx, 'extra');
      if (arg === 'wallet') return askWallet_(p, ctx, d.type === 'Transfer' ? 'from' : 'wallet');
      if (arg === 'to') return askWallet_(p, ctx, 'to');
      if (arg === 'type') {
        return showStep_(p, summaryLine_(p) + '\nChange the type to:',
          [[btn_(p, '🧾 Expense', 't', 'Expense'), btn_(p, '💵 Income', 't', 'Income'), btn_(p, '🔁 Transfer', 't', 'Transfer')],
           [btn_(p, '⬅️ Back', 'back'), btn_(p, '❌ Cancel entry', 'n')]]);
      }
      break;
    case 't':
      changeType_(p, arg, ctx);
      break;
    case 'y':
      return saveTrx_(p, ctx, user);
  }
  advanceTrx_(p, ctx);
}

/** Switches Expense / Income / Transfer and re-maps the category if needed. */
function changeType_(p, type, ctx) {
  const d = p.d;
  if (['Expense', 'Income', 'Transfer'].indexOf(type) === -1 || d.type === type) return;
  d.type = type;
  if (d.walletHow === 'default') { d.wallet = null; d.walletHow = ''; }
  if (type === 'Transfer') {
    d.category = null;
    d.categoryHow = '';
    return;
  }
  d.toWallet = null;
  d.extra = null; // fees / spent parts only exist on transfers
  const cat = ctx.categories.filter(function (c) { return c.name === d.category; })[0];
  if (!cat || cat.type !== type) {
    d.category = null;
    d.categoryHow = '';
    const k = matchKeyword_(d.note, ctx.categories, [type]);
    if (k) { d.category = k.category; d.categoryHow = 'keyword'; } else aiCategory_(p, ctx);
    p.orig = d.category;
  }
}

/** Text sent while the bot is waiting for a new amount / date / note. */
function handlePendingText_(p, message) {
  const text = String(message.text).trim();
  const d = p.d;
  if (p.awaitText === 'amount') {
    const a = parseAmountToken_(text);
    if (a === null) {
      sendMessage(p.chatId, "I couldn't read that amount. Send just the amount, e.g. <code>75rb</code>, or tap Back.");
      return;
    }
    if (a.ambiguous) {
      d.amountOptions = a.ambiguous.options;
      d.amountReason = a.ambiguous.reason;
      d.amountText = text;
    } else {
      d.amount = a.value;
      d.amountOptions = null;
    }
  } else if (p.awaitText === 'xamount') {
    const a = parseAmountToken_(text);
    if (a === null || (a.ambiguous && a.ambiguous.reason !== 'small')) {
      sendMessage(p.chatId, "I couldn't read that amount. Send just the amount, e.g. <code>2.5rb</code>, or tap Back.");
      return;
    }
    if (d.extra) d.extra.amount = a.value;
    else d.extra = newFeeExtra_(a.value, loadCtx_()); // "Add fee"
    d.extra.suggested = false;
  } else if (p.awaitText === 'date') {
    const date = parseDateOnly_(text, new Date());
    if (date === null) {
      sendMessage(p.chatId, "I couldn't read that date. Try <code>kemarin</code>, <code>20/09</code> or <code>5 okt</code>.");
      return;
    }
    d.date = date.getTime();
    d.dateNeedsConfirm = false;
  } else if (p.awaitText === 'note') {
    d.note = text.slice(0, 200);
  }
  // Continue below the user's message instead of editing the old one far above.
  dropButtons_(p.chatId, p.msgId);
  p.msgId = null;
  advanceTrx_(p, loadCtx_());
}

function saveTrx_(p, ctx, user) {
  const d = p.d;
  if (isMonthClosed_(ctx.ss, d.date)) return advanceTrx_(p, ctx);
  const loggedBy = user && user.name ? user.name : p.chatId;
  const entries = entriesOf_(d);
  const saved = withScriptLock_(function () {
    const current = getPending_(p.chatId);
    if (!current || current.pid !== p.pid) return null; // double tap: already saved
    const sheet = ctx.ss.getSheetByName(TAB.TRANSACTIONS);
    const linkId = entries.length > 1 ? nextId_(sheet, 'Link ID', 'LNK') : '';
    const ids = entries.map(function (e) { return writeTransaction_(ctx.ss, e, loggedBy, linkId); });
    clearPending_(p.chatId);
    return { ids: ids, linkId: linkId };
  });
  if (saved === null) return;

  editMessage(p.chatId, p.msgId, '✅ Saved as <b>' + saved.ids.join('</b> + <b>') + '</b>' +
    (saved.linkId ? ' (' + saved.linkId + ')' : '') + '.');
  afterSave_(ctx.ss, p.chatId, entries);
  const x = d.extra;
  if (x && x.kind === 'partial' && x.categoryHow === 'chosen' && x.note) offerKeyword_(p.chatId, x.category, x.note);

  if (d.type !== 'Transfer' && d.categoryHow === 'chosen' && d.category !== p.orig) {
    offerKeyword_(p.chatId, d.category, d.note);
  }
}

// ---------------------------------------------------------------------------
// After save (every flow that saves entries calls this)
// ---------------------------------------------------------------------------

/**
 * Runs after entries are saved: sends the budget message (SPEC Section 25)
 * for every expense category in `entries` that has a budget > 0, using the
 * month of each entry's date. entries = [{ type, category, date(ms) }].
 * Never throws — a problem here must not look like a failed save.
 */
function afterSave_(ss, chatId, entries) {
  try {
    const expenses = entries.filter(function (e) { return countsAsExpense_(e) && e.category; });
    if (expenses.length === 0) return;
    const budgeted = {};
    loadCategories_(ss).forEach(function (c) {
      if (c.type === 'Expense' && c.budget > 0) budgeted[c.name] = c.budget;
    });
    const wanted = [];
    expenses.forEach(function (e) {
      const date = new Date(e.date);
      const key = e.category + '|' + date.getFullYear() + '|' + date.getMonth();
      if (budgeted[e.category] && wanted.indexOf(key) === -1) wanted.push(key);
    });
    if (wanted.length === 0) return;

    SpreadsheetApp.flush();
    const rows = loadTransactions_(ss);
    const items = wanted.map(function (key) {
      const parts = key.split('|');
      const year = Number(parts[1]);
      const month = Number(parts[2]);
      return { category: parts[0], year: year, month: month, budget: budgeted[parts[0]],
        spent: spentInMonth_(rows, parts[0], year, month) };
    });

    loadSettingsTab_(true); // fresh: "Budget auto-delete" / "Hide amounts" changes apply right away
    const autoDelete = getSettingYes_(SETTING.BUDGET_AUTO_DELETE);
    const text = buildBudgetText_(items) + (autoDelete ? '\n\n🕒 <i>Deleted at the end of the day.</i>' : '');
    const sent = sendMessage(chatId, text);
    if (autoDelete) scheduleDelete_(chatId, sent.message_id, secondsUntilEndOfDay_());
  } catch (err) {
    logError_('afterSave_', err);
  }
}

/** Seconds until 23:59 today (Asia/Jakarta); 60 if it's already later than that. */
function secondsUntilEndOfDay_() {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0);
  return Math.max(60, Math.round((end.getTime() - now.getTime()) / 1000));
}

// ---------------------------------------------------------------------------
// Keyword offer (after a category correction)
// ---------------------------------------------------------------------------

function offerKeyword_(chatId, category, note) {
  const candidates = keywordCandidates_(note);
  if (candidates.length === 0) return;
  const p = newPending_(chatId, 'kw', { category: category });
  p.opts = candidates;
  const rows = chunk_(candidates.map(function (k, i) { return btn_(p, k, 'kw', i); }), 4);
  rows.push([btn_(p, 'No thanks', 'n')]);
  showStep_(p, '💡 Save a keyword so similar notes go to <b>' + escapeHtml_(category) + '</b> automatically?', rows);
}

function kwCallback_(p, action, arg) {
  if (action !== 'kw') return finishStep_(p, 'OK, no keyword saved.');
  if (!claimPending_(p)) return;
  const keyword = p.opts[Number(arg)];
  const removed = addKeywordToCategory_(openMainSheet_(), p.d.category, keyword);
  finishStep_(p, '✅ "' + escapeHtml_(keyword) + '" → ' + escapeHtml_(p.d.category) + ' from now on.' +
    (removed.length ? ' (Moved from ' + escapeHtml_(removed.join(', ')) + '.)' : ''));
}

// ---------------------------------------------------------------------------
// /undo
// ---------------------------------------------------------------------------

function startUndo_(chatId, user) {
  const ss = openMainSheet_();
  const loggedBy = user && user.name ? user.name : String(chatId);
  const group = findLastEntryGroup_(loadTransactions_(ss), loggedBy);
  if (group.length === 0) {
    sendMessage(chatId, 'Nothing to undo: no entries logged by ' + escapeHtml_(loggedBy) + '.');
    return;
  }
  if (group.some(function (r) { return r['date'] instanceof Date && isMonthClosed_(ss, r['date']); })) {
    sendMessage(chatId, "⛔ Your last entry is in a closed month and can't be undone.");
    return;
  }
  const p = newPending_(chatId, 'undo', {
    ids: group.map(function (r) { return String(r['trx id']).trim(); }).filter(String)
  });
  const linked = group.length > 1;
  showStep_(p, '↩️ Delete your last entry' + (linked ? ' — it is a linked group of ' + group.length +
    ' entries, which are deleted together' : '') + '?\n' + group.map(describeRow_).join('\n'),
    [[btn_(p, linked ? '🗑️ Delete all ' + group.length : '🗑️ Delete', 'y'), btn_(p, '❌ Cancel', 'n')]]);
}

function undoCallback_(p, action) {
  if (action !== 'y') return finishStep_(p, 'OK, kept it.');
  if (!claimPending_(p)) return;
  const deleted = deleteTransactions_(openMainSheet_(), p.d.ids);
  finishStep_(p, deleted.length ? '🗑️ Deleted ' + deleted.join(', ') + '.' : 'Those entries were already gone.');
}

// ---------------------------------------------------------------------------
// /wallet add, /category add
// ---------------------------------------------------------------------------

function startWalletAdd_(chatId, name) {
  if (!name) return sendMessage(chatId, 'Write the name too, e.g. <code>/wallet add Jenius</code>');
  if (name.length > 40 || /[#|,]/.test(name)) return sendMessage(chatId, 'Please use a short name without # | or commas.');
  if (findWallet_(loadWallets_(openMainSheet_()), name)) {
    return sendMessage(chatId, 'A wallet called "' + escapeHtml_(name) + '" already exists. See /wallet.');
  }
  stepWalletAdd_(newPending_(chatId, 'wadd', { name: name }));
}

function stepWalletAdd_(p) {
  const d = p.d;
  const tab = loadSettingsTab_();
  const title = '👛 New wallet <b>' + escapeHtml_(d.name) + '</b>';
  if (!d.group) {
    p.opts = tab.walletGroups;
    if (p.opts.length === 0) return finishStep_(p, 'Add wallet groups in Settings → Wallet Groups first.');
    const rows = chunk_(p.opts.map(function (g, i) { return btn_(p, g, 'g', i); }), 3);
    rows.push(cancelRow_(p));
    return showStep_(p, title + '\nWhich group?', rows);
  }
  if (!d.type) {
    return showStep_(p, title + '\nWhat kind of wallet?',
      [[btn_(p, '💳 Cash / bank / e-wallet', 'wt', 'Cash')], [btn_(p, '📈 Investment category', 'wt', 'Investment')],
       cancelRow_(p)]);
  }
  if (!d.owner) {
    p.opts = tab.owners.length ? tab.owners : ['Shared'];
    const rows = chunk_(p.opts.map(function (o, i) { return btn_(p, o, 'o', i); }), 3);
    rows.push(cancelRow_(p));
    return showStep_(p, title + '\nWho owns it?', rows);
  }
  showStep_(p, title + '\nGroup: ' + escapeHtml_(d.group) + '\nType: ' + d.type + '\nOwner: ' + escapeHtml_(d.owner) +
    '\nOpening balance: Rp0 (set it in the Wallets tab)' +
    (d.type === 'Investment' ? '\nAn Investment category with the same name is added too.' : '') + '\n\nSave?',
    [[btn_(p, '✅ Yes', 'y'), btn_(p, '❌ No', 'n')]]);
}

function walletAddCallback_(p, action, arg) {
  const d = p.d;
  if (action === 'n') return finishStep_(p, '❌ Cancelled. No wallet added.');
  if (action === 'g') d.group = p.opts[Number(arg)];
  if (action === 'wt') d.type = arg === 'Investment' ? 'Investment' : 'Cash';
  if (action === 'o') d.owner = p.opts[Number(arg)];
  if (action === 'y') {
    if (!claimPending_(p)) return;
    try {
      addWallet_(openMainSheet_(), d);
    } catch (err) {
      return finishStep_(p, '❌ ' + escapeHtml_(err.message));
    }
    return finishStep_(p, '✅ Wallet <b>' + escapeHtml_(d.name) + '</b> added. Set its starting balance in the ' +
      'Wallets tab (Opening Balance).');
  }
  stepWalletAdd_(p);
}

function startCategoryAdd_(chatId, args) {
  const words = String(args || '').trim().split(/\s+/).filter(String);
  const types = { expense: 'Expense', pengeluaran: 'Expense', income: 'Income', pemasukan: 'Income' };
  let type = null;
  if (words.length > 1 && types[words[words.length - 1].toLowerCase()]) type = types[words.pop().toLowerCase()];
  const name = words.join(' ').replace(/^#/, '');
  if (!name) return sendMessage(chatId, 'Write the name too, e.g. <code>/category add Pets</code>');
  if (name.length > 40 || /[#|,]/.test(name)) return sendMessage(chatId, 'Please use a short name without # | or commas.');
  if (loadCategories_(openMainSheet_()).some(function (c) { return c.name.toLowerCase() === name.toLowerCase(); })) {
    return sendMessage(chatId, 'A category called "' + escapeHtml_(name) + '" already exists. See /category.');
  }
  stepCategoryAdd_(newPending_(chatId, 'cadd', { name: name, type: type }));
}

function stepCategoryAdd_(p) {
  const title = '📂 New category <b>' + escapeHtml_(p.d.name) + '</b>';
  if (!p.d.type) {
    return showStep_(p, title + '\nIs it for expenses or income?',
      [[btn_(p, '🧾 Expense', 'ct', 'Expense'), btn_(p, '💵 Income', 'ct', 'Income')], cancelRow_(p)]);
  }
  showStep_(p, title + '\nType: ' + p.d.type + '\n\nSave?', [[btn_(p, '✅ Yes', 'y'), btn_(p, '❌ No', 'n')]]);
}

function categoryAddCallback_(p, action, arg) {
  if (action === 'n') return finishStep_(p, '❌ Cancelled. No category added.');
  if (action === 'ct') p.d.type = arg === 'Income' ? 'Income' : 'Expense';
  if (action === 'y') {
    if (!claimPending_(p)) return;
    try {
      addCategory_(openMainSheet_(), p.d.name, p.d.type);
    } catch (err) {
      return finishStep_(p, '❌ ' + escapeHtml_(err.message));
    }
    return finishStep_(p, '✅ Category <b>' + escapeHtml_(p.d.name) + '</b> added. Add keywords for it in the ' +
      'Categories tab (Keywords column), or tag it: <code>#' + escapeHtml_(p.d.name.replace(/\s+/g, '')) + '</code>.');
  }
  stepCategoryAdd_(p);
}

// ---------------------------------------------------------------------------
// Button router
// ---------------------------------------------------------------------------

function handleCallback_(cq) {
  const chatId = String(cq.message.chat.id);
  const parts = String(cq.data || '').split('|');
  const p = getPending_(chatId);
  if (!p || p.pid !== parts[0]) {
    answerCallbackQuery(cq.id, 'This has expired. Please send it again.');
    dropButtons_(chatId, cq.message.message_id);
    return;
  }
  answerCallbackQuery(cq.id);
  p.msgId = cq.message.message_id;
  const action = parts[1];
  const arg = parts[2];
  if (p.kind === 'trx') trxCallback_(p, action, arg, getUserByChatId_(chatId));
  else if (p.kind === 'kw') kwCallback_(p, action, arg);
  else if (p.kind === 'undo') undoCallback_(p, action);
  else if (p.kind === 'wadd') walletAddCallback_(p, action, arg);
  else if (p.kind === 'cadd') categoryAddCallback_(p, action, arg);
  else if (p.kind === 'adj') adjustCallback_(p, action, arg, getUserByChatId_(chatId));
}

/** Friendly reply for a message the parser couldn't use. */
function parseErrorText_(r) {
  const list = function (a) { return escapeHtml_((a || []).join(', ')); };
  switch (r.error) {
    case 'no_amount':
      return "I couldn't find an amount. Examples:\n" +
        '• <code>50rb makan siang BCA</code>\n• <code>+5jt gaji BCA</code>\n• <code>transfer 1jt BCA ke GoPay</code>\n' +
        'Type /help for more.';
    case 'multiple_amounts':
      return 'I found more than one amount (' + list(r.amounts) + '). Please send one transaction per message.';
    case 'invalid_date':
      return 'The date "' + escapeHtml_(r.text) + '" doesn\'t exist. Use e.g. <code>20/09</code> or <code>kemarin</code>.';
    case 'multiple_dates':
      return 'I found more than one date. Please use just one.';
    case 'two_wallets':
      return 'I found two wallets (' + list(r.wallets) + '). For a transfer write: <code>transfer 1jt BCA ke GoPay</code>.';
    case 'too_many_wallets':
      return 'I found more than two wallets (' + list(r.wallets) + '). A transfer goes from one wallet to one other.';
    case 'same_wallet':
      return 'From and To are both ' + escapeHtml_(r.wallet) + '. A transfer needs two different wallets.';
    case 'investment_wallet':
      return escapeHtml_(r.wallet) + ' is an investment wallet. Investment purchases arrive in a later update.';
    case 'transfer_two_extras':
      return 'A transfer can have one extra part: a fee, a received amount, or money spent. Please send the ' +
        'others separately, e.g.\n• <code>transfer 1jt BCA ke GoPay admin 2.5rb</code>\n• <code>20rb makan GoPay</code>';
    case 'extra_unclear':
      return "I couldn't read the fee / spent amount. Write it like <code>admin 2.5rb</code> or " +
        '<code>200rb untuk makan</code>.';
    default:
      return "Sorry, I couldn't understand that. Type /help for examples.";
  }
}
