# Bookkeeping App

A desktop bookkeeping app for accountants who keep the books for multiple companies, in the spirit of QuickBooks Desktop.

Built with Electron, React and TypeScript. Each company is a single `.books` file (an SQLite database), so a client's books can be opened, copied, backed up or sent as one file. All amounts are stored as integer cents.

## What's in the MVP

- **Company files**: create, open, close and switch companies; recent companies list; back up to a `.booksbak` file and restore.
- **Company setup**: name, legal name, address, tax ID, fiscal year start month.
- **Chart of accounts**: starter templates (general, service, retail, blank), account numbers, sub-accounts, inactive accounts, and an opening balances helper that offsets to Opening Balance Equity.
- **Journal entries**: multi-line entries that must balance before saving, edit, void, delete, search by date, ref or memo.
- **Reports**: Profit & Loss, Balance Sheet, Trial Balance and General Ledger, with date presets, prior period or prior year comparison with $ and % change, drill-down from any amount to the transactions, print, and export to PDF, Excel and CSV.
- **Reconcile**: QuickBooks-style reconciliation for bank, credit card and other balance sheet accounts. Enter the statement date, ending balance, service charge and interest, then tick off cleared transactions until the difference is zero. You can leave and finish later, enter an adjustment for a difference, view a Reconciliation Detail report, and undo the last reconciliation. Changing a reconciled transaction asks for confirmation first.
- **Bank feeds**: import a CSV file downloaded from any bank or credit card. A column-mapping step handles different bank layouts (one amount column or separate debit and credit columns, any date format, decimal commas) and is remembered per account. Transactions already imported are skipped. Review them in a For Review list, then categorize, rename the payee and add memos one at a time or in bulk (select with the checkboxes or shift-click), and add them to the books in one go. Transactions you already entered by hand are suggested as matches instead of being added twice. Bank rules ("description contains X, categorize to Y") and past choices for the same payee fill in categories automatically. Added items can be undone, and personal or duplicate items can be excluded.
- **Watched folders**: give a bank or card account a folder, and while the company is open the app imports every CSV statement dropped into it, using the column layout from that account's last manual import. Transactions categorized by a bank rule or matching an entry already in the books are added automatically (optionally also ones categorized like last time for the same payee); the rest wait in For Review, and nothing in a closed period is added. Each file is then moved to an `Imported` subfolder, or to `Needs attention` if its layout isn't recognised. A recent-imports log shows what happened to each file.
- **Closing date**: entries on or before the closing date are locked behind a confirmation, or a password if one is set.

Income and expense accounts reset at each fiscal year end, and prior years' profit rolls into Retained Earnings automatically. No closing entries are needed.

## Installing on Windows

Every merge to `main` builds a Windows installer and attaches it to the latest release on the [Releases page](https://github.com/ggrimsdale-ui/bookkeeping-app/releases). Download `Bookkeeping-Setup-<version>.exe` and run it.

The installer isn't code-signed yet, so Windows SmartScreen may say "Windows protected your PC". Click **More info**, then **Run anyway**.

## Development

Requires Node.js 22.

```sh
npm install
npm run dev        # run the app with hot reload
npm test           # unit tests for the accounting core and reports
npm run typecheck
npm run dist       # build an installer for the current platform (Windows .exe or macOS .dmg)
```

## Layout

- `src/core` is the accounting engine: company file schema, accounts, journal entries, closing date, and report calculations. It has no Electron dependency and is covered by the tests in `test/`.
- `src/main` is the Electron main process: file dialogs, saving the company file after every change, and report export.
- `src/preload` exposes a small bridge to the UI.
- `src/renderer` is the React UI.
