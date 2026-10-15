import { describe, expect, it } from 'vitest'
import { Company, ClosedPeriodError } from '../src/core/company'
import { fiscalYearStart, priorPeriod, priorYear, presetRange } from '../src/core/dates'
import { formatMoney, parseMoney } from '../src/core/money'
import { enterOpeningBalances } from '../src/core/openingBalances'
import { acct, cr, dr, newCompany, post, sql } from './helpers'

describe('money', () => {
  it('parses amounts into exact cents', () => {
    expect(parseMoney('1,234.56')).toBe(123456)
    expect(parseMoney('$0.1')).toBe(10)
    expect(parseMoney('(12.00)')).toBe(-1200)
    expect(parseMoney('-3')).toBe(-300)
    expect(parseMoney('')).toBe(0)
    expect(parseMoney(0.1 + 0.2)).toBe(30)
    expect(() => parseMoney('1.234')).toThrow()
    expect(() => parseMoney('abc')).toThrow()
  })

  it('formats cents', () => {
    expect(formatMoney(123456789)).toBe('1,234,567.89')
    expect(formatMoney(-5)).toBe('-0.05')
    expect(formatMoney(-5, { parens: true })).toBe('(0.05)')
    expect(formatMoney(0, { blankZero: true })).toBe('')
  })
})

describe('dates', () => {
  it('finds the fiscal year start', () => {
    expect(fiscalYearStart('2026-03-15', 1)).toBe('2026-01-01')
    expect(fiscalYearStart('2026-03-15', 7)).toBe('2025-07-01')
    expect(fiscalYearStart('2026-07-01', 7)).toBe('2026-07-01')
  })

  it('computes presets and comparison periods', () => {
    expect(presetRange('lastMonth', '2026-01-15', 1)).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(presetRange('thisQuarter', '2026-05-02', 1)).toEqual({ from: '2026-04-01', to: '2026-06-30' })
    expect(presetRange('lastFiscalYear', '2026-05-02', 7)).toEqual({ from: '2024-07-01', to: '2025-06-30' })
    expect(priorYear({ from: '2024-02-01', to: '2024-02-29' })).toEqual({ from: '2023-02-01', to: '2023-02-28' })
    expect(priorPeriod({ from: '2026-04-01', to: '2026-06-30' })).toEqual({ from: '2026-01-01', to: '2026-03-31' })
    expect(priorPeriod({ from: '2026-04-10', to: '2026-04-19' })).toEqual({ from: '2026-03-31', to: '2026-04-09' })
  })
})

describe('company file', () => {
  it('round-trips through export and open', async () => {
    const c = await newCompany()
    post(c, '2026-01-05', [dr(c, '1000', 10000), cr(c, '4000', 10000)])
    const reopened = Company.open(await sql(), c.export())
    expect(reopened.getInfo().name).toBe('Test Co')
    expect(reopened.listEntries()).toHaveLength(1)
  })

  it('rejects files that are not company files', async () => {
    const SQL = await sql()
    expect(() => Company.open(SQL, new Uint8Array([1, 2, 3]))).toThrow(/not a Bookkeeping company file/)
  })

  it('creates the system accounts in every template', async () => {
    const c = await newCompany('blank')
    const systems = c.listAccounts().map((a) => a.system)
    expect(systems).toContain('retainedEarnings')
    expect(systems).toContain('openingBalanceEquity')
  })
})

describe('chart of accounts', () => {
  it('orders sub-accounts under their parent', async () => {
    const c = await newCompany()
    const names = c.listAccounts().map((a) => a.fullName)
    const parent = names.indexOf("3100 · Owner's Equity")
    expect(names[parent + 1]).toBe("3100 · Owner's Equity:3110 · Owner's Contributions")
  })

  it('validates accounts', async () => {
    const c = await newCompany()
    const base = { number: '', name: 'X', type: 'Expense' as const, parentId: null, description: '' }
    expect(() => c.createAccount({ ...base, number: '1000' })).toThrow(/already used/)
    expect(() => c.createAccount({ ...base, name: 'Rent Expense' })).toThrow(/already exists/)
    expect(() => c.createAccount({ ...base, parentId: acct(c, '1000') })).toThrow(/same type/)
    const sub = c.createAccount({ ...base, name: 'Office Rent', parentId: acct(c, '6450') })
    expect(sub.fullName).toBe('6450 · Rent Expense:Office Rent')
    expect(() => c.updateAccount(acct(c, '6450'), { ...base, name: 'Rent Expense', parentId: sub.id })).toThrow(
      /itself/
    )
  })

  it('protects accounts that are in use or system accounts', async () => {
    const c = await newCompany()
    post(c, '2026-01-05', [dr(c, '6300', 500), cr(c, '1000', 500)])
    expect(() => c.deleteAccount(acct(c, '6300'))).toThrow(/inactive instead/)
    expect(() => c.deleteAccount(acct(c, '3900'))).toThrow(/system account/)
    c.deleteAccount(acct(c, '6600'))
    c.setAccountActive(acct(c, '6300'), false)
    expect(() => post(c, '2026-01-06', [dr(c, '6300', 500), cr(c, '1000', 500)])).toThrow(/inactive/)
  })
})

describe('journal entries', () => {
  it('requires debits to equal credits', async () => {
    const c = await newCompany()
    expect(() => post(c, '2026-01-05', [dr(c, '1000', 100), cr(c, '4000', 99)])).toThrow(/must be equal/)
    expect(() => post(c, '2026-01-05', [dr(c, '1000', 100)])).toThrow(/at least two/)
    expect(() =>
      c.createEntry({ date: '2026-01-05', ref: '', memo: '', lines: [{ ...dr(c, '1000', 100), credit: 100 }, cr(c, '4000', 0)] })
    ).toThrow()
    expect(() => post(c, '2026-02-30', [dr(c, '1000', 100), cr(c, '4000', 100)])).toThrow(/valid date/)
  })

  it('edits, voids and deletes entries', async () => {
    const c = await newCompany()
    const id = post(c, '2026-01-05', [dr(c, '1000', 100), cr(c, '4000', 100)], 'Sale', '1')
    c.updateEntry(id, { date: '2026-01-06', ref: '1', memo: 'Sale', lines: [dr(c, '1000', 250), cr(c, '4000', 250)] })
    expect(c.getEntry(id).lines[0].debit).toBe(250)
    expect(c.nextRef()).toBe('2')
    c.voidEntry(id)
    expect(c.getEntry(id).isVoid).toBe(true)
    expect(c.netByAccount(null, '2026-12-31').size).toBe(0)
    c.deleteEntry(id)
    expect(c.listEntries()).toHaveLength(0)
  })

  it('searches entries', async () => {
    const c = await newCompany()
    post(c, '2026-01-05', [dr(c, '1000', 100, 'Acme deposit'), cr(c, '4000', 100)], 'January sale', 'INV-7')
    post(c, '2026-02-05', [dr(c, '6450', 100), cr(c, '1000', 100)], 'Rent')
    expect(c.listEntries({ search: 'acme' })).toHaveLength(1)
    expect(c.listEntries({ search: 'inv-7' })).toHaveLength(1)
    expect(c.listEntries({ from: '2026-02-01' })).toHaveLength(1)
  })
})

describe('closing date', () => {
  it('blocks changes in closed periods unless confirmed', async () => {
    const c = await newCompany()
    const id = post(c, '2026-01-05', [dr(c, '1000', 100), cr(c, '4000', 100)])
    c.setClosing('2026-01-31', null)
    expect(() => post(c, '2026-01-20', [dr(c, '1000', 100), cr(c, '4000', 100)])).toThrow(ClosedPeriodError)
    expect(() => c.voidEntry(id)).toThrow(ClosedPeriodError)
    // Moving an open entry into a closed period is also blocked.
    const feb = post(c, '2026-02-05', [dr(c, '1000', 100), cr(c, '4000', 100)])
    expect(() =>
      c.updateEntry(feb, { date: '2026-01-31', ref: '', memo: '', lines: [dr(c, '1000', 100), cr(c, '4000', 100)] })
    ).toThrow(ClosedPeriodError)
    c.voidEntry(id, { confirmClosedPeriod: true })
  })

  it('requires the password when one is set', async () => {
    const c = await newCompany()
    c.setClosing('2026-01-31', 'secret')
    expect(c.getClosing()).toEqual({ closingDate: '2026-01-31', hasPassword: true })
    const lines = [dr(c, '1000', 100), cr(c, '4000', 100)]
    expect(() => c.createEntry({ date: '2026-01-02', ref: '', memo: '', lines }, { confirmClosedPeriod: true })).toThrow(
      /password/
    )
    expect(() => c.createEntry({ date: '2026-01-02', ref: '', memo: '', lines }, { closingPassword: 'nope' })).toThrow()
    c.createEntry({ date: '2026-01-02', ref: '', memo: '', lines }, { closingPassword: 'secret' })
    expect(() => c.setClosing(null, null, 'wrong')).toThrow(/incorrect/)
    c.setClosing(null, null, 'secret')
    expect(c.getClosing()).toEqual({ closingDate: null, hasPassword: false })
  })
})

describe('opening balances', () => {
  it('offsets the difference to Opening Balance Equity', async () => {
    const c = await newCompany()
    const entry = enterOpeningBalances(c, '2025-12-31', [
      { accountId: acct(c, '1000'), amount: 1500000 },
      { accountId: acct(c, '2700'), amount: 500000 }
    ])
    expect(entry.isOpening).toBe(true)
    const net = c.netByAccount(null, '2025-12-31')
    expect(net.get(acct(c, '1000'))).toBe(1500000)
    expect(net.get(acct(c, '2700'))).toBe(-500000)
    expect(net.get(acct(c, '3000'))).toBe(-1000000)
  })
})
