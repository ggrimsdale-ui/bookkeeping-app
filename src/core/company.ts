import type { Database, SqlJsStatic, SqlValue } from 'sql.js'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { ACCOUNT_TYPES, TYPE_ORDER, isAccountType } from './accountTypes'
import type { AccountType } from './accountTypes'
import { assertDate, formatDate } from './dates'
import { templateAccounts } from './templates'
import type { TemplateId } from './templates'
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
  JournalLine
} from '../shared/types'

export const SCHEMA_VERSION = 2
const FILE_MARKER = 'bookkeeping-company'

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  parent_id INTEGER REFERENCES accounts(id),
  description TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  system TEXT
);
CREATE TABLE journal_entries (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '',
  is_void INTEGER NOT NULL DEFAULT 0,
  is_opening INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE journal_lines (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  debit INTEGER NOT NULL DEFAULT 0,
  credit INTEGER NOT NULL DEFAULT 0,
  memo TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_entries_date ON journal_entries(date);
CREATE INDEX idx_lines_entry ON journal_lines(entry_id);
CREATE INDEX idx_lines_account ON journal_lines(account_id);
`

/** Upgrades applied in order. Index i upgrades a file from version i + 1 to i + 2. */
const MIGRATIONS = [
  // 2: account reconciliation
  `
  ALTER TABLE journal_lines ADD COLUMN cleared TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE journal_lines ADD COLUMN reconciliation_id INTEGER REFERENCES reconciliations(id);
  CREATE TABLE reconciliations (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    statement_date TEXT NOT NULL,
    beginning_balance INTEGER NOT NULL,
    ending_balance INTEGER NOT NULL,
    adjustment INTEGER NOT NULL DEFAULT 0,
    reconciled_at TEXT NOT NULL
  );
  CREATE TABLE reconcile_drafts (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
    statement_date TEXT NOT NULL,
    ending_balance INTEGER NOT NULL
  );
  CREATE INDEX idx_reconciliations_account ON reconciliations(account_id);
  `
]

type Row = Record<string, SqlValue>

interface AccountRow {
  id: number
  number: string
  name: string
  type: string
  parent_id: number | null
  description: string
  is_active: number
  system: string | null
}

export class Company {
  private constructor(readonly db: Database) {
    db.run('PRAGMA foreign_keys = ON')
  }

  // ----- Lifecycle -----

  static create(SQL: SqlJsStatic, info: CompanyInfo, template: TemplateId): Company {
    const company = new Company(new SQL.Database())
    company.validateInfo(info)
    company.transaction(() => {
      company.db.exec(SCHEMA)
      company.setMeta('marker', FILE_MARKER)
      company.setMeta('schemaVersion', '1')
      company.migrate()
      company.writeInfo(info)
      const idsByNumber = new Map<string, number>()
      for (const a of templateAccounts(template)) {
        const parentId = a.parent ? idsByNumber.get(a.parent) ?? null : null
        company.db.run(
          'INSERT INTO accounts (number, name, type, parent_id, system) VALUES (?, ?, ?, ?, ?)',
          [a.number, a.name, a.type, parentId, a.system ?? null]
        )
        idsByNumber.set(a.number, company.lastId())
      }
    })
    return company
  }

  static open(SQL: SqlJsStatic, bytes: Uint8Array): Company {
    let db: Database
    try {
      db = new SQL.Database(bytes)
      const marker = db.exec("SELECT value FROM meta WHERE key = 'marker'")
      if (marker[0]?.values[0]?.[0] !== FILE_MARKER) throw new Error()
    } catch {
      throw new Error('This file is not a Bookkeeping company file.')
    }
    const company = new Company(db)
    const version = Number(company.getMeta('schemaVersion'))
    if (version > SCHEMA_VERSION) {
      throw new Error('This company file was created by a newer version of the app. Please update the app.')
    }
    if (version < SCHEMA_VERSION) company.transaction(() => company.migrate())
    return company
  }

  /** Brings the schema up to SCHEMA_VERSION. Runs inside the caller's transaction. */
  private migrate(): void {
    for (let v = Number(this.getMeta('schemaVersion')); v < SCHEMA_VERSION; v++) {
      this.db.exec(MIGRATIONS[v - 1])
      this.setMeta('schemaVersion', String(v + 1))
    }
  }

  export(): Uint8Array {
    return this.db.export()
  }

  close(): void {
    this.db.close()
  }

  // ----- Low-level helpers -----

  /** @internal Used by the reconcile module. */
  all<T>(sql: string, params: SqlValue[] = []): T[] {
    const stmt = this.db.prepare(sql)
    try {
      stmt.bind(params)
      const rows: T[] = []
      while (stmt.step()) rows.push(stmt.getAsObject() as T)
      return rows
    } finally {
      stmt.free()
    }
  }

  get<T>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.all<T>(sql, params)[0]
  }

  lastId(): number {
    return this.db.exec('SELECT last_insert_rowid()')[0].values[0][0] as number
  }

  transaction<T>(fn: () => T): T {
    this.db.run('BEGIN')
    try {
      const result = fn()
      this.db.run('COMMIT')
      return result
    } catch (err) {
      this.db.run('ROLLBACK')
      throw err
    }
  }

  private getMeta(key: string): string | null {
    return this.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key])?.value ?? null
  }

  private setMeta(key: string, value: string | null): void {
    if (value === null) this.db.run('DELETE FROM meta WHERE key = ?', [key])
    else this.db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value])
  }

  // ----- Company info -----

  getInfo(): CompanyInfo {
    return {
      name: this.getMeta('name') ?? '',
      legalName: this.getMeta('legalName') ?? '',
      address: this.getMeta('address') ?? '',
      taxId: this.getMeta('taxId') ?? '',
      fiscalYearStartMonth: Number(this.getMeta('fiscalYearStartMonth') ?? 1)
    }
  }

  updateInfo(info: CompanyInfo): void {
    this.validateInfo(info)
    this.transaction(() => this.writeInfo(info))
  }

  private validateInfo(info: CompanyInfo): void {
    if (!info.name.trim()) throw new Error('Company name is required')
    const m = info.fiscalYearStartMonth
    if (!Number.isInteger(m) || m < 1 || m > 12) throw new Error('Fiscal year start month must be 1-12')
  }

  private writeInfo(info: CompanyInfo): void {
    this.setMeta('name', info.name.trim())
    this.setMeta('legalName', info.legalName.trim())
    this.setMeta('address', info.address.trim())
    this.setMeta('taxId', info.taxId.trim())
    this.setMeta('fiscalYearStartMonth', String(info.fiscalYearStartMonth))
  }

  // ----- Closing date -----

  getClosing(): ClosingInfo {
    return { closingDate: this.getMeta('closingDate'), hasPassword: this.getMeta('closingPassword') !== null }
  }

  /**
   * Sets or clears the closing date. Changing an existing password-protected
   * closing date requires the current password.
   */
  setClosing(closingDate: string | null, newPassword: string | null, currentPassword?: string): void {
    if (this.getClosing().hasPassword && !this.checkClosingPassword(currentPassword)) {
      throw new Error('The current closing date password is incorrect.')
    }
    if (closingDate !== null) assertDate(closingDate, 'Closing date')
    this.transaction(() => {
      this.setMeta('closingDate', closingDate)
      this.setMeta('closingPassword', closingDate && newPassword ? hashPassword(newPassword) : null)
    })
  }

  private checkClosingPassword(password: string | undefined): boolean {
    const stored = this.getMeta('closingPassword')
    if (stored === null) return true
    return password !== undefined && verifyPassword(password, stored)
  }

  private assertOpenPeriod(dates: string[], override: ClosingOverride = {}): void {
    const { closingDate, hasPassword } = this.getClosing()
    if (!closingDate || !dates.some((d) => d <= closingDate)) return
    if (hasPassword) {
      if (!this.checkClosingPassword(override.closingPassword)) {
        throw new ClosedPeriodError(closingDate, true)
      }
    } else if (!override.confirmClosedPeriod) {
      throw new ClosedPeriodError(closingDate, false)
    }
  }

  // ----- Accounts -----

  listAccounts(includeInactive = true): Account[] {
    const rows = this.all<AccountRow>('SELECT * FROM accounts')
    const byId = new Map(rows.map((r) => [r.id, r]))
    const typeRank = (t: string): number => TYPE_ORDER.indexOf(t as AccountType)
    const sortKey = (r: AccountRow): string => `${r.number.padStart(12, ' ')}|${r.name.toLowerCase()}`

    // Depth-first walk so sub-accounts follow their parent.
    const children = new Map<number | null, AccountRow[]>()
    for (const r of rows) {
      const key = r.parent_id !== null && byId.has(r.parent_id) ? r.parent_id : null
      const list = children.get(key) ?? []
      list.push(r)
      children.set(key, list)
    }
    for (const list of children.values()) {
      list.sort((a, b) => typeRank(a.type) - typeRank(b.type) || sortKey(a).localeCompare(sortKey(b)))
    }

    const result: Account[] = []
    const walk = (parentId: number | null, depth: number, prefix: string): void => {
      for (const r of children.get(parentId) ?? []) {
        const label = r.number ? `${r.number} · ${r.name}` : r.name
        const fullName = prefix ? `${prefix}:${label}` : label
        result.push(toAccount(r, fullName, depth))
        walk(r.id, depth + 1, fullName)
      }
    }
    walk(null, 0, '')
    return includeInactive ? result : result.filter((a) => a.isActive)
  }

  getAccount(id: number): Account {
    const account = this.listAccounts().find((a) => a.id === id)
    if (!account) throw new Error('Account not found')
    return account
  }

  createAccount(input: AccountInput): Account {
    const clean = this.validateAccount(input, null)
    const id = this.transaction(() => {
      this.db.run(
        'INSERT INTO accounts (number, name, type, parent_id, description) VALUES (?, ?, ?, ?, ?)',
        [clean.number, clean.name, clean.type, clean.parentId, clean.description]
      )
      return this.lastId()
    })
    return this.getAccount(id)
  }

  updateAccount(id: number, input: AccountInput): Account {
    const existing = this.getAccount(id)
    const clean = this.validateAccount(input, id)
    if (existing.system && clean.type !== existing.type) {
      throw new Error(`The type of ${existing.name} cannot be changed.`)
    }
    if (clean.type !== existing.type) {
      const kids = this.get<{ n: number }>('SELECT COUNT(*) AS n FROM accounts WHERE parent_id = ?', [id])!.n
      if (kids > 0) throw new Error('Change the type of the sub-accounts first, or move them to another parent.')
    }
    this.transaction(() => {
      this.db.run(
        'UPDATE accounts SET number = ?, name = ?, type = ?, parent_id = ?, description = ? WHERE id = ?',
        [clean.number, clean.name, clean.type, clean.parentId, clean.description, id]
      )
    })
    return this.getAccount(id)
  }

  setAccountActive(id: number, active: boolean): void {
    const account = this.getAccount(id)
    if (!active && account.system) throw new Error(`${account.name} is a system account and cannot be made inactive.`)
    this.transaction(() => this.db.run('UPDATE accounts SET is_active = ? WHERE id = ?', [active ? 1 : 0, id]))
  }

  deleteAccount(id: number): void {
    const account = this.getAccount(id)
    if (account.system) throw new Error(`${account.name} is a system account and cannot be deleted.`)
    const used = this.get<{ n: number }>('SELECT COUNT(*) AS n FROM journal_lines WHERE account_id = ?', [id])!.n
    if (used > 0) throw new Error('This account has transactions. Make it inactive instead of deleting it.')
    const kids = this.get<{ n: number }>('SELECT COUNT(*) AS n FROM accounts WHERE parent_id = ?', [id])!.n
    if (kids > 0) throw new Error('This account has sub-accounts. Delete or move them first.')
    this.transaction(() => this.db.run('DELETE FROM accounts WHERE id = ?', [id]))
  }

  private validateAccount(input: AccountInput, id: number | null): AccountInput {
    const clean: AccountInput = {
      number: input.number.trim(),
      name: input.name.trim(),
      type: input.type,
      parentId: input.parentId ?? null,
      description: input.description.trim()
    }
    if (!clean.name) throw new Error('Account name is required')
    if (clean.name.includes(':')) throw new Error('Account names cannot contain a colon')
    if (!isAccountType(clean.type)) throw new Error('Choose an account type')
    if (clean.number && !/^[A-Za-z0-9.-]+$/.test(clean.number)) {
      throw new Error('Account numbers can only contain letters, digits, dots and dashes')
    }
    if (clean.number) {
      const dup = this.get<{ id: number }>('SELECT id FROM accounts WHERE number = ? AND id IS NOT ?', [clean.number, id])
      if (dup) throw new Error(`Account number ${clean.number} is already used`)
    }
    const dupName = this.get<{ id: number }>(
      'SELECT id FROM accounts WHERE lower(name) = lower(?) AND parent_id IS ? AND id IS NOT ?',
      [clean.name, clean.parentId, id]
    )
    if (dupName) throw new Error(`An account named ${clean.name} already exists at this level`)
    if (clean.parentId !== null) {
      const parent = this.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', [clean.parentId])
      if (!parent) throw new Error('Parent account not found')
      if (parent.type !== clean.type) {
        throw new Error(`A sub-account must have the same type as its parent (${ACCOUNT_TYPES[parent.type as AccountType].label})`)
      }
      // Prevent cycles: walk up from the new parent.
      let cursor: number | null = clean.parentId
      while (cursor !== null) {
        if (cursor === id) throw new Error('An account cannot be a sub-account of itself')
        cursor = this.get<{ parent_id: number | null }>('SELECT parent_id FROM accounts WHERE id = ?', [cursor])?.parent_id ?? null
      }
    }
    return clean
  }

  // ----- Journal entries -----

  getEntry(id: number): JournalEntry {
    const row = this.get<Row>('SELECT * FROM journal_entries WHERE id = ?', [id])
    if (!row) throw new Error('Journal entry not found')
    const lines = this.all<Row>('SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY line_no', [id])
    return {
      id: row.id as number,
      date: row.date as string,
      ref: row.ref as string,
      memo: row.memo as string,
      isVoid: row.is_void === 1,
      isOpening: row.is_opening === 1,
      lines: lines.map((l) => ({
        accountId: l.account_id as number,
        debit: l.debit as number,
        credit: l.credit as number,
        memo: l.memo as string,
        cleared: l.cleared as JournalLine['cleared']
      }))
    }
  }

  listEntries(filter: EntryFilter = {}): JournalEntrySummary[] {
    const where: string[] = []
    const params: SqlValue[] = []
    if (filter.from) {
      where.push('e.date >= ?')
      params.push(filter.from)
    }
    if (filter.to) {
      where.push('e.date <= ?')
      params.push(filter.to)
    }
    if (filter.search?.trim()) {
      const q = `%${filter.search.trim().toLowerCase()}%`
      where.push(
        '(lower(e.ref) LIKE ? OR lower(e.memo) LIKE ? OR EXISTS (SELECT 1 FROM journal_lines s WHERE s.entry_id = e.id AND lower(s.memo) LIKE ?))'
      )
      params.push(q, q, q)
    }
    const rows = this.all<Row>(
      `SELECT e.*, (SELECT SUM(debit) FROM journal_lines WHERE entry_id = e.id) AS amount
       FROM journal_entries e ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY e.date DESC, e.id DESC`,
      params
    )
    const names = new Map(this.listAccounts().map((a) => [a.id, a.fullName]))
    const lineAccounts = new Map<number, number[]>()
    for (const l of this.all<{ entry_id: number; account_id: number }>(
      'SELECT entry_id, account_id FROM journal_lines ORDER BY entry_id, line_no'
    )) {
      const list = lineAccounts.get(l.entry_id) ?? []
      if (!list.includes(l.account_id)) list.push(l.account_id)
      lineAccounts.set(l.entry_id, list)
    }
    return rows.map((r) => {
      const ids = lineAccounts.get(r.id as number) ?? []
      return {
        id: r.id as number,
        date: r.date as string,
        ref: r.ref as string,
        memo: r.memo as string,
        isVoid: r.is_void === 1,
        isOpening: r.is_opening === 1,
        amount: (r.amount as number) ?? 0,
        accounts: ids.length > 2 ? '-SPLIT-' : ids.map((id) => names.get(id) ?? '?').join(' / ')
      }
    })
  }

  createEntry(input: JournalEntryInput, override?: ClosingOverride): JournalEntry {
    const clean = this.validateEntry(input)
    this.assertOpenPeriod([clean.date], override)
    const id = this.transaction(() => {
      const now = new Date().toISOString()
      this.db.run(
        'INSERT INTO journal_entries (date, ref, memo, is_opening, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [clean.date, clean.ref, clean.memo, clean.isOpening ? 1 : 0, now, now]
      )
      const entryId = this.lastId()
      this.insertLines(entryId, clean)
      return entryId
    })
    return this.getEntry(id)
  }

  updateEntry(id: number, input: JournalEntryInput, override?: ClosingOverride): JournalEntry {
    const existing = this.getEntry(id)
    if (existing.isVoid) throw new Error('A void entry cannot be edited.')
    const clean = this.validateEntry(input)
    this.assertOpenPeriod([existing.date, clean.date], override)

    // Carry each line's cleared status over to the matching new line (same account and amount).
    type Status = { account_id: number; debit: number; credit: number; cleared: string; reconciliation_id: number | null }
    const old = this.all<Status>('SELECT account_id, debit, credit, cleared, reconciliation_id FROM journal_lines WHERE entry_id = ?', [id])
    const carried = clean.lines.map((l) => {
      const i = old.findIndex((o) => o.account_id === l.accountId && o.debit === l.debit && o.credit === l.credit)
      return i === -1 ? null : old.splice(i, 1)[0]
    })
    if (old.some((o) => o.cleared === 'reconciled') && !override?.confirmReconciled) throw new ReconciledChangeError()

    this.transaction(() => {
      this.db.run(
        'UPDATE journal_entries SET date = ?, ref = ?, memo = ?, is_opening = ?, updated_at = ? WHERE id = ?',
        [clean.date, clean.ref, clean.memo, clean.isOpening ? 1 : 0, new Date().toISOString(), id]
      )
      this.db.run('DELETE FROM journal_lines WHERE entry_id = ?', [id])
      this.insertLines(id, clean, carried)
    })
    return this.getEntry(id)
  }

  /** Voiding keeps the entry for the record but removes it from all balances and reports. */
  voidEntry(id: number, override?: ClosingOverride): void {
    const existing = this.getEntry(id)
    this.assertOpenPeriod([existing.date], override)
    this.assertReconciledChangeConfirmed(existing, override)
    this.transaction(() => {
      this.db.run("UPDATE journal_entries SET is_void = 1, memo = 'VOID: ' || memo, updated_at = ? WHERE id = ?", [
        new Date().toISOString(),
        id
      ])
    })
  }

  deleteEntry(id: number, override?: ClosingOverride): void {
    const existing = this.getEntry(id)
    this.assertOpenPeriod([existing.date], override)
    this.assertReconciledChangeConfirmed(existing, override)
    this.transaction(() => {
      this.db.run('DELETE FROM journal_lines WHERE entry_id = ?', [id])
      this.db.run('DELETE FROM journal_entries WHERE id = ?', [id])
    })
  }

  /** Suggests the next reference number by incrementing the most recent numeric one. */
  nextRef(): string {
    const row = this.get<{ ref: string }>(
      "SELECT ref FROM journal_entries WHERE ref GLOB '*[0-9]' ORDER BY id DESC LIMIT 1"
    )
    if (!row) return '1'
    return row.ref.replace(/(\d+)$/, (digits) => String(Number(digits) + 1).padStart(digits.length, '0'))
  }

  private assertReconciledChangeConfirmed(entry: JournalEntry, override?: ClosingOverride): void {
    if (entry.lines.some((l) => l.cleared === 'reconciled') && !override?.confirmReconciled) throw new ReconciledChangeError()
  }

  private insertLines(
    entryId: number,
    entry: JournalEntryInput,
    status: ({ cleared: string; reconciliation_id: number | null } | null)[] = []
  ): void {
    entry.lines.forEach((l, i) => {
      this.db.run(
        'INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit, memo, cleared, reconciliation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [entryId, i + 1, l.accountId, l.debit, l.credit, l.memo.trim(), status[i]?.cleared ?? 'none', status[i]?.reconciliation_id ?? null]
      )
    })
  }

  private validateEntry(input: JournalEntryInput): JournalEntryInput {
    assertDate(input.date)
    const lines = input.lines.filter((l) => l.debit !== 0 || l.credit !== 0 || l.accountId)
    if (lines.length < 2) throw new Error('A journal entry needs at least two lines.')
    const accounts = new Map(this.listAccounts().map((a) => [a.id, a]))
    let debits = 0
    let credits = 0
    lines.forEach((l, i) => {
      const n = i + 1
      const account = accounts.get(l.accountId)
      if (!account) throw new Error(`Line ${n}: choose an account.`)
      if (!account.isActive) throw new Error(`Line ${n}: ${account.name} is inactive.`)
      for (const v of [l.debit, l.credit]) {
        if (!Number.isSafeInteger(v) || v < 0) throw new Error(`Line ${n}: amounts must be positive.`)
      }
      if (l.debit > 0 && l.credit > 0) throw new Error(`Line ${n}: enter a debit or a credit, not both.`)
      if (l.debit === 0 && l.credit === 0) throw new Error(`Line ${n}: enter an amount.`)
      debits += l.debit
      credits += l.credit
    })
    if (debits !== credits) {
      throw new Error(
        `Debits (${(debits / 100).toFixed(2)}) and credits (${(credits / 100).toFixed(2)}) must be equal.`
      )
    }
    return {
      date: input.date,
      ref: input.ref.trim(),
      memo: input.memo.trim(),
      isOpening: !!input.isOpening,
      lines
    }
  }

  // ----- Queries used by reports -----

  /** Net (debit - credit) per account for non-void lines dated within [from, to]. `from` null means since the beginning. */
  netByAccount(from: string | null, to: string): Map<number, number> {
    const rows = this.all<{ account_id: number; net: number }>(
      `SELECT l.account_id, SUM(l.debit - l.credit) AS net
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.is_void = 0 AND e.date <= ? AND (? IS NULL OR e.date >= ?)
       GROUP BY l.account_id`,
      [to, from, from]
    )
    return new Map(rows.map((r) => [r.account_id, r.net]))
  }

  linesForAccounts(
    accountIds: number[],
    from: string,
    to: string
  ): { entryId: number; date: string; ref: string; entryMemo: string; lineMemo: string; accountId: number; debit: number; credit: number }[] {
    if (accountIds.length === 0) return []
    const rows = this.all<Row>(
      `SELECT e.id AS entry_id, e.date, e.ref, e.memo AS entry_memo, l.memo AS line_memo, l.account_id, l.debit, l.credit
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
       WHERE e.is_void = 0 AND e.date >= ? AND e.date <= ? AND l.account_id IN (${accountIds.map(() => '?').join(',')})
       ORDER BY e.date, e.id, l.line_no`,
      [from, to, ...accountIds]
    )
    return rows.map((r) => ({
      entryId: r.entry_id as number,
      date: r.date as string,
      ref: r.ref as string,
      entryMemo: r.entry_memo as string,
      lineMemo: r.line_memo as string,
      accountId: r.account_id as number,
      debit: r.debit as number,
      credit: r.credit as number
    }))
  }

  /** Account ids used on each entry, for the "Split" column. */
  entryAccounts(entryIds: number[]): Map<number, number[]> {
    const result = new Map<number, number[]>()
    if (entryIds.length === 0) return result
    const unique = [...new Set(entryIds)]
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500)
      for (const r of this.all<{ entry_id: number; account_id: number }>(
        `SELECT entry_id, account_id FROM journal_lines WHERE entry_id IN (${chunk.map(() => '?').join(',')}) ORDER BY line_no`,
        chunk
      )) {
        const list = result.get(r.entry_id) ?? []
        if (!list.includes(r.account_id)) list.push(r.account_id)
        result.set(r.entry_id, list)
      }
    }
    return result
  }
}

export class ClosedPeriodError extends Error {
  constructor(
    readonly closingDate: string,
    readonly needsPassword: boolean
  ) {
    super(
      needsPassword
        ? `This change affects a closed period (on or before ${formatDate(closingDate)}). Enter the closing date password to continue.`
        : `This change affects a closed period (on or before ${formatDate(closingDate)}). Confirm to continue.`
    )
    this.name = 'ClosedPeriodError'
  }
}

export class ReconciledChangeError extends Error {
  constructor() {
    super(
      'This entry includes a reconciled transaction. Changing it will throw off the beginning balance of your next reconciliation. Continue anyway?'
    )
    this.name = 'ReconciledChangeError'
  }
}

function toAccount(r: AccountRow, fullName: string, depth: number): Account {
  return {
    id: r.id,
    number: r.number,
    name: r.name,
    type: r.type as AccountType,
    parentId: r.parent_id,
    description: r.description,
    isActive: r.is_active === 1,
    system: (r.system as Account['system']) ?? null,
    fullName,
    depth
  }
}

function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':')
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length)
  return timingSafeEqual(expected, actual)
}
