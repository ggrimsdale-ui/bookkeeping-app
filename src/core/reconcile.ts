import { isDebitNormal, isProfitAndLoss } from './accountTypes'
import type { Company } from './company'
import { assertDate, formatDate, formatLongDate } from './dates'
import { formatMoney } from './money'
import type {
  Account,
  ClosingOverride,
  ReconcileItem,
  ReconcileSession,
  ReconcileStart,
  Reconciliation,
  Report,
  ReportRow
} from '../shared/types'

const DISCREPANCY_ACCOUNT = 'Reconciliation Discrepancies'

/** Income and expense accounts have no statement to reconcile against. */
export function isReconcilable(a: Account): boolean {
  return !isProfitAndLoss(a.type)
}

function reconcilableAccount(company: Company, accountId: number): Account {
  const account = company.getAccount(accountId)
  if (!isReconcilable(account)) throw new Error('Only balance sheet accounts can be reconciled.')
  return account
}

/** Converts a line's debit/credit to the account's natural sign (positive increases the balance). */
function naturalAmount(account: Account, debit: number, credit: number): number {
  return (isDebitNormal(account.type) ? debit - credit : credit - debit) || 0
}

function sumCleared(company: Company, account: Account, cleared: 'reconciled' | 'pending'): number {
  const row = company.get<{ d: number | null; c: number | null }>(
    `SELECT SUM(l.debit) AS d, SUM(l.credit) AS c
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = ? AND l.cleared = ? AND e.is_void = 0`,
    [account.id, cleared]
  )
  return naturalAmount(account, row?.d ?? 0, row?.c ?? 0)
}

/**
 * The balance of everything already reconciled. Like QuickBooks, this is
 * computed from the cleared transactions rather than stored, so editing a
 * reconciled transaction shows up as a beginning balance discrepancy.
 */
export function beginningBalance(company: Company, accountId: number): number {
  return sumCleared(company, reconcilableAccount(company, accountId), 'reconciled')
}

export function listReconciliations(company: Company, accountId: number): Reconciliation[] {
  return company
    .all<{
      id: number
      account_id: number
      statement_date: string
      beginning_balance: number
      ending_balance: number
      adjustment: number
      reconciled_at: string
    }>('SELECT * FROM reconciliations WHERE account_id = ? ORDER BY id DESC', [accountId])
    .map((r) => ({
      id: r.id,
      accountId: r.account_id,
      statementDate: r.statement_date,
      beginningBalance: r.beginning_balance,
      endingBalance: r.ending_balance,
      adjustment: r.adjustment,
      reconciledAt: r.reconciled_at
    }))
}

function getDraft(company: Company, accountId: number): { statementDate: string; endingBalance: number } | null {
  const row = company.get<{ statement_date: string; ending_balance: number }>(
    'SELECT statement_date, ending_balance FROM reconcile_drafts WHERE account_id = ?',
    [accountId]
  )
  return row ? { statementDate: row.statement_date, endingBalance: row.ending_balance } : null
}

/** Everything the reconcile window shows: statement figures, the open transactions and the running totals. */
export function reconcileSession(company: Company, accountId: number): ReconcileSession {
  const account = reconcilableAccount(company, accountId)
  const rows = company.all<{
    line_id: number
    entry_id: number
    date: string
    ref: string
    entry_memo: string
    line_memo: string
    debit: number
    credit: number
    cleared: string
  }>(
    `SELECT l.id AS line_id, e.id AS entry_id, e.date, e.ref, e.memo AS entry_memo, l.memo AS line_memo, l.debit, l.credit, l.cleared
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = ? AND l.cleared != 'reconciled' AND e.is_void = 0
     ORDER BY e.date, e.id, l.line_no`,
    [accountId]
  )
  const items: ReconcileItem[] = rows.map((r) => ({
    lineId: r.line_id,
    entryId: r.entry_id,
    date: r.date,
    ref: r.ref,
    memo: r.line_memo || r.entry_memo,
    amount: naturalAmount(account, r.debit, r.credit),
    marked: r.cleared === 'pending'
  }))
  const beginning = sumCleared(company, account, 'reconciled')
  const marked = sumCleared(company, account, 'pending')
  const last = listReconciliations(company, accountId)[0] ?? null
  return {
    account,
    lastReconciliation: last,
    beginningBalance: beginning,
    draft: getDraft(company, accountId),
    items,
    clearedBalance: beginning + marked
  }
}

function discrepancyAccount(company: Company): Account {
  const existing = company.listAccounts().find((a) => a.type === 'Expense' && a.name === DISCREPANCY_ACCOUNT)
  if (existing) {
    if (!existing.isActive) company.setAccountActive(existing.id, true)
    return existing
  }
  return company.createAccount({ number: '', name: DISCREPANCY_ACCOUNT, type: 'Expense', parentId: null, description: 'Differences entered when reconciling' })
}

/**
 * Posts an entry between the reconciled account and another account and marks
 * the reconciled side cleared. Used for service charges, interest and adjustments.
 */
function postClearedEntry(
  company: Company,
  account: Account,
  date: string,
  amount: number,
  otherAccountId: number,
  memo: string,
  override?: ClosingOverride
): void {
  // amount is in the reconciled account's natural sign.
  const debitSide = isDebitNormal(account.type) ? amount : -amount
  const entry = company.createEntry(
    {
      date,
      ref: '',
      memo,
      lines: [
        { accountId: account.id, debit: Math.max(debitSide, 0), credit: Math.max(-debitSide, 0), memo },
        { accountId: otherAccountId, debit: Math.max(-debitSide, 0), credit: Math.max(debitSide, 0), memo }
      ]
    },
    override
  )
  company.db.run("UPDATE journal_lines SET cleared = 'pending' WHERE entry_id = ? AND account_id = ?", [entry.id, account.id])
}

/** Saves the statement details and records any service charge or interest from the statement. */
export function startReconcile(company: Company, input: ReconcileStart, override?: ClosingOverride): ReconcileSession {
  const account = reconcilableAccount(company, input.accountId)
  assertDate(input.statementDate, 'Statement date')
  if (!Number.isSafeInteger(input.endingBalance)) throw new Error('Enter the ending balance from the statement.')
  const extras = [
    { e: input.serviceCharge, label: 'Service charge', sign: -1 },
    { e: input.interest, label: 'Interest earned', sign: 1 }
  ]
  for (const { e, label } of extras) {
    if (!e || e.amount === 0) continue
    if (e.amount < 0) throw new Error(`${label} must be a positive amount.`)
    assertDate(e.date, `${label} date`)
    if (!e.accountId) throw new Error(`Choose an account for the ${label.toLowerCase()}.`)
  }
  // Charges and interest are posted first so a closed-period refusal leaves nothing half done.
  for (const { e, label, sign } of extras) {
    if (!e || e.amount === 0) continue
    // A service charge lowers an asset but raises a liability (e.g. a credit card fee).
    const assetLike = isDebitNormal(account.type)
    const amount = sign * e.amount * (assetLike ? 1 : -1)
    postClearedEntry(company, account, e.date, amount, e.accountId!, label, override)
  }
  company.transaction(() => {
    company.db.run('INSERT OR REPLACE INTO reconcile_drafts (account_id, statement_date, ending_balance) VALUES (?, ?, ?)', [
      account.id,
      input.statementDate,
      input.endingBalance
    ])
  })
  return reconcileSession(company, account.id)
}

/** Marks or unmarks transactions as cleared on the statement. */
export function setMarked(company: Company, accountId: number, lineIds: number[], marked: boolean): void {
  if (lineIds.length === 0) return
  company.transaction(() => {
    for (let i = 0; i < lineIds.length; i += 500) {
      const chunk = lineIds.slice(i, i + 500)
      company.db.run(
        `UPDATE journal_lines SET cleared = ? WHERE account_id = ? AND cleared != 'reconciled' AND id IN (${chunk.map(() => '?').join(',')})`,
        [marked ? 'pending' : 'none', accountId, ...chunk]
      )
    }
  })
}

/** Throws away the marks and statement details without reconciling. */
export function discardReconcile(company: Company, accountId: number): void {
  company.transaction(() => {
    company.db.run("UPDATE journal_lines SET cleared = 'none' WHERE account_id = ? AND cleared = 'pending'", [accountId])
    company.db.run('DELETE FROM reconcile_drafts WHERE account_id = ?', [accountId])
  })
}

/**
 * Completes the reconciliation. When the cleared balance doesn't match the
 * statement, `adjust` posts the difference to Reconciliation Discrepancies.
 */
export function finishReconcile(company: Company, accountId: number, adjust: boolean, override?: ClosingOverride): number {
  const account = reconcilableAccount(company, accountId)
  const draft = getDraft(company, accountId)
  if (!draft) throw new Error('Start the reconciliation by entering the statement details.')
  const beginning = sumCleared(company, account, 'reconciled')
  const difference = draft.endingBalance - (beginning + sumCleared(company, account, 'pending'))
  if (difference !== 0) {
    if (!adjust) {
      throw new Error(`The cleared balance is off from the statement by ${formatMoney(Math.abs(difference))}. Mark the missing transactions or enter an adjustment.`)
    }
    postClearedEntry(company, account, draft.statementDate, difference, discrepancyAccount(company).id, 'Balance adjustment', override)
  }
  return company.transaction(() => {
    company.db.run(
      'INSERT INTO reconciliations (account_id, statement_date, beginning_balance, ending_balance, adjustment, reconciled_at) VALUES (?, ?, ?, ?, ?, ?)',
      [account.id, draft.statementDate, beginning, draft.endingBalance, difference, new Date().toISOString()]
    )
    const id = company.lastId()
    company.db.run(
      "UPDATE journal_lines SET cleared = 'reconciled', reconciliation_id = ? WHERE account_id = ? AND cleared = 'pending'",
      [id, account.id]
    )
    company.db.run('DELETE FROM reconcile_drafts WHERE account_id = ?', [account.id])
    return id
  })
}

/** Returns the transactions from the most recent reconciliation to uncleared, like QuickBooks' Undo Last Reconciliation. */
export function undoLastReconciliation(company: Company, accountId: number): void {
  const last = listReconciliations(company, accountId)[0]
  if (!last) throw new Error('This account has not been reconciled yet.')
  company.transaction(() => {
    company.db.run("UPDATE journal_lines SET cleared = 'none', reconciliation_id = NULL WHERE reconciliation_id = ?", [last.id])
    company.db.run('DELETE FROM reconciliations WHERE id = ?', [last.id])
  })
}

export function increaseLabel(account: Account): string {
  return isDebitNormal(account.type) ? 'Deposits and Other Credits' : 'Charges and Cash Advances'
}

export function decreaseLabel(account: Account): string {
  return isDebitNormal(account.type) ? 'Checks and Payments' : 'Payments and Credits'
}

/** Reconciliation Detail report: what was cleared, what was still outstanding, and how it ties to the register. */
export function reconciliationReport(company: Company, reconciliationId: number): Report {
  const rec = company.get<{ account_id: number }>('SELECT account_id FROM reconciliations WHERE id = ?', [reconciliationId])
  if (!rec) throw new Error('Reconciliation not found')
  const account = company.getAccount(rec.account_id)
  const r = listReconciliations(company, account.id).find((x) => x.id === reconciliationId)!

  const lines = company.all<{
    entry_id: number
    date: string
    ref: string
    memo: string
    debit: number
    credit: number
    cleared: string
    reconciliation_id: number | null
  }>(
    `SELECT e.id AS entry_id, e.date, e.ref, COALESCE(NULLIF(l.memo, ''), e.memo) AS memo, l.debit, l.credit, l.cleared, l.reconciliation_id
     FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
     WHERE l.account_id = ? AND e.is_void = 0
     ORDER BY e.date, e.id, l.line_no`,
    [account.id]
  )
  const cleared = lines.filter((l) => l.reconciliation_id === reconciliationId)
  // Outstanding at the statement date: dated on or before it and not cleared by this or an earlier reconciliation.
  const outstanding = lines.filter(
    (l) => l.date <= r.statementDate && (l.reconciliation_id === null || l.reconciliation_id > reconciliationId)
  )

  const rows: ReportRow[] = []
  const blank = ['', ''] as const
  const lineRow = (l: (typeof lines)[number], balance: number): ReportRow => ({
    kind: 'line',
    cells: [formatDate(l.date), l.ref, l.memo, naturalAmount(account, l.debit, l.credit), balance],
    indent: 2,
    drills: new Array(5).fill({ entryId: l.entry_id })
  })
  let balance = r.beginningBalance
  rows.push({ kind: 'line', cells: ['Beginning Balance', ...blank, null, r.beginningBalance], indent: 0 })

  const groups = (items: typeof lines, title: string): number => {
    rows.push({ kind: 'section', cells: [title, ...blank, null, null], indent: 0 })
    let total = 0
    for (const [label, pick] of [
      [decreaseLabel(account), (n: number) => n < 0],
      [increaseLabel(account), (n: number) => n > 0]
    ] as const) {
      const group = items.filter((l) => pick(naturalAmount(account, l.debit, l.credit)))
      rows.push({ kind: 'section', cells: [`${label} - ${group.length} item${group.length === 1 ? '' : 's'}`, ...blank, null, null], indent: 1 })
      let sub = 0
      for (const l of group) {
        const amt = naturalAmount(account, l.debit, l.credit)
        sub += amt
        balance += amt
        rows.push(lineRow(l, balance))
      }
      rows.push({ kind: 'subtotal', cells: [`Total ${label}`, ...blank, sub, balance], indent: 1 })
      total += sub
    }
    rows.push({ kind: 'subtotal', cells: [`Total ${title}`, ...blank, total, balance], indent: 0 })
    return total
  }

  groups(cleared, 'Cleared Transactions')
  rows.push({ kind: 'total', cells: ['Cleared Balance', ...blank, null, balance], indent: 0 })
  groups(outstanding, 'Uncleared Transactions')
  const register = company.netByAccount(null, r.statementDate).get(account.id) ?? 0
  rows.push({
    kind: 'total',
    cells: [`Register Balance as of ${formatDate(r.statementDate)}`, ...blank, null, (isDebitNormal(account.type) ? register : -register) || 0],
    indent: 0
  })
  rows.push({ kind: 'grandTotal', cells: ['Statement Ending Balance', ...blank, null, r.endingBalance], indent: 0 })
  if (r.adjustment !== 0) {
    rows.push({ kind: 'line', cells: ['Includes a balance adjustment of', ...blank, r.adjustment, null], indent: 0 })
  }

  return {
    kind: 'reconciliation',
    title: 'Reconciliation Detail',
    companyName: company.getInfo().name,
    subtitle: `${account.fullName}, period ending ${formatLongDate(r.statementDate)}`,
    basis: `Reconciled ${formatDate(r.reconciledAt.slice(0, 10))}`,
    columns: [
      { label: 'Date', kind: 'text' },
      { label: 'Ref', kind: 'text' },
      { label: 'Memo', kind: 'text' },
      { label: 'Amount', kind: 'money' },
      { label: 'Balance', kind: 'money' }
    ],
    rows
  }
}
