import { lazy, Suspense, useEffect, useState } from 'react'
import { Routes, Route } from 'react-router-dom'
import Shell from './components/layout/Shell'
import ErrorBoundary from './components/ErrorBoundary'
import SetupWizard from './components/SetupWizard'
import LockScreen from './components/LockScreen'
import NoodleSpinner from './components/anim/NoodleSpinner'
import { ToastProvider } from './components/Toast'
import { applyChartPalette } from './lib/chartPalette'
import { applyTheme, applyAccent, applyMotionLevel } from './lib/theme'
import type { ThemePreset, MotionLevel } from './lib/theme'
import type { PaletteName } from './components/charts/tokens'

interface AppSettings {
  onboardingCompletedVersion?: string
  chartPalette?: PaletteName
  uiScale?: string
  themePreset?: ThemePreset
  accentColor?: string
  motionLevel?: MotionLevel
}

// Dashboard loads eagerly — it's the default route on launch. Every other
// page is code-split so heavy deps (recharts, markdown, etc.) ship in
// chunks loaded only when the user navigates there.
import DashboardPage from './pages/DashboardPage'

const FinancePage = lazy(() => import('./pages/FinancePage'))
const PortfolioPage = lazy(() => import('./pages/PortfolioPage'))
const HealthPage = lazy(() => import('./pages/HealthPage'))
const SleepDetailPage = lazy(() => import('./pages/SleepDetailPage'))
const ExerciseDetailPage = lazy(() => import('./pages/exercise/ExerciseDetailPage'))
const ActivityDetailPage = lazy(() => import('./pages/exercise/ActivityDetailPage'))
const HrvDetailPage = lazy(() => import('./pages/HrvDetailPage'))
const HeartRateDetailPage = lazy(() => import('./pages/HeartRateDetailPage'))
const ProductivityPage = lazy(() => import('./pages/ProductivityPage'))
const ChatPage = lazy(() => import('./pages/ChatPage'))
const WeekendPage = lazy(() => import('./pages/weekend/WeekendPage'))
const SavedPage = lazy(() => import('./pages/SavedPage'))
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage'))
const DevChartsPage = import.meta.env.DEV ? lazy(() => import('./pages/_DevChartsPage')) : null

function PageFallback() {
  return (
    <div className="h-full w-full flex items-center justify-center">
      <NoodleSpinner size={96} label="Loading…" />
    </div>
  )
}

type LockState = 'checking' | 'setup' | 'unlock' | 'unlocked'

export default function App() {
  const [showWizard, setShowWizard] = useState(false)
  const [lockState, setLockState] = useState<LockState>('checking')

  useEffect(() => {
    window.api
      .authIsSet()
      .then((isSet) => {
        setLockState(isSet ? 'unlock' : 'setup')
      })
      .catch(() => {
        // If the auth check fails, fall through to setup so the app remains usable.
        setLockState('setup')
      })
  }, [])

  useEffect(() => {
    if (lockState !== 'unlocked') return
    window.api
      .getSettings('appSettings')
      .then((raw) => {
        const s = (raw as AppSettings | null) || {}
        if (!s.onboardingCompletedVersion) setShowWizard(true)
        if (s.chartPalette) applyChartPalette(s.chartPalette as PaletteName)
        if (s.uiScale) window.api.setZoomFactor(parseFloat(s.uiScale))
        applyTheme(s.themePreset || 'ramen')
        if (s.accentColor) applyAccent(s.accentColor)
        applyMotionLevel(s.motionLevel || 'playful')
      })
      .catch((err) => console.warn('[App] Failed to load app settings:', err))
  }, [lockState])

  if (lockState === 'checking') {
    return <PageFallback />
  }

  if (lockState === 'setup' || lockState === 'unlock') {
    return <LockScreen mode={lockState} onUnlocked={() => setLockState('unlocked')} />
  }

  return (
    <ToastProvider>
      <ErrorBoundary>
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route element={<Shell />}>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/finance" element={<FinancePage />} />
              <Route path="/portfolio" element={<PortfolioPage />} />
              <Route path="/health" element={<HealthPage />} />
              <Route path="/health/sleep" element={<SleepDetailPage />} />
              <Route path="/health/exercise" element={<ExerciseDetailPage />} />
              <Route path="/health/exercise/activity/:key" element={<ActivityDetailPage />} />
              <Route path="/health/hrv" element={<HrvDetailPage />} />
              <Route path="/health/heart" element={<HeartRateDetailPage />} />
              <Route path="/productivity" element={<ProductivityPage />} />
              <Route path="/weekend" element={<WeekendPage />} />
              <Route path="/saved" element={<SavedPage />} />
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              {DevChartsPage && <Route path="/_dev/charts" element={<DevChartsPage />} />}
            </Route>
          </Routes>
        </Suspense>
        {showWizard && <SetupWizard onClose={() => setShowWizard(false)} />}
      </ErrorBoundary>
    </ToastProvider>
  )
}
