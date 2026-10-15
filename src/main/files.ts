import { app } from 'electron'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { RecentCompany } from '../shared/types'

/** Writes to a temporary file, flushes it, then renames over the target so a crash never leaves a half-written file. */
export function writeFileAtomic(path: string, data: Uint8Array): void {
  const tmp = `${path}.tmp-${process.pid}`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

export function readFileBytes(path: string): Uint8Array {
  if (!existsSync(path)) throw new Error(`File not found: ${path}`)
  return new Uint8Array(readFileSync(path))
}

const MAX_RECENT = 10

function recentPath(): string {
  return join(app.getPath('userData'), 'recent-companies.json')
}

export function readRecent(): RecentCompany[] {
  try {
    const list = JSON.parse(readFileSync(recentPath(), 'utf8')) as RecentCompany[]
    return list.filter((r) => existsSync(r.path))
  } catch {
    return []
  }
}

function writeRecent(list: RecentCompany[]): void {
  writeFileAtomic(recentPath(), Buffer.from(JSON.stringify(list, null, 2)))
}

export function addRecent(path: string, name: string): void {
  const list = readRecent().filter((r) => r.path !== path)
  list.unshift({ path, name, openedAt: new Date().toISOString() })
  writeRecent(list.slice(0, MAX_RECENT))
}

export function removeRecent(path: string): void {
  writeRecent(readRecent().filter((r) => r.path !== path))
}
