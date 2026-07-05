# Syncing Apple Health Data to Mien

This guide shows how to create an Apple Shortcut that automatically sends your health data (sleep, heart rate, HRV, steps) from your iPhone to the Mien relay server.

## Prerequisites

- Relay server running (`cd relay && node server.js`)
- Relay URL and token (from Settings in the Mien app, or from `relay.key` on the server)
- Shortcuts app on your iPhone (built-in)

## How It Works

```
Apple Health → Shortcuts → HTTP POST → Relay Server → Mien (desktop & mobile)
```

The relay server has a simple endpoint designed for Shortcuts:

```
POST /health/simple?sleep=420&hr=68&steps=8500&hrv=45&date=2026-05-05
```

All parameters are optional — send whichever data you have.

## Creating the Shortcut

### Step 1: Open Shortcuts

Open the **Shortcuts** app on your iPhone and tap **+** to create a new shortcut. Name it **"Sync Health to Mien"**.

### Step 2: Add Health Data Actions

Add the following actions in order:

#### Get Sleep Data

1. **Find Health Samples** where
   - Type is **Sleep Analysis**
   - Start Date is in the **last 1 day**
   - Sort by **Start Date**, **Latest First**, Limit **1**
2. **If** *Health Samples* **has any value**:
   - **Set variable** `sleepMinutes` to the **Value** of the health sample (in minutes)
3. **Otherwise**: Set `sleepMinutes` to `0`

#### Get Heart Rate

1. **Find Health Samples** where
   - Type is **Heart Rate**
   - Start Date is in the **last 1 day**
   - Sort by **Start Date**, **Latest First**, Limit **1**
2. **If** *Health Samples* **has any value**:
   - **Set variable** `heartRate` to the **Value** (rounded)
3. **Otherwise**: Set `heartRate` to `0`

#### Get Steps

1. **Find Health Samples** where
   - Type is **Step Count**
   - Start Date is in the **last 1 day**
2. **Set variable** `steps` to the **Sum** of the health samples

#### Get HRV

1. **Find Health Samples** where
   - Type is **Heart Rate Variability**
   - Start Date is in the **last 1 day**
   - Sort by **Start Date**, **Latest First**, Limit **1**
2. **If** *Health Samples* **has any value**:
   - **Set variable** `hrv` to the **Value** (rounded)
3. **Otherwise**: Set `hrv` to `0`

### Step 3: Send to Relay

1. Add **Get Contents of URL**:
   - URL: `http://YOUR_RELAY_IP:3456/health/simple?sleep=[sleepMinutes]&hr=[heartRate]&steps=[steps]&hrv=[hrv]`
   - Method: **POST**
   - Headers: Add header `Authorization` with value `Bearer YOUR_RELAY_TOKEN`

Replace `YOUR_RELAY_IP` with your relay server's IP address and `YOUR_RELAY_TOKEN` with the token from `relay.key`.

If using a Cloudflare Tunnel, use the `https://xxx.trycloudflare.com` URL instead.

### Step 4: Done notification (optional)

Add **Show Notification**: "Health synced to Mien"

## Simplified Version (Copy-Paste Friendly)

If the step-by-step is too complex, here's the minimal shortcut — just 4 actions:

1. **Text** → `http://YOUR_RELAY_IP:3456/health/simple`
2. **Get Current Health Data** (you'll pick which types)
3. **Get Contents of URL** → POST to the text URL with query parameters
4. **Show Result**

The key is the final URL call. Even if you only send one metric (e.g. just steps), it works — all parameters are optional.

## Automating the Shortcut

### Run on a Schedule

1. Go to **Shortcuts → Automation** tab
2. Tap **+** → **Time of Day**
3. Set to run at **10:00 PM** (or whenever you want daily sync)
4. Select **"Sync Health to Mien"**
5. Toggle off **"Ask Before Running"**

### Run When You Open the Mien App

1. **Shortcuts → Automation → + → App**
2. Select **Mien** → **Is Opened**
3. Select your shortcut
4. Toggle off "Ask Before Running"

## Sending Sleep Stage Data

For detailed sleep stages (deep, REM, core), use the full `/health/sync` endpoint instead:

```
POST /health/sync
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json

{
  "metrics": [
    {
      "type": "sleep",
      "date": "2026-05-05",
      "value": {
        "totalAsleep": 420,
        "deep": 90,
        "rem": 105,
        "core": 225,
        "awake": 30,
        "sleepStart": "23:15",
        "sleepEnd": "06:45"
      }
    }
  ]
}
```

To build this in Shortcuts, use **Find Health Samples** for each sleep stage category (Deep Sleep, REM Sleep, Core Sleep), then construct a **Dictionary** and POST it as JSON.

## Verifying It Works

1. Run the shortcut manually
2. Check the relay server terminal — you should see: `Simple health sync: 4 metrics for 2026-05-05`
3. Open Mien on your phone → pull to refresh on the Health tab
4. Your data should appear

## Troubleshooting

### "Could not connect to server"
- Make sure the relay server is running
- iPhone and server must be on the same Wi-Fi (unless using Cloudflare Tunnel)
- Check the IP address — find it with `ipconfig` (Windows) or `ifconfig` (Mac/Linux)

### "401 Unauthorized"
- Add the `Authorization: Bearer <token>` header
- Token must match `relay.key` on the server exactly

### Data shows but values are 0
- Apple Health permissions: go to **Settings → Health → Data Access → Shortcuts** and make sure Shortcuts has read access to the health types you're querying

### Sleep data is missing
- Apple Watch must be worn during sleep for sleep tracking
- Sleep data is only available after you wake up and the watch processes it
- Check **Health → Browse → Sleep** to confirm data exists
