import React from 'react'
import { RefreshCw } from 'lucide-react'

interface State {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
          <div className="text-center space-y-2">
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              Something went wrong
            </h2>
            <p className="text-sm max-w-md" style={{ color: 'var(--text-muted)' }}>
              {this.state.error?.message || 'An unexpected error occurred.'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors"
              style={{ background: 'var(--accent-blue)', color: 'white' }}
            >
              <RefreshCw size={14} />
              Try Again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-lg text-sm transition-colors"
              style={{
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--separator)',
                color: 'var(--text-secondary)',
              }}
            >
              Reload app
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
