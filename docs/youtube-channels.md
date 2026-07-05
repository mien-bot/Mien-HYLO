# YouTube Channel Integration

## Overview

The Finance section pulls latest videos from YouTube channels you follow and displays them alongside Google News articles in the News feed. Videos are fetched via YouTube's public RSS feeds — no API key required.

## Default Channels

| Channel | Channel ID |
|---------|-----------|
| Meet Kevin | `UCUvvj5lwue7PspotMDjk5UA` |
| Trading Fraternity | `UC0ItS3yMDYkMXMGRMHe5fOA` |

These are pre-configured and will be used if no custom channels are set in Settings.

## How It Works

1. YouTube exposes an RSS feed for every channel at:
   ```
   https://www.youtube.com/feeds/videos.xml?channel_id=CHANNEL_ID
   ```
2. On every finance refresh (manual or scheduled every 4 hours), the app fetches the latest 10 videos per channel.
3. Videos are stored in the existing `news_articles` SQLite table with `source` set to `YouTube: Channel Name`.
4. The News panel displays them with a red **YT** badge to distinguish them from regular news articles.
5. Clicking a video opens it in your default browser.
6. When you request a summary, Mien builds video context in the fastest available order: stored context, YouTube captions, `yt-dlp` subtitles, then optional local audio transcription.

## Transcript Fallbacks

Mien does not transcribe every video by default. Quick summaries prioritize speed:

1. Use cached `content_context` if a transcript was already fetched.
2. Fetch YouTube caption tracks directly from the video page.
3. Try `yt-dlp` subtitle extraction without downloading audio.
4. If captions/subtitles are unavailable and local tools are installed, download low-bitrate audio and transcribe sampled sections.

Deep summaries use the same path, but the audio fallback transcribes the full audio instead of samples.

Optional local tools:

```bash
yt-dlp
faster-whisper
```

`whisper` is also supported as a fallback CLI. Set `MIEN_WHISPER_MODEL` to override the default model (`base` for quick summaries, `small` for deep summaries).

## Configuration

Go to **Settings > YouTube Channels** to manage your channel list.

### Format

One channel per line, using `Name|ChannelID` format:

```
Meet Kevin|UCUvvj5lwue7PspotMDjk5UA
Trading Fraternity|UC0ItS3yMDYkMXMGRMHe5fOA
Graham Stephan|UCV6KDgJskWaEckne5aPA0aQ
```

### Finding a Channel ID

1. Go to the YouTube channel page in your browser.
2. Right-click the page and select **View Page Source**.
3. Search for `channelId` — you'll find a string like `UCUvvj5lwue7PspotMDjk5UA`.

Alternatively, use a site like [Comment Picker](https://commentpicker.com/youtube-channel-id.php) to look it up by channel URL.

## Architecture

### Files

| File | Purpose |
|------|---------|
| `src/main/services/finance/youtube.fetcher.ts` | RSS fetch logic, channel parsing |
| `src/main/services/finance/index.ts` | Calls YouTube fetcher during refresh |
| `src/renderer/components/finance/NewsPanel.tsx` | Renders YT badge on video entries |
| `src/renderer/pages/SettingsPage.tsx` | YouTube Channels settings UI |

### Data Flow

```
Settings (youtubeChannels)
  -> parseChannelsSetting() -> YouTubeChannel[]
  -> fetchYouTubeVideos() -> rss-parser -> YouTube RSS
  -> INSERT into news_articles (source = "YouTube: Name")
  -> NewsPanel renders with YT badge
```

### Database

Videos use the existing `news_articles` table. No schema changes needed.

| Column | Value |
|--------|-------|
| `title` | Video title |
| `url` | YouTube watch URL |
| `source` | `YouTube: Channel Name` |
| `published_at` | ISO date from RSS |
| `summary` | AI-generated summary after you click Summary or Deep Summary |
| `content_context` | RSS description plus cached transcript context when available |
| `transcript_status` | Transcript state: captions, yt-dlp subtitles, partial/full audio transcript, metadata-only, or failed |
| `transcript_source` | Retrieval source: YouTube captions, yt-dlp subtitles, faster-whisper, whisper, or none |
| `transcript_fetched_at` | Last transcript attempt timestamp |
| `related_symbols` | `NULL` (videos aren't symbol-specific) |

## Adding More Channels

Some finance YouTube channels worth adding:

| Channel | ID |
|---------|-----|
| Graham Stephan | `UCV6KDgJskWaEckne5aPA0aQ` |
| Andrei Jikh | `UCGy7SkBjcIAgTiwkXEtPnYg` |
| Financial Education | `UCnMn36GT_H0X-w5_ckLtlgQ` |
| Tom Nash | `UCj3XKFWQK0RRxmMkEC1IHlg` |
| Ticker Symbol: YOU | `UCGy7SkBjcIAgTiwkXEtPnYg` |
