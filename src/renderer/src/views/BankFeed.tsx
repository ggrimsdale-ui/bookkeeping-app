import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { BankRules } from '../components/BankRules'
import { CsvImport } from '../components/CsvImport'
import { useDialogs } from '../components/Dialogs'
import { AccountSelect } from '../components/inputs'
import { WatchFolderDialog } from '../components/WatchFolder'
import { AttachmentsDialog } from '../components/Attachments'
import { formatDate, formatMoney, isProfitAndLoss } from '../format'
import type { Nav } from '../nav'
import type { Account, BankCounts, BankImportResult, BankRuleInput, BankTab, BankTransaction, BankTxPatch, WatchFolder } from '../../../shared/types'

const TABS: { tab: BankTab; label: string }[] = [
  { tab: 'review', label: 'For Review' },
  { tab: 'done', label: 'Added' },
  { tab: 'excluded', label: 'Excluded' }
]

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** Text that saves when you leave the field or press Enter. */
function TextCell({ value, onSave, placeholder }: { value: string; onSave: (v: string) => void; placeholder?: string }): JSX.Element {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = (): void => {
    if (text.trim() !== value) onSave(text)
  }
  return (
    <input
      className="cell-input"
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setText(value)
      }}
    />
  )
}

/**
 * The bank feed center: import a bank's CSV file, then review, categorize and
 * add the transactions in bulk, like QuickBooks' Bank Feeds.
 */
export function BankFeed({ nav, accountId }: { nav: Nav; accountId?: number }): JSX.Element {
  const dialogs = useDialogs()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [feedId, setFeedId] = useState<number | null>(accountId ?? null)
  const [tab, setTab] = useState<BankTab>('review')
  const [txs, setTxs] = useState<BankTransaction[]>([])
  const [counts, setCounts] = useState<BankCounts>({ review: 0, done: 0, excluded: 0 })
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [direction, setDirection] = useState<'all' | 'in' | 'out'>('all')
  const [uncategorized, setUncategorized] = useState(false)
  const [importing, setImporting] = useState(false)
  const [rules, setRules] = useState<{ initial?: BankRuleInput } | null>(null)
  const [bulkCategory, setBulkCategory] = useState<number | null>(null)
  const [bulkPayee, setBulkPayee] = useState('')
  const [bulkMemo, setBulkMemo] = useState('')
  const [busy, setBusy] = useState(false)
  const [watch, setWatch] = useState<WatchFolder | null>(null)
  const [editingWatch, setEditingWatch] = useState(false)
  const [receiptsFor, setReceiptsFor] = useState<BankTransaction | null>(null)

  useEffect(() => {
    void api.listAccounts().then((all) => {
      setAccounts(all)
      if (feedId === null) {
        const first = all.find((a) => a.type === 'Bank' && a.isActive) ?? all.find((a) => a.type === 'CreditCard' && a.isActive)
        if (first) setFeedId(first.id)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.version])

  useEffect(() => {
    if (feedId === null) return
    void Promise.all([api.listBankTransactions(feedId, tab), api.bankCounts(feedId), api.getWatchFolder(feedId)])
      .then(([list, c, w]) => {
        setTxs(list)
        setCounts(c)
        setWatch(w)
      })
      .catch(dialogs.error)
  }, [feedId, tab, nav.version, dialogs])

  // A new account or tab starts with nothing selected.
  useEffect(() => {
    setChecked(new Set())
    setAnchor(null)
  }, [feedId, tab])

  const feedAccounts = accounts.filter((a) => !isProfitAndLoss(a.type) && (a.isActive || a.id === feedId))
  const feed = accounts.find((a) => a.id === feedId)
  const categories = accounts.filter((a) => a.id !== feedId)
  const names = useMemo(() => new Map(accounts.map((a) => [a.id, a.fullName])), [accounts])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return txs.filter((t) => {
      if (direction === 'in' && t.amount < 0) return false
      if (direction === 'out' && t.amount > 0) return false
      if (uncategorized && tab === 'review' && (t.categoryId !== null || (t.match && !t.ignoreMatch))) return false
      if (!q) return true
      return [t.description, t.payee, t.memo, t.bankMemo, t.ref, formatMoney(Math.abs(t.amount))].some((s) => s.toLowerCase().includes(q))
    })
  }, [txs, search, direction, uncategorized, tab])

  const selected = visible.filter((t) => checked.has(t.id))
  const selectedIds = selected.map((t) => t.id)
  const spent = selected.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0)
  const received = selected.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0)
  const allChecked = visible.length > 0 && visible.every((t) => checked.has(t.id))

  /** Click toggles one row; shift-click sets every row between it and the last one clicked. */
  const toggle = (index: number, shift: boolean): void => {
    const target = !checked.has(visible[index].id)
    const next = new Set(checked)
    const [from, to] = shift && anchor !== null ? [Math.min(anchor, index), Math.max(anchor, index)] : [index, index]
    for (let i = from; i <= to; i++) {
      if (target) next.add(visible[i].id)
      else next.delete(visible[i].id)
    }
    setChecked(next)
    setAnchor(index)
  }

  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    try {
      await fn()
      return true
    } catch (err) {
      dialogs.error(err)
      return false
    } finally {
      setBusy(false)
      nav.changed()
    }
  }

  const patch = (ids: number[], p: BankTxPatch): void => {
    // Show the change right away; the reload confirms it.
    setTxs((list) =>
      list.map((t) => (ids.includes(t.id) ? { ...t, ...p, categorySource: p.categoryId !== undefined ? (p.categoryId === null ? null : 'user') : t.categorySource } : t))
    )
    void run(() => api.updateBankTransactions(ids, p))
  }

  const applyBulk = (): void => {
    const p: BankTxPatch = {}
    if (bulkCategory !== null) p.categoryId = bulkCategory
    if (bulkPayee.trim()) p.payee = bulkPayee
    if (bulkMemo.trim()) p.memo = bulkMemo
    if (Object.keys(p).length === 0) return
    patch(selectedIds, p)
    setBulkCategory(null)
    setBulkPayee('')
    setBulkMemo('')
  }

  const accept = async (ids: number[]): Promise<void> => {
    let summary = ''
    const ok = await run(async () => {
      const r = await dialogs.guarded((override) => api.acceptBankTransactions(ids, override))
      const parts = [r.added && `Added ${plural(r.added, 'transaction')}`, r.matched && `matched ${plural(r.matched, 'transaction')}`].filter(Boolean)
      if (r.skipped) parts.push(`${plural(r.skipped, 'transaction')} still need${r.skipped === 1 ? 's' : ''} a category`)
      summary = parts.join(', ')
    })
    if (ok) {
      setChecked(new Set())
      if (summary.includes('need')) void dialogs.alert(`${summary.charAt(0).toUpperCase()}${summary.slice(1)}.`, 'Bank feed')
    }
  }

  const exclude = (ids: number[], value: boolean): void => {
    void run(() => api.excludeBankTransactions(ids, value)).then(() => setChecked(new Set()))
  }

  const undo = async (ids: number[]): Promise<void> => {
    const added = txs.filter((t) => ids.includes(t.id) && t.status === 'added').length
    const message =
      added > 0
        ? `Send ${plural(ids.length, 'transaction')} back to For Review? The ${plural(added, 'journal entry')} created from ${added === 1 ? 'it' : 'them'} will be deleted, including any changes made since.`
        : `Send ${plural(ids.length, 'transaction')} back to For Review? The matched entries stay in the books.`
    if (!(await dialogs.confirm(message, { okLabel: 'Undo' }))) return
    await run(() => dialogs.guarded((override) => api.undoBankTransactions(ids, override)))
    setChecked(new Set())
  }

  const remove = async (ids: number[]): Promise<void> => {
    const ok = await dialogs.confirm(
      `Delete ${plural(ids.length, 'imported transaction')}? Use this for a file imported by mistake. Deleted transactions are imported again if the file is imported again.`,
      { okLabel: 'Delete', danger: true }
    )
    if (!ok) return
    await run(() => api.deleteBankTransactions(ids))
    setChecked(new Set())
  }

  const applyRules = async (): Promise<void> => {
    if (feedId === null) return
    let n = 0
    if (await run(async () => (n = await api.applyBankRules(feedId)))) {
      void dialogs.alert(n ? `Categorized ${plural(n, 'transaction')}.` : 'No transactions waiting for review match your rules or past choices.', 'Apply rules')
    }
  }

  const imported = (r: BankImportResult): void => {
    setImporting(false)
    setTab('review')
    nav.changed()
    const lines = [`Imported ${plural(r.imported, 'transaction')}.`]
    if (r.duplicates) lines.push(`Skipped ${plural(r.duplicates, 'transaction')} already imported.`)
    if (r.categorized) lines.push(`${plural(r.categorized, 'transaction')} categorized by rules or past choices.`)
    if (r.matched) lines.push(`${plural(r.matched, 'transaction')} match${r.matched === 1 ? 'es' : ''} entries already in the books.`)
    void dialogs.alert(lines.join('\n'), 'Import complete')
  }

  const ruleFrom = (t: BankTransaction): BankRuleInput => ({
    // Drop reference numbers so the rule catches the next one too.
    contains: t.description.replace(/[#*]?\s*\S*\d\S*/g, ' ').replace(/\s+/g, ' ').trim() || t.description,
    direction: t.amount < 0 ? 'out' : 'in',
    categoryId: t.categoryId ?? 0,
    payee: t.payee !== t.description ? t.payee : ''
  })

  const amountCells = (t: BankTransaction): JSX.Element => (
    <>
      <td className="num nowrap">{t.amount < 0 ? formatMoney(-t.amount) : ''}</td>
      <td className="num nowrap">{t.amount > 0 ? formatMoney(t.amount) : ''}</td>
    </>
  )

  const categoryCell = (t: BankTransaction): JSX.Element => {
    if (t.match && !t.ignoreMatch) {
      return (
        <div className="match-cell">
          <span className="badge match">Match</span> {formatDate(t.match.date)}
          {t.match.ref && ` · #${t.match.ref}`} · {t.match.memo || 'Journal entry'}
          <div>
            <button className="link small" onClick={() => nav.push({ name: 'entry', id: t.match!.entryId })}>
              View
            </button>{' '}
            <button className="link small" onClick={() => patch([t.id], { ignoreMatch: true })} title="Add this as a new transaction instead">
              Don't match
            </button>
          </div>
        </div>
      )
    }
    return (
      <div className="category-cell">
        <AccountSelect
          accounts={categories}
          value={t.categoryId}
          blankLabel="Uncategorized"
          className={t.categoryId === null ? 'uncategorized' : ''}
          onChange={(id) => patch([t.id], { categoryId: id })}
        />
        {t.categorySource === 'rule' && <span className="badge" title="Set by a bank rule">rule</span>}
        {t.categorySource === 'history' && <span className="badge" title="Same as last time for this payee">suggested</span>}
        {t.match && t.ignoreMatch && (
          <button className="link small" onClick={() => patch([t.id], { ignoreMatch: false })}>
            Match instead
          </button>
        )}
      </div>
    )
  }

  if (feedAccounts.length === 0 && accounts.length > 0) {
    return (
      <div className="page">
        <h1>Bank Feeds</h1>
        <p>Add a bank or credit card account to the chart of accounts first.</p>
        <button onClick={() => nav.go({ name: 'accounts' })}>Chart of accounts</button>
      </div>
    )
  }

  const colSpan = tab === 'review' ? 11 : tab === 'done' ? 9 : 7

  return (
    <div className="page bank-page">
      <div className="page-header">
        <h1>Bank Feeds</h1>
        <div className="toolbar">
          <AccountSelect accounts={feedAccounts} value={feedId} onChange={setFeedId} className="narrow" aria-label="Account" />
          <button className="primary" disabled={!feed} onClick={() => setImporting(true)}>
            Import CSV file…
          </button>
          <button onClick={() => setRules({})}>Rules…</button>
          <button disabled={!feed} onClick={() => setEditingWatch(true)}>
            {watch ? 'Watched folder…' : 'Watch a folder…'}
          </button>
          {tab === 'review' && (
            <button disabled={busy || counts.review === 0} onClick={applyRules} title="Categorize waiting items using your rules and past choices">
              Apply rules
            </button>
          )}
        </div>
      </div>

      {watch && (
        <div className="info-banner watch-banner">
          <span>
            Watching <strong>{watch.folder}</strong> for new statements.{' '}
            {watch.autoAccept ? 'Transactions covered by a rule or a match are added automatically.' : 'New transactions wait here for review.'}
          </span>
          <button
            className="link"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const n = await api.checkWatchFolders()
                if (n === 0) void dialogs.alert('No new files in the watched folder.', 'Watched folder')
              })
            }
          >
            Check now
          </button>
        </div>
      )}

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.tab} className={tab === t.tab ? 'active' : ''} onClick={() => setTab(t.tab)}>
            {t.label} <span className="count">{counts[t.tab]}</span>
          </button>
        ))}
      </div>

      <div className="toolbar filters">
        <input type="search" placeholder="Search description, payee, memo or amount" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)} aria-label="Show">
          <option value="all">Money in and out</option>
          <option value="out">Money out</option>
          <option value="in">Money in</option>
        </select>
        {tab === 'review' && (
          <label className="checkbox">
            <input type="checkbox" checked={uncategorized} onChange={(e) => setUncategorized(e.target.checked)} />
            Uncategorized only
          </label>
        )}
        <span className="muted small">{visible.length === txs.length ? plural(txs.length, 'transaction') : `${visible.length} of ${txs.length} shown`}</span>
      </div>

      {selected.length > 0 && (
        <div className="bulk-bar">
          <div className="bulk-summary">
            <strong>{selected.length} selected</strong>
            <span className="muted small">
              {spent > 0 && `spent ${formatMoney(spent)}`}
              {spent > 0 && received > 0 && ' · '}
              {received > 0 && `received ${formatMoney(received)}`}
            </span>
            <button className="link small" onClick={() => setChecked(new Set())}>
              Clear
            </button>
          </div>
          {tab === 'review' && (
            <>
              <div className="bulk-edit">
                <AccountSelect accounts={categories} value={bulkCategory} onChange={setBulkCategory} blankLabel="Category…" aria-label="Category for selected" />
                <input placeholder="Payee…" value={bulkPayee} onChange={(e) => setBulkPayee(e.target.value)} aria-label="Payee for selected" />
                <input placeholder="Memo…" value={bulkMemo} onChange={(e) => setBulkMemo(e.target.value)} aria-label="Memo for selected" />
                <button disabled={busy || (bulkCategory === null && !bulkPayee.trim() && !bulkMemo.trim())} onClick={applyBulk}>
                  Apply to {selected.length}
                </button>
              </div>
              <div className="bulk-actions">
                {selected.length === 1 && <button onClick={() => setRules({ initial: ruleFrom(selected[0]) })}>Create rule…</button>}
                <button disabled={busy} onClick={() => exclude(selectedIds, true)}>
                  Exclude
                </button>
                <button className="danger-outline" disabled={busy} onClick={() => void remove(selectedIds)}>
                  Delete
                </button>
                <button className="primary" disabled={busy} onClick={() => void accept(selectedIds)}>
                  Add / match {selected.length}
                </button>
              </div>
            </>
          )}
          {tab === 'done' && (
            <div className="bulk-actions">
              <button disabled={busy} onClick={() => void undo(selectedIds)}>
                Undo {selected.length}
              </button>
            </div>
          )}
          {tab === 'excluded' && (
            <div className="bulk-actions">
              <button className="danger-outline" disabled={busy} onClick={() => void remove(selectedIds)}>
                Delete
              </button>
              <button disabled={busy} onClick={() => exclude(selectedIds, false)}>
                Restore {selected.length}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="bank-scroll">
        <table className="grid bank-grid">
          <thead>
            <tr>
              <th style={{ width: 28 }}>
                <input
                  type="checkbox"
                  aria-label="Select all shown"
                  checked={allChecked}
                  onChange={() => setChecked(allChecked ? new Set() : new Set(visible.map((t) => t.id)))}
                />
              </th>
              <th>Date</th>
              <th>Ref</th>
              <th>Bank description</th>
              {tab !== 'excluded' && <th>Payee</th>}
              {tab === 'review' && <th>Category or match</th>}
              {tab === 'review' && <th>Memo</th>}
              {tab === 'done' && <th>Added to</th>}
              <th className="num">Spent</th>
              <th className="num">Received</th>
              <th title="Receipts">📎</th>
              {tab !== 'excluded' && <th />}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={colSpan} className="muted empty">
                  {txs.length > 0
                    ? 'No transactions match the filters.'
                    : tab === 'review'
                      ? 'Nothing to review. Import a CSV file downloaded from the bank to get started.'
                      : tab === 'done'
                        ? 'Nothing added yet.'
                        : 'Nothing excluded.'}
                </td>
              </tr>
            )}
            {visible.map((t, i) => (
              <tr key={t.id} className={checked.has(t.id) ? 'selected' : ''}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${t.description}`}
                    checked={checked.has(t.id)}
                    onChange={() => undefined}
                    onClick={(e) => toggle(i, e.shiftKey)}
                  />
                </td>
                <td className="nowrap">{formatDate(t.date)}</td>
                <td>{t.ref}</td>
                <td className="description">
                  {t.description}
                  {t.bankMemo && <div className="muted small">{t.bankMemo}</div>}
                </td>
                {tab === 'review' && (
                  <>
                    <td>
                      <TextCell value={t.payee} onSave={(v) => patch([t.id], { payee: v })} />
                    </td>
                    <td>{categoryCell(t)}</td>
                    <td>
                      <TextCell value={t.memo} placeholder="Memo" onSave={(v) => patch([t.id], { memo: v })} />
                    </td>
                  </>
                )}
                {tab === 'done' && (
                  <>
                    <td>{t.payee}</td>
                    <td>
                      {t.status === 'matched' ? <span className="badge match">Matched</span> : names.get(t.categoryId ?? -1) ?? ''}
                    </td>
                  </>
                )}
                {amountCells(t)}
                <td>
                  <button
                    className={`paperclip-button ${t.attachmentCount ? 'has' : ''}`}
                    title={t.attachmentCount ? `${t.attachmentCount} receipt${t.attachmentCount === 1 ? '' : 's'}. Click to view or add.` : 'Attach a receipt'}
                    onClick={() => setReceiptsFor(t)}
                  >
                    📎{t.attachmentCount > 0 ? ` ${t.attachmentCount}` : ''}
                  </button>
                </td>
                {tab === 'review' && (
                  <td className="right">
                    <button
                      className="small"
                      disabled={busy || (t.categoryId === null && !(t.match && !t.ignoreMatch))}
                      title={t.categoryId === null && !t.match ? 'Choose a category first' : undefined}
                      onClick={() => void accept([t.id])}
                    >
                      {t.match && !t.ignoreMatch ? 'Match' : 'Add'}
                    </button>
                  </td>
                )}
                {tab === 'done' && (
                  <td className="right nowrap">
                    {t.entryId !== null && (
                      <button className="link small" onClick={() => nav.push({ name: 'entry', id: t.entryId! })}>
                        Open entry
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {importing && feed && <CsvImport account={feed} onClose={() => setImporting(false)} onImported={imported} />}
      {receiptsFor && (
        <AttachmentsDialog
          title={`Receipts: ${receiptsFor.payee} · ${formatDate(receiptsFor.date)} · ${formatMoney(Math.abs(receiptsFor.amount))}`}
          target={{ bankTxId: receiptsFor.id }}
          onClose={() => setReceiptsFor(null)}
          onChange={nav.changed}
        />
      )}
      {editingWatch && feed && (
        <WatchFolderDialog
          account={feed}
          current={watch}
          onClose={() => setEditingWatch(false)}
          onSaved={() => {
            setEditingWatch(false)
            nav.changed()
          }}
        />
      )}
      {rules && <BankRules accounts={accounts} initial={rules.initial} onClose={() => setRules(null)} onChanged={nav.changed} />}
    </div>
  )
}
