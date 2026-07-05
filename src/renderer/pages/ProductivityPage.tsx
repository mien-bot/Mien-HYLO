import { useState, useEffect, useCallback } from 'react'
import {
  Sparkles,
  RefreshCw,
  Calendar,
  Send,
  ChevronDown,
  ChevronUp,
  Moon,
  Users,
  Zap,
  Coffee,
  Pencil,
  Upload,
  Plus,
  X,
  Clock,
  Lock,
  Smartphone,
  Save,
  Trash2,
} from 'lucide-react'
import TaskList from '../components/productivity/TaskList'
import DayTimeline from '../components/productivity/DayTimeline'
import NoodleSpinner from '../components/anim/NoodleSpinner'
import WeatherPreviewCard from '../components/WeatherPreviewCard'
import type {
  TodayTaskItem,
  DailySchedule,
  PlannerWeatherPreview,
} from '../../shared/types/ipc.types'

interface WorkBlock {
  project: string
  details?: string
  duration: string // e.g. "1h", "30m", "1.5h"
}

interface FixedBlock {
  start: string // HH:MM
  end: string // HH:MM
  label: string
}

interface SchedulePreferences {
  specialToday?: string
  afterWorkTasks?: string
  workBlocks?: WorkBlock[]
  fixedBlocks?: FixedBlock[]
  eveningMode?: string
  customEvening?: string
  exerciseType?: string
  exerciseEnabled?: boolean
  exerciseDuration?: string
  wakeTime?: string
  workStartTime?: string
  workEndTime?: string
  sleepTarget?: string // When to stop and sleep
}

interface ProductivitySettings {
  notionCalendarDbId?: string
}

const DEFAULT_HABITS = [
  { time: '09:00-09:30', activity: 'Wake up & get ready', category: 'routine' },
  { time: '09:30-12:00', activity: 'Work — morning block', category: 'work' },
  { time: '12:00-13:00', activity: 'Lunch', category: 'break' },
  { time: '13:00-18:00', activity: 'Work — afternoon block', category: 'work' },
  { time: '18:00-18:20', activity: 'Commute home', category: 'routine' },
  { time: '18:30-19:30', activity: 'Exercise or free time', category: 'free' },
  { time: '19:30-20:00', activity: 'Dinner', category: 'routine' },
  { time: '20:00-01:00', activity: 'Projects / relax', category: 'free' },
  { time: '01:00-02:00', activity: 'Wind down & sleep', category: 'sleep' },
]

const QUICK_PROJECTS = ['HYLO', 'OVA', 'Photography', 'Mien', 'Reading', 'Study', 'Side project']
const DURATION_OPTIONS = ['30m', '1h', '1.5h', '2h', '3h']

interface EditableScheduleBlock {
  time: string
  activity: string
  rationale?: string
}

const EVENING_MODES = [
  {
    id: 'project-work',
    label: 'Project Work',
    icon: Zap,
    desc: 'Use the project list as the evening priority',
  },
  { id: 'relax', label: 'Relax', icon: Coffee, desc: 'Eat, movie/chill, sleep by midnight' },
  { id: 'hangout', label: 'Hang out', icon: Users, desc: 'Social time with friends/family' },
  { id: 'sleep-early', label: 'Sleep early', icon: Moon, desc: 'Eat, wind down, recover' },
  { id: 'custom', label: 'Custom', icon: Pencil, desc: 'Something else in mind' },
]

const EXERCISE_TYPES = [
  'Run',
  'Gym',
  'Walk',
  'Yoga',
  'Basketball',
  'Swimming',
  'Cycling',
  'Home workout',
]

function getCategoryColor(category: string): string {
  switch (category) {
    case 'work':
      return 'var(--accent-amber)'
    case 'routine':
      return 'var(--text-muted)'
    case 'break':
      return '#737373'
    case 'free':
      return 'var(--accent-blue)'
    case 'sleep':
      return 'var(--accent-purple)'
    default:
      return 'var(--text-muted)'
  }
}

export default function ProductivityPage() {
  const [tasks, setTasks] = useState<TodayTaskItem[]>([])
  const [tasksLoading, setTasksLoading] = useState(true)
  const [schedule, setSchedule] = useState<DailySchedule | null>(null)
  const [scheduleLoading, setScheduleLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<string | null>(null)
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const [scheduleHistory, setScheduleHistory] = useState<DailySchedule[]>([])
  const [notionStatus, setNotionStatus] = useState<string | null>(null)
  const [expandedSchedule, setExpandedSchedule] = useState<string | null>(null)
  const [showAllSchedules, setShowAllSchedules] = useState(false)
  const [applyingHistoryDate, setApplyingHistoryDate] = useState<string | null>(null)

  // Schedule questionnaire state
  const [showQuestionnaire, setShowQuestionnaire] = useState(false)
  const [prefs, setPrefs] = useState<SchedulePreferences>({
    eveningMode: 'project-work',
    exerciseEnabled: false,
    exerciseDuration: '1h',
    workStartTime: '09:30',
    workEndTime: '18:00',
    workBlocks: [],
  })
  const [newProject, setNewProject] = useState('')
  const [newProjectDetails, setNewProjectDetails] = useState('')
  const [newDuration, setNewDuration] = useState('1h')
  const [editingSchedule, setEditingSchedule] = useState(false)
  const [editedBlocks, setEditedBlocks] = useState<EditableScheduleBlock[]>([])
  const [scheduleSaveMsg, setScheduleSaveMsg] = useState<string | null>(null)
  const [weatherPreview, setWeatherPreview] = useState<PlannerWeatherPreview | null>(null)
  const [weatherLoading, setWeatherLoading] = useState(false)

  const [relaySyncing, setRelaySyncing] = useState(false)
  const [relaySyncMsg, setRelaySyncMsg] = useState<string | null>(null)

  // Tweak state
  const [tweakInput, setTweakInput] = useState('')
  const [tweaking, setTweaking] = useState(false)
  const [tweakError, setTweakError] = useState<string | null>(null)

  // Task completion state (persisted per day in localStorage)
  const todayKey = new Date().toISOString().slice(0, 10)
  const [completedTasks, setCompletedTasks] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(`tasks-completed-${todayKey}`)
      return stored ? new Set(JSON.parse(stored)) : new Set()
    } catch {
      return new Set()
    }
  })
  const handleToggleTask = useCallback(
    (id: string) => {
      setCompletedTasks((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        localStorage.setItem(`tasks-completed-${todayKey}`, JSON.stringify([...next]))
        return next
      })
    },
    [todayKey],
  )

  const handlePushToPhone = async () => {
    setRelaySyncing(true)
    setRelaySyncMsg(null)
    try {
      await window.api.relaySyncAll()
      setRelaySyncMsg('Synced!')
    } catch {
      setRelaySyncMsg('Sync failed — check relay settings')
    }
    setRelaySyncing(false)
    setTimeout(() => setRelaySyncMsg(null), 3000)
  }

  // Notion export
  const [exportingToNotion, setExportingToNotion] = useState(false)
  const [notionDatabases, setNotionDatabases] = useState<{ id: string; title: string }[]>([])
  const [showDbPicker, setShowDbPicker] = useState(false)

  const loadTodayTasks = useCallback(async () => {
    setTasksLoading(true)
    try {
      const result = await window.api.getTodayTasks()
      setTasks(result)
    } catch (err: any) {
      setSyncError(err.message || 'Failed to load today tasks')
    }
    setTasksLoading(false)
  }, [])

  useEffect(() => {
    window.api
      .getTodaySchedule()
      .then(setSchedule)
      .catch((err) => setSyncError((err as Error)?.message || 'Failed to load today schedule'))
      .finally(() => setScheduleLoading(false))
    window.api
      .getScheduleHistory(30)
      .then(setScheduleHistory)
      .catch((err) => console.warn('[Productivity] Failed to load schedule history:', err))
    loadTodayTasks()
  }, [loadTodayTasks])

  useEffect(() => {
    if (!showQuestionnaire) return
    const today = new Date().toISOString().slice(0, 10)
    setWeatherLoading(true)
    window.api
      .getPlannerWeatherPreview([today])
      .then(setWeatherPreview)
      .catch((err) =>
        setWeatherPreview({
          location: 'Unknown',
          source: 'Open-Meteo',
          days: [],
          unavailableReason: (err as Error)?.message || 'Weather preview unavailable.',
        }),
      )
      .finally(() => setWeatherLoading(false))
  }, [showQuestionnaire])

  const parseScheduleBlocks = (dailySchedule: DailySchedule | null): EditableScheduleBlock[] => {
    if (!dailySchedule) return []
    try {
      const parsed = JSON.parse(dailySchedule.schedule_json)
      return Array.isArray(parsed)
        ? parsed.map((block) => ({
            time: String(block?.time || ''),
            activity: String(block?.activity || ''),
            rationale: block?.rationale ? String(block.rationale) : '',
          }))
        : []
    } catch {
      return []
    }
  }

  const addWorkBlock = (project: string, details = '', duration = newDuration) => {
    const name = project.trim()
    if (!name) return
    setPrefs((p) => ({
      ...p,
      workBlocks: [
        ...(p.workBlocks || []),
        { project: name, details: details.trim() || undefined, duration },
      ],
    }))
    setNewProject('')
    setNewProjectDetails('')
  }

  const startEditingSchedule = () => {
    setEditedBlocks(parseScheduleBlocks(schedule))
    setEditingSchedule(true)
    setScheduleSaveMsg(null)
  }

  const updateEditedBlock = (index: number, patch: Partial<EditableScheduleBlock>) => {
    setEditedBlocks((blocks) =>
      blocks.map((block, i) => (i === index ? { ...block, ...patch } : block)),
    )
  }

  const handleSaveScheduleEdits = async () => {
    if (!schedule) return
    const cleaned = editedBlocks
      .map((block) => ({
        time: block.time.trim(),
        activity: block.activity.trim(),
        rationale: (block.rationale || '').trim(),
      }))
      .filter((block) => block.time && block.activity)

    setScheduleSaveMsg(null)
    try {
      const updated = await window.api.updateTodaySchedule(JSON.stringify(cleaned))
      setSchedule(updated)
      setEditingSchedule(false)
      setScheduleSaveMsg('Schedule updated')
      setTimeout(() => setScheduleSaveMsg(null), 3000)
    } catch (err: any) {
      setScheduleSaveMsg(err.message || 'Could not save schedule')
    }
  }

  const handleTweak = async () => {
    const instruction = tweakInput.trim()
    if (!instruction || !schedule) return
    setTweaking(true)
    setTweakError(null)
    setScheduleSaveMsg(null)
    try {
      const updated = await window.api.tweakDailySchedule(schedule.date, instruction)
      setSchedule(updated)
      setTweakInput('')
      setScheduleSaveMsg('Schedule tweaked')
      setTimeout(() => setScheduleSaveMsg(null), 3000)
    } catch (err: any) {
      setTweakError(err.message || 'Tweak failed')
    }
    setTweaking(false)
  }

  const handleApplyHistoryToToday = async (historyItem: DailySchedule) => {
    setApplyingHistoryDate(historyItem.date)
    setScheduleSaveMsg(null)
    setScheduleError(null)
    setEditingSchedule(false)
    try {
      const updated = await window.api.updateTodaySchedule(historyItem.schedule_json)
      setSchedule(updated)
      const history = await window.api.getScheduleHistory(30)
      setScheduleHistory(history)
      setScheduleSaveMsg('Schedule updated')
      setTimeout(() => setScheduleSaveMsg(null), 3000)
    } catch (err: any) {
      setScheduleError(err.message || 'Could not apply this plan to today')
    } finally {
      setApplyingHistoryDate(null)
    }
  }

  const handleSyncTasks = useCallback(async () => {
    setSyncing(true)
    setSyncError(null)
    setSyncStatus(null)
    try {
      const synced = await window.api.syncNotionTasks()
      await loadTodayTasks()
      setSyncStatus(`Synced ${synced.length} open task${synced.length === 1 ? '' : 's'}`)
      setTimeout(() => setSyncStatus(null), 3000)
    } catch (err: any) {
      setSyncError(err.message || 'Failed to sync tasks')
    }
    setSyncing(false)
  }, [loadTodayTasks])

  const handleGenerateSchedule = async () => {
    setScheduleLoading(true)
    setScheduleError(null)
    setShowQuestionnaire(false)
    setEditingSchedule(false)
    setSchedule(null) // Clear old schedule so spinner shows
    try {
      await window.api.generateSchedule(prefs)
      const sched = await window.api.getTodaySchedule()
      setSchedule(sched)
    } catch (err: any) {
      console.error('Failed to generate schedule:', err)
      setScheduleError(
        err.message || 'Failed to generate schedule — check your Claude API key in Settings',
      )
    }
    setScheduleLoading(false)
  }

  const handleExportToNotion = async (databaseId?: string) => {
    if (!schedule) return
    setExportingToNotion(true)
    setShowDbPicker(false)
    try {
      const today = new Date().toISOString().split('T')[0]
      const result = await window.api.pushScheduleToNotion(
        schedule.schedule_json,
        today,
        databaseId,
      )
      // Persist the picked DB as the new default so subsequent exports go to the same place.
      if (databaseId) {
        try {
          const current =
            ((await window.api.getSettings('appSettings')) as ProductivitySettings | null) || {}
          await window.api.setSettings('appSettings', {
            ...current,
            notionCalendarDbId: databaseId,
          })
        } catch {}
      }
      setNotionStatus(`Sent ${result.created} schedule blocks to Notion!`)
      setTimeout(() => setNotionStatus(null), 4000)
    } catch (err) {
      setNotionStatus(`Failed: ${err instanceof Error ? err.message : String(err)}`)
      setTimeout(() => setNotionStatus(null), 5000)
    }
    setExportingToNotion(false)
  }

  const handleExportClick = async () => {
    // Try default calendar DB first
    try {
      const settings = (await window.api.getSettings('appSettings')) as ProductivitySettings | null
      if (settings?.notionCalendarDbId) {
        handleExportToNotion()
        return
      }
    } catch {}
    // No default — show picker
    try {
      const dbs = await window.api.listNotionDatabases()
      setNotionDatabases(dbs)
      setShowDbPicker(true)
    } catch (err: any) {
      setNotionStatus(`Failed: ${err.message}`)
      setTimeout(() => setNotionStatus(null), 5000)
    }
  }

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>
          Productivity
        </h2>
        <div className="flex items-center gap-2">
          {schedule && (
            <button
              onClick={handleExportClick}
              disabled={exportingToNotion}
              className="flex items-center gap-1.5 text-sm px-3.5 py-1.5 rounded-lg transition-colors disabled:opacity-40"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-blue)' }}
            >
              <Upload size={14} className={exportingToNotion ? 'animate-spin' : ''} />
              Send Schedule to Notion
            </button>
          )}
          <button
            onClick={() => setShowQuestionnaire(!showQuestionnaire)}
            className="flex items-center gap-1.5 text-sm px-3.5 py-1.5 rounded-lg transition-colors"
            style={{
              background: showQuestionnaire ? 'var(--accent-amber)' : 'var(--bg-tertiary)',
              color: showQuestionnaire ? 'white' : 'var(--accent-amber)',
            }}
          >
            <Sparkles size={14} />
            Plan My Day
          </button>
        </div>
      </div>

      {/* Notion status */}
      {notionStatus && (
        <div
          className="text-sm px-3 py-2 rounded-lg"
          style={{
            background: notionStatus.startsWith('Failed')
              ? 'rgba(239,68,68,0.1)'
              : 'rgba(34,197,94,0.1)',
            color: notionStatus.startsWith('Failed') ? 'var(--accent-red)' : 'var(--accent-green)',
          }}
        >
          {notionStatus}
        </div>
      )}

      {/* Notion DB picker modal */}
      {showDbPicker && (
        <div className="card">
          <h3 className="text-sm font-medium mb-3" style={{ color: 'var(--text-primary)' }}>
            Choose a Notion database to export to
          </h3>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {notionDatabases.map((db) => (
              <button
                key={db.id}
                onClick={() => handleExportToNotion(db.id)}
                className="w-full text-left px-3 py-2 rounded-lg text-sm transition-colors hover:bg-white/[0.05]"
                style={{ color: 'var(--text-secondary)' }}
              >
                {db.title}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowDbPicker(false)}
            className="mt-2 text-xs"
            style={{ color: 'var(--text-muted)' }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* AI Schedule Questionnaire */}
      {showQuestionnaire && (
        <div className="card space-y-4">
          <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
            Tell me about your day
          </h3>

          <WeatherPreviewCard preview={weatherPreview} loading={weatherLoading} compact />

          {/* Special today */}
          <div>
            <label className="text-xs block mb-1.5" style={{ color: 'var(--text-muted)' }}>
              Anything special about today?
            </label>
            <input
              type="text"
              value={prefs.specialToday || ''}
              onChange={(e) => setPrefs((p) => ({ ...p, specialToday: e.target.value }))}
              placeholder="e.g. dentist at 3pm, friend visiting, deadline..."
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{
                background: 'var(--bg-tertiary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
              }}
            />
          </div>

          {/* Locked time blocks — immovable commitments */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label
                className="text-xs flex items-center gap-1"
                style={{ color: 'var(--text-muted)' }}
              >
                <Lock size={10} />
                Locked time blocks
                <span className="text-[10px] opacity-70">(work, meetings, appts — won't move)</span>
              </label>
              <button
                onClick={() =>
                  setPrefs((p) => ({
                    ...p,
                    fixedBlocks: [
                      ...(p.fixedBlocks || []),
                      { start: '18:00', end: '21:00', label: 'Work' },
                    ],
                  }))
                }
                className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] transition-colors"
                style={{
                  background: 'var(--bg-tertiary)',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                }}
              >
                <Plus size={10} /> Add
              </button>
            </div>

            {(prefs.fixedBlocks || []).length > 0 && (
              <div className="space-y-1.5 mb-2">
                {(prefs.fixedBlocks || []).map((block, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 p-2 rounded-lg"
                    style={{ background: 'var(--bg-tertiary)' }}
                  >
                    <div
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: 'var(--accent-red)' }}
                    />
                    <input
                      type="time"
                      value={block.start}
                      onChange={(e) => {
                        const blocks = [...(prefs.fixedBlocks || [])]
                        blocks[i] = { ...blocks[i], start: e.target.value }
                        setPrefs((p) => ({ ...p, fixedBlocks: blocks }))
                      }}
                      className="px-1.5 py-0.5 rounded text-xs outline-none"
                      style={{
                        background: 'var(--bg-secondary)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border)',
                      }}
                    />
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      →
                    </span>
                    <input
                      type="time"
                      value={block.end}
                      onChange={(e) => {
                        const blocks = [...(prefs.fixedBlocks || [])]
                        blocks[i] = { ...blocks[i], end: e.target.value }
                        setPrefs((p) => ({ ...p, fixedBlocks: blocks }))
                      }}
                      className="px-1.5 py-0.5 rounded text-xs outline-none"
                      style={{
                        background: 'var(--bg-secondary)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border)',
                      }}
                    />
                    <input
                      type="text"
                      value={block.label}
                      onChange={(e) => {
                        const blocks = [...(prefs.fixedBlocks || [])]
                        blocks[i] = { ...blocks[i], label: e.target.value }
                        setPrefs((p) => ({ ...p, fixedBlocks: blocks }))
                      }}
                      placeholder="Label (Work, Dentist, ...)"
                      className="flex-1 px-2 py-0.5 rounded text-xs outline-none"
                      style={{
                        background: 'var(--bg-secondary)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border)',
                      }}
                    />
                    <button
                      onClick={() =>
                        setPrefs((p) => ({
                          ...p,
                          fixedBlocks: (p.fixedBlocks || []).filter((_, j) => j !== i),
                        }))
                      }
                      className="p-0.5 rounded transition-colors hover:bg-white/[0.05]"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* After-work project blocks */}
          <div>
            <label className="text-xs block mb-2" style={{ color: 'var(--text-muted)' }}>
              Project work
            </label>

            {/* Quick-add project buttons */}
            <div className="flex flex-wrap gap-1.5 mb-2">
              {QUICK_PROJECTS.filter(
                (p) => !(prefs.workBlocks || []).some((b) => b.project === p),
              ).map((project) => (
                <button
                  key={project}
                  onClick={() => addWorkBlock(project, '', '1h')}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs transition-colors"
                  style={{
                    background: 'var(--bg-tertiary)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                  }}
                >
                  <Plus size={10} />
                  {project}
                </button>
              ))}
            </div>

            {/* Added work blocks */}
            {(prefs.workBlocks || []).length > 0 && (
              <div className="space-y-1.5 mb-2">
                {(prefs.workBlocks || []).map((block, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[1fr_120px_24px] gap-2 p-2 rounded-lg"
                    style={{ background: 'var(--bg-tertiary)' }}
                  >
                    <div className="space-y-1">
                      <input
                        type="text"
                        value={block.project}
                        onChange={(e) => {
                          const blocks = [...(prefs.workBlocks || [])]
                          blocks[i] = { ...blocks[i], project: e.target.value }
                          setPrefs((p) => ({ ...p, workBlocks: blocks }))
                        }}
                        placeholder="Project"
                        className="w-full px-2 py-1 rounded text-sm font-medium outline-none"
                        style={{
                          background: 'var(--bg-secondary)',
                          color: 'var(--text-primary)',
                          border: '1px solid var(--border)',
                        }}
                      />
                      <input
                        type="text"
                        value={block.details || ''}
                        onChange={(e) => {
                          const blocks = [...(prefs.workBlocks || [])]
                          blocks[i] = { ...blocks[i], details: e.target.value }
                          setPrefs((p) => ({ ...p, workBlocks: blocks }))
                        }}
                        placeholder="What are you doing for this project?"
                        className="w-full px-2 py-1 rounded text-xs outline-none"
                        style={{
                          background: 'var(--bg-secondary)',
                          color: 'var(--text-primary)',
                          border: '1px solid var(--border)',
                        }}
                      />
                    </div>
                    <select
                      value={block.duration}
                      onChange={(e) => {
                        const blocks = [...(prefs.workBlocks || [])]
                        blocks[i] = { ...blocks[i], duration: e.target.value }
                        setPrefs((p) => ({ ...p, workBlocks: blocks }))
                      }}
                      className="self-start px-2 py-1.5 rounded-lg text-xs outline-none"
                      style={{
                        background: 'var(--bg-secondary)',
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      {DURATION_OPTIONS.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                    <div className="flex justify-end">
                      <button
                        onClick={() =>
                          setPrefs((p) => ({
                            ...p,
                            workBlocks: (p.workBlocks || []).filter((_, j) => j !== i),
                          }))
                        }
                        className="p-0.5 rounded transition-colors hover:bg-white/[0.05]"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  </div>
                ))}
                <div
                  className="flex items-center gap-1.5 text-xs"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <Clock size={10} />
                  Total:{' '}
                  {(prefs.workBlocks || []).reduce((sum, b) => {
                    const match = b.duration.match(/^(\d+\.?\d*)(h|m)$/)
                    if (!match) return sum
                    return (
                      sum + (match[2] === 'h' ? parseFloat(match[1]) * 60 : parseFloat(match[1]))
                    )
                  }, 0)}{' '}
                  min
                </div>
              </div>
            )}

            {/* Custom project input */}
            <div className="grid grid-cols-[180px_1fr_68px_32px] gap-1.5">
              <input
                type="text"
                value={newProject}
                onChange={(e) => setNewProject(e.target.value)}
                placeholder="Project..."
                className="px-3 py-1.5 rounded-lg text-sm outline-none"
                style={{
                  background: 'var(--bg-tertiary)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border)',
                }}
              />
              <input
                type="text"
                value={newProjectDetails}
                onChange={(e) => setNewProjectDetails(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newProject.trim())
                    addWorkBlock(newProject, newProjectDetails, newDuration)
                }}
                placeholder="What are you doing?"
                className="px-3 py-1.5 rounded-lg text-sm outline-none"
                style={{
                  background: 'var(--bg-tertiary)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border)',
                }}
              />
              <select
                value={newDuration}
                onChange={(e) => setNewDuration(e.target.value)}
                className="px-2 py-1.5 rounded-lg text-xs outline-none"
                style={{
                  background: 'var(--bg-tertiary)',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                }}
              >
                {DURATION_OPTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  if (newProject.trim()) addWorkBlock(newProject, newProjectDetails, newDuration)
                }}
                className="px-2.5 py-1.5 rounded-lg text-xs transition-colors"
                style={{ background: 'var(--accent-amber)', color: 'white' }}
              >
                <Plus size={12} />
              </button>
            </div>
          </div>

          {/* Other tasks / errands */}
          <div>
            <label className="text-xs block mb-1.5" style={{ color: 'var(--text-muted)' }}>
              Other tasks or errands?
            </label>
            <input
              type="text"
              value={prefs.afterWorkTasks || ''}
              onChange={(e) => setPrefs((p) => ({ ...p, afterWorkTasks: e.target.value }))}
              placeholder="e.g. grocery shopping, laundry, pick up package..."
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{
                background: 'var(--bg-tertiary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
              }}
            />
          </div>

          {/* Evening mode */}
          <div>
            <label className="text-xs block mb-2" style={{ color: 'var(--text-muted)' }}>
              What kind of evening?
            </label>
            <div className="grid grid-cols-3 gap-2">
              {EVENING_MODES.map((mode) => {
                const Icon = mode.icon
                const selected = prefs.eveningMode === mode.id
                return (
                  <button
                    key={mode.id}
                    onClick={() => setPrefs((p) => ({ ...p, eveningMode: mode.id }))}
                    className="flex flex-col items-center gap-1.5 p-3 rounded-lg transition-all text-center"
                    style={{
                      background: selected ? 'var(--accent-amber)' : 'var(--bg-tertiary)',
                      color: selected ? 'white' : 'var(--text-secondary)',
                      border: selected
                        ? '1px solid var(--accent-amber)'
                        : '1px solid var(--border)',
                    }}
                  >
                    <Icon size={18} />
                    <span className="text-xs font-medium">{mode.label}</span>
                    <span className="text-[10px] opacity-70">{mode.desc}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Exercise picker - independent from evening mode */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Exercise
              </label>
              {prefs.exerciseEnabled ? (
                <button
                  onClick={() => setPrefs((p) => ({ ...p, exerciseEnabled: false }))}
                  className="flex items-center gap-1 px-3 py-1 rounded-full text-xs transition-colors"
                  style={{
                    background: 'var(--bg-tertiary)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                  }}
                >
                  <X size={11} />
                  Remove
                </button>
              ) : (
                <button
                  onClick={() =>
                    setPrefs((p) => ({
                      ...p,
                      exerciseEnabled: true,
                      exerciseType: p.exerciseType || 'Run',
                      exerciseDuration: p.exerciseDuration || '1h',
                    }))
                  }
                  className="flex items-center gap-1 px-3 py-1 rounded-full text-xs transition-colors"
                  style={{
                    background: 'var(--accent-green)',
                    color: 'white',
                    border: '1px solid var(--accent-green)',
                  }}
                >
                  <Plus size={11} />
                  Add exercise
                </button>
              )}
            </div>
            {prefs.exerciseEnabled && (
              <div
                className="flex flex-wrap items-center gap-1.5 p-2 rounded-lg"
                style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}
              >
                {EXERCISE_TYPES.map((type) => {
                  const selected = prefs.exerciseType === type
                  return (
                    <button
                      key={type}
                      onClick={() => setPrefs((p) => ({ ...p, exerciseType: type }))}
                      className="px-3 py-1.5 rounded-full text-xs transition-colors"
                      style={{
                        background: selected ? 'var(--accent-green)' : 'var(--bg-secondary)',
                        color: selected ? 'white' : 'var(--text-secondary)',
                      }}
                    >
                      {type}
                    </button>
                  )
                })}
                <select
                  value={prefs.exerciseDuration || '1h'}
                  onChange={(e) => setPrefs((p) => ({ ...p, exerciseDuration: e.target.value }))}
                  className="px-2 py-1.5 rounded-lg text-xs outline-none"
                  style={{
                    background: 'var(--bg-secondary)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border)',
                  }}
                >
                  {DURATION_OPTIONS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Custom evening input */}
          {prefs.eveningMode === 'custom' && (
            <div>
              <label className="text-xs block mb-1.5" style={{ color: 'var(--text-muted)' }}>
                What do you have in mind?
              </label>
              <input
                type="text"
                value={prefs.customEvening || ''}
                onChange={(e) => setPrefs((p) => ({ ...p, customEvening: e.target.value }))}
                placeholder="e.g. movie night, cooking a new recipe..."
                className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                style={{
                  background: 'var(--bg-tertiary)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border)',
                }}
              />
            </div>
          )}

          {/* Time controls */}
          <div>
            <label className="text-xs block mb-2" style={{ color: 'var(--text-muted)' }}>
              Today's times
            </label>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>
                  Work starts
                </label>
                <input
                  type="time"
                  value={prefs.workStartTime || '09:30'}
                  onChange={(e) => setPrefs((p) => ({ ...p, workStartTime: e.target.value }))}
                  className="w-full px-2.5 py-1.5 rounded-lg text-sm outline-none"
                  style={{
                    background: 'var(--bg-tertiary)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border)',
                  }}
                />
              </div>
              <div>
                <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>
                  Work ends
                </label>
                <input
                  type="time"
                  value={prefs.workEndTime || '18:00'}
                  onChange={(e) => setPrefs((p) => ({ ...p, workEndTime: e.target.value }))}
                  className="w-full px-2.5 py-1.5 rounded-lg text-sm outline-none"
                  style={{
                    background: 'var(--bg-tertiary)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border)',
                  }}
                />
              </div>
              <div>
                <label className="text-[10px] block mb-1" style={{ color: 'var(--text-muted)' }}>
                  Sleep by
                </label>
                <input
                  type="time"
                  value={prefs.sleepTarget || '02:00'}
                  onChange={(e) => setPrefs((p) => ({ ...p, sleepTarget: e.target.value }))}
                  className="w-full px-2.5 py-1.5 rounded-lg text-sm outline-none"
                  style={{
                    background: 'var(--bg-tertiary)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border)',
                  }}
                />
              </div>
            </div>
          </div>

          {/* Generate button */}
          <button
            onClick={handleGenerateSchedule}
            disabled={scheduleLoading}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-40"
            style={{ background: 'var(--accent-amber)', color: 'white' }}
          >
            <Sparkles size={14} className={scheduleLoading ? 'animate-spin' : ''} />
            {scheduleLoading ? 'Generating...' : 'Generate My Schedule'}
          </button>
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        {/* Main schedule area */}
        <div className="col-span-2 space-y-4">
          {/* AI-generated schedule (if exists) */}
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                {schedule ? "Today's Schedule" : 'Default Daily Habits'}
              </h3>
              <div className="flex items-center gap-2">
                {relaySyncMsg && (
                  <span
                    className="text-[10px]"
                    style={{
                      color: relaySyncMsg.startsWith('Synced')
                        ? 'var(--accent-green)'
                        : 'var(--accent-red)',
                    }}
                  >
                    {relaySyncMsg}
                  </span>
                )}
                {schedule && (
                  <>
                    <span
                      className="text-[10px] px-2 py-0.5 rounded-full"
                      style={{ background: 'var(--accent-amber)', color: 'white' }}
                    >
                      AI Generated
                    </span>
                    {scheduleSaveMsg && (
                      <span
                        className="text-[10px]"
                        style={{
                          color:
                            scheduleSaveMsg === 'Schedule updated'
                              ? 'var(--accent-green)'
                              : 'var(--accent-red)',
                        }}
                      >
                        {scheduleSaveMsg}
                      </span>
                    )}
                    {editingSchedule ? (
                      <>
                        <button
                          onClick={handleSaveScheduleEdits}
                          title="Save schedule edits"
                          className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full transition-colors"
                          style={{ background: 'var(--accent-green)', color: 'white' }}
                        >
                          <Save size={10} />
                          Save
                        </button>
                        <button
                          onClick={() => setEditingSchedule(false)}
                          className="text-[10px] px-2 py-0.5 rounded-full transition-colors"
                          style={{
                            background: 'var(--bg-tertiary)',
                            color: 'var(--text-secondary)',
                          }}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={startEditingSchedule}
                        title="Edit this schedule without regenerating"
                        className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full transition-colors"
                        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                      >
                        <Pencil size={10} />
                        Edit
                      </button>
                    )}
                    <button
                      onClick={handleExportClick}
                      disabled={exportingToNotion}
                      title="Send this schedule to Notion calendar"
                      className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full transition-colors disabled:opacity-40"
                      style={{ background: 'var(--accent-purple)', color: 'white' }}
                    >
                      <Send size={10} className={exportingToNotion ? 'animate-spin' : ''} />
                      {exportingToNotion ? 'Sending...' : 'Send to Notion'}
                    </button>
                    <button
                      onClick={handlePushToPhone}
                      disabled={relaySyncing}
                      title="Sync schedule through relay"
                      className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full transition-colors disabled:opacity-40"
                      style={{ background: 'var(--accent-blue)', color: 'white' }}
                    >
                      <Smartphone size={10} />
                      {relaySyncing ? 'Syncing…' : 'Sync'}
                    </button>
                  </>
                )}
              </div>
            </div>

            {schedule && !editingSchedule && (
              <div className="mb-3 flex gap-2">
                <input
                  type="text"
                  value={tweakInput}
                  onChange={(e) => setTweakInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !tweaking && handleTweak()}
                  placeholder="Tweak schedule... e.g. 'move gym to 8pm' or 'add 30min reading before bed'"
                  disabled={tweaking}
                  className="flex-1 px-3 py-1.5 rounded-lg text-xs outline-none transition-colors"
                  style={{
                    background: 'var(--bg-tertiary)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border)',
                  }}
                />
                <button
                  onClick={handleTweak}
                  disabled={tweaking || !tweakInput.trim()}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs transition-colors disabled:opacity-40"
                  style={{ background: 'var(--accent-amber)', color: 'white' }}
                >
                  {tweaking ? (
                    <RefreshCw size={12} className="animate-spin" />
                  ) : (
                    <Pencil size={12} />
                  )}
                  {tweaking ? 'Tweaking...' : 'Tweak'}
                </button>
              </div>
            )}

            {tweakError && (
              <div
                className="mb-3 px-3 py-2 rounded-lg text-xs"
                style={{
                  background: 'rgba(239,68,68,0.1)',
                  color: 'var(--accent-red)',
                  border: '1px solid rgba(239,68,68,0.2)',
                }}
              >
                {tweakError}
              </div>
            )}

            {scheduleError && (
              <div
                className="mb-3 px-3 py-2 rounded-lg text-xs"
                style={{
                  background: 'rgba(239,68,68,0.1)',
                  color: 'var(--accent-red)',
                  border: '1px solid rgba(239,68,68,0.2)',
                }}
              >
                {scheduleError}
              </div>
            )}

            {schedule ? (
              editingSchedule ? (
                <div className="space-y-2">
                  {editedBlocks.map((block, i) => (
                    <div
                      key={i}
                      className="grid grid-cols-[130px_1fr_1fr_28px] gap-2 p-2 rounded-lg"
                      style={{ background: 'var(--bg-tertiary)' }}
                    >
                      <input
                        type="text"
                        value={block.time}
                        onChange={(e) => updateEditedBlock(i, { time: e.target.value })}
                        placeholder="18:00-19:00"
                        className="px-2 py-1.5 rounded text-xs font-mono outline-none"
                        style={{
                          background: 'var(--bg-secondary)',
                          color: 'var(--text-primary)',
                          border: '1px solid var(--border)',
                        }}
                      />
                      <input
                        type="text"
                        value={block.activity}
                        onChange={(e) => updateEditedBlock(i, { activity: e.target.value })}
                        placeholder="Activity"
                        className="px-2 py-1.5 rounded text-xs outline-none"
                        style={{
                          background: 'var(--bg-secondary)',
                          color: 'var(--text-primary)',
                          border: '1px solid var(--border)',
                        }}
                      />
                      <input
                        type="text"
                        value={block.rationale || ''}
                        onChange={(e) => updateEditedBlock(i, { rationale: e.target.value })}
                        placeholder="Why / notes"
                        className="px-2 py-1.5 rounded text-xs outline-none"
                        style={{
                          background: 'var(--bg-secondary)',
                          color: 'var(--text-primary)',
                          border: '1px solid var(--border)',
                        }}
                      />
                      <button
                        onClick={() =>
                          setEditedBlocks((blocks) => blocks.filter((_, j) => j !== i))
                        }
                        className="p-1 rounded transition-colors hover:bg-white/[0.05]"
                        style={{ color: 'var(--text-muted)' }}
                        aria-label="Remove block"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() =>
                      setEditedBlocks((blocks) => [
                        ...blocks,
                        { time: '', activity: '', rationale: '' },
                      ])
                    }
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors"
                    style={{
                      background: 'var(--bg-tertiary)',
                      color: 'var(--text-secondary)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    <Plus size={12} />
                    Add block
                  </button>
                </div>
              ) : (
                <DayTimeline schedule={schedule} loading={scheduleLoading} />
              )
            ) : scheduleLoading ? (
              <div className="flex flex-col items-center justify-center py-16">
                <NoodleSpinner
                  size={72}
                  color="var(--accent-amber)"
                  label="Building your schedule…"
                />
              </div>
            ) : (
              /* Default habits timeline */
              <div className="space-y-1">
                {DEFAULT_HABITS.map((block, i) => (
                  <div key={i} className="flex gap-3 group">
                    <div className="w-24 shrink-0 text-right">
                      <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                        {block.time}
                      </span>
                    </div>
                    <div className="flex flex-col items-center">
                      <div
                        className="w-2.5 h-2.5 rounded-full shrink-0 mt-1"
                        style={{ background: getCategoryColor(block.category) }}
                      />
                      {i < DEFAULT_HABITS.length - 1 && (
                        <div
                          className="w-0.5 flex-1 min-h-6"
                          style={{ background: 'var(--border)' }}
                        />
                      )}
                    </div>
                    <div className="pb-4 flex-1">
                      <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                        {block.activity}
                      </p>
                    </div>
                  </div>
                ))}
                <p className="text-xs text-center pt-2" style={{ color: 'var(--text-muted)' }}>
                  Click "Plan My Day" to customize with AI
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Daily Tasks */}
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                Daily Tasks
              </h3>
              <button
                onClick={handleSyncTasks}
                disabled={syncing}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors disabled:opacity-40"
                style={{ color: 'var(--accent-amber)', background: 'var(--bg-tertiary)' }}
              >
                <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
                Sync
              </button>
            </div>
            {syncError && (
              <p className="text-xs mb-2 px-1" style={{ color: 'var(--accent-red)' }}>
                {syncError}
              </p>
            )}
            {syncStatus && (
              <p className="text-xs mb-2 px-1" style={{ color: 'var(--accent-green)' }}>
                {syncStatus}
              </p>
            )}
            <TaskList
              tasks={tasks}
              loading={tasksLoading}
              completedIds={completedTasks}
              onToggle={handleToggleTask}
            />
          </div>
        </div>
      </div>

      {/* Day Plan History */}
      {scheduleHistory.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
              Day Plan History ({scheduleHistory.length})
            </h3>
            {scheduleHistory.length > 5 && (
              <button
                onClick={() => setShowAllSchedules(!showAllSchedules)}
                className="flex items-center gap-1 text-xs transition-colors"
                style={{ color: 'var(--text-muted)' }}
              >
                {showAllSchedules ? 'Show less' : `Show all ${scheduleHistory.length}`}
                {showAllSchedules ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
            )}
          </div>
          <div className="space-y-1 max-h-[70vh] overflow-y-auto">
            {(showAllSchedules ? scheduleHistory : scheduleHistory.slice(0, 5)).map((s) => {
              const isExpanded = expandedSchedule === s.date
              const blocks = (() => {
                try {
                  const parsed = JSON.parse(s.schedule_json)
                  return Array.isArray(parsed)
                    ? parsed
                        .map((block: any) => ({
                          time: String(block?.time || '').trim(),
                          activity: String(
                            block?.activity || block?.title || 'Untitled block',
                          ).trim(),
                          rationale: block?.rationale ? String(block.rationale).trim() : '',
                        }))
                        .filter(
                          (block: { time: string; activity: string }) =>
                            block.time || block.activity,
                        )
                    : []
                } catch {
                  return []
                }
              })()
              const blockCount = blocks.length
              return (
                <div
                  key={s.date}
                  className="rounded-lg overflow-hidden"
                  style={{ background: isExpanded ? 'var(--bg-tertiary)' : 'transparent' }}
                >
                  <button
                    onClick={() => setExpandedSchedule(isExpanded ? null : s.date)}
                    className="flex items-center justify-between w-full p-3 rounded-lg transition-colors hover:bg-white/[0.03]"
                  >
                    <div className="flex items-center gap-3">
                      <Calendar size={14} style={{ color: 'var(--accent-blue)' }} />
                      <div className="text-left">
                        <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                          {s.date}
                        </p>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          {blockCount} blocks ·{' '}
                          {s.created_at
                            ? new Date(s.created_at).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })
                            : ''}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {isExpanded ? (
                        <ChevronUp size={14} style={{ color: 'var(--text-muted)' }} />
                      ) : (
                        <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} />
                      )}
                    </div>
                  </button>
                  {isExpanded && (
                    <div className="px-3 pb-3">
                      <div
                        className="rounded-lg overflow-hidden"
                        style={{ border: '1px solid var(--border-subtle)' }}
                      >
                        {blocks.map((block, i) => (
                          <div
                            key={i}
                            className="grid gap-3 text-xs px-3 py-2"
                            style={{
                              gridTemplateColumns: '86px minmax(0, 1fr)',
                              borderTop: i === 0 ? 'none' : '1px solid var(--border-subtle)',
                              background: i % 2 === 0 ? 'var(--bg-secondary)' : 'transparent',
                            }}
                          >
                            <span style={{ color: 'var(--text-muted)' }}>
                              {block.time || 'Anytime'}
                            </span>
                            <div className="min-w-0">
                              <p style={{ color: 'var(--text-secondary)' }}>{block.activity}</p>
                              {block.rationale && (
                                <p
                                  className="mt-0.5 line-clamp-2"
                                  style={{ color: 'var(--text-muted)' }}
                                >
                                  {block.rationale}
                                </p>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                      {s.ai_rationale && (
                        <p
                          className="text-xs mt-2 pt-2"
                          style={{
                            color: 'var(--text-muted)',
                            borderTop: '1px solid var(--border)',
                          }}
                        >
                          {s.ai_rationale}
                        </p>
                      )}
                      <div className="flex justify-end mt-3">
                        <button
                          onClick={() => handleApplyHistoryToToday(s)}
                          disabled={applyingHistoryDate === s.date}
                          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
                          style={{ background: 'var(--accent-blue)', color: 'white' }}
                        >
                          <Calendar size={12} />
                          {applyingHistoryDate === s.date ? 'Applying...' : 'Use today'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
