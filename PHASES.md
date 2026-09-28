# PHASES.md — Build plan and prompts

How to use:
1. Open the project folder (with SPEC.md, CLAUDE.md, PROGRESS.md, PHASES.md)
   in Claude Code.
2. Start a NEW Claude Code session for each phase, and paste that phase's
   prompt. CLAUDE.md and PROGRESS.md carry the context between sessions.
3. Answer its questions, follow its manual steps, then test in Telegram with
   the checklist it gives you.
4. Only move on when the phase works. If something breaks, use the
   "Bug report" prompt at the bottom.

---

## Phase 0 — Project setup and "hello bot"
```
Read CLAUDE.md, SPEC.md (Sections 0, 3, 13, 20) and PROGRESS.md.
Phase 0 goal: a working skeleton, no transaction logic yet.
- Help me install and log in to clasp, and create a standalone Apps Script
  project linked to this folder
- Create appsscript.json (Asia/Jakarta, needed scopes) and the file
  structure from CLAUDE.md with empty/stub functions
- Script Properties setup: tell me step by step how to add the bot token
  and Gemini key myself
- doPost with update_id dedupe, LockService, error logging, and an
  allow-list check against the Users table (for now, read allowed chat IDs
  from a Script Property until the sheet exists)
- /start and /help replies (help can be a placeholder)
- Guide me through deploying as a web app and setting the Telegram webhook
- A setWebhook and a getWebhookInfo helper I can run from the editor
Show me your plan and questions first.
```

## Phase 1 — Sheet template
```
Read CLAUDE.md, SPEC.md (Sections 6, 8, 12, 18) and PROGRESS.md.
Phase 1 goal: a function createTemplate() in Template.gs that builds the
complete main sheet from scratch: every tab, header, data validation,
formula, number format, frozen header, protected formula columns, sample
rows (sample wallets, default categories incl. "Admin & Bank Fees" and
"Adjustment"), the Users table in Settings, and a Dashboard tab with the
charts listed in Section 18.
- Explain which values are formulas and which are written by the script
- Save the new sheet's ID as the main sheet and the template in Script
  Properties
- Switch the allow-list to read from the Users table
- Add a validateSheet() function that lists missing tabs/columns (used later
  by /setsheet)
Show me your plan and questions first.
```

## Phase 2 — Core logging: income, expense, transfer
```
Read CLAUDE.md, SPEC.md (Sections 4, 5, 6, 14, 19) and PROGRESS.md.
Phase 2 goal: log Income, Expense and simple Transfer end to end.
- Parser: all Indonesian amount formats, optional dates (kemarin, 20/09),
  wallet and #category detection, English/Bahasa keywords, ambiguous-number
  handling. Write testParser() with at least 30 cases
- Category mapping order: explicit → keyword → Gemini → ask with buttons;
  offer to save a keyword after I correct a category
- Wallet selection rules 1–3 from Section 6
- Preview with [Yes] [No] [Edit], pending state in CacheService (10 min)
- Checks: large amount, duplicate within 5 min, negative balance
- /undo, /saldo (with password, auto-delete password message, /changepass,
  default 0000 reminder), /wallet, /category, /help with real examples
- Hiding amounts (SPEC Section 13 "Hiding sensitive amounts"): a shared
  spoiler helper for formatting Rp amounts, used by /saldo now and by
  /inv, /open and /report later; /saldo reply auto-delete via a queue and
  a 1-minute cleanup trigger that exits early when empty. Guide me through
  creating the trigger
Show me your plan and questions first.
```

## Phase 2B — Budgeting
```
Read CLAUDE.md, SPEC.md (Section 25, Section 13 "Hiding sensitive amounts",
Section 18 Tabs 3, 7, 15) and PROGRESS.md.
Phase 2B goal: budgets per category with a message after every save.
(Already built before this phase: the Categories tab's Monthly Budget,
Spent and Remaining columns, upgradeSheets(), and the "Password for
/saldo" switch — check PROGRESS.md.)
- Load Monthly Budget per Expense category (empty/0 = no limit; ignore
  budgets on non-Expense categories)
- ONE shared "counts as expense / income" rule, used for spent now and by
  /report and the Dashboard later (today: Type = Expense)
- Spent calculated by the bot for the ENTRY's month (message after save)
  or the current month (/budget)
- The separate budget message after every successful save (under, exactly
  at, over; one message for a linked group with several categories; none
  for no-limit categories, non-expenses or /undo) via ONE reusable
  "after save" step that every later flow calls
- /budget and /budget [category] with spoiler amounts; "Password for
  /budget" switch in Settings (default No)
- "Budget auto-delete" = Yes/No (default Yes): budget messages after saving
  are deleted at the end of the day (23:59) in one batch; the /budget reply
  after 60 seconds. Same queue and cleanup trigger as /saldo, no new trigger
- Add the Budget_History tab to the schema (written in Phase 8) and the new
  Settings rows via upgradeSheets()
Show me your plan and questions first.
```

## Phase 3 — Adjust balance and transfers with fees/partial expense
```
Read CLAUDE.md, SPEC.md (Section 6: Adjust Balance, Transfer with Partial
Expense; Section 14) and PROGRESS.md.
Phase 3 goal: /adjust, transfer + admin fee, transfer + partial expense,
"sampai [amount]" difference detection, linked entries with Link ID,
source-vs-destination question, and /undo for linked groups. Expense
portions (fees, partial spending) go through the Phase 2B "after save" step
so the budget message lists every budgeted category in the linked group.
Show me your plan and questions first.
```

## Phase 4 — Hutang / piutang and split bill (text)
```
Read CLAUDE.md, SPEC.md (Section 7, Section 14) and PROGRESS.md.
Phase 4 goal: piutang, hutang, long-term, group piutang with sub-records,
split bill (equal/custom), pelunasan (full/partial/overpayment), add to
existing, convert/close, contacts and aliases (/contact), /open (amounts
with the spoiler helper from Phase 2), full history linked by Debt ID.
Decide how Conversion rows count (expense/income) and put it in the shared
"counts as expense / income" rule from Phase 2B, so budgets, reports and
the Dashboard agree. My split-bill share and converted piutang trigger the
budget message through the "after save" step.
Show me your plan and questions first.
```

## Phase 5 — Favorites and reminders
```
Read CLAUDE.md, SPEC.md (Sections 9 and 15) and PROGRESS.md.
Phase 5 goal: /fav list/add/edit/delete, favorites edited directly in the
sheet, fixed vs variable amounts, default fees, scheduled prompts with
[Yes] [Change amount] [Skip]. Build the single hourly dispatcher trigger
for all reminders in Section 15 (daily, weekly Monday, monthly 1st,
merging rules, snooze) and guide me through creating the trigger.
Favorites saved as expenses go through the Phase 2B "after save" step
(budget message). Keep it to TWO time triggers in total (this dispatcher +
the 1-minute cleanup trigger).
Show me your plan and questions first.
```

## Phase 6 — Investments
```
Read CLAUDE.md, SPEC.md (Section 8) and PROGRESS.md.
Phase 6 goal: investment purchases (lot, gram, unit, total; any two of
quantity/price/total), investment category wallets, single and bulk
/inv update (including edits made directly in the sheet), Price_History,
selling with FIFO default and row picker, realized vs unrealized gain,
/inv (amounts with the spoiler helper from Phase 2), and the last-day 12:00 price reminder in the dispatcher.
Show me your plan and questions first.
```

## Phase 7 — Bill OCR: GoPay Split Bill + receipts
```
Read CLAUDE.md, SPEC.md (Sections 10, 24 and 25 "Budget message after
saving") and PROGRESS.md.
Phase 7 goal: read bill images and log them.
- Accept photos AND image files (documents); use the largest photo size.
  Send a "processing…" message first
- ONE Gemini vision call with a JSON-only prompt. Route: issuer matches
  "GoPay" AND a participant list is found → GoPay Split Bill flow (Section
  10, using the Phase 4 split-bill logic); everything else → Receipt flow
  (GoPay payment receipts suggest GoPay as the wallet). Caption "split" /
  "bill" forces the flow
- Split bills: identify the sender by GoPay name from the Users table,
  match names via Contacts, low confidence, totals that don't add up,
  unknown names, duplicates, full manual fallback
- Receipts: final total (never Subtotal or Kembalian), candidate totals when
  unclear, Expense preview with category (keyword → AI → ask) and wallet,
  receipt duplicate rule (total + merchant + receipt date, any time)
- Caption parsed like a text message but with the amount OPTIONAL
- The pending entry keeps only the Telegram file_id (not the image). Only
  after I tap Yes: save the row(s), download the image again, upload it to
  the Receipts folder (monthly subfolder, file name rule; create
  MonetaBot/Receipts if none is set), then put a "View receipt" HYPERLINK in
  Image Link on every row of the group. Upload failure: keep the
  transaction, log it, tell me
- The budget message after saving (Phase 2B "after save" step)
- /undo of a receipt asks whether to also trash the image
- Upgrade function: Input Source dropdown → Text / OCR-GoPay / OCR-Receipt
  / Favorite / Sheet in my existing main sheet and template
- /setreceipts [folder url], and a guide for sharing the Receipts folder
  with my partner so "View receipt" opens for them
Show me your plan and questions first.
```

## Phase 8 — Closing, reports, sheet management
```
Read CLAUDE.md, SPEC.md (Sections 11, 12, 16) and PROGRESS.md.
Phase 8 goal: /closing with pre-checks and summary, archive sheet created
in the Archive folder, clearing and carry-over, blocking entries in closed
months (no /reopen), Monthly Report tab, /report [month] [year] (chat
summary amounts with the spoiler helper from Phase 2), automatic
report after closing, the 18:00 last-day closing reminder, /setsheet with
validation, /setarchive, /settemplate, /template. On closing, write each
budgeted category's budget and spent to Budget_History; /report shows
budget usage (Budget_History for closed months, Categories tab live for
the current month), using the shared "counts as expense" rule. Carry the
Categories budgets over. Be careful: closing deletes data from the main sheet,
so archive and verify first.
Show me your plan and questions first.
```

## Phase 9 — Final review
```
Read CLAUDE.md, SPEC.md and PROGRESS.md.
Review the whole project against SPEC.md Section 22 and 23:
- List any requirement that is missing or only partly done
- Give me the full test checklist from Section 22 item 6
- Check quota risks and error handling
- Write a short README.md for me: how to deploy updates, add a wallet,
  change the password, and what to do if the bot stops replying
Do not change code until I approve your list.
```

---

## Bug report prompt (use anytime)
```
Bug: [what I typed in Telegram]
Expected: [what should happen]
Got: [what the bot replied, or nothing]
Logs tab / error: [paste any error, but no tokens or keys]
Find the cause, explain it briefly, fix it, push, and tell me how to retest.
```

---

## Spec update prompt (use if you already started building)
```
SPEC.md was updated: new Section 24 (receipt OCR for non-GoPay bills) and
Section 25 (budgeting), plus related edits in Sections 0, 4, 12, 13, 16,
17, 18 (Tabs 3, 7, 15, 16), 21 and 22. PHASES.md has a new Phase 2B and
updated Phases 3, 4, 7 and 8.
Read the changes, compare them with what is already built (PROGRESS.md),
and tell me what needs to change in existing code and in which phase each
change belongs. Do not change code until I approve.
```
