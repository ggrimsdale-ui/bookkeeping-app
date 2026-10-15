import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { Modal, useDialogs } from '../components/Dialogs'
import { AccountSelect, MoneyInput } from '../components/inputs'
import { ACCOUNT_TYPES, TYPE_ORDER, fiscalYearStart, formatMoney, isProfitAndLoss, today } from '../format'
import type { Nav } from '../nav'
import type { Account, AccountInput, AccountType } from '../../../shared/types'

export function Accounts({ nav }: { nav: Nav }): JSX.Element {
  const dialogs = useDialogs()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [balances, setBalances] = useState<Record<number, number>>({})
  const [showInactive, setShowInactive] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const [editing, setEditing] = useState<Account | 'new' | null>(null)
  const [openingBalances, setOpeningBalances] = useState(false)
  const [fyStartMonth, setFyStartMonth] = useState(1)

  useEffect(() => {
    void Promise.all([api.listAccounts(), api.accountBalances(today()), api.current()]).then(([a, b, c]) => {
      setAccounts(a)
      setBalances(b)
      setFyStartMonth(c?.info.fiscalYearStartMonth ?? 1)
    })
  }, [nav.version])

  const visible = accounts.filter((a) => showInactive || a.isActive)
  const current = accounts.find((a) => a.id === selected) ?? null

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
      nav.changed()
    } catch (err) {
      dialogs.error(err)
    }
  }

  const openDetail = (a: Account): void => {
    const to = today()
    nav.push({
      name: 'report',
      params: {
        kind: 'generalLedger',
        accountIds: [a.id],
        periods: [{ label: 'Total', from: fiscalYearStart(to, fyStartMonth), to }]
      }
    })
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Chart of Accounts</h1>
        <div className="toolbar">
          <button className="primary" onClick={() => setEditing('new')}>
            New account
          </button>
          <button disabled={!current} onClick={() => current && setEditing(current)}>
            Edit
          </button>
          <button disabled={!current} onClick={() => current && openDetail(current)}>
            Account detail
          </button>
          <button
            disabled={!current || !!current.system}
            onClick={() => current && run(() => api.setAccountActive(current.id, !current.isActive))}
          >
            {current && !current.isActive ? 'Make active' : 'Make inactive'}
          </button>
          <button
            disabled={!current || !!current.system}
            onClick={async () => {
              if (!current) return
              if (await dialogs.confirm(`Delete ${current.fullName}?`, { danger: true, okLabel: 'Delete' })) {
                await run(() => api.deleteAccount(current.id))
                setSelected(null)
              }
            }}
          >
            Delete
          </button>
          <button onClick={() => setOpeningBalances(true)}>Opening balances…</button>
          <label className="checkbox">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
        </div>
      </div>

      <table className="grid accounts">
        <thead>
          <tr>
            <th>Account</th>
            <th>Type</th>
            <th className="num">Balance</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((a) => (
            <tr
              key={a.id}
              className={`clickable ${a.id === selected ? 'selected' : ''} ${a.isActive ? '' : 'inactive'}`}
              onClick={() => setSelected(a.id)}
              onDoubleClick={() => setEditing(a)}
            >
              <td style={{ paddingLeft: 8 + a.depth * 20 }}>
                {a.number && <span className="acct-number">{a.number}</span>}
                {a.name}
                {!a.isActive && <span className="badge">inactive</span>}
              </td>
              <td>{ACCOUNT_TYPES[a.type].label}</td>
              <td className="num">
                {isProfitAndLoss(a.type) ? (
                  <span className="muted small" title="Fiscal year to date">
                    {formatMoney(balances[a.id] ?? 0)}
                  </span>
                ) : (
                  formatMoney(balances[a.id] ?? 0)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Income and expense balances are fiscal year to date. Double-click an account to edit it.</p>

      {editing && (
        <AccountDialog
          account={editing === 'new' ? null : editing}
          accounts={accounts}
          onClose={() => setEditing(null)}
          onSaved={(a) => {
            setEditing(null)
            setSelected(a.id)
            nav.changed()
          }}
        />
      )}
      {openingBalances && (
        <OpeningBalancesDialog
          accounts={accounts}
          onClose={() => setOpeningBalances(false)}
          onSaved={() => {
            setOpeningBalances(false)
            nav.changed()
          }}
        />
      )}
    </div>
  )
}

function AccountDialog({
  account,
  accounts,
  onClose,
  onSaved
}: {
  account: Account | null
  accounts: Account[]
  onClose: () => void
  onSaved: (a: Account) => void
}): JSX.Element {
  const dialogs = useDialogs()
  const [input, setInput] = useState<AccountInput>(
    account
      ? { number: account.number, name: account.name, type: account.type, parentId: account.parentId, description: account.description }
      : { number: '', name: '', type: 'Expense', parentId: null, description: '' }
  )
  const [isSub, setIsSub] = useState(account?.parentId != null)
  const parents = accounts.filter((a) => a.type === input.type && a.id !== account?.id)

  const save = async (): Promise<void> => {
    try {
      const clean = { ...input, parentId: isSub ? input.parentId : null }
      if (isSub && clean.parentId === null) throw new Error('Choose the parent account.')
      onSaved(account ? await api.updateAccount(account.id, clean) : await api.createAccount(clean))
    } catch (err) {
      dialogs.error(err)
    }
  }

  return (
    <Modal
      title={account ? 'Edit account' : 'New account'}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="form">
        <label>
          Account type
          <select
            value={input.type}
            disabled={!!account?.system}
            onChange={(e) => setInput({ ...input, type: e.target.value as AccountType, parentId: null })}
          >
            {TYPE_ORDER.map((t) => (
              <option key={t} value={t}>
                {ACCOUNT_TYPES[t].label}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <label style={{ flex: '0 0 120px' }}>
            Number
            <input value={input.number} onChange={(e) => setInput({ ...input, number: e.target.value })} />
          </label>
          <label>
            Name
            <input autoFocus value={input.name} onChange={(e) => setInput({ ...input, name: e.target.value })} />
          </label>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={isSub} onChange={(e) => setIsSub(e.target.checked)} />
          Subaccount of
        </label>
        {isSub && (
          <AccountSelect accounts={parents} value={input.parentId} onChange={(id) => setInput({ ...input, parentId: id })} />
        )}
        <label>
          Description
          <input value={input.description} onChange={(e) => setInput({ ...input, description: e.target.value })} />
        </label>
      </div>
    </Modal>
  )
}

function OpeningBalancesDialog({
  accounts,
  onClose,
  onSaved
}: {
  accounts: Account[]
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const dialogs = useDialogs()
  const eligible = useMemo(
    () => accounts.filter((a) => a.isActive && !isProfitAndLoss(a.type) && a.system !== 'openingBalanceEquity'),
    [accounts]
  )
  const [date, setDate] = useState(today())
  const [amounts, setAmounts] = useState<Record<number, number>>({})

  const save = async (): Promise<void> => {
    try {
      const balances = Object.entries(amounts).map(([id, amount]) => ({ accountId: Number(id), amount }))
      await dialogs.guarded((override) => api.enterOpeningBalances(date, balances, override))
      onSaved()
    } catch (err) {
      dialogs.error(err)
    }
  }

  return (
    <Modal
      title="Enter opening balances"
      wide
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>
            Record opening balances
          </button>
        </>
      }
    >
      <p className="muted small">
        Enter each balance as of the conversion date, as it appears on the prior balance sheet (positive for normal balances).
        The difference goes to Opening Balance Equity. This creates one journal entry you can edit later.
      </p>
      <label className="inline">
        Balances as of <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <div className="scroll-box">
        <table className="grid">
          <tbody>
            {eligible.map((a) => (
              <tr key={a.id}>
                <td style={{ paddingLeft: 8 + a.depth * 20 }}>{a.fullName}</td>
                <td className="muted small">{ACCOUNT_TYPES[a.type].label}</td>
                <td style={{ width: 160 }}>
                  <MoneyInput allowNegative value={amounts[a.id] ?? 0} onChange={(v) => setAmounts({ ...amounts, [a.id]: v })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}
