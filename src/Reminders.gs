/**
 * Reminders.gs — the single hourly dispatcher trigger (SPEC Section 15).
 *
 * runReminders() runs every hour. Each reminder slot has a time from Settings
 * and runs once per day: at the first run at or after its hour (a missed run
 * catches up later that day). The day it last ran is kept in the
 * REMINDER_STATE Script Property, written BEFORE the slot runs, so a slot is
 * never sent twice (a failure is logged to the Logs tab instead).
 *
 * Morning slot (Daily Reminder Time, 08:00): ONE message per person with
 *   - favorites due (Favorites.gs)
 *   - hutang/piutang: Monday = weekly summary (every open record), the 1st =
 *     monthly (long-term and groups), both on a Monday the 1st = merged, other
 *     days = short-term records with a due date that is near or overdue
 * Exactly one item keeps its buttons ([Yes] [Change amount] [Skip] or
 * [Snooze]); two or more are a plain list (log favorites with /fav or by
 * typing). Each person gets the morning message at most once a day.
 * Debt reminders go to whoever logged the record (Transactions → Logged By);
 * records with no known owner go to every user.
 *
 * Only TWO time triggers exist: this one (installReminderTrigger) and the
 * 1-minute message cleanup (installCleanupTrigger).
 */

/**
 * The reminder slots. Later phases add the last-day slots here:
 *   Phase 8 — start closing (Closing Reminder Time, last day of the month)
 * A slot: { key, timeSetting, when(now) → bool (optional), run(now) }. (A function, not a
 * top-level const, because Config.gs may load after this file.)
 */
function reminderSlots_() {
  return [
    { key: 'morning', timeSetting: SETTING.DAILY_REMINDER_TIME, run: runMorningReminders_ },
    { key: 'price', timeSetting: SETTING.PRICE_REMINDER_TIME, when: isLastDayOfMonth_, run: runPriceReminder_ }
  ];
}

/** The hourly trigger's function. Returns immediately when no slot is due. */
function runReminders() {
  try {
    const now = new Date();
    const today = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const state = readReminderState_();
    const due = reminderSlots_().filter(function (slot) {
      return state[slot.key] !== today && (!slot.when || slot.when(now));
    });
    if (due.length === 0) return;
    loadSettingsTab_(true); // reminder times / days changed in Settings apply right away
    due.forEach(function (slot) {
      if (now.getHours() < parseHour_(getSetting_(slot.timeSetting))) return;
      markReminderState_(slot.key, today);
      try {
        slot.run(now);
      } catch (err) {
        logError_('runReminders: ' + slot.key, err);
      }
    });
  } catch (err) {
    logError_('runReminders', err);
  }
}

function readReminderState_() {
  try {
    return JSON.parse(getProp_(PROP.REMINDER_STATE) || '{}');
  } catch (err) {
    return {};
  }
}

/** Sets one key of REMINDER_STATE (re-read first, so other keys are kept). */
function markReminderState_(key, value) {
  const state = readReminderState_();
  state[key] = value;
  PropertiesService.getScriptProperties().setProperty(PROP.REMINDER_STATE, JSON.stringify(state));
}

/** "08:00" / "8" / "8.30" → 8. Unreadable → 8. */
function parseHour_(text) {
  const m = String(text || '').match(/^\s*(\d{1,2})/);
  const h = m ? Number(m[1]) : 8;
  return h >= 0 && h <= 23 ? h : 8;
}

/**
 * The morning message, one per person. force = send even if this person
 * already got today's (sendRemindersNow); otherwise at most once a day.
 */
function runMorningReminders_(now, force) {
  const ss = openMainSheet_();
  if (ss === null) return;
  let debtParts = {};
  let favParts = {};
  try {
    debtParts = debtPartsByChat_(now);
  } catch (err) {
    logError_('debtPartsByChat_', err);
  }
  try {
    favParts = dueFavoritesByChat_(now);
  } catch (err) {
    logError_('dueFavoritesByChat_', err);
  }
  const today = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const prompts = readFavPrompts_();
  const reminded = {};
  uniqueChatIds_((getUsers_() || []).filter(function (u) { return u.active; })).forEach(function (chatId) {
    if (!force && readReminderState_()['sent|' + chatId] === today) return;
    const favs = favParts[chatId] || [];
    const debt = debtParts[chatId] || null;
    const msg = buildMorningMessage_(favs, debt, now);
    if (!msg) return;
    try {
      const sent = sendMessage(chatId, msg.text, msg.markup ? { reply_markup: msg.markup } : {});
      markReminderState_('sent|' + chatId, today);
      // Older prompts for these favorites lose their buttons; a single prompt is remembered.
      favs.forEach(function (it) {
        const key = it.fav.id + '|' + chatId;
        if (prompts[key]) dropButtons_(chatId, prompts[key]);
        delete prompts[key];
      });
      if (msg.favButtons) prompts[favs[0].fav.id + '|' + chatId] = sent.message_id;
      if (debt) debt.ids.forEach(function (id) { reminded[id] = true; });
    } catch (err) {
      logError_('runMorningReminders_', err, chatId);
    }
  });
  writeFavPrompts_(prompts);
  const ids = Object.keys(reminded);
  if (ids.length === 0) return;
  const byId = {};
  ids.forEach(function (id) { byId[id] = midnight_(now); });
  withScriptLock_(function () { setColumnById_(ss.getSheetByName(TAB.DEBTS), 'Debt ID', 'Last Reminder', byId); });
}

/**
 * One person's morning message: { text, markup, favButtons } or null.
 * favs = [{ fav, occ }], debt = { kind: 'daily' | 'summary', text, ids } or null.
 * Exactly one item keeps its buttons; two or more = a plain list. Pure.
 */
function buildMorningMessage_(favs, debt, now) {
  const debtCount = debt ? debt.ids.length : 0;
  if (favs.length + debtCount === 0) return null;
  if (favs.length === 1 && debtCount === 0) {
    return { text: buildFavPromptText_(favs[0].fav, favs[0].occ, now), markup: favPromptButtons_(favs[0].fav, favs[0].occ),
      favButtons: true };
  }
  if (favs.length === 0 && debtCount === 1 && debt.kind === 'daily') {
    return { text: debt.text + '\n\n<i>💤 Snooze skips it tomorrow. /open shows everything.</i>',
      markup: keyboard_([[['💤 Snooze ' + debt.ids[0], 'S|' + debt.ids[0]]]]) };
  }
  const parts = [];
  if (favs.length) parts.push(buildFavListText_(favs, now));
  if (debt) parts.push(debt.text);
  return { text: parts.join('\n\n') };
}

// ---------------------------------------------------------------------------
// Which debt reminders, for which records (pure; tested by testReminders)
// ---------------------------------------------------------------------------

/** { daily, weekly, monthly } for this day. Weekly / monthly days replace the daily one. */
function reminderPlan_(now, weeklyDay, monthlyDate) {
  const wd = WEEKDAYS[String(weeklyDay || '').trim().toLowerCase()];
  const weekday = wd === undefined ? 1 : wd;
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const date = Math.min(Math.max(Number(monthlyDate) || 1, 1), last); // 31 → last day of shorter months
  const weekly = now.getDay() === weekday;
  const monthly = now.getDate() === date;
  return { daily: !weekly && !monthly, weekly: weekly, monthly: monthly };
}

function daysBetween_(from, to) {
  return Math.round((midnight_(to) - midnight_(from)) / 86400000);
}

/** A group parent (has sub-records) or a sub-record. */
function isGroupDebt_(d, debts) {
  return !!d.parent || childrenOf_(debts, d.id).length > 0;
}

/**
 * True if an open short-term, non-group record belongs in today's daily
 * reminder: it has a due date within `beforeDays` (or overdue). Records
 * without a due date only appear in the weekly summary (owner's decision).
 * Snoozed until today or later = not today.
 */
function dailyDue_(d, debts, now, beforeDays) {
  if (!isOpenDebt_(d) || d.term === 'Long' || isGroupDebt_(d, debts) || !d.due) return false;
  if (d.snoozed && midnight_(d.snoozed) >= midnight_(now)) return false;
  return daysBetween_(now, d.due) <= beforeDays;
}

/** "due 3 Nov (in 2 days)" / "due 28 Oct · ⚠️ overdue 4 days" / "open 5 days" / "long-term, since 1 Sep 2026". */
function reminderTiming_(d, now) {
  if (d.due) {
    const n = daysBetween_(now, d.due);
    return 'due ' + formatDate_(d.due) + (n < 0 ? ' · ⚠️ overdue ' + (-n) + ' day' + (n === -1 ? '' : 's')
      : n === 0 ? ' (today)' : ' (in ' + n + ' day' + (n === 1 ? '' : 's') + ')');
  }
  const open = d.start ? daysBetween_(d.start, now) : null;
  const since = open === null ? '' : open <= 0 ? 'since today' : 'open ' + open + ' day' + (open === 1 ? '' : 's');
  return d.term === 'Long' ? 'long-term' + (since ? ' · ' + since : '') : since;
}

/** "• PTG-001 Budi · Piutang · Rp300.000 · open 5 days" (+ open sub-records of a group). */
function reminderLines_(d, debts, now, hide) {
  const timing = reminderTiming_(d, now);
  const lines = ['• <b>' + escapeHtml_(d.id) + '</b> ' + escapeHtml_(d.name) + ' · ' + d.type + ' · ' +
    money_(d.remaining, hide) + (timing ? ' · ' + timing : '')];
  childrenOf_(debts, d.id).filter(isOpenDebt_).forEach(function (k) {
    lines.push('   ◦ ' + escapeHtml_(k.id) + ' ' + escapeHtml_(k.name) + ' · ' + money_(k.remaining, hide));
  });
  return lines;
}

/**
 * The daily message for one person's records: { text, ids } or null.
 * mine = the records this person owns (top-level).
 */
function buildDailyReminder_(mine, debts, now, beforeDays, hide) {
  const items = mine.filter(function (d) { return dailyDue_(d, debts, now, beforeDays); });
  if (items.length === 0) return null;
  let lines = ['⏰ <b>Hutang / piutang due</b>'];
  items.forEach(function (d) { lines = lines.concat(reminderLines_(d, debts, now, hide)); });
  return { text: lines.join('\n'), ids: items.map(function (d) { return d.id; }) };
}

/**
 * Weekly summary (all open records), monthly reminder (long-term and group
 * records), or both merged into one message: { text, ids } or null.
 */
function buildSummaryReminder_(mine, debts, now, plan, hide) {
  const open = mine.filter(isOpenDebt_);
  const longOrGroup = open.filter(function (d) { return d.term === 'Long' || isGroupDebt_(d, debts); });
  const short = open.filter(function (d) { return longOrGroup.indexOf(d) === -1; });
  const shown = plan.weekly ? open : longOrGroup;
  if (shown.length === 0) return null;
  const title = plan.weekly && plan.monthly ? '📋 <b>Weekly + monthly summary</b>'
    : plan.weekly ? '📋 <b>Weekly summary</b>' : '🗓 <b>Monthly reminder</b> · long-term and group';
  let lines = [title + ' · ' + shown.length + ' open'];
  const total = function (type) {
    const list = shown.filter(function (d) { return d.type === type; });
    return list.length ? type + ' ' + money_(list.reduce(function (s, d) { return s + d.remaining; }, 0), hide) +
      (type === 'Piutang' ? ' (they owe you)' : ' (you owe)') : '';
  };
  lines.push([total('Piutang'), total('Hutang')].filter(String).join(' · '));
  if (plan.weekly && short.length) {
    lines.push('', '<b>Short-term</b>');
    short.forEach(function (d) { lines = lines.concat(reminderLines_(d, debts, now, hide)); });
  }
  if (longOrGroup.length) {
    lines.push('', '<b>Long-term and groups</b>');
    longOrGroup.forEach(function (d) { lines = lines.concat(reminderLines_(d, debts, now, hide)); });
  }
  return { text: lines.join('\n'), ids: shown.map(function (d) { return d.id; }) };
}

/**
 * Who logged each record: { 'PTG-001': 'Me', 'PTG-010': 'Partner' }, from the
 * first Transactions row carrying its Debt ID (a sub-record's row also
 * counts for its group, PTG-010-A → PTG-010).
 */
function debtOwners_(trxRows) {
  const owners = {};
  trxRows.forEach(function (r) {
    const id = String(r['debt id'] || '').trim().toUpperCase();
    const by = String(r['logged by'] || '').trim();
    if (id === '' || by === '') return;
    if (!owners[id]) owners[id] = by;
    const root = id.replace(/-[A-Z]+$/, '');
    if (!owners[root]) owners[root] = by;
  });
  return owners;
}

/**
 * Top-level records per chat: { chatId: [records] }. A record goes to the
 * user named in Logged By; with no matching user, to everyone.
 */
function debtsByRecipient_(debts, owners, users) {
  const active = users.filter(function (u) { return u.active; });
  const out = {};
  active.forEach(function (u) { out[u.chatId] = []; });
  debts.filter(function (d) { return !d.parent; }).forEach(function (d) {
    const by = String(owners[d.id.toUpperCase()] || '').toLowerCase();
    const owner = active.filter(function (u) { return String(u.name).toLowerCase() === by; })[0];
    uniqueChatIds_(owner ? [owner] : active).forEach(function (chatId) { out[chatId].push(d); });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** Each person's debt part of the morning message: { chatId: { kind, text, ids } }. */
function debtPartsByChat_(now) {
  const ss = openMainSheet_();
  const debts = loadDebts_(ss);
  if (!debts.some(isOpenDebt_)) return {};
  const plan = reminderPlan_(now, getSetting_(SETTING.WEEKLY_REMINDER_DAY), getSettingInt_(SETTING.MONTHLY_REMINDER_DATE));
  const beforeDays = getSettingInt_(SETTING.DEBT_DAYS_BEFORE_DUE);
  const hide = getSettingYes_(SETTING.HIDE_AMOUNTS);
  const perChat = debtsByRecipient_(debts, debtOwners_(loadTransactions_(ss)), getUsers_() || []);
  const out = {};
  Object.keys(perChat).forEach(function (chatId) {
    const m = plan.daily ? buildDailyReminder_(perChat[chatId], debts, now, beforeDays, hide)
      : buildSummaryReminder_(perChat[chatId], debts, now, plan, hide);
    if (m) out[chatId] = { kind: plan.daily ? 'daily' : 'summary', text: m.text, ids: m.ids };
  });
  return out;
}

/**
 * [💤 PTG-001] / [💤 Snooze all] on a daily reminder: sets Snoozed Until =
 * tomorrow (the record skips tomorrow's reminder) and removes the button(s).
 */
function snoozeCallback_(cq, parts) {
  const chatId = String(cq.message.chat.id);
  const keyboard = (cq.message.reply_markup && cq.message.reply_markup.inline_keyboard) || [];
  const all = [];
  keyboard.forEach(function (row) {
    row.forEach(function (b) {
      const m = String(b.callback_data || '').match(/^S\|(.+)$/);
      if (m && m[1] !== '*') all.push(m[1]);
    });
  });
  const ids = parts[1] === '*' ? all : [parts[1]];
  if (ids.length === 0) {
    answerCallbackQuery(cq.id, 'Nothing to snooze.');
    return;
  }
  const until = addDays_(new Date(), 1);
  const byId = {};
  ids.forEach(function (id) { byId[id] = until; });
  const ss = openMainSheet_();
  withScriptLock_(function () { setColumnById_(ss.getSheetByName(TAB.DEBTS), 'Debt ID', 'Snoozed Until', byId); });
  answerCallbackQuery(cq.id, '💤 ' + (parts[1] === '*' ? 'All snoozed' : ids[0] + ' snoozed') + ' — no reminder tomorrow (' +
    formatDate_(until) + ').');
  const left = all.filter(function (id) { return ids.indexOf(id) === -1; });
  const rows = chunk_(left.map(function (id) { return { text: '💤 ' + id, callback_data: 'S|' + id }; }), 3);
  if (left.length > 1) rows.push([{ text: '💤 Snooze all', callback_data: 'S|*' }]);
  try {
    tgCall_('editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: rows } });
  } catch (err) {
    console.warn('snoozeCallback_: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Setup helpers — run these from the editor
// ---------------------------------------------------------------------------

/**
 * Creates the hourly trigger for runReminders (replacing an older one), so
 * the project has exactly two time triggers: this and the message cleanup.
 */
function installReminderTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'runReminders'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runReminders').timeBased().everyHours(1).create();
  const all = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  console.log('PASS: reminder trigger installed. runReminders will run every hour.');
  console.log('Triggers in this project (' + all.length + '): ' + all.join(', ') +
    (all.length === 2 ? '  ✓ (reminders + cleanup)' : '  ← expected 2: runReminders and cleanupMessages'));
}

/**
 * Sends this morning's message right now (favorites + debts), even if it
 * already went out today. For testing. Marks the morning as done, so the
 * hourly trigger doesn't send it again today.
 */
function sendRemindersNow() {
  loadSettingsTab_(true);
  const now = new Date();
  console.log('Today: ' + JSON.stringify(reminderPlan_(now, getSetting_(SETTING.WEEKLY_REMINDER_DAY),
    getSettingInt_(SETTING.MONTHLY_REMINDER_DATE))));
  markReminderState_('morning', Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd')); // the trigger won't resend today
  runMorningReminders_(now, true);
  console.log('Done. Check Telegram (and the Logs tab if nothing arrived).');
}

/** Shows when each reminder slot last ran. */
function showReminderState() {
  console.log('Last run per slot: ' + JSON.stringify(readReminderState_()));
  console.log('Open favorite prompts: ' + JSON.stringify(readFavPrompts_()));
}
