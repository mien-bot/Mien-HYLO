# Sleep Consistency Heatmap — Monday-on-Top Weekday Order

## Symptom

The **Sleep Consistency** heatmap (Health page + Dashboard) showed weekday rows
starting with **Sunday** on top (`S M T W T F S`) when it should start with
**Monday** on top (`M T W T F S S`). This had been fixed before and then
"reverted again."

## Root Cause

The `CalendarHeatmap` component takes a `startWeekOn` prop:

- `startWeekOn={0}` → Sunday on top
- `startWeekOn={1}` → Monday on top

Monday-on-top depends entirely on the **explicit prop** being passed at the call
site, because the desktop component's *default* was `startWeekOn = 0` (Sunday).
The mobile component already defaulted to `1`.

The order got silently clobbered by a regression in a later commit:

| Commit | Date | What it did |
|--------|------|-------------|
| `807d538` "CalendarHeatmap: Mon on top, year labels, legend tooltips…" | 2026-05-17 | **Set** `startWeekOn={1}` on both Health + Dashboard heatmaps (Monday on top) |
| `9f911b0` "Improve sync reliability and mobile smoothness" | 2026-05-26 | **Reverted** both back to `startWeekOn={0}` (Sunday on top) — the regression |

Because `9f911b0` reintroduced `startWeekOn={0}` and the component default was
also `0`, nothing was left to keep Monday on top, so the heatmap fell back to
Sunday-first. This is the classic "stale file overwrite" pattern — a later commit
committed an older snapshot of `HealthPage.tsx` / `DashboardPage.tsx` that
predated the Monday change.

## The Fix

Three changes (all on desktop):

1. `src/renderer/pages/HealthPage.tsx` — `startWeekOn={0}` → `startWeekOn={1}`
2. `src/renderer/pages/DashboardPage.tsx` — `startWeekOn={0}` → `startWeekOn={1}`
3. `src/renderer/components/charts/CalendarHeatmap.tsx` — default
   `startWeekOn = 0` → `startWeekOn = 1` (defensive: now matches the mobile
   component, so a future dropped prop falls back to Monday, not Sunday)

## Why It Keeps Coming Back / How to Prevent It

The weekday order is a one-line prop, easy to overwrite when a commit carries a
stale version of these page files. Guard against recurrence:

- The component default is now `1`, so even if a call site loses the prop, the
  heatmap stays Monday-first. (Desktop now matches mobile, which already used `1`.)
- If you see Sunday-on-top again, check both call sites and the component default
  with: `grep -rn "startWeekOn" src/renderer`
- All three should read `1`. Mobile (`mobile/src/components/charts/CalendarHeatmap.tsx`)
  already defaults to `1`.

## Files Involved

- `src/renderer/components/charts/CalendarHeatmap.tsx` — desktop component (default + rendering)
- `src/renderer/pages/HealthPage.tsx` — Sleep Consistency heatmap (Health page)
- `src/renderer/pages/DashboardPage.tsx` — Sleep Consistency heatmap (Dashboard)
- `mobile/src/components/charts/CalendarHeatmap.tsx` — mobile component (already defaults to `1`)
