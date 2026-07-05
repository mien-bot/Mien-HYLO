interface ChartLegendItem {
  label: string
  color: string
}

interface GradientLegendProps {
  lowLabel: string
  highLabel: string
  midLabel?: string
  colors: string[]
}

export default function ChartLegend({ items }: { items: ChartLegendItem[] }) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-2 text-[10px]"
      style={{ color: 'var(--text-muted)' }}
    >
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  )
}

export function GradientLegend({ lowLabel, highLabel, midLabel, colors }: GradientLegendProps) {
  return (
    <div className="mt-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
      <div className="flex items-center gap-2">
        <span className="shrink-0">{lowLabel}</span>
        <div
          className="flex-1 h-2 rounded-sm"
          style={{
            background: `linear-gradient(to right, ${colors.join(', ')})`,
            minWidth: 100,
          }}
        />
        <span className="shrink-0">{highLabel}</span>
      </div>
      {midLabel && <div className="text-center opacity-60 mt-0.5">{midLabel}</div>}
    </div>
  )
}

// Sector Exposure: light → dark blue intensity (higher weight = darker)
export const SECTOR_RAMP = ['#0f1a2e', '#1a3a5c', '#0a84ff', '#30d158', '#ffd60a']
export const SECTOR_EXPOSURE_LEGEND_PROPS: GradientLegendProps = {
  lowLabel: '0%',
  highLabel: '100%',
  colors: SECTOR_RAMP,
}

// Correlation: red (−1 inverse) → gray (0 uncorrelated) → green (+1 correlated)
export const CORRELATION_RAMP = ['#ff453a', '#c46a64', '#888888', '#64a87a', '#30d158']
export const CORRELATION_LEGEND_PROPS: GradientLegendProps = {
  lowLabel: 'Inverse (−1)',
  highLabel: 'Correlated (+1)',
  colors: CORRELATION_RAMP,
}

// Sentiment: red (negative) → gray (neutral) → green (positive)
export const SENTIMENT_RAMP = ['#ff453a', '#c46a64', '#888888', '#64a87a', '#30d158']
export const SENTIMENT_LEGEND_PROPS: GradientLegendProps = {
  lowLabel: 'Negative',
  highLabel: 'Positive',
  colors: SENTIMENT_RAMP,
}
