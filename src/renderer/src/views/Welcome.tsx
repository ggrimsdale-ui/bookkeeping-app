import { useEffect, useState } from 'react'
import { api } from '../api'
import { useDialogs } from '../components/Dialogs'
import { CompanyInfoFields } from '../components/CompanyInfoFields'
import { TEMPLATE_LABELS, formatDate } from '../format'
import type { OpenCompany } from '../../../shared/api'
import type { CompanyInfo, RecentCompany, TemplateId } from '../../../shared/types'

interface Props {
  showNew: boolean
  setShowNew: (show: boolean) => void
  onOpened: (c: OpenCompany | null) => void
  onOpen: (path?: string) => void
  onRestore: () => void
}

export function Welcome({ showNew, setShowNew, onOpened, onOpen, onRestore }: Props): JSX.Element {
  const [recent, setRecent] = useState<RecentCompany[]>([])
  useEffect(() => {
    api.recentCompanies().then(setRecent)
  }, [])

  if (showNew) return <NewCompany onCancel={() => setShowNew(false)} onCreated={onOpened} />

  return (
    <div className="welcome">
      <h1>Bookkeeping</h1>
      <p className="muted">Open a client's company file, or set up a new company.</p>
      <div className="welcome-actions">
        <button className="primary" onClick={() => setShowNew(true)}>
          Create a new company
        </button>
        <button onClick={() => onOpen()}>Open a company file…</button>
        <button onClick={onRestore}>Restore a backup…</button>
      </div>
      {recent.length > 0 && (
        <section className="recent">
          <h2>Recent companies</h2>
          <table className="grid">
            <tbody>
              {recent.map((r) => (
                <tr key={r.path} className="clickable" onClick={() => onOpen(r.path)}>
                  <td>
                    <strong>{r.name}</strong>
                    <div className="muted small">{r.path}</div>
                  </td>
                  <td className="muted small nowrap">Opened {formatDate(r.openedAt.slice(0, 10))}</td>
                  <td className="nowrap">
                    <button
                      className="link small"
                      onClick={(e) => {
                        e.stopPropagation()
                        api.removeRecent(r.path).then(() => setRecent(recent.filter((x) => x.path !== r.path)))
                      }}
                    >
                      Remove from list
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}

function NewCompany({ onCancel, onCreated }: { onCancel: () => void; onCreated: (c: OpenCompany | null) => void }): JSX.Element {
  const dialogs = useDialogs()
  const [info, setInfo] = useState<CompanyInfo>({ name: '', legalName: '', address: '', taxId: '', fiscalYearStartMonth: 1 })
  const [template, setTemplate] = useState<TemplateId>('general')
  const [busy, setBusy] = useState(false)

  const create = async (): Promise<void> => {
    if (!info.name.trim()) return void dialogs.alert('Enter the company name.')
    setBusy(true)
    try {
      onCreated(await api.newCompany(info, template))
    } catch (err) {
      dialogs.error(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="welcome">
      <h1>New company</h1>
      <div className="form">
        <CompanyInfoFields info={info} onChange={setInfo} />
        <label>
          Starting chart of accounts
          <select value={template} onChange={(e) => setTemplate(e.target.value as TemplateId)}>
            {(Object.keys(TEMPLATE_LABELS) as TemplateId[]).map((id) => (
              <option key={id} value={id}>
                {TEMPLATE_LABELS[id]}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">You will choose where to save the company file next. Each company is a single file you can copy or back up.</p>
        <div className="buttons">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={busy} onClick={create}>
            Create company…
          </button>
        </div>
      </div>
    </div>
  )
}
