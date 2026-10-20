import { execFile } from 'node:child_process'
import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { ffmpeg } from './ffmpeg.js'

const exec = promisify(execFile)
const TRANSCRIBE_SCRIPT = path.resolve(import.meta.dirname, '../tools/transcribe.py')

export const isUrl = (s: string) => /^https?:\/\//i.test(s)

/** Downloads a TikTok / Reels / Shorts / Ad Library video with yt-dlp. Returns the file path. */
export async function downloadVideo(url: string, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  try {
    await exec(
      'yt-dlp',
      ['--no-playlist', '--max-filesize', '300M', '-f', 'mp4/bestvideo*+bestaudio/best', '--merge-output-format', 'mp4', '-o', 'example.%(ext)s', url],
      { cwd: dir, timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 },
    )
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? String(err)
    throw new Error(`Не удалось скачать ${url}: ${stderr.trim().split('\n').at(-1)}`)
  }
  const file = (await readdir(dir)).find((f) => f.startsWith('example.'))
  if (!file) throw new Error(`yt-dlp ничего не скачал по ссылке ${url}`)
  return path.join(dir, file)
}

/** Timestamped transcript via faster-whisper, or undefined when it isn't installed. */
export async function transcribe(file: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec('python3', [TRANSCRIBE_SCRIPT, file], { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

/** Grabs evenly spaced frames, small enough for a captioning model. */
export async function sampleFrames(file: string, duration: number, count: number, dir: string): Promise<{ time: number; file: string }[]> {
  await mkdir(dir, { recursive: true })
  const frames = Array.from({ length: count }, (_, i) => ({
    time: ((i + 0.5) * duration) / count,
    file: path.join(dir, `frame-${i}.jpg`),
  }))
  for (const f of frames) {
    await ffmpeg(['-ss', f.time.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=512:-2', f.file])
  }
  return frames
}
