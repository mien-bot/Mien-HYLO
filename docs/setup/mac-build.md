# Building Mien for iPhone (No Apple Developer Account)

This guide walks through building and installing Mien on your iPhone using a Mac. Uses Expo's development build with a free Apple ID — no $99 developer account needed.

---

## Prerequisites

### On the Mac
1. **Xcode** — install from the Mac App Store (free, ~12 GB)
2. **Xcode Command Line Tools** — open Terminal and run:
   ```bash
   xcode-select --install
   ```
3. **Node.js 18+** — install via Homebrew:
   ```bash
   # Install Homebrew if you don't have it
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

   # Install Node
   brew install node
   ```
4. **CocoaPods** (React Native iOS dependency manager):
   ```bash
   sudo gem install cocoapods
   ```

### On the iPhone
- iOS 16 or later
- A Lightning/USB-C cable to connect to the Mac

---

## One-Time Setup

### 1. Clone or copy the project to the Mac

If the repo is on GitHub:
```bash
git clone <your-repo-url> ~/Projects/Mien
cd ~/Projects/Mien/mobile
```

If transferring from your Windows PC (USB drive, network share, etc.):
```bash
# Copy the entire Mien folder to ~/Projects/Mien
cd ~/Projects/Mien/mobile
```

### 2. Install dependencies

```bash
npm install
```

### 3. Install expo-dev-client

This is what allows a standalone build (not Expo Go):
```bash
npx expo install expo-dev-client
```

### 4. Add Apple ID to Xcode

1. Open **Xcode**
2. Go to **Xcode → Settings → Accounts** (or `Cmd + ,`)
3. Click the **+** button → **Apple ID**
4. Sign in with any Apple ID (the one on your iPhone is fine)
5. You'll see a "Personal Team" appear — this is your free signing identity

### 5. Connect your iPhone

1. Plug your iPhone into the Mac via USB
2. On the iPhone, tap **Trust** when prompted
3. Keep it unlocked during the build

### 6. Register your device

Open Xcode, go to **Window → Devices and Simulators**. Your iPhone should appear. If it says "Preparing device for development", wait for it to finish.

---

## Build & Install

### First build (takes 5–10 min, subsequent builds are faster)

```bash
cd ~/Projects/Mien/mobile
npx expo run:ios --device
```

This will:
1. Generate the native `ios/` directory (Expo prebuild)
2. Install CocoaPods dependencies
3. Compile the app with Xcode
4. Sign it with your free Apple ID
5. Install it on your connected iPhone

**If prompted to select a device**, pick your iPhone from the list.

**If you get a signing error**, Xcode will open. In Xcode:
1. Select the project in the left sidebar
2. Go to **Signing & Capabilities** tab
3. Check **Automatically manage signing**
4. Select your **Personal Team** from the dropdown
5. If the bundle identifier `com.mien.app` conflicts, change it to something unique like `com.yourname.mien`
6. Close Xcode, run `npx expo run:ios --device` again

### Trust the developer on your iPhone

After the first install, the app won't open yet. On your iPhone:
1. Go to **Settings → General → VPN & Device Management**
2. Under "Developer App", tap your Apple ID email
3. Tap **Trust "[your email]"**
4. Now open Mien — it should launch with the noodle icon

---

## Updating the App

When you make code changes on your Windows PC:

### Option A: Git pull + rebuild (recommended)

On the Mac:
```bash
cd ~/Projects/Mien
git pull
cd mobile
npm install          # only needed if dependencies changed
npx expo run:ios --device
```

### Option B: Hot reload over network (during development)

If the Mac and iPhone are on the same WiFi:
```bash
cd ~/Projects/Mien/mobile
npx expo start --dev-client
```
Then open the Mien app on your iPhone — it connects to the dev server and hot-reloads changes. No rebuild needed for JS/TS changes.

### Option C: Copy files + rebuild

If not using git, copy the updated `mobile/` folder to the Mac and rebuild:
```bash
cd ~/Projects/Mien/mobile
npm install
npx expo run:ios --device
```

---

## Important Notes

### Free provisioning limitations
- Apps signed with a free Apple ID **expire after 7 days**
- You can only have **3 apps** installed at a time with free signing
- To renew: just run `npx expo run:ios --device` again
- Your data (SQLite DB) persists across reinstalls

### App updates without rebuilding
For JavaScript-only changes (no new native modules), you can use hot reload:
```bash
cd ~/Projects/Mien/mobile
npx expo start --dev-client
```
Open Mien on iPhone → it loads the latest JS from the dev server.

**You only need to rebuild** (`npx expo run:ios --device`) when:
- Adding a new native package (e.g. `expo install expo-camera`)
- Changing `app.json` config (icon, permissions, bundle ID)
- Updating Expo SDK version

### What triggers a native rebuild
| Change | Rebuild needed? |
|--------|----------------|
| Edit a `.tsx` screen | No — hot reload |
| Edit a service `.ts` file | No — hot reload |
| Add a new npm package (JS only) | No — hot reload |
| Add `expo-camera` or similar native module | **Yes** |
| Change `app.json` (icon, name, permissions) | **Yes** |
| Upgrade Expo SDK (`npx expo install expo@latest`) | **Yes** |

### HealthKit access
The app requests HealthKit permission for sleep/HR/HRV data. This works with free provisioning but requires the entitlement in `app.json` (already configured). On first launch, iOS will prompt for health data access.

### Notifications
Sleep routine notifications (`expo-notifications`) work with free provisioning. Push notifications from a server would require a paid account, but local scheduled notifications (what Mien uses) work fine.

---

## Quick Reference

```bash
# Full build + install to iPhone
cd ~/Projects/Mien/mobile
npx expo run:ios --device

# Dev mode (hot reload, no rebuild)
npx expo start --dev-client

# Clean rebuild (if something breaks)
cd ~/Projects/Mien/mobile
rm -rf ios node_modules
npm install
npx expo run:ios --device

# Check what's installed
npx expo config
```

---

## Troubleshooting

### "Untrusted Developer" on iPhone
Settings → General → VPN & Device Management → Trust your Apple ID

### "No provisioning profile" error
Open Xcode, go to the project signing settings, select your Personal Team, let it auto-manage signing.

### Build fails on CocoaPods
```bash
cd ios && pod install --repo-update && cd ..
npx expo run:ios --device
```

### "App is no longer available" (after 7 days)
Normal with free signing. Just rebuild:
```bash
npx expo run:ios --device
```

### iPhone not showing up
- Make sure it's unlocked and trusted
- Try a different USB cable
- Run `xcrun xctrace list devices` to verify it's detected
