# AutoSleep Shortcut — Setup & Integration

## Overview

AutoSleep is an iOS app that runs its own sleep-staging algorithm on Apple Watch data, producing higher-quality sleep metrics than raw Health Auto Export (HAE) watch samples. This doc covers the iOS Shortcut that POSTs AutoSleep data directly to the relay's `/health/autosleep` endpoint.

**Why this exists**: HAE only exports raw Pixel Watch sleep samples (`sourceCategory: "watch"`). AutoSleep's analysis is never written to HealthKit in a form HAE can export, so a Shortcut is the only way to get AutoSleep data into Mien.

**Data preference**: When AutoSleep data is present for a given night, the relay treats it as authoritative over raw watch samples.

---

## Shortcut Setup

### Actions (in order)

1. **Time Asleep** — AutoSleep variable
2. **Tonight's Bedtime** — AutoSleep variable
3. **Format Date** — Current Date, format: ISO 8601, Include Time: on
4. **Get Contents of URL** — see configuration below

### Get Contents of URL Configuration

| Field | Value |
|---|---|
| URL | `https://relay.example.com/health/autosleep` |
| Method | POST |
| Header: `Authorization` | `Bearer <token from relay.key>` |
| Request Body type | JSON |
| Field: `asleep` | Time Asleep variable |
| Field: `bedtime` | Tonight's Bedtime variable |
| Field: `date` | Formatted Date (from step 3) |

### Notes on AutoSleep Variables

AutoSleep Shortcuts variables export as **JSON-encoded dictionary strings**, not simple values. For example:

- `Time Asleep` → `{"Sleep":"5.70", "Start":"Fri, 5/29/26, 3:22 AM", "Until":"Fri, 5/29/26, 9:31 AM", "Recharge%":"71", ...}`
- `Tonight's Bedtime` → `{"Tonight'sBedtime":"10:38 PM", "Waketime":"9:47 AM", ...}`
- `date` (ISO 8601) → `"2026-05-29T03:22:00-05:00\n2026-05-29T09:31:00-05:00"` (two timestamps joined by newline)

The relay unwraps these automatically — you don't need to do anything special in the Shortcut.

---

## Relay Endpoint — `/health/autosleep`

**Method**: `POST`  
**Auth**: Bearer token (same as all relay endpoints)  
**Content-Type**: `application/json`

### Accepted Body Formats

**Flat single-night object** (used by Shortcut):
```json
{
  "asleep": "<AutoSleep dict string or seconds or H:MM:SS>",
  "bedtime": "<AutoSleep dict string or ISO timestamp>",
  "date": "<ISO 8601 or YYYY-MM-DD>"
}
```

**Array of nights** (for bulk import):
```json
[
  { "date": "2026-05-29", "asleep": 26280, "deep": 2940, "rem": 5580 },
  { "date": "2026-05-28", "asleep": 24300 }
]
```

### Field Reference

| Field | Accepted formats | Notes |
|---|---|---|
| `asleep` / `totalAsleep` | seconds (number), `H:MM:SS` string, AutoSleep dict string | Required. Dict: extracts `Sleep` (hours → seconds) |
| `bedtime` / `sleepStart` | ISO 8601, `"Fri, 5/29/26, 3:22 AM"`, AutoSleep dict string | Optional. Dict: not useful (time-only), `Start` from `asleep` dict used instead |
| `waketime` / `sleepEnd` | ISO 8601, `"Fri, 5/29/26, 9:31 AM"` | Optional. Extracted from `asleep` dict's `Until` field |
| `date` | ISO 8601 (sliced to `YYYY-MM-DD`), `YYYY-MM-DD` | Required if no `waketime` |
| `deep` | seconds or `H:MM:SS` | Optional |
| `rem` | seconds or `H:MM:SS` | Optional |
| `core` | seconds or `H:MM:SS` | Optional |
| `quality` | seconds or `H:MM:SS` | AutoSleep deep+REM combined; relay derives `rem = quality - deep` |
| `inBed` | seconds or `H:MM:SS` | Optional; defaults to `totalAsleep` |
| `sleepBPM` / `heartRate` | number | Optional |
| `sleepHRV` / `hrv` | number | Optional |

### AutoSleep Dict Unwrapping (relay-side)

When `asleep` is a JSON-encoded dict string, the relay automatically extracts:
- `Sleep` (hours) → converts to seconds for `toMin()`
- `Start` → sets as `bedtime` (full timestamp with date)
- `Until` → sets as `waketime` (full timestamp with date)

When `date` is a multi-line ISO string (Shortcuts quirk), relay slices to first 10 chars (`YYYY-MM-DD`).

### Skip Conditions

A night is skipped (not stored) if:
- `totalAsleep < 30` minutes after parsing
- `date` cannot be determined (no `date` field and no `waketime`)
- Body is not valid JSON

### Response

```json
{ "ok": true, "added": 1, "skipped": 0, "received": 1 }
```

Relay also logs: `AutoSleep ingest: N nights stored, M skipped (K received)`

---

## AutoSleep vs HAE Comparison

| | AutoSleep Shortcut | Health Auto Export |
|---|---|---|
| Source | AutoSleep algorithm | Raw Apple Watch accelerometer |
| `sourceCategory` | `autosleep` | `watch` |
| Sleep staging | AutoSleep's own model | HealthKit raw stages |
| Bedtime/waketime | Accurate timestamps from AutoSleep | From HealthKit `inBedStart`/`inBedEnd` |
| Stage detail | Total only (no separate deep/rem/core from Shortcut) | Full stage breakdown |
| Trigger | Manual or automated Shortcut | HAE app automatic export |

**Recommendation**: Use both. AutoSleep data is preferred when present. HAE provides stage-level breakdown that AutoSleep's Shortcuts variables don't expose.

---

## Automation

To avoid running the Shortcut manually each morning:

1. **Shortcuts** → **Automation** → **New Automation**
2. Trigger: **Time of Day** (e.g., 9:00 AM) or **Alarm** → When Dismissed
3. Action: Run Shortcut → this Shortcut
4. Turn off "Ask Before Running"

The alarm-dismiss trigger is ideal — fires after sleep ends, when AutoSleep has finalized its analysis.

---

## Troubleshooting

### `invalid JSON: unexpected end of JSON input`
The Request Body has no fields. Tap **Add new field** in the Shortcuts JSON body and add `asleep`, `bedtime`, `date`.

### `0 nights stored, 1 skipped`
`totalAsleep` parsed to < 30 minutes. Most likely causes:
- `asleep` field is empty or wrong variable selected
- AutoSleep dict `Sleep` field is missing (app may not have analyzed last night yet)

### Request not reaching relay
1. Check `relay.example.com` is accessible — requires `cloudflared tunnel run mien` running separately (relay's `TUNNEL=1` uses ephemeral trycloudflare URLs, not the named tunnel)
2. Verify Authorization header is `Bearer <token>` — token is in `relay/relay.key`
3. Confirm relay is running: `GET https://relay.example.com/health` should return `{"status":"ok"}`

### Named tunnel (`relay.example.com`) vs ephemeral tunnel
- `TUNNEL=1 node server.js` → random `*.trycloudflare.com` URL (changes on restart)
- `relay.example.com` → requires `cloudflared tunnel run mien` running as a separate process; relay runs without `TUNNEL=1` and just listens on port 3456

---

## File References

- Relay endpoint: `relay/server.js` (search `POST /health/autosleep`, ~line 2826)
- AutoSleep dict unwrap: same file, inside `for (const night of nights)` loop
- HAE pipeline: `docs/health/auto-export-setup.md`
