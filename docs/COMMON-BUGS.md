# Common Bugs & Pitfalls

Recurring issues that have broken the app multiple times. Check this before shipping.

## 1. useCallback self-reference (temporal dead zone)

**Error:** `Cannot access 'X' before initialization`

**Cause:** A `useCallback` that lists itself in its own dependency array:
```tsx
// WRONG — self-reference creates temporal dead zone
const loadData = useCallback(async () => {
  // ...
}, [loadData])  // <-- references itself before it's assigned
```

**Fix:** Remove the self-reference. If the callback has no external deps, use `[]`:
```tsx
// CORRECT
const loadData = useCallback(async () => {
  // ...
}, [])
```

**History:**
- 2026-05-17: `loadTodayTasks` in ProductivityPage.tsx crashed the app on load

---

## 2. Missing lucide-react imports

**Error:** `Failed to construct 'Image'` or similar DOM constructor errors

**Cause:** Using a lucide icon in JSX without importing it. The browser falls back to the native DOM constructor (e.g., `Image`, `Text`, `Navigator`).

**Fix:** Always check that every `<IconName>` used in JSX is imported from `lucide-react`.

**History:**
- 2026-05-16: `Image` used in WeekendPage.tsx but never imported — crashed the Weekend tab

---

## 3. electron-vite build not run before packaging

**Error:** Installer ships stale code / features don't appear after install

**Cause:** `npm run package` (electron-builder) does NOT run `npm run build` (electron-vite build). If you only run `package`, it bundles whatever was last built.

**Fix:** Always run both:
```bash
npm run build && npm run package
```

**History:**
- 2026-05-17: Saturday/Sunday day-toggle checkboxes were in source but missing from installed app

---

## 4. electron-store v11 ESM import

**Error:** `store.get is not a function` or similar

**Cause:** electron-store v11 exports ESM by default. When externalized by electron-vite, the default export gets nested.

**Fix:** Always use the wrapper:
```typescript
import store from './lib/store'  // NOT from 'electron-store' directly
```

The wrapper at `src/main/lib/store.ts` handles: `const StoreClass = (ElectronStore as any).default || ElectronStore`

---

## 5. Invalid Claude model IDs

**Error:** API 400 errors or silent failures in AI features

**Cause:** Using non-existent model IDs like `claude-sonnet-4-6-20250514` or `claude-opus-4-7`.

**Valid IDs:**
- `claude-sonnet-4-6` (default)
- `claude-opus-4-6` (Opus mode)
- `claude-haiku-4-5-20251001`

---

## 6. Server-side tools (web_search) fail silently over relay OAuth

**Symptom:** AI features that rely on live web search degrade silently — e.g. Plan Weekend "search the web" returns a "Live search was unavailable this session due to a tool error" notice and falls back to stale training-data guesses instead of real results.

**Cause:** The desktop reaches Claude through the relay (`getClient()` in `ai.service.ts` prefers `relayUrl`), and the relay authenticates to Anthropic with a **Claude Code OAuth token** (`relay/server.js:2050-2054` — `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`). **Server-side tools like `web_search` and `code_execution` are not available over Claude Code OAuth tokens** — they require `x-api-key` auth on an org with web search enabled. When Claude tries to invoke the tool, server-side execution fails and the model falls back to "prior knowledge."

Note: this is **not** a tool-version bug. `web_search_20260209` and `code_execution_20260120` (`ai.service.ts:159,167`) are valid current API versions.

**Affected call sites** (all pass `{ webSearch: true }`):
- `webSearchEvents()` — `weekend-planner.service.ts:1155` (Plan Weekend web search)
- `performRestaurantResearch()` / discover — `restaurants.service.ts:1003,1257`

**Fix options (none applied — current behavior is intentional):**
- Use a direct Anthropic API key (with web search enabled) instead of the OAuth token — set `claudeApiKey` in Settings (direct API mode) or point the relay at an API key. Web search is a paid server tool.
- Prefer the key-free Ticketmaster path `searchWeekendEvents()` (`weekend-planner.service.ts:1140`) for events — it doesn't depend on server-side tools.
- Detect the tool failure/refusal and surface a toast instead of showing the model's fallback prose as if it were a real result.

**History:**
- 2026-06-13: Plan Weekend web search surfaced a stale Thai-festival guess; traced to relay OAuth not supporting the server-side `web_search` tool. Decision: keep as is (Ticketmaster path works; web search would require a paid API key).

---

## Pre-ship checklist

1. Search for `useCallback.*\[.*same-function-name` patterns
2. Verify all lucide-react icons are imported
3. Run `npm run build` before `npm run package`
4. Test the app loads each page without console errors
