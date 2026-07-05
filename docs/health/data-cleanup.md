# Health Data Cleanup & Validation Rules

## Overview
Health Auto Export sends raw Apple Watch data that often includes zero/near-zero readings from days the watch wasn't worn, incomplete sensor readings, and duplicate entries from multiple sync intervals. This document records all validation and cleanup rules applied to prevent bad data from entering the database and to clean existing bad entries.

## Cleanup Endpoint
`POST /health/cleanup` — runs all cleanup rules against the existing database. Safe to run multiple times (idempotent).

## Validation Rules

### On Import (aggregation layer in `health-export.service.ts`)

All incoming data is grouped by `(metricType, date)` and aggregated before storage. The following filters apply **before** aggregation:

| Metric Type | Filter | Reason |
|---|---|---|
| `steps` | Skip entries with qty < 10 | Fractional steps = incomplete sensor reading |
| `active_energy` | Skip entries with qty < 1 | Sub-calorie values = sensor noise |
| `basal_energy` | Skip entries with qty <= 0 | Zero = watch not worn |
| `distance` | Skip entries with qty <= 0 | Zero = watch not worn |
| `exercise_time` | Skip entries with qty < 1 | Fractional minutes = sensor noise |
| `flights_climbed` | Skip entries with qty < 1 | Fractional flights = sensor noise |
| `time_in_daylight` | Skip entries with qty < 1 | Fractional minutes = sensor noise |
| `sleep` | Skip if total asleep < 60 min | Under 1h = not a real sleep session |
| `heart_rate` | Skip entries with bpm <= 0 | Zero = watch not worn |
| `hrv` | Skip entries with value <= 0 or > 300ms | Out of physiological range |

### Aggregation Rules (per metric type)

| Metric Type | Strategy |
|---|---|
| `heart_rate` | Average all readings; store avg, min, max, count |
| `hrv` | Average all readings; store avg, min, max, count |
| `steps` | Sum all readings (rounded to integer) |
| `active_energy` | Sum all readings (rounded to integer) |
| `basal_energy` | Sum all readings (rounded to integer) |
| `sleep` | Keep longest session as primary; sum total asleep/inBed across sessions |
| Other metrics | Keep the last entry for the day |

### On Display (renderer charts)

| Component | Filter |
|---|---|
| `SleepChart.tsx` | Skip days with hours < 1 |
| `HeartRateChart.tsx` | Skip days with bpm <= 0 |
| `MetricCard.tsx` | Skip values <= 0 |

## Cleanup History

### 2026-05-11 — Initial comprehensive cleanup
Removed 58 bad entries from 145 total (40% was junk):
- `basal_energy_zero`: 8 entries (all had qty=0)
- `active_energy_near_zero`: 5 entries (values like 0.005, 0.01 cal)
- `steps_near_zero`: 5 entries (values like 0.59, 3.28 steps)
- `distance_zero`: 14 entries (all qty=0)
- `exercise_time_zero`: 8 entries (all qty=0)
- `flights_climbed_zero`: 11 entries (all qty=0)
- `time_in_daylight_zero`: 7 entries (all qty=0)

Previously removed (same session, earlier cleanup run):
- `sleep_under_2h`: 4 entries
- `hr_out_of_range`: 0 (none found)
- `hrv_out_of_range`: 0 (none found)

### Result
87 clean entries remaining across: heart_rate, hrv, sleep, steps, active_energy, respiratory_rate, resting_heart_rate, vo2_max, wrist_temperature, cardio_recovery.

## Preventing Re-import of Bad Data

The aggregation layer (`aggregateEntries()` in `health-export.service.ts`) now filters **before** storing, so re-exporting from Health Auto Export will not re-introduce the same bad data:

1. Zero-value metrics are filtered out before aggregation (they return `null` and are skipped)
2. Sleep sessions under 2h return `null` and are skipped
3. Heart rate and HRV readings outside physiological range are excluded from aggregation
4. `INSERT OR REPLACE` with `UNIQUE(metric_type, date)` means re-imports overwrite with the new (clean) aggregated value

### Sleep Fragment Reconstruction

Health Auto Export sometimes sends sleep data as raw stage fragments instead of aggregated sessions (see `HEALTH-AUTO-EXPORT-SETUP.md` for full details on Format A vs Format B).

When fragments are detected (entries where `value` is a string like "Core", "Deep", "REM", "Awake"), the import layer reconstructs a sleep session:
1. Calculates duration for each fragment from `start`/`end` timestamps (or `qty * 60` as fallback)
2. Groups by stage type (deep, rem, core/light, awake, inBed)
3. Sums to build a complete session with `totalAsleep`, `deep`, `rem`, `core`, `inBed`
4. Marks the result with `reconstructed: true` flag
5. Midnight-crossing: fragments before noon are assigned to the previous night's date

**Known issue**: Reconstructed data can inflate totals because it includes naps, overlapping fragments, and sensor artifacts alongside real sleep. For example, May 4 actual sleep was 5h 44min but fragments reconstructed to 11.1h.

### Overwrite Prevention

Reconstructed sleep data (from fragments) will **never** overwrite existing aggregated sleep data (from Format A exports). On import:
1. All existing non-reconstructed sleep entries are loaded into a lookup map
2. If a reconstructed entry targets a date that already has clean aggregated data, it is skipped
3. Only dates with no existing sleep data (or only reconstructed data) get the reconstructed entry

This means: if you export both Format A (aggregated) and Format B (fragments) for the same date, the aggregated data wins.

### If bad data reappears
Run the cleanup endpoint: `curl -X POST http://localhost:19876/health/cleanup`

This can also be triggered from the desktop app Settings page (long-press on version text).

## Metric Name Mapping

Health Auto Export uses various naming conventions. All are mapped to canonical names:

| Canonical Name | Aliases |
|---|---|
| `heart_rate` | heartRate |
| `hrv` | heart_rate_variability, heartRateVariability |
| `sleep` | sleep_analysis, sleepAnalysis |
| `steps` | step_count, stepCount |
| `active_energy` | activeEnergy |
| `basal_energy` | basalEnergy, basal_energy_burned |
| `distance` | distance_walking_running, distanceWalkingRunning |
| `exercise_time` | exerciseTime, apple_exercise_time |
| `flights_climbed` | flightsClimbed |
| `time_in_daylight` | timeInDaylight |
| `workout` | workouts |
