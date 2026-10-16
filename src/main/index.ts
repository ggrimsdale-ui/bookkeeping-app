import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { addAttachment, deleteAttachment, getAttachment, listAttachments } from '../core/attachments'
import initSqlJs from 'sql.js'
import type { SqlJsStatic } from 'sql.js'
import { ClosedPeriodError, Company, ReconciledChangeError } from '../core/company'
import { isDebitNormal } from '../core/accountTypes'
import { reportToCsv } from '../core/exportReport'
import { enterOpeningBalances } from '../core/openingBalances'
import { balancesAsOf, buildReport } from '../core/reports'
import {
  discardReconcile,
  finishReconcile,
  listReconciliations,
  reconcileSession,
  setMarked,
  startReconcile,
  undoLastReconciliation
} from '../core/reconcile'
import {
  acceptBankTransactions,
  applyRules,
  bankCounts,
  deleteBankTransactions,
  deleteRule,
  excludeBankTransactions,
  getCsvMapping,
  importBankRows,
  listBankTransactions,
  listRules,
  saveRule,
  undoBankTransactions,
  updateBankTransactions
} from '../core/bankFeed'
import type { Api, ApiMethod, ApiResult, MenuCommand, OpenCompany } from '../shared/api'
import { getWatchFolder, listBankImports, setWatchFolder } from '../core/autoImport'
import { reportToXlsx } from './excel'
import { scanWatchFolders } from './watcher'
import { addRecent, readFileBytes, readRecent, removeRecent, writeFileAtomic } from './files'

const COMPANY_FILTER = { name: 'Bookkeeping Company File', extensions: ['books'] }
const BACKUP_FILTER = { name: 'Bookkeeping Backup', extensions: ['booksbak'] }

let SQL: SqlJsStatic
let window: BrowserWindow | null = null
let session: { company: Company; path: string } | null = null

/** How often watched folders are checked while a company is open. */
const WATCH_INTERVAL_MS = 15000
setInterval(() => checkFolders(), WATCH_INTERVAL_MS)

/** Imports any new files from the open company's watched folders and tells the UI to refresh. */
function checkFolders(): number {
  if (!session) return 0
  let handled = 0
  try {
    handled = scanWatchFolders(session.company)
  } catch (err) {
    console.error('Watched folder check failed:', err)
  }
  if (handled > 0) {
    save()
    sendMenu('refresh')
  }
  return handled
}

function requireCompany(): Company {
  if (!session) throw new Error('No company is open.')
  return session.company
}

/** Writes the in-memory database to disk. Called after every change. */
function save(): void {
  if (session) writeFileAtomic(session.path, session.company.export())
}

function describe(): OpenCompany | null {
  if (!session) return null
  return { path: session.path, info: session.company.getInfo(), closing: session.company.getClosing() }
}

function openPath(path: string): OpenCompany {
  const company = Company.open(SQL, readFileBytes(path))
  session?.company.close()
  session = { company, path }
  addRecent(path, company.getInfo().name)
  updateTitle()
  // Pick up statements dropped in while the company was closed.
  setTimeout(() => checkFolders(), 1000)
  return describe()!
}

function updateTitle(): void {
  window?.setTitle(session ? `${session.company.getInfo().name} - Bookkeeping` : 'Bookkeeping')
}

function mutate<T>(fn: (c: Company) => T): T {
  const result = fn(requireCompany())
  save()
  return result
}

const handlers: { [K in ApiMethod]: (...args: Parameters<Api[K]>) => ReturnType<Api[K]> | Promise<ReturnType<Api[K]>> } = {
  recentCompanies: () => readRecent(),
  current: () => describe(),

  async newCompany(info, template) {
    const result = await dialog.showSaveDialog(window!, {
      title: 'Save new company file',
      defaultPath: `${info.name.replace(/[\\/:*?"<>|]/g, '').trim() || 'Company'}.books`,
      filters: [COMPANY_FILTER]
    })
    if (result.canceled || !result.filePath) return null
    const company = Company.create(SQL, info, template)
    writeFileAtomic(result.filePath, company.export())
    company.close()
    return openPath(result.filePath)
  },

  async openCompany(path) {
    if (!path) {
      const result = await dialog.showOpenDialog(window!, { title: 'Open company file', filters: [COMPANY_FILTER], properties: ['openFile'] })
      if (result.canceled || result.filePaths.length === 0) return null
      path = result.filePaths[0]
    }
    return openPath(path)
  },

  closeCompany() {
    session?.company.close()
    session = null
    updateTitle()
  },

  async backupCompany() {
    const company = requireCompany()
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
    const result = await dialog.showSaveDialog(window!, {
      title: 'Back up company file',
      defaultPath: `${company.getInfo().name} ${stamp}.booksbak`,
      filters: [BACKUP_FILTER]
    })
    if (result.canceled || !result.filePath) return null
    writeFileAtomic(result.filePath, company.export())
    return result.filePath
  },

  async restoreCompany() {
    const source = await dialog.showOpenDialog(window!, {
      title: 'Choose a backup to restore',
      filters: [BACKUP_FILTER, COMPANY_FILTER],
      properties: ['openFile']
    })
    if (source.canceled || source.filePaths.length === 0) return null
    const bytes = readFileBytes(source.filePaths[0])
    // Validate before asking where to put it.
    const restored = Company.open(SQL, bytes)
    const name = restored.getInfo().name
    restored.close()
    const target = await dialog.showSaveDialog(window!, {
      title: 'Save restored company file as',
      defaultPath: `${name} (restored).books`,
      filters: [COMPANY_FILTER]
    })
    if (target.canceled || !target.filePath) return null
    if (session?.path === target.filePath) throw new Error('Close the company before restoring over its file.')
    writeFileAtomic(target.filePath, bytes)
    return openPath(target.filePath)
  },

  removeRecent: (path) => removeRecent(path),

  updateInfo(info) {
    mutate((c) => c.updateInfo(info))
    addRecent(session!.path, info.name)
    updateTitle()
    return describe()!
  },

  setClosing(closingDate, newPassword, currentPassword) {
    mutate((c) => c.setClosing(closingDate, newPassword, currentPassword))
    return describe()!
  },

  listAccounts: () => requireCompany().listAccounts(),

  accountBalances(asOf) {
    const company = requireCompany()
    const accounts = company.listAccounts()
    const { debit } = balancesAsOf(company, accounts, asOf)
    const result: Record<number, number> = {}
    for (const a of accounts) {
      const d = debit.get(a.id) ?? 0
      result[a.id] = (isDebitNormal(a.type) ? d : -d) || 0
    }
    return result
  },

  createAccount: (input) => mutate((c) => c.createAccount(input)),
  updateAccount: (id, input) => mutate((c) => c.updateAccount(id, input)),
  setAccountActive: (id, active) => mutate((c) => c.setAccountActive(id, active)),
  deleteAccount: (id) => mutate((c) => c.deleteAccount(id)),
  enterOpeningBalances: (date, balances, override) => mutate((c) => enterOpeningBalances(c, date, balances, override)),

  listEntries: (filter) => requireCompany().listEntries(filter),
  getEntry: (id) => requireCompany().getEntry(id),
  nextRef: () => requireCompany().nextRef(),
  createEntry: (input, override) => mutate((c) => c.createEntry(input, override)),
  updateEntry: (id, input, override) => mutate((c) => c.updateEntry(id, input, override)),
  voidEntry: (id, override) => mutate((c) => c.voidEntry(id, override)),
  deleteEntry: (id, override) => mutate((c) => c.deleteEntry(id, override)),

  reconcileSession: (accountId) => reconcileSession(requireCompany(), accountId),
  startReconcile: (input, override) => mutate((c) => startReconcile(c, input, override)),
  setReconcileMarked: (accountId, lineIds, marked) =>
    mutate((c) => {
      setMarked(c, accountId, lineIds, marked)
      return reconcileSession(c, accountId)
    }),
  discardReconcile: (accountId) => mutate((c) => discardReconcile(c, accountId)),
  finishReconcile: (accountId, adjust, override) => mutate((c) => finishReconcile(c, accountId, adjust, override)),
  undoLastReconciliation: (accountId) => mutate((c) => undoLastReconciliation(c, accountId)),
  listReconciliations: (accountId) => listReconciliations(requireCompany(), accountId),

  bankCounts: (accountId) => bankCounts(requireCompany(), accountId),
  listBankTransactions: (accountId, tab) => listBankTransactions(requireCompany(), accountId, tab),
  getCsvMapping: (accountId) => getCsvMapping(requireCompany(), accountId),
  importBankRows: (accountId, fileName, rows, mapping) => mutate((c) => importBankRows(c, accountId, fileName, rows, mapping)),
  updateBankTransactions: (ids, patch) => mutate((c) => updateBankTransactions(c, ids, patch)),
  acceptBankTransactions: (ids, override) => mutate((c) => acceptBankTransactions(c, ids, override)),
  excludeBankTransactions: (ids, excluded) => mutate((c) => excludeBankTransactions(c, ids, excluded)),
  undoBankTransactions: (ids, override) => mutate((c) => undoBankTransactions(c, ids, override)),
  deleteBankTransactions: (ids) => mutate((c) => deleteBankTransactions(c, ids)),
  applyBankRules: (accountId) => mutate((c) => applyRules(c, accountId)),
  listBankRules: () => listRules(requireCompany()),
  saveBankRule: (id, input) => mutate((c) => saveRule(c, id, input)),
  deleteBankRule: (id) => mutate((c) => deleteRule(c, id)),
  listBankImports: (accountId) => listBankImports(requireCompany(), accountId),
  getWatchFolder: (accountId) => getWatchFolder(requireCompany(), accountId),
  setWatchFolder(accountId, settings) {
    if (settings && !existsSync(settings.folder)) throw new Error(`Folder not found: ${settings.folder}`)
    mutate((c) => setWatchFolder(c, accountId, settings))
    setTimeout(() => checkFolders(), 500)
    return getWatchFolder(requireCompany(), accountId)
  },
  async chooseFolder() {
    const result = await dialog.showOpenDialog(window!, { title: 'Choose a folder to watch for bank statements', properties: ['openDirectory', 'createDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  },
  checkWatchFolders: () => checkFolders(),

  listAttachments: (target) => listAttachments(requireCompany(), target),
  addAttachment: (target, fileName, data) => mutate((c) => addAttachment(c, target, fileName, new Uint8Array(data))),
  getAttachment: (id) => getAttachment(requireCompany(), id),
  deleteAttachment: (id) => mutate((c) => deleteAttachment(c, id)),
  async openAttachment(id) {
    const a = getAttachment(requireCompany(), id)
    // A copy in the temp folder; the original stays inside the company file.
    const dir = join(app.getPath('temp'), 'bookkeeping-attachments', String(id))
    mkdirSync(dir, { recursive: true })
    const path = join(dir, a.fileName)
    writeFileAtomic(path, a.data)
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  },
  async saveAttachmentAs(id) {
    const a = getAttachment(requireCompany(), id)
    const result = await dialog.showSaveDialog(window!, { title: 'Save attachment', defaultPath: a.fileName })
    if (result.canceled || !result.filePath) return null
    writeFileAtomic(result.filePath, a.data)
    return result.filePath
  },

  report: (params) => buildReport(requireCompany(), params),

  async exportReport(params, format) {
    const report = buildReport(requireCompany(), params)
    const base = `${report.companyName} ${report.title}`.replace(/[\\/:*?"<>|&]/g, '').trim()
    const filters = {
      csv: { name: 'CSV', extensions: ['csv'] },
      xlsx: { name: 'Excel Workbook', extensions: ['xlsx'] },
      pdf: { name: 'PDF', extensions: ['pdf'] }
    }
    const result = await dialog.showSaveDialog(window!, {
      title: 'Export report',
      defaultPath: `${base}.${format}`,
      filters: [filters[format]]
    })
    if (result.canceled || !result.filePath) return null
    if (format === 'csv') writeFileAtomic(result.filePath, Buffer.from('﻿' + reportToCsv(report), 'utf8'))
    else if (format === 'xlsx') writeFileAtomic(result.filePath, await reportToXlsx(report))
    else {
      // The renderer's print stylesheet shows only the report.
      const pdf = await window!.webContents.printToPDF({
        printBackground: false,
        pageSize: 'Letter',
        landscape: report.columns.length > 4,
        margins: { marginType: 'default' }
      })
      writeFileAtomic(result.filePath, pdf)
    }
    shell.showItemInFolder(result.filePath)
    return result.filePath
  },

  printReport() {
    window?.webContents.print({ printBackground: false })
  }
}

function registerIpc(): void {
  ipcMain.handle('api', async (_event, method: ApiMethod, args: unknown[]): Promise<ApiResult<unknown>> => {
    try {
      const fn = handlers[method] as (...a: unknown[]) => unknown
      if (!fn) throw new Error(`Unknown method ${method}`)
      return { ok: true, value: await fn(...args) }
    } catch (err) {
      if (err instanceof ClosedPeriodError) {
        return { ok: false, error: err.message, closedPeriod: { closingDate: err.closingDate, needsPassword: err.needsPassword } }
      }
      if (err instanceof ReconciledChangeError) return { ok: false, error: err.message, reconciledChange: true }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

function sendMenu(command: MenuCommand): void {
  window?.webContents.send('menu', command)
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Company…', accelerator: 'CmdOrCtrl+Shift+N', click: () => sendMenu('new') },
        { label: 'Open Company…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open') },
        { label: 'Close Company', click: () => sendMenu('close') },
        { type: 'separator' },
        { label: 'Back Up Company…', click: () => sendMenu('backup') },
        { label: 'Restore Backup…', click: () => sendMenu('restore') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'Bookkeeping',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })
  window.once('ready-to-show', () => window?.show())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  if (process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else window.loadFile(join(__dirname, '../renderer/index.html'))
  window.on('closed', () => {
    window = null
  })
}

app.whenReady().then(async () => {
  SQL = await initSqlJs()
  registerIpc()
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  session?.company.close()
  session = null
  if (process.platform !== 'darwin') app.quit()
})
