# PROGRESS.md

Claude Code updates this file at the end of every phase.

## Current phase
Phase 6 — BUILT and pushed (2026-11-01), waiting for the owner's Telegram
checklist. Owner setup: new deployment version, upgradeSheets (adds
Investment_Sales → Link ID).
Phase 5 — DONE (committed 78d4907; owner re-test of the fixes pending).
Phase 4, 3, 2B, 2, 1, 0 — DONE.
Next: Phase 7 — Bill OCR (GoPay Split Bill + receipts).

## Deferred (agreed, must be picked up later — do not drop)
(none open. The AI parsing fallback was built in Phase 3.)

## Spec change 2026-09-28: receipts (SPEC 24) + budgeting (SPEC 25)
Decisions (owner): GoPay flow only if issuer = GoPay AND participant list;
budgets stay in the Categories tab (Monthly Budget + formula columns Spent
and Remaining; no Budgets tab, no dropdown restriction — user leaves non-
expense budgets empty); budget message uses the entry's month, /budget the
current month; "Budget auto-delete" = Yes/No: budget messages after saving
are deleted at END OF DAY (23:59) in one batch, /budget and /saldo replies
after a fixed 60s (the cleanup's precise ≤60s wait stays, it only serves
on-demand replies); "Password for /saldo" and "Password for /budget"
switches in Settings (one switch for both users); budget history goes to a
new Budget_History tab at closing.
Already done (2026-09-28, part of Phase 2):
- Categories Spent/Remaining formula columns in getSchema_ (Remaining red
  when negative) + upgradeSheets() to add them to the existing main sheet
  and template (writes formulas in en_US, then restores the locale; also
  runs upgradeSettings and validateSheet)
- "Password for /saldo" switch (Settings, default Yes, read fresh); the
  password prompt says where to turn it off
- "✅ Saved as TRX-…" no longer shows wallet balances (owner's decision)
- Budget message after saving (pulled forward from 2B at the owner's
  request): afterSave_(ss, chatId, entries) in Confirm.gs — one message for
  all budgeted expense categories in the entries, month of each entry's
  date, spoiler amounts; "Budget auto-delete" (Yes/No, default Yes) deletes
  it at 23:59 via the delete queue. countsAsExpense_ (Transactions.gs) is
  the shared rule; parseBudget_/spentInMonth_/buildBudgetText_ in
  Categories.gs; testBudget in Tests.gs
- upgradeSettings removes OBSOLETE_SETTINGS rows (e.g. "Saldo auto-delete
  (seconds)"), moving only the Setting/Value/Notes cells
Still to change in code that is already built:
- Phase 2B (DONE 2026-09-28): /budget and /budget [category]
  (buildBudgetReport_ in Categories.gs, pure; total covers budgeted
  categories only, plus a "Spending without a budget" line; warnings for
  budgets on non-Expense categories and duplicate names), "Password for
  /budget" switch (default No, same password flow as /saldo), /budget reply
  deleted after 60s when Budget auto-delete = Yes, Budget_History tab in the
  schema + upgradeMissingTabs_ (added to existing sheets by upgradeSheets),
  testBudgetCommand
- From now on every new saving flow must call afterSave_
- Phase 7: LISTS.INPUT_SOURCES (Config.gs) and the sheet dropdown change to
  Text / OCR-GoPay / OCR-Receipt / Favorite / Sheet; parser needs a caption
  mode with an optional amount; routeUpdate_ must accept image documents;
  receipts need their own duplicate rule (findDuplicate_ is text-only)

## Done
- Phase 0 (skeleton, no transaction logic)
  - clasp linked to standalone project (script ID in .clasp.json, rootDir src/)
  - appsscript.json: Asia/Jakarta, V8, web app (execute as me, anyone),
    scopes: external_request, spreadsheets, drive, script.scriptapp
  - doPost: webhook ?key= check → update_id dedupe (CacheService 6h, inside
    LockService) → allow-list → router
  - Blocked chat IDs are ignored silently; last 10 webhook outcomes are kept
    in the RECENT_UPDATES Script Property (run showRecentUpdates in Main.gs)
    because Apps Script hides console logs of web-app runs made by Telegram
  - /start and placeholder /help; other text gets a "still being built" reply
  - Editor helpers: setWebhook (creates WEBHOOK_KEY), getWebhookInfo (key
    hidden), deleteWebhook
  - Stub .gs files for every later module; git repo initialised
- Phase 1 (sheet template)
  - Template.gs: getSchema_() is the single source of truth for every tab and
    column (header, format, dropdown, formula). createTemplate() and
    validateSheet() both read it
  - createTemplate(): builds "MonetaBot Template" (clean, sample rows, Users
    with blank chat IDs), validates it, copies it to "MonetaBot Main" (Users
    filled from ALLOWED_CHAT_IDS), both in Drive folder "MonetaBot"; saves
    TEMPLATE_ID and MAIN_SHEET_ID. Refuses to run if either is already set
  - resetSheets(): trashes both sheets and clears the two properties (refuses
    if Transactions has rows)
  - validateSheet(id?): lists missing tabs/columns; extra ones are fine.
    Default = main sheet. For /setsheet later
  - Tabs: Dashboard, Transactions, Wallets, Categories, Hutang_Piutang,
    Investments, Investment_Sales, Price_History, Favorites, Contacts,
    Monthly Report, Settings, Logs
  - Formula columns (green header, formula lives IN the header cell as
    ={"Header"; ARRAYFORMULA/MAP(...)}, protected warning-only):
    Transactions: Wallet Group, Month Status · Wallets: Current Balance ·
    Hutang_Piutang: Remaining · Investments: Current Value, Gain/Loss (Rp),
    Gain/Loss (%) · Investment_Sales: Proceeds, Realized Gain ·
    Settings: Owners, Investment Categories
  - Script-written: all IDs, statuses (Debt/Investment Status), Monthly
    Report, Price_History, Logs
  - Wallet Current Balance: Cash type = Opening + In − Out − Transfer out +
    Transfer in (by Direction). Investment type = SUM of Investments Current
    Value for that Investment Category. Investment Current Value uses
    Acquisition Price until a Current Price is entered
  - Month Status: "Closed" if Monthly Report has Month Key (YYYYMM number)
    with Status = Closed
  - Settings tab = 3 tables side by side sharing row 1: Setting/Value/Notes
    (A:C, Value column is plain text), Users (E:H: Chat ID, Display Name,
    GoPay Name, Active), helper lists (J: Owners, K: Investment Categories,
    L: Wallet Groups — manual)
  - Dashboard: chart data tables from column T (all formulas), 7 charts on
    the left. Trend charts read Monthly Report (Month, Portfolio Value,
    Net Worth)
  - Allow-list now reads active rows of the Users table (cached 5 min,
    clearConfigCache() to force). Falls back to ALLOWED_CHAT_IDS only if no
    main sheet or it can't be read
  - Config.gs: TAB and LISTS constants, getUsers_(), getSettings_(),
    setSettingValue_(). Sheets.gs: readTableByHeaders_ (lowercase keys),
    writeRowsByHeaders_ (writes only named columns, refuses formula columns,
    throws on unknown header), appendRowByHeaders_, lastDataRow_
  - Logs tab is live (errors from logError_ land there)
  - Tests.gs: testConfig, testDedupe, testAllowList, testSheet, testDoPost,
    testSendHello
- Phase 2 (core logging: income, expense, transfer)
  - Parser.gs (pure, tested): amounts 50000 / 50.000 / 50,000 / Rp50.000 /
    50k / 50rb / 50 rb / 50ribu / 1.5jt / 1,5jt / 2jt / 2 juta; unclear
    amounts (2.00.000, 1,5,000, 50.5rb, 1.5, 1.250jt, bare "50") return
    options to pick; dates kemarin/kmrn/kmarin/kemaren/yesterday, hari ini,
    N hari lalu / N days ago, dd/mm(/yyyy), dd-mm, "20 sep", "tgl 10" =
    nearest past 10th (confirmed by the user); #category (exact or unique
    prefix); income by +, income words or an Income keyword; transfers by
    transfer/tf/pindah/top up or "X ke Y"; transfers with fee words or a
    second amount are refused until Phase 3
  - Wallet matching: full name, or the part before brackets ("IPOT" →
    "IPOT (Saham)"); a short name shared by several wallets asks the user to
    pick. Investment wallets (Wallet Type = Investment, or group listed in
    "Investment Wallet Groups") are blocked for expense/income; transfers may
    use investment-group cash wallets (BCA → IPOT) but not Type=Investment
  - Category mapping (changed in Phase 3 to #tag → keyword → buttons, NO AI).
    Phase 2 version: #tag → longest keyword → Gemini (AI.gs, JSON only,
    model from Settings, failures logged) → buttons; after the user picks a
    category, offer to save a word from the note as a keyword (moved from
    any other category)
  - Wallet rules: mentioned → category default wallet (shown in preview) →
    buttons. Expense buttons = "Spending Wallet Groups"; income = all
    non-investment cash wallets; transfers = all cash wallets
  - Confirm.gs: one pending item per chat in CacheService (10 min), buttons
    carry a pid so old buttons expire; preview [Yes] [No] [Edit]; Edit →
    Amount/Category/Wallet/Date/Note/Type with Back and Cancel entry; checks
    in the preview: large amount, duplicate (type+amount+note within the
    window), negative balance, future date; closed month blocked with
    [Use today]; double taps guarded (claimPending_)
  - "✅ Saved as TRX-0001." (no balances); afterSave_ then sends the budget
    message (see "Spec change" above)
  - /undo (own last entry or its Link ID group, not in closed months),
    /saldo [wallet | short name | group | owner | all] (investments hidden
    unless "all"; spoilers; deleted after a fixed 60s), /changepass, /wallet,
    /wallet add (guided), /category or /cat, /category add, /cancel, /help
  - Password: Settings "Password" row, numbers only, read fresh; wrong
    password re-asks (5 tries, then 15-min lock); every password message and
    prompt is deleted; "Password for /saldo" switch
  - Telegram.gs: HTML messages, escapeHtml_, formatRp_, THE spoiler helper
    spoiler_/money_, delete queue (cache + Script Property backup) with
    cleanupMessages (every-minute trigger, exits when empty, waits for
    messages due within the next minute) and installCleanupTrigger
  - Settings rows added: Gemini Model, Hide amounts, Password, Password for
    /saldo, Spending Wallet Groups, Investment Wallet Groups, Budget
    auto-delete. upgradeSheets() / upgradeSettings() add missing rows and
    columns to existing sheets and remove obsolete rows
  - Tests: testParser (87 cases), testCategoryMapping, testSpoiler,
    testPassword, testDeleteQueue, testBudget, testSheet; showSettings and
    showRecentUpdates helpers
- Phase 2B (budgeting)
  - Budget message after saving (afterSave_, built during Phase 2), /budget
    and /budget [category], "Password for /budget" (default No), /budget
    reply deleted after 60s and after-save messages at 23:59 when "Budget
    auto-delete" = Yes, Budget_History tab (filled in Phase 8),
    upgradeMissingTabs_, testBudget + testBudgetCommand
  - Rule for all later phases: every flow that saves an expense calls
    afterSave_(ss, chatId, [{ type, category, date }])
- Phase 3 (adjust balance, transfers with fee / received amount / partial expense, AI parsing)
  - Parser: one extra part per transfer (extractTransferExtra_): fee words
    before/after an amount ("admin 2.5rb", "dipotong admin 15k", "biaya
    transfer 6.5rb", "2.5rb admin"), received ("sampai / diterima R"), partial
    ("Y untuk / buat / dipakai …", the rest is its note, #tag = its category).
    Needs a main amount too; two extras → asks to split. parseAdjust_ for
    /adjust (0 and negative balances, optional date + note)
  - Rules (owner): EVERY fee comes out of the amount (Transfer = amount − fee,
    fee from the source; the From deduction is what was typed). Partial
    spending is spent FROM THE DESTINATION after arriving (no question; Edit
    can switch). "sampai R": [A fee] [Spent on something] [Typo]
  - entriesOf_(d) → the rows to save (Transfer + Expense), walletDeltas_ →
    per-wallet effect shown in the preview and used for negative checks
  - Linked rows share a Link ID (nextId_ on "Link ID", LNK-0001); saved in one
    lock; the expense part goes through afterSave_ (budget message)
  - Source wallet's Default Transfer Fee is suggested on plain transfers
    (preview "default fee for BCA", [🚫 No fee]); Edit: fee/spent amount and
    category, remove, ➕ Add fee, switch source/destination
  - /undo on a linked group deletes all of it ("Delete all N")
  - /adjust: "Password for /adjust" (default Yes), spoiler amounts, recorded
    vs actual vs adjustment, re-checked on Yes, Adjustment row (Type and
    Category Adjustment, Direction In/Out, never income/expense). "Adjust
    auto-delete" (default Yes): the bot message AND the /adjust command are
    deleted 60s after the flow ends, or at pending expiry (10 min).
    scheduleDelete_ replaces an existing entry for the same message
  - AI (owner: ONLY for parsing): aiParseTransaction_ + validateAiTransaction_
    when the rules find no clear amount and looksLikeMoney_; every field is
    checked against real wallets, category comes from keywords/buttons, the
    preview says "🤖 Read by AI". AI category guessing was REMOVED
    (aiSuggestCategory_ gone). Gemini retries 503/500/network errors (3 tries,
    1s + 2s); the reply notes when the AI step failed; testGemini lists the
    models the key can use
  - Tests: testParser 102, testAdjust 15, testLinkedEntries 12, testAiParse 12
- Phase 4 (hutang / piutang, group piutang, split bill, pelunasan, convert)
  - parseDebt_ (Parser.gs, pure): kinds new / split / pay / add / convert.
    Lend/borrow words ("Budi pinjam" = piutang), due dates (extractDueDate_:
    dd/mm, "30 okt", "tgl 10", "5 hari", "bulan depan"), long term, IDs
    (PTG-001, PTG-010-A). Comma mode: commas separate people (any case), a
    full stop ends the header (note/category); without a full stop a first
    part word is the note only if it is a category keyword. Plain mode: in a
    split, Capitalized words are names. Several names / "piutang split" =
    group; including aku/saya in a piutang = split bill; a split includes me
    ONLY with aku/saya. Missing amount/total → needsAmount / needsTotal
    (asked, entry kept). computeShares_: friends round down, leftover to me
    (or the first person)
  - Debts.gs: records (loadDebts_), resolveDebtTarget_ (pay: spread over all
    open records, nearest due date first then oldest — sortForPayment_,
    allocatePayment_; add: pick one; convert: pick or [All]; unknown name →
    "No open … Create a new one?"), overpayment (correct / income-expense /
    flip into a new record the other way), previews, saveDebt_ (Debt ID on
    every row, Link ID for groups/splits/multi-record payments, new names
    added to Contacts), conversions = Expense/Income rows with Direction
    None (record category suggested; group = every open person)
  - Hutang_Piutang: Added/Paid/Converted/Remaining/Status are formulas
    (debtSumFormula_ sums Transactions by Debt ID incl. "ID-*" sub-records);
    upgradeDebtColumns_ converted the existing sheet
  - /undo: removes records a debt entry created (blocked while later rows
    exist), reopens converted records (debtUndoPlan_ / applyDebtUndo_)
  - /open, /piutang, /hutang [name] (buildOpenText_, "Password for /open",
    "Open auto-delete" 60s), /contact, /contact add (Contacts.gs)
  - The shared rule stays: countsAsExpense_ = Type Expense (conversions are
    Expense rows), so budgets, Spent column, reports and Dashboard agree
  - Missing Contacts / Hutang_Piutang tabs no longer break other messages
  - Tests: testDebtParser 51, testShares 5
- Phase 5 (favorites and reminders)
  - Owner decisions: debt reminders go to whoever logged the record
    (first Transactions row with its Debt ID → Logged By; unknown → both);
    favorites have a Remind column (Me / Partner / All, default All); an
    unanswered prompt is asked again each morning until it's logged/skipped
    or the next due date; one message per favorite; [Yes] on a scheduled
    prompt saves right away (the normal preview only if previewChecks_ has a
    warning or the month is closed); snooze only pauses the daily reminder;
    an expense favorite's default fee = a linked "Admin & Bank Fees" expense
    on top (a transfer's fee still comes out of the amount); /fav delete
    removes the row
  - Favorites.gs: parseFavAdd_ / parseFavEdit_ / extractFavSchedule_ (pure).
    Monthly "setiap tanggal 1 (September 2026)", "tiap bulan tgl 5",
    "tgl 5 setiap bulan", "tanggal 5", "monthly on the 5th"; weekly
    "setiap senin", "tiap minggu hari sabtu", "every friday"; "variable",
    "admin 1rb", "remind Partner", "tanpa jadwal", "tanpa admin",
    "nama <new>". No amount = Variable. Transfer without words → "Top up
    GoPay" / "Transfer BCA → Jago". Days 29–31 = last day of shorter months
  - Favorites tab read every time; rows typed in the sheet get an ID
    (ensureFavoriteIds_) and, if scheduled without Start Date, Start Date =
    next due date. IDs never reuse a number seen in Favorites or
    Transactions (maxFavoriteNumber_). favProblems_ flags unknown
    wallet/category/day in /fav and skips them in prompts (Logs tab)
  - /fav (list + buttons), /fav <name>, plain text = exact favorite name,
    /fav add, /fav edit <name> jadi <change> (preview shows "was …"),
    /fav delete. Logging reuses the trx flow: draft.favId → Favorite ID +
    Input Source "Favorite" on every row, Last Logged (midnight) inside the
    save lock, afterSave_ budget message, other users' prompt buttons removed
  - Scheduled prompts: buttons "F|y|c|s|<favId>|<yyyymmdd>" (not tied to the
    10-min pending). Answered = Last Logged ≥ due − 7 days (weekly 3) or Last
    Skipped ≥ due. Double taps guarded by a 30s cache key. FAV_PROMPTS
    Script Property keeps the latest prompt per favorite + chat
  - Reminders.gs: runReminders (hourly trigger) → reminderSlots_ (only
    "morning" now). Slot hour from Settings, first run at/after it, last run
    day in REMINDER_STATE (written before sending → never twice; a missed
    hour catches up later that day). Morning: debts (Monday weekly / 1st
    monthly / merged / else daily) + favorite prompts. Daily = open
    short-term, non-group, not snoozed, due within "Debt Reminder Days
    Before Due" or overdue, or open ≥ "Debt Reminder After Days" (new
    setting, 3). Weekly = all open (short-term, then long-term & groups);
    monthly = long-term & groups with open members. Amounts via money_
    (Hide amounts). Last Reminder written per record. Snooze buttons per
    record + "Snooze all" (ids read from the message's own buttons) set
    Snoozed Until = tomorrow
  - Editor helpers: installReminderTrigger (replaces an old one, prints the
    trigger list; expected 2), sendRemindersNow (test), showReminderState
  - Sheet: Favorites columns Start Date, Remind, Last Skipped
    (upgradeMissingColumns_, run by upgradeSheets); setColumnById_ in
    Sheets.gs writes one column by ID in one call; loadDebts_ reads Snoozed
    Until; Settings rows now use SETTING constants
  - Tests: testFavParser 37, testFavSchedule 21, testReminders 16; Node fake
    end-to-end run of add/list/log/edit/delete, prompts, skip, re-prompt,
    snooze, weekly/monthly/merged, dispatcher catch-up
  - Fixes after the owner's first test (2026-11-01):
    - Favorites may use any everyday wallet (e.g. savings): draft.anyWallet
      makes askWallet_ offer every non-investment wallet, not only Spending
      groups. (A wallet whose group is in "Investment Wallet Groups" stays blocked)
    - "Partner is not a user": the partner's Chat ID was not in Settings →
      Users. Error text now says a user needs a Chat ID there
    - /fav edit: leftover words = the new name ("jadi Token PLN"); "nama X" still works
    - Reminders sent twice: sendRemindersNow didn't mark the morning as done,
      so the trigger sent again. Now it marks it, and every person gets the
      morning message at most once a day ("sent|<chatId>" in REMINDER_STATE;
      sendRemindersNow forces a resend for testing)
    - ONE morning message per person (buildMorningMessage_): favorites due +
      debt part. Exactly one item keeps its buttons (favorite prompt or
      [💤 Snooze]); two or more = plain list, log with /fav or by typing.
      sendFavoritePrompts_/sendDebtReminders_ → dueFavoritesByChat_ /
      debtPartsByChat_
    - Favorites Keywords column (after Name, comma-separated, typed in the
      sheet or "keyword a, b" / "tanpa keyword" in /fav add/edit). A message
      that is exactly a name or keyword logs that favorite, checked BEFORE
      the debt parser (so "bayar mobil" isn't a debt payment)
    - Daily debt reminder = short-term records WITH a due date that's near or
      overdue only; no due date → weekly list only. "Debt Reminder After
      Days" removed (OBSOLETE_SETTINGS)
    - /fav off <name> / /fav on <name> (also pause/resume/nonaktif/aktif)
    - Tests: testFavParser 46, testReminders 20
    - Duplicate line in the morning list: two Users rows with the same Chat ID
      counted as two people. uniqueChatIds_ now sends/lists per chat once
      (favorites and debts); /fav flags two favorites with the same name

- Phase 6 (investments)
  - Owner decisions: stocks stored in LOTS (Quantity in lots, prices per lot;
    a typed price for a lot asset is per share ×100 unless "/lot"); a buy
    fee goes into the cost (Acquisition Cost = qty × price + fee,
    Acquisition Price = cost / qty); no source wallet → last one used for
    that asset (else category), shown "(last used)"; the price reminder
    goes to every active user (each chat once)
  - Defaults: sale fee in Investment_Sales → Fees (reduces Realized Gain),
    wallet gets proceeds − fee; "nominal" assets: Quantity = Rupiah, price
    1, and /inv update takes the new TOTAL value; /inv has no password
    (spoiler amounts), no auto-delete; quantities "0,5" / "0.005" are
    decimals, "1.000" = thousand
  - Investments.gs: parseInvestment_ (pure) — only when the message starts
    with beli/buy/invest/jual/sell/cairkan/redeem AND names an investment
    wallet, a known asset or "lot" ("beli kopi 20rb" stays an expense).
    Checked after favorites, before debts. readInvNumbers_ reads "2gr",
    "2 lot", "1.350rb/gr", "@1.520", "harga X", "total X", "fee X",
    "semua"; resolveInvNumbers_ works out the missing one of qty / price /
    total from what was typed (d.in), every time. Unmarked money with a
    quantity: lot → price per share, else the bot asks [price] / [total].
    Unit: typed → the asset's rows → the category's latest row → buttons.
    Platform: "via/di X", else the source wallet's name before "("
  - Buy: Investments row (Current Price = purchase price, Status Holding,
    Source Wallet, Link ID) + Transactions "Investment Buy" (Direction
    Transfer, source → category wallet, Category = Investment category of the
    same name) + the price applied to every holding row of that asset and
    logged in Price_History
  - Sell: FIFO (allocateSale_) or [🔀 Choose rows] (one row); preview shows
    rows, fee, proceeds into the wallet, realized gain (saleGain_).
    Investment_Sales row per purchase row (fee on the first), Quantity =
    remaining, Status Partially Sold / Sold, "Investment Sell" transfer of
    proceeds − fee, price applied + logged. /inv sell = guided (asset buttons
    → quantity → price, [Last price] button)
  - /inv update: one asset per line; asset name → its holding rows, category
    name → its holding rows (same unit); unknown → [Skip those, save the rest]
    / [Correct it]; >30% change flagged. Source Manual (one line) / Bulk
  - Sheet edits: syncSheetPrices_ (on /inv, buy/sell messages, the price
    reminder) gives typed rows an Inv ID / Status / Acquisition Cost and logs
    a changed Current Price as "Sheet Edit" + Last Price Update
  - /inv [category | asset]: per category and asset: quantity, last price
    (date), average cost, value, gain Rp/% (money_ spoilers), total, realized
    gain this month (Investment_Sales)
  - /undo: a buy also deletes its Investments row (blocked once sold from);
    a sale gives the quantities back and deletes its Investment_Sales rows
    (needs the new Link ID column)
  - Reminders: slot "price" (Price Update Reminder Time, last day of the
    month) with a copy-ready <pre>/inv update</pre> block. Still 2 triggers
  - Owner's first test (2026-11-01): "beli BBCA 1 lot 9.500" was an expense
    because the web app still ran version 20 (Phase 5); the Phase 6 code was
    pushed but no new deployment version made. Speed work (same behaviour,
    checked with a sheet-read counter in the fake run; saves 31-36 → 9-18
    reads, button taps 6 → 3):
    - getHeaderInfo_/getHeaderMap_ cache each tab's header row per execution
      (headerCacheOff_ = true in createTemplate/resetSheets/upgradeSheets/
      upgradeSettings/validateSheet, which change headers)
    - lastDataRow_ reads only the last 50 rows (whole tab only if empty)
    - loadCtx_: contacts read lazily (getter); parseDebt_ looks at contacts
      only when a pay word is present; startTransaction_ passes
      Object.create(ctx) so the getter stays lazy
    - favorites name/keyword lookup skipped when the message has a digit
    - syncSheetPrices_ reads once, locks only to write, returns the rows; it
      runs when a flow starts (/inv, /inv update, /inv sell, buy/sell message,
      price reminder), not on button taps (invCtx_(sync))
    - saves read everything first, then write (prepareColumnById_,
      preparePrices_, preparePriceHistory_, nextTransactionSlot_ + bumpId_,
      prepareFavoriteLogged_): a read after a write makes Sheets recalculate
  - Owner feedback 2 (2026-11-01), replaces the lot decision above:
    - Wallet Type = Cash / Emas / Saham / Others (old "Investment" = Others;
      walletKind_ in Wallets.gs, w.kind). The type sets the unit (unitFor_):
      Emas → gram, Saham → share shown as "lembar" ("2 lot" = 200 lembar,
      "/lot" price ÷100), Others → typed unit (unit / coin / nominal…)
    - A value on its own is the TOTAL; with a unit ("10jt/gr", "5000/lembar",
      "harga", "@") it is the price — in messages and in replies, buy and
      sell. The "price or total?" question is gone
    - normalizeInvText_: "Emas 3 jt/ gr" → "Emas 3jt/gr", "Rp 10jt" → "Rp10jt"
    - Investment signal also: lembar / coin words or a price per investment
      unit ("15jt/coin"); "beli kopi 250gr 50rb" stays an expense
    - Tabs: the old "Investments" (one row per purchase) is now
      "Investment_Details" (TAB.INVESTMENTS) with formula columns Qty Sold,
      Sold Value, Avg Sell Price, Realized Gain, Total Gain/Loss (Rp/%). New
      "Investments" (TAB.INV_SUMMARY): one row per asset, all formulas — Qty
      Bought / Sold / Held, Avg Buy Price (Total Cost ÷ Qty Bought), Total
      Cost, Avg Sell Price, Sold Value, Current Price / Value, Floating Gain,
      Realized Gain, Total Gain/Loss (Rp/%). Total = floating (held at the
      current price) + realized
    - /inv: per asset held qty, avg buy, last price, floating; if sold: sold
      qty @ avg sell, realized, total (sold + held); sold-out assets stay with
      their realized gain. "Inv auto-delete" (default Yes, 60s)
    - upgradeSheets: renameInvestmentDetails_ → upgradeMissingColumns_
      (now also formula columns, en_US) for Investment_Sales and
      Investment_Details → convertLotRows_ (lot → lembar in details, sales,
      price history) → upgradeMissingTabs_ (summary before the details tab)
      → upgradeWalletTypes_ (dropdown, Investment → Emas/Saham/Others by name,
      Current Balance and Dashboard wallet-group formulas)
  - Owner feedback 3 (2026-11-01), final for stocks and wallets:
    - "lbr" = lembar everywhere (buy, sell, /inv update)
    - Stocks: Quantity in LOTS, prices per LEMBAR (IDX style). lotMult_()
      (JS) and lotMultOf_ / saleLotMult_ (sheet formulas) multiply by 100
      for Unit "lot": value, cost, proceeds, realized gain, average prices
      per lembar in both investment tabs. "200 lbr" = 2 lot, "980rb/lot" =
      Rp9.800/lembar. Saham wallets → unit lot
    - convertStockRows_ (replaces convertLotRows_, runs in upgradeSheets):
      share/lembar rows → lot (qty ÷100, sales too); lot rows whose prices
      were per lot (Acquisition Cost ≈ qty × price) → prices ÷100 (sales,
      Price_History too). Safe to run again
    - refreshFormulas_(ss, tab) rewrites changed header formulas (used for
      Investment_Details, Investment_Sales, Investments)
    - Wallet Group may hold several groups, comma-separated ("Spending,
      Investment Wallet"). w.group = first (home: /saldo, /wallet, previews,
      Dashboard group balances), w.groups / walletGroups_ = all. Spending
      buttons: any group in Spending Wallet Groups. Blocked for expenses: any
      group in Investment Wallet Groups (so IPOT "Investment, Investment
      Wallet" stays blocked). /saldo <group> matches any group. The Wallet
      Group dropdown flags a two-group cell as invalid (allowed, warning only)
    - New setting "Investment Source Groups" (default "Investment Wallet"):
      buy source and sale destination buttons list only those wallets
      (invSourceWallets_); a typed or last-used wallet outside them is asked
      again. upgradeSheets adds "Investment Wallet" to Settings → Wallet Groups
    - /inv simplified: held items only — quantity, avg buy → now (per lembar /
      gr / unit), change Rp/%, value; category and total lines. Sold and
      realized numbers stay in the Investments tab
    - /wallet add: tick one or more groups (✅), then Done → saved as "A, B". The
      Wallet Group dropdown in the sheet needs "Allow multiple selections" switched
      on by hand (Apps Script cannot set it); it saves the same "A, B" format
  - Owner feedback 4: investment CATEGORY ≠ investment WALLET
    - Settings → Investment Categories is a typed list (was a formula from
      Categories); settingsInvCategoriesToList_ keeps the old values
    - Wallets → new column Investment Category (dropdown from that list) for
      investment wallets (w.invCategory; empty → the wallet's name). /wallet add
      asks it for Emas / Saham / Others wallets. Several wallets may share one
    - Investment_Details → new column Investment Wallet (holds the row; the
      Wallets Current Balance formula now sums by it). Investment Category =
      the wallet's category (reports, /inv, the Investments tab)
    - Buy: "which investment wallet holds it?" (buttons "Wallet · Category");
      a wallet name picks it, a category name picks its only wallet or asks
      among its wallets, a known asset keeps its wallet. Sell uses the rows'
      wallet. Transactions: To Wallet / Wallet = the investment wallet,
      Category = the investment category
    - If only one wallet is in the Investment Wallet group, buys and sales use
      it without asking ("your only investment wallet")
    - fillInvestmentWallets_ (upgradeSheets): investment wallets without a
      category get their own name (added to the Settings list); old detail
      rows get Investment Wallet = their old Investment Category. Dashboard
      AE3 lists the Settings categories
  - Owner feedback 5:
    - Buy preview: [👛 From] (paying wallet) [📈 To] (investment wallet) and
      [🏷 Category] when the wallet has several. Sell preview: [📈 From] (when
      the asset is in several investment wallets) [👛 To] (where the money goes)
    - An investment wallet may have several categories (Wallets → Investment
      Category "Reksadana, Crypto"; w.invCategories / walletCategories_).
      Buying into it asks the category unless the asset or the message names
      it; /wallet add ticks one or more. Multi-select in the sheet dropdown is
      switched on by hand, like Wallet Group
    - Selling an asset held in several wallets without naming one asks which;
      the sale (save re-check, Choose rows, Last price) only uses that wallet's
      rows — bug found in the fake run: the save re-check took FIFO across
      all wallets
    - Owner: each investment wallet keeps its own average for the same stock;
      selling is FIFO inside the chosen wallet. /inv shows the combined line plus
      one line per wallet (◦ wallet · qty · avg) when a stock is in several; the
      "Sell from which?" buttons show each wallet's average. The Investments tab
      keeps one combined average per stock
    - Tests: testInvParser 38, testInvReport 15
    - Tests: testInvParser 36, testInvReport 14; formulas checked for brackets
      and column references (Sheets itself can't run in the Node test)
  - Tests: testInvParser 29, testInvReport 10; Node fake end-to-end run of
    buy / ask / sell FIFO + chosen row / bulk update / sheet edit / undo /
    guided sell / last-day reminder

## Known issues
- (Resolved in Phase 4) Conversions are Expense/Income rows with Direction
  None, so every total that counts Type = Expense / Income includes them
- Price columns use Rp#,##0, so fractional unit prices (e.g. reksadana NAV)
  display rounded (the stored value is exact)
- Closed-month protection is not built yet (Closing phase)
- After /undo of the newest rows, the next entry reuses the same IDs
  (TRX/LNK/SAL: nextId_ = highest + 1). Harmless (the old rows are gone)
- Investments: one source wallet per purchase; a buy paid from two wallets
  needs a transfer first. Lots are assumed to be 100 shares
- Partner's chat ID may still need to be typed into Settings → Users
- The Users table and Settings are cached for 5 minutes (except the
  password, the /saldo switch and the budget-message settings, which are
  read fresh). Run clearConfigCache after editing Users to apply at once
- Gemini has no timeout control in UrlFetchApp; a slow reply delays the
  preview (the bot shows "typing…")
- End-of-day deletion of budget messages relies on the cleanup trigger; if
  it isn't installed, /saldo warns but budget messages just stay
- The "Monthly Budget" column is only used for Expense categories; budgets
  typed on other types are ignored (by design)
- Reminder times are whole hours and the hourly trigger isn't minute-exact
  (08:00 means "some time between 08:00 and 09:00"). Accepted
- Weekly/monthly summaries have no Snooze (by design); the weekly summary
  for a user lists their own records plus records whose owner is unknown.
  Snooze only appears when the morning message has exactly one item
- clasp 3.4 prints "Skipping push." when the online appsscript.json differs
  (here only a trailing newline); `clasp push --force` after checking
- A favorite paid more than 7 days early (3 for weekly) still gets its
  prompt on the due date; tap Skip
- Phase 8 report ("paid vs skipped") should count Transactions rows by
  Favorite ID (one per Link ID) and Last Skipped in the month

## Notes / decisions made during build
- Formulas written by script must be written while the sheet locale is
  en_US (comma syntax); in id_ID they are a parse error. Template is built
  in en_US and switched to id_ID at the end; Sheets converts parsed formulas
- doPost must return HtmlService output, NOT ContentService (302 → Telegram
  retries forever and blocks newer messages). After a stuck queue, run
  setWebhook once (it drops pending updates)
- Deployment lesson: if the bot is silent but testDoPost works, the webhook
  points at a different or outdated deployment. Fix: Manage deployments →
  Edit → New version → copy that /exec URL into WEB_APP_URL → setWebhook
- Always update the EXISTING deployment (Edit → New version), never
  "New deployment", so the webhook URL stays the same
- Script Properties: BOT_TOKEN, GEMINI_KEY, WEB_APP_URL, WEBHOOK_KEY (auto),
  MAIN_SHEET_ID, TEMPLATE_ID (set by createTemplate), ALLOWED_CHAT_IDS
  (fallback only), RECENT_UPDATES, DELETE_QUEUE, REMINDER_STATE and
  FAV_PROMPTS (bot-written). Reserved:
  ARCHIVE_FOLDER_ID, RECEIPTS_FOLDER_ID. PASSWORD_HASH is no longer used
  (the password lives in Settings) and can be deleted
- Every code change needs Deploy → Manage deployments → Edit → New version;
  "it doesn't work" after a push was twice just a missing new version
- Testing approach: pure logic runs in Node before pushing, plus a fake
  end-to-end run (fake SpreadsheetApp/Cache/Telegram) of whole
  conversations; the real sheet is then checked with the editor tests
- Owner decisions in Phase 4: several names or "piutang split" = group; commas
  separate names, a full stop ends the note; a split includes me only with
  aku/saya; payments go to the nearest due date first, then the oldest;
  missing amounts are asked, not errors; /piutang and /hutang lists
- Owner decisions in Phase 2: no balances on "✅ Saved"; /saldo delete fixed
  at 60s (no setting); password in the Settings tab; expense buttons limited
  to Spending Wallet Groups
- Webhook secret is passed as ?key= in the URL because Apps Script can't read
  Telegram's secret-token header
- Display names default to "Me" / "Partner" (user's choice); editable in Users
- Script writers must never write into formula columns; find the next row by
  the ID/key column (lastDataRow_), not getLastRow
- Functions ending in _ are private (hidden from the editor Run dropdown)
- withScriptLock_(fn) in Main.gs is the lock helper for all later writes
