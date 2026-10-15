import ExcelJS from 'exceljs'
import type { Report } from '../shared/types'

/** Builds an .xlsx workbook with real numbers, indentation and bold totals. */
export async function reportToXlsx(report: Report): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet(report.title.slice(0, 31))
  const width = report.columns.length

  const header = (text: string, size: number, bold: boolean): void => {
    const row = sheet.addRow([text])
    sheet.mergeCells(row.number, 1, row.number, width)
    row.getCell(1).font = { size, bold }
    row.getCell(1).alignment = { horizontal: 'center' }
  }
  header(report.companyName, 14, true)
  header(report.title, 12, true)
  header(report.subtitle, 10, false)
  header(report.basis, 9, false)
  sheet.addRow([])

  const head = sheet.addRow(report.columns.map((c) => c.label))
  head.font = { bold: true }
  head.eachCell((cell) => {
    cell.border = { bottom: { style: 'thin' } }
  })

  for (const r of report.rows) {
    const values = report.columns.map((c, i) => {
      const v = r.cells[i]
      if (v === null || v === undefined) return null
      if (c.kind === 'money' && typeof v === 'number') return v / 100
      return v
    })
    const row = sheet.addRow(values)
    if (r.indent) row.getCell(1).alignment = { indent: r.indent }
    const isTotal = r.kind === 'subtotal' || r.kind === 'total' || r.kind === 'grandTotal'
    if (isTotal || r.kind === 'section') row.font = { bold: true }
    report.columns.forEach((c, i) => {
      const cell = row.getCell(i + 1)
      if (c.kind === 'money') cell.numFmt = '#,##0.00;(#,##0.00)'
      if (c.kind === 'percent') cell.numFmt = '0.0%'
      if (isTotal && c.kind !== 'text') {
        cell.border = r.kind === 'grandTotal' ? { top: { style: 'thin' }, bottom: { style: 'double' } } : { top: { style: 'thin' } }
      }
    })
  }

  sheet.getColumn(1).width = report.kind === 'generalLedger' ? 12 : 48
  report.columns.forEach((c, i) => {
    if (i === 0) return
    sheet.getColumn(i + 1).width = c.kind === 'text' ? (c.label === 'Memo' || c.label === 'Split' ? 36 : 12) : 16
  })
  sheet.views = [{ state: 'frozen', ySplit: 6 }]

  return new Uint8Array(await workbook.xlsx.writeBuffer())
}
