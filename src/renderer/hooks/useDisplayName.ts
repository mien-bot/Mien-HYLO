import { useEffect, useState } from 'react'

/** Reads the user's configured display name from app settings (once on mount). */
export function useDisplayName(): string {
  const [name, setName] = useState('')
  useEffect(() => {
    let alive = true
    window.api
      .getSettings('appSettings')
      .then((raw) => {
        const s = (raw as { displayName?: string } | null) || {}
        if (alive && s.displayName) setName(s.displayName)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return name
}
