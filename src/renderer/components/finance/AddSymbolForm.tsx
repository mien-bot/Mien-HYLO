import { useState } from 'react'
import { Plus } from 'lucide-react'

interface Props {
  onAdd: (symbol: string, type: string, name?: string) => Promise<void>
}

export default function AddSymbolForm({ onAdd }: Props) {
  const [symbol, setSymbol] = useState('')
  const [type, setType] = useState<'stock' | 'crypto' | 'etf'>('stock')
  const [adding, setAdding] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!symbol.trim()) return
    setAdding(true)
    await onAdd(symbol.trim().toUpperCase(), type)
    setSymbol('')
    setAdding(false)
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex items-center gap-2 mt-4 pt-4"
      style={{ borderTop: '1px solid var(--border)' }}
    >
      <input
        type="text"
        value={symbol}
        onChange={(e) => setSymbol(e.target.value.toUpperCase())}
        placeholder="AAPL, BTC, SPY..."
        className="flex-1 px-3 py-2 rounded-lg border text-sm outline-none focus:border-blue-500/50 transition-colors"
        style={{
          background: 'var(--bg-secondary)',
          borderColor: 'var(--border)',
          color: 'var(--text-primary)',
        }}
      />
      <select
        value={type}
        onChange={(e) => setType(e.target.value as 'stock' | 'crypto' | 'etf')}
        className="px-3 py-2 rounded-lg border text-sm outline-none"
        style={{
          background: 'var(--bg-secondary)',
          borderColor: 'var(--border)',
          color: 'var(--text-primary)',
        }}
      >
        <option value="stock">Stock</option>
        <option value="crypto">Crypto</option>
        <option value="etf">ETF</option>
      </select>
      <button
        type="submit"
        disabled={adding || !symbol.trim()}
        className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm transition-colors hover:opacity-80 disabled:opacity-40"
        style={{ background: 'var(--accent-blue)', color: 'white' }}
      >
        <Plus size={14} />
        Add
      </button>
    </form>
  )
}
