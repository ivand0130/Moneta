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
      group: String(r['wallet group'] || '').trim(),
      type: /^investment$/i.test(String(r['wallet type']).trim()) ? 'Investment' : 'Cash',
      balance: Number(r['current balance']) || 0,
      owner: String(r['owner'] || '').trim(),
      active: String(r['active'] || '').trim().toLowerCase() !== 'no',
      row: r._row
    };
  });
}

/** Finds a wallet by name (case-insensitive), or null. */
function findWallet_(wallets, name) {
  if (!name) return null;
  return wallets.filter(function (w) { return w.name.toLowerCase() === String(name).toLowerCase(); })[0] || null;
}

/** Active cash wallets (the ones you can spend from / transfer between). */
function cashWallets_(wallets) {
  return wallets.filter(function (w) { return w.active && w.type === 'Cash'; });
}

/**
 * /saldo text. filter (optional) matches a wallet group or an owner name.
 * Every amount goes through money_() (the spoiler helper).
 * Returns { text } or { error } if the filter matches nothing.
 */
function buildSaldoText_(wallets, filter) {
  let list = wallets.filter(function (w) { return w.active; });
  const f = String(filter || '').trim().toLowerCase();
  if (f !== '') {
    list = list.filter(function (w) { return w.group.toLowerCase() === f || w.owner.toLowerCase() === f; });
    if (list.length === 0) {
      const groups = unique_(wallets.map(function (w) { return w.group; }));
      const owners = unique_(wallets.map(function (w) { return w.owner; }));
      return { error: 'No wallets match "' + escapeHtml_(filter) + '".\nGroups: ' + escapeHtml_(groups.join(', ')) +
        '\nOwners: ' + escapeHtml_(owners.join(', ')) };
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
  return { text: lines.join('\n') };
}

/** /wallet → list grouped by wallet group, no balances. */
function buildWalletListText_(wallets) {
  const lines = ['👛 <b>Wallets</b>'];
  unique_(wallets.map(function (w) { return w.group; }), true).forEach(function (group) {
    lines.push('', '<b>' + escapeHtml_(group || 'No group') + '</b>');
    wallets.filter(function (w) { return w.group === group; }).forEach(function (w) {
      lines.push('• ' + escapeHtml_(w.name) + ' — ' + w.type + (w.owner ? ', ' + escapeHtml_(w.owner) : '') +
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
    appendRowByHeaders_(ss, TAB.WALLETS, {
      'Wallet': w.name, 'Wallet Group': w.group, 'Wallet Type': w.type,
      'Opening Balance': 0, 'Owner': w.owner, 'Active': 'Yes'
    });
    if (w.type === 'Investment' &&
        !loadCategories_(ss).some(function (c) { return c.name.toLowerCase() === w.name.toLowerCase(); })) {
      appendRowByHeaders_(ss, TAB.CATEGORIES, { 'Category': w.name, 'Type': 'Investment' });
    }
  });
}

/** Unique values in first-seen order (blanks dropped unless keepEmpty). */
function unique_(values, keepEmpty) {
  const out = [];
  values.forEach(function (v) { if ((keepEmpty || v !== '') && out.indexOf(v) === -1) out.push(v); });
  return out;
}
