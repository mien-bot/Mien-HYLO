import { useState } from 'react'
import {
  ChartCard,
  TrendBadge,
  SparklineRow,
  ScoreRing,
  RadialGauge,
  HeatmapChart,
  CalendarHeatmap,
  type HeatmapCell,
  type CalendarPoint,
} from '../components/charts'
import { applyChartPalette } from '../lib/chartPalette'
import type { PaletteName } from '../components/charts/tokens'

const PALETTES: PaletteName[] = [
  'default',
  'colorblind-deuter',
  'colorblind-protan',
  'highcontrast',
]

function buildHeatmapData(rows: number, cols: number, scale = 100): HeatmapCell[][] {
  return Array.from({ length: rows }, (_, j) =>
    Array.from({ length: cols }, (_, i) => ({
      value: Math.round(((Math.sin(i * 0.4 + j * 0.7) + 1) / 2) * scale),
      tooltip: `cell ${i},${j}`,
    })),
  )
}

function buildCalendarData(days: number): CalendarPoint[] {
  const today = new Date()
  const out: CalendarPoint[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const iso = d.toISOString().slice(0, 10)
    const v = Math.round(40 + Math.sin(i * 0.2) * 30 + Math.random() * 30)
    out.push({ date: iso, value: v, tooltip: `${iso}: ${v}` })
  }
  return out
}

export default function DevChartsPage() {
  const [palette, setPalette] = useState<PaletteName>('default')
  const [lastUpdated, setLastUpdated] = useState<number>(Date.now())
  const [range, setRange] = useState(30)
  const [loading, setLoading] = useState(false)

  const handlePalette = (p: PaletteName) => {
    setPalette(p)
    applyChartPalette(p)
  }

  const handleRefresh = async () => {
    setLoading(true)
    await new Promise((r) => setTimeout(r, 600))
    setLastUpdated(Date.now())
    setLoading(false)
  }

  const goodData = [10, 12, 11, 13, 14, 15, 17, 19, 21, 22, 24, 26, 28, 30]
  const badData = [50, 48, 46, 44, 42, 39, 38, 36, 34, 31, 28, 26, 24, 22]
  const flatData = [50, 51, 50, 49, 50, 51, 50, 49, 50, 51]

  const heat = buildHeatmapData(5, 7, 100)
  const sparseHeat: HeatmapCell[][] = [
    [{ value: 0.1 }, { value: 0.5 }, { value: 0.9 }],
    [{ value: -0.4 }, { value: 0.0 }, { value: 0.7 }],
  ]
  const cal30 = buildCalendarData(30)
  const cal90 = buildCalendarData(90)
  const cal365 = buildCalendarData(365)

  return (
    <div
      className="p-6 space-y-6 overflow-y-auto h-full"
      style={{ background: 'var(--bg-primary)' }}
    >
      <header className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
            Chart Library — Dev Preview
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            Tier 1 primitives. Use this page to verify visuals at different breakpoints and
            palettes.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {PALETTES.map((p) => (
            <button
              key={p}
              onClick={() => handlePalette(p)}
              className="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
              style={{
                background: palette === p ? 'var(--accent-blue)' : 'var(--bg-tertiary)',
                color: palette === p ? '#fff' : 'var(--text-secondary)',
              }}
            >
              {p}
            </button>
          ))}
        </div>
      </header>

      <section>
        <h2
          className="text-sm font-semibold uppercase tracking-wider mb-3"
          style={{ color: 'var(--text-muted)' }}
        >
          ChartCard wrapper (with manual refresh)
        </h2>
        <ChartCard
          title="Sleep Quality"
          subtitle="Last 30 nights · synthetic data"
          lastUpdated={lastUpdated}
          loading={loading}
          onRefresh={handleRefresh}
          range={range}
          onRangeChange={setRange}
          rangeOptions={[
            { label: '7D', days: 7 },
            { label: '30D', days: 30 },
            { label: '90D', days: 90 },
          ]}
        >
          <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            Range selected: {range} days. Click the refresh icon — it updates the "last updated"
            badge.
          </div>
        </ChartCard>
      </section>

      <section>
        <h2
          className="text-sm font-semibold uppercase tracking-wider mb-3"
          style={{ color: 'var(--text-muted)' }}
        >
          TrendBadge — improving / declining / stable / inverted
        </h2>
        <div className="flex gap-6 flex-wrap">
          <ChartCard title="Improving (higherIsBetter)" density="compact">
            <TrendBadge data={goodData} unit="h" higherIsBetter />
          </ChartCard>
          <ChartCard title="Declining (higherIsBetter)" density="compact">
            <TrendBadge data={badData} unit="h" higherIsBetter />
          </ChartCard>
          <ChartCard title="Declining (good, e.g. debt)" density="compact">
            <TrendBadge data={badData} unit="h" higherIsBetter={false} />
          </ChartCard>
          <ChartCard title="Stable" density="compact">
            <TrendBadge data={flatData} unit="bpm" />
          </ChartCard>
          <ChartCard title="Empty" density="compact">
            <TrendBadge data={[1, 2]} unit="x" />
          </ChartCard>
        </div>
      </section>

      <section>
        <h2
          className="text-sm font-semibold uppercase tracking-wider mb-3"
          style={{ color: 'var(--text-muted)' }}
        >
          SparklineRow — small inline trend
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <ChartCard title="Increasing" density="compact">
            <SparklineRow data={goodData} strokeColor="var(--accent-green)" fillBelow />
          </ChartCard>
          <ChartCard title="Decreasing" density="compact">
            <SparklineRow data={badData} strokeColor="var(--accent-red)" fillBelow />
          </ChartCard>
          <ChartCard title="Flat" density="compact">
            <SparklineRow data={flatData} strokeColor="var(--accent-blue)" />
          </ChartCard>
          <ChartCard title="Volatile" density="compact">
            <SparklineRow
              data={[10, 30, 5, 25, 15, 40, 12, 35, 8, 28]}
              strokeColor="var(--accent-purple)"
              fillBelow
            />
          </ChartCard>
        </div>
      </section>

      <section>
        <h2
          className="text-sm font-semibold uppercase tracking-wider mb-3"
          style={{ color: 'var(--text-muted)' }}
        >
          ScoreRing — circular 0-100 indicators
        </h2>
        <ChartCard title="Sleep quality components">
          <div className="flex gap-6 flex-wrap items-center">
            <ScoreRing score={87} label="Overall" color="var(--accent-blue)" size={96} />
            <ScoreRing score={72} label="Deep" color="var(--accent-purple)" />
            <ScoreRing score={58} label="REM" color="var(--accent-cyan)" />
            <ScoreRing score={94} label="Efficiency" color="var(--accent-green)" />
            <ScoreRing score={45} label="Consistency" color="var(--accent-amber)" />
            <ScoreRing score={0} label="Empty" color="var(--accent-red)" />
          </div>
        </ChartCard>
      </section>

      <section>
        <h2
          className="text-sm font-semibold uppercase tracking-wider mb-3"
          style={{ color: 'var(--text-muted)' }}
        >
          RadialGauge — single value with zones
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <ChartCard title="Recovery Readiness">
            <div className="flex justify-center">
              <RadialGauge
                value={78}
                min={0}
                max={100}
                label="Ready"
                unit="/100"
                thresholds={[
                  { at: 0, color: 'var(--accent-red)' },
                  { at: 40, color: 'var(--accent-amber)' },
                  { at: 75, color: 'var(--accent-green)' },
                ]}
              />
            </div>
          </ChartCard>
          <ChartCard title="Sleep Debt">
            <div className="flex justify-center">
              <RadialGauge
                value={6.2}
                min={0}
                max={20}
                label="Hours"
                unit="hrs"
                thresholds={[
                  { at: 0, color: 'var(--accent-green)' },
                  { at: 4, color: 'var(--accent-amber)' },
                  { at: 10, color: 'var(--accent-red)' },
                ]}
              />
            </div>
          </ChartCard>
          <ChartCard title="AI Cache Hit Rate">
            <div className="flex justify-center">
              <RadialGauge value={89} min={0} max={100} label="Hit rate" unit="%" size={140} />
            </div>
          </ChartCard>
        </div>
      </section>

      <section>
        <h2
          className="text-sm font-semibold uppercase tracking-wider mb-3"
          style={{ color: 'var(--text-muted)' }}
        >
          HeatmapChart — grid with optional value labels
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ChartCard title="Sector returns by day">
            <HeatmapChart
              data={heat}
              xLabels={['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']}
              yLabels={['Tech', 'Health', 'Energy', 'Cons', 'Fin']}
              cellSize={32}
              showValues
            />
          </ChartCard>
          <ChartCard title="Correlation (small sparse)">
            <HeatmapChart
              data={sparseHeat}
              xLabels={['AAPL', 'GOOG', 'MSFT']}
              yLabels={['NVDA', 'TSLA']}
              cellSize={40}
              valueRange={[-1, 1]}
              showValues
            />
          </ChartCard>
        </div>
      </section>

      <section>
        <h2
          className="text-sm font-semibold uppercase tracking-wider mb-3"
          style={{ color: 'var(--text-muted)' }}
        >
          CalendarHeatmap — 30 / 90 / 365 day windows
        </h2>
        <div className="space-y-4">
          <ChartCard title="30 days — sleep quality">
            <CalendarHeatmap data={cal30} cellSize={16} />
          </ChartCard>
          <ChartCard title="90 days — consistency">
            <CalendarHeatmap data={cal90} cellSize={14} />
          </ChartCard>
          <ChartCard title="365 days — full year">
            <CalendarHeatmap data={cal365} cellSize={11} />
          </ChartCard>
        </div>
      </section>

      <section>
        <h2
          className="text-sm font-semibold uppercase tracking-wider mb-3"
          style={{ color: 'var(--text-muted)' }}
        >
          Empty state behavior
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <ChartCard title="Empty sparkline">
            <SparklineRow data={[]} />
          </ChartCard>
          <ChartCard title="Empty heatmap">
            <HeatmapChart data={[]} xLabels={[]} yLabels={[]} />
          </ChartCard>
          <ChartCard title="Empty calendar">
            <CalendarHeatmap data={[]} />
          </ChartCard>
        </div>
      </section>
    </div>
  )
}
