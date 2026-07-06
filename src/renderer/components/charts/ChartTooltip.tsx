import type { ComponentType } from 'react'
import { Tooltip as RechartsTooltip } from 'recharts'

// Recharts 3 accepts string or number values at the library boundary, while
// Mien's chart formatters intentionally operate on each chart's known data
// shape. Keep that compatibility cast in one place instead of weakening the
// renderer's compiler settings or scattering casts across every formatter.
const ChartTooltip = RechartsTooltip as ComponentType<any>

export default ChartTooltip
