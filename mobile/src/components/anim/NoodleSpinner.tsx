import React, { useEffect, useMemo, useState } from 'react'
import { AccessibilityInfo, View, Text, StyleSheet, ViewStyle } from 'react-native'
import Svg, { Path, Ellipse, Rect, Line, G, Defs, ClipPath } from 'react-native-svg'
import Animated, {
  useSharedValue,
  useAnimatedProps,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  Easing,
  type SharedValue,
} from 'react-native-reanimated'
import {
  NOODLE_VIEWBOX,
  CHOPSTICK_PATHS,
  DANGLING_NOODLE_PATHS,
  DANGLING_NOODLE_PATHS_ALT,
  BOWL_RIM,
  BOWL_BODY,
  BOWL_BASE,
  INSIDE_NOODLE_PATHS,
  INSIDE_NOODLE_PATHS_ALT,
  STEAM_PUFFS,
} from './noodleGeometry'

export type NoodleVariant =
  | 'random'
  | 'inside'
  | 'slurp'
  | 'twirl'
  | 'steam'
  | 'wiggle'
  | 'bowl-wobble'

interface Props {
  size?: number
  color?: string
  variant?: NoodleVariant
  label?: string
  style?: ViewStyle
}

const CYCLEABLE: Exclude<NoodleVariant, 'random'>[] = [
  'slurp',
  'twirl',
  'steam',
  'wiggle',
  'bowl-wobble',
]

const AnimatedSvg = Animated.createAnimatedComponent(Svg)
const AnimatedG = Animated.createAnimatedComponent(G)
const AnimatedPath = Animated.createAnimatedComponent(Path)
const AnimatedEllipse = Animated.createAnimatedComponent(Ellipse)

function pickVariant(v: NoodleVariant): Exclude<NoodleVariant, 'random'> {
  if (v === 'random') return CYCLEABLE[Math.floor(Math.random() * CYCLEABLE.length)]
  return v
}

// Listen for the OS-level reduce-motion accessibility setting so spinners
// can stop animating for users who request it.
function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    let mounted = true
    AccessibilityInfo.isReduceMotionEnabled().then(v => { if (mounted) setReduce(v) })
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce)
    return () => { mounted = false; sub.remove() }
  }, [])
  return reduce
}

// Bowl rocks around its base, not its center, for a believable wobble.
const BOWL_PIVOT_X = 32
const BOWL_PIVOT_Y = 49

export default function NoodleSpinner({
  size = 28,
  color = '#f5f5f7',
  variant = 'inside',
  label,
  style,
}: Props) {
  const chosen = useMemo(() => pickVariant(variant), [variant])
  const reduce = useReduceMotion()

  // Shared drivers — only the ones the chosen variant needs will animate.
  const bowlRotate = useSharedValue(0)
  const twirl = useSharedValue(0)
  const insideBob = useSharedValue(0)
  const chopstickY = useSharedValue(0)
  const chopstickRot = useSharedValue(0)
  const morph = useSharedValue(0)
  const slurp = useSharedValue(0)
  const steamProgress = [useSharedValue(0), useSharedValue(0), useSharedValue(0)]

  useEffect(() => {
    if (reduce) return

    // Inside: bowl and chopsticks stay still — only the noodles inside swirl.
    if (chosen === 'inside') {
      twirl.value = withRepeat(
        withSequence(
          withTiming(7, { duration: 1300, easing: Easing.inOut(Easing.ease) }),
          withTiming(-7, { duration: 1300, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      )
      insideBob.value = withRepeat(
        withSequence(
          withTiming(-1.2, { duration: 1100, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.6, { duration: 1100, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      )
      return
    }

    // Chopsticks always animate — each variant has its own feel
    if (chosen === 'slurp') {
      // Slurp: pronounced lift + tilt, like picking up noodles
      chopstickY.value = withRepeat(
        withSequence(
          withTiming(-6, { duration: 700, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 700, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      )
      chopstickRot.value = withRepeat(
        withSequence(
          withTiming(-7, { duration: 700, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 700, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      )
      slurp.value = withRepeat(withTiming(1, { duration: 1400 }), -1, true)
    } else if (chosen === 'twirl') {
      // Twirl: chopsticks do a circular stirring motion
      chopstickY.value = withRepeat(
        withSequence(
          withTiming(-3, { duration: 600, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 600, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      )
      chopstickRot.value = withRepeat(
        withSequence(
          withTiming(-5, { duration: 600, easing: Easing.inOut(Easing.ease) }),
          withTiming(5, { duration: 600, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 600, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      )
    } else if (chosen === 'bowl-wobble') {
      // Bowl-wobble: chopsticks sway opposite to the bowl
      chopstickY.value = withRepeat(
        withSequence(
          withTiming(-2, { duration: 800, easing: Easing.inOut(Easing.ease) }),
          withTiming(1, { duration: 800, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      )
      chopstickRot.value = withRepeat(
        withSequence(
          withTiming(3, { duration: 800, easing: Easing.inOut(Easing.ease) }),
          withTiming(-3, { duration: 800, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      )
    } else {
      // Steam, wiggle: gentle idle bounce
      chopstickY.value = withRepeat(
        withSequence(
          withTiming(-2, { duration: 1000, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 1000, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      )
      chopstickRot.value = withRepeat(
        withSequence(
          withTiming(-3, { duration: 1000, easing: Easing.inOut(Easing.ease) }),
          withTiming(3, { duration: 1000, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      )
    }

    if (chosen === 'bowl-wobble') {
      bowlRotate.value = withRepeat(
        withSequence(
          withTiming(4, { duration: 800, easing: Easing.inOut(Easing.ease) }),
          withTiming(-4, { duration: 800, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      )
    }
    if (chosen === 'twirl') {
      twirl.value = withRepeat(
        withSequence(
          withTiming(3, { duration: 600, easing: Easing.inOut(Easing.ease) }),
          withTiming(-2, { duration: 600, easing: Easing.inOut(Easing.ease) }),
          withTiming(2, { duration: 600, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 600, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
      )
    }
    if (chosen === 'wiggle') {
      morph.value = withRepeat(
        withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) }),
        -1,
        true,
      )
    }
    if (chosen === 'steam') {
      steamProgress.forEach((sv, i) => {
        // Stagger each puff's start so emission is continuous, then loop.
        sv.value = withSequence(
          withTiming(0, { duration: i * 500 }),
          withRepeat(
            withTiming(1, { duration: 2200, easing: Easing.out(Easing.ease) }),
            -1,
          ),
        )
      })
    }
  }, [chosen, reduce])

  const bowlAnimatedProps = useAnimatedProps(() => ({
    transform: `rotate(${bowlRotate.value} ${BOWL_PIVOT_X} ${BOWL_PIVOT_Y})`,
  }))

  const twirlAnimatedProps = useAnimatedProps(() => ({
    transform: `translate(0 ${insideBob.value}) rotate(${twirl.value} 32 37)`,
  }))

  const chopstickAnimatedProps = useAnimatedProps(() => ({
    transform: `translate(0 ${chopstickY.value}) rotate(${chopstickRot.value} 40 17)`,
  }))

  // Wiggle uses path-d morphing — Reanimated supports animating string props
  // via interpolation we'd need to do manually. Easier path: rotate the
  // dangling noodles group slightly.
  const wiggleAnimatedProps = useAnimatedProps(() => ({
    transform: `rotate(${morph.value * 6 - 3} 36 23)`,
  }))

  const insideStyle = useAnimatedStyle(() => ({
    opacity: chosen === 'slurp' ? 0.4 + slurp.value * 0.6 : 1,
  }))

  return (
    <View style={[styles.wrap, style]}>
      <Animated.View style={insideStyle}>
        <Svg width={size} height={size} viewBox={NOODLE_VIEWBOX}>
          {chosen === 'steam' && (
            <G>
              {STEAM_PUFFS.map((p, i) => (
                <SteamPuff key={i} puff={p} stroke={color} progress={steamProgress[i]} />
              ))}
            </G>
          )}

          {/* Clip path to keep inside noodles contained within the bowl */}
          <Defs>
            <ClipPath id="bowl-clip">
              <Ellipse cx={BOWL_RIM.cx} cy={BOWL_RIM.cy} rx={BOWL_RIM.rx - 1} ry={BOWL_RIM.ry - 0.5} />
              <Path d={BOWL_BODY} />
            </ClipPath>
          </Defs>

          <AnimatedG animatedProps={bowlAnimatedProps as any}>
            <Ellipse
              cx={BOWL_RIM.cx}
              cy={BOWL_RIM.cy}
              rx={BOWL_RIM.rx}
              ry={BOWL_RIM.ry}
              stroke={color}
              strokeWidth={1.8}
              fill="transparent"
            />
            <Path d={BOWL_BODY} stroke={color} strokeWidth={1.8} strokeLinecap="round" fill="none" />
            <Rect
              x={BOWL_BASE.x}
              y={BOWL_BASE.y}
              width={BOWL_BASE.width}
              height={BOWL_BASE.height}
              rx={BOWL_BASE.rx}
              stroke={color}
              strokeWidth={1.5}
              fill="none"
            />

            {/* Inside noodles clipped to bowl interior */}
            <G clipPath="url(#bowl-clip)">
              <AnimatedG animatedProps={twirlAnimatedProps as any}>
                {INSIDE_NOODLE_PATHS.map((d, i) => (
                  <Path
                    key={i}
                    d={d}
                    stroke={color}
                    strokeWidth={1.4}
                    strokeLinecap="round"
                    fill="none"
                  />
                ))}
              </AnimatedG>
            </G>
          </AnimatedG>

          <AnimatedG animatedProps={chopstickAnimatedProps as any}>
            {CHOPSTICK_PATHS.map((c, i) => (
              <Line
                key={i}
                x1={c.x1}
                y1={c.y1}
                x2={c.x2}
                y2={c.y2}
                stroke={color}
                strokeWidth={1.8}
                strokeLinecap="round"
              />
            ))}
          </AnimatedG>

          <AnimatedG animatedProps={wiggleAnimatedProps as any}>
            {DANGLING_NOODLE_PATHS.map((d, i) => (
              <Path
                key={i}
                d={chosen === 'wiggle' && i % 2 === 0 ? DANGLING_NOODLE_PATHS_ALT[i] : d}
                stroke={color}
                strokeWidth={1.4}
                strokeLinecap="round"
                fill="none"
              />
            ))}
          </AnimatedG>
        </Svg>
      </Animated.View>
      {label ? <Text style={[styles.label, { color }]}>{label}</Text> : null}
    </View>
  )
}

function SteamPuff({
  puff,
  stroke,
  progress,
}: {
  puff: { cx: number; cy: number; rx: number; ry: number }
  stroke: string
  progress: SharedValue<number>
}) {
  const animatedProps = useAnimatedProps(() => {
    const opacity = progress.value < 0.2 ? progress.value * 5 : 1 - (progress.value - 0.2) * 1.25
    return {
      cy: puff.cy - progress.value * 14,
      rx: puff.rx * (1 + progress.value * 0.6),
      ry: puff.ry * (1 + progress.value * 0.6),
      opacity: Math.max(0, Math.min(opacity, 0.7)),
    } as any
  })
  return (
    <AnimatedEllipse
      cx={puff.cx}
      cy={puff.cy}
      rx={puff.rx}
      ry={puff.ry}
      stroke={stroke}
      strokeWidth={1}
      fill="none"
      animatedProps={animatedProps as any}
    />
  )
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  label: {
    fontSize: 12,
    opacity: 0.7,
  },
})
