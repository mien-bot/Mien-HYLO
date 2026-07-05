import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeSleepEntry } from './sleep-merge.js'

const watchNight = {
  type: 'sleep',
  date: '2026-05-29',
  source: 'health_auto_export',
  value: { totalAsleep: 450, deep: 50, rem: 100, core: 300, awake: 30, sourceCategory: 'watch' },
}
const watchNap = {
  type: 'sleep',
  date: '2026-05-29',
  source: 'health_auto_export',
  value: { totalAsleep: 83, deep: 0, rem: 0, core: 83, awake: 6, sourceCategory: 'watch' },
}
const autoNoStages = {
  type: 'sleep',
  date: '2026-05-29',
  source: 'autosleep',
  value: { totalAsleep: 420, deep: 0, rem: 0, core: 420, awake: 0, sourceCategory: 'autosleep' },
}
const watchNightWithTimes = {
  ...watchNight,
  value: {
    ...watchNight.value,
    sleepStart: '2026-05-29 03:22:00 -0500',
    sleepEnd: '2026-05-29 09:31:00 -0500',
  },
}
const autoBadTimes = {
  type: 'sleep',
  date: '2026-05-29',
  source: 'autosleep',
  value: {
    totalAsleep: 342,
    deep: 0,
    rem: 0,
    core: 342,
    awake: 0,
    inBed: 342,
    sleepStart: '2026-05-29 08:00:48 -0500',
    sleepEnd: '2026-05-29T14:31:00.000Z',
    sourceCategory: 'autosleep',
  },
}

// THE REGRESSION: a stage-less morning-nap fragment must NOT wipe the staged night.
// Old behavior (metrics[idx] = incoming) returned watchNap → deep/rem = 0.
test('nap fragment does not clobber the staged night', () => {
  const merged = mergeSleepEntry(watchNight, watchNap)
  assert.equal(merged.value.deep, 50)
  assert.equal(merged.value.rem, 100)
  assert.equal(merged.value.totalAsleep, 450)
})

test('stage-less AutoSleep keeps its accurate total but grafts the watch stages', () => {
  // watch already stored, AutoSleep arrives second
  const merged = mergeSleepEntry(watchNight, autoNoStages)
  assert.equal(merged.value.deep, 50)
  assert.equal(merged.value.rem, 100)
  assert.equal(merged.value.totalAsleep, 420) // AutoSleep's accurate total
  assert.equal(merged.value.core, 420 - 50 - 100) // re-based so stages sum
  assert.equal(merged.value.sourceCategory, 'autosleep')
})

test('order-independent: watch arrives after AutoSleep, same result', () => {
  const merged = mergeSleepEntry(autoNoStages, watchNight)
  assert.equal(merged.value.deep, 50)
  assert.equal(merged.value.rem, 100)
  assert.equal(merged.value.totalAsleep, 420)
  assert.equal(merged.value.sourceCategory, 'autosleep')
})

test('a richer/longer staged entry still replaces a plain existing one', () => {
  const merged = mergeSleepEntry(autoNoStages, watchNight)
  assert.ok(merged.value.deep > 0)
})

test('no existing entry returns incoming unchanged', () => {
  assert.deepEqual(mergeSleepEntry(null, watchNight), watchNight)
})

test('string-encoded existing value is parsed, not dropped', () => {
  const stringy = { ...watchNight, value: JSON.stringify(watchNight.value) }
  const merged = mergeSleepEntry(stringy, watchNap)
  assert.equal(merged.value.deep, 50)
})

test('bad AutoSleep Shortcut timestamps do not replace plausible staged watch times', () => {
  const merged = mergeSleepEntry(watchNightWithTimes, autoBadTimes)
  assert.equal(merged.value.totalAsleep, 342)
  assert.equal(merged.value.deep, 50)
  assert.equal(merged.value.rem, 100)
  assert.equal(merged.value.sleepStart, '2026-05-29 03:22:00 -0500')
  assert.equal(merged.value.sleepEnd, '2026-05-29 09:31:00 -0500')
})
