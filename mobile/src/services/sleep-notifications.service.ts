import * as Notifications from 'expo-notifications'
import { parseSleepSessions, calculateWindDownRoutine } from './sleep-analysis.service'

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
})

/**
 * Schedule wind-down routine notifications based on circadian analysis.
 * Cancels existing sleep notifications first, then schedules new ones.
 */
export async function scheduleSleepNotifications(): Promise<void> {
  const { status } = await Notifications.requestPermissionsAsync()
  if (status !== 'granted') return

  // Cancel existing sleep notifications
  const scheduled = await Notifications.getAllScheduledNotificationsAsync()
  for (const n of scheduled) {
    if ((n.content.data as any)?.category === 'sleep-routine') {
      await Notifications.cancelScheduledNotificationAsync(n.identifier)
    }
  }

  try {
    const sessions = await parseSleepSessions(14)
    if (sessions.length < 3) return

    const routine = calculateWindDownRoutine(sessions)

    // Schedule key notifications (not all 7 steps — just the important ones)
    const keySteps = [
      { index: 0, title: 'Time to dim lights', body: routine.steps[0].description },
      { index: 1, title: 'Put your phone away', body: routine.steps[1].description },
      { index: 2, title: 'Shower time', body: routine.steps[2].description },
      { index: 6, title: 'Lights out', body: `Target bedtime: ${routine.optimalBedtime}` },
    ]

    for (const step of keySteps) {
      const s = routine.steps[step.index]
      const [h, m] = s.time.split(':').map(Number)

      await Notifications.scheduleNotificationAsync({
        content: {
          title: step.title,
          body: step.body,
          data: { category: 'sleep-routine', step: s.activity },
          sound: true,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DAILY,
          hour: h,
          minute: m,
        },
      })
    }

    console.log(`[SleepNotifications] Scheduled ${keySteps.length} daily reminders`)
  } catch (err) {
    console.error('[SleepNotifications] Failed:', err)
  }
}

/**
 * Cancel all sleep routine notifications
 */
export async function cancelSleepNotifications(): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync()
  for (const n of scheduled) {
    if ((n.content.data as any)?.category === 'sleep-routine') {
      await Notifications.cancelScheduledNotificationAsync(n.identifier)
    }
  }
}
