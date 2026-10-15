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
}

// ----- Reports -----

export type ReportKind = 'profitAndLoss' | 'balanceSheet' | 'trialBalance' | 'generalLedger'

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
}

export interface RecentCompany {
  path: string
  name: string
  openedAt: string
}
