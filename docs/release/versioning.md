# Mien Versioning

## Format: `MAJOR.MINOR.PATCH`

Example: `1.8.0` — major version 1, minor version 8, patch 0.

---

## PATCH (third number) — `1.7.0` → `1.7.1`

**Something broke and you fixed it. No new capabilities.**

The user can't do anything new. They just stop experiencing a bug, crash, or incorrect behavior.

### Bump patch when:
- Fixing a bug or crash
- Correcting wrong data (model IDs, API endpoints, bad calculations)
- Fixing a visual glitch or CSS issue
- Updating dependencies without behavior change
- Documentation corrections
- Config/build fixes

### Real examples from Mien:
| Version | What happened |
|---------|---------------|
| v1.0.1 | Relay server hardening, null-coalesce crash fixes |
| v1.2.1 | Black screen fix (bad lucide-react import) |
| v1.7.1 | Relay health-store merge fix (data-loss bug) |

### The test:
> "Did I fix something that was broken?"
> Yes → patch.

---

## MINOR (second number) — `1.7.0` → `1.8.0`

**The user can do something new, or an existing feature got meaningfully better.**

New screen, new service integration, new analysis engine, new UI section, a feature that changes how the user interacts with the app.

### Bump minor when:
- Adding a new feature (restaurant autocomplete, weekend planner, exercise page)
- Adding a new page or screen
- Integrating a new API or data source
- Adding a new analysis engine or AI skill
- Significant enhancement to an existing feature (basic search → typeahead)
- New automation or scheduled job

### Real examples from Mien:
| Version | What happened |
|---------|---------------|
| v1.1.0 | Mobile app enhancements — health screen rewrite, portfolio rewrite, restaurant feature |
| v1.2.0 | Health Auto Export integration, historical trends analysis |
| v1.3.0 | Workouts & exercise page, YouTube fetcher rewrite |
| v1.4.0 | Weekend planner — editable times, event detail modal, image export |
| v1.5.0 | Sleep automation pipeline, wind-down routine, mobile notifications |
| v1.6.0 | AI daily planner, enhanced restaurant database with 9 new fields |
| v1.7.0 | Full bidirectional data sync for all tables |
| v1.8.0 | Restaurant search autocomplete (new feature) + codebase audit fixes |

### The test:
> "Can the user do something they couldn't do before?"
> Yes → minor.

### Edge case: bug fixes + a new feature in the same release
Minor wins. v1.8.0 had both audit fixes (patch-level) and restaurant autocomplete (minor-level). The highest bump level wins.

---

## MAJOR (first number) — `1.x.x` → `2.0.0`

**Something fundamentally changed. Old assumptions may not hold.**

This is rare. It means the app changed in a way that could break existing workflows, data, or expectations.

### Bump major when:
- Database schema change that requires migration or data loss
- Dropping support for a platform (e.g., removing mobile)
- Complete UI rewrite that changes navigation/layout
- Changing the relay protocol in a way that breaks old clients
- Removing a feature entirely

### The test:
> "Could this break something for the current user, or does it change what the app fundamentally is?"
> Yes → major.

### Not yet happened in Mien. Example scenarios:
- Migrating from SQLite to Postgres (data migration required)
- Rewriting the renderer from React to a different framework
- Changing the relay API in a way that old mobile versions can't talk to it

---

## Quick Decision Tree

```
Did you add a new feature or capability?
  YES → MINOR (1.7.0 → 1.8.0)
  NO  →
    Did you fix a bug or make a non-functional improvement?
      YES → PATCH (1.7.0 → 1.7.1)
      NO  →
        Did you make a breaking or fundamental change?
          YES → MAJOR (1.8.0 → 2.0.0)
```

---

## Where the version lives

All four must stay in sync when bumping:

| File | Field |
|------|-------|
| `VERSION` | Plain text — source of truth |
| `package.json` | `"version"` |
| `mobile/package.json` | `"version"` |
| `mobile/app.json` | `expo.version` |

## How to bump

1. Decide the level: major, minor, or patch
2. Update all four files above
3. Add a new entry to the top of `CHANGELOG.md` with the version tag (e.g., `## v1.9.0 — date — title`)
4. Commit: `Bump version to X.Y.Z`

---

## Version History

| Version | Date | Type | Summary |
|---------|------|------|---------|
| 1.0.0 | 2025-05-10 | Initial | Finance dashboard, technical analysis, portfolio risk, AI skills, mobile |
| 1.0.1 | 2025-05-11 | Patch | Relay hardening, mobile crash fixes |
| 1.1.0 | 2026-05 | Minor | Mobile app enhancements — health, portfolio, restaurants, Notion |
| 1.2.0 | 2026-05-11 | Minor | Health Auto Export, historical trends |
| 1.2.1 | 2026-05-11 | Patch | Black screen fix |
| 1.3.0 | 2026-05-11 | Minor | Workouts, exercise page, YouTube rewrite |
| 1.4.0 | 2026-05-12 | Minor | Weekend planner — editable times, event modal, image export |
| 1.5.0 | 2026-05-12 | Minor | Sleep automation, wind-down routine, mobile notifications |
| 1.6.0 | 2026-05-12 | Minor | AI daily planner, restaurant database enhancement |
| 1.7.0 | 2026-05-12 | Minor | Full bidirectional data sync, mobile audit |
| 1.7.1 | 2026-05-13 | Patch | Relay health-store merge fix |
| 1.8.0 | 2026-05-13 | Minor | Codebase audit, model fixes, restaurant autocomplete |
