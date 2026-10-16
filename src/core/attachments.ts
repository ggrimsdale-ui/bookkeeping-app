// Receipts and other documents attached to transactions. They are stored in
// the company file itself, so a client's books and their receipts travel,
// back up and restore together as one file.

import type { Company } from './company'
import type { Attachment, AttachmentTarget } from '../shared/types'

/** Largest file accepted, so one scan can't bloat the company file. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  heic: 'image/heic',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  txt: 'text/plain',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  eml: 'message/rfc822'
}

/** The file's type from its name, since the browser's guess is often empty. */
export function mimeTypeFor(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop() ?? ''
  return TYPES[ext] ?? 'application/octet-stream'
}

/** Whether the app can show the file itself, rather than handing it to another program. */
export function canPreview(mimeType: string): boolean {
  return mimeType === 'application/pdf' || (mimeType.startsWith('image/') && !['image/heic', 'image/tiff'].includes(mimeType)) || mimeType === 'text/plain'
}

interface Row {
  id: number
  file_name: string
  mime_type: string
  size: number
  added_at: string
}

const toAttachment = (r: Row): Attachment => ({ id: r.id, fileName: r.file_name, mimeType: r.mime_type, size: r.size, addedAt: r.added_at })

/** The entry a bank transaction was added as or matched to, if any. */
function bankTxEntry(company: Company, bankTxId: number): number | null {
  const row = company.get<{ entry_id: number | null }>('SELECT entry_id FROM bank_transactions WHERE id = ?', [bankTxId])
  if (!row) throw new Error('Bank transaction not found')
  return row.entry_id
}

/**
 * Attachments for a journal entry, or for a bank transaction. Once a bank
 * transaction is added to the books, its receipts show on the entry too.
 */
export function listAttachments(company: Company, target: AttachmentTarget): Attachment[] {
  const cols = 'id, file_name, mime_type, size, added_at'
  if ('entryId' in target) {
    return company.all<Row>(`SELECT ${cols} FROM attachments WHERE entry_id = ? ORDER BY id`, [target.entryId]).map(toAttachment)
  }
  const entryId = bankTxEntry(company, target.bankTxId)
  return company
    .all<Row>(`SELECT ${cols} FROM attachments WHERE bank_tx_id = ? OR (? IS NOT NULL AND entry_id = ?) ORDER BY id`, [target.bankTxId, entryId, entryId])
    .map(toAttachment)
}

export function addAttachment(company: Company, target: AttachmentTarget, fileName: string, data: Uint8Array): Attachment {
  const name = fileName.trim().replace(/[\\/]/g, '_') || 'attachment'
  if (data.byteLength === 0) throw new Error(`${name} is empty.`)
  if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`${name} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`)
  let entryId: number | null
  let bankTxId: number | null = null
  if ('entryId' in target) {
    if (!company.get('SELECT id FROM journal_entries WHERE id = ?', [target.entryId])) throw new Error('Journal entry not found')
    entryId = target.entryId
  } else {
    bankTxId = target.bankTxId
    entryId = bankTxEntry(company, bankTxId)
  }
  const id = company.transaction(() => {
    company.db.run('INSERT INTO attachments (entry_id, bank_tx_id, file_name, mime_type, size, data, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      entryId,
      bankTxId,
      name,
      mimeTypeFor(name),
      data.byteLength,
      data,
      new Date().toISOString()
    ])
    return company.lastId()
  })
  return toAttachment(company.get<Row>('SELECT id, file_name, mime_type, size, added_at FROM attachments WHERE id = ?', [id])!)
}

export function getAttachment(company: Company, id: number): Attachment & { data: Uint8Array } {
  const row = company.get<Row & { data: Uint8Array }>('SELECT * FROM attachments WHERE id = ?', [id])
  if (!row) throw new Error('Attachment not found')
  return { ...toAttachment(row), data: row.data }
}

export function deleteAttachment(company: Company, id: number): void {
  company.transaction(() => company.db.run('DELETE FROM attachments WHERE id = ?', [id]))
}
