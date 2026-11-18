# MonetaBot — owner's guide

A Telegram bot for the two of us to log money. Each of us chats with the bot
privately; both chats write to the same Google Sheet ("MonetaBot Main").

- Code: Google Apps Script (this repo's `src/` folder, uploaded with clasp)
- Data: the main Google Sheet + the MonetaBot folder in Google Drive
- Secrets (bot token, Gemini key, sheet IDs): Apps Script → ⚙️ Project
  Settings → **Script Properties**. Never paste them into a chat.
- What was built and why: `PROGRESS.md`. Full requirements: `SPEC.md`.

---

## 1. Deploy an update

Do this every time the code changes.

1. Open PowerShell and go to the Moneta folder:
   `cd <path to your Moneta folder>`
2. Get the latest code: `git pull`
3. Upload it to Apps Script: `clasp push`
   (if PowerShell says scripts are disabled, use `clasp.cmd push`;
   if it says "Skipping push", use `clasp push --force`)
4. Open the Apps Script editor → **Deploy → Manage deployments** →
   ✏️ pencil on the existing deployment → **Version: New version** → **Deploy**.
   Always update the existing deployment. A *new* deployment gets a new web
   address and Telegram would stop reaching the bot.
5. If the update notes say "run upgradeSheets": in the editor pick
   **upgradeSheets** in the function dropdown (next to ▶ Run) and click
   **Run**. It is safe to run any time; it never changes your data.

Tip: the dropdown shows the functions of the file you have open. Always check
it shows the function you want before clicking Run.

## 2. Add a wallet

**From Telegram (easiest):** `/wallet add Jenius` — the bot asks for the
group(s) and type. Then type its starting balance in the Wallets tab
(Opening Balance column).

**In the sheet:** add a row to the **Wallets** tab:

| Column | What to type |
|---|---|
| Wallet | The name you will type in messages, e.g. `Jenius` |
| Wallet Group | Pick from the dropdown (e.g. Spending). New groups: Settings tab → Wallet Groups list |
| Wallet Type | `Cash` for money accounts; `Emas` / `Saham` / `Others` for investment wallets |
| Investment Category | Only for investment wallets |
| Opening Balance | The balance today |
| Owner | You, your partner, or Shared |
| Receipt Issuer | Optional: e.g. `GoPay` so receipts from that app pick this wallet |
| Active | `Yes` |

Leave **Current Balance** alone (green header = formula). The bot reads the
tab every time, so the new wallet works right away.

Categories work the same way: `/category add Pets`, or a new row in the
**Categories** tab (Monthly Budget empty = no limit).

## 3. Change the password

The password protects /saldo (and /budget, /adjust, /open, /closing,
/setsheet when switched on in Settings). Numbers only.

- **From Telegram:** `/changepass` → current password → new password → again.
  Every message with the password is deleted right away.
- **Forgot it:** open the main sheet → **Settings** tab → the **Password**
  row → type a new number in Value. It works immediately.
- Too many wrong tries locks it for 15 minutes.
- Turn the password on/off per command in the Settings tab
  ("Password for /saldo", "Password for /budget", …).

## 4. The bot stops replying

Go down this list; stop when it works again.

1. **Is it everyone or only one person?** If only your partner: check their
   chat ID is in Settings → Users with Active = Yes, then run
   **clearConfigCache** in the editor.
2. **A closing running?** During /closing (1–2 minutes) the bot answers
   "closing is running, send again in 2 minutes". Wait and resend.
3. **Look at what Telegram sees:** run **getWebhookInfo** in the editor and
   read the log.
   - `last_error_message` mentions 302 / 401 / 404: the deployment is wrong.
     Do step 4 of "Deploy an update" (new version of the *existing*
     deployment), then run **setWebhook**.
   - `pending_update_count` is high: messages are queued; run **setWebhook**
     (it clears the queue — anything still waiting must be sent again).
4. **Look at what the bot saw:** run **showRecentUpdates** — the last 10
   things the bot did. "BLOCKED chat ID" = that chat isn't in Users.
5. **Errors:** open the main sheet → **Logs** tab (newest at the bottom).
6. **After changing Google accounts or permissions:** run any function in
   the editor once (e.g. testConfig) and click **Allow** on the permission
   screen, then make a new deployment version.
7. **Auto-delete or reminders stopped:** run **installCleanupTrigger** and
   **installReminderTrigger** once (they replace old copies, never
   duplicate). There must be exactly two triggers (⏰ Triggers in the editor).
8. **Closing says "on hold":** a closing stopped halfway. Follow the steps
   in the bot's message (use the archive copy with `/setsheet`), or run
   **clearClosingHold** only if you are sure the main sheet is fine.

## 5. Monthly routine

1. Last day of the month: the bot reminds you. Update investment prices
   (`/inv update`), check everything is logged.
2. Tap **🔒 Start closing** on the reminder (or send `/closing`) → read the
   summary → 🔒 Close → password. The month moves to an
   archive sheet in Drive (MonetaBot/Archive/<year>) and you get the report.
3. `/report` shows any month; `/report bca` or `/report spending` shows one
   wallet or wallet group.
4. Closing is final (no reopen). Entries dated in a closed month are blocked;
   use `/adjust` to correct a balance instead.

## 6. Editor functions you may need

| Function | When |
|---|---|
| upgradeSheets | After an update that says so; also rebuilds the Dashboard |
| clearConfigCache | After editing Users or Settings, to apply at once |
| setWebhook / getWebhookInfo | Bot not reachable (see section 4) |
| showRecentUpdates | See the last 10 things the bot handled |
| installCleanupTrigger / installReminderTrigger | Triggers missing |
| sendRemindersNow | Send today's reminders now (testing) |
| clearClosingHold | Only after a stopped closing, when the sheet is fine |
| testParser, testClosing, … | Checks; each ends with PASS or FAIL in the log |

Never run **createTemplate** or **resetSheets** on a working setup: they are
for building everything from scratch (they refuse to run when sheets exist).

## 7. Limits to know

- **Gemini (free tier):** used only to read messages the rules can't and bill
  photos — never to choose categories. The free tier allows a limited number
  of requests per minute and per day; when it's busy or down the bot retries,
  then falls back to asking you, and logs it in the Logs tab. Nothing is
  lost. The model names are in the Settings tab (Gemini Model / Gemini
  Vision Model) if Google renames them. Key: Script Property `GEMINI_KEY`
  (get one at aistudio.google.com → Get API key).
- **Apps Script:** each run may take at most 6 minutes; time triggers have a
  daily runtime budget (~90 minutes), which is why the 1-minute cleanup
  trigger exits at once when it has nothing to do. Reminders run from one
  hourly trigger, so "08:00" means some time between 08:00 and 09:00.
- **Telegram:** the bot can only delete messages younger than 48 hours.
- **Amounts** are whole Rupiah. Investment prices with decimals (reksadana
  NAV) are stored exactly but shown rounded in the sheet.
