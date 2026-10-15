import { useState } from 'react'
import { api } from '../api'
import { useDialogs } from '../components/Dialogs'
import { CompanyInfoFields } from '../components/CompanyInfoFields'
import { formatLongDate } from '../format'
import type { Nav } from '../nav'
import type { OpenCompany } from '../../../shared/api'
import type { CompanyInfo } from '../../../shared/types'

export function Settings({
  nav,
  company,
  onChange
}: {
  nav: Nav
  company: OpenCompany
  onChange: (c: OpenCompany) => void
}): JSX.Element {
  const dialogs = useDialogs()
  const [info, setInfo] = useState<CompanyInfo>(company.info)
  const [closingDate, setClosingDate] = useState(company.closing.closingDate ?? '')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')

  const saveInfo = async (): Promise<void> => {
    try {
      onChange(await api.updateInfo(info))
      nav.changed()
      await dialogs.alert('Company information saved.')
    } catch (err) {
      dialogs.error(err)
    }
  }

  const currentPassword = async (): Promise<string | undefined | null> => {
    if (!company.closing.hasPassword) return undefined
    return dialogs.prompt('Enter the current closing date password.', { title: 'Closing date', password: true })
  }

  const saveClosing = async (clear: boolean): Promise<void> => {
    try {
      if (!clear && !closingDate) throw new Error('Choose a closing date.')
      if (!clear && password !== confirm) throw new Error('The passwords do not match.')
      const current = await currentPassword()
      if (current === null) return
      const updated = await api.setClosing(clear ? null : closingDate, clear ? null : password || null, current)
      onChange(updated)
      if (clear) setClosingDate('')
      setPassword('')
      setConfirm('')
      nav.changed()
    } catch (err) {
      dialogs.error(err)
    }
  }

  return (
    <div className="page">
      <h1>Company Settings</h1>
      <div className="two-col">
        <section className="form">
          <h2>Company information</h2>
          <CompanyInfoFields info={info} onChange={setInfo} />
          <div className="buttons">
            <button className="primary" onClick={saveInfo}>
              Save company information
            </button>
          </div>
          <p className="muted small">Company file: {company.path}</p>
        </section>

        <section className="form">
          <h2>Closing date</h2>
          <p className="muted small">
            Entries dated on or before the closing date are locked. Changing them asks for confirmation, or for the password if
            you set one. Use this once a period's returns are filed.
          </p>
          {company.closing.closingDate ? (
            <p>
              Books are closed through <strong>{formatLongDate(company.closing.closingDate)}</strong>
              {company.closing.hasPassword ? ', password protected.' : '.'}
            </p>
          ) : (
            <p>No closing date is set.</p>
          )}
          <label>
            Closing date
            <input type="date" value={closingDate} onChange={(e) => setClosingDate(e.target.value)} />
          </label>
          <label>
            Closing date password (optional)
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label>
            Confirm password
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
          <div className="buttons">
            {company.closing.closingDate && <button onClick={() => saveClosing(true)}>Remove closing date</button>}
            <button className="primary" onClick={() => saveClosing(false)}>
              Set closing date
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
