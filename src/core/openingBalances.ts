import { isDebitNormal } from './accountTypes'
import type { Company } from './company'
import type { ClosingOverride, JournalEntry, JournalLine } from '../shared/types'

export interface OpeningBalance {
  accountId: number
  /** Cents, in the account's normal direction (a positive bank balance, a positive loan balance). */
  amount: number
}

/**
 * Records opening balances as one journal entry, with the difference posted
 * to Opening Balance Equity so the entry always balances.
 */
export function enterOpeningBalances(
  company: Company,
  date: string,
  balances: OpeningBalance[],
  override?: ClosingOverride
): JournalEntry {
  const accounts = new Map(company.listAccounts().map((a) => [a.id, a]))
  const obe = [...accounts.values()].find((a) => a.system === 'openingBalanceEquity')
  if (!obe) throw new Error('Opening Balance Equity account is missing')

  const lines: JournalLine[] = []
  let net = 0
  for (const b of balances) {
    if (b.amount === 0) continue
    const account = accounts.get(b.accountId)
    if (!account) throw new Error('Account not found')
    if (account.id === obe.id) throw new Error('Opening Balance Equity is calculated automatically')
    // Convert the natural-sign amount to a debit or credit.
    const debitAmount = isDebitNormal(account.type) ? b.amount : -b.amount
    lines.push({
      accountId: account.id,
      debit: debitAmount > 0 ? debitAmount : 0,
      credit: debitAmount < 0 ? -debitAmount : 0,
      memo: 'Opening balance'
    })
    net += debitAmount
  }
  if (lines.length === 0) throw new Error('Enter at least one opening balance.')
  if (net !== 0) {
    lines.push({
      accountId: obe.id,
      debit: net < 0 ? -net : 0,
      credit: net > 0 ? net : 0,
      memo: 'Opening balance offset'
    })
  }
  if (lines.length < 2) throw new Error('Opening balances must include at least two accounts.')
  return company.createEntry({ date, ref: 'OPEN', memo: 'Opening balances', isOpening: true, lines }, override)
}
