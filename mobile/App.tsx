import React, { useEffect, useRef, useState } from 'react'
import { AppState, View, Text, StyleSheet } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { LinearGradient } from 'expo-linear-gradient'
import { NavigationContainer, DefaultTheme } from '@react-navigation/native'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated'
import { useFonts, Nunito_400Regular, Nunito_700Bold, Nunito_800ExtraBold } from '@expo-google-fonts/nunito'
import { colors, withAlpha } from './src/lib/theme'
import { ThemeProvider, useTheme } from './src/lib/ThemeContext'
import { haptic } from './src/lib/motion'
import NoodleSpinner from './src/components/anim/NoodleSpinner'
import SyncingOverlay from './src/components/SyncingOverlay'

import DashboardScreen from './src/screens/DashboardScreen'
import PortfolioScreen from './src/screens/PortfolioScreen'
import StockDetailScreen from './src/screens/StockDetailScreen'
import MarketPulseScreen from './src/screens/MarketPulseScreen'
import HealthScreen from './src/screens/HealthScreen'
import SleepHistoryScreen from './src/screens/SleepHistoryScreen'
import HrvHistoryScreen from './src/screens/HrvHistoryScreen'
import ExerciseHistoryScreen from './src/screens/ExerciseHistoryScreen'
import WeekendScreen from './src/screens/WeekendScreen'
import SavedPlansScreen from './src/screens/SavedPlansScreen'
import PlanDetailScreen from './src/screens/PlanDetailScreen'
import ActivityDetailScreen from './src/screens/ActivityDetailScreen'
import ProductivityScreen from './src/screens/ProductivityScreen'
import ChatScreen from './src/screens/ChatScreen'
import SettingsScreen from './src/screens/SettingsScreen'
import BriefingsScreen from './src/screens/BriefingsScreen'
import AlertsScreen from './src/screens/AlertsScreen'
import { getSettings } from './src/lib/storage'
import { scheduleSleepNotifications } from './src/services/sleep-notifications.service'
import { seamlessSyncFromRelay } from './src/services/health-sync.service'

const Tab = createBottomTabNavigator()
const PortfolioStack = createNativeStackNavigator()
const PlannerStack = createNativeStackNavigator()
const HealthStack = createNativeStackNavigator()
const HomeStack = createNativeStackNavigator()

const darkTheme = {
  ...DefaultTheme,
  dark: true,
  colors: {
    ...DefaultTheme.colors,
    primary: colors.accent.blue,
    background: colors.bg.primary,
    card: colors.bg.secondary,
    text: colors.text.primary,
    border: colors.border,
    notification: colors.accent.red,
  },
}

const TAB_ICONS: Record<string, { focused: keyof typeof Ionicons.glyphMap; default: keyof typeof Ionicons.glyphMap }> = {
  Home: { focused: 'home', default: 'home-outline' },
  Portfolio: { focused: 'trending-up', default: 'trending-up-outline' },
  Health: { focused: 'heart', default: 'heart-outline' },
  Productivity: { focused: 'time', default: 'time-outline' },
  Weekend: { focused: 'calendar', default: 'calendar-outline' },
  Chat: { focused: 'chatbubble', default: 'chatbubble-outline' },
  Settings: { focused: 'settings', default: 'settings-outline' },
}

function PortfolioStackScreen() {
  return (
    <PortfolioStack.Navigator screenOptions={{ headerShown: false }}>
      <PortfolioStack.Screen name="PortfolioList" component={PortfolioScreen} />
      <PortfolioStack.Screen name="StockDetail" component={StockDetailScreen} />
      <PortfolioStack.Screen name="MarketPulse" component={MarketPulseScreen} />
      <PortfolioStack.Screen name="Alerts" component={AlertsScreen} />
    </PortfolioStack.Navigator>
  )
}

function HomeStackScreen() {
  return (
    <HomeStack.Navigator screenOptions={{ headerShown: false }}>
      <HomeStack.Screen name="Dashboard" component={DashboardScreen} />
      <HomeStack.Screen name="Briefings" component={BriefingsScreen} />
    </HomeStack.Navigator>
  )
}

function HealthStackScreen() {
  return (
    <HealthStack.Navigator screenOptions={{ headerShown: false }}>
      <HealthStack.Screen name="HealthMain" component={HealthScreen} />
      <HealthStack.Screen name="SleepHistory" component={SleepHistoryScreen} />
      <HealthStack.Screen name="HrvHistory" component={HrvHistoryScreen} />
      <HealthStack.Screen name="ExerciseHistory" component={ExerciseHistoryScreen} />
    </HealthStack.Navigator>
  )
}

function PlannerStackScreen() {
  return (
    <PlannerStack.Navigator screenOptions={{ headerShown: false }}>
      <PlannerStack.Screen name="PlannerMain" component={WeekendScreen} />
      <PlannerStack.Screen name="SavedPlans" component={SavedPlansScreen} />
      <PlannerStack.Screen name="PlanDetail" component={PlanDetailScreen} />
      <PlannerStack.Screen name="ActivityDetail" component={ActivityDetailScreen} />
    </PlannerStack.Navigator>
  )
}

function ThemedTabs() {
  const { accent } = useTheme()
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarIcon: ({ focused, color }) => {
          const icons = TAB_ICONS[route.name]
          const iconName = focused ? icons.focused : icons.default
          return <Ionicons name={iconName as any} size={22} color={color} />
        },
        tabBarActiveTintColor: accent,
        tabBarInactiveTintColor: colors.text.muted,
        tabBarStyle: {
          backgroundColor: colors.bg.secondary,
          borderTopColor: colors.border,
          borderTopWidth: 0.5,
          paddingTop: 6,
          paddingBottom: 2,
          height: 84,
        },
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: '500' as const,
          marginTop: 2,
        },
        headerShown: false,
      })}
      screenListeners={{
        tabPress: () => haptic('selection'),
      }}
    >
      <Tab.Screen name="Home" component={HomeStackScreen} />
      <Tab.Screen name="Portfolio" component={PortfolioStackScreen} />
      <Tab.Screen name="Health" component={HealthStackScreen} />
      <Tab.Screen name="Productivity" component={ProductivityScreen} />
      <Tab.Screen name="Weekend" component={PlannerStackScreen} />
      <Tab.Screen name="Chat" component={ChatScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  )
}

function BootSplash() {
  const pulse = useSharedValue(0)
  const progress = useSharedValue(0)

  useEffect(() => {
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 950, easing: Easing.out(Easing.cubic) }),
        withTiming(0, { duration: 950, easing: Easing.inOut(Easing.cubic) }),
      ),
      -1,
    )
    progress.value = withTiming(1, { duration: 1050, easing: Easing.out(Easing.cubic) })
  }, [])

  const haloStyle = useAnimatedStyle(() => ({
    opacity: 0.24 + pulse.value * 0.24,
    transform: [{ scale: 0.96 + pulse.value * 0.08 }],
  }))

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 0.98 + pulse.value * 0.015 }],
  }))

  const progressStyle = useAnimatedStyle(() => ({
    width: `${Math.max(12, progress.value * 100)}%`,
  }))

  const dotStyle = useAnimatedStyle(() => ({
    opacity: 0.45 + pulse.value * 0.55,
    transform: [{ translateY: -1 - pulse.value * 2 }],
  }))

  return (
    <Animated.View
      entering={FadeIn.duration(140)}
      exiting={FadeOut.duration(480)}
      style={bootStyles.overlay}
      pointerEvents="none"
    >
      <LinearGradient
        colors={['#050507', '#101015', '#190f0a']}
        locations={[0, 0.58, 1]}
        style={StyleSheet.absoluteFill}
      />
      <View style={bootStyles.glowTop} />
      <View style={bootStyles.glowBottom} />

      <Animated.View style={[bootStyles.haloOuter, haloStyle]} />
      <Animated.View style={[bootStyles.haloInner, haloStyle]} />

      <Animated.View
        entering={FadeIn.duration(420)}
        style={[bootStyles.markCard, cardStyle]}
      >
        <LinearGradient
          colors={[withAlpha(colors.accent.orange, 0.26), withAlpha(colors.accent.blue, 0.08)]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={bootStyles.markGradient}
        >
          <NoodleSpinner size={132} color={colors.text.primary} variant="inside" />
        </LinearGradient>
      </Animated.View>

      <Animated.Text entering={FadeIn.delay(180).duration(360)} style={bootStyles.label}>
        Mien
      </Animated.Text>
      <Animated.View entering={FadeIn.delay(300).duration(360)} style={bootStyles.statusRow}>
        <Text style={bootStyles.statusText}>Preparing your day</Text>
        {[0, 1, 2].map((dot) => (
          <Animated.View
            key={dot}
            style={[
              bootStyles.statusDot,
              dotStyle,
              { backgroundColor: dot === 0 ? colors.accent.orange : dot === 1 ? colors.accent.green : colors.accent.blue },
            ]}
          />
        ))}
      </Animated.View>
      <Animated.View entering={FadeIn.delay(360).duration(320)} style={bootStyles.progressTrack}>
        <Animated.View style={[bootStyles.progressFill, progressStyle]} />
      </Animated.View>
    </Animated.View>
  )
}

export default function App() {
  const [bootDone, setBootDone] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const lastSyncRef = useRef(0)
  const syncInFlightRef = useRef(false)
  const [fontsLoaded] = useFonts({ Nunito_400Regular, Nunito_700Bold, Nunito_800ExtraBold })

  useEffect(() => {
    getSettings().then(s => {
      if (s.enableWindDownNotifications !== 'false') {
        scheduleSleepNotifications().catch(err =>
          console.warn('[App] Failed to schedule sleep notifications:', err)
        )
      }
    })
    // Short boot overlay after the JS bundle is mounted.
    const t = setTimeout(() => setBootDone(true), 1200)
    return () => clearTimeout(t)
  }, [])

  // Auto-sync health data when app comes to foreground (throttled to once per 2 min)
  useEffect(() => {
    const doSync = async (showOverlay = false) => {
      const now = Date.now()
      if (now - lastSyncRef.current < 120_000) return // skip if synced <2 min ago
      if (syncInFlightRef.current) return
      lastSyncRef.current = now
      syncInFlightRef.current = true

      const startedAt = Date.now()
      if (showOverlay) setSyncing(true)

      try {
        await seamlessSyncFromRelay()
      } catch {
      } finally {
        syncInFlightRef.current = false
        if (showOverlay) {
          const remaining = Math.max(0, 700 - (Date.now() - startedAt))
          setTimeout(() => setSyncing(false), remaining)
        }
      }
    }

    // Sync on app launch
    doSync(true)

    // Sync when returning from background
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') doSync(true)
    })

    // Periodic sync every 5 minutes while app is open
    const interval = setInterval(doSync, 5 * 60_000)

    return () => { sub.remove(); clearInterval(interval) }
  }, [])

  return (
    <ThemeProvider>
    <SafeAreaProvider>
      <StatusBar style="light" />
      {(!bootDone || !fontsLoaded) && <BootSplash />}
      <NavigationContainer theme={darkTheme}>
        <ThemedTabs />
      </NavigationContainer>
      {syncing && bootDone && <SyncingOverlay label="Syncing data" />}
    </SafeAreaProvider>
    </ThemeProvider>
  )
}

const bootStyles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bg.primary,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    overflow: 'hidden',
  },
  glowTop: {
    position: 'absolute',
    top: -120,
    left: -80,
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: withAlpha(colors.accent.blue, 0.18),
  },
  glowBottom: {
    position: 'absolute',
    right: -100,
    bottom: -140,
    width: 310,
    height: 310,
    borderRadius: 155,
    backgroundColor: withAlpha(colors.accent.orange, 0.2),
  },
  haloOuter: {
    position: 'absolute',
    width: 245,
    height: 245,
    borderRadius: 123,
    borderWidth: 1,
    borderColor: withAlpha(colors.text.primary, 0.08),
    backgroundColor: withAlpha(colors.text.primary, 0.025),
  },
  haloInner: {
    position: 'absolute',
    width: 178,
    height: 178,
    borderRadius: 89,
    borderWidth: 1,
    borderColor: withAlpha(colors.accent.orange, 0.18),
  },
  markCard: {
    width: 174,
    height: 174,
    borderRadius: 46,
    padding: 16,
    borderWidth: 1,
    borderColor: withAlpha(colors.text.primary, 0.11),
    backgroundColor: withAlpha(colors.bg.secondary, 0.82),
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 18 },
    elevation: 14,
  },
  markGradient: {
    flex: 1,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    color: colors.text.primary,
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: 0,
    marginTop: 24,
  },
  statusRow: {
    minHeight: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    marginTop: 6,
  },
  statusText: {
    color: colors.text.secondary,
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0,
  },
  statusDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  progressTrack: {
    width: 148,
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: withAlpha(colors.text.primary, 0.1),
    marginTop: 20,
  },
  progressFill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.accent.orange,
  },
})
