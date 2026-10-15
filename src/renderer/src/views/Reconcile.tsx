import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useDialogs } from '../components/Dialogs'
import { AccountSelect, MoneyInput } from '../components/inputs'
import { formatDate, formatMoney, isDebitNormal, isProfitAndLoss, today } from '../format'
import type { Nav } from '../nav'
import type { Account, ReconcileItem, ReconcileSession, Reconciliation, StatementCharge } from '../../../shared/types'

function reconciliationReport(nav: Nav, r: Reconciliation): void {
  nav.push({
    name: 'report',
    params: { kind: 'reconciliation', reconciliationId: r.id, periods: [{ label: 'Total', from: r.statementDate, to: r.statementDate }] }
  })
}

const blankCharge = (): StatementCharge => ({ date: today(), amount: 0, accountId: null })

/** Step 1: choose the account and enter the statement details, like QuickBooks' Begin Reconciliation window. */
export function ReconcileStart({ nav, accountId }: { nav: Nav; accountId?: number }): JSX.Element {
  const dialogs = useDialogs()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [selected, setSelected] = useState<number | null>(accountId ?? null)
  const [session, setSession] = useState<ReconcileSession | null>(null)
  const [history, setHistory] = useState<Reconciliation[]>([])
  const [statementDate, setStatementDate] = useState(today())
  const [endingBalance, setEndingBalance] = useState(0)
  const [serviceCharge, setServiceCharge] = useState<StatementCharge>(blankCharge)
  const [interest, setInterest] = useState<StatementCharge>(blankCharge)

  useEffect(() => {
    void api.listAccounts().then((all) => {
      setAccounts(all)
      if (selected === null) {
        const firstBank = all.find((a) => a.type === 'Bank' && a.isActive)
        if (firstBank) setSelected(firstBank.id)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav.version])

  useEffect(() => {
    if (selected === null) return
    void Promise.all([api.reconcileSession(selected), api.listReconciliations(selected)]).then(([s, h]) => {
      setSession(s)
      setHistory(h)
      const date = s.draft?.statementDate ?? today()
      setStatementDate(date)
      setEndingBalance(s.draft?.endingBalance ?? 0)
      setServiceCharge({ ...blankCharge(), date })
      setInterest({ ...blankCharge(), date })
    })
  }, [selected, nav.version])

  const reconcilable = accounts.filter((a) => !isProfitAndLoss(a.type) && (a.isActive || a.id === selected))
  const expenseAccounts = accounts.filter((a) => (a.type === 'Expense' || a.type === 'OtherExpense') && a.isActive)
  const incomeAccounts = accounts.filter((a) => (a.type === 'Income' || a.type === 'OtherIncome') && a.isActive)
  const liability = session ? !isDebitNormal(session.account.type) : false

  const proceed = async (): Promise<void> => {
    if (selected === null) return
    try {
      await dialogs.guarded((override) =>
        api.startReconcile(
          {
            accountId: selected,
            statementDate,
            endingBalance,
            serviceCharge: serviceCharge.amount ? serviceCharge : undefined,
            interest: interest.amount ? interest : undefined
          },
          override
        )
      )
      nav.changed()
      nav.push({ name: 'reconcileWork', accountId: selected })
    } catch (err) {
      dialogs.error(err)
    }
  }

  const discard = async (): Promise<void> => {
    if (selected === null) return
    if (!(await dialogs.confirm('Discard the reconciliation in progress? Your marks will be cleared.', { okLabel: 'Discard', danger: true }))) return
    await api.discardReconcile(selected).catch(dialogs.error)
    nav.changed()
  }

  const undo = async (): Promise<void> => {
    if (selected === null || history.length === 0) return
    const last = history[0]
    const ok = await dialogs.confirm(
      `Undo the reconciliation for the period ending ${formatDate(last.statementDate)}? Its transactions go back to uncleared. Any adjustment entry stays in the books.`,
      { okLabel: 'Undo reconciliation', danger: true }
    )
    if (!ok) return
    await api.undoLastReconciliation(selected).catch(dialogs.error)
    nav.changed()
  }

  return (
    <div className="page">
      <h1>Reconcile</h1>
      <div className="two-col reconcile-start">
        <section className="form">
          <h2>Begin reconciliation</h2>
          <label>
            Account
            <AccountSelect accounts={reconcilable} value={selected} onChange={setSelected} />
          </label>
          {session && (
            <>
              <div className="statement-facts">
                <span>Last reconciled</span>
                <strong>{session.lastReconciliation ? formatDate(session.lastReconciliation.statementDate) : 'Never'}</strong>
                <span>Beginning balance</span>
                <strong>{formatMoney(session.beginningBalance)}</strong>
              </div>
              {session.draft && (
                <div className="info-banner">
                  A reconciliation for the period ending {formatDate(session.draft.statementDate)} is in progress.{' '}
                  <button className="link" onClick={() => nav.push({ name: 'reconcileWork', accountId: session.account.id })}>
                    Resume it
                  </button>{' '}
                  or{' '}
                  <button className="link" onClick={discard}>
                    discard it
                  </button>
                  .
                </div>
              )}
              <div className="row">
                <label>
                  Statement date
                  <input
                    type="date"
                    value={statementDate}
                    onChange={(e) => {
                      // Statement charges are usually dated on the statement date.
                      setStatementDate(e.target.value)
                      setServiceCharge((c) => ({ ...c, date: e.target.value }))
                      setInterest((c) => ({ ...c, date: e.target.value }))
                    }}
                  />
                </label>
                <label>
                  Ending balance
                  <MoneyInput allowNegative value={endingBalance} onChange={setEndingBalance} />
                </label>
              </div>

              <h2>{liability ? 'Finance charge' : 'Service charge'}</h2>
              <ChargeFields charge={serviceCharge} onChange={setServiceCharge} accounts={expenseAccounts} />
              <h2>{liability ? 'Credits or refunds earned' : 'Interest earned'}</h2>
              <ChargeFields charge={interest} onChange={setInterest} accounts={incomeAccounts} />
              <p className="muted small">Charges and interest from the statement are recorded as journal entries and marked cleared.</p>
              <div className="buttons">
                <button className="primary" onClick={proceed}>
                  Continue
                </button>
              </div>
            </>
          )}
        </section>

        <section>
          <h2>Previous reconciliations</h2>
          <table className="grid">
            <thead>
              <tr>
                <th>Statement date</th>
                <th className="num">Ending balance</th>
                <th>Reconciled on</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {history.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    This account has not been reconciled yet.
                  </td>
                </tr>
              )}
              {history.map((r) => (
                <tr key={r.id}>
                  <td>{formatDate(r.statementDate)}</td>
                  <td className="num">{formatMoney(r.endingBalance)}</td>
                  <td>{formatDate(r.reconciledAt.slice(0, 10))}</td>
                  <td className="right">
                    <button className="link small" onClick={() => reconciliationReport(nav, r)}>
                      View report
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {history.length > 0 && (
            <div className="buttons">
              <button className="danger-outline" onClick={undo}>
                Undo last reconciliation
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function ChargeFields({
  charge,
  onChange,
  accounts
}: {
  charge: StatementCharge
  onChange: (c: StatementCharge) => void
  accounts: Account[]
}): JSX.Element {
  return (
    <div className="row">
      <label style={{ flex: '0 0 130px' }}>
        Amount
        <MoneyInput value={charge.amount} onChange={(amount) => onChange({ ...charge, amount })} />
      </label>
      <label style={{ flex: '0 0 150px' }}>
        Date
        <input type="date" value={charge.date} onChange={(e) => onChange({ ...charge, date: e.target.value })} />
      </label>
      <label>
        Account
        <AccountSelect accounts={accounts} value={charge.accountId} onChange={(accountId) => onChange({ ...charge, accountId })} />
      </label>
    </div>
  )
}

/** Step 2: tick off the transactions that appear on the statement until the difference is zero. */
export function ReconcileWork({ nav, accountId }: { nav: Nav; accountId: number }): JSX.Element {
  const dialogs = useDialogs()
  const [session, setSession] = useState<ReconcileSession | null>(null)
  const [hideAfter, setHideAfter] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.reconcileSession(accountId).then(setSession).catch(dialogs.error)
  }, [accountId, nav.version, dialogs])

  const draft = session?.draft
  const visible = useMemo(
    () => (session && draft ? session.items.filter((i) => !hideAfter || i.marked || i.date <= draft.statementDate) : []),
    [session, draft, hideAfter]
  )

  if (!session) return <div className="page">Loading…</div>
  if (!draft) {
    return (
      <div className="page">
        <h1>Reconcile</h1>
        <p>Enter the statement details first.</p>
        <button onClick={() => nav.go({ name: 'reconcile', accountId })}>Begin reconciliation</button>
      </div>
    )
  }

  const asset = isDebitNormal(session.account.type)
  const decreases = visible.filter((i) => i.amount < 0)
  const increases = visible.filter((i) => i.amount > 0)
  const marked = session.items.filter((i) => i.marked)
  const markedDecreases = marked.filter((i) => i.amount < 0)
  const markedIncreases = marked.filter((i) => i.amount > 0)
  const difference = draft.endingBalance - session.clearedBalance

  const mark = async (items: ReconcileItem[], value: boolean): Promise<void> => {
    const ids = items.filter((i) => i.marked !== value).map((i) => i.lineId)
    if (ids.length === 0) return
    // Update the screen right away, then take the totals from the saved file.
    const set = new Set(ids)
    setSession({ ...session, items: session.items.map((i) => (set.has(i.lineId) ? { ...i, marked: value } : i)) })
    try {
      setSession(await api.setReconcileMarked(accountId, ids, value))
    } catch (err) {
      dialogs.error(err)
      setSession(await api.reconcileSession(accountId))
    }
  }

  const finish = async (): Promise<void> => {
    let adjust = false
    if (difference !== 0) {
      adjust = await dialogs.confirm(
        `The cleared balance is off from the statement by ${formatMoney(Math.abs(difference))}.\n\n` +
          'Go back and look for missing or mistyped transactions, or enter an adjustment to the Reconciliation Discrepancies expense account for the difference.',
        { title: 'Reconciliation is out of balance', okLabel: 'Enter adjustment' }
      )
      if (!adjust) return
    }
    setBusy(true)
    try {
      const id = await dialogs.guarded((override) => api.finishReconcile(accountId, adjust, override))
      nav.changed()
      nav.go({
        name: 'report',
        params: { kind: 'reconciliation', reconciliationId: id, periods: [{ label: 'Total', from: draft.statementDate, to: draft.statementDate }] }
      })
    } catch (err) {
      dialogs.error(err)
    } finally {
      setBusy(false)
    }
  }

  const discard = async (): Promise<void> => {
    if (!(await dialogs.confirm('Discard this reconciliation? Your marks will be cleared.', { okLabel: 'Discard', danger: true }))) return
    await api.discardReconcile(accountId).catch(dialogs.error)
    nav.changed()
    nav.go({ name: 'reconcile', accountId })
  }

  const pane = (title: string, items: ReconcileItem[]): JSX.Element => (
    <section className="reconcile-pane">
      <div className="pane-header">
        <h2>{title}</h2>
        <span className="muted small">{items.length} shown</span>
      </div>
      <div className="pane-scroll">
        <table className="grid reconcile-items">
          <thead>
            <tr>
              <th style={{ width: 28 }}>
                <input
                  type="checkbox"
                  aria-label={`Mark all ${title}`}
                  checked={items.length > 0 && items.every((i) => i.marked)}
                  onChange={(e) => void mark(items, e.target.checked)}
                />
              </th>
              <th>Date</th>
              <th>Ref</th>
              <th>Memo</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  Nothing to clear.
                </td>
              </tr>
            )}
            {items.map((i) => (
              <tr
                key={i.lineId}
                className={`clickable ${i.marked ? 'marked' : ''}`}
                onClick={() => void mark([i], !i.marked)}
                onDoubleClick={() => nav.push({ name: 'entry', id: i.entryId })}
                title="Click to mark cleared. Double-click to open the entry."
              >
                <td>
                  <input type="checkbox" checked={i.marked} readOnly tabIndex={-1} />
                </td>
                <td className="nowrap">{formatDate(i.date)}</td>
                <td>{i.ref}</td>
                <td>{i.memo}</td>
                <td className="num">{formatMoney(Math.abs(i.amount))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )

  const sum = (items: ReconcileItem[]): number => items.reduce((s, i) => s + i.amount, 0)

  return (
    <div className="page reconcile-page">
      <div className="page-header">
        <h1>Reconcile {session.account.fullName}</h1>
        <div className="toolbar">
          <span>
            For the period ending <strong>{formatDate(draft.statementDate)}</strong>
          </span>
          <label className="checkbox">
            <input type="checkbox" checked={hideAfter} onChange={(e) => setHideAfter(e.target.checked)} />
            Hide transactions after the statement's end date
          </label>
          <button onClick={() => void mark(visible, true)}>Mark all</button>
          <button onClick={() => void mark(session.items, false)}>Unmark all</button>
        </div>
      </div>

      <div className="reconcile-panes">
        {pane(asset ? 'Checks and Payments' : 'Payments and Credits', decreases)}
        {pane(asset ? 'Deposits and Other Credits' : 'Charges and Cash Advances', increases)}
      </div>

      <div className="reconcile-summary">
        <div className="summary-col">
          <div>
            <span>Beginning balance</span>
            <span className="num">{formatMoney(session.beginningBalance)}</span>
          </div>
          <div className="muted">Items you have marked cleared</div>
          <div>
            <span>
              {markedIncreases.length} {asset ? 'deposits and other credits' : 'charges and cash advances'}
            </span>
            <span className="num">{formatMoney(sum(markedIncreases))}</span>
          </div>
          <div>
            <span>
              {markedDecreases.length} {asset ? 'checks and payments' : 'payments and credits'}
            </span>
            <span className="num">{formatMoney(Math.abs(sum(markedDecreases)))}</span>
          </div>
        </div>
        <div className="summary-col">
          <div>
            <span>Statement ending balance</span>
            <span className="num">{formatMoney(draft.endingBalance)}</span>
          </div>
          <div>
            <span>Cleared balance</span>
            <span className="num">{formatMoney(session.clearedBalance)}</span>
          </div>
          <div className={`difference ${difference === 0 ? 'ok' : 'warn'}`}>
            <span>Difference</span>
            <span className="num">{formatMoney(difference)}</span>
          </div>
        </div>
      </div>

      <div className="buttons">
        <button onClick={() => nav.go({ name: 'reconcile', accountId })}>Modify statement</button>
        <button className="danger-outline" onClick={discard}>
          Discard
        </button>
        <span className="spacer" />
        <button onClick={() => nav.go({ name: 'reconcile', accountId })} title="Keep your marks and come back later">
          Leave and finish later
        </button>
        <button className="primary" disabled={busy} onClick={finish}>
          Reconcile now
        </button>
      </div>
    </div>
  )
}
