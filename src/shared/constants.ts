// Sleep Analysis
export const SLEEP_DEBT_WINDOW_DAYS = 14
// Window for estimating habitual sleep NEED. Deliberately longer than the debt
// window so "sleep need" stays a stable trait — identical on every screen
// regardless of how many nights that screen happened to load.
export const SLEEP_NEED_WINDOW_DAYS = 90
export const SLEEP_CYCLE_MINUTES = 90

// Fitness / Training
export const DEFAULT_TRAINING_DAYS = 90
export const CTL_TIME_CONSTANT = 42
export const ATL_TIME_CONSTANT = 7
export const DEFAULT_MAX_HR = 190
export const BANISTER_GENDER_FACTOR = 0.64
export const BANISTER_EXPONENT = 1.92
export const ACWR_SWEET_SPOT = [0.8, 1.3] as const
export const ACWR_INJURY_RISK = 1.5

// Charts / Aggregations
export const DEFAULT_CHART_DAYS = 30
export const DEFAULT_ROLLING_WINDOWS = [7, 14, 30] as const

// Health Server
export const HEALTH_SERVER_PORT = 19876

// Caching
export const CACHE_TTL_MS = 60_000
