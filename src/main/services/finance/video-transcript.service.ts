import { execFile } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getDb } from '../../db/database'
import { extractYouTubeVideoId, fetchYouTubeCaptionTranscript } from './youtube.fetcher'

export type VideoContextMode = 'quick' | 'deep'
export type TranscriptStatus =
  | 'metadata_only'
  | 'captions'
  | 'yt_dlp_subtitles'
  | 'partial_audio_transcript'
  | 'full_audio_transcript'
  | 'failed'

export interface VideoContextResult {
  context: string | null
  status: TranscriptStatus
  source: string
  fetchedAt: string
}

interface ExecResult {
  stdout: string
  stderr: string
}

const QUICK_TRANSCRIPT_CHARS = 24_000
const DEEP_TRANSCRIPT_CHARS = 60_000

function execFileAsync(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 30_000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
      },
    )
  })
}

// yt-dlp / whisper are external CLIs that may be installed as a standalone
// binary on PATH OR as a Python module (`python -m yt_dlp`). Electron's PATH is
// often narrower than a dev shell, so a bare execFile('yt-dlp') frequently fails
// with ENOENT and silently collapses the whole transcript chain to metadata-only.
// We probe a set of candidate invocations once and cache the first that responds.
interface ToolInvocation {
  cmd: string
  prefix: string[]
}

const YT_DLP_CANDIDATES: ToolInvocation[] = [
  ...(process.env.MIEN_YTDLP_PATH ? [{ cmd: process.env.MIEN_YTDLP_PATH, prefix: [] }] : []),
  { cmd: 'yt-dlp', prefix: [] },
  { cmd: 'yt-dlp.exe', prefix: [] },
  { cmd: 'python', prefix: ['-m', 'yt_dlp'] },
  { cmd: 'py', prefix: ['-m', 'yt_dlp'] },
  { cmd: 'python3', prefix: ['-m', 'yt_dlp'] },
]

const WHISPER_CANDIDATES: ToolInvocation[] = [
  ...(process.env.MIEN_WHISPER_PATH ? [{ cmd: process.env.MIEN_WHISPER_PATH, prefix: [] }] : []),
  { cmd: 'faster-whisper', prefix: [] },
  { cmd: 'whisper', prefix: [] },
]

let ytDlpResolved: ToolInvocation | null = null

async function resolveTool(
  candidates: ToolInvocation[],
  versionArgs: string[] = ['--version'],
): Promise<ToolInvocation | null> {
  for (const cand of candidates) {
    try {
      await execFileAsync(cand.cmd, [...cand.prefix, ...versionArgs], { timeoutMs: 15_000 })
      return cand
    } catch {
      // try the next candidate
    }
  }
  return null
}

async function resolveYtDlp(): Promise<ToolInvocation | null> {
  if (ytDlpResolved) return ytDlpResolved
  ytDlpResolved = await resolveTool(YT_DLP_CANDIDATES)
  if (!ytDlpResolved) {
    console.warn(
      '[transcript] yt-dlp not found. Tried PATH and `python -m yt_dlp`. ' +
        'Install with `pip install yt-dlp` or set MIEN_YTDLP_PATH. ' +
        'YouTube subtitle/audio fallbacks are disabled until then.',
    )
  }
  return ytDlpResolved
}

async function runYtDlp(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const inv = await resolveYtDlp()
  if (!inv) throw new Error('yt-dlp is not installed or not resolvable')
  return execFileAsync(inv.cmd, [...inv.prefix, ...args], opts)
}

/** Diagnostic: which external transcript tools are usable from this process. */
export async function getTranscriptToolsStatus(): Promise<{
  ytDlp: ToolInvocation | null
  whisper: ToolInvocation | null
}> {
  return {
    ytDlp: await resolveYtDlp(),
    whisper: await resolveTool(WHISPER_CANDIDATES, ['--help']),
  }
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mien-youtube-'))
}

function removeTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {}
}

function cleanSubtitleText(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/^WEBVTT[\s\S]*?(?=\n\n|\r\n\r\n)/i, '')
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed) return false
      if (/^\d+$/.test(trimmed)) return false
      if (/-->/i.test(trimmed)) return false
      if (/^(kind|language):/i.test(trimmed)) return false
      return true
    })
    .join(' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\{\\an\d+\}/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

// YouTube's json3 caption format: { events: [{ segs: [{ utf8 }] }] }. Cleaner
// than VTT/SRT (no interleaved timestamps), so we parse it directly when present.
function parseJson3Subtitle(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { events?: Array<{ segs?: Array<{ utf8?: string }> }> }
    return (
      parsed.events
        ?.flatMap((event) => event.segs || [])
        .map((seg) => seg.utf8 || '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim() || ''
    )
  } catch {
    return ''
  }
}

function readLargestTextFile(dir: string, extensions: string[]): string | null {
  const files = fs
    .readdirSync(dir)
    .filter((name) => extensions.some((ext) => name.toLowerCase().endsWith(ext)))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8')
    const text = file.toLowerCase().endsWith('.json3')
      ? parseJson3Subtitle(raw)
      : cleanSubtitleText(raw)
    if (text) return text
  }
  return null
}

async function fetchYtDlpSubtitles(url: string): Promise<string | null> {
  const dir = makeTempDir()
  try {
    await runYtDlp(
      [
        '--skip-download',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs',
        'en.*,en',
        '--sub-format',
        'json3/vtt/srt/best',
        '--output',
        path.join(dir, '%(id)s.%(ext)s'),
        url,
      ],
      { cwd: dir, timeoutMs: 60_000 },
    )
    return readLargestTextFile(dir, ['.json3', '.vtt', '.srt', '.txt'])
  } catch (err) {
    console.warn('[transcript] yt-dlp subtitles failed:', (err as Error).message)
    return null
  } finally {
    removeTempDir(dir)
  }
}

async function getVideoDurationSeconds(url: string): Promise<number | null> {
  try {
    const { stdout } = await runYtDlp(['--skip-download', '--dump-json', url], {
      timeoutMs: 20_000,
    })
    const parsed = JSON.parse(stdout) as { duration?: number }
    return typeof parsed.duration === 'number' && parsed.duration > 0 ? parsed.duration : null
  } catch {
    return null
  }
}

export interface YouTubeMetadata {
  videoId: string | null
  title: string | null
  channel: string | null
  channelId: string | null
  uploadDate: string | null // YYYYMMDD
  durationSeconds: number | null
}

/** Fetch a YouTube video's metadata (title/channel/date) via yt-dlp --dump-json. */
export async function getYouTubeMetadata(url: string): Promise<YouTubeMetadata | null> {
  try {
    const { stdout } = await runYtDlp(['--skip-download', '--dump-json', url], {
      timeoutMs: 25_000,
    })
    const d = JSON.parse(stdout) as Record<string, unknown>
    return {
      videoId: typeof d.id === 'string' ? d.id : null,
      title: typeof d.title === 'string' ? d.title : null,
      channel:
        (typeof d.channel === 'string' && d.channel) ||
        (typeof d.uploader === 'string' && d.uploader) ||
        null,
      channelId: typeof d.channel_id === 'string' ? d.channel_id : null,
      uploadDate: typeof d.upload_date === 'string' ? d.upload_date : null,
      durationSeconds: typeof d.duration === 'number' ? d.duration : null,
    }
  } catch (err) {
    console.warn('[transcript] yt-dlp metadata failed:', (err as Error).message)
    return null
  }
}

function quickAudioSections(durationSeconds: number | null): string[] {
  if (!durationSeconds || durationSeconds <= 8 * 60) return ['*00:00-04:00']

  const middleStart = Math.max(0, Math.floor(durationSeconds / 2 - 120))
  const endStart = Math.max(0, durationSeconds - 240)
  return [
    '*00:00-04:00',
    `*${formatSeconds(middleStart)}-${formatSeconds(middleStart + 240)}`,
    `*${formatSeconds(endStart)}-${formatSeconds(durationSeconds)}`,
  ]
}

function formatSeconds(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = Math.floor(totalSeconds % 60)
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
}

function findAudioFiles(dir: string): string[] {
  const audioExts = ['.m4a', '.mp3', '.opus', '.webm', '.wav']
  return fs
    .readdirSync(dir)
    .filter((name) => audioExts.some((ext) => name.toLowerCase().endsWith(ext)))
    .map((name) => path.join(dir, name))
    .sort()
}

async function downloadAudio(url: string, mode: VideoContextMode, dir: string): Promise<string[]> {
  const args = [
    '--extract-audio',
    '--audio-format',
    'mp3',
    '--audio-quality',
    '9',
    '--output',
    path.join(dir, '%(id)s.%(section_number|full)s.%(ext)s'),
  ]

  if (mode === 'quick') {
    const duration = await getVideoDurationSeconds(url)
    for (const section of quickAudioSections(duration)) {
      args.push('--download-sections', section)
    }
  }

  args.push(url)
  await runYtDlp(args, { cwd: dir, timeoutMs: mode === 'quick' ? 120_000 : 300_000 })
  return findAudioFiles(dir)
}

async function transcribeWithFasterWhisper(
  audioFiles: string[],
  dir: string,
  mode: VideoContextMode,
): Promise<string | null> {
  const model = process.env.MIEN_WHISPER_MODEL || (mode === 'quick' ? 'base' : 'small')
  try {
    await execFileAsync(
      'faster-whisper',
      [
        ...audioFiles,
        '--model',
        model,
        '--language',
        'en',
        '--output_dir',
        dir,
        '--output_format',
        'txt',
      ],
      { cwd: dir, timeoutMs: mode === 'quick' ? 180_000 : 900_000 },
    )
    return readLargestTextFile(dir, ['.txt'])
  } catch (err) {
    console.warn('[transcript] faster-whisper unavailable/failed:', (err as Error).message)
    return null
  }
}

async function transcribeWithOpenAiWhisper(
  audioFiles: string[],
  dir: string,
  mode: VideoContextMode,
): Promise<string | null> {
  const model = process.env.MIEN_WHISPER_MODEL || (mode === 'quick' ? 'base' : 'small')
  try {
    await execFileAsync(
      'whisper',
      [
        ...audioFiles,
        '--model',
        model,
        '--language',
        'en',
        '--output_dir',
        dir,
        '--output_format',
        'txt',
        '--fp16',
        'False',
      ],
      { cwd: dir, timeoutMs: mode === 'quick' ? 180_000 : 900_000 },
    )
    return readLargestTextFile(dir, ['.txt'])
  } catch (err) {
    console.warn('[transcript] whisper unavailable/failed:', (err as Error).message)
    return null
  }
}

async function fetchAudioTranscript(
  url: string,
  mode: VideoContextMode,
): Promise<{ text: string; source: string } | null> {
  const dir = makeTempDir()
  try {
    const audioFiles = await downloadAudio(url, mode, dir)
    if (audioFiles.length === 0) return null

    const faster = await transcribeWithFasterWhisper(audioFiles, dir, mode)
    if (faster) return { text: faster, source: 'faster_whisper' }

    const openaiWhisper = await transcribeWithOpenAiWhisper(audioFiles, dir, mode)
    if (openaiWhisper) return { text: openaiWhisper, source: 'whisper' }

    return null
  } catch {
    return null
  } finally {
    removeTempDir(dir)
  }
}

function hasTranscript(context?: string | null): boolean {
  return Boolean(context && /Transcript \((YouTube captions|yt-dlp subtitles|audio)/i.test(context))
}

function hasDeepEnoughTranscript(context?: string | null): boolean {
  if (!hasTranscript(context)) return false
  return !/Transcript \(audio partial/i.test(context || '')
}

function buildContext(
  existingContext: string | null | undefined,
  sourceLabel: string,
  transcript: string,
  fetchedAt: string,
  maxChars: number,
): string {
  const prefix = existingContext?.trim() && !hasTranscript(existingContext)
    ? `Video description / source context:\n${existingContext.trim()}\n\n`
    : ''
  return `${prefix}Transcript metadata: source=${sourceLabel}; fetched_at=${fetchedAt}\nTranscript (${sourceLabel}):\n${transcript.slice(0, maxChars)}`
}

function saveTranscriptMetadata(
  url: string,
  context: string | null,
  status: TranscriptStatus,
  source: string,
  fetchedAt: string,
): void {
  try {
    getDb()
      .prepare(
        `UPDATE news_articles
         SET content_context = COALESCE(?, content_context),
             transcript_status = ?,
             transcript_source = ?,
             transcript_fetched_at = ?
         WHERE url = ?`,
      )
      .run(context, status, source, fetchedAt, url)
  } catch {}
}

export async function getVideoContext(
  url: string,
  existingContext?: string | null,
  mode: VideoContextMode = 'quick',
): Promise<VideoContextResult> {
  const fetchedAt = new Date().toISOString()
  const maxChars = mode === 'deep' ? DEEP_TRANSCRIPT_CHARS : QUICK_TRANSCRIPT_CHARS
  let sourceContext = existingContext
  if (!sourceContext) {
    try {
      const row = getDb()
        .prepare('SELECT content_context FROM news_articles WHERE url = ?')
        .get(url) as { content_context?: string | null } | undefined
      sourceContext = row?.content_context || null
    } catch {}
  }

  if (!/youtube\.com|youtu\.be/i.test(url)) {
    return { context: sourceContext || null, status: 'metadata_only', source: 'none', fetchedAt }
  }
  if (!extractYouTubeVideoId(url)) {
    return { context: sourceContext || null, status: 'metadata_only', source: 'none', fetchedAt }
  }
  if (mode === 'quick' && hasTranscript(sourceContext)) {
    return { context: sourceContext || null, status: 'captions', source: 'cache', fetchedAt }
  }
  if (mode === 'deep' && hasDeepEnoughTranscript(sourceContext)) {
    return { context: sourceContext || null, status: 'captions', source: 'cache', fetchedAt }
  }

  const captionTranscript = await fetchYouTubeCaptionTranscript(url)
  if (captionTranscript) {
    const context = buildContext(
      sourceContext,
      'YouTube captions',
      captionTranscript,
      fetchedAt,
      maxChars,
    )
    saveTranscriptMetadata(url, context, 'captions', 'youtube_captions', fetchedAt)
    return { context, status: 'captions', source: 'youtube_captions', fetchedAt }
  }

  const subtitleTranscript = await fetchYtDlpSubtitles(url)
  if (subtitleTranscript) {
    const context = buildContext(
      sourceContext,
      'yt-dlp subtitles',
      subtitleTranscript,
      fetchedAt,
      maxChars,
    )
    saveTranscriptMetadata(url, context, 'yt_dlp_subtitles', 'yt_dlp_subtitles', fetchedAt)
    return { context, status: 'yt_dlp_subtitles', source: 'yt_dlp_subtitles', fetchedAt }
  }

  const audioTranscript = await fetchAudioTranscript(url, mode)
  if (audioTranscript?.text) {
    const status: TranscriptStatus =
      mode === 'deep' ? 'full_audio_transcript' : 'partial_audio_transcript'
    const label = mode === 'deep' ? 'audio full' : 'audio partial'
    const context = buildContext(
      sourceContext,
      label,
      audioTranscript.text,
      fetchedAt,
      maxChars,
    )
    saveTranscriptMetadata(url, context, status, audioTranscript.source, fetchedAt)
    return { context, status, source: audioTranscript.source, fetchedAt }
  }

  const status: TranscriptStatus = sourceContext ? 'metadata_only' : 'failed'
  console.warn(
    `[transcript] no transcript for ${url} (status=${status}). ` +
      'Captions/InnerTube returned nothing and yt-dlp subtitle/audio fallbacks did not produce text. ' +
      'Ensure yt-dlp is installed (`pip install yt-dlp`); audio transcription also needs whisper + ffmpeg.',
  )
  saveTranscriptMetadata(url, sourceContext || null, status, 'none', fetchedAt)
  return { context: sourceContext || null, status, source: 'none', fetchedAt }
}
