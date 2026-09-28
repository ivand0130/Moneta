# PROGRESS.md

Claude Code updates this file at the end of every phase.

## Current phase
Phase 2B — code pushed (2026-09-28), waiting on upgradeSheets + deploy +
Telegram test.
Phase 2 — DONE (2026-09-28).
Next after 2B: Phase 3 — Adjust balance and transfers with fees/partial
expense.

## Deferred (agreed, must be picked up later — do not drop)
- AI natural-language PARSING fallback: when the rule-based parser can't read
  a message, ask Gemini to extract type/amount/wallet/date/note (JSON only),
  then show the normal preview. Phase 2 uses Gemini for category suggestion
  only. Pick up in Phase 3 or later, before the OCR phase (it shares AI.gs).

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
- Phase 2B (pushed, being tested): /budget and /budget [category]
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
  - Category mapping: #tag → longest keyword → Gemini (AI.gs, JSON only,
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

## Known issues
- Conversion (debt → income/expense) rows: how they count in totals and
  balances is decided in Phase 4. Dashboard cash flow counts only
  Type = Income / Expense
- Price columns use Rp#,##0, so fractional unit prices (e.g. reksadana NAV)
  display rounded (the stored value is exact)
- Closed-month protection is not built yet (Closing phase)
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
  (fallback only), RECENT_UPDATES and DELETE_QUEUE (bot-written). Reserved:
  ARCHIVE_FOLDER_ID, RECEIPTS_FOLDER_ID. PASSWORD_HASH is no longer used
  (the password lives in Settings) and can be deleted
- Every code change needs Deploy → Manage deployments → Edit → New version;
  "it doesn't work" after a push was twice just a missing new version
- Testing approach: pure logic runs in Node before pushing, plus a fake
  end-to-end run (fake SpreadsheetApp/Cache/Telegram) of whole
  conversations; the real sheet is then checked with the editor tests
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
