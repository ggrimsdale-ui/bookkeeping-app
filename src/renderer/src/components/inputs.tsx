import { useEffect, useState } from 'react'
import { formatMoney, parseMoney } from '../format'
import type { Account } from '../../../shared/types'

/** Text input for an amount in cents. Accepts "1,234.56", "$12", "(5.00)". */
export function MoneyInput({
  value,
  onChange,
  allowNegative = false,
  ...rest
}: {
  value: number
  onChange: (cents: number) => void
  allowNegative?: boolean
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>): JSX.Element {
  const [text, setText] = useState(value ? formatMoney(value) : '')
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    // Sync when the value changes from outside (e.g. the line was cleared).
    setText((current) => {
      try {
        if (parseMoney(current) === value) return current
      } catch {
        // fall through
      }
      return value ? formatMoney(value) : ''
    })
  }, [value])

  return (
    <input
      {...rest}
      className={`num ${invalid ? 'invalid' : ''} ${rest.className ?? ''}`}
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        try {
          const cents = parseMoney(e.target.value)
          if (cents < 0 && !allowNegative) throw new Error()
          setInvalid(false)
          onChange(cents)
        } catch {
          setInvalid(true)
        }
      }}
      onBlur={(e) => {
        if (!invalid) setText(value ? formatMoney(value) : '')
        rest.onBlur?.(e)
      }}
    />
  )
}

export function AccountSelect({
  accounts,
  value,
  onChange,
  blankLabel = 'Choose an account…',
  ...rest
}: {
  accounts: Account[]
  value: number | null
  onChange: (id: number | null) => void
  blankLabel?: string
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'>): JSX.Element {
  return (
    <select {...rest} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{blankLabel}</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id} disabled={!a.isActive && a.id !== value}>
          {'  '.repeat(a.depth)}
          {a.number ? `${a.number} · ` : ''}
          {a.name}
          {a.isActive ? '' : ' (inactive)'}
        </option>
      ))}
    </select>
  )
}
