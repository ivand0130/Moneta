# PROGRESS.md

Claude Code updates this file at the end of every phase.

## Current phase
Phase 0 — code pushed; waiting on manual setup + Telegram test
Next: Phase 1 — Sheet template

## Done
- Phase 0 (skeleton, no transaction logic)
  - clasp linked to standalone project (script ID in .clasp.json, rootDir src/)
  - appsscript.json: Asia/Jakarta, V8, web app (execute as me, anyone),
    scopes: external_request, spreadsheets, drive, script.scriptapp
  - doPost: webhook ?key= check → update_id dedupe (CacheService 6h, inside
    LockService) → allow-list (ALLOWED_CHAT_IDS Script Property) → router
  - Blocked chat IDs are ignored silently; last 10 webhook outcomes are kept
    in the RECENT_UPDATES Script Property (run showRecentUpdates in Main.gs)
    because Apps Script hides console logs of web-app runs made by Telegram
  - /start and placeholder /help; other text gets a "still being built" reply
  - Editor helpers: setWebhook (creates WEBHOOK_KEY), getWebhookInfo (key
    hidden), deleteWebhook
  - Tests.gs: testConfig, testDedupe, testAllowList, testSendHello
  - Stub .gs files for every later module
  - git repo initialised

## Known issues
- Errors go only to the execution log until the Logs tab exists (Phase 1)
- The Apps Script project is titled "Daniel.ivan" (created from the home
  folder in an earlier attempt); rename it to "MonetaBot" in the editor.
  There is also an unused "Untitled project" in the account that can be deleted

## Notes / decisions made during build
- Script Properties: BOT_TOKEN, GEMINI_KEY, WEB_APP_URL, WEBHOOK_KEY (auto),
  ALLOWED_CHAT_IDS (Phase 0 only). Reserved: MAIN_SHEET_ID,
  ARCHIVE_FOLDER_ID, TEMPLATE_ID, PASSWORD_HASH
- Webhook secret is passed as ?key= in the URL because Apps Script can't read
  Telegram's secret-token header
- Logs tab headers expected by writeLogRow_ (Sheets.gs): Timestamp, Level,
  Source, Message, Details — Phase 1 template must use these names
- Functions ending in _ are private (hidden from the editor Run dropdown)
- withScriptLock_(fn) in Main.gs is the lock helper for all later writes
