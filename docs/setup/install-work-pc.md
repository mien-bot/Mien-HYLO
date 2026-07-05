# Installing Mien on a locked-down work computer

A top-to-bottom checklist for the case where:

- You don't have admin rights on the machine.
- SmartScreen, AppLocker, or Defender blocks `.exe` installers.
- The machine can't reach GitHub directly (private repo, no SSO, etc.).
- PowerShell's execution policy is locked at `RemoteSigned` by Group Policy.

You will end up with Mien running from a folder in your user directory, with Desktop / Start Menu shortcuts, talking to a relay you already run on another machine. **No admin prompts, nothing installed into `Program Files`.**

> **New to Mien?** Read [HOW-IT-WORKS.md](../../HOW-IT-WORKS.md) first — a layman's-terms overview of the relay, tunnels, and how data flows. Helps the troubleshooting section below make a lot more sense.

---

## What you need

- A **permissive machine** (home PC, personal laptop) signed in to GitHub with access to `mien-bot/Mien`. Just for the download.
- A **transfer channel** that works on both machines: OneDrive personal, USB drive, Teams chat, email to yourself - any single file you can copy between them.
- The work machine, signed in as yourself.
- The **relay URL and auth token** from the machine where your relay already runs (the long random string in `relay/relay.key`).

---

## Step 1 - Get the source onto your work machine

On the permissive machine:

1. Open https://github.com/mien-bot/Mien.
2. Click the green **Code** dropdown -> **Download ZIP**. You get `Mien-master.zip`.
3. Drop the zip into OneDrive / a USB / wherever your transfer channel is.

On the work machine:

4. Copy / download `Mien-master.zip` somewhere you control. **Avoid `Downloads/`** if you can - some corporate DLP setups scan that folder aggressively. A clean folder like `C:\Users\<you>\Mien\` is better.
5. Right-click the zip -> **Extract All...** -> point it at `C:\Users\<you>\Mien\`. You should now have `C:\Users\<you>\Mien\Mien-master\` containing `setup.ps1`, `package.json`, `src/`, etc.

---

## Step 2 - Unblock the downloaded files

Files that came from the internet carry a Zone.Identifier marker that PowerShell's `RemoteSigned` policy will refuse to run. Strip it before doing anything else.

Open PowerShell (Start menu -> type "PowerShell" -> Enter), then:

```powershell
cd C:\Users\<you>\Mien\Mien-master
Get-ChildItem -Recurse | Unblock-File
```

`Unblock-File` works without admin and respects `RemoteSigned` - all it does is delete the alternate data stream that marks files as internet-origin.

---

## Step 3 - Run the installer script

From the same PowerShell window:

```powershell
.\setup.ps1
```

What happens:

1. The script downloads Node.js 20 to `%USERPROFILE%\.mien\tools` (no admin needed) and adds it to your **user** PATH.
2. `npm install` runs in the Mien folder (this takes the longest - a few minutes on first run).
3. `npx electron-rebuild` rebuilds `better-sqlite3` for Electron's ABI. **This step always runs**, even if a prebuilt `.node` file is already there - the prebuilt one is compiled for Node.js, not Electron.
4. A silent VBS launcher is written to `%USERPROFILE%\.mien\launch.vbs`.
5. Desktop and Start Menu shortcuts are created.

When the script finishes you'll see:

```
  Mien is ready.

     Launch:  double-click 'Mien' on your Desktop or in the Start Menu
     Source:  C:\Users\<you>\Mien\Mien-master
```

If the script errors out, jump to **Troubleshooting** below and find your error message.

---

## Step 4 - Launch Mien

Double-click the **Mien** shortcut on your Desktop (or type "Mien" in the Start menu and Enter). The window opens straight to the Dashboard - no console window, no SmartScreen prompt (because nothing is being installed).

If nothing opens, the silent VBS launcher is being blocked by AppLocker. Fall back to:

```powershell
cd C:\Users\<you>\Mien\Mien-master
npm run dev
```

That runs Mien in foreground mode. Leave the PowerShell window open while you use the app - closing it kills Mien.

---

## Step 5 - Wire it to your relay

The Dashboard will show a banner saying AI isn't configured. To use the relay you already run on another machine:

1. Click the gear icon (Settings).
2. Under **AI Connection**, paste:
   - **Relay Server URL**: your existing Cloudflare tunnel URL (the same one your other client uses).
   - **Relay Auth Token**: the same token from your other machine's `relay/relay.key`.
3. Click **Save**.

The banner clears. Try the Chat page - it should respond on the next message. Both clients now share the same health data, briefings, and watchlist.

---

## Troubleshooting

In rough order of how often each one bites on locked-down machines.

### `setup.ps1 cannot be loaded ... not digitally signed`

You skipped Step 2. Run `Get-ChildItem -Recurse | Unblock-File` from inside the source folder, then re-run `.\setup.ps1`.

If you also see *"Set-ExecutionPolicy ... the setting is overridden by a policy defined at a more specific scope"* when trying to change the policy, that's expected - your IT has locked the policy via Group Policy and you can't override it. `Unblock-File` is still allowed and is the actual fix.

### `Could not download Node.js`

The corporate proxy is intercepting `nodejs.org`. Either:

- Set the proxy env var before re-running: `$env:HTTPS_PROXY = "http://proxy.example.com:8080"` (ask IT for the URL).
- Or download `node-v20.18.1-win-x64.zip` on the permissive machine, drop it at `%USERPROFILE%\.mien\tools\node.zip`, and re-run `.\setup.ps1` - the script will skip the download if the extracted folder already exists at `%USERPROFILE%\.mien\tools\node-v20.18.1-win-x64\`.

### `npm install` hangs forever or fails with SSL errors

Also the corporate proxy. `npm config set proxy http://proxy.example.com:8080` and `npm config set https-proxy http://proxy.example.com:8080`, then re-run.

### `electron-rebuild failed` / needs Visual Studio Build Tools

The prebuilt `better-sqlite3` binary for this Electron version isn't available and `node-gyp` is falling back to a from-source compile that needs MSVC. Workaround:

1. Run `setup.ps1` on the permissive machine.
2. Zip up `%USERPROFILE%\.mien\src\node_modules\better-sqlite3\` from there.
3. Transfer the zip and unzip it over the same path on the work machine.
4. Re-run `.\setup.ps1` - it will see the rebuilt binary and skip.

### Desktop shortcut does nothing when double-clicked

AppLocker is blocking `.vbs` files. Run Mien in foreground instead:

```powershell
cd C:\Users\<you>\Mien\Mien-master
npm run dev
```

Leave the PowerShell window open while you use the app.

### App crashes on startup with `NODE_MODULE_VERSION 137 ... requires NODE_MODULE_VERSION 145`

electron-rebuild didn't actually run. From the source folder:

```powershell
npx electron-rebuild -f -w better-sqlite3
npm run dev
```

If your zip is from before this guide existed and `setup.ps1` skipped the rebuild, that's the fix.

### Setting a password throws `MEMORY_LIMIT_EXCEEDED`

Fixed on `master` - re-download `Mien-master.zip` and reinstall, or edit `src/main/lib/auth.ts` locally and add `, maxmem: 128 * 1024 * 1024` to both `scryptSync(...)` option objects, then `npm run dev`.

### `Add-MpPreference -ExclusionPath` fails with access denied

This one needs admin under most Defender policies. Either ask IT for an exclusion on `%USERPROFILE%\.mien\` and `%USERPROFILE%\Mien\`, or accept that scans will run on those folders (slow first launch, fine afterward).

### Cloudflare tunnel URL is blocked by corporate firewall

Your tunnel may be classified as VPN / unknown. Options:

- Use a named Cloudflare tunnel pointing at a subdomain you own (gets categorized as a normal website).
- Use Mien from the work machine only on personal hotspot / off corporate network.

---

## Updating

When the source changes upstream, repeat Step 1 (download fresh ZIP, replace the folder), then:

```powershell
cd C:\Users\<you>\Mien\Mien-master
Get-ChildItem -Recurse | Unblock-File
npm install     # only if package.json changed
npm run dev
```

No need to re-run `setup.ps1` unless Node.js or the shortcut wiring changed.
