# Product Requirement Prompt: Personal Money Tracker Bot

## 0. Final Decisions (already agreed; do not re-ask)
- AI: Gemini API free tier (Flash) for parsing, category suggestion and
  GoPay OCR; keyword/manual fallback always available
- Users: me and my partner each chat with the bot PRIVATELY; both private
  chats read and write the SAME Google Sheet. "Logged By" comes from the
  sender's chat ID via the Users table in Settings
- Wallets, categories, contacts, users and GoPay names are all configured in
  the sheet, never hardcoded. The logic reads them at runtime
- Bot replies in English; inputs can be English or Bahasa Indonesia
- Adjustments are excluded from income/expense totals
- Investment sales use FIFO by default
- No /reopen: closing is final; entries dated in a closed month are blocked
- Pending confirmations use CacheService (10-minute expiry), not a sheet tab
- Balances, remaining amounts and gain/loss use sheet formulas where possible
  so manual edits stay correct; IDs and statuses are set by the script
- Password message is auto-deleted after reading
- Sensitive amounts are hidden with Telegram spoiler formatting, and the
  /saldo reply auto-deletes after a fixed 60 seconds (see Section 13)
- The /saldo password is kept in the Settings tab ("Password", numbers
  only), read fresh each time, so it can be reset in the sheet (Section 13)
- Monthly report includes a breakdown by user
- Photos that are not GoPay Split Bills are read as receipts: the total is
  logged as an Expense and the image is saved to Drive (Section 24). A photo
  goes to the GoPay Split Bill flow only if the issuer is GoPay AND it has a
  participant list
- Budgets are set per category in the Categories tab (Monthly Budget, with
  live Spent and Remaining formula columns); empty/0 = no limit; a separate
  budget message follows each save and can auto-delete at the end of the
  day ("Budget auto-delete" = Yes/No) (Section 25)
- /saldo and /budget each have a Settings switch to turn the password on or
  off (Section 13)
- Investment prices are manual only for now

## 1. Role & Goal
You are an experienced developer. Help me build a personal money tracking
system where my partner and I log transactions through Telegram, the data is
stored in Google Sheets, and the bot handles categories, multiple wallets,
transfers, hutang/piutang, investments, recurring transactions, GoPay Split
Bill OCR, reminders, monthly closing, and reports.

## 2. Background
- I currently track money in: Money Lover app
- Problem: I can track expenses and income, but the data is not detailed
  enough, so I can't properly evaluate my finances
- Users: Me & Partner (both can log transactions; each entry records who logged it)
- Location & currency: Indonesia, IDR (Rp)

## 3. Tech Stack
- Chat platform: Telegram
- Backend: Google Apps Script (web app + webhook + time-driven triggers)
- The script must be a standalone Apps Script project (not bound to one sheet)
  that opens the main sheet by ID from settings, so the main sheet URL can be
  changed without redeploying
- Storage: Google Sheets (main sheet) + Google Drive (archives, images)
- AI (category mapping, natural-language parsing, and OCR of images):
  Gemini API (Flash model, free tier), called via UrlFetchApp. Use a
  keyword-based or manual fallback if the AI fails, hits a rate limit, or is
  turned off in Settings
- Investment prices: manual input by default. Explain which assets can be
  auto-fetched reliably for free
- Constraints: free tools preferred; if paid tools give a clearly better
  experience, the max budget is Rp50.000–100.000 per month

## 4. Transaction Types
The bot must support these inputs:

| Type                       | Meaning                                                   | Example input                                   |
|----------------------------|-----------------------------------------------------------|-------------------------------------------------|
| Income                     | Money received                                            | +5jt gaji BCA                                   |
| Expense                    | Money spent                                               | 50rb makan siang di KFC                         |
| Transfer                   | Move money between my own wallets (not income/expense)    | transfer 1jt BCA ke GoPay                       |
| Transfer + partial expense | Transfer where part is an expense (admin fee, or part spent directly) | transfer 1jt BCA ke GoPay dipotong 2.5rb |
| Adjust balance             | Correct a wallet balance to the actual amount             | /adjust BCA 10.200.000                          |
| Piutang (lend)             | I lend money to someone                                   | piutang 500rb Budi                              |
| Hutang (borrow)            | I borrow money from someone                               | pinjam 1jt dari Andi                            |
| Long-term hutang/piutang   | No due date, reminded monthly                             | piutang jangka panjang 10jt Budi                |
| Group piutang              | Money lent to several people at once                      | piutang grup 600rb Budi, Andi, Citra            |
| Split bill                 | I paid for a group including myself                       | split 400rb makan Budi Andi termasuk saya       |
| GoPay Split Bill (image)   | Send a GoPay Split Bill screenshot to log a split bill    | [GoPay Split Bill image]                        |
| Receipt (image)            | Photo of any other bill; the total becomes an Expense     | [receipt photo] caption: BCA                    |
| Budget check               | Show budget, spent and remaining per category             | /budget  or  /budget food                       |
| Pelunasan (settlement)     | Full or partial payment of hutang/piutang                 | Budi bayar piutang 200rb                        |
| Add to existing            | Increase an existing open hutang/piutang                  | tambah piutang Budi 100rb                       |
| Convert / close debt       | Close a hutang/piutang by turning it into income/expense  | tutup piutang PTG-001 jadi pengeluaran          |
| Investment purchase        | Move money from a wallet into an investment               | investasi 5jt BCA ke Saham BBCA 10 lot          |
| Investment (unit-based)    | Purchase by gram/unit, price per unit, or total           | beli emas 2gr 1.350rb/gr dari BCA               |
| Investment sale            | Sell all or part of an investment                         | jual BBCA 5 lot harga 10.200 ke BCA             |
| Price update               | Update the current price of one or many investments       | /inv update BBCA 9.800                          |
| Transaksi Favorit          | Saved usual transaction (weekly/monthly)                  | /fav listrik  or  bayar rekening listrik        |
| Closing                    | Close the month so its report is final                    | tutup transaksi bulan September 2026            |
| Change main sheet          | Point the bot to another Google Sheet                     | /setsheet [google sheets url]                   |
| Download template          | Get a fresh copy of the main sheet template               | /template                                       |

- Understand Indonesian amount formats: 50000, 50.000, 50k, 50rb, 1.5jt, 2juta
- Keep the command format and keywords shown in this document
- Inputs may be in English or Bahasa Indonesia (or mixed); bot replies are in English
- Support both slash commands and natural-language style
- Transaction date is optional; if empty, date = today
  (e.g. "50rb bensin kemarin" or "50rb bensin 20/09" should also work)

## 5. Category Mapping
- Every Income and Expense transaction (including expense portions of
  transfers, split bills, and conversions) must have a category
- Mapping order:
  1. Category explicitly written by the user (e.g. "#food")
  2. Keyword match from the Categories tab (e.g. "KFC" → Food)
  3. AI suggestion based on the note (e.g. "beli obat di Kimia Farma" → Health)
  4. If still unclear → ask me to pick from a category list (inline buttons)
- AI-mapped and keyword-mapped categories are shown in the preview so I can
  confirm or change them before saving
- When I correct a category, offer to save the keyword so the same note is
  mapped automatically next time
- Categories are editable in the Categories tab (name, type, budget, keywords)
- Investments have their own categories (see Section 8)

## 6. Multiple Wallets & Grouping
- Wallets are grouped into Wallet Groups, for example:
  | Wallet | Wallet Group |
  |--------|--------------|
  | BCA    | Spending     |
  | GoPay  | Spending     |
  | Cash   | Spending     |
  | IPOT   | Investment (uninvested cash / RDN) |
  | Jago   | Savings      |
  These are sample rows only. Wallets are NEVER hardcoded: the bot always
  reads wallet names, groups, owners and balances from the Wallets tab, so I
  can add, rename or deactivate wallets in the sheet and the logic follows
- Investment assets are held in investment category wallets (see Section 8),
  which are never merged with other wallets and are shown separately everywhere
- Wallet selection rules:
  1. If I mention a wallet (e.g. "50rb makan BCA") → use it and map it to its
     group automatically
  2. If I don't mention a wallet but a default mapping exists (e.g. category
     Food → default wallet GoPay) → show the mapped wallet in the preview and
     require confirmation before saving. I can confirm, cancel, or mention
     the correct wallet
  3. If no mapping exists → the bot asks me to choose a wallet (inline buttons)
- Each wallet has an opening balance and a running balance
- Transfers between wallets change both balances but do not count as
  income or expense
- Data display:
  - /saldo shows balance per wallet, subtotal per wallet group, investment
    value per investment category, and grand total (password required)
  - Reports can be filtered by wallet or wallet group
  - /saldo [wallet group] and /saldo [owner] filter the balance view
  - Each wallet shows its owner (Me / Partner / Shared)

### Adjust Balance
- /adjust [wallet] [actual balance], e.g. "/adjust BCA 10.200.000"
- The bot calculates the difference from the recorded balance and shows it
  in the preview before saving
- Saved as an Adjustment entry with the difference amount
- Adjustments are EXCLUDED from income and expense totals (category
  "Adjustment", Type = Adjustment)
- Adjustments are listed separately in the monthly report

### Transfer with Partial Expense
- A transfer can include an expense portion, for example:
  - Admin/transfer fees (e.g. BI-FAST Rp2.500, top-up fee Rp1.000)
  - Part of the transferred money is used directly for spending
- Recording logic:
  - Save as linked entries sharing one Link ID (e.g. LNK-0005):
    1. Transfer row: the amount that actually moves between wallets
    2. Expense row(s): the expense portion, with category and note
  - Source wallet decreases by the total (transfer + expense)
  - Destination wallet increases only by the transferred portion
  - Only the expense portion counts in expense totals and reports;
    the transfer portion never counts as income or expense
- Sample inputs:
  - Admin/fee:
    - Transfer BCA ke IPOT 1jt dipotong admin 15k
    - Transfer BCA ke IPOT 1jt admin 15k
  - Directly used:
    - Transfer BCA ke IPOT 1jt, 500k untuk makan siang
    - Transfer BCA ke GoPay 100k, 20k untuk beli barang
- The bot must ask/confirm:
  - Whether the expense is taken from the source or the destination wallet
    (e.g. fee deducted before sending vs. money spent after arriving)
  - The category of the expense portion (default for fees: "Admin & Bank Fees",
    otherwise keyword/AI mapping)
  - If the input only says "transfer 1jt, sampai 997.500", calculate the
    difference (Rp2.500) and ask whether it's a fee
- Saved favorites can include a default fee (e.g. top-up GoPay always Rp1.000)
- /undo on any linked entry asks whether to remove the whole linked group

## 7. Hutang/Piutang Logic
- Each hutang/piutang gets a unique ID (e.g. PTG-001, HTG-001)
- Track: counterparty name, original amount, added amounts, paid amount,
  remaining balance, due date, status, transaction date (if empty, date = today),
  wallet used, term (short / long), category
- Status values: Open, Partial, Paid, Converted
- Partial payments reduce the remaining balance; status changes to Paid when
  the balance reaches 0
- "Add to existing" increases the balance of an existing Open/Partial record
  instead of creating a new one
- Paid and Converted records cannot be changed. Adding to them creates a
  new record instead
- Keep a full history of every payment and addition, linked by ID
- Settlements count as cash flow: receiving piutang = money in, paying
  hutang = money out, applied to the selected wallet
- Open hutang/piutang carry over to the new month after closing

Long-term hutang/piutang:
- No due date required
- Reminded monthly instead of daily/weekly

Group piutang:
- One parent record with a sub-record per person (e.g. PTG-010-A, PTG-010-B)
- Each person's share can be equal or custom
- Each person settles separately; the parent is Paid when all are Paid

Split bill (I paid for friends, including myself):
- My share is recorded as an Expense (with category)
- Each friend's share becomes a piutang
- All entries share one Link ID
- Support equal split or custom amounts per person
- Input can be text or a GoPay Split Bill image (see Section 10)

Convert / close hutang/piutang:
- Command to close an open hutang/piutang without payment, e.g. when I decide
  a friend doesn't need to pay back, or the "loan" was actually a treat
- Piutang converted → creates an Expense transaction for the remaining amount
- Hutang converted → creates an Income transaction for the remaining amount
- The bot must ask for (or AI-suggest) a category and confirm before converting
- Status becomes Converted, linked to the new Income/Expense Trx ID

## 8. Investment Tracker

### Structure
- All investments are recorded in a separate Investments tab
- Each investment category is treated as its own wallet and is never merged
  with other wallets, for example:
  | Investment Category (= Wallet) | Unit type    | Example asset        |
  |--------------------------------|--------------|----------------------|
  | Saham                          | lot / share  | BBCA, TLKM           |
  | Emas                           | gram         | Antam, Pegadaian     |
  | Reksadana                      | unit         | RDPU X, RDSaham Y    |
  | Crypto                         | coin         | BTC, ETH             |
  | Deposito / Obligasi            | nominal      | SBR, ORI             |
- Each investment category has its own category for reporting
- Platform/broker (e.g. IPOT, Pluang, Bibit) is stored as information only

### Purchase flow
- "Add investment" = money moves from a source wallet (e.g. BCA) into an
  investment category wallet (e.g. Saham)
- Each purchase creates a new row in the Investments tab (one row per
  purchase, even for the same asset)
- The source wallet decreases; the investment wallet increases by the
  acquisition cost
- Investment purchases count as Transfer (not expense) and appear in
  reports as "Invested this month" 


### Unit-based input (e.g. gold per gram)
- Input can be any two of: quantity, price per unit, total
  - "beli emas 2gr 1.350rb/gr" → total Rp2.700.000
  - "beli emas 2gr total 2.700rb" → price per gram Rp1.350.000
  - "beli emas 2.700rb harga 1.350rb/gr" → quantity 2 gr
- The bot calculates the missing value and confirms it in the preview
- The same rules apply to price updates and sales

### Investment data (per row)
- Investment date
- Asset name, investment category, platform
- Quantity and unit
- Acquisition price per unit and acquisition cost (total)
- Current price per unit and current value (formula: quantity × price)
- Increase/decrease in Rp and % (formula)
- Last price update date
- Status: Holding / Partially Sold / Sold
- Source wallet and Link ID

### Price updates
- Reminder on the last day of the month at 12:00 WIB to update all
  investment prices, before the closing reminder
- The last price entered in a month is treated as that month's final
  investment value.
- Single update: "/inv update BBCA 9.800" or "/inv update emas 1.380rb/gr"
- Bulk update: several lines in one message, e.g.
    /inv update
    BBCA 9.800
    TLKM 3.100
    emas 1.380rb/gr
    RDPU X 1.520
  → the bot shows all changes in one preview for confirmation
- Bulk edit is also possible directly in the Investments tab; the bot must
  still read it correctly
- If an asset name matches several rows (e.g. several gold purchases), the
  price update applies to all rows of that asset, after confirmation
- Every update is saved to the Price History tab

### Selling
- Full or partial sale: "jual BBCA 5 lot harga 10.200 ke BCA"
- The bot shows: quantity sold, proceeds, fees, realized gain/loss, and the
  destination wallet
- If the asset has several purchase rows, use FIFO by default (oldest
  purchase first), with a button to choose specific rows instead
- Proceeds move from the investment wallet to the destination wallet
- Realized gain/loss is recorded separately from unrealized gain/loss
- Status becomes Partially Sold or Sold; sold rows stay for history

### Closing & reporting
- On closing, snapshot each investment's final value into Price History
- Investments are carried over to the new main sheet after closing
- The monthly report and dashboard show:
  - Total invested and total sold this month
  - Portfolio value per investment category (opening, ending, change)
  - Unrealized gain/loss per category and in total (Rp and %)
  - Realized gain/loss this month
  - Month-over-month change of the portfolio value

## 9. Transaksi Favorit (Recurring / Usual Transactions)
- Save usual transactions as templates
- Favorite components:
  - Name (mandatory, used as the key to find the favorite)
  - Value (mandatory)
  - Category (mapped automatically or manual input)
  - Payment date (optional; no date = no reminder)
  - Type, wallet, to wallet (for transfers), default fee [optional]
- Examples: rekening listrik, internet, kos, BPJS, investasi rutin, top-up GoPay
- Each favorite is listed in the Favorites tab. Favorites added or edited
  directly in the sheet are recognized by the bot as well
- Commands:
  - /fav: list all favorites as buttons, tap to log
  - /fav add, /fav edit, /fav delete
- Adding examples:
  - /fav add Bayar Token Listrik 100k setiap tanggal 1 September 2026
  - /fav add Bayar cicilan mobil 100k → no date = no reminder
  - /fav add Belanja bulanan 200k
- Editing: mention only the part to change, found by name
  - /fav edit belanja bulanan jadi setiap tanggal 2 September
  - /fav edit bayar cicilan mobil jadi 2jt
- Scheduled favorites: on the scheduled date, the bot sends a prompt
  ("Pay rekening listrik Rp350.000 from BCA today?") with
  [Yes] [Change amount] [Skip] — never saved automatically without confirmation
- Variable-amount favorites (e.g. electricity) ask for the amount each time
- Anything unclear is confirmed before saving

## 10. GoPay Split Bill OCR
(Photos are first routed as described in Section 24; this section applies
only when the image is a GoPay Split Bill.)
- I can send a screenshot of a GoPay Split Bill to log a split bill
- The bot reads the image (AI vision recommended) and extracts:
  - Merchant / bill title and date (if missing → today)
  - Total bill, including tax, service charge, discounts, and delivery fee
  - Who paid the bill (me or someone else)
  - Each participant's name and share amount
  - My share
- Recording logic:
  - If I paid: my share = Expense; each other participant's share = Piutang
  - If someone else paid: my share = Hutang to that person
    (ask: if I already paid them back, record it as an Expense instead)
  - All entries share one Link ID
  - Category for my share is mapped from the merchant/title (keyword, then AI)
  - Wallet is asked if not mentioned in the caption
- Name matching:
  - GoPay names are matched to existing counterparty names using the
    Contacts tab (e.g. "Budi Santoso" → Budi)
  - Unknown names → ask whether to use as-is, map to an existing contact,
    or create a new contact
  - The bot must identify which participant is the sender: each user's
    GoPay name is stored in the Settings tab (editable in the sheet), and
    "me" = the user who sent the image
- The photo caption can add or override details (e.g. "BCA #food")
- Always show a full preview before saving, highlighting uncertain values:
  "Total read as Rp385.500 (low confidence). Correct? [Yes] [Edit]"
- If the shares don't add up to the total → show the difference and ask
- If the image is unreadable → ask me to resend it or type the split bill
- The image is saved to Google Drive and linked in the transaction rows
- Duplicate check: same total + participants + date → ask before saving
- OCR failure must never block logging; fall back to manual input

## 11. Monthly Closing
- Command: "tutup transaksi bulan September 2026" or /closing [month] [year]
- Reminder on the last day of the month at 18:00 WIB to start closing
- Before closing, the bot checks that investment prices were updated this
  month, shows a summary, and asks for confirmation
- After closing:
  - That month's report is final and saved in the Monthly Report tab
  - A new Google Sheet is generated in the archive folder, containing that
    month's complete data
  - Transaction data on the main sheet is cleared to start the new month
  - Carried over to the new month: wallet ending balances (as opening
    balances), open hutang/piutang, investments, favorites, categories,
    contacts, and settings
  - New entries dated in a closed month are BLOCKED. The bot explains why and
    offers to log it with today's date or to use /adjust instead
- There is NO /reopen command. Closing is final

## 12. Sheet Management
- /setsheet [url]: change the main Google Sheet the bot uses
  - Requires the password
  - The bot checks that it can access the sheet and that all required tabs and
    columns exist; if not, it lists what's missing and offers to create them
  - Shows the sheet name and asks for confirmation before switching
- /setarchive [folder url]: change the Drive folder used for closing archives
- /setreceipts [folder url]: change the Drive folder used for bill images
- /template: send a link to make a copy of the main sheet template
  - /settemplate [url]: change which sheet is used as the template
  - Option to create a fresh copy directly in my Drive and send its link
- Main sheet, archive folder, and template URLs are stored in script
  properties so they survive sheet changes

## 13. Security
- Only allowed chat IDs can use the bot
- /setsheet always requires the password; /saldo and /budget require it
  when their switch in Settings is on (see below); default password 0000
- /changepass to change the password; the bot reminds me to change the
  default on first use
- The password is stored in the Settings tab ("Password" row, numbers only,
  plain text) so it can be reset in the sheet if forgotten (owner's decision;
  anyone who can open the sheet already sees every balance). It is read
  fresh from the sheet every time, never cached. Input with spaces or
  letters is rejected
- A wrong password asks again (up to 5 tries, then a 15-minute lock), so a
  retry is never read as a transaction
- Delete the message containing the password after it's read
  (deleteMessage works in private chats)

### Hiding sensitive amounts
- Spoiler formatting: in replies to /saldo, /inv, /open, /report, /budget
  and the budget message after saving, every
  Rp amount, quantity value and gain/loss is wrapped in Telegram spoiler
  formatting (HTML parse mode, <tg-spoiler>), so it stays blurred until
  tapped. Everyday confirmations (e.g. "✅ Saved as TRX-0123") and previews
  keep plain amounts so logging stays fast
- Spoilers can be turned on/off in Settings ("Hide amounts" = yes/no)
- Auto-delete: the /saldo reply is deleted automatically after a FIXED 60
  seconds (owner's decision; there is no delay setting)
  - The bot stores the chat ID, message ID and delete time in a queue
    (CacheService, with a Script Properties backup)
  - A cleanup trigger runs every minute and exits immediately when the queue
    is empty to save quota
  - Timing: each run also takes messages due within the next minute and
    waits until their exact time, so a 60-second message disappears at
    about 60 seconds. This is fine for the quota (~90 min/day of trigger
    runtime) because only on-demand replies (/saldo, /budget) use it
  - If deletion fails (e.g. message already deleted), log it and move on
  - The bot adds a small note under the reply, e.g.
    "🕒 This message will be deleted in 60s"
- Password switches in Settings: "Password for /saldo" (default Yes) and
  "Password for /budget" (default No). No = the reply is shown right away,
  still with hidden amounts and auto-delete. Read fresh, so a change applies
  immediately. One switch for both users
- The same queue is used for budget messages (Section 25): the /budget
  reply is deleted after 60 seconds; the budget message after each save is
  deleted at the END OF THE DAY (23:59 Asia/Jakarta), in one batch, so the
  many messages that follow expenses never make the trigger wait

## 14. Confirmation & Error Handling
The bot must ask me questions instead of guessing when:
- The input format is unclear or the amount can't be read
  → reply with the correct format and an example
- The number format is wrong or ambiguous (e.g. "2.00.000", "1,5,000", "50.5rb")
  → show how it was read and ask me to confirm or re-enter
- A required parameter is missing → ask for the missing part
- The category or wallet was mapped automatically → show it in the preview
- No wallet mapping exists → ask me to choose a wallet
- A name matches multiple open records (e.g. two open piutang for "Budi")
  → show the list with IDs and remaining balances, then ask which one
- A name doesn't match any open record during pelunasan or "add to existing"
  → ask: "No open record for [name]. Create new, or check the spelling?"
- A payment is larger than the remaining balance
  → ask whether to record the overpayment or correct the amount
- The amount is unusually large (above Rp5.000.000)
  → ask for confirmation before saving
- A possible duplicate is detected (same amount + note within 5 minutes)
  → ask whether to save it again
- A wallet balance would go negative → warn and ask to confirm
- The entry is dated in a closed month → block it and offer today's date or /adjust
- A transfer's expense portion is larger than or equal to the total amount
  → ask me to correct the numbers
- A transfer's received amount differs from the sent amount
  → ask whether the difference is a fee, a partial expense, or a typo
- Investment input has fewer than two of quantity / price per unit / total
  → ask for the missing value
- A calculated investment quantity or price looks unusual (e.g. far from the
  last price) → ask to confirm
- Sale quantity is larger than the quantity held → ask me to correct it
- Bulk price update contains an unknown asset name → list it and ask whether
  to skip, correct, or create it
- OCR confidence is low, shares don't match the total, or names are unknown
  → highlight and ask
- /setsheet URL is inaccessible or the structure doesn't match → explain and
  do not switch

Confirmation rules:
- Show a preview of what will be saved (type, amount, category, wallet,
  wallet group, date, note, and all linked entries), with
  [Yes] [No] [Edit] buttons
- Store pending confirmations temporarily; cancel them after 10 minutes with
  no response
- /undo to delete the last saved entry (or its whole linked group), after
  confirmation

## 15. Reminders
- Daily check at 08:00 WIB: short-term hutang/piutang still open after 3 days
  from the transaction date (or due soon / overdue if a due date is set)
- Weekly summary every Monday at 08:00 WIB: all open hutang/piutang.
  On that day, the daily reminder is not sent
- Monthly reminder on the 1st at 08:00 WIB for long-term and group
  hutang/piutang. On that day, the daily reminder is not sent. If the 1st is
  a Monday, weekly and monthly reminders are merged into one message
- Scheduled Transaksi Favorit prompts on their set dates
- Last day of the month:
  - 12:00 WIB: investment price update reminder, listing all held assets and
    their last prices
  - 18:00 WIB: reminder to start closing
- Reminder message shows: ID, name, type, remaining balance, due date (if any),
  days open / overdue
- Avoid spam: combine reminders into one message per time slot
- Snooze button to postpone a reminder by 1 day
- /open: list all open hutang/piutang anytime

## 16. Monthly Report
- Automatically sent immediately after closing
- Also available on demand: /report or /report [month] [year]
- Generated from Google Sheets data and saved in the Monthly Report tab
- Report contents:
  - Total income, total expense, net cash flow
  - Balance per wallet and per wallet group (opening, ending, change)
  - Total transfers between wallet groups (e.g. Spending → Investment)
  - Balance adjustments made this month
  - Expense breakdown by category (amount + % of total), including admin fees
  - Top 5 biggest expenses
  - Comparison with the previous month (up/down %)
  - Hutang summary: total owed, paid this month, remaining, overdue, converted
  - Piutang summary: total lent, received this month, remaining, overdue,
    converted
  - Investment summary: invested, sold, portfolio value per category,
    unrealized and realized gain/loss, month-over-month change
  - Net worth: cash wallets + investment value + piutang − hutang
  - Transaksi Favorit: paid vs skipped this month (only those with dates)
  - Budget usage per category from the Categories budget columns (see
    Section 25)
  - Breakdown by user (me vs partner)
- Format: a short chat summary plus a link to the report tab of the newly
  generated archive sheet

## 17. Commands
Commands will reread the existing google sheets
- /help: user guide with all formats and examples
- /saldo: balance per wallet, per wallet group, investment value per
  category, and total (password required)
- /adjust [wallet] [balance]: adjust a wallet balance
- /open: all open hutang/piutang
- /inv: all investments per category with current value and gain/loss
- /inv update: single or bulk price update
- /inv sell: guided sale flow
- /report [month] [year]: monthly report
- /closing [month] [year]
- /fav, /fav add, /fav edit, /fav delete
- /wallet: list wallets and their groups; /wallet add to create one
- /category: list categories; /category add to create one
- /contact: list contacts and aliases; /contact add to create one
- /budget, /budget [category]: budget, spent and remaining (Section 25)
- /setsheet [url], /setarchive [url], /setreceipts [url], /settemplate [url],
  /template
- /changepass: change the password (default 0000)
- /undo: remove the last entry or linked group, after confirmation

## 18. Google Sheets Requirements
Design and document the full spreadsheet structure. Include:

Tab 1: Transactions (all money movements)
| Column          | Example            | Notes                                              |
|-----------------|--------------------|----------------------------------------------------|
| Trx ID          | TRX-0001           | Auto-generated                                     |
| Link ID         | LNK-0005           | Groups linked entries (transfer + expense, split bill, conversions, investments) |
| Date            | 2026-09-24 12:30   | Asia/Jakarta; defaults to today                    |
| Logged By       | Me / Partner       | From Telegram chat ID                              |
| Type            | Expense            | Income / Expense / Transfer / Adjustment / Piutang / Hutang / Settlement / Addition / Conversion / Investment Buy / Investment Sell |
| Amount          | 50000              | Always positive                                    |
| Direction       | Out                | In / Out / Transfer                                |
| Category        | Food               | From Categories tab                                |
| Category Source | AI                 | Manual / Keyword / AI                              |
| Wallet          | GoPay              | From Wallets tab                                   |
| Wallet Group    | Spending           | Looked up from Wallets tab                         |
| To Wallet       | Saham              | Transfers / investments only                       |
| Note            | makan siang di KFC |                                                    |
| Debt ID         | PTG-001            | Hutang/piutang-related entries only                |
| Inv ID          | INV-0001           | Investment-related entries only                    |
| Favorite ID     | FAV-003            | If logged from a favorite                          |
| Input Source    | Text               | Text / OCR-GoPay / OCR-Receipt / Favorite / Sheet  |
| Image Link      | View receipt       | HYPERLINK to the bill image in the Receipts folder |
| Month Status    | Open               | Open / Closed                                      |

Tab 2: Hutang_Piutang (one row per record or sub-record)
| Column        | Example      | Notes                              |
|---------------|--------------|------------------------------------|
| Debt ID       | PTG-001      |                                    |
| Parent ID     | PTG-010      | Group piutang only                 |
| Link ID       | LNK-0007     | Split bill only                    |
| Type          | Piutang      | Hutang / Piutang                   |
| Term          | Short        | Short / Long                       |
| Name          | Budi         | From Contacts tab                  |
| Start Date    | 2026-09-01   | Defaults to today                  |
| Due Date      | 2026-10-30   | Empty for long-term                |
| Wallet        | BCA          |                                    |
| Category      | Food         | Used for split bill / conversion   |
| Original      | 500000       |                                    |
| Added         | 100000       |                                    |
| Paid          | 200000       |                                    |
| Remaining     | 400000       |                                    |
| Status        | Partial      | Open / Partial / Paid / Converted  |
| Converted Trx | TRX-0045     | If converted                       |
| Last Reminder | 2026-09-20   |                                    |
| Snoozed Until | 2026-09-21   |                                    |

Tab 3: Categories: name, type (income/expense/investment),
keywords for auto-detection, default wallet [optional]; include default
"Admin & Bank Fees" and "Adjustment" categories. Budget columns (Section
25): Monthly Budget (typed by me; empty/0 = no limit), Spent (formula: this
month's expenses in that category, Expense categories only) and Remaining
(formula: Budget − Spent, blank when there is no budget, red when over).
Column order: Category, Type, Monthly Budget, Spent, Remaining, Keywords,
Default Wallet

Tab 4: Wallets: wallet name, wallet group, wallet type (cash / investment
category), opening balance, current balance, owner (Me / Partner / Shared),
default transfer fee [optional], active (yes/no)

Tab 5: Favorites: Favorite ID, name, type, value (fixed/variable), category,
wallet, to wallet (for transfers), default fee, schedule, day/date,
last logged, active

Tab 6: Monthly Report: one section or row per month, filled by the script,
including closing status and archive link

Tab 7: Settings: a Users table (chat ID, display name, GoPay name) for me
and my partner, main sheet ID, archive folder ID, receipts folder ID, reminder
times, thresholds (large amount, duplicate window, reminder days), timezone,
AI on/off, Gemini model, Hide amounts (yes/no), Password (numbers only),
Password for /saldo (yes/no), Password for /budget (yes/no), Spending
Wallet Groups, Investment Wallet Groups, Budget auto-delete (yes/no).
Helper lists: Owners, Investment Categories, Wallet Groups.
(Bot token, Gemini key and folder/sheet IDs are stored in Script
Properties; the ID rows in Settings are info only. Auto-delete delays are
fixed — 60 seconds for /saldo and /budget, end of day for budget messages
after saving — not settings.)

Tab 8: (no Pending tab) Pending confirmations are stored in CacheService
with a 10-minute expiry, keyed by chat ID

Tab 9: Logs: script errors, AI mapping failures, OCR failures

Tab 10: Dashboard with charts: monthly cash flow trend, expense category pie,
wallet group allocation, investment allocation per category, portfolio value
trend, gain/loss per category, net worth trend

Tab 11: Investments (one row per purchase)
| Column              | Example        | Notes                                   |
|---------------------|----------------|-----------------------------------------|
| Inv ID              | INV-0001       | Auto-generated                          |
| Link ID             | LNK-0010       | Links to the purchase transfer/fees     |
| Investment Date     | 2026-09-24     | Defaults to today                       |
| Investment Category | Emas           | = investment wallet                     |
| Asset Name          | Antam          |                                         |
| Platform            | Pegadaian      | Info only                               |
| Unit                | gram           | lot / share / gram / unit / nominal     |
| Quantity            | 2              | Remaining quantity after sales          |
| Acquisition Price   | 1350000        | Per unit                                |
| Acquisition Cost    | 2700000        | Total                                   |
| Current Price       | 1380000        | Per unit, last update                   |
| Current Value       | 2760000        | Formula                                 |
| Gain/Loss (Rp)      | 60000          | Formula                                 |
| Gain/Loss (%)       | 2.22%          | Formula                                 |
| Last Price Update   | 2026-09-30     |                                         |
| Source Wallet       | BCA            |                                         |
| Status              | Holding        | Holding / Partially Sold / Sold         |

Tab 12: Investment_Sales
| Column          | Example    | Notes     |
|-----------------|------------|-----------|
| Sale ID         | SAL-0001   |           |
| Inv ID          | INV-0001   |           |
| Sale Date       | 2026-10-15 |           |
| Quantity Sold   | 1          |           |
| Sale Price      | 1400000    | Per unit  |
| Proceeds        | 1400000    |           |
| Fees            | 5000       |           |
| Realized Gain   | 45000      | Formula   |
| To Wallet       | BCA        |           |

Tab 13: Price_History: date, Inv ID / asset name, price per unit, value,
source (manual / bulk / sheet edit / auto), month-end flag

Tab 14: Contacts: name, aliases (e.g. GoPay display names), notes

Tab 15: Budget_History: month key, category, budget, spent, remaining,
over/under. Written by the script at closing, one row per budgeted
category per month (the Monthly Report tab has one row per month, so it
can't hold per-category values). Past reports read from here.

Sheet rules:
- Data validation (dropdowns) for Type, Status, Term, Category, Wallet,
  Wallet Group, Investment Category, Unit
- Remaining, Status, wallet balances, and investment gain/loss calculated
  automatically (formula or script; explain which is better)
- Number format: Rp with thousand separators
- Freeze header rows; protect formula columns from accidental edits
- Closed months are protected from editing
- The sheet must still work if I edit or add rows manually
- The template must contain every tab, header, validation, formula, and
  dashboard so /template and /setsheet work with a fresh copy

## 19. User Flow Examples
Me:  50rb makan siang di KFC
Bot: Preview: Expense Rp50.000 | Food (AI) | GoPay → Spending (mapped)
     | 24 Sep 2026 | "makan siang di KFC"
     Save? [Yes] [No] [Edit]
Me:  Yes
Bot: ✅ Saved as TRX-0123. GoPay balance: Rp450.000

Me:  transfer 1jt BCA ke GoPay admin 2.5rb
Bot: Preview (LNK-0005):
     1. Transfer Rp1.000.000 BCA (Spending) → GoPay (Spending)
     2. Expense Rp2.500 | Admin & Bank Fees | from BCA
     BCA −Rp1.002.500 | GoPay +Rp1.000.000
     Save? [Yes] [No] [Edit]

Me:  transfer 1jt BCA ke IPOT, 200rb dipakai bayar makan
Bot: Is the Rp200.000 spent from BCA (only Rp800.000 transferred) or from
     IPOT after the transfer? [From BCA] [From IPOT]
Me:  From BCA
Bot: Preview (LNK-0006):
     1. Transfer Rp800.000 BCA (Spending) → IPOT (Investment)
     2. Expense Rp200.000 | Food (AI) | from BCA
     Save? [Yes] [No] [Edit]

Me:  /adjust BCA 10.200.000
Bot: Recorded BCA balance: Rp10.250.000. Adjustment: −Rp50.000.
     Save? [Yes] [No]

Me:  piutang 500rb Budi jatuh tempo 30/10
Bot: Piutang to Budi, Rp500.000, from which wallet? [BCA] [GoPay] [Cash]
Me:  BCA
Bot: Piutang to Budi, Rp500.000 | BCA | due 30 Oct 2026. Save? [Yes] [No] [Edit]
Me:  Yes
Bot: ✅ Saved as PTG-001

Me:  Budi bayar piutang 200rb
Bot: Budi has 2 open piutang:
     1. PTG-001: remaining Rp500.000 (due 30/10)
     2. PTG-004: remaining Rp150.000 (due 12/11)
     Which one?
Me:  1
Bot: Received into which wallet? [BCA] [GoPay] [Cash]
Me:  BCA
Bot: ✅ Payment Rp200.000 for PTG-001 into BCA. Remaining: Rp300.000 (Partial)

Me:  [GoPay Split Bill image] caption: GoPay
Bot: 🧾 Read from GoPay Split Bill:
     "Makan malam Solaria" | 24 Sep 2026 | Total Rp385.500 (incl. tax)
     Paid by: you
     - You: Rp128.500 → Expense | Food (keyword)
     - Budi Santoso → Budi: Rp128.500 → Piutang
     - "Andi W" (unknown): Rp128.500 → Piutang
     Who is "Andi W"? [Andi] [New contact] [Use as-is]
Me:  Andi
Bot: Preview (LNK-0008): Expense Rp128.500 (Food, GoPay) + PTG-013 Budi
     Rp128.500 + PTG-014 Andi Rp128.500. Save? [Yes] [No] [Edit]

Me:  tutup piutang PTG-011 jadi pengeluaran
Bot: Convert remaining Rp100.000 (Budi) to Expense. Category? [Food] [Gift] [Other]
Me:  Gift
Bot: ✅ PTG-011 Converted → TRX-0130 (Expense, Gift, Rp100.000)

Me:  beli emas 2gr 1.350rb/gr dari BCA
Bot: Preview (LNK-0010):
     Investment: Emas 2 gr × Rp1.350.000 = Rp2.700.000
     BCA −Rp2.700.000 | Emas wallet +Rp2.700.000
     Asset name? [Antam] [UBS] [Other]

Me:  /inv update
     BBCA 9.800
     emas 1.380rb/gr
Bot: Preview price update:
     BBCA: 9.500 → 9.800 (+3.16%)
     Emas (3 rows, 5 gr): 1.350.000 → 1.380.000/gr (+2.22%)
     Save? [Yes] [No] [Edit]

Me:  jual BBCA 5 lot harga 10.200 ke BCA
Bot: Sell 5 lot BBCA (FIFO from INV-0003) × 10.200 = Rp5.100.000
     Realized gain: +Rp350.000 | BCA +Rp5.100.000
     Fee? [None] [Enter fee]

Me:  /fav add Bayar Token Listrik 100k setiap tanggal 1 September 2026
Bot: Preview favorite: Bayar Token Listrik | Rp100.000 | Utilities (AI)
     | monthly on the 1st, starting 1 Sep 2026 | wallet? [BCA] [GoPay]

Bot (scheduled favorite): 📌 Bayar Token Listrik is due today.
     Amount? [Rp100.000] [Change] [Skip]

Bot (daily): ⏰ PTG-001 (Budi) has been open for 3 days.
     Remaining: Rp300.000 [Snooze 1 day]

Bot (weekly): 📋 Open hutang/piutang: 3 records, total piutang Rp700.000,
     total hutang Rp1.000.000 [View details]

Bot (last day, 12:00): 📈 Time to update investment prices:
     BBCA (last 9.800), Emas (last 1.380.000/gr), RDPU X (last 1.520)

Bot (last day, 18:00): 📅 Ready to close September 2026? [Start closing]

## 20. Non-Functional Requirements
- Reply within 3 seconds (AI mapping and OCR may take longer; show a
  "processing" message if needed)
- Timezone: Asia/Jakarta
- Bot language: English replies; inputs accepted in English or Bahasa Indonesia
- Prevent duplicate entries if the webhook fires twice
- Log script errors to the Logs tab
- AI and OCR failures must never block logging (fall back to keyword or
  manual input)
- Stay within Google Apps Script quotas (execution time, triggers, URL fetch);
  explain any limits I should know about

## 21. Out of Scope
- Bank account syncing
- Interest calculation on loans
- Reading individual line items into separate transactions (receipt OCR
  logs the total only)
- /reopen of closed months
- Automatic investment price fetching (manual only for now)

## 22. What I Want From You
1. Ask me clarifying questions before coding if anything is unclear
2. Give the Google Sheets setup first: tabs, columns, validation, formulas,
   and dashboard, so it can be saved as the template
3. Explain the Gemini setup, free-tier limits, and how the fallback works
4. Give the complete Apps Script code with comments, split into clear sections
5. Give step-by-step setup instructions for a beginner, including all triggers
   (reminders, favorites, price updates, closing, archive)
6. Give a test checklist covering every transaction type, wallet mapping,
   category mapping, transfers with fees, partial expenses, received-amount
   differences, balance adjustments, investment purchases (lot, gram, total),
   bulk price updates, partial sales, GoPay Split Bill images (clear, blurry,
   unknown names, totals not matching), closing and archiving, /setsheet with
   valid and invalid sheets, /template, passwords, spoiler amounts in
   /saldo, /inv, /open, /report and /budget, /saldo auto-delete (fixed 60s,
   already deleted manually), receipt OCR (clear, blurry, several totals,
   GoPay payment receipt vs GoPay Split Bill, photo vs file, caption
   override, caption without amount, cancel = no upload, upload failure,
   link in Transactions tab, partner opening the link), budgets (no limit,
   0, under, exactly at, over, several categories in one linked group,
   back-dated entry in the previous month, /undo, sheet edits, Spent and
   Remaining columns, /budget with and without password, auto-delete Yes
   and No, end-of-day deletion), /saldo with and without password, and
   every error case
7. Suggest improvements or risks I haven't thought of

## 23. Success Criteria
- I can log any transaction in under 10 seconds
- The bot never saves an unclear entry, category, or wallet without asking first
- Every transaction has a correct category and wallet
- Transfers and investment purchases never inflate my income or expense totals
- A GoPay Split Bill image is turned into correct expense and piutang entries
  with one confirmation
- I never miss a hutang/piutang, recurring payment, price update, or closing
- I receive an accurate monthly report, including investments and net worth,
  without opening the sheet

## 24. Receipt OCR (bills that are not GoPay Split Bill)

### Routing: which OCR flow to use
- Every photo I send goes through ONE Gemini vision call that returns JSON:
  merchant/issuer name, whether the image is a GoPay Split Bill (participant
  list with shares), date, line items (optional), subtotal, tax, service,
  discount, total, and a confidence value per field
- Rule: if the OCR result's name/issuer matches "GoPay" (case-insensitive,
  e.g. "GoPay", "Gopay Split Bill") AND it contains a split-bill participant
  list → use the GoPay Split Bill flow (Section 10)
- Otherwise → use the Receipt flow below. This includes normal GoPay payment
  receipts with no participant list (GoFood, merchant QR payments); for
  those, suggest GoPay as the wallet. (Matching on the name alone is not
  enough: those receipts would fail in the split-bill flow.)
- The caption can force a flow: "split" → Section 10, "bill" → Receipt flow
- Images arrive either as a Telegram photo or as a file ("document" with an
  image type, uncompressed); both are accepted. Use the largest photo size
- An album (several photos at once) arrives as separate messages; each is
  handled as its own bill

### Receipt flow
- Take the FINAL total the customer paid ("Total", "Grand Total", "Total
  Bayar", "Jumlah"), after tax, service charge, discounts and delivery fees.
  Never use Subtotal or Change ("Kembalian") as the amount
- If several totals appear or they don't add up (subtotal + tax + service −
  discount ≠ total) → show the candidates and ask which one to use
- Create an Expense preview:
  - Amount = total bill
  - Note = merchant name (plus caption text, if any)
  - Date = receipt date; if missing or unreadable → today
  - Category = mapping order from Section 5 using the merchant name and
    items (keyword → AI → ask)
  - Wallet = from the caption (e.g. "BCA"), else wallet rules from Section 6
  - Input Source = OCR-Receipt
- The caption can add or override details (e.g. "BCA #food", "120rb").
  The caption is parsed like a text message but the amount is OPTIONAL
  (a text message without an amount is an error; a caption without one is
  not — the OCR total is used)
- Highlight low-confidence values: "Total read as Rp185.500 (low
  confidence). Correct? [Yes] [Edit]"
- Unreadable image or no total found → ask me to resend or type the amount
- Duplicate check: same total + merchant + receipt date, at ANY time → ask
  before saving. (This is a separate rule from the text-entry duplicate
  check, which looks at type + amount + note within a few minutes: a
  receipt is often logged hours later and its note is the merchant name.)
- Blocked-month and large-amount rules from Section 14 still apply
- OCR failure never blocks logging; fall back to manual input

### Saving the image
- Every uploaded bill image (receipts AND GoPay Split Bills) is saved to the
  Receipts folder in Google Drive, set with /setreceipts [folder url] (stored
  in Script Properties as RECEIPTS_FOLDER_ID, like the archive folder)
- If no folder is set yet, the bot creates "Receipts" inside the MonetaBot
  Drive folder and uses that, so the first receipt never fails
- Inside that folder, create one subfolder per month (e.g. "2026-09")
- File name: [Trx ID]_[yyyy-mm-dd]_[merchant].jpg (e.g.
  TRX-0142_2026-09-24_Indomaret.jpg)
- The image is saved ONLY after I confirm; if I cancel, nothing is uploaded
- While waiting for Yes, the pending entry keeps only Telegram's file_id
  (pending entries live in CacheService, max 100 KB, so they can't hold the
  image; nothing survives "in memory" between messages). On Yes the bot
  downloads the image again with getFile
- Order on Yes: write the Transactions row(s) → upload the image (the file
  name needs the Trx ID) → write the link into Image Link. If the upload
  fails, the transaction stays saved without a link, the failure is logged
  to Logs, and the success message says the image couldn't be saved
- Drive files are private to the owner by default. For my partner to open
  "View receipt", the Receipts folder must be shared with them (a one-time
  manual step the phase guide explains)
- The Transactions tab "Image Link" column shows a clickable link
  (HYPERLINK formula, text "View receipt"); every row of a linked group
  (e.g. split bill) gets the same link
- The success message includes the link: "✅ Saved as TRX-0142 · 🧾 View receipt"
- Archived months keep the links; images are never deleted by closing
- /undo of a receipt entry removes the Transactions row(s) but moves the
  image to the Drive trash only after confirming ("Also delete the receipt
  image? [Yes] [Keep]")
- Input Source values change from the Phase 1 list (Text / OCR / Favorite /
  Sheet) to Text / OCR-GoPay / OCR-Receipt / Favorite / Sheet; the existing
  main sheet and template get the new dropdown through an upgrade function

### Example
Me:  [photo of an Indomaret receipt] caption: BCA
Bot: 🧾 Read from receipt: Indomaret | 24 Sep 2026 | Total Rp185.500
     Expense Rp185.500 | Groceries (keyword) | BCA → Spending
     Save? [Yes] [No] [Edit]
Me:  Yes
Bot: ✅ Saved as TRX-0142 · 🧾 View receipt

## 25. Budgeting

### Where budgets live: the Categories tab
- Budgets are set per category in the Categories tab, which already has a
  Monthly Budget column. Two formula columns sit next to it:
  - Spent: this month's expenses in that category (calculated live from the
    Transactions tab; only for Expense categories)
  - Remaining: Monthly Budget − Spent; blank when there is no budget; shown
    in red when negative (over budget)
- Monthly Budget can be empty or 0 → treated as NO LIMIT: that category
  behaves exactly as it does today, with no budget message
- Budgets only make sense for Expense categories; I simply leave the budget
  empty for Income / Investment / Adjustment categories (no dropdown
  restriction). The bot ignores budgets on non-Expense categories
- Budgets are monthly and shared by me and my partner (both users' spending
  counts). There are no per-user budgets and no rollover of unused budget
- Edits in the sheet take effect immediately; the bot reads the Categories
  tab at runtime (not cached)
- Sheets built before this feature get the Spent and Remaining columns via
  an upgrade function (inserted right after Monthly Budget)

### How "spent" is calculated
- Spent = sum of all expense amounts in that category in a given month,
  calculated live from the Transactions tab (never stored), so /undo and
  manual sheet edits are always reflected
- Counts: normal expenses, expense portions of transfers (e.g. admin fees),
  my share of split bills, piutang converted to expense, favorites logged
  as expenses, and receipt OCR expenses
- Does NOT count: income, transfers, investments, adjustments, piutang
  lent, hutang, or settlements
- ONE shared rule decides whether a Transactions row "counts as an expense"
  (and as income). The bot's budget messages, /report, the Monthly Report,
  the Dashboard and the Categories Spent column all use it, so their numbers
  always agree. Today that rule is Type = Expense; how Conversion rows count
  is decided in Phase 4 and then applied everywhere (including the Spent
  formula)
- Remaining = Budget − Spent. % used = Spent ÷ Budget

### Which month
- The budget message after saving uses the month of the ENTRY's date
  (e.g. on 1 Oct, "50rb makan kemarin" is dated 30 Sep → September's
  budget, spent and remaining). The bot calculates this itself
- /budget and the Categories Spent/Remaining columns show the current month
  (today, Asia/Jakarta)

### Budget message after saving
- After a transaction is saved successfully, IF it includes an expense in a
  category with a budget greater than 0, the bot sends a SEPARATE message
  in the same chat, right after the "✅ Saved" message:
    📊 Budget · Food · September 2026
    Budget Rp1.500.000 | Spent Rp1.250.000 (83%) | Remaining Rp250.000
- When spending exceeds the budget:
    ⚠️ Food is OVER budget by Rp50.000
    Budget Rp1.500.000 | Spent Rp1.550.000 (103%)
- Exactly at the budget: "Remaining Rp0 (100%)", not "over"
- A linked group touching several budgeted categories (e.g. transfer +
  admin fee + food) → one message listing each affected category
- No budget message for no-limit categories or non-expense entries
- No budget message after /undo; the next save or /budget shows the new
  numbers
- The budget message is sent to the chat of the person who logged it
- Amounts follow the "Hide amounts" spoiler setting (Section 13)
- One reusable "after save" step sends it, so every flow that saves an
  expense (text, transfers with fees, split bills, conversions, favorites,
  receipts) gets it automatically

### /budget command
- /budget: every category with a budget > 0 showing budget, spent,
  remaining and % used; over-budget categories flagged with ⚠️; a total
  row; plus one line for spending in no-limit categories
- /budget [category]: the same for one category (any case; a unique
  prefix works, e.g. /budget bills)
- Current month only; past months are in /report
- Password: asked only when "Password for /budget" = Yes in Settings
  (default No), using the same password flow as /saldo (Section 13)

### Disappearing messages
- Setting: "Budget auto-delete" = Yes / No (default Yes)
- Yes →
  - the budget message after saving is deleted at the END OF THE DAY
    (23:59 Asia/Jakarta), with the note "🕒 Deleted at the end of the day".
    All of the day's budget messages go in one batch, so the cleanup
    trigger never has to wait for them (quota-safe)
  - the /budget reply is deleted after 60 seconds, like /saldo
- No → both stay in the chat
- Both use the same queue and 1-minute cleanup trigger as /saldo (Section
  13); no extra trigger
- The "✅ Saved" message itself is never auto-deleted, so the transaction
  record stays in the chat

### Reporting
- The monthly report's "Budget usage per category" section shows budget,
  spent, remaining, and over/under per category
- On closing, each budgeted category's budget and spent amount are saved in
  the Budget_History tab (Section 18, Tab 15: one row per category per
  month), so later budget changes don't alter past reports. /report for a
  closed month reads Budget_History; for the current month it reads the
  Categories tab live. The Categories budgets are carried over on closing
