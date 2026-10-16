import { describe, expect, it } from 'vitest'
import { ClosedPeriodError, Company } from '../src/core/company'
import {
  acceptBankTransactions,
  applyRules,
  bankCounts,
  deleteBankTransactions,
  excludeBankTransactions,
  importBankRows,
  listBankTransactions,
  payeeKey,
  saveRule,
  undoBankTransactions,
  updateBankTransactions
} from '../src/core/bankFeed'
import type { BankRowInput } from '../src/core/csv'
import { buildReport } from '../src/core/reports'
import { acct, cr, dr, newCompany, post, sql } from './helpers'

const row = (date: string, description: string, amount: number, ref = ''): BankRowInput => ({ date, description, memo: '', ref, amount })

const january = [
  row('2026-01-03', 'SQ *BLUE BOTTLE 0103', -450),
  row('2026-01-05', 'CLIENT PAYMENT ACME', 120000),
  row('2026-01-10', 'CHECK 101', -30000, '101'),
  row('2026-01-12', 'SQ *BLUE BOTTLE 0112', -450)
]

function ids(c: Company, bank: number, tab: 'review' | 'done' | 'excluded' = 'review'): number[] {
  return listBankTransactions(c, bank, tab).map((t) => t.id)
}

describe('bank feeds', () => {
  it('imports rows for review and skips ones already imported', async () => {
    const c = await newCompany()
    const bank = acct(c, '1000')
    expect(importBankRows(c, bank, 'jan.csv', january)).toMatchObject({ imported: 4, duplicates: 0 })
    // An overlapping file: two old rows and one new.
    const overlap = [january[2], january[3], row('2026-01-20', 'POWER CO', -8000)]
    expect(importBankRows(c, bank, 'jan-feb.csv', overlap)).toMatchObject({ imported: 1, duplicates: 2 })
    expect(bankCounts(c, bank)).toEqual({ review: 5, done: 0, excluded: 0 })
    // Two identical coffees on one day are both real.
    const twice = [row('2026-02-01', 'COFFEE', -300), row('2026-02-01', 'COFFEE', -300)]
    expect(importBankRows(c, bank, 'feb.csv', twice).imported).toBe(2)
    expect(importBankRows(c, bank, 'feb.csv', twice).duplicates).toBe(2)
  })

  it('categorizes in bulk and adds journal entries that hit the reports', async () => {
    const c = await newCompany()
    const bank = acct(c, '1000')
    importBankRows(c, bank, 'jan.csv', january)
    const txs = listBankTransactions(c, bank, 'review')
    const coffee = txs.filter((t) => t.description.includes('BLUE BOTTLE')).map((t) => t.id)
    updateBankTransactions(c, coffee, { categoryId: acct(c, '6300'), payee: 'Blue Bottle Coffee' })
    updateBankTransactions(c, [txs.find((t) => t.ref === '101')!.id], { categoryId: acct(c, '6450'), memo: 'January rent' })
    updateBankTransactions(c, [txs.find((t) => t.amount > 0)!.id], { categoryId: acct(c, '4000') })

    expect(acceptBankTransactions(c, ids(c, bank))).toEqual({ added: 4, matched: 0, skipped: 0 })
    expect(bankCounts(c, bank)).toEqual({ review: 0, done: 4, excluded: 0 })

    const rent = listBankTransactions(c, bank, 'done').find((t) => t.ref === '101')!
    const entry = c.getEntry(rent.entryId!)
    expect(entry).toMatchObject({ date: '2026-01-10', ref: '101', memo: 'CHECK 101' })
    expect(entry.lines).toEqual([
      expect.objectContaining({ accountId: bank, debit: 0, credit: 30000, memo: 'January rent' }),
      expect.objectContaining({ accountId: acct(c, '6450'), debit: 30000, credit: 0, memo: 'January rent' })
    ])

    const pl = buildReport(c, { kind: 'profitAndLoss', periods: [{ label: 'Jan', from: '2026-01-01', to: '2026-01-31' }] })
    const net = pl.rows.find((r) => r.cells[0] === 'Net Income')!.cells[1]
    expect(net).toBe(120000 - 900 - 30000)
  })

  it('leaves uncategorized items in review', async () => {
    const c = await newCompany()
    const bank = acct(c, '1000')
    importBankRows(c, bank, 'jan.csv', january)
    const [first] = ids(c, bank)
    updateBankTransactions(c, [first], { categoryId: acct(c, '6300') })
    expect(acceptBankTransactions(c, ids(c, bank))).toEqual({ added: 1, matched: 0, skipped: 3 })
  })

  it('suggests categories from rules and from past choices for the same payee', async () => {
    const c = await newCompany()
    const bank = acct(c, '1000')
    saveRule(c, null, { contains: 'client payment', direction: 'in', categoryId: acct(c, '4000'), payee: 'Acme Corp' })
    importBankRows(c, bank, 'jan.csv', january.slice(0, 2))
    const [acme, coffee] = [...listBankTransactions(c, bank, 'review')].sort((a, b) => b.amount - a.amount)
    expect(acme).toMatchObject({ categoryId: acct(c, '4000'), categorySource: 'rule', payee: 'Acme Corp' })
    expect(coffee.categoryId).toBeNull()

    updateBankTransactions(c, [coffee.id], { categoryId: acct(c, '6300') })
    acceptBankTransactions(c, [coffee.id])

    // A later coffee with a different reference number gets the same category.
    expect(importBankRows(c, bank, 'feb.csv', [row('2026-02-03', 'SQ *BLUE BOTTLE 0203', -500)]).categorized).toBe(1)
    const next = listBankTransactions(c, bank, 'review').find((t) => t.date === '2026-02-03')!
    expect(next).toMatchObject({ categoryId: acct(c, '6300'), categorySource: 'history' })
    expect(payeeKey('SQ *BLUE BOTTLE 0203')).toBe('sq blue bottle')
  })

  it('applies a new rule to items already waiting, without overriding the user', async () => {
    const c = await newCompany()
    const bank = acct(c, '1000')
    importBankRows(c, bank, 'jan.csv', january)
    const txs = listBankTransactions(c, bank, 'review').filter((t) => t.description.includes('BLUE BOTTLE'))
    updateBankTransactions(c, [txs[0].id], { categoryId: acct(c, '6000') })
    saveRule(c, null, { contains: 'BLUE BOTTLE', direction: 'any', categoryId: acct(c, '6300'), payee: '' })
    expect(applyRules(c, bank)).toBe(1)
    const after = listBankTransactions(c, bank, 'review').filter((t) => t.description.includes('BLUE BOTTLE'))
    expect(after.map((t) => [t.categoryId, t.categorySource])).toEqual([
      [acct(c, '6000'), 'user'],
      [acct(c, '6300'), 'rule']
    ])
  })

  it('matches transactions already entered instead of adding them twice', async () => {
    const c = await newCompany()
    const bank = acct(c, '1000')
    const rentId = post(c, '2026-01-08', [dr(c, '6450', 30000), cr(c, '1000', 30000)], 'Rent', '101')
    importBankRows(c, bank, 'jan.csv', january)
    const check = listBankTransactions(c, bank, 'review').find((t) => t.ref === '101')!
    expect(check.match).toMatchObject({ entryId: rentId, date: '2026-01-08', memo: 'Rent' })

    expect(acceptBankTransactions(c, [check.id])).toEqual({ added: 0, matched: 1, skipped: 0 })
    expect(c.listEntries()).toHaveLength(1)
    // Already matched, so it isn't offered again.
    importBankRows(c, bank, 'again.csv', [row('2026-01-09', 'CHECK 101 AGAIN', -30000)])
    expect(listBankTransactions(c, bank, 'review').every((t) => t.match === null)).toBe(true)

    // Undoing a match leaves the entry in the books and makes it available again.
    undoBankTransactions(c, [check.id])
    expect(c.listEntries()).toHaveLength(1)
    expect(listBankTransactions(c, bank, 'review').filter((t) => t.match?.entryId === rentId)).toHaveLength(1)
  })

  it('lets the user ignore a suggested match and add a new entry', async () => {
    const c = await newCompany()
    const bank = acct(c, '1000')
    post(c, '2026-01-08', [dr(c, '6450', 30000), cr(c, '1000', 30000)], 'Rent', '101')
    importBankRows(c, bank, 'jan.csv', [january[2]])
    const [id] = ids(c, bank)
    updateBankTransactions(c, [id], { ignoreMatch: true, categoryId: acct(c, '6450') })
    expect(listBankTransactions(c, bank, 'review')[0]).toMatchObject({ ignoreMatch: true, match: expect.objectContaining({ ref: '101' }) })
    expect(acceptBankTransactions(c, [id])).toEqual({ added: 1, matched: 0, skipped: 0 })
  })

  it('posts credit card charges and payments the right way round', async () => {
    const c = await newCompany()
    const card = acct(c, '2100')
    importBankRows(c, card, 'visa.csv', [row('2026-01-04', 'HOTEL', -25000), row('2026-01-20', 'PAYMENT THANK YOU', 25000)])
    const [payment, hotel] = listBankTransactions(c, card, 'review')
    updateBankTransactions(c, [hotel.id], { categoryId: acct(c, '6000') })
    updateBankTransactions(c, [payment.id], { categoryId: acct(c, '1000') })
    acceptBankTransactions(c, [hotel.id, payment.id])
    const hotelEntry = c.getEntry(listBankTransactions(c, card, 'done').find((t) => t.description === 'HOTEL')!.entryId!)
    expect(hotelEntry.lines[0]).toMatchObject({ accountId: card, credit: 25000 })
    const tb = buildReport(c, { kind: 'trialBalance', periods: [{ label: 'Jan', from: '2026-01-01', to: '2026-01-31' }] })
    expect(tb.rows.find((r) => String(r.cells[0]).includes('Credit Card'))).toBeUndefined() // nets to zero
  })

  it('adds nothing when one entry falls in a closed period, until confirmed', async () => {
    const c = await newCompany()
    const bank = acct(c, '1000')
    c.setClosing('2026-01-06', null)
    importBankRows(c, bank, 'jan.csv', january)
    const all = ids(c, bank)
    updateBankTransactions(c, all, { categoryId: acct(c, '6000') })
    expect(() => acceptBankTransactions(c, all)).toThrow(ClosedPeriodError)
    expect(c.listEntries()).toHaveLength(0)
    expect(bankCounts(c, bank).review).toBe(4)
    expect(acceptBankTransactions(c, all, { confirmClosedPeriod: true }).added).toBe(4)
  })

  it('undoes added items by deleting their entry, and deleting the entry elsewhere sends them back to review', async () => {
    const c = await newCompany()
    const bank = acct(c, '1000')
    importBankRows(c, bank, 'jan.csv', january)
    const all = ids(c, bank)
    updateBankTransactions(c, all, { categoryId: acct(c, '6000') })
    acceptBankTransactions(c, all)
    const [a, b] = listBankTransactions(c, bank, 'done')
    undoBankTransactions(c, [a.id])
    expect(() => c.getEntry(a.entryId!)).toThrow()
    c.deleteEntry(b.entryId!)
    expect(bankCounts(c, bank)).toEqual({ review: 2, done: 2, excluded: 0 })
    // Category choices survive the round trip.
    expect(listBankTransactions(c, bank, 'review').every((t) => t.categoryId === acct(c, '6000'))).toBe(true)
  })

  it('excludes, restores and deletes items', async () => {
    const c = await newCompany()
    const bank = acct(c, '1000')
    importBankRows(c, bank, 'jan.csv', january)
    const [first, second] = ids(c, bank)
    excludeBankTransactions(c, [first, second], true)
    expect(bankCounts(c, bank)).toEqual({ review: 2, done: 0, excluded: 2 })
    excludeBankTransactions(c, [first], false)
    expect(bankCounts(c, bank)).toEqual({ review: 3, done: 0, excluded: 1 })
    // Excluded items still count as imported, so re-importing the file doesn't bring them back.
    expect(importBankRows(c, bank, 'jan.csv', january).imported).toBe(0)
    deleteBankTransactions(c, ids(c, bank, 'review'))
    expect(bankCounts(c, bank)).toEqual({ review: 0, done: 0, excluded: 1 })
  })

  it('refuses bad categories and protects accounts in use', async () => {
    const c = await newCompany()
    const bank = acct(c, '1000')
    importBankRows(c, bank, 'jan.csv', january)
    expect(() => updateBankTransactions(c, ids(c, bank), { categoryId: bank })).toThrow(/imported into/)
    expect(() => importBankRows(c, acct(c, '6000'), 'x.csv', january)).toThrow(/balance sheet/)
    expect(() => c.deleteAccount(bank)).toThrow()
    const supplies = c.createAccount({ number: '6999', name: 'Misc', type: 'Expense', parentId: null, description: '' }).id
    updateBankTransactions(c, ids(c, bank), { categoryId: supplies })
    c.deleteAccount(supplies)
    expect(listBankTransactions(c, bank, 'review').every((t) => t.categoryId === null)).toBe(true)
  })

  it('upgrades a version 2 company file', async () => {
    const c = await newCompany()
    c.db.exec('DROP TABLE bank_watch_folders; DROP TABLE bank_transactions; DROP TABLE bank_imports; DROP TABLE bank_rules; DROP TABLE bank_csv_mappings')
    c.db.run("UPDATE meta SET value = '2' WHERE key = 'schemaVersion'")
    const reopened = Company.open(await sql(), c.export())
    expect(importBankRows(reopened, acct(reopened, '1000'), 'jan.csv', january).imported).toBe(4)
  })
})
