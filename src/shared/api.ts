import type {
  Account,
  AccountInput,
  Attachment,
  AttachmentTarget,
  BankAcceptResult,
  BankCounts,
  BankImportResult,
  BankRule,
  BankRuleInput,
  BankTab,
  BankTransaction,
  BankTxPatch,
  BankImportLog,
  WatchFolder,
  ClosingInfo,
  ClosingOverride,
  CompanyInfo,
  EntryFilter,
  JournalEntry,
  JournalEntryInput,
  JournalEntrySummary,
  ReconcileSession,
  ReconcileStart,
  Reconciliation,
  RecentCompany,
  Report,
  ReportParams,
  TemplateId
} from './types'
import type { OpeningBalance } from '../core/openingBalances'
import type { BankRowInput, CsvMapping } from '../core/csv'

export type { OpeningBalance, BankRowInput, CsvMapping }

/** A saved column mapping, with the header titles it was made for. */
export type SavedCsvMapping = CsvMapping & { headers?: string[] }

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

  // Reconciliation
  reconcileSession(accountId: number): ReconcileSession
  startReconcile(input: ReconcileStart, override?: ClosingOverride): ReconcileSession
  setReconcileMarked(accountId: number, lineIds: number[], marked: boolean): ReconcileSession
  discardReconcile(accountId: number): void
  finishReconcile(accountId: number, adjust: boolean, override?: ClosingOverride): number
  undoLastReconciliation(accountId: number): void
  listReconciliations(accountId: number): Reconciliation[]

  // Bank feeds
  bankCounts(accountId: number): BankCounts
  listBankTransactions(accountId: number, tab: BankTab): BankTransaction[]
  getCsvMapping(accountId: number): SavedCsvMapping | null
  importBankRows(accountId: number, fileName: string, rows: BankRowInput[], mapping?: SavedCsvMapping): BankImportResult
  updateBankTransactions(ids: number[], patch: BankTxPatch): void
  acceptBankTransactions(ids: number[], override?: ClosingOverride): BankAcceptResult
  excludeBankTransactions(ids: number[], excluded: boolean): void
  undoBankTransactions(ids: number[], override?: ClosingOverride): void
  deleteBankTransactions(ids: number[]): void
  applyBankRules(accountId: number): number
  listBankRules(): BankRule[]
  saveBankRule(id: number | null, input: BankRuleInput): BankRule
  deleteBankRule(id: number): void
  listBankImports(accountId: number): BankImportLog[]
  getWatchFolder(accountId: number): WatchFolder | null
  setWatchFolder(accountId: number, settings: Omit<WatchFolder, 'accountId'> | null): WatchFolder | null
  chooseFolder(): string | null
  /** Checks the watched folders now. Returns how many files were imported or set aside. */
  checkWatchFolders(): number

  // Attachments (receipts)
  listAttachments(target: AttachmentTarget): Attachment[]
  addAttachment(target: AttachmentTarget, fileName: string, data: Uint8Array): Attachment
  getAttachment(id: number): Attachment & { data: Uint8Array }
  deleteAttachment(id: number): void
  /** Opens the file in the program the computer uses for it. */
  openAttachment(id: number): void
  saveAttachmentAs(id: number): string | null

  // Reports
  report(params: ReportParams): Report
  exportReport(params: ReportParams, format: ExportFormat): string | null
  printReport(): void
}

export type ApiMethod = keyof Api

export type ApiResult<T> =
  | { ok: true; value: T }
  | {
      ok: false
      error: string
      closedPeriod?: { closingDate: string; needsPassword: boolean }
      /** The change touches a reconciled transaction and needs confirmation. */
      reconciledChange?: boolean
    }

export type MenuCommand = 'new' | 'open' | 'close' | 'backup' | 'restore' | 'refresh'
