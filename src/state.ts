import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Brief } from './config.js'
import type { Analysis, Script } from './script.js'

export interface SceneState {
  /** Files are relative to the run directory. */
  keyframe?: string
  keyframeRef?: string
  clip?: string
}

/**
 * Everything a run has produced so far. Each stage fills its part and the
 * pipeline skips stages whose output is already here, so an interrupted or
 * partly redone run resumes where it stopped instead of paying again.
 */
export interface RunState {
  id: string
  createdAt: string
  brief: Brief
  example?: { kind: 'video' | 'text'; file: string; transcript?: string }
  analysis?: Analysis
  script?: Script
  refs: { product?: string[]; persona?: string }
  persona?: string
  scenes: SceneState[]
  voice?: string
  final?: string
  spentUsd: number
}

export class Run {
  constructor(
    readonly dir: string,
    public state: RunState,
  ) {}

  static async create(runsDir: string, brief: Brief, example?: RunState['example']): Promise<Run> {
    const id = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
    const dir = path.resolve(runsDir, id)
    await mkdir(path.join(dir, 'media'), { recursive: true })
    const run = new Run(dir, { id, createdAt: new Date().toISOString(), brief, example, refs: {}, scenes: [], spentUsd: 0 })
    await run.save()
    return run
  }

  static async open(dir: string): Promise<Run> {
    const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')) as RunState
    return new Run(path.resolve(dir), state)
  }

  /** Absolute path of a run-relative (or already absolute) file. */
  file(rel: string): string {
    return path.resolve(this.dir, rel)
  }

  async writeMedia(name: string, data: Buffer): Promise<string> {
    const rel = path.join('media', name)
    await writeFile(this.file(rel), data)
    return rel
  }

  private saving: Promise<void> = Promise.resolve()

  /** Scenes finish in parallel, so writes are queued to keep state.json whole. */
  save(): Promise<void> {
    const target = path.join(this.dir, 'state.json')
    const write = async () => {
      await writeFile(`${target}.tmp`, JSON.stringify(this.state, null, 2))
      await rename(`${target}.tmp`, target)
    }
    this.saving = this.saving.then(write, write)
    return this.saving
  }

  /**
   * Forgets a stage's output and everything built from it, so the next
   * `resume` regenerates it. Scene-level stages can target a single scene.
   */
  invalidate(stage: Stage, scene?: number): void {
    const s = this.state
    const from = STAGES.indexOf(stage)
    const drops = (st: Stage) => STAGES.indexOf(st) >= from
    // A new persona or script changes every scene, whatever scene was asked for.
    const perScene = from >= STAGES.indexOf('keyframes')
    const scenes = scene === undefined || !perScene ? s.scenes : s.scenes.filter((_, i) => i === scene)

    if (drops('analysis')) delete s.analysis
    if (drops('script')) {
      delete s.script
      s.scenes = []
    }
    if (drops('persona')) {
      delete s.persona
      delete s.refs.persona
    }
    for (const sc of scenes) {
      if (drops('keyframes')) {
        delete sc.keyframe
        delete sc.keyframeRef
      }
      if (drops('clips')) delete sc.clip
    }
    // The voiceover covers the whole script: it depends on the script, not on the pictures.
    if (stage === 'voice' || drops('script')) delete s.voice
    delete s.final
  }
}

export const STAGES = ['analysis', 'script', 'persona', 'keyframes', 'clips', 'voice', 'assemble'] as const
export type Stage = (typeof STAGES)[number]

/** Runs `fn` over `items` with at most `limit` in flight; rejects on the first failure after all settle. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  const errors: unknown[] = []
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      try {
        results[i] = await fn(items[i] as T, i)
      } catch (err) {
        errors.push(err)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (errors.length) throw errors[0]
  return results
}
