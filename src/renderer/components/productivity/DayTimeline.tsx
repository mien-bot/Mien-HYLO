import type { DailySchedule } from '../../../shared/types/ipc.types'
import NoodleSpinner from '../anim/NoodleSpinner'

interface TimeBlock {
  time: string
  activity: string
  rationale: string
}

interface Props {
  schedule: DailySchedule | null
  loading: boolean
}

export default function DayTimeline({ schedule, loading }: Props) {
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <NoodleSpinner size={72} color="var(--accent-amber)" />
      </div>
    )
  }

  if (!schedule) {
    return (
      <p className="text-sm py-8 text-center" style={{ color: 'var(--text-muted)' }}>
        No schedule for today. Click "Generate Schedule" to create an AI-optimized day plan.
      </p>
    )
  }

  let blocks: TimeBlock[] = []
  try {
    blocks = JSON.parse(schedule.schedule_json)
  } catch {
    // If it's not JSON, show as plain text
    return (
      <div
        className="text-sm leading-relaxed whitespace-pre-wrap"
        style={{ color: 'var(--text-primary)' }}
      >
        {schedule.schedule_json}
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {blocks.map((block, i) => {
        const color = getBlockColor(block.activity)
        return (
          <div key={i} className="flex gap-3 group">
            {/* Time column */}
            <div className="w-24 shrink-0 text-right">
              <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                {block.time}
              </span>
            </div>

            {/* Connector */}
            <div className="flex flex-col items-center">
              <div
                className="w-2.5 h-2.5 rounded-full shrink-0 mt-1"
                style={{ background: color }}
              />
              {i < blocks.length - 1 && (
                <div className="w-0.5 flex-1 min-h-6" style={{ background: 'var(--border)' }} />
              )}
            </div>

            {/* Content */}
            <div className="pb-4 flex-1">
              <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                {block.activity}
              </p>
              <p
                className="text-xs mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ color: 'var(--text-muted)' }}
              >
                {block.rationale}
              </p>
            </div>
          </div>
        )
      })}

      {schedule.ai_rationale && (
        <div
          className="mt-4 pt-4 text-xs"
          style={{ borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }}
        >
          {schedule.ai_rationale}
        </div>
      )}
    </div>
  )
}

function getBlockColor(activity: string): string {
  const lower = activity.toLowerCase()
  if (lower.includes('sleep') || lower.includes('wind down') || lower.includes('bed'))
    return '#a855f7'
  if (lower.includes('exercise') || lower.includes('workout') || lower.includes('gym'))
    return '#22c55e'
  if (
    lower.includes('market') ||
    lower.includes('trading') ||
    lower.includes('finance') ||
    lower.includes('invest')
  )
    return '#3b82f6'
  if (lower.includes('break') || lower.includes('lunch') || lower.includes('rest')) return '#737373'
  if (lower.includes('focus') || lower.includes('deep work') || lower.includes('work'))
    return '#f59e0b'
  if (lower.includes('meeting') || lower.includes('call')) return '#ef4444'
  return '#6b7280'
}
