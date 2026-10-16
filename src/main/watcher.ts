import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { extname, join, parse } from 'node:path'
import { listWatchFolders, processStatement } from '../core/autoImport'
import type { Company } from '../core/company'
import { decodeText } from '../core/csv'

export const IMPORTED_FOLDER = 'Imported'
export const ATTENTION_FOLDER = 'Needs attention'

/** Files modified this recently may still be downloading or copying. */
const SETTLE_MS = 3000

/** Moves a file into a subfolder, adding " (2)", " (3)"… if a file with that name is already there. */
function moveInto(file: string, folder: string): void {
  mkdirSync(folder, { recursive: true })
  const { name, ext } = parse(file)
  let target = join(folder, `${name}${ext}`)
  for (let n = 2; existsSync(target); n++) target = join(folder, `${name} (${n})${ext}`)
  try {
    renameSync(file, target)
  } catch {
    // Across drives a rename fails; copy then delete.
    copyFileSync(file, target)
    unlinkSync(file)
  }
}

/**
 * Looks in every watched folder of the open company for new CSV files,
 * imports each one and moves it to Imported (or Needs attention).
 * Returns how many files were handled.
 */
export function scanWatchFolders(company: Company): number {
  let handled = 0
  for (const w of listWatchFolders(company)) {
    let names: string[]
    try {
      names = readdirSync(w.folder)
    } catch {
      continue // The folder is missing or offline (e.g. a network drive); try again next time.
    }
    for (const name of names.sort()) {
      if (!['.csv', '.txt'].includes(extname(name).toLowerCase())) continue
      const file = join(w.folder, name)
      try {
        const stat = statSync(file)
        if (!stat.isFile() || Date.now() - stat.mtimeMs < SETTLE_MS) continue
        const text = decodeText(new Uint8Array(readFileSync(file)))
        const { outcome } = processStatement(company, w.accountId, name, text)
        moveInto(file, join(w.folder, outcome === 'imported' ? IMPORTED_FOLDER : ATTENTION_FOLDER))
        handled++
      } catch (err) {
        // A locked file is retried next time; duplicates are skipped if it was already imported.
        console.error(`Could not process ${file}:`, err)
      }
    }
  }
  return handled
}
