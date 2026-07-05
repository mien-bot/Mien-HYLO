/**
 * Tunnel URL watcher
 *
 * The relay server (relay/server.js) writes its current Cloudflare quick-tunnel
 * URL to relay/tunnel-url.txt whenever it rotates. This service makes that URL
 * visible to the desktop UI in two ways:
 *
 *   1. Local file watcher — if the relay is running on the same machine as the
 *      desktop app, fs.watch picks up changes instantly.
 *   2. HTTP poll of /tunnel-info — works regardless of where the relay runs,
 *      provided relayUrl + relayToken are configured.
 *
 * Both paths emit the same `relay:tunnel-url` IPC event.
 */
import { BrowserWindow, app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getAppSettings } from '../lib/settings'

export interface TunnelUrlState {
  url: string | null
  source: 'file' | 'http' | null
  updatedAt: number | null
}

let state: TunnelUrlState = { url: null, source: null, updatedAt: null }
let fileWatcher: fs.FSWatcher | null = null
let pollTimer: NodeJS.Timeout | null = null
let watchedPath: string | null = null

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('relay:tunnel-url', state)
  }
}

function updateUrl(url: string | null, source: 'file' | 'http'): void {
  const trimmed = url?.trim() || null
  if (trimmed === state.url) return
  state = { url: trimmed, source, updatedAt: Date.now() }
  broadcast()
}

function resolveRelayDir(): string {
  const settings = getAppSettings()
  if (settings?.relayDir) return settings.relayDir
  // Default: <repo-root>/relay, derived from cwd in dev or app path when packaged
  const cwd = process.cwd()
  if (fs.existsSync(path.join(cwd, 'relay', 'server.js'))) {
    return path.join(cwd, 'relay')
  }
  const appPath = app.getAppPath()
  return path.join(appPath, '..', 'relay')
}

function readTunnelFile(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8').trim()
    return content || null
  } catch {
    return null
  }
}

function startFileWatcher(): void {
  const relayDir = resolveRelayDir()
  const filePath = path.join(relayDir, 'tunnel-url.txt')
  watchedPath = filePath

  // Seed initial value if file already exists.
  const initial = readTunnelFile(filePath)
  if (initial) updateUrl(initial, 'file')

  // Watch the *directory* — the file may not exist yet when the relay hasn't
  // generated a tunnel URL, and fs.watch on a missing path throws.
  try {
    if (!fs.existsSync(relayDir)) return
    fileWatcher = fs.watch(relayDir, (_event, fname) => {
      if (fname !== 'tunnel-url.txt') return
      const current = readTunnelFile(filePath)
      if (current) updateUrl(current, 'file')
    })
  } catch (err: any) {
    console.error('[tunnel-url] watcher failed:', err.message)
  }
}

async function pollTunnelInfo(): Promise<void> {
  const settings = getAppSettings()
  const relayUrl = settings?.relayUrl
  const token = settings?.relayToken
  if (!relayUrl) return

  try {
    const url = `${String(relayUrl).replace(/\/$/, '')}/tunnel-info`
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(url, { headers, signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return
    const data = (await res.json()) as { enabled?: boolean; url?: string | null }
    if (data?.url) updateUrl(data.url, 'http')
  } catch {
    // Network failures are expected when the relay is unreachable — ignore.
  }
}

export function initTunnelUrlWatcher(): void {
  startFileWatcher()
  // Poll every 60s for the remote case.
  pollTunnelInfo()
  pollTimer = setInterval(pollTunnelInfo, 60_000)
}

export function shutdownTunnelUrlWatcher(): void {
  if (fileWatcher) {
    fileWatcher.close()
    fileWatcher = null
  }
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

export function getTunnelUrlState(): TunnelUrlState {
  return state
}

export function getWatchedPath(): string | null {
  return watchedPath
}
