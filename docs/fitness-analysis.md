# Fitness Analysis Engine

## Overview

Mien's fitness analysis engine provides scientific training load tracking, recovery scoring, and personalized sleep recommendations based on established sports science models. It combines data from your Pixel Watch (heart rate, HRV, resting HR, VO2 max, exercise, steps, sleep) into a unified fitness intelligence system.

## Scientific Foundation

### Banister Fitness-Fatigue Model (1975)

The core of the system is Eric Banister's impulse-response model, the same framework used by Strava, TrainingPeaks, Garmin, and Elevate. The key insight: every workout produces both a **fitness** stimulus and **fatigue**, and these decay at different rates.

- **Fitness (CTL)** builds slowly and decays slowly (time constant: 42 days)
- **Fatigue (ATL)** spikes quickly and dissipates quickly (time constant: 7 days)
- **Form (TSB)** = Fitness - Fatigue, predicting readiness to perform

```
CTL_today = CTL_yesterday × (1 - 1/42) + TRIMP_today × (1/42)
ATL_today = ATL_yesterday × (1 - 1/7)  + TRIMP_today × (1/7)
TSB = CTL - ATL
```

**Training Status** is derived from CTL, ATL, TSB, VO2 trend, and exercise consistency:

| Status | Condition | Meaning |
|--------|-----------|---------|
| Productive | CTL rising, TSB near 0, VO2 improving | Balanced training driving adaptation |
| Peaking | TSB > +15, strong CTL | Well-rested with high fitness base |
| Maintaining | Stable CTL, neutral TSB | Consistent training, stable fitness |
| Recovery | TSB slightly positive | Freshening up after hard block |
| Overreaching | TSB < -20 | Accumulated fatigue, rest needed |
| Detraining | Low CTL, low activity | Fitness declining from inactivity |

### TRIMP (Training Impulse) — Banister 1991

TRIMP quantifies the physiological stress of each workout by combining duration and heart rate intensity with exponential weighting:

```
TRIMP = duration(min) × %HRR × 0.64 × e^(1.92 × %HRR)
```

Where `%HRR` = (exercise HR - resting HR) / (max HR - resting HR)

The exponential factor means high-intensity minutes produce disproportionately more training stress than easy minutes. A 30-minute run at 85% HRR generates roughly 4x the TRIMP of a 30-minute walk at 40% HRR.

When workout heart rate data is unavailable, the engine estimates intensity from workout type:

| Workout Type | Estimated %HRR |
|-------------|----------------|
| Running / HIIT / Sprint | 75% |
| Swimming | 70% |
| Cycling | 70% |
| Strength Training | 60% |
| Walking | 40% |
| Yoga / Stretching | 35% |

### EPOC Estimation

Excess Post-Exercise Oxygen Consumption (EPOC) estimates how much energy your body needs to recover after exercise. Based on Garmin/Firstbeat methodology:

| Intensity | EPOC Rate | Example (30 min) |
|-----------|-----------|-------------------|
| Light (<65% HRmax) | 0.5/min | ~15 ml O2/kg |
| Moderate (65-80% HRmax) | 1.5/min | ~45 ml O2/kg |
| High (>80% HRmax) | 3.5/min | ~105 ml O2/kg |

### Acute:Chronic Workload Ratio (Gabbett 2016)

ACWR = ATL / CTL. This ratio predicts injury risk and optimal training progression:

| ACWR | Zone | Interpretation |
|------|------|---------------|
| < 0.5 | Undertrained | Training well below fitness base |
| 0.8 - 1.3 | Sweet Spot | Optimal training progression |
| 1.3 - 1.5 | Caution | Elevated load, monitor recovery |
| > 1.5 | Danger Zone | High injury risk, reduce intensity |

## Recovery Scoring

Recovery readiness is a weighted composite of four factors:

| Factor | Weight | Data Source | Methodology |
|--------|--------|-------------|-------------|
| HRV Recovery | 30% | Heart rate variability | Z-score against 30-day baseline. +2σ = 90, 0 = 50, -2σ = 10 |
| Resting Heart Rate | 20% | Resting HR | Each bpm above baseline reduces score by 8 points |
| Sleep Quality | 25% | Sleep duration + deep % | Targets: 7-9h total, 15-23% deep sleep |
| Training Load Balance | 25% | ACWR + TSB | ACWR 0.8-1.3 = 80 pts, TSB adjustments |

**Recovery Status:**

| Score | Status | Recommendation |
|-------|--------|---------------|
| 80-100 | Optimal | Ready for high-intensity training |
| 65-79 | Good | Normal training appropriate |
| 45-64 | Fair | Moderate intensity recommended |
| 25-44 | Poor | Light activity or rest day |
| 0-24 | Critical | Full rest, investigate stressors |

**Estimated Recovery Time** is calculated from the most recent TRIMP load plus recovery deficit:
```
recovery_hours = 12 + (last_trimp / 5) + (recovery_score < 50 ? 12 : 0)
```
Capped at 72 hours maximum.

## Training-Adjusted Sleep Recommendation

Based on research by Fullagar et al. (2015) and the Gatorade Sports Science Institute: athletes training at high loads need 8-10 hours of sleep for optimal recovery, muscle repair, and hormone regulation.

```
base_need = 7.5 hours
training_extra = (weekly_TRIMP / 50) × 15 minutes    (capped at +2 hours)
recommended = base_need + training_extra
```

| Weekly TRIMP | Training Level | Extra Sleep | Total Need |
|-------------|---------------|-------------|------------|
| < 50 | Light | +0-15 min | ~7.5-8h |
| 50-150 | Moderate | +15-45 min | ~8-8.5h |
| 150-300 | High | +45-90 min | ~8.5-9.5h |
| 300+ | Very High | +90-120 min | ~9.5-10h |

The system compares your actual recent sleep average against the recommendation and reports the deficit.

## Fitness Profile

The composite fitness score (0-100) is derived from:

- **VO2 Max** — ACSM guidelines: 20=0, 60=100
- **Resting Heart Rate** — Lower is better: 40=100, 80=0
- **HRV Baseline** — Higher is better: 20=0, 80=100
- **Exercise Consistency** — % of days with 20+ min exercise

**Fitness Levels:**

| Score | Level |
|-------|-------|
| 85+ | Elite |
| 70-84 | Advanced |
| 50-69 | Intermediate |
| 30-49 | Developing |
| 0-29 | Beginner |

**VO2 Max Categories (ACSM, males 20-29):**

| VO2 Max | Category |
|---------|----------|
| < 25 | Very Poor |
| 25-33 | Poor |
| 33-37 | Below Average |
| 37-42 | Average |
| 42-47 | Above Average |
| 47-52 | Excellent |
| 52+ | Superior |

## Data Sources

All data flows from the Pixel Watch via Health Auto Export:

| Metric | DB Type | Used For |
|--------|---------|----------|
| `heart_rate` | Avg/Min/Max per day | TRIMP calculation, HR range charts |
| `resting_heart_rate` | Daily RHR | Recovery scoring, fitness profile |
| `hrv` | Daily HRV (RMSSD) | Recovery scoring, autonomic health |
| `vo2_max` | Periodic VO2 estimate | Fitness profile, cardio assessment |
| `exercise_time` | Daily exercise minutes | TRIMP fallback, consistency tracking |
| `active_energy` | Daily active calories | Energy expenditure tracking |
| `steps` | Daily step count | Walking load estimation |
| `sleep` | Duration + stages | Recovery scoring, sleep recommendation |
| `workout` | Per-workout details | TRIMP calculation (name, duration, HR, distance) |

## UI Components

The Fitness & Activity page (`/health/exercise`) has 5 tabs:

### Overview
- Daily steps, calories, exercise minutes with trend lines
- VO2 max trend chart
- Workout log table

### Training Science
- Training status banner (CTL / ATL / TSB)
- Banister fitness-fatigue chart over time
- Recovery readiness dashboard with factor breakdown
- Training-adjusted sleep recommendation
- Daily TRIMP chart
- Methodology reference

### Heart & Recovery
- Heart rate range chart (min/avg/max daily)
- Resting HR trend with linear regression
- HRV trend with baseline reference
- Cardio fitness gauges (VO2 + RHR)

### Sleep vs Fitness
- Dual-axis sleep + exercise overlay
- Sleep vs steps scatter plot (correlation)
- HRV + resting HR vs exercise
- Auto-generated correlation insights

### Activity Log
- Full daily table: steps, calories, exercise, HR, RHR, HRV, sleep

### Activity Detail AI Report
- Per-workout **AI Report** button on the activity detail page
- Builds a bounded local context from the workout, second-by-second Strava streams, heart-rate zones, 90/180-day same-sport history, VO2 max trend, and fitness/recovery analysis
- Generates an exercise-science report covering heart-rate physiology, pace/duration efficiency, training-load context, VO2 max confidence, data-quality limitations, and the next training move
- Treats wearable VO2 max and wrist heart-rate measurements as estimates, not clinical or lab-grade measurements

## Integration with Sleep Analysis

The fitness engine feeds into the sleep analysis context (`buildSleepAnalysisContext`) so the AI chat can provide holistic recommendations considering both training load and sleep patterns. This means when you ask Claude about your health, it knows:

- Your current training load and fatigue level
- How much extra sleep you need based on training
- Whether you're recovered enough to train
- How your sleep patterns correlate with exercise performance

## References

- Banister, E.W. (1991). "Modeling human performance in running." *J. Applied Sport Science Research*
- Banister, E.W. et al. (1975). "A systems model of training for athletic performance." *Australian J. Sports Medicine*
- Gabbett, T.J. (2016). "The training-injury prevention paradox." *British J. Sports Medicine*
- Fullagar, H.H. et al. (2015). "Sleep and Athletic Performance." *Sports Medicine*
- Fellrnr.com. "Modeling Human Performance" — TSB model derivation
- TrainingPeaks. "The Science of the Performance Manager" — CTL/ATL/TSB implementation
- Firstbeat Analytics / Garmin. EPOC-based training load methodology
- ACSM. "Guidelines for Exercise Testing and Prescription" — VO2 max categories
