# AutoSleep iOS Shortcut Setup

Send AutoSleep's accurate sleep data directly to Mien, bypassing Health Auto Export and Apple Watch's over-counting algorithm.

## What this replaces

- Before: iPhone -> Apple Health -> Health Auto Export -> relay. HAE only got Apple Watch native sleep tracking, which can over-report asleep time by counting awake-in-bed as sleep.
- After: iPhone -> AutoSleep Shortcut actions -> relay `/health/autosleep`. AutoSleep does motion-based analysis on the Watch's raw sensor data and Mien receives AutoSleep's numbers.

HAE keeps handling everything else, including HR, steps, HRV, energy, and workouts. Only sleep moves to this AutoSleep path.

## One-time setup on iPhone

### 1. Verify AutoSleep is installed and has data

Open the AutoSleep app and confirm last night's sleep is showing. If AutoSleep itself does not have your data, fix AutoSleep first.

### 2. Build the Shortcut

Open the Shortcuts app, tap `+`, and create a shortcut named `Mien Sleep Push`.

AutoSleep's Shortcuts integration exposes one action per metric. There is usually no single `Get Sleep` action that returns every field. In the action picker, search for `AutoSleep`, then scroll the full alphabetical action list and add one action for each field below.

For each AutoSleep action:

- Set `Of Day` to `Today` first.
- If the relay stores the record under the wrong date, switch the actions to `Yesterday`.
- After adding the action, tap its result chip and rename it to the clean variable name shown below.

Add these AutoSleep actions:

| Action to find | Rename result variable to | JSON key |
|---|---:|---|
| Time Asleep | `Asleep` | `asleep` |
| Time In Bed, or In Bed | `InBed` | `inBed` |
| Time Awake, or Awake | `Awake` | `awake` |
| Deep Sleep | `Deep` | `deep` |
| Quality Sleep | `Quality` | `quality` |
| Efficiency | `Efficiency` | `efficiency` |
| Bedtime, Lights Out, or Sleep Start | `Bedtime` | `bedtime` |
| Wake Time, Get Up Time, or Sleep End | `Waketime` | `waketime` |
| Heart Rate, Sleep BPM, or BPM | `SleepBPM` | `sleepBPM` |
| HRV, Sleep HRV, or Readiness HRV | `SleepHRV` | `sleepHRV` |

The exact labels vary by AutoSleep version. If you do not see a name, use the closest AutoSleep action that returns that same metric. `sleepBPM` and `sleepHRV` are optional, but include them if available.

### 3. Add the POST action

Add `Get Contents of URL`.

Configure it like this:

- URL: `https://<your-relay-tunnel-url>/health/autosleep`
- Method: `POST`
- Request Body: `JSON`
- Headers:
  - `Authorization` = `Bearer <your-relay-token>` using the value from `relay/relay.key` on the server
  - `Content-Type` = `application/json`

In the JSON body, add fields with these exact keys and set each value to the renamed magic variable:

```json
{
  "bedtime": "Bedtime",
  "waketime": "Waketime",
  "asleep": "Asleep",
  "inBed": "InBed",
  "awake": "Awake",
  "deep": "Deep",
  "quality": "Quality",
  "efficiency": "Efficiency",
  "sleepBPM": "SleepBPM",
  "sleepHRV": "SleepHRV"
}
```

In Shortcuts, do not type the variable names as text. Tap into each value field and insert the matching magic variable chip.

### 4. Test it

For first-run testing, add `Show Result` after `Get Contents of URL`.

Run the shortcut manually. A successful relay response looks like:

```json
{ "ok": true, "added": 1, "skipped": 0, "received": 1 }
```

On the server, the log should print:

```text
AutoSleep ingest: 1 nights stored, 0 skipped (1 received)
```

Verify in `relay/health-data.json` that the latest sleep record has `source: "autosleep"` and `sourceCategory: "autosleep"`, and that `totalAsleep` matches AutoSleep.

### 5. Automate it

In Shortcuts, open the Automation tab, tap `+`, and create a personal automation.

Good triggers:

- Time of Day, 11:00 AM
- When I Open AutoSleep
- When iPhone unlocks after 8 AM

Action: `Run Shortcut` -> `Mien Sleep Push`.

Turn off any confirmation prompt so it runs automatically.

## Troubleshooting action names

If the AutoSleep action picker opens in the middle of the alphabet, scroll all the way up. The actions are alphabetical, so seeing `R` through `W` means the earlier actions are above the visible area.

If you cannot find a metric:

- Required for useful sleep import: `asleep`, `bedtime`, and `waketime`.
- Strongly recommended: `inBed`, `awake`, `deep`, `quality`, and `efficiency`.
- Optional: `sleepBPM` and `sleepHRV`.

If only the required fields are available, the relay will still store the night. Missing stage fields will be stored as zero or omitted.

## Historical backfill

To replace existing over-counted sleep records with AutoSleep history:

```bash
# 1. Export AutoSleep history: AutoSleep app -> Settings -> Export -> CSV
# 2. Get the CSV to the server
# 3. On the server:
node scripts/backfill-autosleep.js /path/to/AutoSleep.csv https://<relay-url> "$(cat relay/relay.key)"
```

The script POSTs the CSV rows to `/health/autosleep` in batches of 200, overwriting existing sleep records for matching dates. Existing non-AutoSleep records for other dates remain untouched.

## Field reference

| Field | Type | Meaning |
|---|---|---|
| `asleep` | `HH:MM:SS` or seconds | Total time actually asleep |
| `inBed` | `HH:MM:SS` or seconds | Total time in bed including awake periods |
| `awake` | `HH:MM:SS` or seconds | Total awake-in-bed time |
| `deep` | `HH:MM:SS` or seconds | Deep sleep duration |
| `quality` | `HH:MM:SS` or seconds | AutoSleep quality sleep |
| `efficiency` | number 0-100 | `asleep / inBed * 100` |
| `bedtime` | timestamp | When you got into bed |
| `waketime` | timestamp | When you got up |
| `sleepBPM` | number | Average HR during sleep |
| `sleepHRV` | number | Average HRV in ms |

The relay derives `rem = quality - deep` and `core = asleep - quality` for compatibility with Mien's existing stage display.
