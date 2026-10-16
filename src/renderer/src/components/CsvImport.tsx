import { useMemo, useState } from 'react'
import { api } from '../api'
import { Modal, useDialogs } from './Dialogs'
import { formatDate, formatMoney } from '../format'
import { columnLabel, decodeText, detectDelimiter, guessMapping, mapRows, mappingFits, parseCsv } from '../../../core/csv'
import type { CsvMapping, DateFormat } from '../../../core/csv'
import type { Account, BankImportResult } from '../../../shared/types'

const DATE_FORMATS: { value: DateFormat; label: string }[] = [
  { value: 'MDY', label: 'Month first (MM/DD/YYYY)' },
  { value: 'DMY', label: 'Day first (DD/MM/YYYY)' },
  { value: 'YMD', label: 'Year first (YYYY-MM-DD)' }
]

interface Loaded {
  fileName: string
  rows: string[][]
  /** True when the mapping came from this account's last import. */
  remembered: boolean
}

/** Upload a bank CSV file, confirm which column is which, preview and import. */
export function CsvImport({
  account,
  onClose,
  onImported
}: {
  account: Account
  onClose: () => void
  onImported: (result: BankImportResult) => void
}): JSX.Element {
  const dialogs = useDialogs()
  const [file, setFile] = useState<Loaded | null>(null)
  const [mapping, setMapping] = useState<CsvMapping | null>(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = async (f: File): Promise<void> => {
    try {
      const text = decodeText(new Uint8Array(await f.arrayBuffer()))
      const delimiter = detectDelimiter(text)
      const rows = parseCsv(text, delimiter)
      if (rows.length === 0) throw new Error('This file is empty.')
      const saved = await api.getCsvMapping(account.id)
      const fits = !!saved && mappingFits(rows, saved)
      const { headers: _headers, ...savedMapping } = saved ?? {}
      setMapping(fits ? (savedMapping as CsvMapping) : guessMapping(rows, delimiter))
      setFile({ fileName: f.name, rows, remembered: !!fits })
    } catch (err) {
      dialogs.error(err)
    }
  }

  const mapped = useMemo(() => (file && mapping ? mapRows(file.rows, mapping) : null), [file, mapping])
  const width = file ? Math.max(...file.rows.map((r) => r.length)) : 0
  const set = (patch: Partial<CsvMapping>): void => setMapping((m) => (m ? { ...m, ...patch } : m))

  const doImport = async (): Promise<void> => {
    if (!file || !mapping || !mapped) return
    setBusy(true)
    try {
      const headers = mapping.headerRow >= 0 ? file.rows[mapping.headerRow].map((h) => h.toLowerCase()) : undefined
      onImported(await api.importBankRows(account.id, file.fileName, mapped.rows, { ...mapping, headers }))
    } catch (err) {
      dialogs.error(err)
    } finally {
      setBusy(false)
    }
  }

  const columnSelect = (value: number | null, onChange: (v: number | null) => void, optional = false): JSX.Element => (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}>
      {optional && <option value="">(none)</option>}
      {[...Array(width).keys()].map((i) => (
        <option key={i} value={i}>
          {columnLabel(file!.rows, mapping!.headerRow, i)}
        </option>
      ))}
    </select>
  )

  const totalIn = mapped?.rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0) ?? 0
  const totalOut = mapped?.rows.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0) ?? 0
  const dates = mapped?.rows.map((r) => r.date).sort() ?? []

  return (
    <Modal
      title={`Import bank transactions into ${account.fullName}`}
      wide
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!mapped || mapped.rows.length === 0 || busy} onClick={doImport}>
            {mapped ? `Import ${mapped.rows.length} transaction${mapped.rows.length === 1 ? '' : 's'}` : 'Import'}
          </button>
        </>
      }
    >
      <label
        className={`drop-zone ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          const f = e.dataTransfer.files[0]
          if (f) void load(f)
        }}
      >
        <input
          type="file"
          accept=".csv,.txt,text/csv"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void load(f)
            e.target.value = ''
          }}
        />
        {file ? (
          <span>
            <strong>{file.fileName}</strong> · {file.rows.length} lines. Choose another file or drop it here.
          </span>
        ) : (
          <span>
            <strong>Choose a CSV file</strong> downloaded from the bank, or drop it here.
          </span>
        )}
      </label>

      {file && mapping && mapped && (
        <>
          {file.remembered && <div className="info-banner small">Using the column layout from this account's last import.</div>}
          <div className="form csv-mapping">
            <div className="row">
              <label>
                Column titles
                <select value={mapping.headerRow} onChange={(e) => set({ headerRow: Number(e.target.value) })}>
                  <option value={-1}>The file has no title row</option>
                  {file.rows.slice(0, 10).map((r, i) => (
                    <option key={i} value={i}>
                      Line {i + 1}: {r.join(', ').slice(0, 60)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="row">
              <label>
                Date
                {columnSelect(mapping.dateCol, (v) => set({ dateCol: v ?? 0 }))}
              </label>
              <label>
                Date format
                <select value={mapping.dateFormat} onChange={(e) => set({ dateFormat: e.target.value as DateFormat })}>
                  {DATE_FORMATS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="row">
              <label>
                Description
                {columnSelect(mapping.descriptionCol, (v) => set({ descriptionCol: v ?? 0 }))}
              </label>
              <label>
                Extra details (optional)
                {columnSelect(mapping.memoCol, (v) => set({ memoCol: v }), true)}
              </label>
              <label>
                Check number (optional)
                {columnSelect(mapping.refCol, (v) => set({ refCol: v }), true)}
              </label>
            </div>
            <div className="row">
              <label className="checkbox">
                <input
                  type="radio"
                  checked={mapping.amountMode === 'signed'}
                  onChange={() => set({ amountMode: 'signed', amountCol: mapping.amountCol ?? mapping.outCol ?? 0 })}
                />
                One amount column
              </label>
              <label className="checkbox">
                <input
                  type="radio"
                  checked={mapping.amountMode === 'split'}
                  onChange={() =>
                    set({ amountMode: 'split', outCol: mapping.outCol ?? mapping.amountCol ?? 0, inCol: mapping.inCol ?? mapping.amountCol ?? 0 })
                  }
                />
                Separate money out and money in columns
              </label>
            </div>
            {mapping.amountMode === 'signed' ? (
              <div className="row">
                <label>
                  Amount
                  {columnSelect(mapping.amountCol, (v) => set({ amountCol: v ?? 0 }))}
                </label>
                <label className="checkbox">
                  <input type="checkbox" checked={mapping.flipSign} onChange={(e) => set({ flipSign: e.target.checked })} />
                  Money out is shown as a positive number (common for credit cards)
                </label>
              </div>
            ) : (
              <div className="row">
                <label>
                  Money out (debits, withdrawals)
                  {columnSelect(mapping.outCol, (v) => set({ outCol: v }))}
                </label>
                <label>
                  Money in (credits, deposits)
                  {columnSelect(mapping.inCol, (v) => set({ inCol: v }))}
                </label>
              </div>
            )}
            <label className="checkbox">
              <input type="checkbox" checked={mapping.decimalComma} onChange={(e) => set({ decimalComma: e.target.checked })} />
              Amounts use a comma for decimals (1.234,56)
            </label>
          </div>

          <h2 className="preview-title">
            Preview
            <span className="muted small">
              {mapped.rows.length} transactions
              {dates.length > 0 && ` from ${formatDate(dates[0])} to ${formatDate(dates[dates.length - 1])}`} · money out{' '}
              {formatMoney(totalOut)} · money in {formatMoney(totalIn)}
            </span>
          </h2>
          <div className="preview-scroll">
            <table className="grid">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Ref</th>
                  <th>Description</th>
                  <th className="num">Spent</th>
                  <th className="num">Received</th>
                </tr>
              </thead>
              <tbody>
                {mapped.rows.slice(0, 50).map((r, i) => (
                  <tr key={i}>
                    <td className="nowrap">{formatDate(r.date)}</td>
                    <td>{r.ref}</td>
                    <td>
                      {r.description}
                      {r.memo && <div className="muted small">{r.memo}</div>}
                    </td>
                    <td className="num">{r.amount < 0 ? formatMoney(-r.amount) : ''}</td>
                    <td className="num">{r.amount > 0 ? formatMoney(r.amount) : ''}</td>
                  </tr>
                ))}
                {mapped.rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      No transactions could be read with these columns. Check the date and amount columns above.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {mapped.rows.length > 50 && <p className="muted small">Showing the first 50.</p>}
          {mapped.skipped.length > 0 && (
            <p className="muted small">
              {mapped.skipped.length} line{mapped.skipped.length === 1 ? '' : 's'} will be skipped:{' '}
              {mapped.skipped
                .slice(0, 4)
                .map((s) => `line ${s.line} (${s.reason})`)
                .join(', ')}
              {mapped.skipped.length > 4 ? '…' : '.'}
            </p>
          )}
          <p className="muted small">Transactions already imported into this account are skipped automatically.</p>
        </>
      )}
    </Modal>
  )
}
