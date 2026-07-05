import { useState, useEffect } from 'react'
import { Moon, ChevronRight, Clock, AlertCircle, CheckCircle } from 'lucide-react'
import NoodleSpinner from '../anim/NoodleSpinner'

interface WakePrediction {
  rangeStart: string
  rangeEnd: string
  optimalPoint: string
  confidence: 'low' | 'medium' | 'high'
  confidenceScore: number
  explanation: {
    sleepDebt: string
    circadianAlignment: string
    consistency: string
    inertiaRisk: string
    summary: string
  }
  signals: {
    estimatedDLMO: string
    processSAtPredictedWake: number
    sleepDebtHours: number
    sleepNeedHours: number
    chronotype: string
    sleepRegularityIndex: number
    habitualWakeTime: string
    habitualSleepOnset: string
    estimatedMSFsc: string
    socialJetLagHours: number
    dataPoints: number
    prcAdjustmentMinutes: number
    inertiaRisk: 'low' | 'medium' | 'high'
    cycleAlignedWakes: string[]
    bindingFloor: 'sleep_need' | 'circadian' | 'consistency'
  }
  dataQuality: 'phone_only' | 'wearable_actigraphy' | 'full_biomarker'
  disclaimer: string
}

function fmt12(t: string): string {
  if (!t || !t.includes(':')) return t
  const [h, m] = t.split(':').map(Number)
  const period = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${period}`
}

const FLOOR_META = {
  sleep_need: { label: 'Sleep Need', color: 'var(--accent-blue)' },
  circadian: { label: 'Body Clock', color: 'var(--accent-purple)' },
  consistency: { label: 'Schedule', color: 'var(--accent-amber)' },
} as const

const CONF_COLOR = {
  high: 'var(--accent-green)',
  medium: 'var(--accent-amber)',
  low: 'var(--accent-red)',
} as const

const INERTIA_COLOR = {
  low: 'var(--accent-green)',
  medium: 'var(--accent-amber)',
  high: 'var(--accent-red)',
} as const

export default function WakePredictionCard() {
  const [prediction, setPrediction] = useState<WakePrediction | null>(null)
  const [loading, setLoading] = useState(true)
  const [showDetails, setShowDetails] = useState(false)

  // Yesterday-outcome prompt
  const [pendingDate, setPendingDate] = useState<string | null>(null)
  const [grogRating, setGrogRating] = useState<number | null>(null)
  const [energyRating, setEnergyRating] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    try {
      const result = await window.api.predictWakeTime()
      setPrediction(result)
      if (result) {
        await window.api.saveWakePrediction(result)
      }
      // Check if yesterday's prediction needs an outcome
      const yest = new Date()
      yest.setDate(yest.getDate() - 1)
      const yestStr = yest.toISOString().split('T')[0]
      const validation = await window.api.validateWakePredictions(2)
      if (validation && validation.withOutcomes === 0 && validation.totalPredictions > 0) {
        setPendingDate(yestStr)
      }
    } catch (err) {
      console.error('[WakePredictionCard] load failed:', err)
    }
    setLoading(false)
  }

  async function submitOutcome() {
    if (!pendingDate || !grogRating) return
    setSubmitting(true)
    try {
      const now = new Date()
      const hh = String(now.getHours()).padStart(2, '0')
      const mm = String(now.getMinutes()).padStart(2, '0')
      await window.api.recordWakeOutcome({
        date: pendingDate,
        actualWakeTime: `${hh}:${mm}`,
        grogginessRating: grogRating,
        energyRating: energyRating ?? undefined,
      })
      setSubmitted(true)
      setPendingDate(null)
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <Moon size={16} style={{ color: 'var(--accent-blue)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            Personalized Wake Window
          </span>
        </div>
        <div className="flex justify-center py-6">
          <NoodleSpinner color="var(--accent-blue)" />
        </div>
      </div>
    )
  }

  if (!prediction) {
    return (
      <div className="card">
        <div className="flex items-center gap-2 mb-3">
          <Moon size={16} style={{ color: 'var(--accent-blue)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            Personalized Wake Window
          </span>
        </div>
        <div className="flex flex-col items-center gap-2 py-6 text-center">
          <AlertCircle size={20} style={{ color: 'var(--text-muted)' }} />
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            At least 5 nights of sleep data needed to generate a personalized prediction.
          </p>
        </div>
      </div>
    )
  }

  const { signals, explanation, confidence, dataQuality } = prediction
  const confColor = CONF_COLOR[confidence]
  const floorMeta = FLOOR_META[signals.bindingFloor]
  const uncertainty =
    dataQuality === 'phone_only'
      ? '±30–45 min'
      : dataQuality === 'wearable_actigraphy'
        ? '±15–30 min'
        : '±10–20 min'

  return (
    <div className="card">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <Moon size={16} style={{ color: 'var(--accent-blue)' }} />
        <span className="text-sm font-medium flex-1" style={{ color: 'var(--text-primary)' }}>
          Personalized Wake Window
        </span>
        <span
          className="text-xs px-2 py-0.5 rounded-full font-medium"
          style={{ background: confColor + '22', color: confColor }}
        >
          {confidence} confidence
        </span>
      </div>

      {/* Main time range */}
      <div className="flex items-baseline gap-3 mb-1">
        <span className="text-4xl font-bold tabular-nums" style={{ color: 'var(--accent-blue)' }}>
          {fmt12(prediction.rangeStart)}
        </span>
        <span className="text-xl" style={{ color: 'var(--text-muted)' }}>
          –
        </span>
        <span className="text-4xl font-bold tabular-nums" style={{ color: 'var(--accent-blue)' }}>
          {fmt12(prediction.rangeEnd)}
        </span>
      </div>
      <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
        Optimal midpoint: {fmt12(prediction.optimalPoint)} · {uncertainty} · {signals.dataPoints}{' '}
        nights analyzed
      </p>

      {/* Three-floor visualization */}
      <div className="mb-4">
        <p className="text-[10px] mb-2" style={{ color: 'var(--text-muted)' }}>
          Binding constraint — latest of three floors:
        </p>
        <div className="grid grid-cols-3 gap-1.5">
          {(['sleep_need', 'circadian', 'consistency'] as const).map((floor) => {
            const meta = FLOOR_META[floor]
            const isBinding = signals.bindingFloor === floor
            return (
              <div
                key={floor}
                className="p-2 rounded-lg text-center"
                style={{
                  background: isBinding ? meta.color + '22' : 'var(--bg-tertiary)',
                  border: `1px solid ${isBinding ? meta.color + '55' : 'transparent'}`,
                }}
              >
                <p
                  className="text-[10px] font-medium mb-0.5"
                  style={{ color: isBinding ? meta.color : 'var(--text-muted)' }}
                >
                  {meta.label}
                </p>
                <p
                  className="text-[10px]"
                  style={{ color: isBinding ? meta.color : 'var(--text-muted)' }}
                >
                  {isBinding ? '▲ binding' : '—'}
                </p>
              </div>
            )
          })}
        </div>
        {floorMeta && (
          <p className="text-[10px] mt-1.5" style={{ color: 'var(--text-secondary)' }}>
            <span style={{ color: floorMeta.color }}>{floorMeta.label}</span> is the limiting factor
            tonight.
          </p>
        )}
      </div>

      {/* Signal grid */}
      <div className="grid grid-cols-4 gap-2 mb-4">
        {[
          {
            label: 'Inertia Risk',
            value: signals.inertiaRisk,
            color: INERTIA_COLOR[signals.inertiaRisk],
          },
          {
            label: 'Est. DLMO',
            value: fmt12(signals.estimatedDLMO),
            color: 'var(--accent-purple)',
          },
          {
            label: 'Sleep Need',
            value: `${signals.sleepNeedHours.toFixed(1)}h`,
            color: 'var(--text-primary)',
          },
          {
            label: 'Regularity',
            value: `${signals.sleepRegularityIndex}/100`,
            color:
              signals.sleepRegularityIndex >= 80
                ? 'var(--accent-green)'
                : signals.sleepRegularityIndex >= 65
                  ? 'var(--accent-amber)'
                  : 'var(--accent-red)',
          },
        ].map(({ label, value, color }) => (
          <div
            key={label}
            className="p-2 rounded-lg text-center"
            style={{ background: 'var(--bg-tertiary)' }}
          >
            <p className="text-[10px] mb-0.5" style={{ color: 'var(--text-muted)' }}>
              {label}
            </p>
            <p className="text-xs font-semibold" style={{ color }}>
              {value}
            </p>
          </div>
        ))}
      </div>

      {/* PRC light note */}
      {Math.abs(signals.prcAdjustmentMinutes) >= 5 && (
        <p className="text-[10px] mb-3 px-1" style={{ color: 'var(--text-muted)' }}>
          {signals.prcAdjustmentMinutes > 0
            ? `☀️ Morning light advancing your clock ~${signals.prcAdjustmentMinutes} min (phase advance)`
            : `🌆 Evening light delaying your clock ~${Math.abs(signals.prcAdjustmentMinutes)} min (phase delay)`}
        </p>
      )}

      {/* Collapsible explanation */}
      <button
        className="w-full text-left flex items-center gap-1.5 mb-2 select-none"
        onClick={() => setShowDetails((v) => !v)}
        style={{ color: 'var(--text-secondary)' }}
      >
        <ChevronRight
          size={12}
          style={{
            transform: showDetails ? 'rotate(90deg)' : 'none',
            transition: 'transform 0.18s',
          }}
        />
        <span className="text-xs">{showDetails ? 'Hide explanation' : 'Why this window?'}</span>
      </button>

      {showDetails && (
        <div className="space-y-2 mb-3">
          {(
            [
              ['Sleep Debt', explanation.sleepDebt, 'var(--accent-amber)'],
              ['Circadian Alignment', explanation.circadianAlignment, 'var(--accent-purple)'],
              ['Consistency', explanation.consistency, 'var(--accent-blue)'],
              ['Inertia Risk', explanation.inertiaRisk, 'var(--accent-green)'],
            ] as const
          ).map(([label, text, color]) => (
            <div
              key={label}
              className="p-2.5 rounded-lg"
              style={{ background: 'var(--bg-tertiary)' }}
            >
              <p className="text-[10px] font-semibold mb-1" style={{ color }}>
                {label}
              </p>
              <p className="text-[10px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                {text}
              </p>
            </div>
          ))}

          {/* 90-min cycle reference */}
          {signals.cycleAlignedWakes.length > 0 && (
            <div className="p-2.5 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
              <div className="flex items-center gap-1.5 mb-1.5">
                <Clock size={10} style={{ color: 'var(--text-muted)' }} />
                <p className="text-[10px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
                  90-min cycle ends
                </p>
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {signals.cycleAlignedWakes.map((t: string) => (
                  <span
                    key={t}
                    className="text-[10px] px-2 py-0.5 rounded"
                    style={{ background: 'var(--bg-primary)', color: 'var(--text-secondary)' }}
                  >
                    {fmt12(t)}
                  </span>
                ))}
              </div>
            </div>
          )}

          <p
            className="text-[10px] italic px-0.5 leading-relaxed"
            style={{ color: 'var(--text-muted)' }}
          >
            {prediction.disclaimer}
          </p>
        </div>
      )}

      {/* Yesterday's outcome prompt */}
      {pendingDate && !submitted && (
        <div
          className="mt-3 p-3 rounded-lg"
          style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}
        >
          <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
            How did yesterday's wake go?
          </p>
          <p className="text-[10px] mb-2" style={{ color: 'var(--text-muted)' }}>
            Grogginess (1 = none, 5 = severe):
          </p>
          <div className="flex gap-1.5 mb-3">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                className="w-7 h-7 rounded text-xs font-medium transition-opacity"
                style={{
                  background: grogRating === n ? 'var(--accent-blue)' : 'var(--bg-primary)',
                  color: grogRating === n ? '#fff' : 'var(--text-secondary)',
                }}
                onClick={() => setGrogRating(n)}
              >
                {n}
              </button>
            ))}
          </div>
          <p className="text-[10px] mb-2" style={{ color: 'var(--text-muted)' }}>
            Energy (1 = exhausted, 5 = great) — optional:
          </p>
          <div className="flex gap-1.5 mb-3">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                className="w-7 h-7 rounded text-xs font-medium transition-opacity"
                style={{
                  background: energyRating === n ? 'var(--accent-green)' : 'var(--bg-primary)',
                  color: energyRating === n ? '#fff' : 'var(--text-secondary)',
                }}
                onClick={() => setEnergyRating(n)}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              className="flex-1 py-1.5 rounded text-xs font-medium"
              style={{
                background: 'var(--accent-blue)',
                color: '#fff',
                opacity: !grogRating || submitting ? 0.5 : 1,
              }}
              disabled={!grogRating || submitting}
              onClick={submitOutcome}
            >
              {submitting ? 'Saving…' : 'Submit'}
            </button>
            <button
              className="px-3 py-1.5 rounded text-xs"
              style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)' }}
              onClick={() => setPendingDate(null)}
            >
              Skip
            </button>
          </div>
        </div>
      )}

      {submitted && (
        <div
          className="mt-3 flex items-center gap-2 p-2.5 rounded-lg"
          style={{ background: 'var(--bg-tertiary)' }}
        >
          <CheckCircle size={12} style={{ color: 'var(--accent-green)' }} />
          <p className="text-[10px]" style={{ color: 'var(--accent-green)' }}>
            Outcome recorded — prediction model will self-correct over time.
          </p>
        </div>
      )}
    </div>
  )
}
