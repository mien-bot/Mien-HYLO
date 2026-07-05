# Health Auto Export — Setup & Troubleshooting Guide

## App Overview
Health Auto Export is an iOS app that exports Apple Health data via HTTP POST to our desktop relay server (port 19876). It's the primary data pipeline for all health metrics in Mien.

- App: https://www.healthyapps.dev/
- Help center: https://help.healthyapps.dev
- Official server repo: https://github.com/HealthyApps/health-auto-export-server
- Export format docs: https://help.healthyapps.dev/en/health-auto-export/export-format/health-metrics/

## Required Settings in Health Auto Export

### Export Configuration
- **Export Method**: REST API
- **URL**: `http://<desktop-ip>:19876/health/import` (local) or Cloudflare tunnel URL + `/health/auto-export`
- **Method**: POST
- **Content-Type**: application/json
- **Sync Cadence**: Quantity 1, Interval Days
- **Summarize Data**: ON, Time Grouping: **Day** (CRITICAL — see below)

### Metrics to Export (CHECK these)
| Metric | Why |
|---|---|
| Sleep Analysis | Sleep tracking, debt, quality scoring, circadian analysis |
| Heart Rate | HR chart, recovery scoring |
| Heart Rate Variability | HRV card, recovery score |
| Step Count | Steps card |
| Active Energy | Calories burned |
| Workouts | Exercise tracking |
| VO2 Max | Fitness trend |
| Resting Heart Rate | Fitness baseline |

### Metrics to UNCHECK (save export time)
| Metric | Why skip |
|---|---|
| Basal Energy | Useful but not displayed in app currently |
| Distance (Walking/Running) | Often exports 0 |
| Exercise Time | Redundant with Workouts |
| Flights Climbed | Usually fractional/near-zero |
| Time in Daylight | Usually exports 0 |
| Cardio Recovery | Very sparse data |
| Respiratory Rate | Not displayed |
| Wrist Temperature | Not displayed |

## CRITICAL: Summarize Data Setting

### The Setting
In Health Auto Export, enable **"Summarize Data"** with time grouping set to **Day**.

- **Summarize ON (Day)** = one entry per night, clean totals with stage breakdown
- **Summarize OFF** = hundreds of individual sleep stage fragments per night

### Why It Matters
Without summarization, sleep data arrives as raw stage fragments (each one seconds to minutes long). These fragments include naps, overlapping entries, and sensor artifacts. Reconstructing accurate totals from fragments is unreliable — totals get inflated (e.g., actual 5h 35m shows as 11h).

## Sleep Data Formats

### Format A — Summarized / Aggregated (CORRECT)

Actual payload received from Health Auto Export with "Summarize Data: Day" enabled:

```json
{
  "name": "sleep_analysis",
  "units": "hr",
  "data": [{
    "date": "2026-05-05 00:00:00 -0500",
    "totalSleep": 5.5417,
    "asleep": 0,
    "core": 3.0797,
    "rem": 1.4522,
    "deep": 1.0099,
    "awake": 0.0751,
    "inBed": 0,
    "sleepStart": "2026-05-05 03:35:43 -0500",
    "sleepEnd": "2026-05-05 09:12:44 -0500",
    "inBedStart": "2026-05-05 03:35:43 -0500",
    "inBedEnd": "2026-05-05 09:12:44 -0500",
    "source": "Apple Watch"
  }]
}
```

Key fields:
- **`totalSleep`** — total sleep time in **hours** (NOT minutes). This is the primary field.
- `core`, `rem`, `deep`, `awake` — sleep stages in **hours**
- `asleep` — always 0 (not used by Health Auto Export)
- `inBed` — always 0 (not used — use `inBedStart`/`inBedEnd` timestamps instead)
- `sleepStart` / `sleepEnd` — actual sleep period timestamps
- `inBedStart` / `inBedEnd` — in-bed period timestamps
- `date` — calendar date (may be the wake-up day, NOT the night-of date)

### Format B — Raw Fragments (WRONG — Summarize OFF)

```json
{
  "name": "sleep_analysis",
  "data": [{
    "qty": 0.42,
    "value": "Core",
    "start": "2026-05-11 09:13:11 -0500",
    "end": "2026-05-11 09:38:44 -0500",
    "source": "Apple Watch"
  }]
}
```

Individual stage transitions — each one is seconds to minutes long. Dozens per night.

### How Mien Handles Both Formats

The parser in `health-export.service.ts` auto-detects the format:

1. **Format A (summarized)**: Detects numeric `core`/`rem`/`deep` fields without string `value`. Uses `totalSleep` (hours→minutes). Calculates `inBed` from `inBedStart`/`inBedEnd` timestamps since the `inBed` field is always 0.
2. **Format B (fragments)**: Detects entries with `value` string fields like "Core"/"Deep"/"REM". Groups into sessions separated by >60 min gaps, picks the longest session (main overnight sleep), sums stage durations. Marks with `reconstructed: true`.
3. **Overwrite protection**: Clean data (Format A) always wins. Reconstructed data (Format B) never overwrites existing non-reconstructed entries.

### Field Mapping (Health Auto Export → Mien DB)

| Health Auto Export field | Mien stores as | Unit conversion |
|---|---|---|
| `totalSleep` | `totalAsleep` | hours × 60 → minutes |
| `core` | `core` | hours × 60 → minutes |
| `rem` | `rem` | hours × 60 → minutes |
| `deep` | `deep` | hours × 60 → minutes |
| `inBedStart` / `inBedEnd` | `inBed` | calculated as minutes between timestamps |
| `sleepStart` | `sleepStart` | stored as-is |
| `sleepEnd` | `sleepEnd` | stored as-is |
| `asleep` | (ignored) | always 0 in summarized format |
| `inBed` | (ignored) | always 0 in summarized format |

## Sleep Date Assignment

Health Auto Export sets `date` to the calendar date of the export, which is often the **wake-up day** (e.g., sleep on night of May 4 ending May 5 morning → `date` = May 5). Mien reassigns using `sleepStart`:

| Sleep start time | Assigned to |
|---|---|
| 6pm–midnight May 10 | May 10 (evening bedtime) |
| midnight–2:59pm May 11 | May 10 (still that night's sleep) |
| 3pm–5:59pm May 11 | May 11 (afternoon nap) |

This 6pm–3pm window accounts for late bedtimes (going to bed at 3am) and sleeping in until afternoon. The `sleepStart` timestamp is used for assignment, not the `date` field.

## Fragment Reconstruction (Fallback)

When fragments (Format B) are received, Mien reconstructs sleep sessions as a fallback:

1. Parses all fragments with start/end timestamps
2. Sorts by start time
3. Groups into sessions: a gap >60 minutes between fragments = new session
4. Picks the longest session only (filters out naps)
5. Sums deep/rem/core/awake minutes from that session
6. Marks result with `reconstructed: true`

**Known limitation**: Even with session isolation, reconstructed data is less accurate than summarized data. Always prefer enabling "Summarize Data" in the app.

## Data Pipeline Architecture

```
iPhone (Health Auto Export, Summarize: Day)
    | HTTP POST (JSON, sleep in hours)
    v
Desktop Relay (port 19876, health-export.service.ts)
    | parseAndStorePayload()
    | 1. Groups entries by (metricType, date)
    | 2. Sleep date reassignment using sleepStart (6pm-3pm window)
    | 3. Checks existing non-reconstructed sleep data
    | 4. aggregateEntries() per group
    |    - Auto-detects Format A (summarized) vs Format B (fragments)
    |    - Converts totalSleep/core/rem/deep from hours → minutes
    |    - Calculates inBed from inBedStart/inBedEnd timestamps
    |    - Filters: sleep <1h, HR >220 or <=0, HRV >300 or <=0
    |              steps <10, active_energy <1, zero-value metrics
    | 5. Overwrite protection: skip if reconstructed + clean data exists
    v
SQLite Database (health_metrics table)
    | UNIQUE(metric_type, date) — one row per metric per day
    | INSERT OR REPLACE — re-exports overwrite with latest
    v
Desktop App (renderer charts)
    | Additional display filters (SleepChart >=1h, HeartRateChart >0)
    v
Mobile App (pulls from /health/data endpoint)
```

## Data Validation Rules

All incoming data passes through validation:

| Metric | Minimum | Maximum | Action if out of range |
|---|---|---|---|
| sleep | 60 min (1h) | — | Skipped on import |
| heart_rate | 1 bpm | 220 bpm | Skipped on import |
| hrv | 1 ms | 300 ms | Skipped on import |
| steps | 10 | — | Skipped on import |
| active_energy | 1 cal | — | Skipped on import |
| basal_energy | 1 cal | — | Skipped on import |
| distance | 0.01 | — | Skipped on import |
| exercise_time | 1 min | — | Skipped on import |
| flights_climbed | 1 | — | Skipped on import |
| time_in_daylight | 1 min | — | Skipped on import |

## Cleanup Endpoint

To remove bad data that already got into the database:
```bash
curl -X POST http://localhost:19876/health/cleanup
```
Returns: `{"removed": N, "before": X, "after": Y, "details": {...}}`

Cleanup rules include:
- `sleep_under_1h`: Sleep entries with <60 min total
- `sleep_reconstructed_inflated`: Reconstructed sleep entries with >600 min (10h)
- `hr_out_of_range`: Heart rate <=0 or >220
- `hrv_out_of_range`: HRV <=0 or >300
- Zero/near-zero metrics for energy, steps, distance, exercise, flights, daylight

Also available via Settings page (long-press on version text).

## Relay Sync

The desktop syncs with the relay server (if configured) every 30 minutes:
- **Push**: Sends last 14 days of desktop data to relay
- **Pull**: Fetches data from relay, applies same validation filters before inserting
- Pull uses `INSERT OR IGNORE` — won't overwrite existing desktop data

## Troubleshooting

### No data arriving
1. Check URL is correct in Health Auto Export
2. Check desktop app is running (health server on port 19876)
3. If using Cloudflare tunnel, verify tunnel is active
4. Check Windows Firewall allows port 19876 (if using local IP)
5. Test: `curl http://localhost:19876/health` should return `{"status":"ok"}`

### Sleep data missing (0 entries)
1. Ensure "Summarize Data" is ON with time grouping "Day"
2. The `totalSleep` field (in hours) must be present — without summarization it's absent
3. Check app logs for "Sleep aggregation" or "Sleep date mapped" messages
4. If no log messages, the export may not include sleep_analysis — check metric selection

### Sleep shows wrong hours
1. **Inflated (e.g., 11h actual 5h)**: Summarize was OFF, fragments got reconstructed with naps included. Enable summarize, run cleanup, re-export.
2. **Too low**: Pre-filter may be rejecting entries. Check that `totalSleep` field exists in the export.
3. **Wrong date**: Sleep from May 5 3am should show as May 4. The 6pm–3pm date assignment window handles this. If still wrong, check `sleepStart` timestamps in the export.

### Data keeps coming back after cleanup
1. Relay sync pulls bad data from the relay every 30 min
2. Fixed in sync.service.ts — pull now filters bad data before inserting
3. If still happening, the relay server itself has bad data — re-export clean data

### Duplicate/overlapping data
1. `INSERT OR REPLACE` with `UNIQUE(metric_type, date)` handles this
2. Aggregation layer combines multiple readings per day into one entry
3. Re-exporting is safe — it overwrites with latest values

## iOS Shortcut Alternative

If Health Auto Export still doesn't produce clean sleep data, an iOS Shortcut can query HealthKit directly and POST clean data:

1. **Shortcuts** → create "Mien Sleep Sync"
2. **Find Health Samples** → Sleep Analysis, last 1 day, limit 50
3. Loop through samples, sum deep/rem/core minutes from start/end timestamps
4. Build JSON matching Format A structure
5. **Get Contents of URL** → POST to `http://<ip>:19876/health/import`
6. **Automation** → trigger on alarm dismiss for automatic daily sync

This bypasses Health Auto Export entirely for sleep and sends clean data straight from HealthKit. No Apple Developer account needed.

## Verified Results (May 11, 2026)

After enabling "Summarize Data: Day" and fixing the parser to handle `totalSleep` (hours):

| DB Date | Mien | User-reported actual | Status |
|---|---|---|---|
| May 4 | 5h 33m | 5h 35m | Verified |
| May 6 | 3h 53m | 3h 55m | Verified |
| May 8 | 6h 11m | 6h 21m | Verified |
| May 10 | 4h 0m | — | — |

## Known Issues & History

### May 2026: Sleep Data Debugging Timeline
1. **Problem**: Sleep showing 0h or very low values after May 4
2. **Root cause 1**: "Summarize Data" was OFF → fragments couldn't be aggregated properly
3. **Root cause 2**: Fragment reconstruction inflated totals (naps + overlapping entries)
4. **Root cause 3**: Reconstructed data overwrote good aggregated entries via `INSERT OR REPLACE`
5. **Root cause 4**: Even with summarize ON, parser didn't recognize `totalSleep` field (used `totalAsleep` which doesn't exist in Health Auto Export format)
6. **Root cause 5**: Pre-filter checked `totalAsleep ?? asleep ?? qty` — all 0 in summarized format — and rejected entries before they reached the aggregation logic

### Fixes Applied
- Added `totalSleep` field recognition (hours → minutes conversion)
- Pre-filter now checks `totalSleep` and falls back to `core + rem + deep` sum
- `inBed` calculated from `inBedStart`/`inBedEnd` timestamps (field is always 0)
- Sleep date reassignment uses `sleepStart` timestamp with 6pm–3pm window
- Overwrite protection: reconstructed data never overwrites clean entries
- Fragment reconstruction picks longest session only (filters naps)
- Cleanup rule removes reconstructed entries >10h as inflated

## File References
- Import/aggregation/cleanup: `src/main/services/health/health-export.service.ts`
- Sleep analysis engine: `src/main/services/health/sleep-analysis.ts`
- Relay sync: `src/main/services/sync.service.ts`
- Validation rules doc: `HEALTH-DATA-CLEANUP.md`
- Health charts: `src/renderer/components/health/`
