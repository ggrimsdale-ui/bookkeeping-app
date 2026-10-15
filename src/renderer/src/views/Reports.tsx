import { useEffect, useState } from 'react'
import { api } from '../api'
import { useDialogs } from '../components/Dialogs'
import { AccountSelect } from '../components/inputs'
import { ReportTable } from '../components/ReportTable'
import { fiscalYearStart, formatDate, presetRange, priorPeriod, priorYear, today } from '../format'
import type { Nav } from '../nav'
import type { ExportFormat, OpenCompany } from '../../../shared/api'
import type { Account, Drill, Report, ReportKind, ReportParams } from '../../../shared/types'
import type { RangePreset } from '../../../core/dates'

const REPORTS: { kind: ReportKind; title: string; description: string }[] = [
  { kind: 'profitAndLoss', title: 'Profit & Loss', description: 'Income and expenses for a period, with optional comparison columns.' },
  { kind: 'balanceSheet', title: 'Balance Sheet', description: 'Assets, liabilities and equity as of a date.' },
  { kind: 'trialBalance', title: 'Trial Balance', description: 'Debit and credit balance of every account as of a date.' },
  { kind: 'generalLedger', title: 'General Ledger', description: 'Every transaction by account, with running balances.' }
]

const isPointInTime = (kind: ReportKind): boolean => kind === 'balanceSheet' || kind === 'trialBalance'

export function ReportsMenu({ nav, company }: { nav: Nav; company: OpenCompany }): JSX.Element {
  const to = today()
  const from = fiscalYearStart(to, company.info.fiscalYearStartMonth)
  return (
    <div className="page">
      <h1>Reports</h1>
      <div className="report-list">
        {REPORTS.map((r) => (
          <button
            key={r.kind}
            className="tile wide"
            onClick={() => nav.push({ name: 'report', params: { kind: r.kind, periods: [{ label: 'Total', from, to }] } })}
          >
            <strong>{r.title}</strong>
            <span>{r.description}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

type Compare = 'none' | 'priorPeriod' | 'priorYear'

const PRESETS: { value: RangePreset | 'custom'; label: string }[] = [
  { value: 'custom', label: 'Custom' },
  { value: 'thisMonth', label: 'This month' },
  { value: 'lastMonth', label: 'Last month' },
  { value: 'thisQuarter', label: 'This quarter' },
  { value: 'lastQuarter', label: 'Last quarter' },
  { value: 'thisFiscalYearToDate', label: 'This fiscal year to date' },
  { value: 'thisFiscalYear', label: 'This fiscal year' },
  { value: 'lastFiscalYear', label: 'Last fiscal year' }
]

function columnLabel(kind: ReportKind, from: string, to: string): string {
  return isPointInTime(kind) ? formatDate(to) : `${formatDate(from)} - ${formatDate(to)}`
}

export function ReportView({ nav, company, initial }: { nav: Nav; company: OpenCompany; initial: ReportParams }): JSX.Element {
  const dialogs = useDialogs()
  const kind = initial.kind
  const [preset, setPreset] = useState<RangePreset | 'custom'>('custom')
  const [from, setFrom] = useState(initial.periods[0].from)
  const [to, setTo] = useState(initial.periods[0].to)
  const [compare, setCompare] = useState<Compare>(initial.periods.length > 1 ? 'priorYear' : 'none')
  const [showChange, setShowChange] = useState(!!initial.showChange)
  const [accountId, setAccountId] = useState<number | null>(initial.accountIds?.[0] ?? null)
  const [showZero, setShowZero] = useState(!!initial.showZeroBalances)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fyMonth = company.info.fiscalYearStartMonth

  const params = (): ReportParams => {
    const main = { from, to }
    const periods = [{ label: columnLabel(kind, from, to), ...main }]
    if (compare !== 'none' && kind !== 'trialBalance' && kind !== 'generalLedger') {
      const prior = compare === 'priorYear' ? priorYear(main) : priorPeriod(main)
      // For a point-in-time report the prior period's end date is the comparison date.
      periods.push({ label: columnLabel(kind, prior.from, prior.to), ...prior })
    }
    return {
      kind,
      periods,
      showChange: periods.length === 2 && showChange,
      accountIds: kind === 'generalLedger' && accountId ? [accountId] : undefined,
      showZeroBalances: showZero
    }
  }

  useEffect(() => {
    if (kind === 'generalLedger') void api.listAccounts().then(setAccounts)
  }, [kind])

  useEffect(() => {
    if (!from || !to) return
    setError(null)
    api
      .report(params())
      .then(setReport)
      .catch((err: Error) => setError(err.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, compare, showChange, accountId, showZero, nav.version])

  const applyPreset = (value: RangePreset | 'custom'): void => {
    setPreset(value)
    if (value === 'custom') return
    const range = presetRange(value, today(), fyMonth)
    setFrom(range.from)
    setTo(range.to)
  }

  const drill = (d: Drill): void => {
    if (d.entryId) nav.push({ name: 'entry', id: d.entryId })
    else if (d.accountId && d.to) {
      nav.push({
        name: 'report',
        params: {
          kind: 'generalLedger',
          accountIds: [d.accountId],
          periods: [{ label: 'Total', from: d.from ?? fiscalYearStart(d.to, fyMonth), to: d.to }]
        }
      })
    }
  }

  const exportAs = async (format: ExportFormat): Promise<void> => {
    try {
      await api.exportReport(params(), format)
    } catch (err) {
      dialogs.error(err)
    }
  }

  const title = REPORTS.find((r) => r.kind === kind)!.title
  return (
    <div className="page report-page">
      <div className="report-controls no-print">
        <h1>{title}</h1>
        <div className="toolbar">
          <label className="inline">
            Dates
            <select value={preset} onChange={(e) => applyPreset(e.target.value as RangePreset | 'custom')}>
              {PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {!isPointInTime(kind) && (
            <label className="inline">
              From
              <input
                type="date"
                value={from}
                onChange={(e) => {
                  setPreset('custom')
                  setFrom(e.target.value)
                }}
              />
            </label>
          )}
          <label className="inline">
            {isPointInTime(kind) ? 'As of' : 'To'}
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setPreset('custom')
                setTo(e.target.value)
                if (isPointInTime(kind)) setFrom(fiscalYearStart(e.target.value || today(), fyMonth))
              }}
            />
          </label>
          {(kind === 'profitAndLoss' || kind === 'balanceSheet') && (
            <>
              <label className="inline">
                Compare to
                <select value={compare} onChange={(e) => setCompare(e.target.value as Compare)}>
                  <option value="none">Nothing</option>
                  <option value="priorPeriod">Previous period</option>
                  <option value="priorYear">Previous year</option>
                </select>
              </label>
              {compare !== 'none' && (
                <label className="checkbox">
                  <input type="checkbox" checked={showChange} onChange={(e) => setShowChange(e.target.checked)} />
                  $ and % change
                </label>
              )}
            </>
          )}
          {kind === 'generalLedger' && (
            <label className="inline">
              Account
              <AccountSelect accounts={accounts} value={accountId} onChange={setAccountId} blankLabel="All accounts" className="narrow" />
            </label>
          )}
          <label className="checkbox">
            <input type="checkbox" checked={showZero} onChange={(e) => setShowZero(e.target.checked)} />
            Show zero balances
          </label>
        </div>
        <div className="toolbar">
          <button onClick={() => api.printReport()}>Print…</button>
          <button onClick={() => exportAs('pdf')}>Export PDF</button>
          <button onClick={() => exportAs('xlsx')}>Export Excel</button>
          <button onClick={() => exportAs('csv')}>Export CSV</button>
          <span className="muted small">Click an amount to see the transactions behind it.</span>
        </div>
      </div>
      {error && <div className="error-banner no-print">{error}</div>}
      {report && <ReportTable report={report} onDrill={drill} />}
    </div>
  )
}
