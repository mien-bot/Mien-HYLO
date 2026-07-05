export type Density = 'compact' | 'comfortable'

export interface RangeOption {
  label: string
  days: number
}

export interface ChartCardProps {
  title: string
  subtitle?: string
  lastUpdated?: number | null
  onRefresh?: () => void | Promise<void>
  loading?: boolean
  range?: number
  onRangeChange?: (days: number) => void
  rangeOptions?: RangeOption[]
  actions?: React.ReactNode
  density?: Density
  className?: string
  children: React.ReactNode
}

export interface TrendBadgeProps {
  data: number[]
  unit?: string
  higherIsBetter?: boolean
  window?: 'wk' | 'day'
  compact?: boolean
}

export interface SparklineRowProps {
  data: number[]
  height?: number
  width?: number | string
  strokeColor?: string
  fillBelow?: boolean
  showDots?: boolean
}

export interface ScoreRingProps {
  score: number
  label?: string
  color?: string
  size?: number
  thickness?: number
  subtext?: string
  max?: number
}

export interface RadialGaugeProps {
  value: number
  min?: number
  max?: number
  label?: string
  unit?: string
  thresholds?: Array<{ at: number; color: string }>
  size?: number
  thickness?: number
}

export interface HeatmapCell {
  value: number | null
  label?: string
  tooltip?: string
}

export interface HeatmapChartProps {
  data: HeatmapCell[][]
  xLabels: string[]
  yLabels: string[]
  valueRange?: [number, number]
  colorRamp?: string[]
  cellSize?: number
  showValues?: boolean
  showLabels?: boolean
  rotateXLabels?: boolean
  onCellClick?: (x: number, y: number, cell: HeatmapCell) => void
}

export interface CalendarPoint {
  date: string
  value: number | null
  tooltip?: string
}

export interface CalendarHeatmapProps {
  data: CalendarPoint[]
  valueRange?: [number, number]
  valueScale?: 'linear' | 'sleep-hours'
  colorRamp?: string[]
  cellSize?: number
  startWeekOn?: 0 | 1
  collapseEmptyWeeks?: boolean
  showMonthLabels?: boolean
  showLegend?: boolean
  legendValueLabel?: string
  legendLessLabel?: string
  legendMoreLabel?: string
  legendSwatchLabels?: string[]
  onClick?: (point: CalendarPoint) => void
}
