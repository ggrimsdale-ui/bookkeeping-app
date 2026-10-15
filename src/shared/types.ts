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
