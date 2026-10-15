import { useEffect, useState } from 'react'
import { api } from '../api'
import { useDialogs } from '../components/Dialogs'
import { AccountSelect, MoneyInput } from '../components/inputs'
import { formatMoney, today } from '../format'
import type { Nav } from '../nav'
import type { Account, JournalEntry, JournalLine } from '../../../shared/types'

interface DraftLine extends Omit<JournalLine, 'accountId'> {
  key: number
  accountId: number | null
}

let nextKey = 1
const blankLine = (): DraftLine => ({ key: nextKey++, accountId: null, debit: 0, credit: 0, memo: '' })

export function EntryEditor({ nav, id }: { nav: Nav; id?: number }): JSX.Element {
  const dialogs = useDialogs()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [existing, setExisting] = useState<JournalEntry | null>(null)
  const [date, setDate] = useState(today())
  const [ref, setRef] = useState('')
  const [memo, setMemo] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([blankLine(), blankLine(), blankLine(), blankLine()])
  const [saving, setSaving] = useState(false)

  const reset = async (): Promise<void> => {
    setExisting(null)
    setRef(await api.nextRef())
    setMemo('')
    setLines([blankLine(), blankLine(), blankLine(), blankLine()])
  }

  useEffect(() => {
    void api.listAccounts().then(setAccounts)
    if (id === undefined) {
      void reset()
      return
    }
    void api.getEntry(id).then((e) => {
      setExisting(e)
      setDate(e.date)
      setRef(e.ref)
      setMemo(e.memo)
      setLines([...e.lines.map((l) => ({ ...l, key: nextKey++ })), blankLine()])
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const debits = lines.reduce((s, l) => s + l.debit, 0)
  const credits = lines.reduce((s, l) => s + l.credit, 0)
  const difference = debits - credits
  const readOnly = !!existing?.isVoid

  const update = (key: number, patch: Partial<DraftLine>): void => {
    setLines((ls) => {
      const next = ls.map((l) => (l.key === key ? { ...l, ...patch } : l))
      // Keep a blank line at the bottom for quick entry.
      const last = next[next.length - 1]
      if (last.accountId !== null || last.debit || last.credit || last.memo) next.push(blankLine())
      return next
    })
  }

  /** On a new line, pre-fill the amount that would balance the entry, like QuickBooks does. */
  const fillBalance = (key: number): void => {
    const line = lines.find((l) => l.key === key)
    if (!line || line.debit || line.credit || difference === 0) return
    update(key, difference > 0 ? { credit: difference } : { debit: -difference })
  }

  const save = async (andNew: boolean): Promise<void> => {
    const used = lines.filter((l) => l.accountId !== null || l.debit || l.credit)
    const input = {
      date,
      ref,
      memo,
      isOpening: existing?.isOpening,
      lines: used.map((l) => ({ accountId: l.accountId ?? 0, debit: l.debit, credit: l.credit, memo: l.memo }))
    }
    setSaving(true)
    try {
      await dialogs.guarded((override) =>
        existing ? api.updateEntry(existing.id, input, override) : api.createEntry(input, override)
      )
      nav.changed()
      if (!andNew) nav.back()
      else if (existing) {
        nav.back()
        nav.push({ name: 'entry' })
      } else await reset()
    } catch (err) {
      dialogs.error(err)
    } finally {
      setSaving(false)
    }
  }

  const voidEntry = async (): Promise<void> => {
    if (!existing) return
    if (!(await dialogs.confirm('Void this entry? It stays on record but no longer affects any balance.', { okLabel: 'Void', danger: true }))) return
    try {
      await dialogs.guarded((override) => api.voidEntry(existing.id, override))
      nav.changed()
      nav.back()
    } catch (err) {
      dialogs.error(err)
    }
  }

  const deleteEntry = async (): Promise<void> => {
    if (!existing) return
    if (!(await dialogs.confirm('Permanently delete this entry? This cannot be undone.', { okLabel: 'Delete', danger: true }))) return
    try {
      await dialogs.guarded((override) => api.deleteEntry(existing.id, override))
      nav.changed()
      nav.back()
    } catch (err) {
      dialogs.error(err)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>
          {existing ? 'Journal Entry' : 'New Journal Entry'}
          {existing?.isVoid && <span className="badge">void</span>}
          {existing?.isOpening && <span className="badge">opening balances</span>}
        </h1>
      </div>
      <fieldset disabled={readOnly} className="entry-header">
        <label>
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          Entry no.
          <input value={ref} onChange={(e) => setRef(e.target.value)} style={{ width: 120 }} />
        </label>
        <label style={{ flex: 1 }}>
          Memo
          <input value={memo} onChange={(e) => setMemo(e.target.value)} />
        </label>
      </fieldset>

      <table className="grid entry-lines">
        <thead>
          <tr>
            <th style={{ width: '38%' }}>Account</th>
            <th className="num" style={{ width: 140 }}>
              Debit
            </th>
            <th className="num" style={{ width: 140 }}>
              Credit
            </th>
            <th>Memo</th>
            <th style={{ width: 32 }} />
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.key}>
              <td>
                <AccountSelect
                  disabled={readOnly}
                  accounts={accounts}
                  value={l.accountId}
                  onChange={(accountId) => update(l.key, { accountId })}
                  onBlur={() => l.accountId !== null && fillBalance(l.key)}
                />
              </td>
              <td>
                <MoneyInput disabled={readOnly} value={l.debit} onChange={(debit) => update(l.key, { debit, credit: debit ? 0 : l.credit })} />
              </td>
              <td>
                <MoneyInput disabled={readOnly} value={l.credit} onChange={(credit) => update(l.key, { credit, debit: credit ? 0 : l.debit })} />
              </td>
              <td>
                <input disabled={readOnly} value={l.memo} onChange={(e) => update(l.key, { memo: e.target.value })} />
              </td>
              <td>
                {!readOnly && lines.length > 2 && (
                  <button className="icon" title="Remove line" onClick={() => setLines(lines.filter((x) => x.key !== l.key))}>
                    ×
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className="right">Totals</td>
            <td className="num">{formatMoney(debits)}</td>
            <td className="num">{formatMoney(credits)}</td>
            <td colSpan={2} className={difference === 0 ? 'ok' : 'warn'}>
              {difference === 0 ? 'Balanced' : `Out of balance by ${formatMoney(Math.abs(difference))}`}
            </td>
          </tr>
        </tfoot>
      </table>

      <div className="buttons">
        {existing && !existing.isVoid && (
          <button className="danger-outline" onClick={voidEntry}>
            Void
          </button>
        )}
        {existing && (
          <button className="danger-outline" onClick={deleteEntry}>
            Delete
          </button>
        )}
        <span className="spacer" />
        <button onClick={nav.back}>{readOnly ? 'Close' : 'Cancel'}</button>
        {!readOnly && (
          <>
            <button disabled={saving} onClick={() => save(true)}>
              Save &amp; New
            </button>
            <button className="primary" disabled={saving} onClick={() => save(false)}>
              Save &amp; Close
            </button>
          </>
        )}
      </div>
    </div>
  )
}
