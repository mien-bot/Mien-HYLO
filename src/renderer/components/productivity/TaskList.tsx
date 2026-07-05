import { Circle, CheckCircle2, AlertCircle, Calendar } from 'lucide-react'
import { format, parseISO, isPast, isToday } from 'date-fns'
import type { TodayTaskItem } from '../../../shared/types/ipc.types'
import NoodleSpinner from '../anim/NoodleSpinner'

interface Props {
  tasks: TodayTaskItem[]
  loading: boolean
  completedIds: Set<string>
  onToggle: (id: string) => void
}

export default function TaskList({ tasks, loading, completedIds, onToggle }: Props) {
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-10">
        <NoodleSpinner size={56} color="var(--accent-amber)" />
      </div>
    )
  }

  if (tasks.length === 0) {
    return (
      <p className="text-sm py-4 text-center" style={{ color: 'var(--text-muted)' }}>
        No tasks for today.
      </p>
    )
  }

  return (
    <div className="space-y-1.5">
      {tasks.map((task) => {
        const isOverdue =
          task.due_date && isPast(parseISO(task.due_date)) && !isToday(parseISO(task.due_date))
        const isDueToday = task.due_date && isToday(parseISO(task.due_date))
        const priorityColor = getPriorityColor(task.priority)
        const isCompleted = completedIds.has(String(task.id))

        return (
          <div
            key={task.id}
            className="flex items-start gap-2.5 p-2.5 rounded-lg hover:bg-white/5 transition-colors cursor-pointer select-none"
            onClick={() => onToggle(String(task.id))}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(String(task.id)) } }}
            tabIndex={0}
            role="button"
            style={{ opacity: isCompleted ? 0.5 : 1 }}
          >
            {isCompleted ? (
              <CheckCircle2
                size={16}
                className="shrink-0 mt-0.5"
                style={{ color: 'var(--accent-green)' }}
              />
            ) : (
              <Circle
                size={16}
                className="shrink-0 mt-0.5"
                style={{ color: 'var(--text-muted)' }}
              />
            )}
            <div className="flex-1 min-w-0">
              <p
                className="text-sm truncate"
                style={{
                  color: isCompleted ? 'var(--text-muted)' : 'var(--text-primary)',
                  textDecoration: isCompleted ? 'line-through' : 'none',
                }}
              >
                {task.title}
              </p>
              <div className="flex items-center gap-2 mt-1">
                {task.time && (
                  <span
                    className="text-xs font-mono"
                    style={{
                      color: isCompleted ? 'var(--text-muted)' : 'var(--accent-blue)',
                      textDecoration: isCompleted ? 'line-through' : 'none',
                    }}
                  >
                    {task.time}
                  </span>
                )}
                {task.due_date && (
                  <span
                    className="flex items-center gap-1 text-xs"
                    style={{
                      color: isCompleted
                        ? 'var(--text-muted)'
                        : isOverdue
                          ? 'var(--accent-red)'
                          : isDueToday
                            ? 'var(--accent-amber)'
                            : 'var(--text-muted)',
                    }}
                  >
                    {isOverdue && !isCompleted && <AlertCircle size={10} />}
                    {isDueToday && !isCompleted && <Calendar size={10} />}
                    {isDueToday ? 'Today' : format(parseISO(task.due_date), 'MMM d')}
                  </span>
                )}
                {task.priority && !isCompleted && (
                  <span
                    className="text-xs px-1.5 py-0.5 rounded"
                    style={{ background: `${priorityColor}20`, color: priorityColor }}
                  >
                    {task.priority}
                  </span>
                )}
                {!isCompleted && (
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {task.status}
                  </span>
                )}
                <span
                  className="text-xs px-1.5 py-0.5 rounded"
                  style={{
                    color:
                      task.source === 'weekend' ? 'var(--accent-purple)' : 'var(--accent-blue)',
                    background:
                      task.source === 'weekend' ? 'rgba(168,85,247,0.12)' : 'rgba(59,130,246,0.12)',
                  }}
                >
                  {task.source === 'weekend' ? 'Weekend' : 'Notion'}
                </span>
              </div>
              {task.location && !isCompleted && (
                <p className="text-xs mt-1 truncate" style={{ color: 'var(--text-muted)' }}>
                  {task.location}
                </p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function getPriorityColor(priority: string | null): string {
  if (!priority) return '#737373'
  const p = priority.toLowerCase()
  if (p === 'high' || p === 'urgent' || p === 'p1') return '#ef4444'
  if (p === 'medium' || p === 'p2') return '#f59e0b'
  if (p === 'low' || p === 'p3') return '#22c55e'
  return '#737373'
}
