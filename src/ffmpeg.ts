import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export async function ffmpeg(args: string[], opts: { cwd?: string } = {}): Promise<void> {
  try {
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 64 * 1024 * 1024, cwd: opts.cwd })
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? ''
    throw new Error(`ffmpeg ${args.join(' ')}\n${stderr.trim()}`)
  }
}

/** Duration in seconds of a media file. */
export async function probeDuration(file: string): Promise<number> {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ])
  const value = Number.parseFloat(stdout.trim())
  if (!Number.isFinite(value)) throw new Error(`ffprobe: не удалось определить длительность ${file}`)
  return value
}

export async function hasAudio(file: string): Promise<boolean> {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a',
    '-show_entries', 'stream=index',
    '-of', 'csv=p=0',
    file,
  ])
  return stdout.trim().length > 0
}

/** Timestamps (s) of hard cuts, to recover the editing rhythm of a reference video. */
export async function detectCuts(file: string, threshold = 0.3): Promise<number[]> {
  // showinfo logs one line per selected frame to stderr.
  const { stderr } = await exec('ffmpeg', [
    '-hide_banner', '-i', file,
    '-vf', `select='gt(scene,${threshold})',showinfo`,
    '-an', '-f', 'null', '-',
  ], { maxBuffer: 64 * 1024 * 1024 })
  return [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]))
}
