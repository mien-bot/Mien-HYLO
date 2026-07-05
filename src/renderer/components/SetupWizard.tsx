import { lazy, Suspense, useState, useEffect } from 'react'
import { Sparkles, ArrowRight, Check, X } from 'lucide-react'

const RamenScene = lazy(() => import('./anim/RamenScene'))

const WIZARD_VERSION = '1.2.0'

type Step = 'welcome' | 'credentials' | 'apis' | 'done'

interface WizardSettings {
  relayUrl?: string
  relayToken?: string
  claudeApiKey?: string
  alphaVantageKey?: string
  ticketmasterApiKey?: string
  googlePlacesKey?: string
  onboardingCompletedVersion?: string
  onboardingDismissed?: boolean
}

interface Props {
  onClose: () => void
}

/**
 * First-run setup wizard. Walks a new user through configuring Claude
 * credentials and optional v1.2 API keys. Shown when
 * appSettings.onboardingCompletedVersion is missing.
 */
export default function SetupWizard({ onClose }: Props) {
  const [step, setStep] = useState<Step>('welcome')
  const [relayUrl, setRelayUrl] = useState('')
  const [relayToken, setRelayToken] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [alphaVantageKey, setAlphaVantageKey] = useState('')
  const [ticketmasterApiKey, setTicketmasterApiKey] = useState('')
  const [googlePlacesKey, setGooglePlacesKey] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.api
      .getSettings('appSettings')
      .then((s: WizardSettings | null) => {
        if (s?.relayUrl) setRelayUrl(s.relayUrl)
        if (s?.relayToken) setRelayToken(s.relayToken)
        if (s?.claudeApiKey) setApiKey(s.claudeApiKey)
        if (s?.alphaVantageKey) setAlphaVantageKey(s.alphaVantageKey)
        if (s?.ticketmasterApiKey) setTicketmasterApiKey(s.ticketmasterApiKey)
        if (s?.googlePlacesKey) setGooglePlacesKey(s.googlePlacesKey)
      })
      .catch((err) => console.warn('[SetupWizard] Failed to load settings:', err))
  }, [])

  const finish = async () => {
    setSaving(true)
    try {
      const current = ((await window.api.getSettings('appSettings')) as WizardSettings | null) || {}
      const next = {
        ...current,
        relayUrl: relayUrl || current.relayUrl || '',
        relayToken: relayToken || current.relayToken || '',
        claudeApiKey: apiKey || current.claudeApiKey || '',
        alphaVantageKey: alphaVantageKey || current.alphaVantageKey || '',
        ticketmasterApiKey: ticketmasterApiKey || current.ticketmasterApiKey || '',
        googlePlacesKey: googlePlacesKey || current.googlePlacesKey || '',
        onboardingCompletedVersion: WIZARD_VERSION,
        onboardingDismissed: true,
      }
      await window.api.setSettings('appSettings', next)
    } catch (err) {
      console.error('Wizard save failed:', err)
    }
    setSaving(false)
    onClose()
  }

  const skip = async () => {
    try {
      const current = ((await window.api.getSettings('appSettings')) as WizardSettings | null) || {}
      await window.api.setSettings('appSettings', {
        ...current,
        onboardingCompletedVersion: WIZARD_VERSION,
      })
    } catch {}
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      role="dialog"
      aria-modal="true"
      aria-label="Setup wizard"
    >
      <div
        className="w-full max-w-lg rounded-2xl p-6 space-y-5 relative"
        style={{ background: 'var(--bg-primary)', border: '1px solid var(--separator)' }}
      >
        <button
          onClick={skip}
          className="absolute top-3 right-3 p-1 rounded transition-colors hover:opacity-70"
          style={{ color: 'var(--text-muted)' }}
          aria-label="Skip setup"
        >
          <X size={16} />
        </button>

        {step === 'welcome' && (
          <>
            <div className="flex justify-center -mt-2 -mb-2">
              <Suspense
                fallback={
                  <div
                    style={{ width: 200, height: 200 }}
                    className="flex items-center justify-center"
                  >
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      Boiling water…
                    </div>
                  </div>
                }
              >
                <RamenScene size={200} />
              </Suspense>
            </div>
            <div className="flex items-center gap-3">
              <Sparkles size={24} style={{ color: 'var(--accent-blue)' }} />
              <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
                Welcome to Mien
              </h2>
            </div>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              Mien is a personal dashboard — sleep, finance, productivity, weekend planning —
              powered by Claude. Everything runs on your own machine. No accounts. No shared
              servers.
            </p>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              Two minutes to get connected. You'll need either a running relay (recommended) or a
              Claude API key. See <code style={{ color: 'var(--accent-blue)' }}>SETUP.md</code> in
              the project folder for relay setup instructions.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={skip}
                className="text-xs px-3 py-1.5 rounded transition-colors"
                style={{ color: 'var(--text-muted)' }}
              >
                Skip — I'll configure later
              </button>
              <button
                onClick={() => setStep('credentials')}
                className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg transition-colors"
                style={{ background: 'var(--accent-blue)', color: 'white' }}
              >
                Get started <ArrowRight size={14} />
              </button>
            </div>
          </>
        )}

        {step === 'credentials' && (
          <>
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              Connect to Claude
            </h2>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Pick either path. If both are configured the relay wins.
            </p>

            <div className="space-y-3">
              <div className="rounded-lg p-3" style={{ background: 'var(--bg-tertiary)' }}>
                <div className="text-xs font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                  Option A — Relay (recommended)
                </div>
                <label className="block text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>
                  Relay URL
                </label>
                <input
                  value={relayUrl}
                  onChange={(e) => setRelayUrl(e.target.value)}
                  placeholder="http://localhost:3456"
                  className="w-full px-2.5 py-1.5 mb-2 rounded text-xs outline-none"
                  style={{
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--separator)',
                    color: 'var(--text-primary)',
                  }}
                />
                <label className="block text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>
                  Relay Bearer Token
                </label>
                <input
                  type="password"
                  value={relayToken}
                  onChange={(e) => setRelayToken(e.target.value)}
                  placeholder="paste from relay/relay.key"
                  className="w-full px-2.5 py-1.5 rounded text-xs outline-none"
                  style={{
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--separator)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>

              <div className="rounded-lg p-3" style={{ background: 'var(--bg-tertiary)' }}>
                <div className="text-xs font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                  Option B — Claude API key (direct)
                </div>
                <label className="block text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>
                  API Key
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-ant-..."
                  className="w-full px-2.5 py-1.5 rounded text-xs outline-none"
                  style={{
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--separator)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>
            </div>

            <div className="flex justify-between gap-2 pt-2">
              <button
                onClick={() => setStep('welcome')}
                className="text-xs px-3 py-1.5 rounded transition-colors"
                style={{ color: 'var(--text-muted)' }}
              >
                Back
              </button>
              <div className="flex gap-2">
                <button
                  onClick={skip}
                  className="text-xs px-3 py-1.5 rounded transition-colors"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Skip
                </button>
                <button
                  onClick={() => setStep('apis')}
                  className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg transition-colors"
                  style={{ background: 'var(--accent-blue)', color: 'white' }}
                >
                  Continue <ArrowRight size={14} />
                </button>
              </div>
            </div>
          </>
        )}

        {step === 'apis' && (
          <>
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              Optional integrations
            </h2>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              All optional. Mien works without these; each unlocks one feature. Add later in
              Settings if you skip.
            </p>

            <div className="space-y-3">
              <div className="rounded-lg p-3" style={{ background: 'var(--bg-tertiary)' }}>
                <div className="text-xs font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                  Alpha Vantage{' '}
                  <span style={{ color: 'var(--text-muted)' }}>
                    · stock fundamentals & earnings
                  </span>
                </div>
                <p className="text-[10px] mb-1.5" style={{ color: 'var(--text-muted)' }}>
                  Free tier: 25 req/day. Grab at alphavantage.co/support/#api-key
                </p>
                <input
                  type="password"
                  value={alphaVantageKey}
                  onChange={(e) => setAlphaVantageKey(e.target.value)}
                  placeholder="paste API key (optional)"
                  className="w-full px-2.5 py-1.5 rounded text-xs outline-none"
                  style={{
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--separator)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>

              <div className="rounded-lg p-3" style={{ background: 'var(--bg-tertiary)' }}>
                <div className="text-xs font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                  Ticketmaster <span style={{ color: 'var(--text-muted)' }}>· weekend events</span>
                </div>
                <p className="text-[10px] mb-1.5" style={{ color: 'var(--text-muted)' }}>
                  Free tier: 5000 req/day. developer.ticketmaster.com
                </p>
                <input
                  type="password"
                  value={ticketmasterApiKey}
                  onChange={(e) => setTicketmasterApiKey(e.target.value)}
                  placeholder="paste API key (optional)"
                  className="w-full px-2.5 py-1.5 rounded text-xs outline-none"
                  style={{
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--separator)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>

              <div className="rounded-lg p-3" style={{ background: 'var(--bg-tertiary)' }}>
                <div className="text-xs font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                  Google Places{' '}
                  <span style={{ color: 'var(--text-muted)' }}>· restaurant discovery</span>
                </div>
                <p className="text-[10px] mb-1.5" style={{ color: 'var(--text-muted)' }}>
                  Paid (small free quota). console.cloud.google.com
                </p>
                <input
                  type="password"
                  value={googlePlacesKey}
                  onChange={(e) => setGooglePlacesKey(e.target.value)}
                  placeholder="paste API key (optional)"
                  className="w-full px-2.5 py-1.5 rounded text-xs outline-none"
                  style={{
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--separator)',
                    color: 'var(--text-primary)',
                  }}
                />
              </div>
            </div>

            <div className="flex justify-between gap-2 pt-2">
              <button
                onClick={() => setStep('credentials')}
                className="text-xs px-3 py-1.5 rounded transition-colors"
                style={{ color: 'var(--text-muted)' }}
              >
                Back
              </button>
              <button
                onClick={() => setStep('done')}
                className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg transition-colors"
                style={{ background: 'var(--accent-blue)', color: 'white' }}
              >
                Continue <ArrowRight size={14} />
              </button>
            </div>
          </>
        )}

        {step === 'done' && (
          <>
            <div className="flex items-center gap-3">
              <Check size={24} style={{ color: 'var(--accent-green)' }} />
              <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>
                You're set
              </h2>
            </div>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              Click the gear icon any time to add Notion, Alpha Vantage, Ticketmaster, or Google
              Places keys. Health data flows in from the Apple Health Auto Export app pointing at
              your relay.
            </p>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              Try the Chat page — type <code style={{ color: 'var(--accent-blue)' }}>/help</code> to
              see what Claude can do here.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setStep('apis')}
                className="text-xs px-3 py-1.5 rounded transition-colors"
                style={{ color: 'var(--text-muted)' }}
              >
                Back
              </button>
              <button
                onClick={finish}
                disabled={saving}
                className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
                style={{ background: 'var(--accent-green)', color: 'white' }}
              >
                {saving ? 'Saving…' : 'Finish'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
