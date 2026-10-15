import type {
  Account,
  AccountInput,
  ClosingInfo,
  ClosingOverride,
  CompanyInfo,
  EntryFilter,
  JournalEntry,
  JournalEntryInput,
  JournalEntrySummary,
  RecentCompany,
  Report,
  ReportParams,
  TemplateId
} from './types'
import type { OpeningBalance } from '../core/openingBalances'

export type { OpeningBalance }

export interface OpenCompany {
  path: string
  info: CompanyInfo
  closing: ClosingInfo
}

export type ExportFormat = 'csv' | 'xlsx' | 'pdf'

/** Everything the UI can ask the main process to do. Each method returns a promise in the renderer. */
export interface Api {
  // Company files
  recentCompanies(): RecentCompany[]
  current(): OpenCompany | null
  newCompany(info: CompanyInfo, template: TemplateId): OpenCompany | null
  openCompany(path?: string): OpenCompany | null
  closeCompany(): void
  backupCompany(): string | null
  restoreCompany(): OpenCompany | null
  removeRecent(path: string): void

  // Company settings
  updateInfo(info: CompanyInfo): OpenCompany
  setClosing(closingDate: string | null, newPassword: string | null, currentPassword?: string): OpenCompany

  // Accounts
  listAccounts(): Account[]
  accountBalances(asOf: string): Record<number, number>
  createAccount(input: AccountInput): Account
  updateAccount(id: number, input: AccountInput): Account
  setAccountActive(id: number, active: boolean): void
  deleteAccount(id: number): void
  enterOpeningBalances(date: string, balances: OpeningBalance[], override?: ClosingOverride): JournalEntry

  // Journal entries
  listEntries(filter: EntryFilter): JournalEntrySummary[]
  getEntry(id: number): JournalEntry
  nextRef(): string
  createEntry(input: JournalEntryInput, override?: ClosingOverride): JournalEntry
  updateEntry(id: number, input: JournalEntryInput, override?: ClosingOverride): JournalEntry
  voidEntry(id: number, override?: ClosingOverride): void
  deleteEntry(id: number, override?: ClosingOverride): void

  // Reports
  report(params: ReportParams): Report
  exportReport(params: ReportParams, format: ExportFormat): string | null
  printReport(): void
}

export type ApiMethod = keyof Api

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; closedPeriod?: { closingDate: string; needsPassword: boolean } }

export type MenuCommand = 'new' | 'open' | 'close' | 'backup' | 'restore'
