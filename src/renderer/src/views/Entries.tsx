import { useEffect, useState } from 'react'
import { api } from '../api'
import { formatDate, formatMoney } from '../format'
import type { Nav } from '../nav'
import type { JournalEntrySummary } from '../../../shared/types'

export function Entries({ nav }: { nav: Nav }): JSX.Element {
  const [entries, setEntries] = useState<JournalEntrySummary[]>([])
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    const t = setTimeout(() => {
      void api.listEntries({ from: from || undefined, to: to || undefined, search }).then(setEntries)
    }, 150)
    return () => clearTimeout(t)
  }, [from, to, search, nav.version])

  return (
    <div className="page">
      <div className="page-header">
        <h1>Journal Entries</h1>
        <div className="toolbar">
          <button className="primary" onClick={() => nav.push({ name: 'entry' })}>
            New journal entry
          </button>
          <label className="inline">
            From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="inline">
            To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <input type="search" placeholder="Search ref or memo" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Date</th>
            <th>Ref</th>
            <th>Memo</th>
            <th>Accounts</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No journal entries match.
              </td>
            </tr>
          )}
          {entries.map((e) => (
            <tr key={e.id} className={`clickable ${e.isVoid ? 'inactive' : ''}`} onClick={() => nav.push({ name: 'entry', id: e.id })}>
              <td className="nowrap">{formatDate(e.date)}</td>
              <td>{e.ref}</td>
              <td>
                {e.memo}
                {e.isVoid && <span className="badge">void</span>}
                {e.isOpening && <span className="badge">opening</span>}
              </td>
              <td className="small">{e.accounts}</td>
              <td className="num">{e.isVoid ? '' : formatMoney(e.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
