import { useEffect, useState } from 'react'
import { api } from '../api'
import { AccountSelect } from './inputs'
import { Modal, useDialogs } from './Dialogs'
import type { Account, BankRule, BankRuleInput } from '../../../shared/types'

const DIRECTIONS: { value: BankRuleInput['direction']; label: string }[] = [
  { value: 'any', label: 'Money in or out' },
  { value: 'out', label: 'Money out only' },
  { value: 'in', label: 'Money in only' }
]

const blank = (): BankRuleInput => ({ contains: '', direction: 'any', categoryId: 0, payee: '' })

/**
 * Bank rules: "when the description contains X, categorize to Y". They fill
 * in categories as files are imported, for every bank and card account.
 */
export function BankRules({
  accounts,
  initial,
  onClose,
  onChanged
}: {
  accounts: Account[]
  /** Starts a new rule with these values, e.g. from a selected transaction. */
  initial?: BankRuleInput
  onClose: () => void
  onChanged: () => void
}): JSX.Element {
  const dialogs = useDialogs()
  const [rules, setRules] = useState<BankRule[]>([])
  const [editing, setEditing] = useState<{ id: number | null; input: BankRuleInput } | null>(initial ? { id: null, input: initial } : null)

  const load = (): void => void api.listBankRules().then(setRules).catch(dialogs.error)
  useEffect(load, [dialogs])

  const names = new Map(accounts.map((a) => [a.id, a.fullName]))
  const active = accounts.filter((a) => a.isActive)

  const save = async (): Promise<void> => {
    if (!editing) return
    try {
      await api.saveBankRule(editing.id, editing.input)
      setEditing(null)
      load()
      onChanged()
    } catch (err) {
      dialogs.error(err)
    }
  }

  const remove = async (rule: BankRule): Promise<void> => {
    if (!(await dialogs.confirm(`Delete the rule for "${rule.contains}"?`, { okLabel: 'Delete', danger: true }))) return
    await api.deleteBankRule(rule.id).catch(dialogs.error)
    load()
    onChanged()
  }

  const set = (patch: Partial<BankRuleInput>): void => setEditing((e) => (e ? { ...e, input: { ...e.input, ...patch } } : e))

  return (
    <Modal
      title="Bank rules"
      wide
      onClose={onClose}
      footer={
        editing ? (
          <>
            <button onClick={() => setEditing(null)}>Cancel</button>
            <button className="primary" onClick={save}>
              Save rule
            </button>
          </>
        ) : (
          <>
            <button onClick={() => setEditing({ id: null, input: blank() })}>New rule</button>
            <button className="primary" onClick={onClose}>
              Done
            </button>
          </>
        )
      }
    >
      {editing ? (
        <div className="form">
          <label>
            When the bank description contains
            <input autoFocus value={editing.input.contains} onChange={(e) => set({ contains: e.target.value })} placeholder="e.g. BLUE BOTTLE" />
          </label>
          <div className="row">
            <label>
              For
              <select value={editing.input.direction} onChange={(e) => set({ direction: e.target.value as BankRuleInput['direction'] })}>
                {DIRECTIONS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Categorize to
              <AccountSelect accounts={active} value={editing.input.categoryId || null} onChange={(id) => set({ categoryId: id ?? 0 })} />
            </label>
          </div>
          <label>
            Rename the payee to (optional)
            <input value={editing.input.payee} onChange={(e) => set({ payee: e.target.value })} placeholder="e.g. Blue Bottle Coffee" />
          </label>
          <p className="muted small">Rules apply to new imports into any account. Use "Apply rules" to update items already waiting for review.</p>
        </div>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Description contains</th>
              <th>For</th>
              <th>Categorize to</th>
              <th>Payee</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  No rules yet. Rules categorize recurring payees automatically when you import.
                </td>
              </tr>
            )}
            {rules.map((r) => (
              <tr key={r.id}>
                <td>{r.contains}</td>
                <td>{DIRECTIONS.find((d) => d.value === r.direction)?.label}</td>
                <td>{names.get(r.categoryId) ?? '?'}</td>
                <td>{r.payee}</td>
                <td className="right nowrap">
                  <button className="link small" onClick={() => setEditing({ id: r.id, input: { ...r } })}>
                    Edit
                  </button>{' '}
                  <button className="link small" onClick={() => void remove(r)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  )
}
