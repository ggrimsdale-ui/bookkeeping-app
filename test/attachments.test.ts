import { describe, expect, it } from 'vitest'
import { Company } from '../src/core/company'
import { addAttachment, deleteAttachment, getAttachment, listAttachments, mimeTypeFor } from '../src/core/attachments'
import {
  acceptBankTransactions,
  deleteBankTransactions,
  importBankRows,
  listBankTransactions,
  undoBankTransactions,
  updateBankTransactions
} from '../src/core/bankFeed'
import { acct, cr, dr, newCompany, post, sql } from './helpers'

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

async function withBankTx(): Promise<{ c: Company; bank: number; txId: number }> {
  const c = await newCompany()
  const bank = acct(c, '1000')
  importBankRows(c, bank, 'sep.csv', [{ date: '2026-09-12', description: 'STAPLES', memo: '', ref: '', amount: -4218 }])
  return { c, bank, txId: listBankTransactions(c, bank, 'review')[0].id }
}

describe('attachments', () => {
  it('stores receipts on an entry inside the company file', async () => {
    const c = await newCompany()
    const id = post(c, '2026-09-01', [dr(c, '6300', 1000), cr(c, '1000', 1000)], 'Supplies')
    const a = addAttachment(c, { entryId: id }, 'Receipt 0912.PDF', bytes('%PDF-1.4 receipt'))
    expect(a).toMatchObject({ fileName: 'Receipt 0912.PDF', mimeType: 'application/pdf', size: 16 })
    // Survives saving and reopening the file.
    const reopened = Company.open(await sql(), c.export())
    expect(new TextDecoder().decode(getAttachment(reopened, a.id).data)).toBe('%PDF-1.4 receipt')
    expect(reopened.listEntries()[0].attachmentCount).toBe(1)
    deleteAttachment(reopened, a.id)
    expect(listAttachments(reopened, { entryId: id })).toEqual([])
  })

  it('refuses empty and oversized files and guesses types from the name', async () => {
    const c = await newCompany()
    const id = post(c, '2026-09-01', [dr(c, '6300', 1000), cr(c, '1000', 1000)])
    expect(() => addAttachment(c, { entryId: id }, 'x.png', new Uint8Array())).toThrow(/empty/)
    expect(() => addAttachment(c, { entryId: id }, 'x.png', new Uint8Array(26 * 1024 * 1024))).toThrow(/larger/)
    expect(mimeTypeFor('IMG_1234.JPG')).toBe('image/jpeg')
    expect(mimeTypeFor('scan.heic')).toBe('image/heic')
    expect(mimeTypeFor('mystery')).toBe('application/octet-stream')
  })

  it('carries a bank transaction receipt onto the entry it becomes, and back on undo', async () => {
    const { c, bank, txId } = await withBankTx()
    addAttachment(c, { bankTxId: txId }, 'staples.jpg', bytes('jpg'))
    expect(listBankTransactions(c, bank, 'review')[0].attachmentCount).toBe(1)
    updateBankTransactions(c, [txId], { categoryId: acct(c, '6300') })
    acceptBankTransactions(c, [txId])
    const [done] = listBankTransactions(c, bank, 'done')
    expect(listAttachments(c, { entryId: done.entryId! }).map((a) => a.fileName)).toEqual(['staples.jpg'])

    // One added from the entry afterwards shows on the bank transaction too, counted once each.
    addAttachment(c, { entryId: done.entryId! }, 'invoice.pdf', bytes('pdf'))
    expect(listBankTransactions(c, bank, 'done')[0].attachmentCount).toBe(2)
    expect(listAttachments(c, { bankTxId: txId })).toHaveLength(2)

    // Undo deletes the entry: the bank receipt stays with the transaction, the entry's own goes.
    undoBankTransactions(c, [txId])
    expect(listAttachments(c, { bankTxId: txId }).map((a) => a.fileName)).toEqual(['staples.jpg'])
  })

  it('keeps receipts on a matched entry and removes them with deleted bank transactions', async () => {
    const { c, bank, txId } = await withBankTx()
    const entryId = post(c, '2026-09-11', [dr(c, '6300', 4218), cr(c, '1000', 4218)], 'Staples')
    addAttachment(c, { bankTxId: txId }, 'staples.jpg', bytes('jpg'))
    acceptBankTransactions(c, [txId])
    expect(listAttachments(c, { entryId })).toHaveLength(1)
    undoBankTransactions(c, [txId])
    expect(listAttachments(c, { entryId })).toHaveLength(0)
    deleteBankTransactions(c, [txId])
    expect(c.get<{ n: number }>('SELECT COUNT(*) AS n FROM attachments')!.n).toBe(0)
    expect(listBankTransactions(c, bank, 'review')).toHaveLength(0)
  })
})
