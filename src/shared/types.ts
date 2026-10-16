// Types shared between the main process, the accounting core and the UI.

import type { AccountType } from '../core/accountTypes'
import type { TemplateId } from '../core/templates'

export type { AccountType, TemplateId }

export interface CompanyInfo {
  name: string
  legalName: string
  address: string
  taxId: string
  /** Month (1-12) in which the fiscal year starts. */
  fiscalYearStartMonth: number
}

export interface ClosingInfo {
  closingDate: string | null
  hasPassword: boolean
}

export interface Account {
  id: number
  number: string
  name: string
  type: AccountType
  parentId: number | null
  description: string
  isActive: boolean
  system: 'retainedEarnings' | 'openingBalanceEquity' | null
  /** "1000 · Checking" or "Owner's Equity:Owner's Draws" style display name. */
  fullName: string
  depth: number
}

export interface AccountInput {
  number: string
  name: string
  type: AccountType
  parentId: number | null
  description: string
}

export interface JournalLine {
  accountId: number
  /** Cents. Exactly one of debit/credit is non-zero. */
  debit: number
  credit: number
  memo: string
  /** Reconciliation status, read-only. Set by the reconcile screen. */
  cleared?: 'none' | 'pending' | 'reconciled'
}

export interface JournalEntry {
  id: number
  date: string
  ref: string
  memo: string
  isVoid: boolean
  isOpening: boolean
  lines: JournalLine[]
}

export interface JournalEntryInput {
  date: string
  ref: string
  memo: string
  isOpening?: boolean
  lines: JournalLine[]
}

export interface JournalEntrySummary {
  id: number
  date: string
  ref: string
  memo: string
  isVoid: boolean
  isOpening: boolean
  amount: number
  accounts: string
  attachmentCount: number
}

export interface EntryFilter {
  from?: string
  to?: string
  search?: string
}

/** Lets a change go through when it touches a closed period. */
export interface ClosingOverride {
  closingPassword?: string
  /** Confirmed by the user when no closing password is set. */
  confirmClosedPeriod?: boolean
  /** Confirmed by the user when the change touches a reconciled transaction. */
  confirmReconciled?: boolean
}

// ----- Reports -----

export type ReportKind = 'profitAndLoss' | 'balanceSheet' | 'trialBalance' | 'generalLedger' | 'reconciliation'

export interface Drill {
  accountId?: number
  from?: string | null
  to?: string
  entryId?: number
}

export interface ReportColumn {
  label: string
  kind: 'text' | 'money' | 'percent'
}

export interface ReportRow {
  kind: 'section' | 'line' | 'subtotal' | 'total' | 'grandTotal' | 'spacer'
  /** Text cells are strings, money cells are cents, percent cells are ratios. */
  cells: (string | number | null)[]
  indent?: number
  drills?: (Drill | null)[]
}

export interface Report {
  kind: ReportKind
  title: string
  companyName: string
  subtitle: string
  basis: string
  columns: ReportColumn[]
  rows: ReportRow[]
}

export interface ReportParams {
  kind: ReportKind
  /** P&L, GL: one or more periods. Balance sheet, TB: uses `to` of each period as the as-of date. */
  periods: { label: string; from: string; to: string }[]
  /** Add $ change and % change columns when there are exactly two periods. */
  showChange?: boolean
  accountIds?: number[]
  showZeroBalances?: boolean
  /** Reconciliation report: which reconciliation to show. */
  reconciliationId?: number
}

export interface RecentCompany {
  path: string
  name: string
  openedAt: string
}

// ----- Reconciliation -----

export interface Reconciliation {
  id: number
  accountId: number
  statementDate: string
  beginningBalance: number
  endingBalance: number
  /** Amount posted to Reconciliation Discrepancies, in the account's natural sign. */
  adjustment: number
  reconciledAt: string
}

export interface ReconcileItem {
  lineId: number
  entryId: number
  date: string
  ref: string
  memo: string
  /** Natural sign: positive increases the account (a deposit, a card charge). */
  amount: number
  marked: boolean
}

export interface ReconcileSession {
  account: Account
  lastReconciliation: Reconciliation | null
  beginningBalance: number
  /** Statement details saved by "Leave" or by starting the reconciliation. */
  draft: { statementDate: string; endingBalance: number } | null
  items: ReconcileItem[]
  clearedBalance: number
}

export interface StatementCharge {
  date: string
  /** Positive cents. */
  amount: number
  accountId: number | null
}

export interface ReconcileStart {
  accountId: number
  statementDate: string
  endingBalance: number
  serviceCharge?: StatementCharge
  interest?: StatementCharge
}

// ----- Bank feeds (CSV import) -----

export type BankTxStatus = 'review' | 'added' | 'matched' | 'excluded'

/** An existing register transaction that looks like the same bank transaction. */
export interface BankMatch {
  entryId: number
  date: string
  ref: string
  memo: string
}

export interface BankTransaction {
  id: number
  accountId: number
  importId: number | null
  date: string
  /** The bank's own description, as imported. */
  description: string
  bankMemo: string
  ref: string
  /** Cents. Positive is money in (a deposit, a card payment), negative is money out (a check, a card charge). */
  amount: number
  /** Cleaned-up name used as the entry memo. Starts as the bank description. */
  payee: string
  memo: string
  categoryId: number | null
  /** Where the category came from: a bank rule, a past choice for the same payee, or the user. */
  categorySource: 'rule' | 'history' | 'user' | null
  status: BankTxStatus
  /** The journal entry it was added as, or matched to. */
  entryId: number | null
  /** For review items: a register transaction it can be matched to instead of adding a new one. */
  match: BankMatch | null
  /** The user chose to add this as a new transaction even though a match was found. */
  ignoreMatch: boolean
  /** Receipts attached to the bank transaction or to the entry it became. */
  attachmentCount: number
}

export type BankTab = 'review' | 'done' | 'excluded'

export interface BankCounts {
  review: number
  done: number
  excluded: number
}

export interface BankTxPatch {
  payee?: string
  memo?: string
  categoryId?: number | null
  ignoreMatch?: boolean
}

export interface BankImportResult {
  importId: number
  imported: number
  duplicates: number
  categorized: number
  matched: number
}

export interface BankAcceptResult {
  added: number
  matched: number
  /** Selected items left in review because they have no category and no match. */
  skipped: number
}

export interface BankRule {
  id: number
  /** Matches when the bank description contains this text (any case). */
  contains: string
  direction: 'any' | 'in' | 'out'
  categoryId: number
  /** Optional cleaner payee name. */
  payee: string
}

export type BankRuleInput = Omit<BankRule, 'id'>

/** A folder the app checks for new bank CSV files for one account. */
export interface WatchFolder {
  accountId: number
  folder: string
  /** Add confident transactions without review: rule categories and matches to existing entries. */
  autoAccept: boolean
  /** Also add transactions categorized from past choices for the same payee. */
  acceptHistory: boolean
}

/** One file imported into an account, by hand or from its watched folder. */
export interface BankImportLog {
  id: number
  accountId: number
  fileName: string
  importedAt: string
  source: 'manual' | 'folder'
  imported: number
  duplicates: number
  /** Added or matched automatically. */
  autoAdded: number
  /** Why a watched-folder file was not imported, or what was left for review. */
  note: string
}

// ----- Attachments -----

/** What an attachment belongs to: a journal entry, or an imported bank transaction (before or after it's added). */
export type AttachmentTarget = { entryId: number } | { bankTxId: number }

export interface Attachment {
  id: number
  fileName: string
  mimeType: string
  /** Bytes. */
  size: number
  addedAt: string
}
