import { useId, useMemo } from 'react'
import { motion } from 'framer-motion'
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
import { useReducedMotion } from '../../hooks/useReducedMotion'

export type NoodleVariant = 'random' | 'slurp' | 'twirl' | 'steam' | 'wiggle' | 'bowl-wobble'

interface Props {
  size?: number
  // Any CSS color: hex, named, rgb(), or var(--token).
  // We apply it via `color` on the wrapper and use `currentColor` in the SVG
  // so CSS variables work (SVG stroke="var(...)" does NOT resolve).
  color?: string
  variant?: NoodleVariant
  label?: string
  className?: string
  inline?: boolean
}

const CYCLEABLE: Exclude<NoodleVariant, 'random'>[] = [
  'slurp',
  'twirl',
  'steam',
  'wiggle',
  'bowl-wobble',
]

function pickVariant(v: NoodleVariant): Exclude<NoodleVariant, 'random'> {
  if (v === 'random') return CYCLEABLE[Math.floor(Math.random() * CYCLEABLE.length)]
  return v
}

// Bowl visual center — used as pivot for wobble so the bowl rocks at its base.
const BOWL_PIVOT_X = 32
const BOWL_PIVOT_Y = 49

export default function NoodleSpinner({
  size = 64,
  color,
  variant = 'slurp',
  label,
  className = '',
  inline = false,
}: Props) {
  const chosen = useMemo(() => pickVariant(variant), [variant])
  const reduced = useReducedMotion()
  const reactId = useId()
  const clipId = `noodle-bowl-${reactId.replace(/:/g, '')}`

  const Wrapper: any = inline ? 'span' : 'div'

  return (
    <Wrapper
      className={`${inline ? 'inline-flex' : 'flex'} flex-col items-center justify-center gap-3 ${className}`}
      style={color ? { color } : undefined}
      role="status"
      aria-label={label || 'Loading'}
    >
      <svg
        width={size}
        height={size}
        viewBox={NOODLE_VIEWBOX}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
      >
        {/* Steam — always show gentle steam, bigger puffs for steam variant */}
        {!reduced && <SteamPuffs intense={chosen === 'steam'} />}

        {/* Clip path to keep inside noodles contained within the bowl */}
        <defs>
          <clipPath id={clipId}>
            <ellipse
              cx={BOWL_RIM.cx}
              cy={BOWL_RIM.cy}
              rx={BOWL_RIM.rx - 1}
              ry={BOWL_RIM.ry - 0.5}
            />
            <path d={BOWL_BODY} />
          </clipPath>
        </defs>

        {/* Bowl group — wobbles around its base in bowl-wobble variant */}
        <motion.g
          animate={
            !reduced
              ? chosen === 'bowl-wobble'
                ? { rotate: [-5, 5, -5] }
                : { rotate: [-1.5, 1.5, -1.5] }
              : undefined
          }
          transition={
            !reduced
              ? chosen === 'bowl-wobble'
                ? { duration: 1.4, repeat: Infinity, ease: 'easeInOut' }
                : { duration: 3, repeat: Infinity, ease: 'easeInOut' }
              : undefined
          }
          style={{ originX: `${BOWL_PIVOT_X}px`, originY: `${BOWL_PIVOT_Y}px` }}
        >
          <ellipse
            cx={BOWL_RIM.cx}
            cy={BOWL_RIM.cy}
            rx={BOWL_RIM.rx}
            ry={BOWL_RIM.ry}
            stroke="currentColor"
            strokeWidth={1.8}
            fill="transparent"
          />
          <path
            d={BOWL_BODY}
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            fill="none"
          />
          <rect
            x={BOWL_BASE.x}
            y={BOWL_BASE.y}
            width={BOWL_BASE.width}
            height={BOWL_BASE.height}
            rx={BOWL_BASE.rx}
            stroke="currentColor"
            strokeWidth={1.5}
            fill="none"
          />

          {/* Internal noodles — 5 strands filling the bowl, clipped to bowl interior */}
          <motion.g
            clipPath={`url(#${clipId})`}
            animate={
              reduced
                ? undefined
                : chosen === 'slurp' || chosen === 'twirl'
                  ? {
                      rotate: [-2, 2.5, -1.5, 1.5, -2],
                      x: [0, 1.4, 0.4, -1.1, 0],
                      y: [0, -0.8, 0.3, 0.9, 0],
                    }
                  : { x: [0, 1, 0, -1, 0] }
            }
            transition={
              reduced
                ? undefined
                : chosen === 'slurp' || chosen === 'twirl'
                  ? { duration: 2.1, repeat: Infinity, ease: 'easeInOut' }
                  : { duration: 2.4, repeat: Infinity, ease: 'easeInOut' }
            }
            style={{ transformOrigin: '32px 37px' }}
          >
            {INSIDE_NOODLE_PATHS.map((d, i) => (
              <motion.path
                key={i}
                d={d}
                stroke="currentColor"
                strokeWidth={1.3}
                strokeLinecap="round"
                fill="none"
                opacity={1 - i * 0.08}
                animate={
                  reduced
                    ? undefined
                    : chosen === 'twirl'
                      ? { d: [d, INSIDE_NOODLE_PATHS_ALT[i], d] }
                      : chosen === 'slurp'
                        ? { d: [d, INSIDE_NOODLE_PATHS_ALT[i], d], pathLength: [0.75, 1, 0.75] }
                        : { d: [d, INSIDE_NOODLE_PATHS_ALT[i], d] }
                }
                transition={
                  reduced
                    ? undefined
                    : chosen === 'twirl'
                      ? { duration: 1.7, repeat: Infinity, ease: 'easeInOut', delay: i * 0.08 }
                      : chosen === 'slurp'
                        ? { duration: 1.05, repeat: Infinity, ease: 'easeInOut', delay: i * 0.08 }
                        : {
                            duration: 2.0 + i * 0.2,
                            repeat: Infinity,
                            ease: 'easeInOut',
                            delay: i * 0.12,
                          }
                }
              />
            ))}
          </motion.g>
        </motion.g>

        {/* Chopsticks — lift dramatically in slurp, gentle bob otherwise */}
        <motion.g
          animate={
            !reduced
              ? chosen === 'slurp'
                ? { y: [0, -8, 0], rotate: [0, -7, 0] }
                : { y: [0, -4, 0], rotate: [0, -2, 0] }
              : undefined
          }
          transition={
            !reduced
              ? chosen === 'slurp'
                ? { duration: 1.4, repeat: Infinity, ease: 'easeInOut' }
                : { duration: 1.8, repeat: Infinity, ease: 'easeInOut' }
              : undefined
          }
          style={{ originX: '40px', originY: '17px' }}
        >
          {CHOPSTICK_PATHS.map((c, i) => (
            <line
              key={i}
              x1={c.x1}
              y1={c.y1}
              x2={c.x2}
              y2={c.y2}
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
            />
          ))}
        </motion.g>

        {/* Dangling noodles — 5 strands hanging from chopsticks */}
        <motion.g
          animate={
            !reduced ? (chosen === 'slurp' ? { y: [0, -8, 0] } : { y: [0, -4, 0] }) : undefined
          }
          transition={
            !reduced
              ? chosen === 'slurp'
                ? { duration: 1.4, repeat: Infinity, ease: 'easeInOut' }
                : { duration: 1.8, repeat: Infinity, ease: 'easeInOut' }
              : undefined
          }
        >
          {DANGLING_NOODLE_PATHS.map((d, i) => (
            <motion.path
              key={i}
              d={d}
              stroke="currentColor"
              strokeWidth={1.3}
              strokeLinecap="round"
              fill="none"
              opacity={0.95 - i * 0.05}
              animate={
                reduced
                  ? undefined
                  : chosen === 'slurp'
                    ? { pathLength: [1, 0.3, 1], y: [0, -3, 0] }
                    : { d: [d, DANGLING_NOODLE_PATHS_ALT[i], d] }
              }
              transition={
                reduced
                  ? undefined
                  : chosen === 'slurp'
                    ? { duration: 1.4, repeat: Infinity, ease: 'easeInOut', delay: i * 0.1 }
                    : {
                        duration: 1.4 + i * 0.15,
                        repeat: Infinity,
                        ease: 'easeInOut',
                        delay: i * 0.12,
                      }
              }
            />
          ))}
        </motion.g>
      </svg>

      {label && (
        <motion.span
          className="text-sm font-medium tracking-wide"
          style={{ color: 'var(--text-muted)' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
        >
          {label}
        </motion.span>
      )}
    </Wrapper>
  )
}

function SteamPuffs({ intense }: { intense: boolean }) {
  return (
    <g>
      {STEAM_PUFFS.map((p, i) => (
        <motion.ellipse
          key={i}
          cx={p.cx}
          cy={p.cy}
          rx={p.rx}
          ry={p.ry}
          stroke="currentColor"
          strokeWidth={0.8}
          fill="none"
          initial={{ opacity: 0, y: 0, x: 0, scale: 0.5 }}
          animate={{
            opacity: [0, intense ? 0.7 : 0.45, 0],
            y: [-2, intense ? -12 : -8, intense ? -18 : -13],
            x: [0, (i - 2) * 1.2, (i - 2) * 2.5],
            scale: [0.5, intense ? 1.3 : 1.0, intense ? 1.8 : 1.4],
          }}
          transition={{
            duration: intense ? 2.2 : 2.8,
            repeat: Infinity,
            ease: 'easeOut',
            delay: i * (intense ? 0.44 : 0.56),
          }}
        />
      ))}
    </g>
  )
}
