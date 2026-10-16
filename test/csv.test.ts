import { describe, expect, it } from 'vitest'
import { detectDelimiter, guessMapping, mapRows, parseBankAmount, parseBankDate, parseCsv } from '../src/core/csv'

describe('CSV parsing', () => {
  it('handles quotes, doubled quotes, line breaks in quotes and blank lines', () => {
    const text = '﻿Date,Description,Amount\r\n01/02/2026,"ACME, INC ""HQ""",-1.00\r\n\r\n01/03/2026,"two\nlines",2\n'
    expect(parseCsv(text)).toEqual([
      ['Date', 'Description', 'Amount'],
      ['01/02/2026', 'ACME, INC "HQ"', '-1.00'],
      ['01/03/2026', 'two\nlines', '2']
    ])
  })

  it('detects semicolon and tab delimiters', () => {
    expect(detectDelimiter('Date;Text;Amount\n02.01.2026;Rent;-1.000,00\n')).toBe(';')
    expect(detectDelimiter('Date\tText\tAmount\n2026-01-02\tRent\t-5\n')).toBe('\t')
    expect(detectDelimiter('Date,Text,Amount\n2026-01-02,"Smith; Jones",-5\n')).toBe(',')
  })

  it('reads the date formats banks use', () => {
    expect(parseBankDate('01/02/2026', 'MDY')).toBe('2026-01-02')
    expect(parseBankDate('01/02/2026', 'DMY')).toBe('2026-02-01')
    expect(parseBankDate('1/2/26', 'MDY')).toBe('2026-01-02')
    expect(parseBankDate('2026-01-02', 'MDY')).toBe('2026-01-02')
    expect(parseBankDate('20260102', 'MDY')).toBe('2026-01-02')
    expect(parseBankDate('02 Jan 2026', 'MDY')).toBe('2026-01-02')
    expect(parseBankDate('Jan 2, 2026', 'MDY')).toBe('2026-01-02')
    expect(parseBankDate('01/02/2026 00:00:00', 'MDY')).toBe('2026-01-02')
    expect(parseBankDate('02/30/2026', 'MDY')).toBeNull()
    expect(parseBankDate('Ending balance', 'MDY')).toBeNull()
  })

  it('reads amounts in cents', () => {
    expect(parseBankAmount('1,234.56')).toBe(123456)
    expect(parseBankAmount('$-12.00')).toBe(-1200)
    expect(parseBankAmount('-$12.00')).toBe(-1200)
    expect(parseBankAmount('(12.00)')).toBe(-1200)
    expect(parseBankAmount('12.00 DR')).toBe(-1200)
    expect(parseBankAmount('12.00 CR')).toBe(1200)
    expect(parseBankAmount('-1.234,56', true)).toBe(-123456)
    expect(parseBankAmount('.5')).toBe(50)
    expect(parseBankAmount('')).toBeNull()
    expect(parseBankAmount('abc')).toBeNull()
    expect(parseBankAmount('1.234')).toBeNull()
  })
})

describe('column mapping', () => {
  it('guesses a single signed amount column', () => {
    const rows = parseCsv(
      'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\nDEBIT,01/15/2026,COFFEE SHOP,-4.50,DEBIT,995.50,\nDEBIT,01/16/2026,CHECK 101,-200.00,CHECK,795.50,101\n'
    )
    const m = guessMapping(rows)
    expect(m).toMatchObject({ headerRow: 0, dateCol: 1, descriptionCol: 2, amountMode: 'signed', amountCol: 3, refCol: 6 })
    expect(mapRows(rows, m).rows).toEqual([
      { date: '2026-01-15', description: 'COFFEE SHOP', memo: '', ref: '', amount: -450 },
      { date: '2026-01-16', description: 'CHECK 101', memo: '', ref: '101', amount: -20000 }
    ])
  })

  it('guesses separate debit and credit columns and day-first dates', () => {
    const rows = parseCsv('Date,Details,Debit,Credit,Balance\n15/01/2026,Rent,500.00,,1000.00\n20/01/2026,Client payment,,1200.00,2200.00\n')
    const m = guessMapping(rows)
    expect(m).toMatchObject({ dateFormat: 'DMY', amountMode: 'split', outCol: 2, inCol: 3, descriptionCol: 1 })
    expect(mapRows(rows, m).rows.map((r) => [r.date, r.amount])).toEqual([
      ['2026-01-15', -50000],
      ['2026-01-20', 120000]
    ])
  })

  it('finds the header below bank preamble lines and skips rows that are not transactions', () => {
    const rows = parseCsv(
      'Account,Everyday Checking\nStatement period,Jan 2026\nDate,Description,Amount\n2026-01-02,Deposit,100.00\n2026-01-03,Zero,0.00\nTotal,,100.00\n'
    )
    const m = guessMapping(rows)
    expect(m.headerRow).toBe(2)
    const mapped = mapRows(rows, m)
    expect(mapped.rows).toHaveLength(1)
    expect(mapped.skipped).toEqual([
      { line: 5, reason: 'amount is zero' },
      { line: 6, reason: '"Total" is not a date' }
    ])
  })

  it('works out the columns of a file without a header', () => {
    const rows = parseCsv('01/02/2026,-25.00,*,,AMAZON MKTPL\n01/05/2026,300.00,*,,PAYROLL DEPOSIT\n')
    const m = guessMapping(rows)
    expect(m).toMatchObject({ headerRow: -1, dateCol: 0, amountCol: 1, descriptionCol: 4 })
    expect(mapRows(rows, m).rows.map((r) => r.description)).toEqual(['AMAZON MKTPL', 'PAYROLL DEPOSIT'])
  })

  it('flips the sign for cards that show charges as positive', () => {
    const rows = parseCsv('Date,Description,Amount\n01/02/2026,HOTEL,250.00\n01/09/2026,PAYMENT THANK YOU,-250.00\n')
    const mapped = mapRows(rows, { ...guessMapping(rows), flipSign: true })
    expect(mapped.rows.map((r) => r.amount)).toEqual([-25000, 25000])
  })

  it('reads European files with semicolons and decimal commas', () => {
    const text = 'Datum;Omschrijving;Bedrag\n02.01.2026;Huur;-1.250,00\n15.01.2026;Klant;2.000,50\n'
    const rows = parseCsv(text)
    const m = guessMapping(rows, detectDelimiter(text))
    expect(m.decimalComma).toBe(true)
    // "Datum" isn't English, so the date and amount columns come from the data.
    expect(mapRows(rows, { ...m, headerRow: 0, dateFormat: 'DMY' }).rows.map((r) => [r.date, r.amount])).toEqual([
      ['2026-01-02', -125000],
      ['2026-01-15', 200050]
    ])
  })
})
