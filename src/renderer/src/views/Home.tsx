import { useEffect, useState } from 'react'
import { api } from '../api'
import { fiscalYearStart, formatDate, formatMoney, today } from '../format'
import type { Nav } from '../nav'
import type { OpenCompany } from '../../../shared/api'
import type { Account, JournalEntrySummary, ReportKind } from '../../../shared/types'

export function Home({ nav, company }: { nav: Nav; company: OpenCompany }): JSX.Element {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [balances, setBalances] = useState<Record<number, number>>({})
  const [recent, setRecent] = useState<JournalEntrySummary[]>([])
  const asOf = today()

  useEffect(() => {
    void Promise.all([api.listAccounts(), api.accountBalances(asOf), api.listEntries({})]).then(([a, b, e]) => {
      setAccounts(a)
      setBalances(b)
      setRecent(e.slice(0, 8))
    })
  }, [asOf, nav.version])

  const fyStart = fiscalYearStart(asOf, company.info.fiscalYearStartMonth)
  const openReport = (kind: ReportKind): void =>
    nav.push({ name: 'report', params: { kind, periods: [{ label: 'Total', from: fyStart, to: asOf }] } })
  const cash = accounts.filter((a) => a.type === 'Bank' && a.isActive)

  return (
    <div className="page">
      <h1>{company.info.name}</h1>
      <div className="tiles">
        <button className="tile" onClick={() => nav.push({ name: 'entry' })}>
          <strong>New journal entry</strong>
          <span>Record a transaction</span>
        </button>
        <button className="tile" onClick={() => nav.go({ name: 'reconcile' })}>
          <strong>Reconcile</strong>
          <span>Match an account to its statement</span>
        </button>
        <button className="tile" onClick={() => nav.go({ name: 'accounts' })}>
          <strong>Chart of accounts</strong>
          <span>{accounts.length} accounts</span>
        </button>
        <button className="tile" onClick={() => openReport('profitAndLoss')}>
          <strong>Profit &amp; Loss</strong>
          <span>Fiscal year to date</span>
        </button>
        <button className="tile" onClick={() => openReport('balanceSheet')}>
          <strong>Balance Sheet</strong>
          <span>As of today</span>
        </button>
        <button className="tile" onClick={() => openReport('trialBalance')}>
          <strong>Trial Balance</strong>
          <span>As of today</span>
        </button>
        <button className="tile" onClick={() => openReport('generalLedger')}>
          <strong>General Ledger</strong>
          <span>Fiscal year to date</span>
        </button>
      </div>

      <div className="two-col">
        <section>
          <h2>Bank accounts</h2>
          <table className="grid">
            <tbody>
              {cash.length === 0 && (
                <tr>
                  <td className="muted">No bank accounts yet.</td>
                </tr>
              )}
              {cash.map((a) => (
                <tr
                  key={a.id}
                  className="clickable"
                  onClick={() =>
                    nav.push({
                      name: 'report',
                      params: { kind: 'generalLedger', accountIds: [a.id], periods: [{ label: 'Total', from: fyStart, to: asOf }] }
                    })
                  }
                >
                  <td>{a.fullName}</td>
                  <td className="num">{formatMoney(balances[a.id] ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section>
          <h2>Recent journal entries</h2>
          <table className="grid">
            <tbody>
              {recent.length === 0 && (
                <tr>
                  <td className="muted">No entries yet.</td>
                </tr>
              )}
              {recent.map((e) => (
                <tr key={e.id} className="clickable" onClick={() => nav.push({ name: 'entry', id: e.id })}>
                  <td className="nowrap">{formatDate(e.date)}</td>
                  <td>{e.memo || e.accounts}</td>
                  <td className="num">{formatMoney(e.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  )
}
