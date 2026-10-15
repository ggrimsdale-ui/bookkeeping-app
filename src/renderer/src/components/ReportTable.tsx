import { cellText } from '../../../core/exportReport'
import type { Drill, Report } from '../../../shared/types'

export function ReportTable({ report, onDrill }: { report: Report; onDrill: (drill: Drill) => void }): JSX.Element {
  const ledger = report.kind === 'generalLedger'
  return (
    <div className="report-paper">
      <div className="report-heading">
        <div className="report-company">{report.companyName}</div>
        <div className="report-title">{report.title}</div>
        <div className="report-subtitle">{report.subtitle}</div>
        <div className="report-basis">{report.basis}</div>
      </div>
      <table className={`report ${ledger ? 'ledger' : ''}`}>
        <thead>
          <tr>
            {report.columns.map((c, i) => (
              <th key={i} className={c.kind === 'text' ? '' : 'num'}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row, r) => {
            if (row.kind === 'section' && ledger) {
              return (
                <tr key={r} className="row-section">
                  <td colSpan={report.columns.length}>{row.cells[0]}</td>
                </tr>
              )
            }
            return (
              <tr key={r} className={`row-${row.kind}`}>
                {report.columns.map((c, i) => {
                  const drill = row.drills?.[i] ?? null
                  const text = i === 0 ? String(row.cells[0] ?? '') : cellText(report, row, i)
                  const style = i === 0 && row.indent ? { paddingLeft: 6 + row.indent * 18 } : undefined
                  const negative = typeof row.cells[i] === 'number' && (row.cells[i] as number) < 0
                  return (
                    <td
                      key={i}
                      style={style}
                      className={[
                        c.kind === 'text' ? '' : 'num',
                        drill && text ? 'drill' : '',
                        negative ? 'negative' : ''
                      ].join(' ')}
                      onDoubleClick={drill && text ? () => onDrill(drill) : undefined}
                      onClick={drill && text && c.kind !== 'text' ? () => onDrill(drill) : undefined}
                      title={drill && text ? 'Open the transactions behind this amount' : undefined}
                    >
                      {text}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
