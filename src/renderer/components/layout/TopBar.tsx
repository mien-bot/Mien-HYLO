import { useState, useEffect } from 'react'
import { format } from 'date-fns'
import Avatar from '../Avatar'
import { useDisplayName } from '../../hooks/useDisplayName'

export default function TopBar() {
  const [now, setNow] = useState(new Date())
  const name = useDisplayName()

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(interval)
  }, [])

  return (
    <header
      className="h-12 flex items-center justify-between px-6 border-b shrink-0"
      style={{
        borderColor: 'var(--separator)',
        background: 'color-mix(in srgb, var(--bg-secondary) 78%, transparent)',
        backdropFilter: 'blur(12px)',
        boxShadow: 'inset 0 -1px 0 var(--accent-soft)',
      }}
    >
      <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
        {format(now, "EEEE, MMMM d, yyyy '·' h:mm a")}
      </span>
      <Avatar name={name} size={28} />
    </header>
  )
}
