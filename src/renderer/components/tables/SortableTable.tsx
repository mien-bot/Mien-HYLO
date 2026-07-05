import { useState, useMemo, useCallback } from 'react'
import { Search, ArrowUp, ArrowDown } from 'lucide-react'

type SortDir = 'asc' | 'desc'

interface SortState {
  key: string | null
  dir: SortDir
}

export function useTableSort<T>(
  data: T[],
  accessors: Record<string, (item: T) => number | string | null | undefined>,
  defaultSort?: { key: string; dir: SortDir },
) {
  const [sort, setSort] = useState<SortState>(defaultSort ?? { key: null, dir: 'desc' })

  const toggle = useCallback(
    (key: string) => {
      setSort((prev) => {
        if (prev.key === key) return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        return { key, dir: key === 'date' || key === 'name' ? 'asc' : 'desc' }
      })
    },
    [],
  )

  const sorted = useMemo(() => {
    if (!sort.key || !accessors[sort.key]) return data
    const accessor = accessors[sort.key]
    return [...data].sort((a, b) => {
      const av = accessor(a)
      const bv = accessor(b)
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'string' && typeof bv === 'string') {
        return sort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      }
      return sort.dir === 'asc'
        ? (av as number) - (bv as number)
        : (bv as number) - (av as number)
    })
  }, [data, sort, accessors])

  return { sorted, sortKey: sort.key, sortDir: sort.dir, toggle }
}

export function useTableFilter<T>(
  data: T[],
  searchFn: (item: T, query: string) => boolean,
) {
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    if (!search) return data
    const q = search.toLowerCase()
    return data.filter((item) => searchFn(item, q))
  }, [data, search, searchFn])

  return { filtered, search, setSearch }
}

export function TableSearchBar({
  value,
  onChange,
  placeholder = 'Filter…',
  count,
  total,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  count?: number
  total?: number
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <div className="relative flex-1" style={{ maxWidth: 220 }}>
        <Search
          size={13}
          className="absolute left-2.5 top-1/2 -translate-y-1/2"
          style={{ color: 'var(--text-muted)' }}
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full pl-8 pr-3 py-1.5 text-xs rounded-md border-0 outline-none"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
        />
      </div>
      {value && count != null && total != null && count !== total && (
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {count} of {total}
        </span>
      )}
    </div>
  )
}

export function SortHeader({
  label,
  sortKey,
  currentKey,
  currentDir,
  onSort,
  align = 'right',
  title,
  style,
  className = '',
}: {
  label: string
  sortKey: string
  currentKey: string | null
  currentDir: SortDir
  onSort: (key: string) => void
  align?: 'left' | 'right' | 'center'
  title?: string
  style?: React.CSSProperties
  className?: string
}) {
  const active = currentKey === sortKey
  return (
    <th
      className={`text-${align} py-2 font-medium cursor-pointer select-none hover:text-[var(--text-secondary)] transition-colors ${className}`}
      title={title}
      style={style}
      onClick={() => onSort(sortKey)}
    >
      <span className={`inline-flex items-center gap-0.5 ${align === 'right' ? 'justify-end' : ''}`}>
        {label}
        {active && (currentDir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
      </span>
    </th>
  )
}
