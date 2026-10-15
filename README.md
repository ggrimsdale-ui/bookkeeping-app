# Bookkeeping App

A desktop bookkeeping app for accountants who keep the books for multiple companies, in the spirit of QuickBooks Desktop.

Built with Electron, React and TypeScript. Each company is a single `.books` file (an SQLite database), so a client's books can be opened, copied, backed up or sent as one file. All amounts are stored as integer cents.

## What's in the MVP

- **Company files**: create, open, close and switch companies; recent companies list; back up to a `.booksbak` file and restore.
- **Company setup**: name, legal name, address, tax ID, fiscal year start month.
- **Chart of accounts**: starter templates (general, service, retail, blank), account numbers, sub-accounts, inactive accounts, and an opening balances helper that offsets to Opening Balance Equity.
- **Journal entries**: multi-line entries that must balance before saving, edit, void, delete, search by date, ref or memo.
- **Reports**: Profit & Loss, Balance Sheet, Trial Balance and General Ledger, with date presets, prior period or prior year comparison with $ and % change, drill-down from any amount to the transactions, print, and export to PDF, Excel and CSV.
- **Closing date**: entries on or before the closing date are locked behind a confirmation, or a password if one is set.

Income and expense accounts reset at each fiscal year end, and prior years' profit rolls into Retained Earnings automatically. No closing entries are needed.

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
