import { useEffect, useState } from 'react'
import { api } from '../api'
import { Modal, useDialogs } from './Dialogs'
import { canPreview, mimeTypeFor } from '../../../core/attachments'
import type { Attachment, AttachmentTarget } from '../../../shared/types'

const ACCEPT = 'image/*,application/pdf,.pdf,.heic,.txt,.csv,.doc,.docx,.xls,.xlsx,.eml'

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function icon(mimeType: string): string {
  if (mimeType === 'application/pdf') return '📄'
  if (mimeType.startsWith('image/')) return '🧾'
  return '📎'
}

/** Shows one attachment inside the app: images and PDFs are drawn in place; anything else opens in its own program. */
export function AttachmentViewer({ items, start, onClose }: { items: Attachment[]; start: number; onClose: () => void }): JSX.Element {
  const dialogs = useDialogs()
  const [index, setIndex] = useState(start)
  const [url, setUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const item = items[index]
  const previewable = canPreview(item.mimeType)

  useEffect(() => {
    let objectUrl: string | null = null
    setUrl(null)
    setText(null)
    if (!previewable) return
    void api
      .getAttachment(item.id)
      .then((a) => {
        const data = new Uint8Array(a.data)
        if (a.mimeType === 'text/plain') setText(new TextDecoder().decode(data))
        else {
          objectUrl = URL.createObjectURL(new Blob([data], { type: a.mimeType }))
          setUrl(objectUrl)
        }
      })
      .catch(dialogs.error)
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [item.id, item.mimeType, previewable, dialogs])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, items.length - 1))
      if (e.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items.length])

  return (
    <Modal
      title={item.fileName}
      wide
      onClose={onClose}
      footer={
        <>
          {items.length > 1 && (
            <>
              <button disabled={index === 0} onClick={() => setIndex(index - 1)}>
                ‹ Previous
              </button>
              <span className="muted small viewer-count">
                {index + 1} of {items.length}
              </span>
              <button disabled={index === items.length - 1} onClick={() => setIndex(index + 1)}>
                Next ›
              </button>
            </>
          )}
          <span className="spacer" />
          <button onClick={() => void api.saveAttachmentAs(item.id).catch(dialogs.error)}>Save a copy…</button>
          <button onClick={() => void api.openAttachment(item.id).catch(dialogs.error)}>Open in default app</button>
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="viewer">
        {!previewable && (
          <p className="muted">
            This kind of file can't be shown here. Use <strong>Open in default app</strong> to view it.
          </p>
        )}
        {previewable && url === null && text === null && <p className="muted">Loading…</p>}
        {url && item.mimeType === 'application/pdf' && <iframe title={item.fileName} src={`${url}#navpanes=0`} className="viewer-pdf" />}
        {url && item.mimeType.startsWith('image/') && <img src={url} alt={item.fileName} className="viewer-image" />}
        {text !== null && <pre className="viewer-text">{text}</pre>}
      </div>
    </Modal>
  )
}

/**
 * The receipts attached to a transaction: click one to view it, drop files
 * here or use the button to attach more. With `target` null (a new, unsaved
 * entry), files are held in `pending` until the caller saves them.
 */
export function AttachmentList({
  target,
  pending,
  onPendingChange,
  onChange,
  disabled
}: {
  target: AttachmentTarget | null
  pending?: File[]
  onPendingChange?: (files: File[]) => void
  onChange?: () => void
  disabled?: boolean
}): JSX.Element {
  const dialogs = useDialogs()
  const [items, setItems] = useState<Attachment[]>([])
  const [viewing, setViewing] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const key = target ? JSON.stringify(target) : null

  const load = (): void => {
    if (target) void api.listAttachments(target).then(setItems).catch(dialogs.error)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [key])

  const add = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    if (!target) {
      onPendingChange?.([...(pending ?? []), ...files])
      return
    }
    try {
      for (const f of files) await api.addAttachment(target, f.name, new Uint8Array(await f.arrayBuffer()))
    } catch (err) {
      dialogs.error(err)
    }
    load()
    onChange?.()
  }

  const remove = async (a: Attachment): Promise<void> => {
    if (!(await dialogs.confirm(`Remove ${a.fileName} from this transaction?`, { okLabel: 'Remove', danger: true }))) return
    await api.deleteAttachment(a.id).catch(dialogs.error)
    load()
    onChange?.()
  }

  return (
    <div
      className={`attachments ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if (disabled) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (!disabled) void add([...e.dataTransfer.files])
      }}
    >
      {items.map((a, i) => (
        <span key={a.id} className="attachment-chip">
          <button className="link" title="View" onClick={() => setViewing(i)}>
            {icon(a.mimeType)} {a.fileName}
          </button>
          <span className="muted small">{formatSize(a.size)}</span>
          {!disabled && (
            <button className="icon" title="Remove" onClick={() => void remove(a)}>
              ×
            </button>
          )}
        </span>
      ))}
      {(pending ?? []).map((f, i) => (
        <span key={`p${i}`} className="attachment-chip pending" title="Attached when you save">
          {icon(f.type || mimeTypeFor(f.name))} {f.name}
          <span className="muted small">{formatSize(f.size)}</span>
          <button className="icon" title="Remove" onClick={() => onPendingChange?.((pending ?? []).filter((_, j) => j !== i))}>
            ×
          </button>
        </span>
      ))}
      {!disabled && (
        <label className="attach-button">
          <input
            type="file"
            multiple
            accept={ACCEPT}
            onChange={(e) => {
              void add([...(e.target.files ?? [])])
              e.target.value = ''
            }}
          />
          <span>📎 Attach receipt…</span>
        </label>
      )}
      {items.length === 0 && (pending ?? []).length === 0 && <span className="muted small">No receipts attached. You can also drop files here.</span>}
      {viewing !== null && items[viewing] && <AttachmentViewer items={items} start={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}

/** A dialog with a transaction's receipts, opened from a paperclip in a list. */
export function AttachmentsDialog({
  title,
  target,
  onClose,
  onChange
}: {
  title: string
  target: AttachmentTarget
  onClose: () => void
  onChange?: () => void
}): JSX.Element {
  return (
    <Modal
      title={title}
      onClose={onClose}
      wide
      footer={
        <button className="primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <AttachmentList target={target} onChange={onChange} />
    </Modal>
  )
}
