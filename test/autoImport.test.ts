import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listBankImports, processStatement, setWatchFolder } from '../src/core/autoImport'
import { bankCounts, importBankRows, listBankTransactions, saveRule } from '../src/core/bankFeed'
import type { Company } from '../src/core/company'
import { guessMapping, parseCsv } from '../src/core/csv'
import { scanWatchFolders } from '../src/main/watcher'
import { acct, cr, dr, newCompany, post } from './helpers'

const HEADER = 'Posting Date,Description,Amount\n'
const september = HEADER + '09/01/2026,FIRST FILE ROW,-1.00\n'
const october =
  HEADER +
  [
    '10/02/2026,CHECK 1041,-2400.00',
    '10/04/2026,COMCAST BUSINESS 8155,-189.99',
    '10/09/2026,SQ *BLUE BOTTLE 1009,-6.75',
    '10/12/2026,STAPLES 00123,-42.18'
  ].join('\n') +
  '\n'

/** A company whose checking account has had one file imported by hand, so its column layout is known. */
async function setup(): Promise<{ c: Company; bank: number }> {
  const c = await newCompany()
  const bank = acct(c, '1000')
  const rows = parseCsv(september)
  const mapping = guessMapping(rows)
  importBankRows(c, bank, 'september.csv', [{ date: '2026-09-01', description: 'FIRST FILE ROW', memo: '', ref: '', amount: -100 }], {
    ...mapping,
    headers: rows[0].map((h) => h.toLowerCase())
  })
  saveRule(c, null, { contains: 'COMCAST', direction: 'out', categoryId: acct(c, '6550'), payee: 'Comcast' })
  post(c, '2026-10-01', [dr(c, '6450', 240000), cr(c, '1000', 240000)], 'Rent', '1041')
  return { c, bank }
}

describe('watched folders', () => {
  it('needs a column layout from a manual import before a folder can be watched', async () => {
    const c = await newCompany()
    expect(() => setWatchFolder(c, acct(c, '1010'), { folder: '/tmp/x', autoAccept: true, acceptHistory: false })).toThrow(/by hand first/)
  })

  it('imports a statement and adds only the confident transactions', async () => {
    const { c, bank } = await setup()
    setWatchFolder(c, bank, { folder: '/tmp/x', autoAccept: true, acceptHistory: false })
    const { outcome, log } = processStatement(c, bank, 'october.csv', october)
    expect(outcome).toBe('imported')
    // The check matches the rent entry and Comcast has a rule; coffee and Staples need review.
    expect(log).toMatchObject({ source: 'folder', imported: 4, autoAdded: 2, note: '2 transactions waiting in For Review' })
    expect(bankCounts(c, bank)).toEqual({ review: 3, done: 2, excluded: 0 }) // includes September's row
    expect(c.listEntries()).toHaveLength(2) // rent + Comcast; the check was matched, not added again
    const done = listBankTransactions(c, bank, 'done')
    expect(done.map((t) => [t.payee, t.status])).toEqual([
      ['Comcast', 'added'],
      ['CHECK 1041', 'matched']
    ])
  })

  it('adds past-choice categories only when allowed, and leaves everything when auto-add is off', async () => {
    const { c, bank } = await setup()
    // Teach it Blue Bottle from an earlier statement.
    const earlier = importBankRows(c, bank, 'aug.csv', [{ date: '2026-08-09', description: 'SQ *BLUE BOTTLE 0809', memo: '', ref: '', amount: -500 }])
    const [coffee] = listBankTransactions(c, bank, 'review').filter((t) => t.importId === earlier.importId)
    const { updateBankTransactions, acceptBankTransactions } = await import('../src/core/bankFeed')
    updateBankTransactions(c, [coffee.id], { categoryId: acct(c, '6250') })
    acceptBankTransactions(c, [coffee.id])

    setWatchFolder(c, bank, { folder: '/tmp/x', autoAccept: true, acceptHistory: true })
    expect(processStatement(c, bank, 'october.csv', october).log.autoAdded).toBe(3)

    const other = await setup()
    setWatchFolder(other.c, other.bank, { folder: '/tmp/x', autoAccept: false, acceptHistory: false })
    expect(processStatement(other.c, other.bank, 'october.csv', october).log).toMatchObject({ imported: 4, autoAdded: 0 })
  })

  it('leaves transactions in a closed period for review', async () => {
    const { c, bank } = await setup()
    c.setClosing('2026-10-05', null)
    setWatchFolder(c, bank, { folder: '/tmp/x', autoAccept: true, acceptHistory: false })
    const { log } = processStatement(c, bank, 'october.csv', october)
    expect(log.autoAdded).toBe(0)
    expect(log.note).toContain('closing date 10/05/2026')
  })

  it('sets aside files with a different layout or nothing new to read', async () => {
    const { c, bank } = await setup()
    expect(processStatement(c, bank, 'other-bank.csv', 'Date,Payee,Debit,Credit\n10/02/2026,X,1.00,\n').outcome).toBe('needsAttention')
    expect(listBankImports(c, bank)[0]).toMatchObject({ fileName: 'other-bank.csv', imported: 0, note: expect.stringContaining("columns don't match") })
    // Importing the same statement twice adds nothing the second time.
    setWatchFolder(c, bank, { folder: '/tmp/x', autoAccept: true, acceptHistory: false })
    processStatement(c, bank, 'october.csv', october)
    expect(processStatement(c, bank, 'october copy.csv', october).log).toMatchObject({ imported: 0, duplicates: 4, autoAdded: 0 })
  })

  it('picks up files from the folder and moves them to Imported or Needs attention', async () => {
    const { c, bank } = await setup()
    const folder = mkdtempSync(join(tmpdir(), 'statements-'))
    setWatchFolder(c, bank, { folder, autoAccept: true, acceptHistory: false })
    const old = new Date(Date.now() - 60000)
    for (const [name, text] of [
      ['october.csv', october],
      ['wrong.csv', 'a,b\n1,2\n'],
      ['notes.pdf', 'not a csv']
    ]) {
      writeFileSync(join(folder, name), text)
      utimesSync(join(folder, name), old, old)
    }
    writeFileSync(join(folder, 'still-downloading.csv'), october) // too new to touch yet

    expect(scanWatchFolders(c)).toBe(2)
    expect(readdirSync(join(folder, 'Imported'))).toEqual(['october.csv'])
    expect(readdirSync(join(folder, 'Needs attention'))).toEqual(['wrong.csv'])
    expect(existsSync(join(folder, 'notes.pdf'))).toBe(true)
    expect(existsSync(join(folder, 'still-downloading.csv'))).toBe(true)

    // The same name again is kept alongside, not overwritten.
    writeFileSync(join(folder, 'october.csv'), october)
    utimesSync(join(folder, 'october.csv'), old, old)
    scanWatchFolders(c)
    expect(readdirSync(join(folder, 'Imported')).sort()).toEqual(['october (2).csv', 'october.csv'])
  })
})
