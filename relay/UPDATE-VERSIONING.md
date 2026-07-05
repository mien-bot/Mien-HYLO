# Server Update Versioning

When preparing an update that the relay will serve through `/update/info` and `/update/files`, bump versions in the same commit as the code change.

## Required Bumps

- `package.json`: bump the desktop app patch version for any desktop source update.
- `package-lock.json`: keep the root package version in sync with `package.json`.
- `VERSION`: keep this equal to the desktop app version.
- `relay/package.json`: bump the relay patch version for any relay/server update.

Use patch bumps for normal source-update changes, for example:

- `1.9.1` to `1.9.2` for desktop app changes.
- `3.1.1` to `3.1.2` for relay changes.

Use minor or major bumps only for user-visible feature releases or compatibility-breaking changes.

## Before Commit

1. Confirm the version files are included in `git status --short`.
2. Run `npm run health:quick`.
3. Run `npm run build` when desktop, renderer, main, preload, or shared TypeScript changed.
4. Commit the code and version bump together.
5. Push the branch that the relay server pulls from.

## Why

The desktop Software Update panel can fetch source changes from the relay, but visible versions make it much easier to confirm whether the server has pulled and restarted onto the expected update. The relay `/health` response reads `relay/package.json`, so relay version changes show up after restart.
