import React, { useState, useEffect, useCallback } from 'react'
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  StyleSheet, Alert, RefreshControl,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { colors } from '../lib/theme'
import NoodleSpinner from '../components/anim/NoodleSpinner'
import WeatherPreviewCard from '../components/WeatherPreviewCard'
import {
  getTodaySchedule, generateDailySchedule,
  type SchedulePreferences, type DailySchedule, type FixedBlock,
} from '../services/productivity.service'
import { fullSyncFromRelay } from '../services/health-sync.service'
import { getSettings, saveSettings } from '../lib/storage'
import { listDatabases, pushScheduleToNotion, type NotionDatabase } from '../services/notion.service'
import { getPlannerWeatherPreview, type PlannerWeatherPreview } from '../services/weather.service'

interface WorkBlock { project: string; duration: string }

const EVENING_MODES = [
  { id: 'exercise-then-work', label: 'Exercise + Work', icon: 'barbell' as const },
  { id: 'straight-to-work', label: 'Straight to Work', icon: 'flash' as const },
  { id: 'relax', label: 'Relax', icon: 'cafe' as const },
  { id: 'hangout', label: 'Hang out', icon: 'people' as const },
  { id: 'sleep-early', label: 'Sleep early', icon: 'moon' as const },
  { id: 'custom', label: 'Custom', icon: 'pencil' as const },
]

const EXERCISE_TYPES = ['Run', 'Gym', 'Walk', 'Yoga', 'Basketball', 'Swimming', 'Cycling']
const QUICK_PROJECTS = ['HYLO', 'OVA', 'Photography', 'Mien', 'Reading', 'Study']
const DURATION_OPTIONS = ['30m', '1h', '1.5h', '2h', '3h']

const DEFAULT_HABITS = [
  { time: '09:00-09:30', activity: 'Wake up & get ready' },
  { time: '09:30-12:00', activity: 'Work — morning block' },
  { time: '12:00-13:00', activity: 'Lunch' },
  { time: '13:00-18:00', activity: 'Work — afternoon block' },
  { time: '18:00-18:20', activity: 'Commute home' },
  { time: '18:30-19:30', activity: 'Exercise or free time' },
  { time: '19:30-20:00', activity: 'Dinner' },
  { time: '20:00-01:00', activity: 'Projects / relax' },
  { time: '01:00-02:00', activity: 'Wind down & sleep' },
]

function getBlockColor(activity: string): string {
  const lower = activity.toLowerCase()
  if (lower.includes('sleep') || lower.includes('wind down')) return colors.accent.purple
  if (lower.includes('exercise') || lower.includes('workout') || lower.includes('gym') || lower.includes('run')) return colors.accent.green
  if (lower.includes('work') && !lower.includes('project')) return colors.accent.amber
  if (lower.includes('break') || lower.includes('lunch') || lower.includes('dinner') || lower.includes('eat')) return colors.text.muted
  if (lower.includes('commute')) return colors.text.muted
  return colors.accent.blue
}

export default function ProductivityScreen() {
  const [schedule, setSchedule] = useState<DailySchedule | null>(null)
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [showPlanner, setShowPlanner] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [pushingNotion, setPushingNotion] = useState(false)
  const [notionSent, setNotionSent] = useState(false)
  const [weatherPreview, setWeatherPreview] = useState<PlannerWeatherPreview | null>(null)
  const [weatherLoading, setWeatherLoading] = useState(false)

  // Prefs
  const [specialToday, setSpecialToday] = useState('')
  const [afterWorkTasks, setAfterWorkTasks] = useState('')
  const [workBlocks, setWorkBlocks] = useState<WorkBlock[]>([])
  const [fixedBlocks, setFixedBlocks] = useState<FixedBlock[]>([])
  const [eveningMode, setEveningMode] = useState('exercise-then-work')
  const [exerciseType, setExerciseType] = useState('Run')
  const [customEvening, setCustomEvening] = useState('')

  useEffect(() => {
    loadSchedule()
  }, [])

  const loadSchedule = async () => {
    setLoading(true)
    try {
      const s = await getTodaySchedule()
      setSchedule(s)
    } catch {}
    setLoading(false)
  }

  const handleSyncFromDesktop = async () => {
    setSyncing(true)
    try {
      await fullSyncFromRelay()
      await loadSchedule()
    } catch {}
    setSyncing(false)
  }

  const handleGenerate = async () => {
    setGenerating(true)
    setShowPlanner(false)
    try {
      const prefs: SchedulePreferences = {
        specialToday: specialToday || undefined,
        afterWorkTasks: afterWorkTasks || undefined,
        workBlocks: workBlocks.length > 0 ? workBlocks : undefined,
        fixedBlocks: fixedBlocks.length > 0 ? fixedBlocks.filter(b => b.start && b.end && b.label) : undefined,
        eveningMode,
        exerciseType: eveningMode === 'exercise-then-work' ? exerciseType : undefined,
        customEvening: eveningMode === 'custom' ? customEvening : undefined,
        workStartTime: '09:30',
        workEndTime: '18:00',
        sleepTarget: '02:00',
      }
      const s = await generateDailySchedule(prefs)
      setSchedule(s)
    } catch (err: any) {
      Alert.alert('Error', err.message || 'Failed to generate schedule')
    }
    setGenerating(false)
  }

  const sendScheduleToNotion = async (databaseId: string, persistDefault = false) => {
    if (!schedule) return
    const count = await pushScheduleToNotion(databaseId, schedule.schedule_json, schedule.date)
    if (persistDefault) {
      const current = await getSettings()
      await saveSettings({ ...current, notionCalendarDbId: databaseId })
    }
    setNotionSent(true)
    setTimeout(() => setNotionSent(false), 3000)
    Alert.alert('Sent!', `${count} schedule blocks added to Notion.`)
  }

  const handleNotionPress = async () => {
    if (!schedule || pushingNotion || notionSent) return
    setPushingNotion(true)
    try {
      const settings = await getSettings()
      if (settings.notionCalendarDbId) {
        await sendScheduleToNotion(settings.notionCalendarDbId)
        return
      }

      const dbs = await listDatabases()
      if (dbs.length === 0) {
        Alert.alert('No Databases', 'No Notion databases found. Check your integration token and shared pages.')
        return
      }
      if (dbs.length === 1) {
        await sendScheduleToNotion(dbs[0].id, true)
        return
      }

      const buttons = dbs.slice(0, 8).map((db: NotionDatabase) => ({
        text: db.title,
        onPress: async () => {
          setPushingNotion(true)
          try {
            await sendScheduleToNotion(db.id, true)
          } catch (err: any) {
            Alert.alert('Notion Error', err.message || 'Failed to send schedule to Notion')
          } finally {
            setPushingNotion(false)
          }
        },
      }))
      Alert.alert(
        'Send Schedule to Notion',
        'Select a database',
        [...buttons, { text: 'Cancel', style: 'cancel' }]
      )
    } catch (err: any) {
      Alert.alert('Notion Error', err.message || 'Failed to send schedule to Notion')
    } finally {
      setPushingNotion(false)
    }
  }

  const addProject = (name: string) => {
    if (workBlocks.some(b => b.project === name)) return
    setWorkBlocks([...workBlocks, { project: name, duration: '1h' }])
  }

  const removeProject = (i: number) => {
    setWorkBlocks(workBlocks.filter((_, j) => j !== i))
  }

  const setDuration = (i: number, dur: string) => {
    const blocks = [...workBlocks]
    blocks[i] = { ...blocks[i], duration: dur }
    setWorkBlocks(blocks)
  }

  const addFixedBlock = () => {
    setFixedBlocks([...fixedBlocks, { start: '18:00', end: '21:00', label: 'Work' }])
  }
  const removeFixedBlock = (i: number) => {
    setFixedBlocks(fixedBlocks.filter((_, j) => j !== i))
  }
  const updateFixedBlock = (i: number, patch: Partial<FixedBlock>) => {
    const next = [...fixedBlocks]
    next[i] = { ...next[i], ...patch }
    setFixedBlocks(next)
  }

  const renderTimeline = (blocks: { time: string; activity: string; rationale?: string }[]) => (
    <View>
      {blocks.map((block, i) => (
        <View key={i} style={s.timeBlock}>
          <View style={s.timeCol}>
            <Text style={s.timeText}>{block.time}</Text>
          </View>
          <View style={s.dotCol}>
            <View style={[s.dot, { backgroundColor: getBlockColor(block.activity) }]} />
            {i < blocks.length - 1 && <View style={s.line} />}
          </View>
          <View style={s.contentCol}>
            <Text style={s.activityText}>{block.activity}</Text>
            {block.rationale ? (
              <Text style={s.rationaleText}>{block.rationale}</Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  )

  let scheduleBlocks: any[] = []
  if (schedule) {
    try { scheduleBlocks = JSON.parse(schedule.schedule_json) } catch {}
  }

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <ScrollView
        contentContainerStyle={s.scroll}
        refreshControl={
          <RefreshControl
            refreshing={syncing}
            onRefresh={handleSyncFromDesktop}
            tintColor={colors.accent.blue}
            title="Syncing from desktop…"
            titleColor={colors.text.muted}
          />
        }
      >
        {/* Header */}
        <View style={s.header}>
          <Text style={s.title}>Productivity</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TouchableOpacity
              onPress={handleSyncFromDesktop}
              disabled={syncing}
              style={{ opacity: syncing ? 0.4 : 1 }}
            >
              <Ionicons name="phone-portrait-outline" size={20} color={colors.accent.blue} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.planBtn, showPlanner && s.planBtnActive]}
              onPress={() => {
                const next = !showPlanner
                setShowPlanner(next)
                if (next && !weatherPreview && !weatherLoading) {
                  setWeatherLoading(true)
                  const today = new Date().toISOString().split('T')[0]
                  getPlannerWeatherPreview({ dates: [today] })
                    .then((p) => setWeatherPreview(p))
                    .catch(() => {})
                    .finally(() => setWeatherLoading(false))
                }
              }}
            >
              <Ionicons name="sparkles" size={16} color={showPlanner ? '#fff' : colors.accent.amber} />
              <Text style={[s.planBtnText, showPlanner && { color: '#fff' }]}>Plan My Day</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Planner form */}
        {showPlanner && (
          <View style={s.card}>
            <Text style={s.cardTitle}>Tell me about your day</Text>

            <Text style={s.label}>Anything special today?</Text>
            <TextInput
              style={s.input}
              value={specialToday}
              onChangeText={setSpecialToday}
              placeholder="e.g. dentist at 3pm, deadline..."
              placeholderTextColor={colors.text.muted}
            />

            {/* Locked time blocks */}
            <View style={s.lockedHeader}>
              <Text style={s.label}>
                <Ionicons name="lock-closed" size={11} color={colors.text.muted} />  Locked time blocks
              </Text>
              <TouchableOpacity style={s.addChip} onPress={addFixedBlock}>
                <Ionicons name="add" size={12} color={colors.text.secondary} />
                <Text style={s.addChipText}>Add</Text>
              </TouchableOpacity>
            </View>
            {fixedBlocks.map((b, i) => (
              <View key={i} style={s.lockedRow}>
                <View style={[s.projectDot, { backgroundColor: colors.accent.red || '#ff453a' }]} />
                <TextInput
                  style={s.timeInput}
                  value={b.start}
                  onChangeText={v => updateFixedBlock(i, { start: v })}
                  placeholder="18:00"
                  placeholderTextColor={colors.text.muted}
                  maxLength={5}
                />
                <Text style={{ color: colors.text.muted, fontSize: 11 }}>→</Text>
                <TextInput
                  style={s.timeInput}
                  value={b.end}
                  onChangeText={v => updateFixedBlock(i, { end: v })}
                  placeholder="21:00"
                  placeholderTextColor={colors.text.muted}
                  maxLength={5}
                />
                <TextInput
                  style={s.labelInput}
                  value={b.label}
                  onChangeText={v => updateFixedBlock(i, { label: v })}
                  placeholder="Work"
                  placeholderTextColor={colors.text.muted}
                />
                <TouchableOpacity onPress={() => removeFixedBlock(i)} style={{ padding: 4 }}>
                  <Ionicons name="close" size={14} color={colors.text.muted} />
                </TouchableOpacity>
              </View>
            ))}

            {/* Project blocks */}
            <Text style={s.label}>After-work projects</Text>
            <View style={s.chipRow}>
              {QUICK_PROJECTS.filter(p => !workBlocks.some(b => b.project === p)).map(p => (
                <TouchableOpacity key={p} style={s.addChip} onPress={() => addProject(p)}>
                  <Ionicons name="add" size={12} color={colors.text.secondary} />
                  <Text style={s.addChipText}>{p}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {workBlocks.map((b, i) => (
              <View key={i} style={s.projectRow}>
                <View style={[s.projectDot, { backgroundColor: colors.accent.amber }]} />
                <Text style={s.projectName}>{b.project}</Text>
                <View style={s.durRow}>
                  {DURATION_OPTIONS.map(d => (
                    <TouchableOpacity key={d}
                      style={[s.durChip, b.duration === d && s.durChipActive]}
                      onPress={() => setDuration(i, d)}
                    >
                      <Text style={[s.durChipText, b.duration === d && { color: '#fff' }]}>{d}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TouchableOpacity onPress={() => removeProject(i)} style={{ padding: 4 }}>
                  <Ionicons name="close" size={14} color={colors.text.muted} />
                </TouchableOpacity>
              </View>
            ))}

            <Text style={s.label}>Other tasks or errands?</Text>
            <TextInput
              style={s.input}
              value={afterWorkTasks}
              onChangeText={setAfterWorkTasks}
              placeholder="e.g. grocery shopping, laundry..."
              placeholderTextColor={colors.text.muted}
            />

            {/* Evening mode */}
            <Text style={s.label}>What kind of evening?</Text>
            <View style={s.modeGrid}>
              {EVENING_MODES.map(m => (
                <TouchableOpacity key={m.id}
                  style={[s.modeBtn, eveningMode === m.id && s.modeBtnActive]}
                  onPress={() => setEveningMode(m.id)}
                >
                  <Ionicons name={m.icon as any} size={18} color={eveningMode === m.id ? '#fff' : colors.text.secondary} />
                  <Text style={[s.modeBtnText, eveningMode === m.id && { color: '#fff' }]}>{m.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {eveningMode === 'exercise-then-work' && (
              <View style={s.chipRow}>
                {EXERCISE_TYPES.map(t => (
                  <TouchableOpacity key={t}
                    style={[s.addChip, exerciseType === t && { backgroundColor: colors.accent.green }]}
                    onPress={() => setExerciseType(t)}
                  >
                    <Text style={[s.addChipText, exerciseType === t && { color: '#fff' }]}>{t}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {eveningMode === 'custom' && (
              <TextInput
                style={[s.input, { marginTop: 8 }]}
                value={customEvening}
                onChangeText={setCustomEvening}
                placeholder="What do you have in mind?"
                placeholderTextColor={colors.text.muted}
              />
            )}

            <WeatherPreviewCard
              preview={weatherPreview}
              loading={weatherLoading}
              compact
            />

            <TouchableOpacity style={s.generateBtn} onPress={handleGenerate} disabled={generating}>
              {generating ? (
                <NoodleSpinner size={18} color="#fff" />
              ) : (
                <>
                  <Ionicons name="sparkles" size={16} color="#fff" />
                  <Text style={s.generateBtnText}>Generate My Schedule</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        )}

        {/* Schedule display */}
        <View style={s.card}>
          <View style={s.scheduleHeader}>
            <Text style={s.cardTitle}>
              {schedule ? "Today's Schedule" : 'Default Daily Habits'}
            </Text>
            {schedule && (
              <View style={s.scheduleActions}>
                <TouchableOpacity
                  onPress={handleNotionPress}
                  disabled={pushingNotion || notionSent}
                  style={[s.notionBtn, notionSent && { backgroundColor: colors.accent.green }, (pushingNotion || notionSent) && { opacity: 0.85 }]}
                >
                  {pushingNotion ? (
                    <NoodleSpinner size={13} color="#fff" />
                  ) : (
                    <Ionicons name={notionSent ? 'checkmark' : 'send'} size={13} color="#fff" />
                  )}
                  <Text style={s.notionBtnText}>{notionSent ? 'Sent' : 'Notion'}</Text>
                </TouchableOpacity>
                <View style={s.aiBadge}>
                  <Text style={s.aiBadgeText}>AI Generated</Text>
                </View>
              </View>
            )}
          </View>

          {loading || generating ? (
            <View style={{ paddingVertical: 40, alignItems: 'center' }}>
              <NoodleSpinner size={28} color={colors.accent.amber} />
            </View>
          ) : schedule && scheduleBlocks.length > 0 ? (
            renderTimeline(scheduleBlocks)
          ) : (
            <>
              {renderTimeline(DEFAULT_HABITS)}
              <Text style={s.hintText}>Tap "Plan My Day" to customize with AI</Text>
            </>
          )}

          {schedule?.ai_rationale ? (
            <Text style={s.rationaleBlock}>{schedule.ai_rationale}</Text>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg.primary },
  scroll: { padding: 16, paddingBottom: 32 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 24, fontWeight: '600', color: colors.text.primary },
  planBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, backgroundColor: colors.bg.tertiary },
  planBtnActive: { backgroundColor: colors.accent.amber },
  planBtnText: { fontSize: 13, fontWeight: '500', color: colors.accent.amber },
  card: { backgroundColor: colors.bg.secondary, borderRadius: 14, padding: 16, marginBottom: 12 },
  cardTitle: { fontSize: 14, fontWeight: '500', color: colors.text.secondary, marginBottom: 12 },
  label: { fontSize: 11, color: colors.text.muted, marginTop: 12, marginBottom: 6 },
  input: { backgroundColor: colors.bg.tertiary, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, color: colors.text.primary, borderWidth: 1, borderColor: colors.border },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  addChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16, backgroundColor: colors.bg.tertiary, borderWidth: 1, borderColor: colors.border },
  addChipText: { fontSize: 12, color: colors.text.secondary },
  projectRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, paddingHorizontal: 8, backgroundColor: colors.bg.tertiary, borderRadius: 10, marginTop: 6 },
  lockedHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, marginBottom: 6 },
  lockedRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingHorizontal: 8, backgroundColor: colors.bg.tertiary, borderRadius: 10, marginTop: 6 },
  timeInput: { backgroundColor: colors.bg.secondary, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, fontSize: 12, color: colors.text.primary, borderWidth: 1, borderColor: colors.border, width: 60, textAlign: 'center' },
  labelInput: { flex: 1, backgroundColor: colors.bg.secondary, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, fontSize: 12, color: colors.text.primary, borderWidth: 1, borderColor: colors.border },
  projectDot: { width: 6, height: 6, borderRadius: 3 },
  projectName: { fontSize: 13, fontWeight: '500', color: colors.text.primary, flex: 1 },
  durRow: { flexDirection: 'row', gap: 2 },
  durChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  durChipActive: { backgroundColor: colors.accent.amber },
  durChipText: { fontSize: 10, color: colors.text.muted },
  modeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  modeBtn: { alignItems: 'center', gap: 4, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: colors.bg.tertiary, borderWidth: 1, borderColor: colors.border, width: '31%' as any },
  modeBtnActive: { backgroundColor: colors.accent.amber, borderColor: colors.accent.amber },
  modeBtnText: { fontSize: 10, color: colors.text.secondary, textAlign: 'center' },
  generateBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.accent.amber, borderRadius: 10, paddingVertical: 12, marginTop: 16 },
  generateBtnText: { fontSize: 14, fontWeight: '600', color: '#fff' },
  scheduleHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  scheduleActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  notionBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.accent.purple, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10 },
  notionBtnText: { fontSize: 9, fontWeight: '600', color: '#fff' },
  aiBadge: { backgroundColor: colors.accent.amber, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  aiBadgeText: { fontSize: 9, fontWeight: '600', color: '#fff' },
  timeBlock: { flexDirection: 'row', marginBottom: 2 },
  timeCol: { width: 80, alignItems: 'flex-end', paddingRight: 8 },
  timeText: { fontSize: 11, fontFamily: 'monospace', color: colors.text.muted, marginTop: 2 },
  dotCol: { alignItems: 'center', width: 16 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 4 },
  line: { width: 1.5, flex: 1, minHeight: 20, backgroundColor: colors.border },
  contentCol: { flex: 1, paddingLeft: 8, paddingBottom: 14 },
  activityText: { fontSize: 13, fontWeight: '500', color: colors.text.primary },
  rationaleText: { fontSize: 11, color: colors.text.muted, marginTop: 2 },
  hintText: { fontSize: 12, color: colors.text.muted, textAlign: 'center', marginTop: 12 },
  rationaleBlock: { fontSize: 11, color: colors.text.muted, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border },
})
