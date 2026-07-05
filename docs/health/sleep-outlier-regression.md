# Sleep Outlier Regression

## Summary

The sleep duration chart could show impossible sleep records, such as 16-19 hour nights, even after the prior outlier-exclusion work.

## Prior Fix

Commit `45958a3` (`Exclude sleep outliers from analysis without deleting data`) added:

- `health_metrics.excluded`
- a startup migration that flagged bogus sleep rows
- analysis queries that used `excluded = 0`

The intent was to preserve raw Health Auto Export data while hiding bad rows from analysis.

## Regression Cause

Two paths were still able to surface those rows:

1. `health:getMetrics` returned raw sleep rows without filtering `excluded = 0`. The Sleep Detail duration chart uses this endpoint, so excluded rows could still render.
2. The outlier flagging was implemented as a one-time migration. If old sleep rows were re-upserted later from relay/mobile sync, SQLite defaulted `excluded` back to `0`, and the migration did not run again.

This explains why travel-era outliers appeared to come back after being removed.

## Fix

- Made sleep outlier flagging idempotent with `applySleepOutlierExclusions()`.
- Re-run that flagging during database startup, sleep metric reads, and relay health pulls.
- Updated `health:getMetrics` to filter sleep rows with `excluded = 0`.
- Updated rolling aggregation queries so sleep rolling averages also ignore excluded rows.
- Added a direct reported-duration check (`totalAsleep/asleep/qty > 16h`) in addition to timestamp duration checks.

## Notes

The bad rows are not deleted. They remain in `health_metrics` for auditability, but `excluded = 1` keeps them out of charts and analysis.
