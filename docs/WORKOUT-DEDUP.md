# Workout Deduplication: HAE vs Strava

## Problem
Health Auto Export (HAE) and Strava both record the same workouts, leading to duplicates in the `health_metrics` table (metric_type = 'workout'). The existing `mergeWorkouts()` function was supposed to deduplicate them, but **two bugs** prevented it from working.

## Root Causes

### Bug 1: HAE timestamp format not parseable by JS `Date`
- HAE sends timestamps like `2018-09-09 08:00:14 -0500` (space-separated timezone offset)
- Strava sends ISO format like `2018-09-09T13:00:14Z`
- JavaScript's `new Date('2018-09-09 08:00:14 -0500')` returns `Invalid Date` (NaN)
- `parseWorkoutTime()` / `workoutStartMs()` returned `null` for all HAE workouts
- `sameWorkout()` requires non-null start times to match, so it always returned `false`

**Fix**: Added HAE format detection via regex, converts to ISO before parsing:
```typescript
const haeMatch = str.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/)
if (haeMatch) str = `${haeMatch[1]}T${haeMatch[2]}${haeMatch[3]}:${haeMatch[4]}`
```

### Bug 2: Sport name synonyms not matched
- HAE names workouts "Outdoor Cycling", Strava names the same activity "Ride"
- `workoutNamesCompatible()` checked if one name contains the other (`"outdoor cycling".includes("ride")` = false)
- These pairs were treated as different workouts

**Fix**: Added `SPORT_SYNONYMS` lookup that maps both "Outdoor Cycling" and "Ride" to the canonical name "ride":
```typescript
const SPORT_SYNONYMS = {
  'outdoor cycling': 'ride', 'indoor cycling': 'ride', cycling: 'ride',
  'outdoor run': 'run', 'indoor run': 'run', 'treadmill run': 'run',
  'outdoor walk': 'walk', 'indoor walk': 'walk',
  'outdoor swim': 'swim', 'indoor swim': 'swim', 'pool swim': 'swim',
  'outdoor hike': 'hike', hiking: 'hike',
  'traditional strength training': 'weight training', 'strength training': 'weight training',
}
```

## Data Before/After Cleanup

| Metric | Before | After |
|--------|--------|-------|
| Total workouts in DB | 1,850 | 1,202 |
| Duplicates removed | — | 648 |
| Strava workouts | 562 | 562 (all kept) |
| HAE-only workouts | ~640 | ~640 (kept where no Strava match) |
| Remaining close-time pairs | — | 84 (legitimate: different activity types within 20min) |

## Merge Logic (unchanged, now works correctly)

`src/main/services/health/workout-merge.ts`:

1. **`sameWorkout(a, b)`**: Match by stravaId, or by start time within 20 minutes + compatible name/duration/distance
2. **`preferredWorkout(existing, incoming)`**: Strava always wins over non-Strava; otherwise higher completeness score wins
3. **`mergeWorkouts(existing[], incoming[])`**: For each incoming workout, find match in existing — replace if preferred, append if no match

Called at:
- `health-export.service.ts:167` — HAE import (merges with existing DB row for that date)
- `strava.service.ts:340` — Strava sync (merges with existing)
- `sync.service.ts:304` — Relay pull (merges with existing)
- `relay/server.js:963` — Relay server workout upsert

## Files Changed
- `src/main/services/health/workout-merge.ts` — Fixed `parseWorkoutTime` + added `SPORT_SYNONYMS`
- `relay/server.js` — Same fixes in relay's copy of workout helpers

## Strava Precedence
When a workout exists from both sources, Strava version is always kept because:
- `preferredWorkout()` returns the Strava version when one is Strava and the other isn't
- Strava workouts have higher completeness scores (stravaId, HR zones, splits, laps, best efforts, segments, etc.)
- HAE workouts only have: name, start/end time, duration (in seconds), avgHR, maxHR
