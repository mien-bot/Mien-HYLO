import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import store from './store'

const STORE_KEY = 'appLock'
const KEY_LEN = 64
const SCRYPT_COST = 2 ** 15
// Node's default scrypt maxmem is 32 MiB, which is exactly 128*N*r at
// N=2^15, r=8 - scrypt's internal overhead pushes it just over and the
// call throws MEMORY_LIMIT_EXCEEDED. Give it enough headroom.
const SCRYPT_MAXMEM = 128 * 1024 * 1024

type LockRecord = {
  version: 1
  salt: string
  hash: string
}

function read(): LockRecord | null {
  const raw = store.get(STORE_KEY) as LockRecord | undefined
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.salt !== 'string' || typeof raw.hash !== 'string') return null
  return raw
}

export function isPasswordSet(): boolean {
  return read() !== null
}

export function setPassword(plain: string): void {
  if (typeof plain !== 'string' || plain.length < 4) {
    throw new Error('Password must be at least 4 characters')
  }
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(plain, salt, KEY_LEN, { N: SCRYPT_COST, maxmem: SCRYPT_MAXMEM }).toString(
    'hex',
  )
  const record: LockRecord = { version: 1, salt, hash }
  store.set(STORE_KEY, record)
}

export function verifyPassword(plain: string): boolean {
  const record = read()
  if (!record) return false
  if (typeof plain !== 'string' || plain.length === 0) return false
  let candidate: Buffer
  try {
    candidate = scryptSync(plain, record.salt, KEY_LEN, { N: SCRYPT_COST, maxmem: SCRYPT_MAXMEM })
  } catch {
    return false
  }
  const expected = Buffer.from(record.hash, 'hex')
  if (candidate.length !== expected.length) return false
  return timingSafeEqual(candidate, expected)
}
