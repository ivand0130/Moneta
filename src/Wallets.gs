/**
 * Wallets.gs — wallets and wallet groups read from the Wallets tab, the
 * /saldo balance view, /wallet and /wallet add.
 *
 * Balances come from the sheet's Current Balance formula column, so edits
 * made directly in the sheet are always reflected.
 */

/** Loads wallets: [{name, group, type, balance, owner, active, row}] */
function loadWallets_(ss) {
  return readTableByHeaders_(ss.getSheetByName(TAB.WALLETS), 'Wallet').map(function (r) {
    return {
      name: String(r['wallet']).trim(),
      // Several groups are allowed, comma-separated ("Spending, Investment Wallet"); the first one is the
      // wallet's home group (where /saldo lists it), groups holds all of them.
      group: splitGroups_(r['wallet group'])[0] || '',
      groups: splitGroups_(r['wallet group']),
      type: walletKind_(r['wallet type']) ? 'Investment' : 'Cash',
      kind: walletKind_(r['wallet type']), // Emas / Saham / Others ('' for cash)
      // The category every investment in this wallet gets (Settings → Investment Categories); empty → the wallet's name.
      invCategory: walletKind_(r['wallet type']) ? (String(r['investment category'] || '').trim() || String(r['wallet']).trim()) : '',
      // Several categories are allowed, comma-separated ("Saham, Crypto"): a buy into this wallet then asks which.
      invCategories: walletKind_(r['wallet type']) ? splitGroups_(String(r['investment category'] || '').trim() || String(r['wallet']).trim()) : [],
      balance: Number(r['current balance']) || 0,
      owner: String(r['owner'] || '').trim(),
      active: String(r['active'] || '').trim().toLowerCase() !== 'no',
      defaultFee: parseBudget_(r['default transfer fee']), // same "whole Rupiah, 0 if empty" rule
      receiptIssuer: String(r['receipt issuer'] || '').trim(), // "GoPay": receipts from that app suggest this wallet
      row: r._row
    };
  });
}

/** "Spending, Investment Wallet" → ['Spending', 'Investment Wallet']. */
function splitGroups_(value) {
  return String(value || '').split(',').map(function (g) { return g.trim(); }).filter(String);
}

/** The investment categories of an investment wallet (["Saham", "Crypto"]); its name when none is set. */
function walletCategories_(w) {
  if (!w) return [];
  if (w.invCategories && w.invCategories.length) return w.invCategories;
  return splitGroups_(w.invCategory || w.name);
}

/** All groups of a wallet (works for wallets built without .groups, e.g. in tests). */
function walletGroups_(w) {
  return w.groups || splitGroups_(w.group);
}

/** Wallet Type → investment kind: 'Emas' / 'Saham' / 'Others' (also the old "Investment"), or '' for cash. */
function walletKind_(type) {
  const t = String(type || '').trim().toLowerCase();
  if (/^(emas|gold)$/.test(t)) return 'Emas';
  if (/^(saham|stock|stocks)$/.test(t)) return 'Saham';
  if (/^(others?|lainnya|investment|investasi)$/.test(t)) return 'Others';
  return '';
}

/** Finds a wallet by name (case-insensitive), or null. */
function findWallet_(wallets, name) {
  if (!name) return null;
  return wallets.filter(function (w) { return w.name.toLowerCase() === String(name).toLowerCase(); })[0] || null;
}

/** Active cash wallets: the ones you can transfer between (incl. e.g. IPOT cash). */
function cashWallets_(wallets) {
  return wallets.filter(function (w) { return w.active && w.type === 'Cash'; });
}

/**
 * An investment wallet: Wallet Type = Investment (Saham, Emas…), or its
 * group is listed in the "Investment Wallet Groups" setting (e.g. IPOT).
 * investmentGroups is a lowercase list.
 */
function isInvestmentWallet_(w, investmentGroups) {
  if (w.type === 'Investment') return true;
  // Any of its groups being an investment group (e.g. IPOT in "Investment") keeps it out of expenses/income.
  // The "Investment Wallet" group (allowed to pay for investments) is not one, so "Spending, Investment Wallet" still spends.
  return walletGroups_(w).some(function (g) { return (investmentGroups || []).indexOf(g.toLowerCase()) !== -1; });
}

/** Wallets usable for expenses and income: active cash wallets that aren't investment wallets. */
function everydayWallets_(wallets, investmentGroups) {
  return cashWallets_(wallets).filter(function (w) { return !isInvestmentWallet_(w, investmentGroups); });
}

/** Wallets offered as buttons for an expense: everyday wallets in the "Spending Wallet Groups". */
function spendingWallets_(wallets, investmentGroups, spendingGroups) {
  return everydayWallets_(wallets, investmentGroups).filter(function (w) {
    return walletGroups_(w).some(function (g) { return spendingGroups.indexOf(g.toLowerCase()) !== -1; });
  });
}

/**
 * /saldo text. filter (optional, any case):
 *   ''          → all wallets except investment wallets
 *   'all'       → everything
 *   wallet name → that wallet; otherwise a wallet group or an owner name
 * Every amount goes through money_() (the spoiler helper).
 * Returns { text } or { error } if the filter matches nothing.
 */
function buildSaldoText_(wallets, filter, investmentGroups) {
  let list = wallets.filter(function (w) { return w.active; });
  const f = String(filter || '').trim().toLowerCase();
  const hidingInvestments = f === '';
  if (hidingInvestments) {
    list = list.filter(function (w) { return !isInvestmentWallet_(w, investmentGroups); });
  } else if (f !== 'all' && f !== 'semua') {
    const by = function (field) { return list.filter(function (w) { return w[field].toLowerCase() === f; }); };
    // Wallet name, or the part before brackets ("/saldo ipot" → IPOT (Saham); "ajaib kripto" → both Ajaib wallets)
    let byName = by('name');
    if (byName.length === 0) {
      byName = list.filter(function (w) { return w.name.replace(/\s*\([^)]*\)\s*$/, '').toLowerCase() === f; });
    }
    const byGroup = list.filter(function (w) { return walletGroups_(w).some(function (g) { return g.toLowerCase() === f; }); });
    list = byName.length ? byName : (byGroup.length ? byGroup : by('owner'));
    if (list.length === 0) {
      const active = wallets.filter(function (w) { return w.active; });
      const names = function (field) { return escapeHtml_(unique_(active.map(function (w) { return w[field]; })).join(', ')); };
      return { error: 'No wallet, group or owner called "' + escapeHtml_(filter) + '".\nWallets: ' + names('name') +
        '\nGroups: ' + escapeHtml_(unique_([].concat.apply([], active.map(walletGroups_))).join(', ')) + '\nOwners: ' + names('owner') + '\nOr use <code>/saldo all</code>.' };
    }
  }

  const lines = ['💰 <b>Balances</b>' + (f ? ' — ' + escapeHtml_(filter) : '')];
  let total = 0;
  const cash = list.filter(function (w) { return w.type === 'Cash'; });
  unique_(cash.map(function (w) { return w.group; }), true).forEach(function (group) {
    const inGroup = cash.filter(function (w) { return w.group === group; });
    const subtotal = inGroup.reduce(function (s, w) { return s + w.balance; }, 0);
    total += subtotal;
    lines.push('', '<b>' + escapeHtml_(group || 'No group') + '</b>');
    inGroup.forEach(function (w) {
      lines.push('• ' + escapeHtml_(w.name) + (w.owner ? ' <i>(' + escapeHtml_(w.owner) + ')</i>' : '') + ': ' + money_(w.balance));
    });
    lines.push('Subtotal: ' + money_(subtotal));
  });

  const invest = list.filter(function (w) { return w.type === 'Investment'; });
  if (invest.length) {
    const subtotal = invest.reduce(function (s, w) { return s + w.balance; }, 0);
    total += subtotal;
    lines.push('', '<b>Investments</b> <i>(current value)</i>');
    invest.forEach(function (w) { lines.push('• ' + escapeHtml_(w.name) + ': ' + money_(w.balance)); });
    lines.push('Subtotal: ' + money_(subtotal));
  }

  lines.push('', '<b>Total: </b>' + money_(total));
  if (hidingInvestments) lines.push('<i>Investments not included. Use /saldo all to see everything.</i>');
  return { text: lines.join('\n') };
}

/** /wallet → list grouped by wallet group, no balances. */
function buildWalletListText_(wallets) {
  const lines = ['👛 <b>Wallets</b>'];
  unique_(wallets.map(function (w) { return w.group; }), true).forEach(function (group) {
    lines.push('', '<b>' + escapeHtml_(group || 'No group') + '</b>');
    wallets.filter(function (w) { return w.group === group; }).forEach(function (w) {
      lines.push('• ' + escapeHtml_(w.name) + ' — ' + (w.kind || w.type) + (w.owner ? ', ' + escapeHtml_(w.owner) : '') +
        (walletGroups_(w).length > 1 ? ' <i>(also ' + escapeHtml_(walletGroups_(w).slice(1).join(', ')) + ')</i>' : '') +
        (w.active ? '' : ' <i>(inactive)</i>'));
    });
  });
  lines.push('', 'Balances: /saldo. Add one: <code>/wallet add Jenius</code>.');
  return lines.join('\n');
}

/**
 * Adds a wallet row (opening balance 0). An Investment wallet also gets an
 * Investment category of the same name, since they belong together.
 */
function addWallet_(ss, w) {
  withScriptLock_(function () {
    if (findWallet_(loadWallets_(ss), w.name)) throw new Error('Wallet "' + w.name + '" already exists.');
    const row = { 'Wallet': w.name, 'Wallet Group': w.group, 'Wallet Type': w.type, 'Opening Balance': 0, 'Owner': w.owner, 'Active': 'Yes' };
    if (walletKind_(w.type) && w.invCategory) row['Investment Category'] = w.invCategory;
    appendRowByHeaders_(ss, TAB.WALLETS, favKnownColumns_(ss.getSheetByName(TAB.WALLETS), row).values);
    // The category also gets an Investment row in Categories (Transactions use it for reporting).
    const have = loadCategories_(ss);
    (walletKind_(w.type) ? splitGroups_(w.invCategory || w.name) : []).forEach(function (cat) {
      if (!have.some(function (c) { return c.name.toLowerCase() === cat.toLowerCase(); })) {
        appendRowByHeaders_(ss, TAB.CATEGORIES, { 'Category': cat, 'Type': 'Investment' });
      }
    });
  });
}

/** Unique values in first-seen order (blanks dropped unless keepEmpty). */
function unique_(values, keepEmpty) {
  const out = [];
  values.forEach(function (v) { if ((keepEmpty || v !== '') && out.indexOf(v) === -1) out.push(v); });
  return out;
}

// ---------------------------------------------------------------------------
// /adjust [wallet] [actual balance] (SPEC Section 6)
// ---------------------------------------------------------------------------
// Password first if "Password for /adjust" = Yes. Amounts are hidden with the
// spoiler helper. With "Adjust auto-delete" = Yes the bot's /adjust message is
// deleted 60s after the flow ends, or when an unanswered preview expires.

function startAdjust_(chatId, args, cmdId) {
  if (!String(args || '').trim()) {
    sendMessage(chatId, 'Write the wallet and its actual balance, e.g. <code>/adjust BCA 10.200.000</code>');
    return;
  }
  loadSettingsTab_(true); // fresh, so the switches apply right away
  if (getSettingYes_(SETTING.ADJUST_PASSWORD)) {
    askPassword_(chatId, 'adjust', { filter: args, cmdId: cmdId }, '🔒 Enter the password to adjust a balance.\n' +
      '<i>You can turn this off in Settings → Password for /adjust.</i>');
    return;
  }
  beginAdjust_(chatId, args, cmdId);
}

/** After the password (if any): parse and start the adjust flow. cmdId = your /adjust message. */
function beginAdjust_(chatId, args, cmdId) {
  const ss = openMainSheet_();
  const r = parseAdjust_(args, { wallets: loadWallets_(ss), now: new Date() });
  if (!r.ok) {
    sendMessage(chatId, adjustErrorText_(r));
    // The command may contain a balance: it disappears too.
    if (cmdId && getSettingYes_(SETTING.ADJUST_AUTO_DELETE)) scheduleDelete_(chatId, cmdId, ADJUST_DELETE_SECONDS);
    return;
  }
  const p = newPending_(chatId, 'adj', {
    wallet: r.wallet, walletChoices: r.walletChoices, actual: r.actual, amountOptions: r.amountOptions,
    amountText: r.amountText, date: r.date.getTime(), dateNeedsConfirm: r.dateNeedsConfirm, dateText: r.dateText,
    note: r.note, cmdId: cmdId || null
  });
  stepAdjust_(p);
}

function stepAdjust_(p, notice) {
  const d = p.d;
  const ss = openMainSheet_();
  if (d.amountOptions) {
    const rows = chunk_(d.amountOptions.map(function (v, i) { return btn_(p, formatRp_(v), 'aam', i); }), 2);
    rows.push(cancelRow_(p));
    return showAdjustStep_(p, '🤔 Which balance did you mean by "' + escapeHtml_(d.amountText) + '"?', rows);
  }
  if (d.dateNeedsConfirm) {
    const label = formatDate_(d.date);
    return showAdjustStep_(p, '📅 I read "' + escapeHtml_(d.dateText) + '" as <b>' + label + '</b>. Is that right?',
      [[btn_(p, '✅ ' + label, 'dok'), btn_(p, '📅 Today', 'today')], cancelRow_(p)]);
  }
  const wallets = cashWallets_(loadWallets_(ss));
  const w = findWallet_(wallets, d.wallet);
  if (!w) {
    const list = d.walletChoices ? d.walletChoices : wallets.map(function (x) { return x.name; });
    p.opts = list;
    const rows = chunk_(list.map(function (n, i) { return btn_(p, n, 'aw', i); }), 3);
    rows.push(cancelRow_(p));
    return showAdjustStep_(p, '⚖️ Which wallet?', rows);
  }
  if (isMonthClosed_(ss, d.date)) {
    const month = Utilities.formatDate(new Date(d.date), Session.getScriptTimeZone(), 'MMMM yyyy');
    return showAdjustStep_(p, '⛔ ' + month + " is closed, so entries can't be dated in it. Use today's date?",
      [[btn_(p, '📅 Use today', 'today'), btn_(p, '❌ Cancel', 'n')]]);
  }
  d.recorded = w.balance;
  d.diff = d.actual - w.balance;
  if (d.diff === 0) {
    return finishAdjust_(p, '✅ ' + escapeHtml_(w.name) + ' already matches: ' + money_(w.balance) + '. Nothing to save.');
  }
  showAdjustStep_(p, (notice ? '⚠️ ' + notice + '\n\n' : '') +
    '⚖️ <b>Adjust balance · ' + escapeHtml_(w.name) + '</b>\n' +
    'Recorded: ' + money_(d.recorded) + '\nActual: ' + money_(d.actual) + '\n' +
    'Adjustment: ' + spoiler_(formatRpSigned_(d.diff)) + (d.diff > 0 ? ' (money in)' : ' (money out)') + '\n' +
    '📅 ' + formatDate_(d.date) + (d.note ? '\n📝 ' + escapeHtml_(d.note) : '') +
    '\n<i>Adjustments never count as income or expense.</i>\n\nSave?',
    [[btn_(p, '✅ Yes', 'y'), btn_(p, '❌ No', 'n')]]);
}

/**
 * Shows a step; the first time, queues the bot message AND your /adjust
 * command to vanish when the pending item expires (if never answered).
 */
function showAdjustStep_(p, text, rows) {
  const isNew = !p.msgId;
  showStep_(p, text, rows);
  if (isNew && getSettingYes_(SETTING.ADJUST_AUTO_DELETE)) {
    scheduleDelete_(p.chatId, p.msgId, PENDING_TTL_SECONDS);
    if (p.d.cmdId) scheduleDelete_(p.chatId, p.d.cmdId, PENDING_TTL_SECONDS);
  }
}

/** Ends the flow and (if Adjust auto-delete = Yes) deletes the bot message and your command 60s later. */
function finishAdjust_(p, text) {
  const autoDelete = getSettingYes_(SETTING.ADJUST_AUTO_DELETE);
  finishStep_(p, text + (autoDelete ? '\n\n🕒 <i>This message will be deleted in ' +
    formatDelay_(ADJUST_DELETE_SECONDS) + '.</i>' : ''));
  if (autoDelete && p.msgId) scheduleDelete_(p.chatId, p.msgId, ADJUST_DELETE_SECONDS);
  if (autoDelete && p.d.cmdId) scheduleDelete_(p.chatId, p.d.cmdId, ADJUST_DELETE_SECONDS); // your /adjust message too
}

function adjustCallback_(p, action, arg, user) {
  const d = p.d;
  if (action === 'n') return finishAdjust_(p, '❌ Cancelled. Nothing was saved.');
  if (action === 'aam') { d.actual = d.amountOptions[Number(arg)]; d.amountOptions = null; }
  if (action === 'dok') d.dateNeedsConfirm = false;
  if (action === 'today') { d.date = Date.now(); d.dateNeedsConfirm = false; }
  if (action === 'aw') { d.wallet = p.opts[Number(arg)]; d.walletChoices = null; }
  if (action === 'y') {
    const ss = openMainSheet_();
    // Someone may have logged something since the preview: recompute before saving.
    const w = findWallet_(loadWallets_(ss), d.wallet);
    if (!w || w.balance !== d.recorded) {
      return stepAdjust_(p, 'The recorded balance changed since the preview. Please check again.');
    }
    if (!claimPending_(p)) return;
    const loggedBy = user && user.name ? user.name : p.chatId;
    const id = withScriptLock_(function () { return writeAdjustment_(ss, d, loggedBy); });
    return finishAdjust_(p, '✅ Saved as <b>' + id + '</b>: ' + escapeHtml_(d.wallet) + ' adjusted by ' +
      spoiler_(formatRpSigned_(d.diff)) + '.');
  }
  stepAdjust_(p);
}

function adjustErrorText_(r) {
  switch (r.error) {
    case 'adjust_no_wallet':
      return 'Which wallet? Write its name, e.g. <code>/adjust BCA 10.200.000</code>. See /wallet for names.';
    case 'adjust_investment':
      return escapeHtml_(r.wallet) + ' is an investment wallet: its value comes from the Investments tab ' +
        '(price updates arrive in a later update), so it can\'t be adjusted here.';
    case 'no_amount':
      return 'What is the actual balance? E.g. <code>/adjust BCA 10.200.000</code> (0 and -50.000 are fine too).';
    case 'multiple_amounts':
      return 'I found more than one amount (' + escapeHtml_((r.amounts || []).join(', ')) + '). Send just the actual balance.';
    case 'two_wallets':
      return 'Adjust one wallet at a time (I found ' + escapeHtml_((r.wallets || []).join(', ')) + ').';
    default:
      return parseErrorText_(r);
  }
}
