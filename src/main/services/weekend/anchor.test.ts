import { describe, it, expect } from 'vitest'
import { extractAnchorQuery, anchorRadiusMiles } from './anchor'

describe('extractAnchorQuery', () => {
  it('pulls a street address with a directional', () => {
    expect(
      extractAnchorQuery(
        "Okay, plan around Thai Fest, which is 851 W Irving park area. eat there first",
      ),
    ).toBe('851 W Irving park')
  })

  it('pulls a street address that uses a street-type word instead of a directional', () => {
    expect(extractAnchorQuery('meet at 1060 Addison Street then walk over')).toBe(
      '1060 Addison Street',
    )
  })

  it('falls back to a "around X" proper-noun phrase when there is no address', () => {
    expect(extractAnchorQuery('plan our events around Thai Fest please')).toBe('Thai Fest')
  })

  it('does NOT treat money amounts as an anchor', () => {
    expect(extractAnchorQuery('keep it under $50 budget for the day')).toBe('')
  })

  it('does NOT treat head counts as an anchor', () => {
    expect(extractAnchorQuery('group of 20 people, table for 4')).toBe('')
  })

  it('does NOT treat times after "at" as an anchor', () => {
    expect(extractAnchorQuery('we want dinner at 7 and drinks by 9')).toBe('')
  })

  it('skips non-place words after "at"/"near"', () => {
    expect(extractAnchorQuery('grab lunch at noon near the lake')).toBe('')
  })

  it('returns empty for notes with no location', () => {
    expect(extractAnchorQuery('low energy day, keep it chill and relaxed')).toBe('')
    expect(extractAnchorQuery('')).toBe('')
    expect(extractAnchorQuery(undefined)).toBe('')
  })
})

describe('anchorRadiusMiles', () => {
  it('is lenient when driving is available', () => {
    expect(anchorRadiusMiles('driving')).toBe(8)
    expect(anchorRadiusMiles('driving, transit, walking')).toBe(8)
    expect(anchorRadiusMiles('car')).toBe(8)
  })

  it('is tight for walking or biking', () => {
    expect(anchorRadiusMiles('walking')).toBe(1.5)
    expect(anchorRadiusMiles('transit, walking, biking, rideshare')).toBe(1.5)
    expect(anchorRadiusMiles('biking')).toBe(1.5)
  })

  it('is moderate for transit/rideshare without walking', () => {
    expect(anchorRadiusMiles('transit')).toBe(3)
    expect(anchorRadiusMiles('rideshare')).toBe(3)
  })

  it('defaults to driving-lenient when unset', () => {
    expect(anchorRadiusMiles(undefined)).toBe(8)
  })
})
