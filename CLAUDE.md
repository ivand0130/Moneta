# CLAUDE.md — Personal Money Tracker Bot

This file is read automatically by Claude Code at the start of every session.
The full requirements are in SPEC.md. Progress is tracked in PROGRESS.md.

## Project summary
A Telegram bot for two users (me and my partner) to log money transactions.
Each user chats with the bot privately; both write to the SAME Google Sheet.
Backend: Google Apps Script (standalone project). Storage: Google Sheets +
Google Drive. AI: Gemini API free tier (Flash). Timezone: Asia/Jakarta.
Bot replies in English; user input may be English or Bahasa Indonesia.

## About me (the owner)
- I am a beginner. Explain what you are doing in plain language, and tell me
  exactly what to click or type when I need to do something myself.
- Ask me before anything I must do manually (deploying, authorizing, pasting
  secrets). Give numbered steps.
- Never ask me to paste secrets (bot token, Gemini key, password) into the
  chat. Tell me how to add them to Script Properties myself.

## How we work
- We build ONE phase at a time, following PHASES.md. Do not implement
  features from later phases, but design code so later phases fit in.
- At the start of each phase: read SPEC.md sections for that phase and
  PROGRESS.md, then show me a short plan and any questions before coding.
- SPEC.md Section 0 lists decisions that are final. Do not re-ask them.
- At the end of each phase:
  1. Push code with `clasp push`
  2. Tell me if I need to create a new deployment version, and how
  3. Give me a test checklist for this phase (what to type in Telegram and
     what the bot should reply)
  4. Update PROGRESS.md: what was built, known issues, next phase
- When I report a bug, reproduce the reasoning first, fix the smallest thing
  possible, and explain the cause in one or two sentences.

## Code structure (Apps Script, .gs files pushed via clasp)
- Main.gs: doPost webhook entry, update routing, dedupe, error wrapper
- Config.gs: Script Properties access, Settings tab loader, constants
- Telegram.gs: sendMessage, editMessage, inline keyboards, deleteMessage,
  getFile (for images)
- Parser.gs: amount parsing (50rb, 1.5jt, 2juta, 50.000, 50k), dates
  (kemarin, 20/09), wallet/category/name extraction, intent detection
- AI.gs: Gemini calls (parse, category suggestion, OCR) with timeout,
  JSON-only prompts, and graceful fallback
- Sheets.gs: open main sheet by ID, read/write helpers, header lookup by
  NAME (never by fixed column number), ID generators
- Confirm.gs: pending confirmations in CacheService (10 min), preview
  builder, Yes/No/Edit callbacks, /undo
- Wallets.gs, Categories.gs, Contacts.gs, Transactions.gs, Debts.gs,
  Investments.gs, Favorites.gs, OCR.gs, Reminders.gs, Closing.gs,
  Reports.gs, Security.gs, Template.gs
- Tests.gs: plain functions I can run from the Apps Script editor (e.g.
  testParser) that log PASS/FAIL. Keep parser tests up to date

## Core rules (never break these)
- Nothing is hardcoded that lives in the sheet: wallets, wallet groups,
  categories, keywords, contacts, users, GoPay names, thresholds. Always read
  them at runtime so edits in the sheet change the bot's behavior.
- Find columns by header name, so adding or reordering columns doesn't break
  the bot.
- Secrets (bot token, Gemini key, main sheet ID, archive folder ID,
  template ID) live in Script Properties.
- Exception (owner's decision, 2026-09-25): the /saldo password lives in the
  Settings tab ("Password" row, numbers only, plain text) so it can be reset
  in the sheet. Read it fresh every time, never cache it, and delete every
  message that contains it. Do not move it back to a hash.
- Never save anything unclear: always show a preview and wait for Yes.
- Transfers and investment purchases never count as income or expense.
  Adjustments are excluded from income/expense totals.
- AI/OCR failure never blocks logging: fall back to keywords or manual input,
  and log the failure to the Logs tab.
- Only chat IDs listed in the Users table in Settings may use the bot.
  Anyone else gets no data.
- Amounts in /saldo, /inv, /open and /report replies go through ONE spoiler
  helper (respecting the "Hide amounts" setting). Previews and save
  confirmations stay plain. Send messages with parse_mode HTML and escape
  user text (<, >, &) so notes can't break formatting.
- All amounts are stored as positive integers in Rupiah; display as Rp with
  "." thousand separators (Rp1.250.000).

## Apps Script gotchas to handle
- Telegram may deliver the same update twice. Dedupe by update_id in
  CacheService before doing anything.
- doPost must return HtmlService output, never ContentService. ContentService
  answers with a 302 redirect, which Telegram treats as a failed delivery: it
  retries the same update forever and queues every newer message behind it.
  Dedupe still guards against the occasional genuine retry.
- Use LockService around writes (IDs, balances) because both users can send
  at the same time.
- Limits: 6 minutes per execution, daily UrlFetch quota, 20 triggers per
  project. Use ONE hourly dispatcher trigger that decides which reminders are
  due (daily 08:00, Monday weekly, monthly 1st, last-day 12:00 and 18:00,
  favorites), and records "last sent" in Script Properties to avoid repeats.
  Time triggers are not minute-exact; that is acceptable.
- Set "timeZone": "Asia/Jakarta" in appsscript.json.
- Web app deployment: Execute as "Me", access "Anyone". After code changes,
  update the EXISTING deployment to a new version so the webhook URL stays
  the same.
- Batch sheet reads/writes (getValues/setValues), never cell-by-cell loops.
- Two time triggers only: the hourly reminder dispatcher and the 1-minute
  message-cleanup trigger. The cleanup trigger must exit immediately when
  its queue is empty, to stay within the daily trigger runtime quota.
