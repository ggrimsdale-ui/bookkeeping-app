import { MONTHS } from '../format'
import type { CompanyInfo } from '../../../shared/types'

export function CompanyInfoFields({ info, onChange }: { info: CompanyInfo; onChange: (info: CompanyInfo) => void }): JSX.Element {
  const set = <K extends keyof CompanyInfo>(key: K, value: CompanyInfo[K]): void => onChange({ ...info, [key]: value })
  return (
    <>
      <label>
        Company name
        <input autoFocus value={info.name} onChange={(e) => set('name', e.target.value)} />
      </label>
      <label>
        Legal name
        <input value={info.legalName} onChange={(e) => set('legalName', e.target.value)} />
      </label>
      <label>
        Address
        <textarea rows={3} value={info.address} onChange={(e) => set('address', e.target.value)} />
      </label>
      <label>
        Tax ID (EIN)
        <input value={info.taxId} onChange={(e) => set('taxId', e.target.value)} />
      </label>
      <label>
        First month of fiscal year
        <select value={info.fiscalYearStartMonth} onChange={(e) => set('fiscalYearStartMonth', Number(e.target.value))}>
          {MONTHS.map((m, i) => (
            <option key={m} value={i + 1}>
              {m}
            </option>
          ))}
        </select>
      </label>
    </>
  )
}
