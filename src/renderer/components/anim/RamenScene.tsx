import { useRef, useMemo, useEffect } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'

interface Props {
  size?: number
  className?: string
}

function Bowl() {
  const groupRef = useRef<THREE.Group>(null)
  useFrame((_, dt) => {
    if (groupRef.current) groupRef.current.rotation.y += dt * 0.25
  })

  return (
    <group ref={groupRef} position={[0, -0.2, 0]}>
      {/* Bowl body — open cylinder, slightly conical */}
      <mesh position={[0, 0.05, 0]}>
        <cylinderGeometry args={[1.05, 0.7, 0.65, 32, 1, true]} />
        <meshStandardMaterial
          color="#1c1c1e"
          roughness={0.5}
          metalness={0.2}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Rim torus */}
      <mesh position={[0, 0.35, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.05, 0.05, 12, 48]} />
        <meshStandardMaterial color="#f5f5f7" roughness={0.4} />
      </mesh>
      {/* Bowl base */}
      <mesh position={[0, -0.28, 0]}>
        <cylinderGeometry args={[0.55, 0.55, 0.08, 24]} />
        <meshStandardMaterial color="#1c1c1e" roughness={0.6} />
      </mesh>
      {/* Broth surface */}
      <mesh position={[0, 0.32, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1.0, 32]} />
        <meshStandardMaterial color="#d4985a" roughness={0.3} metalness={0.1} />
      </mesh>

      <Noodles />
      <Toppings />
      <Chopsticks />
    </group>
  )
}

function Noodles() {
  const groupRef = useRef<THREE.Group>(null)
  const timeRef = useRef(0)

  // Generate noodle strand curves
  const strands = useMemo(() => {
    const items: Array<{
      points: THREE.Vector3[]
      curve: THREE.CatmullRomCurve3
      geom: THREE.TubeGeometry
      phase: number
      amplitude: number
    }> = []
    const count = 12

    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2
      const radius = 0.3 + (i % 3) * 0.15
      const phase = i * 1.7
      const amplitude = 0.02 + (i % 3) * 0.015
      const points: THREE.Vector3[] = []

      for (let t = 0; t <= 1; t += 0.04) {
        const spiralT = t * 1.5
        const x = Math.cos(angle + spiralT) * radius * (1 - t * 0.2)
        const z = Math.sin(angle + spiralT) * radius * (1 - t * 0.2)
        const y = 0.34 + Math.sin(t * Math.PI * 4 + phase) * amplitude
        points.push(new THREE.Vector3(x, y, z))
      }

      const curve = new THREE.CatmullRomCurve3(points)
      const geom = new THREE.TubeGeometry(curve, 40, 0.022, 6, false)
      items.push({ points, curve, geom, phase, amplitude })
    }

    // 3 lifted strands draping over the rim
    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * Math.PI * 2 + 0.5
      const points: THREE.Vector3[] = []

      for (let t = 0; t <= 1; t += 0.04) {
        const r = 0.4 + t * 0.6
        const x = Math.cos(angle) * r
        const z = Math.sin(angle) * r
        // rises from broth level, peaks at rim, drapes slightly over
        const y = 0.34 + Math.sin(t * Math.PI) * 0.22 - t * 0.1
        points.push(new THREE.Vector3(x, y, z))
      }

      const curve = new THREE.CatmullRomCurve3(points)
      const geom = new THREE.TubeGeometry(curve, 40, 0.02, 6, false)
      items.push({ points, curve, geom, phase: i * 2.1, amplitude: 0.015 })
    }

    return items
  }, [])

  // Animate noodle wiggle
  useFrame((_, dt) => {
    timeRef.current += dt
    if (!groupRef.current) return
    const t = timeRef.current

    groupRef.current.children.forEach((child, idx) => {
      if (idx < strands.length && child instanceof THREE.Mesh) {
        const strand = strands[idx]
        const positions = child.geometry.attributes.position
        if (!positions) return

        // Subtle vertex displacement for organic wiggle
        const baseGeom = strand.geom.attributes.position
        if (!baseGeom) return

        for (let v = 0; v < positions.count; v++) {
          const bx = baseGeom.getX(v)
          const by = baseGeom.getY(v)
          const bz = baseGeom.getZ(v)
          const wiggle = Math.sin(t * 2.5 + v * 0.15 + strand.phase) * strand.amplitude * 0.6
          positions.setX(v, bx + wiggle)
          positions.setY(v, by + Math.sin(t * 1.8 + v * 0.1 + strand.phase) * 0.004)
          positions.setZ(v, bz + Math.cos(t * 2.2 + v * 0.12 + strand.phase) * wiggle * 0.5)
        }
        positions.needsUpdate = true
      }
    })
  })

  useEffect(() => {
    return () => {
      strands.forEach((s) => s.geom.dispose())
    }
  }, [strands])

  return (
    <group ref={groupRef}>
      {strands.map((s, i) => (
        <mesh key={i} geometry={s.geom.clone()}>
          <meshStandardMaterial
            color={i >= strands.length - 3 ? '#f5e0a0' : '#f0d68c'}
            roughness={0.35}
            metalness={0.05}
          />
        </mesh>
      ))}
    </group>
  )
}

function Toppings() {
  // Narutomaki (fish cake slice)
  const narutomakiRef = useRef<THREE.Group>(null)
  useFrame((_, dt) => {
    if (narutomakiRef.current) {
      narutomakiRef.current.rotation.z += dt * 0.15
    }
  })

  return (
    <group>
      {/* Narutomaki */}
      <group ref={narutomakiRef} position={[-0.4, 0.36, 0.3]} rotation={[-Math.PI / 2, 0, 0]}>
        <mesh>
          <cylinderGeometry args={[0.15, 0.15, 0.04, 16]} />
          <meshStandardMaterial color="#f5e6d3" roughness={0.6} />
        </mesh>
        {/* Pink swirl center */}
        <mesh position={[0, 0.021, 0]}>
          <cylinderGeometry args={[0.07, 0.07, 0.005, 16]} />
          <meshStandardMaterial color="#e8a0b0" roughness={0.5} />
        </mesh>
      </group>

      {/* Soft-boiled egg half */}
      <group position={[0.45, 0.36, -0.25]} rotation={[-Math.PI / 2 + 0.1, 0, 0.3]}>
        <mesh>
          <cylinderGeometry args={[0.17, 0.15, 0.06, 16]} />
          <meshStandardMaterial color="#f5f0e0" roughness={0.5} />
        </mesh>
        <mesh position={[0, 0.031, 0]}>
          <cylinderGeometry args={[0.08, 0.08, 0.005, 16]} />
          <meshStandardMaterial color="#e8a020" roughness={0.4} />
        </mesh>
      </group>

      {/* Green onion slices */}
      {[0, 1, 2, 3].map((i) => {
        const angle = 0.8 + i * 0.6
        const r = 0.35 + (i % 2) * 0.25
        return (
          <mesh
            key={i}
            position={[Math.cos(angle) * r, 0.35, Math.sin(angle) * r]}
            rotation={[-Math.PI / 2, 0, i * 0.8]}
          >
            <ringGeometry args={[0.02, 0.045, 8]} />
            <meshStandardMaterial color="#5a8c3a" roughness={0.6} side={THREE.DoubleSide} />
          </mesh>
        )
      })}
    </group>
  )
}

function Chopsticks() {
  const groupRef = useRef<THREE.Group>(null)
  const timeRef = useRef(0)

  // Dangling noodle strand geometry
  const danglingGeom = useMemo(() => {
    const points: THREE.Vector3[] = []
    for (let t = 0; t <= 1; t += 0.05) {
      const sway = Math.sin(t * Math.PI * 2) * 0.04
      points.push(new THREE.Vector3(sway, -t * 0.6, sway * 0.5))
    }
    const curve = new THREE.CatmullRomCurve3(points)
    return new THREE.TubeGeometry(curve, 24, 0.018, 6, false)
  }, [])

  useEffect(() => {
    return () => {
      danglingGeom.dispose()
    }
  }, [danglingGeom])

  // Gentle bob + dangling noodle sway
  useFrame((_, dt) => {
    timeRef.current += dt
    if (!groupRef.current) return
    const t = timeRef.current
    groupRef.current.position.y = Math.sin(t * 1.5) * 0.02
    groupRef.current.rotation.z = -0.45 + Math.sin(t * 1.2) * 0.02

    // Animate dangling noodle
    const noodleMesh = groupRef.current.children[2]
    if (noodleMesh instanceof THREE.Mesh) {
      const positions = noodleMesh.geometry.attributes.position
      const basePositions = danglingGeom.attributes.position
      if (!positions || !basePositions) return
      for (let v = 0; v < positions.count; v++) {
        const by = basePositions.getY(v)
        const depth = Math.abs(by)
        const sway = Math.sin(t * 3 + v * 0.2) * depth * 0.08
        positions.setX(v, basePositions.getX(v) + sway)
        positions.setZ(v, basePositions.getZ(v) + Math.cos(t * 2.5 + v * 0.15) * depth * 0.04)
      }
      positions.needsUpdate = true
    }
  })

  return (
    <group ref={groupRef} position={[0.7, 0.55, 0]} rotation={[0, 0, -0.45]}>
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[0.055, 1.5, 0.055]} />
        <meshStandardMaterial color="#8b6f47" roughness={0.7} />
      </mesh>
      <mesh position={[0.12, 0.02, 0]}>
        <boxGeometry args={[0.055, 1.5, 0.055]} />
        <meshStandardMaterial color="#8b6f47" roughness={0.7} />
      </mesh>
      {/* Dangling noodle from chopstick tips */}
      <mesh geometry={danglingGeom.clone()} position={[0.06, -0.7, 0]}>
        <meshStandardMaterial color="#f0d68c" roughness={0.35} />
      </mesh>
    </group>
  )
}

function SteamParticles() {
  const ref = useRef<THREE.Points>(null)
  const count = 60
  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      arr[i * 3] = (Math.random() - 0.5) * 1.2
      arr[i * 3 + 1] = Math.random() * 1.5 + 0.4
      arr[i * 3 + 2] = (Math.random() - 0.5) * 1.2
    }
    return arr
  }, [])
  const sizes = useMemo(() => {
    const arr = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      arr[i] = 0.04 + Math.random() * 0.06
    }
    return arr
  }, [])

  useFrame((_, dt) => {
    if (!ref.current) return
    const pos = ref.current.geometry.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < count; i++) {
      let y = pos.getY(i) + dt * (0.25 + sizes[i] * 2)
      let x = pos.getX(i) + Math.sin(y * 3 + i) * dt * 0.15
      if (y > 2.5) {
        y = 0.4
        x = (Math.random() - 0.5) * 0.9
        pos.setZ(i, (Math.random() - 0.5) * 0.9)
      }
      pos.setX(i, x)
      pos.setY(i, y)
    }
    pos.needsUpdate = true
  })

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} count={count} />
      </bufferGeometry>
      <pointsMaterial color="#ffffff" size={0.07} transparent opacity={0.3} sizeAttenuation />
    </points>
  )
}

export default function RamenScene({ size = 240, className = '' }: Props) {
  return (
    <div className={className} style={{ width: size, height: size, pointerEvents: 'none' }}>
      <Canvas camera={{ position: [0, 1.4, 2.6], fov: 45 }}>
        <ambientLight intensity={0.6} />
        <directionalLight position={[2, 4, 3]} intensity={1.1} />
        <directionalLight position={[-3, 2, -2]} intensity={0.3} color="#bf5af2" />
        <Bowl />
        <SteamParticles />
      </Canvas>
    </div>
  )
}
