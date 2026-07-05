// Sleep-entry merge for the relay's per-night ingest.
//
// Background: two independent sources write the same `sleep:<wake-date>` row.
//   - Health Auto Export (watch): full deep/REM/core stage breakdown, but the
//     Apple/Pixel Watch over-reports total asleep (counts awake-in-bed as core).
//   - AutoSleep Shortcut: an accurate motion-based total, but NO stage split
//     (the Shortcut only exports asleep/bedtime/date — see docs/health/autosleep-shortcut.md).
//
// Both ingest paths used to do a blind `metrics[idx] = entry` (last-writer-wins
// per wake-date). That silently destroyed data: a stage-less AutoSleep total, or
// a short morning-nap watch fragment, would overwrite a complete staged night and
// wipe the deep/REM breakdown. This merge keeps the best of each source instead.
//
// Rules (order-independent — same result whether watch or AutoSleep lands first):
//   - Stage split (deep/rem): from whichever entry actually has stages, preferring
//     the larger staged session.
//   - Total / timestamps / HR / efficiency: from AutoSleep when present (its total
//     is the accurate one); otherwise from the longer session.
//   - core is re-based to total - deep - rem so the stages still sum to the total.
//   - A stage-less entry that is also strictly shorter (a nap fragment) never
//     replaces a longer existing entry.

function valueOf(entry) {
  if (!entry) return {}
  const v = entry.value
  if (v && typeof v === 'object') return v
  if (typeof v === 'string') {
    try {
      return JSON.parse(v)
    } catch {
      return {}
    }
  }
  return {}
}

const num = (x) => Number(x) || 0
const hasStages = (v) => num(v.deep) > 0 || num(v.rem) > 0

function timeOf(v, key) {
  return v[key] || (key === 'sleepStart' ? v.start || v.startDate : v.end || v.endDate) || ''
}

function durationFromTimes(v) {
  const start = timeOf(v, 'sleepStart')
  const end = timeOf(v, 'sleepEnd')
  if (!start || !end) return 0
  const ms = new Date(end).getTime() - new Date(start).getTime()
  return ms > 0 ? Math.round(ms / 60000) : 0
}

function hasPlausibleTimes(v) {
  const timedMinutes = durationFromTimes(v)
  if (!timedMinutes) return false
  const asleep = num(v.totalAsleep) || num(v.asleep) || num(v.qty)
  if (!asleep) return true
  // Timestamps represent in-bed/session span, so allow awake time and clock
  // rounding. Reject obvious Shortcut metadata bugs such as 342min asleep
  // paired with an 8:00-9:31 AM span.
  return timedMinutes >= asleep - 30 && timedMinutes <= asleep + 180
}

export function mergeSleepEntry(existing, incoming) {
  if (!existing) return incoming
  if (!incoming) return existing

  const ev = valueOf(existing)
  const iv = valueOf(incoming)
  const cand = [
    { e: existing, v: ev },
    { e: incoming, v: iv },
  ]

  // Richest stage split available (prefer the larger staged session).
  const staged = cand
    .filter((c) => hasStages(c.v))
    .sort((a, b) => num(b.v.totalAsleep) - num(a.v.totalAsleep))[0]

  // Whose total/timestamps to trust: AutoSleep if present, else the longer session.
  const auto = cand.find((c) => c.v.sourceCategory === 'autosleep')
  const base =
    auto ||
    cand.slice().sort((a, b) => num(b.v.totalAsleep) - num(a.v.totalAsleep))[0]

  // No stage data anywhere: keep the latest writer, but never let a strictly
  // shorter fragment (e.g. a morning nap) replace a longer existing entry.
  if (!staged) {
    if (num(iv.totalAsleep) < num(ev.totalAsleep)) return existing
    return incoming
  }

  // The trusted-total entry already carries the stages — take it (with a
  // normalized object value, in case it was stored as a JSON string).
  if (base.e === staged.e) return { ...base.e, value: base.v }

  // Graft the staged split onto the trusted total; re-base core so it sums.
  const deep = num(staged.v.deep)
  const rem = num(staged.v.rem)
  const total = num(base.v.totalAsleep) || deep + rem + num(staged.v.core)
  const core = Math.max(0, total - deep - rem)
  const timeSource = hasPlausibleTimes(base.v) ? base.v : staged.v
  return {
    ...base.e,
    value: {
      ...base.v,
      sleepStart: timeOf(timeSource, 'sleepStart') || timeOf(base.v, 'sleepStart'),
      sleepEnd: timeOf(timeSource, 'sleepEnd') || timeOf(base.v, 'sleepEnd'),
      totalAsleep: total,
      deep,
      rem,
      core,
      stagesFrom: staged.v.sourceCategory || 'watch',
    },
    synced_at: incoming.synced_at || base.e.synced_at,
  }
}
