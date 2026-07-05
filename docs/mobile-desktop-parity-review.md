# Mobile/Desktop Feature Parity Review

Date: 2026-05-17

## Scope

Reviewed the current desktop Electron renderer and Expo mobile app for route, form, view, and action parity, with extra focus on the Weekend planner because the active bug was in restaurant visit tracking.

## Fixes Applied

- Desktop restaurant visit count is now subtle text instead of a bright green pill.
- Desktop visit form is collapsed by default and opened only via `Log visit` / `Edit today visit`.
- Desktop visit history shows the latest 3 visits by default, with a collapsible `Show more` control.
- Desktop visit deletion now requires confirmation.
- Desktop visit history rows are clickable and open a detail panel with rating, notes, edit, and delete actions.
- Desktop database now deduplicates `restaurant_visits` by `place_id + visit_date` and adds a unique index to prevent repeat rows.
- Mobile now has per-visit records, notes, collapsed visit form, clickable past reviews, latest-3 history collapse, edit, and delete confirmation.
- Mobile database now deduplicates `restaurant_visits` by `place_id + visit_date` and adds the same unique index.

## Local Data Cleanup

- Removed 8,191 duplicate `restaurant_visits` rows from the installed desktop database.
- `Cielito Paradise` was reduced to 1 visit.
- Duplicate visit groups after cleanup: 0.

## High-Level Route Parity

Desktop routes:

- Dashboard
- Finance
- Portfolio
- Health
- Sleep detail
- Exercise detail
- HRV detail
- Productivity
- Weekend
- Saved
- Chat
- Settings

Mobile routes/screens:

- Home/Dashboard
- Briefings
- Portfolio
- Stock detail
- Market pulse
- Alerts
- Health
- Sleep history
- HRV history
- Exercise history
- Productivity
- Weekend planner
- Saved plans
- Plan detail
- Activity detail
- Chat
- Settings

Status: mobile covers the main product areas, but it is not a one-for-one clone of every desktop view. Mobile has some mobile-specific screens such as `Briefings`, `MarketPulse`, `Alerts`, `SavedPlans`, and detail screens. Desktop has a broader saved-item hub and deeper Weekend places/map tooling.

## Weekend Planner Parity

Desktop Weekend tabs:

- Plan
- Restaurants
- Places
- Map

Mobile Weekend tabs:

- Plan
- Events
- Restaurants

Weekend parity findings:

- Mobile now has saved restaurant visit logging with date, rating, notes, history, edit, and delete.
- Mobile has restaurant search, saved restaurants, manual add, edit modal, booking links, map/list toggle, filters, planner generation, saved-plan navigation, and export sharing.
- Desktop has a separate `Places` tab for non-food venues; mobile currently folds venue types into the Restaurants area and does not expose a separate places-first workflow.
- Desktop has a dedicated full `Map` tab over all saved places; mobile has a saved-restaurant static map view inside the Restaurants tab.
- Desktop has AI Discover and AI Research All controls for saved restaurants/places; mobile does not expose the same bulk research workflow.
- Desktop manual add uses Google Places search results in the add form; mobile manual add is simpler and separate from search/autocomplete.

Recommendation: if exact Weekend parity is required, the next mobile work should add a `Places` tab, a full saved-places map tab, and the AI Discover / AI Research All controls.

## Finance And Portfolio Parity

Desktop:

- Finance watchlist/search, market tools, briefings, alerts panels, portfolio risk/benchmark panels.
- Separate Portfolio page with positions, summary, value chart, holdings table, add/edit positions, import Robinhood symbols-only flow, and hidden summary values.

Mobile:

- Portfolio stack includes portfolio list, stock detail, market pulse, and alerts.
- Mobile has core watchlist/market/alerts flows, but portfolio position editing/import and all desktop analytics panels are not visibly equivalent from the reviewed screen set.

Recommendation: audit `PortfolioScreen`, `StockDetailScreen`, `MarketPulseScreen`, and `AlertsScreen` against desktop `FinancePage` and `PortfolioPage` before claiming full finance parity. Highest-risk missing areas are Robinhood import, detailed holdings edit, benchmark/risk analytics, and privacy masking across all portfolio totals.

## Health Parity

Desktop:

- Health overview plus dedicated Sleep, Exercise, and HRV detail pages.
- Rich visualizations including calendar heatmaps, correlations, recovery, training load, and detail charts.

Mobile:

- Health overview plus Sleep, Exercise, and HRV history screens.
- Mobile supports health sync/import paths and history views, but desktop visualization density is higher.

Recommendation: verify that mobile exposes the same cross-domain readiness, sleep consistency, sector/health correlations, training load details, wake prediction, and health alert management before treating Health as fully equivalent.

## Productivity Parity

Desktop:

- Productivity page with AI schedule generation/editing, Notion push, task context, and detailed schedule controls.

Mobile:

- Productivity screen exists and includes mobile-oriented schedule generation/sync behavior.

Recommendation: compare settings persistence, Notion push behavior, edited schedule save flow, empty/offline states, and mobile sync behavior before declaring parity.

## Chat And Saved Content Parity

Desktop:

- Chat page and broad Saved hub covering multiple saved artifact categories.

Mobile:

- Chat screen exists.
- Saved plans exist for weekend itineraries, but there is not an exact mobile equivalent of the desktop Saved hub for all categories.

Recommendation: if the saved hub is expected on mobile, add a generalized Saved screen or intentionally document mobile as weekend-plan-only.

## Settings Parity

Desktop:

- Full settings surface including AI, relay, health, Notion, API keys, model/activity settings, and app preferences.

Mobile:

- Settings screen exists and includes mobile-critical settings such as relay and API configuration.

Recommendation: complete a field-by-field Settings audit before claiming parity. Settings are high-risk because missing keys break sync, AI, Notion, Google Places, and health import flows.

## Security And Data Notes

- Visit review text is user-authored and rendered as text, not HTML, in the updated visit panels.
- Desktop and mobile now both enforce one restaurant visit per `place_id + visit_date`.
- Visit deletion now has confirmation on desktop and mobile.
- The duplicate explosion likely came from repeated sync/import or repeated save paths before a unique constraint existed. The new unique index makes recurrence much less likely.

## Remaining Gaps

1. Mobile does not yet have exact Desktop Weekend `Places` and full `Map` tab parity.
2. Mobile does not yet expose Desktop Weekend AI Discover / AI Research All parity.
3. Mobile Finance/Portfolio should be audited for Robinhood import, holdings edit, analytics, and privacy masking parity.
4. Mobile Health should be audited for every desktop chart and insight module.
5. Mobile Saved content is not equivalent to the desktop Saved hub.
6. Settings need a field-by-field parity check.

## Verification Performed

- Desktop quick health check.
- Desktop production build.
- Mobile TypeScript typecheck.
- Local installed database cleanup verification.

## Verification Still Recommended

- Open the mobile Weekend screen and verify visit add/edit/delete on device or simulator.
- Open desktop Weekend after reinstall and verify Cielito/Soul Vibez visit lists show only latest 3 and deletion requires confirmation.
