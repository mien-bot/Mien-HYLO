# Notion Calendar Integration

## Overview

The Weekend Planner can push generated itineraries directly to a Notion database. Each activity becomes a separate page with date/time, location, and cost details. Switch your Notion database to calendar view and your weekend plans appear on the calendar.

## Setup

### 1. Create a Notion Database

Create a new database in Notion with at minimum these two properties:

| Property | Type | Required |
|----------|------|----------|
| Name | Title | Yes (default) |
| Date | Date | Yes |

You can add extra properties (Tags, Status, etc.) — the integration only writes to Name and Date.

### 2. Connect Your Notion Integration

Your Notion API integration needs access to the database:

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Use the same integration whose API key is in Mien Settings
3. Open the database page in Notion, click `...` > `Connections` > add your integration

### 3. Configure in Mien (Optional)

You can set a default Calendar Database ID in **Settings > Notion > Calendar Database ID**. If set, the "Send to Notion" button will use it directly without showing the picker.

If left blank, clicking "Send to Notion" will fetch all databases from your Notion workspace and let you pick one.

## How It Works

### Pushing Weekend Plans

1. Generate a weekend plan on the Weekend page
2. Click **Send to Notion** in the header
3. Pick a Notion database from the dropdown (or it uses your default)
4. Each activity from Saturday and Sunday is created as a separate Notion page

### What Gets Created

For each activity in the plan:

| Field | Source |
|-------|--------|
| **Page title** | Activity name (e.g. "Brunch at Portillo's") |
| **Date start** | Parsed from time range (e.g. `2025-05-17T10:00:00`) |
| **Date end** | Parsed from time range (e.g. `2025-05-17T12:00:00`) |
| **Page body** | Location, travel time, cost, and AI rationale |

Time ranges like "10:00-12:00" or "10:00 AM - 12:00 PM" are parsed into proper datetime values. If a time can't be parsed, the activity is created as an all-day event on that date.

Saturday activities use the weekend date from the plan. Sunday is automatically calculated as the next day.

### Database Picker

The picker uses `notion.search()` to list all databases your integration has access to. It shows:
- Database title
- Click to push immediately

After the first push, clicking "Send to Notion" again pushes to the same database without re-showing the picker.

## Architecture

### Files

| File | Purpose |
|------|---------|
| `src/main/services/notion/notion.sync.ts` | `pushWeekendToNotion()` and `listNotionDatabases()` |
| `src/main/services/notion/notion.client.ts` | Added `calendarDbId` to settings lookup |
| `src/main/ipc.ts` | `weekend:pushToNotion` and `notion:listDatabases` handlers |
| `src/main/preload.ts` | Exposed `pushWeekendToNotion` and `listNotionDatabases` |
| `src/renderer/pages/WeekendPage.tsx` | "Send to Notion" button with database picker UI |
| `src/renderer/pages/SettingsPage.tsx` | Calendar Database ID setting field |

### Data Flow

```
Weekend Page: "Send to Notion" click
  -> listNotionDatabases() -> Notion API search -> database list dropdown
  -> User picks database
  -> pushWeekendToNotion(planJson, weekendDate, databaseId)
  -> Parse plan JSON into saturday[] + sunday[]
  -> For each activity:
       -> notion.pages.create({ parent: databaseId, Name, Date })
  -> Log to notion_sync_log table
```

### IPC Channels

| Channel | Direction | Payload |
|---------|-----------|---------|
| `notion:listDatabases` | renderer -> main | (none) |
| `weekend:pushToNotion` | renderer -> main | `planJson, weekendDate, databaseId?` |

## Tips

- **Calendar view**: After pushing, open the Notion database and select "Calendar" as the view type. Activities will appear on the correct dates with time ranges.
- **Duplicate protection**: There's no deduplication — pushing the same plan twice creates duplicate entries. Regenerate plans rather than re-pushing.
- **Multiple calendars**: You can push different weekends to different databases by leaving the Settings field blank and using the picker each time.
- **Notion rate limits**: The Notion API allows 3 requests/second. A typical weekend plan (6-8 activities) completes in about 3 seconds.
