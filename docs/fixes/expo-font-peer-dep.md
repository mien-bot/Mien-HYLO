# Fix: expo-font peer dependency missing

## Symptom

Metro bundler failed to resolve `expo-font` when starting the mobile app:

```
Unable to resolve module expo-font from
  node_modules/@expo/vector-icons/build/createIconSet.js:
  expo-font could not be found within the project or in these directories:
    node_modules
    ../node_modules
```

All icons rendered via `@expo/vector-icons` (Lucide, Ionicons, etc.) would
fail to load, crashing screens that use them.

## Root cause

`expo-font` was a transitive dependency pulled in by `expo` itself, but was
never declared as a direct dependency in `mobile/package.json`. This works
until Metro's module resolution walks up the tree and fails to find the
package from inside `node_modules/@expo/vector-icons`.

`expo-doctor` surfaced this as:

```
✖ Check that required peer dependencies are installed
  Missing peer dependency: expo-font
  Required by: @expo/vector-icons
```

## Fix

```bash
cd mobile
npx expo install expo-font
```

This added `"expo-font": "~14.0.11"` to `package.json` (the correct
SDK 54-pinned version) and registered the config plugin in `app.json`.

Metro was restarted with `--clear` to flush the stale module resolution
cache.

## Remaining expo-doctor warnings (not actionable)

| Warning | Reason ignored |
|---|---|
| Metro config check | False positive — no custom `metro.config.js` exists; doctor scans node_modules fixtures |
| expo-font duplicate | v14 (project) vs v14 nested inside `react-native-health` deps — harmless at runtime |
| react-native-health New Arch | App targets SDK 54 / old arch; warning is irrelevant until SDK upgrade |
