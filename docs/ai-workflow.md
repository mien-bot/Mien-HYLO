# AI Workflow

Mien borrows the useful parts of gstack as a repo-local operating model: structured planning, review, QA, security, documentation, and release checks. This document explains how to use those ideas without requiring every contributor to install gstack.

## Commands

```bash
npm run health:quick
npm run health
```

`health:quick` is the default preflight. It checks required project files, package scripts, key architecture files, documentation coverage, and whether known secret/runtime files are tracked by git.

`health` runs the same preflight and then executes the production desktop build.

## When To Use Each Gate

Plan before code when a task changes data flow, introduces a setting, touches IPC, affects sync, or changes user-facing behavior.

Review before shipping every code change. Focus on bugs that compile cleanly: stale IPC types, bad null handling, race-prone background jobs, empty API responses, and UI states that only fail with real data.

QA any desktop or mobile screen change in the running app. For desktop UI, use the route that exercises the changed domain. For mobile sync, test the relay-unavailable path as well as the happy path.

Security review anything that handles API keys, relay auth, local HTTP servers, file imports, external API text, AI prompts, or database writes.

Document release notes when setup, configuration, data sync, user workflows, or troubleshooting steps change.

## Mien-Specific Guardrails

- Keep all renderer-to-main communication behind the typed preload API.
- Keep SQLite migrations in `src/main/db/database.ts`.
- Use `src/main/lib/store.ts` for `electron-store`.
- Treat finance feeds, event data, restaurant data, health exports, and AI responses as untrusted input.
- Make relay/mobile behavior degrade cleanly when the desktop is closed or the tunnel is stale.
- Avoid unrelated edits when the worktree is already dirty.

