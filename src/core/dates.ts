// Dates are ISO strings (YYYY-MM-DD) everywhere so they sort and compare as text.

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/

export function isValidDate(s: string): boolean {
  const m = ISO.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
}

export function assertDate(s: string, label = 'Date'): void {
  if (!isValidDate(s)) throw new Error(`${label} must be a valid date (YYYY-MM-DD)`)
}

function parts(s: string): [number, number, number] {
  const m = ISO.exec(s)
  if (!m) throw new Error(`Invalid date: ${s}`)
  return [+m[1], +m[2], +m[3]]
}

export function toIso(y: number, m: number, d: number): string {
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.toISOString().slice(0, 10)
}

export function addDays(s: string, days: number): string {
  const [y, m, d] = parts(s)
  return toIso(y, m, d + days)
}

export function today(): string {
  const now = new Date()
  return toIso(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

/** First day of the fiscal year containing `date`, given the month (1-12) the fiscal year starts. */
export function fiscalYearStart(date: string, startMonth: number): string {
  const [y, m] = parts(date)
  return toIso(m >= startMonth ? y : y - 1, startMonth, 1)
}

export function fiscalYearEnd(date: string, startMonth: number): string {
  const start = fiscalYearStart(date, startMonth)
  const [y, m] = parts(start)
  return toIso(y + 1, m, 0)
}

export interface DateRange {
  from: string
  to: string
}

export type RangePreset =
  | 'thisMonth'
  | 'lastMonth'
  | 'thisQuarter'
  | 'lastQuarter'
  | 'thisFiscalYear'
  | 'lastFiscalYear'
  | 'thisFiscalYearToDate'

export function presetRange(preset: RangePreset, ref: string, fyStartMonth: number): DateRange {
  const [y, m] = parts(ref)
  switch (preset) {
    case 'thisMonth':
      return { from: toIso(y, m, 1), to: toIso(y, m + 1, 0) }
    case 'lastMonth':
      return { from: toIso(y, m - 1, 1), to: toIso(y, m, 0) }
    case 'thisQuarter': {
      const q = Math.floor((m - 1) / 3) * 3 + 1
      return { from: toIso(y, q, 1), to: toIso(y, q + 3, 0) }
    }
    case 'lastQuarter': {
      const q = Math.floor((m - 1) / 3) * 3 + 1
      return { from: toIso(y, q - 3, 1), to: toIso(y, q, 0) }
    }
    case 'thisFiscalYear':
      return { from: fiscalYearStart(ref, fyStartMonth), to: fiscalYearEnd(ref, fyStartMonth) }
    case 'thisFiscalYearToDate':
      return { from: fiscalYearStart(ref, fyStartMonth), to: ref }
    case 'lastFiscalYear': {
      const prev = addDays(fiscalYearStart(ref, fyStartMonth), -1)
      return { from: fiscalYearStart(prev, fyStartMonth), to: prev }
    }
  }
}

/** The same range shifted back one year, used for prior-year comparison columns. */
export function priorYear(range: DateRange): DateRange {
  const shift = (s: string): string => {
    const [y, m, d] = parts(s)
    // Clamp Feb 29 to Feb 28.
    const last = new Date(Date.UTC(y - 1, m, 0)).getUTCDate()
    return toIso(y - 1, m, Math.min(d, last))
  }
  return { from: shift(range.from), to: shift(range.to) }
}

/** The period of equal length immediately before the range. */
export function priorPeriod(range: DateRange): DateRange {
  const [fy, fm, fd] = parts(range.from)
  const [ty, tm, td] = parts(range.to)
  // Whole months: shift by the same number of months.
  const lastOfTo = new Date(Date.UTC(ty, tm, 0)).getUTCDate()
  if (fd === 1 && td === lastOfTo) {
    const months = (ty - fy) * 12 + (tm - fm) + 1
    return { from: toIso(fy, fm - months, 1), to: toIso(fy, fm, 0) }
  }
  const days = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000)
  const to = addDays(range.from, -1)
  return { from: addDays(to, -days), to }
}

export function formatDate(s: string): string {
  const [y, m, d] = parts(s)
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`
}

export function formatLongDate(s: string): string {
  const [y, m, d] = parts(s)
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ]
  return `${months[m - 1]} ${d}, ${y}`
}
