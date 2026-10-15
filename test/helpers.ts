import initSqlJs from 'sql.js'
import type { SqlJsStatic } from 'sql.js'
import { Company } from '../src/core/company'
import type { TemplateId } from '../src/core/templates'
import type { JournalLine } from '../src/shared/types'

let SQL: SqlJsStatic | undefined

export async function sql(): Promise<SqlJsStatic> {
  SQL ??= await initSqlJs()
  return SQL
}

export async function newCompany(template: TemplateId = 'general', fiscalYearStartMonth = 1): Promise<Company> {
  return Company.create(
    await sql(),
    { name: 'Test Co', legalName: 'Test Co LLC', address: '', taxId: '', fiscalYearStartMonth },
    template
  )
}

export function acct(company: Company, number: string): number {
  const a = company.listAccounts().find((x) => x.number === number)
  if (!a) throw new Error(`No account ${number}`)
  return a.id
}

/** Shorthand line builders: dr('1000', 500) is a 5.00 debit. */
export function dr(company: Company, number: string, cents: number, memo = ''): JournalLine {
  return { accountId: acct(company, number), debit: cents, credit: 0, memo }
}

export function cr(company: Company, number: string, cents: number, memo = ''): JournalLine {
  return { accountId: acct(company, number), debit: 0, credit: cents, memo }
}

export function post(company: Company, date: string, lines: JournalLine[], memo = '', ref = ''): number {
  return company.createEntry({ date, ref, memo, lines }).id
}
