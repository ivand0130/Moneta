# MonetaBot — full test checklist (SPEC Section 22, item 6)

How to use: type the message in Telegram, compare with "Expect", tick the
box. Use small amounts; undo test entries with `/undo` (or tap No on the
preview). Wallet / category names below are examples — use your own.
After a sheet test, look at the tab named in brackets.

Rules that apply to every row: nothing is saved before you tap **Yes**; every
amount in a preview is plain (no spoiler); a saved entry gets an ID
(TRX-/LNK-/PTG-/HTG-/INV-…); an expense save is followed by the budget
message if that category has a budget.

---

## 1. Transaction types

| ✓ | Type | Expect |
|---|---|---|
| ☐ | `50rb makan siang di KFC` | Preview: Expense Rp50.000, Food (keyword), default wallet, today → Yes → "✅ Saved as TRX-…" (no balances) |
| ☐ | `gaji 10jt BCA` | Income Rp10.000.000, Salary, BCA |
| ☐ | `transfer 1jt BCA ke GoPay` | Transfer; not in income/expense (check /report later) |
| ☐ | `piutang 500rb Budi jatuh tempo 30/12` | Piutang, asks wallet, due 30 Dec → PTG-… |
| ☐ | `hutang 200rb ke Andi` | Hutang → HTG-… |
| ☐ | `/adjust BCA 10.200.000` | Shows recorded balance and the difference → Yes → Adjustment (not in income/expense) |
| ☐ | `beli emas 2gr 1.350rb/gr dari BCA` | Investment Buy preview, never an Expense |
| ☐ | `jual BBCA 1 lot harga 10.200 ke BCA` | Sale preview with realized gain (FIFO) |

## 2. Amounts and dates

| ✓ | Type | Expect |
|---|---|---|
| ☐ | `50k kopi` / `1.5jt sewa` / `2juta sewa` / `50.000 bensin` | Rp50.000 / Rp1.500.000 / Rp2.000.000 / Rp50.000 |
| ☐ | `makan 50` | Buttons: Rp50.000 or Rp50 |
| ☐ | `50rb 20rb makan` | Asks which amount (two amounts) |
| ☐ | `50rb makan kemarin` | Yesterday's date |
| ☐ | `50rb makan 20/09` | 20 Sep (last year if that date is still ahead this year) |
| ☐ | `50rb makan 3 hari yang lalu` | 3 days ago |
| ☐ | `50rb makan kemarin 20/09` | Asks which date (two dates) |
| ☐ | `50rb makan 31/02` | "invalid date" message, nothing saved |
| ☐ | `hello` | Explains it found no amount; nothing saved |
| ☐ | Same `50rb makan` twice within a few minutes | Second preview warns about a possible duplicate |

## 3. Wallet mapping

| ✓ | Type | Expect |
|---|---|---|
| ☐ | `50rb makan pakai gopay` | Wallet GoPay (any case) |
| ☐ | `50rb makan` | Your Default Wallet / asks if none |
| ☐ | `50rb makan BCA GoPay` | Asks which wallet (two wallets) |
| ☐ | `5jt Saham` | Refuses an investment wallet for a normal expense |
| ☐ | A wallet name typed with a typo | Not guessed silently: asks / offers buttons |
| ☐ | Set a wallet's Active = No in the sheet, then use it | Not offered / asks |

## 4. Category mapping

| ✓ | Type | Expect |
|---|---|---|
| ☐ | `50rb bensin` | Transport (keyword) |
| ☐ | `80rb beli obat` | Health (keyword) |
| ☐ | `50rb xyzabc` | Asks for the category (AI never chooses) |
| ☐ | Correct a category with Edit | Offers to save the word as a keyword → Yes → Keywords column updated [Categories] |
| ☐ | Add a keyword in the sheet, then use it | Works without restarting anything |

## 5. Transfers with fees, partial expenses, received amounts

| ✓ | Type | Expect |
|---|---|---|
| ☐ | `transfer 1jt BCA ke GoPay admin 2.5rb` | LNK: Transfer Rp997.500 + Expense Rp2.500 Admin & Bank Fees; BCA −1.000.000, GoPay +997.500 |
| ☐ | `transfer 1jt BCA ke GoPay biaya transfer 6.5rb` | Same pattern with Rp6.500 |
| ☐ | `transfer 1jt BCA ke IPOT, 200rb dipakai bayar makan` | Transfer Rp1.000.000 + Expense Rp200.000 Food from IPOT |
| ☐ | `transfer 1jt BCA ke GoPay diterima 999.000` | Difference Rp1.000 shown as a fee/expense; GoPay +999.000 |
| ☐ | A wallet with a Default Transfer Fee, transfer without a fee | Fee suggested from the Wallets tab |
| ☐ | `/report` afterwards | Transfers don't appear in income or expense |

## 6. Balance adjustments

| ✓ | Type | Expect |
|---|---|---|
| ☐ | `/adjust` (password if on) | Asks wallet and balance |
| ☐ | `/adjust BCA 10,2jt` | Difference shown → Yes → Adjustment row; /saldo shows the new balance |
| ☐ | `/adjust Saham 5jt` | Refused: investment wallets use /inv update |
| ☐ | Start /adjust, log something in BCA from the other phone, then tap Yes | "The recorded balance changed since the preview" + fresh preview |
| ☐ | Your `/adjust` message | Deleted after 60s when "Adjust auto-delete" = Yes |

## 7. Hutang / piutang

| ✓ | Type | Expect |
|---|---|---|
| ☐ | `Budi bayar piutang 200rb` | Picks/asks the record and wallet → Partial, remaining shown |
| ☐ | Pay more than what's left | Asks what to do with the extra (income / expense / flip) |
| ☐ | Someone pays you while the other phone's preview for the same person is open, then tap Yes | "Amounts changed since the preview" + fresh preview |
| ☐ | Name with both open piutang and hutang: `lunas budi` | Asks: Piutang or Hutang |
| ☐ | `tutup piutang PTG-… jadi pengeluaran` | Asks category → Converted, Expense row |
| ☐ | `/open`, `/piutang`, `/hutang` | Lists open records, amounts in spoilers |
| ☐ | `hutang 100rb ke Andi tempo bulan depan` on the 31st | Due date = last day of next month |
| ☐ | Paying back a hutang | Also counts as an Expense (owner's rule) |

## 8. Investments

| ✓ | Type | Expect |
|---|---|---|
| ☐ | `beli BBCA 2 lot 9.800/lembar` | 2 lot × 100 × 9.800 = Rp1.960.000 |
| ☐ | `beli emas 2gr total 2.700rb` | Price per gram Rp1.350.000 |
| ☐ | `beli BBCA 200 lembar harga 9.800 fee 3rb dari IPOT` | 2 lot + fee Rp3.000 |
| ☐ | `/inv` | Per category: value and gain/loss (spoilers) |
| ☐ | `/inv update` then several lines (`BBCA 9.800`, `emas 1.380rb/gr`) | Bulk preview old → new (%) → Yes → Price_History rows |
| ☐ | `jual BBCA 1 lot harga 10.200 ke BCA` (holding 2 lot) | Partial sale, FIFO, status Partially Sold |
| ☐ | Sell with the asset typed in another case (`bbca`) | Same rows as the preview |
| ☐ | `/undo` a buy that was partly sold | Blocked |

## 9. GoPay Split Bill images

| ✓ | Send | Expect |
|---|---|---|
| ☐ | Clear split bill where you paid | Your share = Expense, others = Piutang, one confirmation |
| ☐ | Split bill where someone else paid | Your share = Hutang to the payer |
| ☐ | Blurry image | Says it can't read it; asks you to type it; nothing saved |
| ☐ | Unknown name in the bill | Asks: existing contact / New contact / Use as-is; the GoPay name can be remembered as an alias |
| ☐ | Shares that don't add up to the total | Warns before saving |
| ☐ | The same bill sent twice | Duplicate warning (same total, people, date) |
| ☐ | Leave a GoPay hutang preview open, close the month, tap Yes | Blocked: the month is closed |

## 10. Receipt photos (not split bills)

| ✓ | Send | Expect |
|---|---|---|
| ☐ | Clear receipt (photo) | Expense = total, merchant as note → Yes → image saved to Drive |
| ☐ | Same receipt as a file (uncompressed) | Same result |
| ☐ | Blurry receipt | Asks you to type the amount; nothing saved yet |
| ☐ | Receipt with several totals | Asks which total |
| ☐ | GoPay payment receipt (not split bill) | Treated as a receipt, wallet = GoPay (Receipt Issuer) |
| ☐ | Caption `150rb makan BCA` | Caption wins over what was read |
| ☐ | Caption without an amount (`makan BCA`) | Amount from the image, wallet/category from the caption |
| ☐ | Tap No / Cancel | Nothing uploaded to Drive |
| ☐ | Drive upload fails (e.g. receipts folder removed) | Entry still saved, warning shown, error in Logs |
| ☐ | Transactions tab → Image Link | "View receipt" link opens the image |
| ☐ | Partner opens the link | Opens (folder shared with partner) |

## 11. Favorites and reminders

| ✓ | Type | Expect |
|---|---|---|
| ☐ | `/fav add Bayar Token Listrik 100k setiap tanggal 1` | Preview → asks wallet → saved |
| ☐ | `/fav`, `/fav edit …`, `/fav delete …` | List / edit / delete |
| ☐ | Morning prompt [Yes] | Saved as shown |
| ☐ | Edit the favorite's amount in the sheet, then tap the old [Yes] | Normal preview instead of saving |
| ☐ | [Skip] | Last Skipped set; no entry |
| ☐ | Daily / weekly / last-day reminders (or run sendRemindersNow) | Open debts, prices on the last day 12:00, closing 18:00 |

## 12. Closing and archive

| ✓ | Do | Expect |
|---|---|---|
| ☐ | `/closing` before the month is over | "isn't over yet" |
| ☐ | `/closing` when an older month is open | "Close <older month> first" |
| ☐ | `/closing` on/after the last day → Close → password | Summary → "⏳ Closing…" → report to both of you; archive in MonetaBot/Archive/<year> |
| ☐ | Send a message during the closing | "closing is running, send again in 2 minutes" |
| ☐ | After closing | Wallet Opening Balance = month-end; month in Monthly Report = Closed; Budget_History and Category_History rows; Settings → Password empty in the archive copy |
| ☐ | Log an entry dated in the closed month | Blocked, points to /adjust |
| ☐ | `/report <closed month>` | Report from the archive, "🔒 closed" |

## 13. Sheet management

| ✓ | Type | Expect |
|---|---|---|
| ☐ | `/setsheet <link of a valid copy>` | Password → "All tabs and columns…" → [Switch] |
| ☐ | `/setsheet <link of a sheet missing tabs>` | Lists what's missing + [Add what's missing] |
| ☐ | `/setsheet <link you can't open>` | "I can't open that sheet" |
| ☐ | `/setsheet` to a sheet without your chat ID | Warning, no Switch button |
| ☐ | `/template` | Link to the template |
| ☐ | `/setarchive <folder link>`, `/setreceipts <folder link>`, `/links` | Saved / lists the links |

Switch back to the real main sheet afterwards.

## 14. Passwords and hidden amounts

| ✓ | Do | Expect |
|---|---|---|
| ☐ | `/saldo` (password on) → correct password | Your password message is deleted; balances in spoilers; reply deleted after 60s |
| ☐ | `/saldo` → wrong password 5 times | Locked 15 min; then send `1234` → deleted, "looked like a password", nothing saved |
| ☐ | Settings → Password for /saldo = No, then `/saldo` | Shows right away (still spoilers, still deleted after 60s) |
| ☐ | Delete the /saldo reply yourself before 60s | No error for you (a warning row in Logs is fine) |
| ☐ | `/changepass` | Old → new → again; all three messages deleted |
| ☐ | Spoilers in `/inv`, `/open`, `/report`, `/budget` | Amounts hidden until tapped |
| ☐ | Settings → Hide amounts = No | Same replies show plain amounts |

## 15. Budgets

| ✓ | Do | Expect |
|---|---|---|
| ☐ | Expense in a category with no budget (empty) | No budget message |
| ☐ | Budget 0 | Treated as no limit |
| ☐ | Under budget | Message: budget, spent (%), remaining |
| ☐ | Exactly at budget | 100%, remaining Rp0 |
| ☐ | Over budget | ⚠️ over by … |
| ☐ | A transfer with fee + partial expense (two categories in one LNK) | One budget message listing both budgeted categories |
| ☐ | `50rb makan kemarin` on the 1st | Uses last month's budget |
| ☐ | `/undo` | Spent goes back down [Categories → Spent] |
| ☐ | Edit an amount in Transactions by hand | Spent / Remaining update |
| ☐ | `/budget`, `/budget food` | All budgets / one category |
| ☐ | Password for /budget = Yes | Asks the password first |
| ☐ | Budget auto-delete = Yes / No | Budget messages gone at 23:59 / stay |

## 16. Dashboard

| ✓ | Check | Expect |
|---|---|---|
| ☐ | This month cards | Income / Expense = `/report` this month |
| ☐ | Net worth | = /report net worth |
| ☐ | Budget health | Same Spent as Categories tab; statuses colored |
| ☐ | Category trends | Last month's numbers match last month's /report categories |
| ☐ | Hutang/piutang due | Records due within 14 days; overdue in red |

## 17. Error cases

| ✓ | Do | Expect |
|---|---|---|
| ☐ | Message from a chat not in Users | No reply at all; "BLOCKED" in showRecentUpdates |
| ☐ | Tap an old preview button after 10 minutes | "⌛ This expired… nothing was saved" |
| ☐ | Tap Yes twice quickly | Saved once |
| ☐ | Both of you save at the same moment | Two different IDs, both saved |
| ☐ | Gemini key removed / wrong (Script Properties) | Unclear messages ask you instead; error in Logs; normal messages still work |
| ☐ | Rename a column header in the sheet | Bot says which column it can't find (rename it back) |
| ☐ | Move a column to another position | Still works (columns found by name) |
| ☐ | `/undo` | Shows what will be removed → Yes → gone (linked rows together) |
| ☐ | Unknown command `/abc` | "Unknown command. Type /help…" |

## 18. Phase 9 additions

| ✓ | Do | Expect |
|---|---|---|
| ☐ | `/report bca` and `/report spending okt` | "Filtered: …" at the top; only those wallets; no net worth / debts |
| ☐ | `/report xyz` | Lists the wallets and groups you can use |
| ☐ | `/report` (budgets) | Each budget shows remaining and Under / At / Over |
| ☐ | `/report` (investments), after the next closing | Per category: start → end, change, gain Rp and % |
| ☐ | `piutang 10jt Budi` from a wallet with less money | Preview shows "BCA (Spending)" + warnings (large amount, goes negative) |
| ☐ | Add to a paid record by ID, e.g. `tambah piutang PTG-001 100rb` | "already Paid" + [➕ Create new Piutang for Budi] |
| ☐ | `beli emas 2gr 1.350rb/gr dari BCA` | Asks "Asset name?" (earlier assets, Just "Emas", Other) |
| ☐ | `jual BBCA 1 lot harga 10.200 ke BCA` | Preview "Fee: none" + [💸 Enter fee] → `5rb` → new realized gain |
| ☐ | `/inv update` with an unknown asset | [➕ Create it] sends a ready "beli …" message |
| ☐ | Unclear split-bill photo | ⚠️ "low confidence" lines on the preview |
| ☐ | Send 3 receipts at once (album) | "📚 Got 3 photos…", then Photo 1, 2, 3 one at a time |
| ☐ | Closing reminder on the last day | Has [🔒 Start closing]; tapping shows the closing summary |
| ☐ | After closing | Price_History has Month-End = Yes rows (Source Closing) dated the last day; editing the archive asks "are you sure?" |
| ☐ | Settings tab | Receipts Folder ID row filled |
| ☐ | Dashboard top right | "Investments this month" block; Month Start fills after the next closing |

