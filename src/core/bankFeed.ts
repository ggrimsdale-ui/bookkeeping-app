// Bank feeds: transactions imported from a bank's CSV file wait in a review
// list, get a category (by hand, in bulk, from a bank rule or from what was
// chosen for the same payee before), and are then added to the books as
// journal entries or matched to transactions already entered. Like the
// QuickBooks bank feed center.

import { isProfitAndLoss } from './accountTypes'
import type { Company } from './company'
import type { BankRowInput, CsvMapping } from './csv'
import { assertDate } from './dates'
import type {
  Account,
  BankAcceptResult,
  BankCounts,
  BankImportResult,
  BankMatch,
  BankRule,
  BankRuleInput,
  BankTab,
  BankTransaction,
  BankTxPatch,
  ClosingOverride
} from '../shared/types'

/** How far apart the bank date and the register date can be for a suggested match. */
const MATCH_DAYS = 10

interface TxRow {
  id: number
  account_id: number
  import_id: number | null
  date: string
  description: string
  bank_memo: string
  ref: string
  amount: number
  payee: string
  memo: string
  category_id: number | null
  category_source: string | null
  status: string
  entry_id: number | null
  ignore_match: number
}

/** Bank feeds work on balance sheet accounts: bank, credit card, loans and the like. */
function feedAccount(company: Company, accountId: number): Account {
  const account = company.getAccount(accountId)
  if (isProfitAndLoss(account.type)) throw new Error('Bank transactions can only be imported into a balance sheet account.')
  return account
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Identifies a bank transaction for duplicate checks: same date, amount and description. */
export function fingerprint(row: { date: string; amount: number; description: string }): string {
  return `${row.date}|${row.amount}|${normalize(row.description)}`
}

/**
 * The part of a bank description that names the payee, without card numbers,
 * dates and reference codes: "SQ *BLUE BOTTLE 0423" and "SQ *BLUE BOTTLE 0511" are the same payee.
 */
export function payeeKey(description: string): string {
  return description
    .toLowerCase()
    .split(/[^a-z0-9&']+/)
    .filter((w) => w && !/\d/.test(w))
    .join(' ')
}

function toTx(r: TxRow): BankTransaction {
  return {
    id: r.id,
    accountId: r.account_id,
    importId: r.import_id,
    date: r.date,
    description: r.description,
    bankMemo: r.bank_memo,
    ref: r.ref,
    amount: r.amount,
    payee: r.payee,
    memo: r.memo,
    categoryId: r.category_id,
    categorySource: (r.category_source as BankTransaction['categorySource']) ?? null,
    status: r.status as BankTransaction['status'],
    entryId: r.entry_id,
    match: null,
    ignoreMatch: r.ignore_match === 1,
    attachmentCount: 0
  }
}

function inChunks(ids: number[], fn: (chunk: number[], placeholders: string) => void): void {
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    fn(chunk, chunk.map(() => '?').join(','))
  }
}

function loadTxs(company: Company, ids: number[]): TxRow[] {
  const rows: TxRow[] = []
  inChunks([...new Set(ids)], (chunk, ph) => {
    rows.push(...company.all<TxRow>(`SELECT * FROM bank_transactions WHERE id IN (${ph}) ORDER BY date, id`, chunk))
  })
  return rows
}

// ----- Column mappings -----

/** The column mapping used for this account's last import, so the next file from the same bank needs no setup. */
export function getCsvMapping(company: Company, accountId: number): (CsvMapping & { headers?: string[] }) | null {
  const row = company.get<{ mapping: string }>('SELECT mapping FROM bank_csv_mappings WHERE account_id = ?', [accountId])
  if (!row) return null
  try {
    return JSON.parse(row.mapping)
  } catch {
    return null
  }
}

// ----- Categorizing -----

export function listRules(company: Company): BankRule[] {
  return company
    .all<{ id: number; contains: string; direction: string; category_id: number; payee: string }>(
      'SELECT * FROM bank_rules ORDER BY lower(contains)'
    )
    .map((r) => ({ id: r.id, contains: r.contains, direction: r.direction as BankRule['direction'], categoryId: r.category_id, payee: r.payee }))
}

export function saveRule(company: Company, id: number | null, input: BankRuleInput): BankRule {
  const contains = input.contains.trim()
  if (!contains) throw new Error('Enter the text the bank description should contain.')
  if (!['any', 'in', 'out'].includes(input.direction)) throw new Error('Choose money in, money out or both.')
  const category = company.listAccounts().find((a) => a.id === input.categoryId)
  if (!category) throw new Error('Choose the account to categorize to.')
  if (!category.isActive) throw new Error(`${category.name} is inactive.`)
  const payee = input.payee.trim()
  const ruleId = company.transaction(() => {
    if (id === null) {
      company.db.run('INSERT INTO bank_rules (contains, direction, category_id, payee) VALUES (?, ?, ?, ?)', [
        contains,
        input.direction,
        category.id,
        payee
      ])
      return company.lastId()
    }
    if (!company.get('SELECT id FROM bank_rules WHERE id = ?', [id])) throw new Error('Rule not found')
    company.db.run('UPDATE bank_rules SET contains = ?, direction = ?, category_id = ?, payee = ? WHERE id = ?', [
      contains,
      input.direction,
      category.id,
      payee,
      id
    ])
    return id
  })
  return listRules(company).find((r) => r.id === ruleId)!
}

export function deleteRule(company: Company, id: number): void {
  company.transaction(() => company.db.run('DELETE FROM bank_rules WHERE id = ?', [id]))
}

interface Suggestion {
  categoryId: number
  source: 'rule' | 'history'
  payee?: string
}

/** Builds a function that suggests a category for a bank description: bank rules first, then past choices. */
function suggester(company: Company, account: Account): (description: string, amount: number) => Suggestion | null {
  const active = new Set(company.listAccounts(false).map((a) => a.id))
  // Longer (more specific) rule text wins over shorter.
  const rules = listRules(company)
    .filter((r) => active.has(r.categoryId) && r.categoryId !== account.id)
    .sort((a, b) => b.contains.length - a.contains.length)
  const history = new Map<string, number>()
  for (const r of company.all<{ description: string; category_id: number }>(
    `SELECT description, category_id FROM bank_transactions
     WHERE account_id = ? AND status = 'added' AND category_id IS NOT NULL
     ORDER BY date, id`,
    [account.id]
  )) {
    // Later rows overwrite earlier ones, so the most recent choice wins.
    if (active.has(r.category_id)) history.set(payeeKey(r.description), r.category_id)
  }
  return (description, amount) => {
    const text = description.toLowerCase()
    for (const r of rules) {
      if (r.direction === 'in' && amount < 0) continue
      if (r.direction === 'out' && amount > 0) continue
      if (text.includes(r.contains.toLowerCase())) return { categoryId: r.categoryId, source: 'rule', payee: r.payee || undefined }
    }
    const key = payeeKey(description)
    const past = key ? history.get(key) : undefined
    return past !== undefined ? { categoryId: past, source: 'history' } : null
  }
}

/** Fills in categories on review items the user hasn't categorized themselves. Returns how many changed. */
export function applyRules(company: Company, accountId: number): number {
  const account = feedAccount(company, accountId)
  const suggest = suggester(company, account)
  const rows = company.all<TxRow>(
    "SELECT * FROM bank_transactions WHERE account_id = ? AND status = 'review' AND (category_source IS NULL OR category_source != 'user')",
    [accountId]
  )
  let changed = 0
  company.transaction(() => {
    for (const r of rows) {
      const s = suggest(r.description, r.amount)
      if (!s) continue
      const payee = s.payee ?? r.payee
      if (s.categoryId === r.category_id && s.source === r.category_source && payee === r.payee) continue
      company.db.run('UPDATE bank_transactions SET category_id = ?, category_source = ?, payee = ? WHERE id = ?', [
        s.categoryId,
        s.source,
        payee,
        r.id
      ])
      changed++
    }
  })
  return changed
}

// ----- Matching -----

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86400000
}

/**
 * Pairs review items with register transactions already in the books for the
 * same amount within a few days, so they can be matched instead of entered twice.
 */
function findMatches(company: Company, accountId: number, items: TxRow[]): Map<number, BankMatch> {
  const result = new Map<number, BankMatch>()
  const wanted = items.filter((i) => i.status === 'review')
  if (wanted.length === 0) return result
  const candidates = company.all<{ entry_id: number; date: string; ref: string; memo: string; net: number }>(
    `SELECT l.entry_id, e.date, e.ref, COALESCE(NULLIF(e.memo, ''), l.memo) AS memo, l.debit - l.credit AS net
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = ? AND e.is_void = 0 AND e.is_opening = 0
       AND l.entry_id NOT IN (SELECT entry_id FROM bank_transactions WHERE entry_id IS NOT NULL)
     ORDER BY e.date, e.id`,
    [accountId]
  )
  const used = new Set<number>()
  // Items the user chose not to match are still shown their match, but only get one nobody else needs.
  const order = [...wanted].sort((a, b) => a.ignore_match - b.ignore_match || a.date.localeCompare(b.date) || a.id - b.id)
  for (const item of order) {
    let best: (typeof candidates)[number] | null = null
    let bestGap = Infinity
    for (const c of candidates) {
      // Debits to the account are money in, whether it's a bank account or a credit card.
      if (c.net !== item.amount || used.has(c.entry_id)) continue
      const gap = daysBetween(c.date, item.date)
      if (gap <= MATCH_DAYS && gap < bestGap) {
        best = c
        bestGap = gap
      }
    }
    if (best) {
      used.add(best.entry_id)
      result.set(item.id, { entryId: best.entry_id, date: best.date, ref: best.ref, memo: best.memo })
    }
  }
  return result
}

// ----- Listing -----

export function bankCounts(company: Company, accountId: number): BankCounts {
  const counts: BankCounts = { review: 0, done: 0, excluded: 0 }
  for (const r of company.all<{ status: string; n: number }>(
    'SELECT status, COUNT(*) AS n FROM bank_transactions WHERE account_id = ? GROUP BY status',
    [accountId]
  )) {
    if (r.status === 'review') counts.review += r.n
    else if (r.status === 'excluded') counts.excluded += r.n
    else counts.done += r.n
  }
  return counts
}

export function listBankTransactions(company: Company, accountId: number, tab: BankTab): BankTransaction[] {
  const statuses = tab === 'done' ? ['added', 'matched'] : [tab]
  const rows = company.all<TxRow>(
    `SELECT * FROM bank_transactions WHERE account_id = ? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY date DESC, id DESC`,
    [accountId, ...statuses]
  )
  const matches = tab === 'review' ? findMatches(company, accountId, rows) : new Map<number, BankMatch>()
  const counts = new Map<string, number>()
  for (const a of company.all<{ bank_tx_id: number | null; entry_id: number | null }>(
    `SELECT a.bank_tx_id, a.entry_id FROM attachments a
     WHERE a.bank_tx_id IN (SELECT id FROM bank_transactions WHERE account_id = ?)
        OR a.entry_id IN (SELECT entry_id FROM bank_transactions WHERE account_id = ? AND entry_id IS NOT NULL)`,
    [accountId, accountId]
  )) {
    // Counted once each, under the bank transaction and under the entry.
    if (a.bank_tx_id !== null) counts.set(`t${a.bank_tx_id}`, (counts.get(`t${a.bank_tx_id}`) ?? 0) + 1)
    else if (a.entry_id !== null) counts.set(`e${a.entry_id}`, (counts.get(`e${a.entry_id}`) ?? 0) + 1)
  }
  return rows.map((r) => ({
    ...toTx(r),
    match: matches.get(r.id) ?? null,
    attachmentCount: (counts.get(`t${r.id}`) ?? 0) + (r.entry_id !== null ? counts.get(`e${r.entry_id}`) ?? 0 : 0)
  }))
}

// ----- Importing -----

/**
 * Adds the rows from a bank file to the review list. Rows already imported
 * into this account (same date, amount and description) are skipped, so the
 * same or an overlapping file can be imported again safely. Two identical
 * rows in one file are both kept.
 */
export function importBankRows(
  company: Company,
  accountId: number,
  fileName: string,
  rows: BankRowInput[],
  mapping?: CsvMapping & { headers?: string[] }
): BankImportResult {
  const account = feedAccount(company, accountId)
  if (!account.isActive) throw new Error(`${account.name} is inactive.`)
  rows.forEach((r, i) => {
    assertDate(r.date, `Row ${i + 1} date`)
    if (!Number.isSafeInteger(r.amount) || r.amount === 0) throw new Error(`Row ${i + 1}: the amount is missing.`)
  })
  if (rows.length === 0) throw new Error('The file has no transactions to import.')

  const existing = new Map<string, number>()
  for (const r of company.all<{ fingerprint: string; n: number }>(
    'SELECT fingerprint, COUNT(*) AS n FROM bank_transactions WHERE account_id = ? GROUP BY fingerprint',
    [accountId]
  )) {
    existing.set(r.fingerprint, r.n)
  }
  const fresh: (BankRowInput & { fp: string })[] = []
  let duplicates = 0
  for (const r of rows) {
    const fp = fingerprint(r)
    const left = existing.get(fp) ?? 0
    if (left > 0) {
      existing.set(fp, left - 1)
      duplicates++
    } else fresh.push({ ...r, fp })
  }

  const suggest = suggester(company, account)
  let categorized = 0
  const importId = company.transaction(() => {
    company.db.run(
      'INSERT INTO bank_imports (account_id, file_name, imported_at, row_count, duplicate_count) VALUES (?, ?, ?, ?, ?)',
      [accountId, fileName, new Date().toISOString(), fresh.length, duplicates]
    )
    const id = company.lastId()
    for (const r of fresh) {
      const description = r.description.trim() || '(no description)'
      const s = suggest(description, r.amount)
      if (s) categorized++
      company.db.run(
        `INSERT INTO bank_transactions
          (account_id, import_id, date, description, bank_memo, ref, amount, fingerprint, payee, category_id, category_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [accountId, id, r.date, description, r.memo.trim(), r.ref.trim(), r.amount, r.fp, s?.payee ?? description, s?.categoryId ?? null, s?.source ?? null]
      )
    }
    if (mapping) {
      company.db.run('INSERT OR REPLACE INTO bank_csv_mappings (account_id, mapping) VALUES (?, ?)', [accountId, JSON.stringify(mapping)])
    }
    return id
  })
  const imported = company.all<TxRow>('SELECT * FROM bank_transactions WHERE import_id = ?', [importId])
  const matched = findMatches(company, accountId, company.all<TxRow>("SELECT * FROM bank_transactions WHERE account_id = ? AND status = 'review'", [accountId]))
  return {
    importId,
    imported: fresh.length,
    duplicates,
    categorized,
    matched: imported.filter((r) => matched.has(r.id)).length
  }
}

// ----- Editing in bulk -----

/** Changes the payee, memo, category or match choice of one or many review items at once. */
export function updateBankTransactions(company: Company, ids: number[], patch: BankTxPatch): void {
  const rows = loadTxs(company, ids).filter((r) => r.status === 'review')
  if (rows.length === 0) return
  let category: Account | undefined
  if (patch.categoryId !== undefined && patch.categoryId !== null) {
    category = company.listAccounts().find((a) => a.id === patch.categoryId)
    if (!category) throw new Error('Account not found')
    if (!category.isActive) throw new Error(`${category.name} is inactive.`)
    if (rows.some((r) => r.account_id === category!.id)) throw new Error('A transaction cannot be categorized to the account it was imported into.')
  }
  const sets: string[] = []
  const params: (string | number | null)[] = []
  if (patch.payee !== undefined) {
    const payee = patch.payee.trim()
    if (!payee) throw new Error('The payee cannot be blank.')
    sets.push('payee = ?')
    params.push(payee)
  }
  if (patch.memo !== undefined) {
    sets.push('memo = ?')
    params.push(patch.memo.trim())
  }
  if (patch.categoryId !== undefined) {
    sets.push('category_id = ?', 'category_source = ?')
    params.push(patch.categoryId, patch.categoryId === null ? null : 'user')
  }
  if (patch.ignoreMatch !== undefined) {
    sets.push('ignore_match = ?')
    params.push(patch.ignoreMatch ? 1 : 0)
  }
  if (sets.length === 0) return
  company.transaction(() => {
    inChunks(
      rows.map((r) => r.id),
      (chunk, ph) => company.db.run(`UPDATE bank_transactions SET ${sets.join(', ')} WHERE id IN (${ph})`, [...params, ...chunk])
    )
  })
}

/**
 * Adds the selected review items to the books, like QuickBooks' "Add/Approve":
 * items with a suggested match are matched to that register transaction, items
 * with a category become a journal entry, and the rest stay in review.
 * All or nothing: if one entry can't be saved, none are.
 */
export function acceptBankTransactions(company: Company, ids: number[], override?: ClosingOverride): BankAcceptResult {
  const rows = loadTxs(company, ids).filter((r) => r.status === 'review')
  const result: BankAcceptResult = { added: 0, matched: 0, skipped: 0 }
  const byAccount = new Map<number, TxRow[]>()
  for (const r of rows) byAccount.set(r.account_id, [...(byAccount.get(r.account_id) ?? []), r])

  company.transaction(() => {
    for (const [accountId, items] of byAccount) {
      const account = feedAccount(company, accountId)
      const matches = findMatches(company, accountId, company.all<TxRow>("SELECT * FROM bank_transactions WHERE account_id = ? AND status = 'review'", [accountId]))
      for (const r of items) {
        const match = r.ignore_match ? undefined : matches.get(r.id)
        if (match) {
          company.db.run("UPDATE bank_transactions SET status = 'matched', entry_id = ? WHERE id = ?", [match.entryId, r.id])
          company.db.run('UPDATE attachments SET entry_id = ? WHERE bank_tx_id = ?', [match.entryId, r.id])
          result.matched++
          continue
        }
        if (r.category_id === null) {
          result.skipped++
          continue
        }
        const amount = Math.abs(r.amount)
        const moneyIn = r.amount > 0
        const memo = r.memo || r.payee
        const entry = company.createEntry(
          {
            date: r.date,
            ref: r.ref,
            memo: r.payee,
            lines: [
              { accountId: account.id, debit: moneyIn ? amount : 0, credit: moneyIn ? 0 : amount, memo: r.memo || r.description },
              { accountId: r.category_id, debit: moneyIn ? 0 : amount, credit: moneyIn ? amount : 0, memo }
            ]
          },
          override
        )
        company.db.run("UPDATE bank_transactions SET status = 'added', entry_id = ? WHERE id = ?", [entry.id, r.id])
        // Receipts attached during review go with the new entry.
        company.db.run('UPDATE attachments SET entry_id = ? WHERE bank_tx_id = ?', [entry.id, r.id])
        result.added++
      }
    }
  })
  return result
}

/** Moves review items to Excluded (personal or duplicate items that shouldn't be in the books), or back. */
export function excludeBankTransactions(company: Company, ids: number[], excluded: boolean): void {
  const [from, to] = excluded ? ['review', 'excluded'] : ['excluded', 'review']
  company.transaction(() => {
    inChunks([...new Set(ids)], (chunk, ph) =>
      company.db.run(`UPDATE bank_transactions SET status = ? WHERE status = ? AND id IN (${ph})`, [to, from, ...chunk])
    )
  })
}

/** Sends added or matched items back to review. An added item's journal entry is deleted; a matched one is left in the books. */
export function undoBankTransactions(company: Company, ids: number[], override?: ClosingOverride): void {
  const rows = loadTxs(company, ids).filter((r) => r.status === 'added' || r.status === 'matched')
  company.transaction(() => {
    for (const r of rows) {
      if (r.status === 'added' && r.entry_id !== null && company.get('SELECT id FROM journal_entries WHERE id = ?', [r.entry_id])) {
        // deleteEntry returns the bank transaction to review.
        company.deleteEntry(r.entry_id, override)
      }
      company.db.run("UPDATE bank_transactions SET status = 'review', entry_id = NULL WHERE id = ?", [r.id])
      company.db.run('UPDATE attachments SET entry_id = NULL WHERE bank_tx_id = ?', [r.id])
    }
  })
}

/** Permanently removes review or excluded items, for example after importing the wrong file. */
export function deleteBankTransactions(company: Company, ids: number[]): void {
  company.transaction(() => {
    inChunks([...new Set(ids)], (chunk, ph) => {
      company.db.run(
        `DELETE FROM attachments WHERE bank_tx_id IN (SELECT id FROM bank_transactions WHERE status IN ('review', 'excluded') AND id IN (${ph}))`,
        chunk
      )
      company.db.run(`DELETE FROM bank_transactions WHERE status IN ('review', 'excluded') AND id IN (${ph})`, chunk)
    })
  })
}
