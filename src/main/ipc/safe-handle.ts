import { ipcMain } from 'electron'

export function safeHandle(channel: string, handler: (...args: any[]) => any) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await handler(...args)
    } catch (err) {
      console.error(`[IPC:${channel}]`, err)
      throw err
    }
  })
}
