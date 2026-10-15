import { describe, expect, it } from 'vitest'
import type { Company } from '../src/core/company'
import { reportToCsv } from '../src/core/exportReport'
import { enterOpeningBalances } from '../src/core/openingBalances'
import { buildReport } from '../src/core/reports'
import type { Report, ReportParams } from '../src/shared/types'
import { acct, cr, dr, newCompany, post } from './helpers'

function row(report: Report, label: string): (string | number | null)[] {
  const r = report.rows.find((x) => x.cells[0] === label)
  if (!r) throw new Error(`No row "${label}" in ${report.rows.map((x) => x.cells[0]).join(', ')}`)
  return r.cells.slice(1)
}

function params(kind: ReportParams['kind'], from: string, to: string, extra: Partial<ReportParams> = {}): ReportParams {
  return { kind, periods: [{ label: 'Total', from, to }], ...extra }
}

/** Two years of activity for a company with a calendar fiscal year. */
async function sample(): Promise<Company> {
  const c = await newCompany()
  enterOpeningBalances(c, '2024-12-31', [{ accountId: acct(c, '1000'), amount: 1000000 }])
  // 2025: sales 50,000, COGS 20,000, rent 12,000 => net income 18,000
  post(c, '2025-03-01', [dr(c, '1000', 5000000), cr(c, '4000', 5000000)], 'Sales')
  post(c, '2025-03-02', [dr(c, '5000', 2000000), cr(c, '1000', 2000000)], 'Purchases')
  post(c, '2025-06-30', [dr(c, '6450', 1200000), cr(c, '1000', 1200000)], 'Rent')
  // 2026: sales 30,000 on account, utilities 1,000 by credit card, interest income 100, owner draw 2,000
  post(c, '2026-02-01', [dr(c, '1200', 3000000), cr(c, '4000', 3000000)], 'Invoice', 'INV-1')
  post(c, '2026-02-15', [dr(c, '6650', 100000), cr(c, '2100', 100000)], 'Power bill')
  post(c, '2026-03-31', [dr(c, '1010', 10000), cr(c, '7000', 10000)], 'Interest')
  post(c, '2026-04-01', [dr(c, '3120', 200000), cr(c, '1000', 200000)], 'Draw')
  // A voided entry must not affect any report.
  const v = post(c, '2026-04-02', [dr(c, '6300', 99900), cr(c, '1000', 99900)], 'Mistake')
  c.voidEntry(v)
  return c
}

describe('profit and loss', () => {
  it('computes gross profit, operating income and net income', async () => {
    const c = await sample()
    const r = buildReport(c, params('profitAndLoss', '2025-01-01', '2025-12-31'))
    expect(row(r, 'Total Income')).toEqual([5000000])
    expect(row(r, 'Gross Profit')).toEqual([3000000])
    expect(row(r, 'Total Expenses')).toEqual([1200000])
    expect(row(r, 'Net Operating Income')).toEqual([1800000])
    expect(row(r, 'Net Income')).toEqual([1800000])
    expect(r.rows.some((x) => x.cells[0] === 'Net Other Income')).toBe(false)
  })

  it('includes other income and comparison columns', async () => {
    const c = await sample()
    const r = buildReport(c, {
      kind: 'profitAndLoss',
      periods: [
        { label: '2026', from: '2026-01-01', to: '2026-12-31' },
        { label: '2025', from: '2025-01-01', to: '2025-12-31' }
      ],
      showChange: true
    })
    expect(r.columns.map((x) => x.label)).toEqual(['', '2026', '2025', '$ Change', '% Change'])
    expect(row(r, 'Net Other Income')).toEqual([10000, 0, 10000, null])
    const net = row(r, 'Net Income')
    expect(net.slice(0, 3)).toEqual([2910000, 1800000, 1110000])
    expect(net[3]).toBeCloseTo(1110000 / 1800000)
  })

  it('drills into account detail for the period', async () => {
    const c = await sample()
    const r = buildReport(c, params('profitAndLoss', '2025-01-01', '2025-12-31'))
    const sales = r.rows.find((x) => x.cells[0] === '4000 · Sales')!
    expect(sales.drills![1]).toEqual({ accountId: acct(c, '4000'), from: '2025-01-01', to: '2025-12-31' })
  })

  it('rolls sub-accounts into their parent', async () => {
    const c = await newCompany()
    post(c, '2026-01-05', [dr(c, '6360', 100000), dr(c, '6370', 7650), dr(c, '6350', 50), cr(c, '1000', 107700)])
    const r = buildReport(c, params('profitAndLoss', '2026-01-01', '2026-12-31'))
    expect(row(r, '6360 · Wages')).toEqual([100000])
    expect(row(r, '6350 · Payroll Expenses - Other')).toEqual([50])
    expect(row(r, 'Total 6350 · Payroll Expenses')).toEqual([107700])
    expect(row(r, 'Total Expenses')).toEqual([107700])
  })
})

describe('balance sheet', () => {
  it('balances and rolls prior-year profit into retained earnings', async () => {
    const c = await sample()
    const r = buildReport(c, params('balanceSheet', '2026-01-01', '2026-12-31'))
    expect(row(r, 'TOTAL ASSETS')).toEqual([row(r, 'TOTAL LIABILITIES & EQUITY')[0]])
    expect(row(r, '3900 · Retained Earnings')).toEqual([1800000])
    expect(row(r, 'Net Income')).toEqual([2910000])
    expect(row(r, '3000 · Opening Balance Equity')).toEqual([1000000])
    // Cash 10,000 + 50,000 - 20,000 - 12,000 - 2,000 = 26,000; savings 100; A/R 30,000
    expect(row(r, '1000 · Checking')).toEqual([2600000])
    expect(row(r, 'Total Current Assets')).toEqual([5610000])
    expect(row(r, 'Total Liabilities')).toEqual([100000])
    expect(row(r, "Total 3100 · Owner's Equity")).toEqual([-200000])
    expect(row(r, 'TOTAL ASSETS')).toEqual([5610000])
  })

  it('balances at every year end with a non-calendar fiscal year', async () => {
    const c = await newCompany('service', 7)
    post(c, '2025-08-01', [dr(c, '1000', 500000), cr(c, '4000', 500000)])
    post(c, '2026-05-01', [dr(c, '6450', 100000), cr(c, '1000', 100000)])
    post(c, '2026-08-01', [dr(c, '1000', 70000), cr(c, '4100', 70000)])
    for (const asOf of ['2026-06-30', '2026-07-01', '2026-12-31']) {
      const r = buildReport(c, params('balanceSheet', asOf, asOf))
      expect(row(r, 'TOTAL ASSETS')).toEqual(row(r, 'TOTAL LIABILITIES & EQUITY'))
    }
    const afterYearEnd = buildReport(c, params('balanceSheet', '2026-07-01', '2026-07-01'))
    expect(row(afterYearEnd, '3900 · Retained Earnings')).toEqual([400000])
    expect(afterYearEnd.rows.some((x) => x.cells[0] === 'Net Income')).toBe(false)
  })
})

describe('trial balance', () => {
  it('balances and agrees with the balance sheet', async () => {
    const c = await sample()
    const r = buildReport(c, params('trialBalance', '2026-12-31', '2026-12-31'))
    const [debits, credits] = row(r, 'TOTAL')
    expect(debits).toBe(credits)
    // Income accounts show only the current fiscal year.
    expect(row(r, '4000 · Sales')).toEqual([null, 3000000])
    expect(row(r, '3900 · Retained Earnings')).toEqual([null, 1800000])
    // Voided entries are excluded.
    expect(r.rows.some((x) => x.cells[0] === '6300 · Office Supplies')).toBe(false)
  })
})

describe('general ledger', () => {
  it('shows beginning balance, running balance and splits', async () => {
    const c = await sample()
    const r = buildReport(c, params('generalLedger', '2026-01-01', '2026-12-31', { accountIds: [acct(c, '1000')] }))
    const cash = r.rows.filter((x) => x.kind !== 'section')
    expect(cash[0].cells[2]).toBe('Beginning Balance')
    expect(cash[0].cells[6]).toBe(2800000)
    expect(cash[1].cells.slice(0, 4)).toEqual(['04/01/2026', '', 'Draw', "3100 · Owner's Equity:3120 · Owner's Draws"])
    expect(cash[1].cells[6]).toBe(2600000)
    expect(row(r, 'Total 1000 · Checking')).toEqual(['', '', '', 0, 200000, 2600000])
  })

  it('resets income accounts at the fiscal year start', async () => {
    const c = await sample()
    const r = buildReport(c, params('generalLedger', '2026-01-01', '2026-12-31', { accountIds: [acct(c, '4000')] }))
    expect(r.rows[1].cells[6]).toBe(0)
    expect(row(r, 'Total 4000 · Sales')[5]).toBe(3000000)
  })

  it('ties ending balances to the trial balance', async () => {
    const c = await sample()
    const gl = buildReport(c, params('generalLedger', '2026-01-01', '2026-06-30'))
    const tb = buildReport(c, params('trialBalance', '2026-06-30', '2026-06-30'))
    const ar = row(gl, 'Total 1200 · Accounts Receivable')
    expect(ar[5]).toBe(row(tb, '1200 · Accounts Receivable')[0])
    const re = row(gl, 'Total 3900 · Retained Earnings')
    expect(re[5]).toBe(row(tb, '3900 · Retained Earnings')[1])
  })
})

describe('export', () => {
  it('writes CSV with plain numbers and quoted text', async () => {
    const c = await sample()
    const csv = reportToCsv(buildReport(c, params('trialBalance', '2026-12-31', '2026-12-31')))
    expect(csv).toContain('Trial Balance')
    expect(csv).toContain('4000 · Sales,,30000.00')
    expect(csv).toContain(`3100 · Owner's Equity:3120 · Owner's Draws,2000.00,`)
    const quoted = reportToCsv({ ...buildReport(c, params('trialBalance', '2026-12-31', '2026-12-31')), companyName: 'A, "B"' })
    expect(quoted).toContain('"A, ""B"""')
  })
})
