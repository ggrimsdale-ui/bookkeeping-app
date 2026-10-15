import { formatMoney } from './money'
import type { Report, ReportRow } from '../shared/types'

export function cellText(report: Report, row: ReportRow, col: number): string {
  const v = row.cells[col]
  if (v === null || v === undefined) return ''
  const kind = report.columns[col].kind
  if (kind === 'money' && typeof v === 'number') return formatMoney(v)
  if (kind === 'percent' && typeof v === 'number') return `${(v * 100).toFixed(1)}%`
  const text = String(v)
  return col === 0 && row.indent ? '  '.repeat(row.indent) + text : text
}

function csvField(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function reportToCsv(report: Report): string {
  const lines: string[][] = [
    [report.companyName],
    [report.title],
    [report.subtitle],
    [report.basis],
    [],
    report.columns.map((c) => c.label),
    ...report.rows.map((r) =>
      report.columns.map((c, i) => {
        // Plain numbers in CSV so spreadsheets can total them.
        const v = r.cells[i]
        if (c.kind === 'money' && typeof v === 'number') return (v / 100).toFixed(2)
        if (c.kind === 'percent' && typeof v === 'number') return (v * 100).toFixed(1)
        return cellText(report, r, i)
      })
    )
  ]
  return lines.map((l) => l.map(csvField).join(',')).join('\r\n') + '\r\n'
}
