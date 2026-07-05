import { motion } from 'framer-motion'
import {
  NOODLE_VIEWBOX,
  BOWL_RIM,
  BOWL_BODY,
  BOWL_BASE,
  INSIDE_NOODLE_PATHS,
} from './noodleGeometry'
import { useReducedMotion } from '../../hooks/useReducedMotion'

interface Props {
  size?: number
  label?: string
  sublabel?: string
  color?: string
  className?: string
}

// Sleepy noodle drooping over the bowl rim — used for empty states.
// The "z"s and the drooping noodle share a 4s breath cycle so they
// feel like a single resting creature.
export default function NoodleIllustration({
  size = 88,
  label,
  sublabel,
  color = 'var(--text-muted)',
  className = '',
}: Props) {
  const reduced = useReducedMotion()

  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 ${className}`}
      style={{ color }}
    >
      <svg
        width={size}
        height={size}
        viewBox={NOODLE_VIEWBOX}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
      >
        {/* Subtle z-z-z — synced with the noodle breath. */}
        <motion.g
          animate={reduced ? undefined : { opacity: [0.2, 0.7, 0.2], y: [0, -3, 0] }}
          transition={reduced ? undefined : { duration: 4, repeat: Infinity, ease: 'easeInOut' }}
        >
          <text x="40" y="14" fontSize="6" fill="currentColor" opacity="0.7">
            z
          </text>
          <text x="45" y="10" fontSize="4" fill="currentColor" opacity="0.5">
            z
          </text>
        </motion.g>

        {/* Drooping noodle — long sad curve hanging over rim, breathing
            on the same cycle as the z's. */}
        <motion.path
          d="M20 27 C 22 24, 26 22, 30 24 C 33 25, 34 30, 34 34"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          fill="none"
          animate={reduced ? undefined : { pathLength: [0.9, 1, 0.9] }}
          transition={reduced ? undefined : { duration: 4, repeat: Infinity, ease: 'easeInOut' }}
        />

        {/* Bowl */}
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

        {/* Resting noodles inside */}
        {INSIDE_NOODLE_PATHS.map((d, i) => (
          <path
            key={i}
            d={d}
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
            fill="none"
            opacity={0.6}
          />
        ))}
      </svg>
      {label && (
        <div className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
          {label}
        </div>
      )}
      {sublabel && (
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {sublabel}
        </div>
      )}
    </div>
  )
}
