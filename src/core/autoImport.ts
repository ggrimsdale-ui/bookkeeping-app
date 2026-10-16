// Watched folders: bank CSV files dropped into an account's folder are
// imported, the transactions the app is confident about are added to the
// books, and the rest wait in For Review. The main process does the file
// handling; this module decides what happens to the file's contents.

import { acceptBankTransactions, getCsvMapping, importBankRows, listBankTransactions } from './bankFeed'
import type { Company } from './company'
import { detectDelimiter, mapRows, mappingFits, parseCsv } from './csv'
import { formatDate } from './dates'
import type { BankImportLog, WatchFolder } from '../shared/types'

export function listWatchFolders(company: Company): WatchFolder[] {
  return company
    .all<{ account_id: number; folder: string; auto_accept: number; accept_history: number }>('SELECT * FROM bank_watch_folders')
    .map((r) => ({ accountId: r.account_id, folder: r.folder, autoAccept: r.auto_accept === 1, acceptHistory: r.accept_history === 1 }))
}

export function getWatchFolder(company: Company, accountId: number): WatchFolder | null {
  return listWatchFolders(company).find((w) => w.accountId === accountId) ?? null
}

/** Sets or clears (null) the watched folder for an account. */
export function setWatchFolder(company: Company, accountId: number, settings: Omit<WatchFolder, 'accountId'> | null): void {
  const account = company.getAccount(accountId)
  company.transaction(() => {
    if (settings === null) {
      company.db.run('DELETE FROM bank_watch_folders WHERE account_id = ?', [accountId])
      return
    }
    const folder = settings.folder.trim()
    if (!folder) throw new Error('Choose a folder to watch.')
    const other = listWatchFolders(company).find((w) => w.folder === folder && w.accountId !== accountId)
    if (other) throw new Error(`That folder is already watched for ${company.getAccount(other.accountId).name}. Use one folder per account.`)
    if (!getCsvMapping(company, account.id)) {
      throw new Error(`Import one file from this bank into ${account.name} by hand first, so the app learns which column is which.`)
    }
    company.db.run('INSERT OR REPLACE INTO bank_watch_folders (account_id, folder, auto_accept, accept_history) VALUES (?, ?, ?, ?)', [
      accountId,
      folder,
      settings.autoAccept ? 1 : 0,
      settings.acceptHistory ? 1 : 0
    ])
  })
}

export function listBankImports(company: Company, accountId: number, limit = 50): BankImportLog[] {
  return company
    .all<{
      id: number
      account_id: number
      file_name: string
      imported_at: string
      source: string
      row_count: number
      duplicate_count: number
      auto_added: number
      note: string
    }>('SELECT * FROM bank_imports WHERE account_id = ? ORDER BY id DESC LIMIT ?', [accountId, limit])
    .map((r) => ({
      id: r.id,
      accountId: r.account_id,
      fileName: r.file_name,
      importedAt: r.imported_at,
      source: r.source as BankImportLog['source'],
      imported: r.row_count,
      duplicates: r.duplicate_count,
      autoAdded: r.auto_added,
      note: r.note
    }))
}

export interface StatementOutcome {
  /** 'imported': move the file to Imported. 'needsAttention': move it to Needs attention. */
  outcome: 'imported' | 'needsAttention'
  log: BankImportLog
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * Imports one statement file from an account's watched folder and, when the
 * folder is set to, adds the transactions the app is confident about: those
 * categorized by a bank rule and those that match an entry already in the
 * books (and, if allowed, ones categorized from past choices). Anything else,
 * and anything dated in a closed period, is left in For Review.
 */
export function processStatement(company: Company, accountId: number, fileName: string, text: string): StatementOutcome {
  const settings = getWatchFolder(company, accountId) ?? { accountId, folder: '', autoAccept: false, acceptHistory: false }
  const attention = (note: string): StatementOutcome => {
    company.transaction(() =>
      company.db.run(
        "INSERT INTO bank_imports (account_id, file_name, imported_at, row_count, duplicate_count, source, note) VALUES (?, ?, ?, 0, 0, 'folder', ?)",
        [accountId, fileName, new Date().toISOString(), note]
      )
    )
    return { outcome: 'needsAttention', log: listBankImports(company, accountId, 1)[0] }
  }

  const rows = parseCsv(text, detectDelimiter(text))
  const saved = getCsvMapping(company, accountId)
  if (!saved) return attention('No column layout saved yet. Import one file from this bank by hand first.')
  if (!mappingFits(rows, saved)) return attention("The columns don't match this account's last import. Import it by hand to set up the new layout.")
  const { rows: transactions } = mapRows(rows, saved)
  if (transactions.length === 0) return attention('No transactions could be read from this file.')

  let result
  try {
    result = importBankRows(company, accountId, fileName, transactions)
  } catch (err) {
    return attention(err instanceof Error ? err.message : String(err))
  }

  const notes: string[] = []
  let autoAdded = 0
  if (settings.autoAccept) {
    const closing = company.getClosing().closingDate
    const fresh = listBankTransactions(company, accountId, 'review').filter((t) => t.importId === result.importId)
    const confident = fresh.filter(
      (t) => (t.match !== null && !t.ignoreMatch) || t.categorySource === 'rule' || (settings.acceptHistory && t.categorySource === 'history')
    )
    const open = confident.filter((t) => !closing || t.date > closing)
    if (open.length < confident.length) notes.push(`${plural(confident.length - open.length, 'transaction')} dated on or before the closing date ${formatDate(closing!)} left for review`)
    if (open.length > 0) {
      try {
        const accepted = acceptBankTransactions(company, open.map((t) => t.id))
        autoAdded = accepted.added + accepted.matched
      } catch (err) {
        notes.push(`Could not add automatically: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  const waiting = result.imported - autoAdded
  if (waiting > 0) notes.unshift(`${plural(waiting, 'transaction')} waiting in For Review`)
  company.transaction(() =>
    company.db.run("UPDATE bank_imports SET source = 'folder', auto_added = ?, note = ? WHERE id = ?", [autoAdded, notes.join('. '), result.importId])
  )
  return { outcome: 'imported', log: listBankImports(company, accountId, 1)[0] }
}
