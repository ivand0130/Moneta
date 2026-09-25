# PROGRESS.md

Claude Code updates this file at the end of every phase.

## Current phase
Phase 1 — DONE (2026-09-25). Main sheet + template built, all tests pass.
Next: Phase 2 — Core logging: income, expense, transfer

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

## Known issues
- Conversion (debt → income/expense) rows: how they count in totals and
  balances is decided in Phase 4. Dashboard cash flow counts only
  Type = Income / Expense
- Price columns use Rp#,##0, so fractional unit prices (e.g. reksadana NAV)
  display rounded (the stored value is exact)
- Closed-month protection is not built yet (Closing phase)
- Partner's chat ID may still need to be typed into Settings → Users

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
  (fallback only), RECENT_UPDATES (bot-written). Reserved: ARCHIVE_FOLDER_ID,
  PASSWORD_HASH
- Webhook secret is passed as ?key= in the URL because Apps Script can't read
  Telegram's secret-token header
- Display names default to "Me" / "Partner" (user's choice); editable in Users
- Script writers must never write into formula columns; find the next row by
  the ID/key column (lastDataRow_), not getLastRow
- Functions ending in _ are private (hidden from the editor Run dropdown)
- withScriptLock_(fn) in Main.gs is the lock helper for all later writes
