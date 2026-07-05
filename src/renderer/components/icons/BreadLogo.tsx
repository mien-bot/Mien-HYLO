import { motion, type MotionProps } from 'framer-motion'
import {
  NOODLE_VIEWBOX,
  CHOPSTICK_PATHS,
  DANGLING_NOODLE_PATHS,
  DANGLING_NOODLE_PATHS_ALT,
  BOWL_RIM,
  BOWL_BODY,
  BOWL_BASE,
  INSIDE_NOODLE_PATHS,
} from '../anim/noodleGeometry'
import { useReducedMotion } from '../../hooks/useReducedMotion'

interface Props {
  size?: number
  className?: string
  animated?: boolean
  onClick?: () => void
}

const STROKE = 'rgba(245,245,247,0.9)'

export default function BreadLogo({ size = 28, className = '', animated = false, onClick }: Props) {
  const reduced = useReducedMotion()
  const enableAnim = animated && !reduced

  // Idle wobble runs at low amplitude; hover snaps to neutral + slight scale.
  // We use whileHover so hovering pauses the loop (less distracting when
  // the user actually wants to click).
  const motionProps: MotionProps | undefined = enableAnim
    ? {
        initial: 'idle',
        animate: 'idle',
        whileHover: 'hover',
        variants: {
          idle: {
            rotate: [-2, 2, -2],
            transition: { duration: 5, repeat: Infinity, ease: 'easeInOut' },
          },
          hover: {
            rotate: 0,
            scale: 1.08,
            transition: { duration: 0.25 },
          },
        },
      }
    : undefined

  const SvgEl: any = enableAnim ? motion.svg : 'svg'

  return (
    <SvgEl
      width={size}
      height={size}
      viewBox={NOODLE_VIEWBOX}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      onClick={onClick}
      style={onClick ? { cursor: 'pointer' } : undefined}
      aria-label={onClick ? 'Mien' : undefined}
      {...(motionProps as Record<string, unknown>)}
    >
      {/* Chopsticks — lift on hover */}
      <motion.g
        variants={
          enableAnim
            ? {
                idle: { y: 0, rotate: 0 },
                hover: { y: -2, rotate: -6 },
              }
            : undefined
        }
        transition={{ duration: 0.3 }}
        style={{ originX: '40px', originY: '17px' }}
      >
        {CHOPSTICK_PATHS.map((c, i) => (
          <line
            key={i}
            x1={c.x1}
            y1={c.y1}
            x2={c.x2}
            y2={c.y2}
            stroke={STROKE}
            strokeWidth={1.8}
            strokeLinecap="round"
          />
        ))}
      </motion.g>

      {/* Dangling noodles — wiggle on hover, static otherwise */}
      {DANGLING_NOODLE_PATHS.slice(0, 3).map((d, i) => (
        <motion.path
          key={i}
          d={d}
          stroke={STROKE}
          strokeWidth={1.4}
          strokeLinecap="round"
          fill="none"
          variants={
            enableAnim
              ? {
                  idle: { d },
                  hover: { d: DANGLING_NOODLE_PATHS_ALT[i] },
                }
              : undefined
          }
          transition={{
            duration: 0.45,
            repeat: enableAnim ? Infinity : 0,
            repeatType: 'reverse',
            delay: i * 0.08,
          }}
        />
      ))}

      <ellipse
        cx={BOWL_RIM.cx}
        cy={BOWL_RIM.cy}
        rx={BOWL_RIM.rx}
        ry={BOWL_RIM.ry}
        stroke={STROKE}
        strokeWidth={1.8}
        fill="transparent"
      />
      <path d={BOWL_BODY} stroke={STROKE} strokeWidth={1.8} strokeLinecap="round" fill="none" />
      <rect
        x={BOWL_BASE.x}
        y={BOWL_BASE.y}
        width={BOWL_BASE.width}
        height={BOWL_BASE.height}
        rx={BOWL_BASE.rx}
        stroke={STROKE}
        strokeWidth={1.5}
        fill="none"
      />
      {INSIDE_NOODLE_PATHS.slice(0, 3).map((d, i) => (
        <path key={i} d={d} stroke={STROKE} strokeWidth={1.4} strokeLinecap="round" fill="none" />
      ))}
    </SvgEl>
  )
}
