import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Cancelled, withClosingOverride } from '../api'
import type { ClosingOverride } from '../../../shared/types'

interface ModalProps {
  title: string
  children: ReactNode
  footer: ReactNode
  onClose: () => void
  wide?: boolean
}

export function Modal({ title, children, footer, onClose, wide }: ModalProps): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-title">{title}</div>
        <div className="modal-body">{children}</div>
        <div className="modal-footer">{footer}</div>
      </div>
    </div>
  )
}

type Request =
  | { kind: 'alert'; title: string; message: string; resolve: () => void }
  | { kind: 'confirm'; title: string; message: string; danger?: boolean; okLabel?: string; resolve: (ok: boolean) => void }
  | { kind: 'prompt'; title: string; message: string; password?: boolean; resolve: (value: string | null) => void }

interface Dialogs {
  alert(message: string, title?: string): Promise<void>
  confirm(message: string, opts?: { title?: string; danger?: boolean; okLabel?: string }): Promise<boolean>
  prompt(message: string, opts?: { title?: string; password?: boolean }): Promise<string | null>
  /** Shows an error unless the user cancelled. */
  error(err: unknown): void
  /** Runs a change that may touch a closed period, prompting as needed. */
  guarded<T>(fn: (override?: ClosingOverride) => Promise<T>): Promise<T>
}

const DialogContext = createContext<Dialogs | null>(null)

export function useDialogs(): Dialogs {
  const ctx = useContext(DialogContext)
  if (!ctx) throw new Error('DialogHost missing')
  return ctx
}

export function DialogHost({ children }: { children: ReactNode }): JSX.Element {
  const [queue, setQueue] = useState<Request[]>([])
  const push = useCallback((r: Request) => setQueue((q) => [...q, r]), [])
  const pop = useCallback(() => setQueue((q) => q.slice(1)), [])

  const dialogs = useMemo<Dialogs>(() => {
    const d: Dialogs = {
      alert: (message, title = 'Bookkeeping') => new Promise((resolve) => push({ kind: 'alert', title, message, resolve })),
      confirm: (message, opts = {}) =>
        new Promise((resolve) => push({ kind: 'confirm', title: opts.title ?? 'Please confirm', message, ...opts, resolve })),
      prompt: (message, opts = {}) =>
        new Promise((resolve) => push({ kind: 'prompt', title: opts.title ?? 'Bookkeeping', message, ...opts, resolve })),
      error: (err) => {
        if (err instanceof Cancelled) return
        void d.alert(err instanceof Error ? err.message : String(err), 'Something needs attention')
      },
      guarded: (fn) =>
        withClosingOverride(
          {
            password: (message) => d.prompt(message, { title: 'Closed period', password: true }),
            confirm: (message) => d.confirm(message, { title: 'Please confirm', okLabel: 'Continue' })
          },
          fn
        )
    }
    return d
  }, [push])

  const current = queue[0]
  return (
    <DialogContext.Provider value={dialogs}>
      {children}
      {current && <DialogView key={queue.length} request={current} done={pop} />}
    </DialogContext.Provider>
  )
}

function DialogView({ request, done }: { request: Request; done: () => void }): JSX.Element {
  const [value, setValue] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])

  const finish = (ok: boolean): void => {
    done()
    if (request.kind === 'alert') request.resolve()
    else if (request.kind === 'confirm') request.resolve(ok)
    else request.resolve(ok ? value : null)
  }

  return (
    <Modal
      title={request.title}
      onClose={() => finish(false)}
      footer={
        <>
          {request.kind !== 'alert' && (
            <button type="button" onClick={() => finish(false)}>
              Cancel
            </button>
          )}
          <button
            type="button"
            autoFocus={request.kind !== 'prompt'}
            className={request.kind === 'confirm' && request.danger ? 'danger' : 'primary'}
            onClick={() => finish(true)}
          >
            {request.kind === 'confirm' ? request.okLabel ?? 'OK' : 'OK'}
          </button>
        </>
      }
    >
      <p className="dialog-message">{request.message}</p>
      {request.kind === 'prompt' && (
        <input
          ref={input}
          type={request.password ? 'password' : 'text'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && finish(true)}
        />
      )}
    </Modal>
  )
}
