import { app, BrowserWindow, shell, Tray, Menu, nativeImage } from 'electron'
import path from 'path'
import { initDatabase, closeDatabase } from './db/database'
import { registerAllHandlers } from './ipc'
import { initHealthServices, shutdownHealthServices } from './services/health/health-export.service'
import { initScheduler, stopScheduler } from './services/scheduler.service'
import { initTunnelUrlWatcher, shutdownTunnelUrlWatcher } from './services/tunnel-url.service'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
const appWithQuitFlag = app as typeof app & { isQuitting?: boolean }

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'Mien',
    backgroundColor: '#0f0f0f',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.removeMenu()

  let didShowWindow = false
  const showMainWindow = () => {
    if (didShowWindow || !mainWindow) return
    didShowWindow = true
    mainWindow?.show()
  }

  // Show when ready to avoid flash. Also use load/fallback paths because
  // packaged renderer failures can otherwise leave the app running tray-only.
  mainWindow.once('ready-to-show', showMainWindow)
  mainWindow.webContents.once('did-finish-load', showMainWindow)
  setTimeout(showMainWindow, 3000)
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`Renderer failed to load (${errorCode}): ${errorDescription}`)
    showMainWindow()
  })

  // Minimize to tray instead of closing
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Dev server or production build
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function createTray(): void {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '../../resources/icon.ico')
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })

  tray = new Tray(icon)
  tray.setToolTip('Mien — Personal Intelligence Dashboard')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Mien',
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        appWithQuitFlag.isQuitting = true
        app.quit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)

  tray.on('double-click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
}

app.whenReady().then(() => {
  initDatabase()
  registerAllHandlers()
  initHealthServices()
  initScheduler()
  initTunnelUrlWatcher()
  // One-time cleanup: remove HAE workout duplicates where Strava data exists
  try {
    const { dedupStoredWorkouts } = require('./services/health/workout-merge')
    const removed = dedupStoredWorkouts()
    if (removed > 0) console.log(`Deduped ${removed} HAE workout entries (Strava preferred)`)
  } catch {}
  createWindow()
  createTray()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else {
      mainWindow?.show()
    }
  })
})

let didCleanup = false
function runCleanup(): void {
  if (didCleanup) return
  didCleanup = true
  try {
    stopScheduler()
  } catch (e) {
    console.error('Cleanup: stopScheduler failed', e)
  }
  try {
    shutdownHealthServices()
  } catch (e) {
    console.error('Cleanup: shutdownHealthServices failed', e)
  }
  try {
    shutdownTunnelUrlWatcher()
  } catch (e) {
    console.error('Cleanup: shutdownTunnelUrlWatcher failed', e)
  }
  try {
    closeDatabase()
  } catch (e) {
    console.error('Cleanup: closeDatabase failed', e)
  }
}

app.on('before-quit', () => {
  appWithQuitFlag.isQuitting = true
  runCleanup()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
