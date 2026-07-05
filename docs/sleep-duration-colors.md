# Sleep Duration Color Scale

Canonical color mapping for all sleep duration visualizations across desktop and mobile. Balanced scale: red (poor) through neutral slate (adequate) to blue (good) with purple for oversleep.

## Color Ramp

| Range | Hex | Name | Usage |
|-------|-----|------|-------|
| ≤4h | `#7f1d1d` | Dark red | Poor sleep |
| 4–5h | `#dc2626` | Red | Low sleep |
| 5–6h | `#f59e0b` | Amber | Below target |
| 6–7h | `#64748b` | Slate | Adequate |
| 7–8h | `#3b82f6` | Blue | Good |
| 8–9h | `#1d4ed8` | Deep blue | Ideal |
| 9h+ | `#7c3aed` | Purple | Plenty / oversleep |

## Heatmap Ramp Array

```typescript
['#7f1d1d', '#dc2626', '#f59e0b', '#64748b', '#3b82f6', '#1d4ed8', '#7c3aed']
```

7 stops. CalendarHeatmap `valueScale="sleep-hours"` maps hours to ramp position:

| Hours | t (0–1) |
|-------|---------|
| ≤4 | 0.0 |
| 5 | 1/6 |
| 6 | 2/6 |
| 7 | 3/6 |
| 8 | 4/6 |
| 9 | 5/6 |
| 10+ | 1.0 |

## sleepDurationColor Function (bar charts)

```typescript
function sleepDurationColor(hours: number): string {
  if (hours <= 4) return '#7f1d1d'
  if (hours < 5) return '#dc2626'
  if (hours < 6) return '#f59e0b'
  if (hours < 7) return '#64748b'
  if (hours < 8) return '#3b82f6'
  if (hours < 9) return '#1d4ed8'
  return '#7c3aed'
}
```

## Legend

```
≤4h  [#7f1d1d] [#dc2626] [#f59e0b] [#64748b] [#3b82f6] [#1d4ed8] [#7c3aed]  9h+
```

Threshold labels: `5 / 6 / 7 / 8h`

## Where It's Used

### Desktop
- `src/renderer/components/charts/CalendarHeatmap.tsx` — `normalizeValue` sleep-hours scale
- `src/renderer/pages/DashboardPage.tsx` — sleep consistency heatmap
- `src/renderer/pages/HealthPage.tsx` — sleep consistency heatmap
- `src/renderer/pages/SleepDetailPage.tsx` — `sleepDurationColor()` for bar chart + legend

### Mobile
- `mobile/src/components/charts/CalendarHeatmap.tsx` — `normalizeValue` sleep-hours scale
- `mobile/src/screens/DashboardScreen.tsx` — sleep consistency heatmap + legend
- `mobile/src/screens/HealthScreen.tsx` — `SleepBarChart` bar colors + legend
- `mobile/src/screens/SleepHistoryScreen.tsx` — bar chart colors + nightly log text colors

## Rules

1. Never use green in the sleep duration scale.
2. All sleep charts on both platforms must use these exact hex values.
3. Bar charts use the discrete `sleepDurationColor` thresholds.
4. Heatmaps use the 7-stop ramp with `valueScale="sleep-hours"`.
5. Legends should show thresholds: `≤4h` on the left, `9h+` on the right.
6. When adding a new sleep duration visualization, reference this file.
