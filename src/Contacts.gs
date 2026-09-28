/**
 * Contacts.gs — contacts and aliases read from the Contacts tab, name
 * matching in messages, /contact and /contact add.
 *
 * A contact is { name, aliases: [] }. Aliases are comma-separated in the
 * sheet (e.g. "Budi Santoso, budi s") and are also where GoPay display names
 * go. Matching is case-insensitive, whole words, longest name first.
 */

function loadContacts_(ss) {
  return readTableByHeaders_(ss.getSheetByName(TAB.CONTACTS), 'Name').map(function (r) {
    return {
      name: String(r['name']).trim(),
      aliases: String(r['aliases'] || '').split(',').map(function (a) { return a.trim(); }).filter(String),
      row: r._row
    };
  });
}

/** The contact whose name or alias equals `text` (any case), or null. */
function findContact_(contacts, text) {
  const t = String(text || '').trim().toLowerCase();
  if (t === '') return null;
  return contacts.filter(function (c) {
    return c.name.toLowerCase() === t || c.aliases.some(function (a) { return a.toLowerCase() === t; });
  })[0] || null;
}

/**
 * Finds contact names/aliases in tokens (whole words, multi-word names too)
 * and marks them used. Returns [{ name (the contact's name), text, index }]
 * in message order.
 */
function extractContacts_(tokens, contacts) {
  const entries = [];
  contacts.forEach(function (c) {
    [c.name].concat(c.aliases).forEach(function (label) {
      const words = label.toLowerCase().split(/\s+/).filter(String);
      if (words.length) entries.push({ name: c.name, words: words });
    });
  });
  entries.sort(function (a, b) { return b.words.length - a.words.length || b.words.join(' ').length - a.words.join(' ').length; });
  const found = [];
  entries.forEach(function (e) {
    for (let i = 0; i + e.words.length <= tokens.length; i++) {
      let match = true;
      for (let k = 0; k < e.words.length; k++) {
        const t = tokens[i + k];
        if (t.used || t.clean !== e.words[k]) { match = false; break; }
      }
      if (!match) continue;
      const text = tokens.slice(i, i + e.words.length).map(function (t) { return t.raw; }).join(' ');
      for (let k = 0; k < e.words.length; k++) tokens[i + k].used = true;
      found.push({ name: e.name, text: text, index: i });
    }
  });
  return found.sort(function (a, b) { return a.index - b.index; });
}

/** Adds a contact row (used when a new name is confirmed in a debt preview, and by /contact add). */
function addContact_(ss, name, aliases) {
  withScriptLock_(function () {
    if (findContact_(loadContacts_(ss), name)) return; // already there (e.g. added a moment ago)
    appendRowByHeaders_(ss, TAB.CONTACTS, { 'Name': name, 'Aliases': (aliases || []).join(', ') });
  });
}

/** /contact → names and aliases. */
function buildContactListText_(contacts) {
  if (contacts.length === 0) {
    return '👥 No contacts yet. They are added when you save a hutang/piutang with a new name, or with ' +
      '<code>/contact add Budi Santoso, budi s</code>.';
  }
  const lines = ['👥 <b>Contacts</b>'];
  contacts.forEach(function (c) {
    lines.push('• ' + escapeHtml_(c.name) + (c.aliases.length ? ' <i>(' + escapeHtml_(c.aliases.join(', ')) + ')</i>' : ''));
  });
  lines.push('', 'Add one: <code>/contact add Budi, Budi Santoso</code> (name first, then aliases such as GoPay names).',
    'Aliases can also be edited in the Contacts tab.');
  return lines.join('\n');
}

/** /contact add Name[, alias, alias] → preview → save. */
function startContactAdd_(chatId, args) {
  const parts = String(args || '').split(',').map(function (s) { return s.trim(); }).filter(String);
  if (parts.length === 0) return sendMessage(chatId, 'Write the name too, e.g. <code>/contact add Budi, Budi Santoso</code>');
  if (parts.some(function (s) { return s.length > 40 || /[#|]/.test(s); })) {
    return sendMessage(chatId, 'Please use short names without # or |.');
  }
  const ss = openMainSheet_();
  const contacts = loadContacts_(ss);
  const taken = parts.filter(function (s) { return findContact_(contacts, s); });
  if (taken.length) {
    return sendMessage(chatId, '"' + escapeHtml_(taken.join('", "')) + '" is already used by a contact. See /contact.');
  }
  const p = newPending_(chatId, 'contact', { name: parts[0], aliases: parts.slice(1) });
  showStep_(p, '👥 New contact <b>' + escapeHtml_(parts[0]) + '</b>' +
    (parts.length > 1 ? '\nAliases: ' + escapeHtml_(parts.slice(1).join(', ')) : '') + '\n\nSave?',
    [[btn_(p, '✅ Yes', 'y'), btn_(p, '❌ No', 'n')]]);
}

function contactCallback_(p, action) {
  if (action !== 'y') return finishStep_(p, '❌ Cancelled. No contact added.');
  if (!claimPending_(p)) return;
  addContact_(openMainSheet_(), p.d.name, p.d.aliases);
  finishStep_(p, '✅ Contact <b>' + escapeHtml_(p.d.name) + '</b> added.');
}
