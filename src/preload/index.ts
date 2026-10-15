import { contextBridge, ipcRenderer } from 'electron'
import type { ApiMethod, ApiResult, MenuCommand } from '../shared/api'

const bridge = {
  call: (method: ApiMethod, args: unknown[]): Promise<ApiResult<unknown>> => ipcRenderer.invoke('api', method, args),
  onMenu: (listener: (command: MenuCommand) => void): (() => void) => {
    const handler = (_event: unknown, command: MenuCommand): void => listener(command)
    ipcRenderer.on('menu', handler)
    return () => ipcRenderer.removeListener('menu', handler)
  }
}

contextBridge.exposeInMainWorld('bridge', bridge)

export type Bridge = typeof bridge
