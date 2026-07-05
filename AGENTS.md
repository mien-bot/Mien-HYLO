# Mien Agent Workflow

This repo uses a lightweight, gstack-inspired workflow for AI-assisted work. The goal is to make every change pass through product framing, engineering review, QA, security, documentation, and release checks without adding vendored tooling.

## Project Context

Mien is a local-first personal intelligence dashboard:

- Desktop: Electron, React, TypeScript, Tailwind, SQLite via `better-sqlite3`.
- Mobile: Expo React Native companion app.
- Relay: Node server for AI proxying and desktop/mobile sync.
- Data domains: finance, health/sleep, productivity, weekend planning, Notion sync, AI chat.

Keep renderer code isolated from Node APIs. All desktop renderer access must go through `src/main/ipc.ts` and `src/main/preload.ts`.

## Default Sprint

Use this sequence for non-trivial work:

1. Product review: define the user outcome, smallest useful scope, and what should be deferred.
2. Engineering review: map files, data flow, IPC boundaries, database changes, failure modes, and tests.
3. Implementation: make the smallest coherent change that follows existing patterns.
4. Review: inspect the diff for production bugs, accidental scope growth, and missing edge cases.
5. QA: run the relevant app path manually or with a browser/simulator when UI behavior changed.
6. Security review: check secrets, auth boundaries, IPC exposure, local network endpoints, and third-party API handling.
7. Documentation/release: update user-facing docs when behavior, setup, settings, or data flow changed.

## Local Commands

Run the fastest relevant check before and after edits:

```bash
npm run health:quick
npm run health
npm run build
npm run package
```

`npm run health:quick` checks repo structure, required docs, package wiring, and obvious secret-tracking hazards without compiling.

`npm run health` runs the quick checks and then the production build.

## Review Checklist

Use this as the repo-local equivalent of gstack `/review`:

- Does the change preserve Electron's main/preload/renderer boundary?
- Are new IPC handlers exposed in `src/main/preload.ts` with typed renderer usage?
- Are database changes inlined in `src/main/db/database.ts` rather than file-based migrations?
- Are background jobs idempotent and safe to retry?
- Do API fetchers handle missing keys, rate limits, malformed responses, and network failures?
- Does mobile behavior still work when the relay URL or desktop app is unavailable?
- Did the change avoid touching unrelated dirty files?

## QA Checklist

Use this as the repo-local equivalent of gstack `/qa`:

- Desktop starts with `npm run dev`.
- Core page route loads for the changed domain.
- Settings values persist after reload.
- Any changed IPC flow works from renderer to main and returns usable errors.
- Any changed mobile sync path handles offline, stale token, and empty data states.
- UI text fits at narrow and desktop widths.

## Security Checklist

Use this as the repo-local equivalent of gstack `/cso`:

- No API keys, bearer tokens, relay keys, tunnel URLs with secrets, or personal exports are tracked.
- New IPC handlers expose only the minimum needed data.
- Local HTTP endpoints validate tokens when reachable outside localhost.
- File import paths are user-selected or configured, not derived from untrusted input.
- External API output is treated as untrusted text before rendering or prompt injection into AI context.

## Documentation Checklist

Use this as the repo-local equivalent of gstack `/document-release`:

- Update `README.md` for user-visible feature changes.
- Update `SETUP.md` for install, configuration, or API key changes.
- Update `DATA-SYNC.md` for relay, mobile, health, or Notion sync changes.
- Update `HOW-IT-WORKS.md` or `docs/architecture.md` for architectural changes.
- Update `CHANGELOG.md` when preparing a release.

## Release Checklist

Use this as the repo-local equivalent of gstack `/ship`:

1. Confirm `git status --short`.
2. Run `npm run health`.
3. Package only after build passes: `npm run package`.
4. Verify generated artifacts are expected and ignored or committed intentionally.
5. Commit only related files with a message that states the user-facing outcome.

