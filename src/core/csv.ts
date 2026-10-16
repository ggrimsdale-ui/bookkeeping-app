// Reading bank statement CSV files. Banks lay their exports out in many
// different ways, so the file is parsed into plain rows first and the user
// confirms which column holds what (the mapping) before anything is imported.
// No Electron or database dependency: the UI uses this for the preview.

import { isValidDate } from './dates'

export type DateFormat = 'MDY' | 'DMY' | 'YMD'

export interface CsvMapping {
  /** Index of the header row, or -1 when the file has no header. Data starts on the next row. */
  headerRow: number
  dateCol: number
  dateFormat: DateFormat
  descriptionCol: number
  /** Extra text from the bank, kept with the transaction. */
  memoCol: number | null
  /** Check number or bank reference. */
  refCol: number | null
  /** 'signed': one amount column. 'split': separate money out and money in columns. */
  amountMode: 'signed' | 'split'
  amountCol: number | null
  /** The file shows money out (spending, card charges) as positive numbers. */
  flipSign: boolean
  outCol: number | null
  inCol: number | null
  /** Amounts are written like 1.234,56. */
  decimalComma: boolean
}

/** One transaction read from the file. `amount` is in cents: positive is money in, negative is money out. */
export interface BankRowInput {
  date: string
  description: string
  memo: string
  ref: string
  amount: number
}

export interface MappedCsv {
  rows: BankRowInput[]
  /** Data rows that could not be read, with 1-based line numbers. */
  skipped: { line: number; reason: string }[]
}

/** Picks the delimiter that splits the first lines into the most consistent number of columns. */
export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20)
  let best = ','
  let bestScore = -1
  for (const d of [',', ';', '\t', '|']) {
    const counts = sample.map((l) => splitLine(l, d).length)
    const max = Math.max(0, ...counts)
    if (max < 2) continue
    // Most lines having the same, larger number of columns wins.
    const agreeing = counts.filter((c) => c === max).length
    const score = agreeing * 100 + max
    if (score > bestScore) {
      bestScore = score
      best = d
    }
  }
  return best
}

function splitLine(line: string, delimiter: string): string[] {
  return parseCsv(line, delimiter)[0] ?? []
}

/** RFC 4180 parsing: quoted fields, doubled quotes, and line breaks inside quotes. Blank lines are dropped. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const endRow = (): void => {
    row.push(field)
    if (row.length > 1 || row[0].trim() !== '') rows.push(row.map((f) => f.trim()))
    row = []
    field = ''
  }
  while (i < text.length) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
    } else if (ch === '"' && field.trim() === '') {
      field = ''
      quoted = true
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      endRow()
    } else field += ch
    i++
  }
  if (field !== '' || row.length > 0) endRow()
  return rows
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function monthIndex(s: string): number {
  return MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1
}

function fullYear(y: number): number {
  return y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y
}

function iso(y: number, m: number, d: number): string | null {
  const s = `${String(fullYear(y)).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  return isValidDate(s) ? s : null
}

/** Reads a bank's date in the given order. Also accepts month names ("15 Jan 2026", "Jan 15, 2026") and 20260115. */
export function parseBankDate(input: string, format: DateFormat): string | null {
  // Drop a time part such as "01/15/2026 00:00:00" or "2026-01-15T00:00".
  const s = input.trim().replace(/[T\s]+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*([AaPp][Mm])?\s*(Z|[+-]\d{2}:?\d{2})?$/, '')
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
  if (m) return iso(+m[1], +m[2], +m[3])
  m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s)
  if (m) return iso(+m[1], +m[2], +m[3])
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s)
  if (m) {
    if (format === 'DMY') return iso(+m[3], +m[2], +m[1])
    return iso(+m[3], +m[1], +m[2])
  }
  m = /^(\d{1,2})[-\s/.]([A-Za-z]{3,9})\.?[-\s/.,]+(\d{2,4})$/.exec(s)
  if (m && monthIndex(m[2])) return iso(+m[3], monthIndex(m[2]), +m[1])
  m = /^([A-Za-z]{3,9})\.?[-\s/.]+(\d{1,2})(st|nd|rd|th)?,?[-\s/.]+(\d{2,4})$/.exec(s)
  if (m && monthIndex(m[1])) return iso(+m[4], monthIndex(m[1]), +m[2])
  return null
}

/** Chooses month-first or day-first from the dates in the file; a day over 12 settles it. Defaults to month-first. */
export function detectDateFormat(values: string[]): DateFormat {
  let mdy = 0
  let dmy = 0
  for (const v of values) {
    if (/^\d{4}/.test(v.trim())) return 'YMD'
    if (parseBankDate(v, 'MDY')) mdy++
    if (parseBankDate(v, 'DMY')) dmy++
  }
  return dmy > mdy ? 'DMY' : 'MDY'
}

/**
 * Reads an amount the way banks write them: "1,234.56", "$-12.00", "(12.00)",
 * "12.00 CR", "-€5,00" with decimal commas. Returns cents, or null when blank or unreadable.
 */
export function parseBankAmount(input: string, decimalComma = false): number | null {
  let s = input.trim()
  if (s === '') return null
  let negative = false
  const suffix = /\s*(CR|DR|-|\+)$/i.exec(s)
  if (suffix) {
    const tag = suffix[1].toUpperCase()
    if (tag === 'DR' || tag === '-') negative = true
    s = s.slice(0, suffix.index)
  }
  if (/^\(.*\)$/.test(s)) {
    negative = !negative
    s = s.slice(1, -1)
  }
  s = s.replace(/[^\d.,+-]/g, '')
  if (s.startsWith('+')) s = s.slice(1)
  if (s.startsWith('-')) {
    negative = !negative
    s = s.slice(1)
  }
  if (decimalComma) s = s.replace(/\./g, '').replace(',', '.')
  else s = s.replace(/,/g, '')
  if (!/^\d+(\.\d{1,2})?$|^\.\d{1,2}$/.test(s)) return null
  const [whole, frac = ''] = s.split('.')
  const cents = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2))
  return negative ? -cents : cents
}

const HEADER_HINT = /date|amount|description|debit|credit|payee|memo|balance|details|narrative|withdraw|deposit/i

/** The first row (within the first ten) that looks like column titles, or -1 when the file starts with data. */
export function detectHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const hits = rows[i].filter((c) => HEADER_HINT.test(c) && !parseBankDate(c, 'MDY') && parseBankAmount(c) === null).length
    if (hits >= 2) return i
  }
  // Titles in another language: a first row of plain text above rows that start with dates.
  const hasDate = (r: string[] | undefined): boolean => !!r?.some((c) => parseBankDate(c, 'MDY') || parseBankDate(c, 'DMY'))
  const numeric = (r: string[]): boolean => r.some((c) => parseBankAmount(c) !== null || parseBankAmount(c, true) !== null)
  if (rows.length > 1 && !hasDate(rows[0]) && !numeric(rows[0]) && hasDate(rows[1])) return 0
  return -1
}

/** Makes a first guess at which column is which from the header titles, or from the data when there is no header. */
export function guessMapping(rows: string[][], delimiter = ','): CsvMapping {
  const headerRow = detectHeaderRow(rows)
  const data = rows.slice(headerRow + 1, headerRow + 51)
  const width = Math.max(0, ...rows.slice(headerRow + 1).map((r) => r.length))
  const headers = headerRow >= 0 ? rows[headerRow].map((h) => h.toLowerCase()) : []
  const find = (re: RegExp, except: (number | null)[] = []): number | null => {
    const i = headers.findIndex((h, idx) => re.test(h) && !except.includes(idx))
    return i === -1 ? null : i
  }
  const column = (i: number): string[] => data.map((r) => r[i] ?? '').filter((v) => v !== '')
  const dateLike = (i: number): boolean => {
    const vals = column(i)
    return vals.length > 0 && vals.filter((v) => parseBankDate(v, 'MDY') || parseBankDate(v, 'DMY')).length >= vals.length * 0.8
  }
  const decimalComma =
    delimiter === ';' || data.some((r) => r.some((c) => /^-?[\d.]*\d,\d{2}$/.test(c) && !/^\d{1,3}(,\d{3})+$/.test(c)))
  const amountLike = (i: number): boolean => {
    const vals = column(i)
    return vals.length > 0 && !dateLike(i) && vals.every((v) => parseBankAmount(v, decimalComma) !== null)
  }

  let dateCol = find(/^(transaction |trans\.? |posting |post(ed)? |value )?date$/) ?? find(/date/)
  if (dateCol === null || !dateLike(dateCol)) {
    dateCol = [...Array(width).keys()].find(dateLike) ?? 0
  }
  const balanceCol = find(/balance/)
  let amountCol = find(/^amount|amount$|^amt$|value/, [dateCol, balanceCol])
  let outCol = find(/debit|withdraw|paid out|money out|spent|outflow|charge|payment/, [dateCol, amountCol, balanceCol])
  let inCol = find(/credit|deposit|paid in|money in|received|inflow/, [dateCol, amountCol, balanceCol, outCol])
  const refCol = find(/check|cheque|^ref|reference|^no\.?$|number|^num/, [dateCol, amountCol, outCol, inCol, balanceCol])
  // Most specific title first: some banks also have a "Details" column that just says DEBIT or CREDIT.
  let descriptionCol =
    find(/description/, [dateCol, refCol]) ??
    find(/payee|narrative|merchant|^name|particulars/, [dateCol, refCol]) ??
    find(/details|transaction$/, [dateCol, refCol])
  const memoCol = find(/memo|notes?|additional|extended/, [dateCol, descriptionCol, refCol])

  if (headerRow < 0 || (amountCol === null && (outCol === null || inCol === null))) {
    // Read the data: the first amount-like column is the amount (a running balance usually comes last).
    const numeric = [...Array(width).keys()].filter((i) => i !== dateCol && amountLike(i))
    amountCol = numeric[0] ?? null
    outCol = inCol = null
  }
  if (descriptionCol === null) {
    // The column with the longest text.
    let best = -1
    for (let i = 0; i < width; i++) {
      if (i === dateCol || i === amountCol || i === outCol || i === inCol) continue
      const len = column(i).reduce((s, v) => s + v.length, 0)
      if (len > best) {
        best = len
        descriptionCol = i
      }
    }
  }
  const split = amountCol === null && outCol !== null && inCol !== null
  return {
    headerRow,
    dateCol,
    dateFormat: detectDateFormat(column(dateCol)),
    descriptionCol: descriptionCol ?? 0,
    memoCol,
    refCol,
    amountMode: split ? 'split' : 'signed',
    amountCol: split ? null : amountCol,
    flipSign: false,
    outCol: split ? outCol : null,
    inCol: split ? inCol : null,
    decimalComma
  }
}

/** Turns the file's rows into transactions using the mapping. Rows without a readable date or amount are skipped. */
export function mapRows(rows: string[][], mapping: CsvMapping): MappedCsv {
  const result: MappedCsv = { rows: [], skipped: [] }
  const cell = (r: string[], i: number | null): string => (i === null ? '' : (r[i] ?? '').trim())
  rows.slice(mapping.headerRow + 1).forEach((r, i) => {
    const line = mapping.headerRow + i + 2
    const rawDate = cell(r, mapping.dateCol)
    const date = parseBankDate(rawDate, mapping.dateFormat)
    if (!date) {
      result.skipped.push({ line, reason: rawDate ? `"${rawDate}" is not a date` : 'no date' })
      return
    }
    let amount: number | null
    if (mapping.amountMode === 'split') {
      const out = parseBankAmount(cell(r, mapping.outCol), mapping.decimalComma)
      const into = parseBankAmount(cell(r, mapping.inCol), mapping.decimalComma)
      amount = out === null && into === null ? null : Math.abs(into ?? 0) - Math.abs(out ?? 0)
    } else {
      amount = parseBankAmount(cell(r, mapping.amountCol), mapping.decimalComma)
      if (amount !== null && mapping.flipSign) amount = -amount
    }
    if (amount === null) {
      result.skipped.push({ line, reason: 'no amount' })
      return
    }
    if (amount === 0) {
      result.skipped.push({ line, reason: 'amount is zero' })
      return
    }
    const description = cell(r, mapping.descriptionCol).replace(/\s+/g, ' ')
    const memo = mapping.memoCol === mapping.descriptionCol ? '' : cell(r, mapping.memoCol).replace(/\s+/g, ' ')
    result.rows.push({ date, description: description || memo || '(no description)', memo: description ? memo : '', ref: cell(r, mapping.refCol), amount })
  })
  return result
}

/** Name for a column in the mapping step: its header text, or a spreadsheet-style letter. */
export function columnLabel(rows: string[][], headerRow: number, i: number): string {
  const letter = i < 26 ? String.fromCharCode(65 + i) : `${String.fromCharCode(64 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`
  const title = headerRow >= 0 ? rows[headerRow]?.[i] : ''
  return title ? `${letter}: ${title}` : `Column ${letter}`
}

/** Decodes the file as UTF-8, falling back to Windows-1252, which many banks still use. */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}
