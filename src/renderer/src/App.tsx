import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './api'
import { useDialogs } from './components/Dialogs'
import type { Nav, View } from './nav'
import type { OpenCompany } from '../../shared/api'
import { Welcome } from './views/Welcome'
import { Home } from './views/Home'
import { Accounts } from './views/Accounts'
import { Entries } from './views/Entries'
import { EntryEditor } from './views/EntryEditor'
import { ReportsMenu, ReportView } from './views/Reports'
import { Settings } from './views/Settings'
import { ReconcileStart, ReconcileWork } from './views/Reconcile'
import { BankFeed } from './views/BankFeed'
import { formatDate } from './format'

const SIDEBAR: { label: string; view: View }[] = [
  { label: 'Home', view: { name: 'home' } },
  { label: 'Chart of Accounts', view: { name: 'accounts' } },
  { label: 'Journal Entries', view: { name: 'entries' } },
  { label: 'Bank Feeds', view: { name: 'bank' } },
  { label: 'Reconcile', view: { name: 'reconcile' } },
  { label: 'Reports', view: { name: 'reports' } },
  { label: 'Company Settings', view: { name: 'settings' } }
]

export function App(): JSX.Element {
  const dialogs = useDialogs()
  const [company, setCompany] = useState<OpenCompany | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [stack, setStack] = useState<View[]>([{ name: 'home' }])
  const [version, setVersion] = useState(0)
  const [showNewCompany, setShowNewCompany] = useState(false)

  useEffect(() => {
    api.current().then((c) => {
      setCompany(c)
      setLoaded(true)
    })
  }, [])

  const opened = useCallback((c: OpenCompany | null) => {
    if (!c) return
    setCompany(c)
    setStack([{ name: 'home' }])
    setVersion((v) => v + 1)
    setShowNewCompany(false)
  }, [])

  const commands = useMemo(
    () => ({
      open: (path?: string) => api.openCompany(path).then(opened).catch(dialogs.error),
      restore: () => api.restoreCompany().then(opened).catch(dialogs.error),
      close: () =>
        api.closeCompany().then(() => {
          setCompany(null)
          setStack([{ name: 'home' }])
        }),
      backup: async () => {
        try {
          const path = await api.backupCompany()
          if (path) await dialogs.alert(`Backup saved to:\n${path}`, 'Backup complete')
        } catch (err) {
          dialogs.error(err)
        }
      }
    }),
    [dialogs, opened]
  )

  useEffect(
    () =>
      window.bridge.onMenu((command) => {
        if (command === 'new') {
          setCompany(null)
          void api.closeCompany()
          setShowNewCompany(true)
        } else if (command === 'open') void commands.open()
        else if (command === 'restore') void commands.restore()
        else if (command === 'close') void commands.close()
        else if (command === 'backup') {
          if (company) void commands.backup()
        }
      }),
    [commands, company]
  )

  const nav: Nav = {
    view: stack[stack.length - 1],
    push: (view) => setStack((s) => [...s, view]),
    go: (view) => setStack([view]),
    back: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    canGoBack: stack.length > 1,
    version,
    changed: () => setVersion((v) => v + 1)
  }

  if (!loaded) return <div className="loading">Loading…</div>

  if (!company) {
    return (
      <Welcome
        showNew={showNewCompany}
        setShowNew={setShowNewCompany}
        onOpened={opened}
        onOpen={commands.open}
        onRestore={commands.restore}
      />
    )
  }

  const view = nav.view
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-company" title={company.path}>
          {company.info.name}
        </div>
        <nav>
          {SIDEBAR.map((item) => {
            const root = stack[0].name
            const active =
              root === item.view.name ||
              (item.view.name === 'reports' && root === 'report') ||
              (item.view.name === 'reconcile' && root === 'reconcileWork')
            return (
              <button key={item.label} className={active ? 'active' : ''} onClick={() => nav.go(item.view)}>
                {item.label}
              </button>
            )
          })}
        </nav>
        <div className="sidebar-footer">
          {company.closing.closingDate && <div className="muted">Closed through {formatDate(company.closing.closingDate)}</div>}
          <button className="link" onClick={commands.backup}>
            Back up company
          </button>
          <button className="link" onClick={commands.close}>
            Close company
          </button>
        </div>
      </aside>
      <main className="content">
        {nav.canGoBack && (
          <button className="back no-print" onClick={nav.back}>
            ‹ Back
          </button>
        )}
        {view.name === 'home' && <Home nav={nav} company={company} />}
        {view.name === 'accounts' && <Accounts nav={nav} />}
        {view.name === 'entries' && <Entries nav={nav} />}
        {view.name === 'entry' && <EntryEditor key={view.id ?? `new-${stack.length}`} nav={nav} id={view.id} />}
        {view.name === 'reports' && <ReportsMenu nav={nav} company={company} />}
        {view.name === 'report' && <ReportView key={JSON.stringify(view.params)} nav={nav} company={company} initial={view.params} />}
        {view.name === 'reconcile' && <ReconcileStart key={view.accountId ?? 'any'} nav={nav} accountId={view.accountId} />}
        {view.name === 'reconcileWork' && <ReconcileWork nav={nav} accountId={view.accountId} />}
        {view.name === 'bank' && <BankFeed key={view.accountId ?? 'any'} nav={nav} accountId={view.accountId} />}
        {view.name === 'settings' && <Settings nav={nav} company={company} onChange={setCompany} />}
      </main>
    </div>
  )
}
