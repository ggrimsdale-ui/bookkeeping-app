import { describe, expect, it } from 'vitest'
import { Company, ReconciledChangeError } from '../src/core/company'
import {
  beginningBalance,
  discardReconcile,
  finishReconcile,
  listReconciliations,
  reconcileSession,
  reconciliationReport,
  setMarked,
  startReconcile,
  undoLastReconciliation
} from '../src/core/reconcile'
import { acct, cr, dr, newCompany, post, sql } from './helpers'

async function bank(): Promise<Company> {
  const c = await newCompany()
  post(c, '2026-01-02', [dr(c, '1000', 100000), cr(c, '3000', 100000)], 'Opening deposit')
  post(c, '2026-01-10', [dr(c, '6450', 30000), cr(c, '1000', 30000)], 'Rent', '101')
  post(c, '2026-01-20', [dr(c, '1000', 50000), cr(c, '4000', 50000)], 'Deposit')
  post(c, '2026-01-30', [dr(c, '6300', 2500), cr(c, '1000', 2500)], 'Supplies', '102') // clears in February
  post(c, '2026-02-05', [dr(c, '6650', 8000), cr(c, '1000', 8000)], 'Power', '103')
  return c
}

function lineIds(c: Company, memos: string[]): number[] {
  return reconcileSession(c, acct(c, '1000'))
    .items.filter((i) => memos.includes(i.memo))
    .map((i) => i.lineId)
}

describe('reconciliation', () => {
  it('lists open transactions with deposits positive and payments negative', async () => {
    const c = await bank()
    const s = reconcileSession(c, acct(c, '1000'))
    expect(s.beginningBalance).toBe(0)
    expect(s.items.map((i) => [i.memo, i.amount])).toEqual([
      ['Opening deposit', 100000],
      ['Rent', -30000],
      ['Deposit', 50000],
      ['Supplies', -2500],
      ['Power', -8000]
    ])
  })

  it('reconciles when the cleared balance matches the statement', async () => {
    const c = await bank()
    const id = acct(c, '1000')
    startReconcile(c, { accountId: id, statementDate: '2026-01-31', endingBalance: 120000 })
    setMarked(c, id, lineIds(c, ['Opening deposit', 'Rent', 'Deposit']), true)
    expect(reconcileSession(c, id).clearedBalance).toBe(120000)
    finishReconcile(c, id, false)

    const s = reconcileSession(c, id)
    expect(s.beginningBalance).toBe(120000)
    expect(s.items.map((i) => i.memo)).toEqual(['Supplies', 'Power'])
    expect(s.draft).toBeNull()
    expect(listReconciliations(c, id)[0]).toMatchObject({ statementDate: '2026-01-31', beginningBalance: 0, endingBalance: 120000 })
  })

  it('refuses to finish with a difference unless an adjustment is entered', async () => {
    const c = await bank()
    const id = acct(c, '1000')
    startReconcile(c, { accountId: id, statementDate: '2026-01-31', endingBalance: 119900 })
    setMarked(c, id, lineIds(c, ['Opening deposit', 'Rent', 'Deposit']), true)
    expect(() => finishReconcile(c, id, false)).toThrow(/off from the statement by 1.00/)
    const recId = finishReconcile(c, id, true)
    expect(beginningBalance(c, id)).toBe(119900)
    const discrepancy = c.listAccounts().find((a) => a.name === 'Reconciliation Discrepancies')!
    expect(c.netByAccount(null, '2026-12-31').get(discrepancy.id)).toBe(100)
    expect(listReconciliations(c, id)[0].adjustment).toBe(-100)
    expect(reconciliationReport(c, recId).rows.at(-1)!.cells[3]).toBe(-100)
  })

  it('posts service charges and interest as cleared', async () => {
    const c = await bank()
    const id = acct(c, '1000')
    const s = startReconcile(c, {
      accountId: id,
      statementDate: '2026-01-31',
      endingBalance: 119500,
      serviceCharge: { date: '2026-01-31', amount: 1500, accountId: acct(c, '6050') },
      interest: { date: '2026-01-31', amount: 1000, accountId: acct(c, '7000') }
    })
    expect(s.clearedBalance).toBe(-500)
    setMarked(c, id, lineIds(c, ['Opening deposit', 'Rent', 'Deposit']), true)
    finishReconcile(c, id, false)
    expect(beginningBalance(c, id)).toBe(119500)
    expect(c.netByAccount(null, '2026-12-31').get(acct(c, '6050'))).toBe(1500)
  })

  it('treats credit card charges as increases', async () => {
    const c = await newCompany()
    post(c, '2026-01-05', [dr(c, '6250', 4000), cr(c, '2100', 4000)], 'Lunch')
    post(c, '2026-01-25', [dr(c, '2100', 4000), cr(c, '1000', 4000)], 'Card payment')
    const id = acct(c, '2100')
    const s = startReconcile(c, {
      accountId: id,
      statementDate: '2026-01-31',
      endingBalance: 2000,
      serviceCharge: { date: '2026-01-31', amount: 2000, accountId: acct(c, '6050') }
    })
    expect(s.items.map((i) => [i.memo, i.amount])).toEqual([
      ['Lunch', 4000],
      ['Card payment', -4000],
      ['Service charge', 2000]
    ])
    setMarked(c, id, lineIds2(c, id), true)
    finishReconcile(c, id, false)
    expect(beginningBalance(c, id)).toBe(2000)
  })

  it('keeps marks when you leave, and clears them when you discard', async () => {
    const c = await bank()
    const id = acct(c, '1000')
    startReconcile(c, { accountId: id, statementDate: '2026-01-31', endingBalance: 120000 })
    setMarked(c, id, lineIds(c, ['Rent']), true)
    const reopened = Company.open(await sql(), c.export())
    const s = reconcileSession(reopened, id)
    expect(s.draft).toEqual({ statementDate: '2026-01-31', endingBalance: 120000 })
    expect(s.items.find((i) => i.memo === 'Rent')!.marked).toBe(true)
    discardReconcile(reopened, id)
    expect(reconcileSession(reopened, id).items.every((i) => !i.marked)).toBe(true)
    expect(reconcileSession(reopened, id).draft).toBeNull()
  })

  it('undoes the last reconciliation', async () => {
    const c = await bank()
    const id = acct(c, '1000')
    startReconcile(c, { accountId: id, statementDate: '2026-01-31', endingBalance: 120000 })
    setMarked(c, id, lineIds(c, ['Opening deposit', 'Rent', 'Deposit']), true)
    finishReconcile(c, id, false)
    undoLastReconciliation(c, id)
    expect(beginningBalance(c, id)).toBe(0)
    expect(listReconciliations(c, id)).toHaveLength(0)
    expect(reconcileSession(c, id).items).toHaveLength(5)
  })

  it('protects reconciled transactions from accidental changes', async () => {
    const c = await bank()
    const id = acct(c, '1000')
    startReconcile(c, { accountId: id, statementDate: '2026-01-31', endingBalance: 120000 })
    setMarked(c, id, lineIds(c, ['Opening deposit', 'Rent', 'Deposit']), true)
    finishReconcile(c, id, false)
    const rent = c.listEntries({ search: 'Rent' })[0].id

    // A memo-only edit keeps the reconciled status.
    c.updateEntry(rent, { date: '2026-01-10', ref: '101', memo: 'January rent', lines: [dr(c, '6450', 30000), cr(c, '1000', 30000)] })
    expect(c.getEntry(rent).lines.find((l) => l.accountId === id)!.cleared).toBe('reconciled')

    // Changing the amount, voiding or deleting needs confirmation.
    const changed = { date: '2026-01-10', ref: '101', memo: 'Rent', lines: [dr(c, '6450', 31000), cr(c, '1000', 31000)] }
    expect(() => c.updateEntry(rent, changed)).toThrow(ReconciledChangeError)
    expect(() => c.voidEntry(rent)).toThrow(ReconciledChangeError)
    expect(() => c.deleteEntry(rent)).toThrow(ReconciledChangeError)
    c.updateEntry(rent, changed, { confirmReconciled: true })
    // The changed line is no longer reconciled, so the beginning balance drops by the original amount.
    expect(beginningBalance(c, id)).toBe(150000)
  })

  it('builds a reconciliation detail report that ties out', async () => {
    const c = await bank()
    const id = acct(c, '1000')
    startReconcile(c, { accountId: id, statementDate: '2026-01-31', endingBalance: 120000 })
    setMarked(c, id, lineIds(c, ['Opening deposit', 'Rent', 'Deposit']), true)
    const recId = finishReconcile(c, id, false)
    const r = reconciliationReport(c, recId)
    const cell = (label: string, col: number): unknown => r.rows.find((x) => x.cells[0] === label)!.cells[col]
    expect(cell('Cleared Balance', 4)).toBe(120000)
    expect(cell('Total Checks and Payments', 3)).toBe(-30000)
    expect(cell('Checks and Payments - 1 item', 3)).toBeNull()
    expect(cell('Total Uncleared Transactions', 3)).toBe(-2500)
    expect(cell('Register Balance as of 01/31/2026', 4)).toBe(117500)
    expect(cell('Statement Ending Balance', 4)).toBe(120000)
  })

  it('upgrades a version 1 company file', async () => {
    const c = await newCompany()
    // Simulate an old file: drop the reconciliation tables and columns.
    c.db.exec(`
      DROP TABLE bank_transactions; DROP TABLE bank_imports; DROP TABLE bank_rules; DROP TABLE bank_csv_mappings;
      DROP TABLE reconcile_drafts; DROP TABLE reconciliations;
      ALTER TABLE journal_lines DROP COLUMN reconciliation_id; ALTER TABLE journal_lines DROP COLUMN cleared;
      UPDATE meta SET value = '1' WHERE key = 'schemaVersion';
    `)
    const upgraded = Company.open(await sql(), c.export())
    post(upgraded, '2026-01-02', [dr(upgraded, '1000', 100), cr(upgraded, '3000', 100)])
    expect(reconcileSession(upgraded, acct(upgraded, '1000')).items).toHaveLength(1)
  })

  it('rejects income and expense accounts', async () => {
    const c = await bank()
    expect(() => reconcileSession(c, acct(c, '4000'))).toThrow(/balance sheet/)
  })
})

function lineIds2(c: Company, id: number): number[] {
  return reconcileSession(c, id).items.map((i) => i.lineId)
}
