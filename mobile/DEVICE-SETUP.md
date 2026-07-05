# Running Mien on Your iPhone

This guide covers how to install Mien as a standalone app on your iPhone with its own icon, instead of running through Expo Go.

## Prerequisites

- **Node.js** installed
- **Apple ID** (free tier works for personal devices)
- iPhone connected to the same Wi-Fi as your dev machine

## One-Time Setup

### 1. Install EAS CLI

```bash
npm install -g eas-cli
```

### 2. Create an Expo Account & Log In

Create a free account at [expo.dev](https://expo.dev), then:

```bash
eas login
```

### 3. Register Your iPhone

This creates a provisioning profile so builds can be installed on your device.

```bash
cd mobile
eas device:create
```

Follow the prompts — it will give you a URL to open in Safari on your iPhone. This installs a provisioning profile. You only need to do this once per device.

## Building the App

### Development Build (with hot reload)

This builds a custom native app that connects to Expo's dev server. You get hot reload and debugging, but the app has its own icon and runs independently.

```bash
cd mobile
eas build --profile development --platform ios
```

The build runs on EAS servers (~10-15 minutes). When done, scan the QR code to install the `.ipa` on your phone.

To start developing:

```bash
npx expo start --dev-client
```

Open the Mien app on your phone — it auto-discovers the dev server on your local network.

### Preview Build (standalone, no dev server)

A fully self-contained app. No dev server needed — the JS bundle is embedded.

```bash
cd mobile
eas build --profile preview --platform ios
```

Scan the QR code to install. The app runs completely offline from your computer.

### Production Build (App Store / TestFlight)

Requires a paid Apple Developer Program membership ($99/year).

```bash
cd mobile
eas build --profile production --platform ios
```

Upload the resulting `.ipa` to App Store Connect for TestFlight distribution or App Store submission.

## Build Profiles Summary

| Profile | Dev Server | Distribution | Use Case |
|---------|-----------|-------------|----------|
| `development` | Required | Ad hoc (your device) | Daily development with hot reload |
| `development-simulator` | Required | Simulator | Testing on iOS Simulator (macOS only) |
| `preview` | Not needed | Ad hoc (your device) | Standalone testing, sharing with others |
| `production` | Not needed | App Store / TestFlight | Public release |

## App Icon

The app icon is generated from `resources/icon.svg` (the bread logo). To regenerate icons after changing the SVG:

```bash
# From project root (requires sharp: npm install -D sharp)
node scripts/generate-icons.mjs
```

This outputs:
- `mobile/assets/icon.png` — 1024x1024, iOS app icon
- `mobile/assets/adaptive-icon.png` — 1024x1024, Android adaptive icon
- `mobile/assets/splash-icon.png` — 1024x1024, splash screen
- `mobile/assets/favicon.png` — 48x48, web favicon

## Troubleshooting

### "Device not registered"
Run `eas device:create` again and re-install the provisioning profile on your iPhone.

### Build fails with signing errors
Make sure you selected the correct Apple team during `eas build`. EAS handles provisioning automatically with your Apple ID — no paid developer account needed for ad hoc builds on registered devices.

### App can't find dev server
Both your iPhone and computer must be on the same Wi-Fi network. If it still can't connect, the dev server URL is shown in the terminal — enter it manually in the Mien app's dev client launcher.

### HealthKit not working
HealthKit only works on physical devices, not simulators. The app already has the required entitlements in `app.json`. You'll be prompted to grant health data access on first launch.
