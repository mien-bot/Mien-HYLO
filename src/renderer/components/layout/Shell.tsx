import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import TunnelUrlBanner from './TunnelUrlBanner'

export default function Shell() {
  const location = useLocation()
  // The Chat page owns its own internal scrolling (message pane scrolls, sidebar
  // stays pinned). Letting <main> scroll here would drag the chat sidebar out of
  // view, so give the chat route a definite, non-scrolling height instead.
  const isChat = location.pathname === '/chat'

  // Keyboard zoom: Ctrl+= / Ctrl+- / Ctrl+0
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      const key = e.key
      if (key === '=' || key === '+') {
        e.preventDefault()
        const next = Math.min(1.6, window.api.getZoomFactor() + 0.05)
        window.api.setZoomFactor(next)
        window.api.setSettings('appSettings.uiScale', next.toFixed(2))
      } else if (key === '-') {
        e.preventDefault()
        const next = Math.max(0.7, window.api.getZoomFactor() - 0.05)
        window.api.setZoomFactor(next)
        window.api.setSettings('appSettings.uiScale', next.toFixed(2))
      } else if (key === '0') {
        e.preventDefault()
        window.api.setZoomFactor(1.0)
        window.api.setSettings('appSettings.uiScale', '1.00')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div
      className="flex h-screen w-screen overflow-hidden"
      style={{ background: 'var(--bg-primary)' }}
    >
      <Sidebar />
      <div className="flex flex-col flex-1 overflow-hidden">
        <TopBar />
        <TunnelUrlBanner />
        <main
          className={`flex-1 p-6 relative ${isChat ? 'overflow-hidden' : 'overflow-y-auto'}`}
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className={isChat ? 'h-full' : 'min-h-full'}
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
          <SteamWisp routeKey={location.pathname} />
        </main>
      </div>
    </div>
  )
}

// Three faint ellipses rising in the top-right corner each route change.
// Decorative only; pointer-events: none so it never blocks clicks.
function SteamWisp({ routeKey }: { routeKey: string }) {
  return (
    <div className="pointer-events-none absolute top-2 right-6">
      <AnimatePresence>
        <motion.svg
          key={routeKey}
          width={32}
          height={40}
          viewBox="0 0 32 40"
          fill="none"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {[0, 1, 2].map((i) => (
            <motion.ellipse
              key={i}
              cx={10 + i * 6}
              cy={32}
              rx={2}
              ry={3}
              stroke="rgba(255,255,255,0.35)"
              strokeWidth={1}
              fill="none"
              initial={{ y: 0, opacity: 0, scale: 0.6 }}
              animate={{ y: -28, opacity: [0, 0.7, 0], scale: [0.6, 1.3, 1.7] }}
              transition={{ duration: 1.4, delay: i * 0.18, ease: 'easeOut' }}
            />
          ))}
        </motion.svg>
      </AnimatePresence>
    </div>
  )
}
