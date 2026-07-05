interface AvatarProps {
  /** Display name; initials are derived from it. Falls back to a bowl glyph. */
  name?: string
  size?: number
  /** Optional image URL; when set, overrides the monogram. */
  src?: string
  className?: string
}

function initialsFrom(name?: string): string {
  const trimmed = (name || '').trim()
  if (!trimmed) return '🍜'
  const parts = trimmed.split(/\s+/).filter(Boolean)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/**
 * Circular avatar. Defaults to a monogram (or noodle-bowl glyph) rendered over
 * the active accent gradient, so it recolors with the chosen theme.
 */
export default function Avatar({ name, size = 30, src, className }: AvatarProps) {
  const label = initialsFrom(name)
  const isGlyph = label === '🍜'
  return (
    <div
      className={`font-display inline-flex items-center justify-center rounded-full overflow-hidden select-none ${className || ''}`}
      style={{
        width: size,
        height: size,
        background: src ? 'var(--bg-tertiary)' : 'var(--accent-gradient)',
        color: '#fff',
        fontSize: isGlyph ? size * 0.5 : size * 0.42,
        fontWeight: 800,
        boxShadow: '0 0 0 1px var(--surface-highlight), 0 2px 8px var(--glow-accent)',
      }}
      title={name || undefined}
    >
      {src ? (
        <img src={src} alt={name || 'avatar'} className="w-full h-full object-cover" />
      ) : (
        <span style={{ lineHeight: 1 }}>{label}</span>
      )}
    </div>
  )
}
