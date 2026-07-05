import { lazy, Suspense, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  LayoutDashboard,
  TrendingUp,
  Briefcase,
  Heart,
  Footprints,
  Moon,
  HeartPulse,
  CalendarClock,
  Calendar,
  Bookmark,
  MessageSquare,
  Settings,
  X,
} from 'lucide-react'
import BreadLogo from '../icons/BreadLogo'

const RamenScene = lazy(() => import('../anim/RamenScene'))

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/finance', icon: TrendingUp, label: 'Finance' },
  { to: '/portfolio', icon: Briefcase, label: 'Portfolio' },
  { to: '/health', icon: Heart, label: 'Health' },
  { to: '/health/sleep', icon: Moon, label: 'Sleep' },
  { to: '/health/hrv', icon: HeartPulse, label: 'HRV' },
  { to: '/health/exercise', icon: Footprints, label: 'Exercise' },
  { to: '/productivity', icon: CalendarClock, label: 'Productivity' },
  { to: '/weekend', icon: Calendar, label: 'Weekend' },
  { to: '/saved', icon: Bookmark, label: 'Saved' },
  { to: '/chat', icon: MessageSquare, label: 'Chat' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

const EGG_REQUIRED = 5
const EGG_WINDOW_MS = 3000

export default function Sidebar() {
  const [clickCount, setClickCount] = useState(0)
  const [showEgg, setShowEgg] = useState(false)
  const clickTimer = useRef<number | null>(null)

  const onLogoClick = () => {
    if (showEgg) return
    setClickCount((n) => {
      const next = n + 1
      if (clickTimer.current) window.clearTimeout(clickTimer.current)
      clickTimer.current = window.setTimeout(() => setClickCount(0), EGG_WINDOW_MS)
      if (next >= EGG_REQUIRED) {
        if (clickTimer.current) window.clearTimeout(clickTimer.current)
        clickTimer.current = null
        setShowEgg(true)
        return 0
      }
      return next
    })
  }

  const onDismissEgg = () => {
    setShowEgg(false)
    setClickCount(0)
    if (clickTimer.current) {
      window.clearTimeout(clickTimer.current)
      clickTimer.current = null
    }
  }

  return (
    <>
      <nav
        className="w-[68px] hover:w-52 transition-all duration-300 ease-out flex flex-col items-center py-5 gap-0.5 border-r group/sidebar"
        style={{ borderColor: 'var(--separator)', background: 'var(--bg-secondary)' }}
      >
        <div className="mb-4 flex h-11 w-full items-center justify-center overflow-hidden px-0 group-hover/sidebar:justify-start group-hover/sidebar:px-5 transition-[padding] duration-300">
          <BreadLogo size={24} className="shrink-0" animated onClick={onLogoClick} />
          <span
            className="font-display ml-0 max-w-0 overflow-hidden whitespace-nowrap text-lg font-extrabold tracking-wide opacity-0 transition-all duration-300 group-hover/sidebar:ml-3 group-hover/sidebar:max-w-24 group-hover/sidebar:opacity-100"
            style={{ color: 'var(--text-primary)' }}
          >
            Mien
          </span>
        </div>
        <div
          className="w-8 group-hover/sidebar:w-36 mx-auto mb-3 transition-all duration-300"
          style={{ borderBottom: '1px solid var(--separator)' }}
        />
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink key={to} to={to} end={to === '/'} className="relative w-full">
            {({ isActive }) => (
              <div
                className={`relative flex items-center gap-3 px-5 py-2.5 mx-2 rounded-lg transition-all duration-150 text-sm
                  ${isActive ? '' : 'hover:bg-white/[0.05]'}`}
                style={{
                  color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                  background: isActive ? 'var(--accent-soft)' : undefined,
                  boxShadow: isActive ? 'inset 0 0 0 1px var(--accent-soft)' : undefined,
                }}
              >
                {isActive && (
                  <span
                    className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-full"
                    style={{
                      background: 'var(--accent-gradient)',
                      boxShadow: '0 0 8px var(--glow-accent)',
                    }}
                  />
                )}
                <Icon size={20} className="shrink-0" />
                <span className="opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-300 whitespace-nowrap font-medium">
                  {label}
                </span>
              </div>
            )}
          </NavLink>
        ))}
      </nav>

      <AnimatePresence>
        {showEgg && (
          <motion.div
            initial={{ opacity: 0, scale: 0.6, y: 30 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.6, y: 30 }}
            transition={{ type: 'spring', stiffness: 200, damping: 20 }}
            className="fixed bottom-6 right-6 z-50 rounded-2xl overflow-hidden"
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--separator)',
              boxShadow: '0 20px 50px rgba(0,0,0,0.6)',
              pointerEvents: 'auto',
            }}
          >
            <button
              onClick={onDismissEgg}
              className="absolute top-2 right-2 z-10 p-1 rounded transition-opacity hover:opacity-70"
              style={{ color: 'var(--text-muted)' }}
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
            <Suspense
              fallback={
                <div
                  style={{ width: 240, height: 240 }}
                  className="flex items-center justify-center"
                >
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    Boiling water…
                  </div>
                </div>
              }
            >
              <RamenScene size={240} />
            </Suspense>
            <div
              className="absolute bottom-2 left-3 text-[10px] tracking-wide"
              style={{ color: 'var(--text-muted)' }}
            >
              🍜 you found ramen
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
