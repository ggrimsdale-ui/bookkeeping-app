// All amounts are stored and computed as integer cents. Never use floats for totals.

export type Cents = number

export function parseMoney(input: string | number | null | undefined): Cents {
  if (input === null || input === undefined) return 0
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('Invalid amount')
    return Math.round(input * 100)
  }
  let s = input.trim()
  if (s === '') return 0
  let negative = false
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true
    s = s.slice(1, -1)
  }
  s = s.replace(/[$,\s]/g, '')
  if (s.startsWith('-')) {
    negative = !negative
    s = s.slice(1)
  }
  if (!/^\d*(\.\d{0,2})?$/.test(s) || s === '' || s === '.') {
    throw new Error(`"${input}" is not a valid amount`)
  }
  const [whole, frac = ''] = s.split('.')
  const cents = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2))
  return negative ? -cents : cents
}

export function formatMoney(cents: Cents, opts: { blankZero?: boolean; parens?: boolean } = {}): string {
  if (opts.blankZero && cents === 0) return ''
  const negative = cents < 0
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const text = `${whole}.${String(abs % 100).padStart(2, '0')}`
  if (!negative) return text
  return opts.parens ? `(${text})` : `-${text}`
}

/** Cents to a plain decimal number for spreadsheet export. */
export function centsToNumber(cents: Cents): number {
  return cents / 100
}
