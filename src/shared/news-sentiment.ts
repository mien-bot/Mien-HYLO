/**
 * Lightweight buzzword-based sentiment scorer for news headlines.
 *
 * Used as a fallback when AI-scored sentiment isn't available. Returns one of
 * 'positive' | 'negative' | 'neutral'. Designed to err toward 'neutral' rather
 * than mislabel — false confidence is worse than no signal.
 */

export type Sentiment = 'positive' | 'negative' | 'neutral'

const POSITIVE_PHRASES = [
  'beats',
  'beat estimates',
  'surges',
  'soars',
  'rallies',
  'rallied',
  'jumps',
  'climbs',
  'gains',
  'record high',
  'all-time high',
  'raises guidance',
  'raises outlook',
  'upgrade',
  'upgraded',
  'buy rating',
  'outperform',
  'strong earnings',
  'tops estimates',
  'announces buyback',
  'dividend hike',
  'breakthrough',
  'approval',
  'partnership',
  'wins contract',
  'expansion',
  'bullish',
  'crushes',
  'smashes',
]

const NEGATIVE_PHRASES = [
  'misses',
  'missed',
  'plunges',
  'plummets',
  'tumbles',
  'slumps',
  'crashes',
  'falls',
  'drops',
  'sinks',
  'cuts guidance',
  'lowers outlook',
  'downgrade',
  'downgraded',
  'sell rating',
  'underperform',
  'weak earnings',
  'lawsuit',
  'investigation',
  'fraud',
  'recall',
  'layoffs',
  'job cuts',
  'bankruptcy',
  'sec charges',
  'probe',
  'warns',
  'profit warning',
  'bearish',
  'disappoints',
  'misses estimates',
  'falls short',
]

export function scoreSentiment(text: string): Sentiment {
  if (!text) return 'neutral'
  const lower = text.toLowerCase()
  let pos = 0
  let neg = 0
  for (const phrase of POSITIVE_PHRASES) if (lower.includes(phrase)) pos++
  for (const phrase of NEGATIVE_PHRASES) if (lower.includes(phrase)) neg++
  if (pos > neg) return 'positive'
  if (neg > pos) return 'negative'
  return 'neutral'
}

export function sentimentColor(s: Sentiment): string {
  if (s === 'positive') return 'var(--accent-green)'
  if (s === 'negative') return 'var(--accent-red)'
  return 'var(--text-muted)'
}

export function sentimentDot(s: Sentiment): string {
  if (s === 'positive') return '●'
  if (s === 'negative') return '●'
  return '○'
}
