import React, { useEffect } from 'react'
import { ViewStyle } from 'react-native'
import Svg, { Path, Ellipse, Rect, Line, G } from 'react-native-svg'
import Animated, {
  useSharedValue,
  useAnimatedProps,
  withRepeat,
  withSequence,
  withTiming,
  Easing,
} from 'react-native-reanimated'
import {
  NOODLE_VIEWBOX,
  CHOPSTICK_PATHS,
  DANGLING_NOODLE_PATHS,
  BOWL_RIM,
  BOWL_BODY,
  BOWL_BASE,
  INSIDE_NOODLE_PATHS,
} from './noodleGeometry'

interface Props {
  size?: number
  color?: string
  animated?: boolean
  style?: ViewStyle
}

const AnimatedG = Animated.createAnimatedComponent(G)

export default function NoodleLogo({
  size = 64,
  color = '#f5f5f7',
  animated = false,
  style,
}: Props) {
  const rot = useSharedValue(0)

  useEffect(() => {
    if (!animated) return
    rot.value = withRepeat(
      withSequence(
        withTiming(3, { duration: 1500, easing: Easing.inOut(Easing.ease) }),
        withTiming(-3, { duration: 1500, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
    )
  }, [animated])

  const animatedProps = useAnimatedProps(() => ({
    transform: `rotate(${rot.value} 32 40)`,
  }))

  return (
    <Svg
      width={size}
      height={size}
      viewBox={NOODLE_VIEWBOX}
      style={style as any}
    >
      <AnimatedG animatedProps={animated ? (animatedProps as any) : undefined}>
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
        {DANGLING_NOODLE_PATHS.map((d, i) => (
          <Path
            key={i}
            d={d}
            stroke={color}
            strokeWidth={1.4}
            strokeLinecap="round"
            fill="none"
          />
        ))}
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
    </Svg>
  )
}
