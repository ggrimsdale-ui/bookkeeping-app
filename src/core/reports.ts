import { isDebitNormal, isProfitAndLoss } from './accountTypes'
import type { AccountType } from './accountTypes'
import type { Company } from './company'
import { reconciliationReport } from './reconcile'
import { addDays, fiscalYearStart, formatDate, formatLongDate } from './dates'
import type { Account, Drill, Report, ReportColumn, ReportParams, ReportRow } from '../shared/types'

const BASIS = 'Accrual Basis'

// ----- Balances -----

interface Balances {
  /** Debit-positive balance per account, with income statement accounts reset at fiscal year start. */
  debit: Map<number, number>
  /** Debit-positive net income for the fiscal year to date (negative means a profit). */
  netIncomeDebit: number
}

/**
 * Balances as of a date the way a trial balance shows them: balance sheet
 * accounts carry their full history, income and expense accounts show only
 * the current fiscal year, and prior years' profit is rolled into Retained Earnings.
 */
export function balancesAsOf(company: Company, accounts: Account[], asOf: string): Balances {
  const fyStart = fiscalYearStart(asOf, company.getInfo().fiscalYearStartMonth)
  const all = company.netByAccount(null, asOf)
  const thisYear = company.netByAccount(fyStart, asOf)
  const debit = new Map<number, number>()
  let priorEarnings = 0
  let netIncomeDebit = 0
  for (const a of accounts) {
    if (isProfitAndLoss(a.type)) {
      const fy = thisYear.get(a.id) ?? 0
      debit.set(a.id, fy)
      netIncomeDebit += fy
      priorEarnings += (all.get(a.id) ?? 0) - fy
    } else {
      debit.set(a.id, all.get(a.id) ?? 0)
    }
  }
  const re = accounts.find((a) => a.system === 'retainedEarnings')
  if (re) debit.set(re.id, (debit.get(re.id) ?? 0) + priorEarnings)
  return { debit, netIncomeDebit }
}

function natural(type: AccountType, debitAmount: number): number {
  return (isDebitNormal(type) ? debitAmount : -debitAmount) || 0
}

// ----- Account tree rendering -----

interface Group {
  title: string
  types?: AccountType[]
  children?: Group[]
  /** Extra computed lines appended inside the group (Net Income in Equity). */
  extra?: { label: string; values: number[] }[]
}

interface Rendered {
  rows: ReportRow[]
  totals: number[]
  empty: boolean
}

interface TreeContext {
  accounts: Account[]
  values: Map<number, number[]>
  columns: number
  drill: (account: Account, col: number) => Drill | null
  showZero: boolean
}

function label(a: Account): string {
  return a.number ? `${a.number} · ${a.name}` : a.name
}

function zeros(n: number): number[] {
  return new Array<number>(n).fill(0)
}

function add(a: number[], b: number[]): number[] {
  return a.map((v, i) => v + b[i])
}

function money(label: string, values: number[], kind: ReportRow['kind'], indent: number, drills?: (Drill | null)[]): ReportRow {
  return { kind, cells: [label, ...values], indent, drills: drills ? [null, ...drills] : undefined }
}

function section(title: string, columns: number, indent: number): ReportRow {
  return { kind: 'section', cells: [title, ...new Array<null>(columns).fill(null)], indent }
}

function renderAccounts(ctx: TreeContext, types: AccountType[], indent: number): Rendered {
  const inGroup = ctx.accounts.filter((a) => types.includes(a.type))
  const ids = new Set(inGroup.map((a) => a.id))
  const kids = new Map<number | null, Account[]>()
  for (const a of inGroup) {
    const key = a.parentId !== null && ids.has(a.parentId) ? a.parentId : null
    kids.set(key, [...(kids.get(key) ?? []), a])
  }

  const renderNode = (a: Account, depth: number): Rendered => {
    const own = ctx.values.get(a.id) ?? zeros(ctx.columns)
    const childResults = (kids.get(a.id) ?? []).map((c) => renderNode(c, depth + 1)).filter((r) => !r.empty)
    const totals = childResults.reduce((t, r) => add(t, r.totals), own)
    const ownZero = own.every((v) => v === 0)
    const drills = own.map((_, i) => ctx.drill(a, i))
    if (childResults.length === 0) {
      if (ownZero && !ctx.showZero) return { rows: [], totals, empty: true }
      return { rows: [money(label(a), own, 'line', depth, drills)], totals, empty: false }
    }
    const rows: ReportRow[] = [section(label(a), ctx.columns, depth)]
    for (const r of childResults) rows.push(...r.rows)
    if (!ownZero) rows.push(money(`${label(a)} - Other`, own, 'line', depth + 1, drills))
    rows.push(money(`Total ${label(a)}`, totals, 'subtotal', depth))
    return { rows, totals, empty: false }
  }

  const rows: ReportRow[] = []
  let totals = zeros(ctx.columns)
  for (const a of kids.get(null) ?? []) {
    const r = renderNode(a, indent)
    if (r.empty) continue
    rows.push(...r.rows)
    totals = add(totals, r.totals)
  }
  return { rows, totals, empty: rows.length === 0 }
}

function renderGroup(ctx: TreeContext, group: Group, indent: number): Rendered {
  const inner: ReportRow[] = []
  let totals = zeros(ctx.columns)
  if (group.types) {
    const r = renderAccounts(ctx, group.types, indent + 1)
    inner.push(...r.rows)
    totals = add(totals, r.totals)
  }
  for (const child of group.children ?? []) {
    const r = renderGroup(ctx, child, indent + 1)
    if (r.empty) continue
    inner.push(...r.rows)
    totals = add(totals, r.totals)
  }
  for (const e of group.extra ?? []) {
    if (e.values.every((v) => v === 0) && !ctx.showZero) continue
    inner.push(money(e.label, e.values, 'line', indent + 1))
    totals = add(totals, e.values)
  }
  if (inner.length === 0) return { rows: [], totals, empty: true }
  return {
    rows: [section(group.title, ctx.columns, indent), ...inner, money(`Total ${group.title}`, totals, 'subtotal', indent)],
    totals,
    empty: false
  }
}

// ----- Change columns -----

function withChange(report: Report, periods: number): Report {
  if (periods !== 2) return report
  return {
    ...report,
    columns: [...report.columns, { label: '$ Change', kind: 'money' }, { label: '% Change', kind: 'percent' }],
    rows: report.rows.map((r) => {
      if (r.kind === 'section' || r.kind === 'spacer') return { ...r, cells: [...r.cells, null, null] }
      const cur = r.cells[1] as number
      const prev = r.cells[2] as number
      const pct = prev === 0 ? null : (cur - prev) / Math.abs(prev)
      return { ...r, cells: [...r.cells, cur - prev, pct], drills: r.drills ? [...r.drills, null, null] : undefined }
    })
  }
}

function moneyColumns(periods: ReportParams['periods']): ReportColumn[] {
  return [{ label: '', kind: 'text' }, ...periods.map((p) => ({ label: p.label, kind: 'money' as const }))]
}

function requirePeriods(params: ReportParams): void {
  if (params.periods.length === 0) throw new Error('Choose a report period')
  for (const p of params.periods) {
    if (p.from > p.to) throw new Error('The start date must be on or before the end date')
  }
}

// ----- Profit and Loss -----

export function profitAndLoss(company: Company, params: ReportParams): Report {
  requirePeriods(params)
  const accounts = company.listAccounts()
  const n = params.periods.length
  const values = new Map<number, number[]>()
  params.periods.forEach((p, i) => {
    const net = company.netByAccount(p.from, p.to)
    for (const a of accounts) {
      if (!isProfitAndLoss(a.type)) continue
      const v = values.get(a.id) ?? zeros(n)
      v[i] = natural(a.type, net.get(a.id) ?? 0)
      values.set(a.id, v)
    }
  })
  const ctx: TreeContext = {
    accounts,
    values,
    columns: n,
    showZero: !!params.showZeroBalances,
    drill: (a, i) => ({ accountId: a.id, from: params.periods[i].from, to: params.periods[i].to })
  }

  const rows: ReportRow[] = []
  const income = renderGroup(ctx, { title: 'Income', types: ['Income'] }, 0)
  const cogs = renderGroup(ctx, { title: 'Cost of Goods Sold', types: ['CostOfGoodsSold'] }, 0)
  const expenses = renderGroup(ctx, { title: 'Expenses', types: ['Expense'] }, 0)
  const otherIncome = renderGroup(ctx, { title: 'Other Income', types: ['OtherIncome'] }, 0)
  const otherExpense = renderGroup(ctx, { title: 'Other Expenses', types: ['OtherExpense'] }, 0)

  rows.push(...income.rows)
  const grossProfit = income.totals.map((v, i) => v - cogs.totals[i])
  if (!cogs.empty) {
    rows.push(...cogs.rows)
    rows.push(money('Gross Profit', grossProfit, 'total', 0))
  }
  rows.push(...expenses.rows)
  const operating = grossProfit.map((v, i) => v - expenses.totals[i])
  rows.push(money('Net Operating Income', operating, 'total', 0))
  let net = operating
  if (!otherIncome.empty || !otherExpense.empty) {
    rows.push(...otherIncome.rows, ...otherExpense.rows)
    const other = otherIncome.totals.map((v, i) => v - otherExpense.totals[i])
    rows.push(money('Net Other Income', other, 'total', 0))
    net = operating.map((v, i) => v + other[i])
  }
  rows.push(money('Net Income', net, 'grandTotal', 0))

  const single = params.periods[0]
  const report: Report = {
    kind: 'profitAndLoss',
    title: 'Profit & Loss',
    companyName: company.getInfo().name,
    subtitle:
      n === 1
        ? `${formatLongDate(single.from)} through ${formatLongDate(single.to)}`
        : params.periods.map((p) => p.label).join(' vs. '),
    basis: BASIS,
    columns: moneyColumns(params.periods),
    rows
  }
  return params.showChange ? withChange(report, n) : report
}

// ----- Balance Sheet -----

export function balanceSheet(company: Company, params: ReportParams): Report {
  requirePeriods(params)
  const accounts = company.listAccounts()
  const fyMonth = company.getInfo().fiscalYearStartMonth
  const n = params.periods.length
  const values = new Map<number, number[]>()
  const netIncome = zeros(n)
  params.periods.forEach((p, i) => {
    const b = balancesAsOf(company, accounts, p.to)
    for (const a of accounts) {
      if (isProfitAndLoss(a.type)) continue
      const v = values.get(a.id) ?? zeros(n)
      v[i] = natural(a.type, b.debit.get(a.id) ?? 0)
      values.set(a.id, v)
    }
    netIncome[i] = -b.netIncomeDebit || 0
  })
  const ctx: TreeContext = {
    accounts,
    values,
    columns: n,
    showZero: !!params.showZeroBalances,
    drill: (a, i) => {
      const asOf = params.periods[i].to
      return { accountId: a.id, from: fiscalYearStart(asOf, fyMonth), to: asOf }
    }
  }

  const assets = renderGroup(
    ctx,
    {
      title: 'ASSETS',
      children: [
        {
          title: 'Current Assets',
          children: [
            { title: 'Checking/Savings', types: ['Bank'] },
            { title: 'Accounts Receivable', types: ['AccountsReceivable'] },
            { title: 'Other Current Assets', types: ['OtherCurrentAsset'] }
          ]
        },
        { title: 'Fixed Assets', types: ['FixedAsset'] },
        { title: 'Other Assets', types: ['OtherAsset'] }
      ]
    },
    0
  )
  const liabilitiesAndEquity = renderGroup(
    ctx,
    {
      title: 'LIABILITIES & EQUITY',
      children: [
        {
          title: 'Liabilities',
          children: [
            {
              title: 'Current Liabilities',
              children: [
                { title: 'Accounts Payable', types: ['AccountsPayable'] },
                { title: 'Credit Cards', types: ['CreditCard'] },
                { title: 'Other Current Liabilities', types: ['OtherCurrentLiability'] }
              ]
            },
            { title: 'Long Term Liabilities', types: ['LongTermLiability'] }
          ]
        },
        { title: 'Equity', types: ['Equity'], extra: [{ label: 'Net Income', values: netIncome }] }
      ]
    },
    0
  )

  // The group renderer labels top-level totals "Total ASSETS"; use the conventional wording.
  const relabel = (rows: ReportRow[], from: string, to: string): ReportRow[] =>
    rows.map((r) => (r.cells[0] === from ? { ...r, kind: 'grandTotal', cells: [to, ...r.cells.slice(1)] } : r))

  const rows = [
    ...relabel(assets.rows, 'Total ASSETS', 'TOTAL ASSETS'),
    ...relabel(liabilitiesAndEquity.rows, 'Total LIABILITIES & EQUITY', 'TOTAL LIABILITIES & EQUITY')
  ]
  if (assets.empty) rows.unshift(money('TOTAL ASSETS', zeros(n), 'grandTotal', 0))
  if (liabilitiesAndEquity.empty) rows.push(money('TOTAL LIABILITIES & EQUITY', zeros(n), 'grandTotal', 0))

  const report: Report = {
    kind: 'balanceSheet',
    title: 'Balance Sheet',
    companyName: company.getInfo().name,
    subtitle: n === 1 ? `As of ${formatLongDate(params.periods[0].to)}` : params.periods.map((p) => p.label).join(' vs. '),
    basis: BASIS,
    columns: moneyColumns(params.periods),
    rows
  }
  return params.showChange ? withChange(report, n) : report
}

// ----- Trial Balance -----

export function trialBalance(company: Company, params: ReportParams): Report {
  requirePeriods(params)
  const asOf = params.periods[0].to
  const accounts = company.listAccounts()
  const fyStart = fiscalYearStart(asOf, company.getInfo().fiscalYearStartMonth)
  const b = balancesAsOf(company, accounts, asOf)
  const rows: ReportRow[] = []
  let debits = 0
  let credits = 0
  for (const a of accounts) {
    const d = b.debit.get(a.id) ?? 0
    if (d === 0 && !params.showZeroBalances) continue
    const drill: Drill = { accountId: a.id, from: fyStart, to: asOf }
    rows.push({
      kind: 'line',
      cells: [a.fullName, d > 0 ? d : null, d < 0 ? -d : null],
      indent: 0,
      drills: [null, drill, drill]
    })
    if (d > 0) debits += d
    else credits -= d
  }
  rows.push({ kind: 'grandTotal', cells: ['TOTAL', debits, credits], indent: 0 })
  return {
    kind: 'trialBalance',
    title: 'Trial Balance',
    companyName: company.getInfo().name,
    subtitle: `As of ${formatLongDate(asOf)}`,
    basis: BASIS,
    columns: [
      { label: '', kind: 'text' },
      { label: 'Debit', kind: 'money' },
      { label: 'Credit', kind: 'money' }
    ],
    rows
  }
}

// ----- General Ledger -----

export function generalLedger(company: Company, params: ReportParams): Report {
  requirePeriods(params)
  const { from, to } = params.periods[0]
  const accounts = company.listAccounts()
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const selected = params.accountIds?.length ? accounts.filter((a) => params.accountIds!.includes(a.id)) : accounts
  const fyStart = fiscalYearStart(from, company.getInfo().fiscalYearStartMonth)
  const dayBefore = addDays(from, -1)

  // Beginning balances, debit-positive, matching the trial balance as of the day before `from`.
  const before = company.netByAccount(null, dayBefore)
  const ytdBefore = fyStart < from ? company.netByAccount(fyStart, dayBefore) : new Map<number, number>()
  const priorEarnings = accounts
    .filter((a) => isProfitAndLoss(a.type))
    .reduce((sum, a) => sum + (before.get(a.id) ?? 0) - (ytdBefore.get(a.id) ?? 0), 0)
  const beginning = (a: Account): number => {
    if (isProfitAndLoss(a.type)) return ytdBefore.get(a.id) ?? 0
    return (before.get(a.id) ?? 0) + (a.system === 'retainedEarnings' ? priorEarnings : 0)
  }

  const lines = company.linesForAccounts(
    selected.map((a) => a.id),
    from,
    to
  )
  const split = company.entryAccounts(lines.map((l) => l.entryId))
  const linesByAccount = new Map<number, typeof lines>()
  for (const l of lines) linesByAccount.set(l.accountId, [...(linesByAccount.get(l.accountId) ?? []), l])

  const rows: ReportRow[] = []
  let totalDebit = 0
  let totalCredit = 0
  for (const a of selected) {
    const own = linesByAccount.get(a.id) ?? []
    const begin = beginning(a)
    if (own.length === 0 && begin === 0 && !params.showZeroBalances) continue
    const sign = isDebitNormal(a.type) ? 1 : -1
    let balance = begin
    let d = 0
    let c = 0
    rows.push({ kind: 'section', cells: [a.fullName, null, null, null, null, null, null], indent: 0 })
    rows.push({ kind: 'line', cells: ['', '', 'Beginning Balance', '', null, null, (begin * sign || 0)], indent: 1 })
    for (const l of own) {
      balance += l.debit - l.credit
      d += l.debit
      c += l.credit
      const others = (split.get(l.entryId) ?? []).filter((id) => id !== a.id)
      const splitName = others.length === 1 ? byId.get(others[0])?.fullName ?? '' : others.length > 1 ? '-SPLIT-' : ''
      const drill: Drill = { entryId: l.entryId }
      rows.push({
        kind: 'line',
        cells: [
          formatDate(l.date),
          l.ref,
          l.lineMemo || l.entryMemo,
          splitName,
          l.debit || null,
          l.credit || null,
          (balance * sign || 0)
        ],
        indent: 1,
        drills: new Array(7).fill(drill)
      })
    }
    rows.push({ kind: 'subtotal', cells: [`Total ${a.fullName}`, '', '', '', d, c, (balance * sign || 0)], indent: 0 })
    totalDebit += d
    totalCredit += c
  }
  rows.push({ kind: 'grandTotal', cells: ['TOTAL', '', '', '', totalDebit, totalCredit, null], indent: 0 })

  return {
    kind: 'generalLedger',
    title: 'General Ledger',
    companyName: company.getInfo().name,
    subtitle: `${formatLongDate(from)} through ${formatLongDate(to)}`,
    basis: BASIS,
    columns: [
      { label: 'Date', kind: 'text' },
      { label: 'Ref', kind: 'text' },
      { label: 'Memo', kind: 'text' },
      { label: 'Split', kind: 'text' },
      { label: 'Debit', kind: 'money' },
      { label: 'Credit', kind: 'money' },
      { label: 'Balance', kind: 'money' }
    ],
    rows
  }
}

export function buildReport(company: Company, params: ReportParams): Report {
  switch (params.kind) {
    case 'profitAndLoss':
      return profitAndLoss(company, params)
    case 'balanceSheet':
      return balanceSheet(company, params)
    case 'trialBalance':
      return trialBalance(company, params)
    case 'generalLedger':
      return generalLedger(company, params)
    case 'reconciliation':
      if (!params.reconciliationId) throw new Error('Choose a reconciliation')
      return reconciliationReport(company, params.reconciliationId)
  }
}
