import { useEffect, useState } from 'react'
import { api } from '../api'
import { Modal, useDialogs } from './Dialogs'
import { formatDate } from '../format'
import type { Account, BankImportLog, WatchFolder } from '../../../shared/types'

/** Sets the folder the app watches for this account's bank statements, and shows recent imports. */
export function WatchFolderDialog({
  account,
  current,
  onClose,
  onSaved
}: {
  account: Account
  current: WatchFolder | null
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const dialogs = useDialogs()
  const [folder, setFolder] = useState(current?.folder ?? '')
  const [autoAccept, setAutoAccept] = useState(current?.autoAccept ?? true)
  const [acceptHistory, setAcceptHistory] = useState(current?.acceptHistory ?? false)
  const [log, setLog] = useState<BankImportLog[]>([])

  useEffect(() => {
    void api.listBankImports(account.id).then(setLog).catch(dialogs.error)
  }, [account.id, dialogs])

  const choose = async (): Promise<void> => {
    const picked = await api.chooseFolder().catch(dialogs.error)
    if (picked) setFolder(picked)
  }

  const save = async (settings: Omit<WatchFolder, 'accountId'> | null): Promise<void> => {
    try {
      await api.setWatchFolder(account.id, settings)
      onSaved()
    } catch (err) {
      dialogs.error(err)
    }
  }

  return (
    <Modal
      title={`Watch a folder for ${account.fullName}`}
      wide
      onClose={onClose}
      footer={
        <>
          {current && (
            <button className="danger-outline" onClick={() => void save(null)}>
              Stop watching
            </button>
          )}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!folder} onClick={() => void save({ folder, autoAccept, acceptHistory })}>
            Save
          </button>
        </>
      }
    >
      <div className="form watch-form">
        <p className="muted small">
          Drop CSV files downloaded from the bank into this folder. While this company is open, the app imports each new file
          with the same columns as your last import into {account.name}, skips transactions already imported, and moves the file
          into an <strong>Imported</strong> subfolder. A file it can't read goes into <strong>Needs attention</strong>.
        </p>
        <label>
          Folder
          <div className="row">
            <input readOnly value={folder} placeholder="No folder chosen" />
            <button onClick={choose}>Choose…</button>
          </div>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={autoAccept} onChange={(e) => setAutoAccept(e.target.checked)} />
          Add transactions to the books automatically when a bank rule categorizes them or they match an entry already in the books
        </label>
        <label className="checkbox indent">
          <input type="checkbox" disabled={!autoAccept} checked={autoAccept && acceptHistory} onChange={(e) => setAcceptHistory(e.target.checked)} />
          Also add ones categorized the same as last time for that payee
        </label>
        <p className="muted small">Everything else waits in For Review. Nothing dated on or before the closing date is added automatically.</p>
      </div>

      <h2>Recent imports</h2>
      <div className="preview-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th>Date</th>
              <th>File</th>
              <th>From</th>
              <th className="num">Imported</th>
              <th className="num">Skipped</th>
              <th className="num">Auto-added</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {log.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  Nothing imported into this account yet.
                </td>
              </tr>
            )}
            {log.map((l) => (
              <tr key={l.id}>
                <td className="nowrap">
                  {formatDate(l.importedAt.slice(0, 10))} {new Date(l.importedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </td>
                <td>{l.fileName}</td>
                <td>{l.source === 'folder' ? 'Folder' : 'By hand'}</td>
                <td className="num">{l.imported}</td>
                <td className="num">{l.duplicates || ''}</td>
                <td className="num">{l.source === 'folder' ? l.autoAdded : ''}</td>
                <td className="small">{l.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}
