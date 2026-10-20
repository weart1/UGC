import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Brief, Quality } from './config.js'
import type { Analysis, Script } from './script.js'

export interface SceneState {
  /** Files are relative to the run directory. */
  keyframe?: string
  keyframeRef?: string
  clip?: string
}

/** A screen recording of the app, described so the LLM can pick moments from it. */
export interface Recording {
  file: string
  duration: number
  description: string
}

export type RunStatus = 'queued' | 'running' | 'paused' | 'awaiting_script' | 'awaiting_keyframes' | 'done' | 'error'

/**
 * Everything a run (one video variant) has produced so far. Each stage fills
 * its part and the pipeline skips stages whose output is already here, so an
 * interrupted or partly redone run resumes where it stopped instead of paying again.
 */
export interface RunState {
  id: string
  projectId: string
  createdAt: string
  status: RunStatus
  error?: string
  brief: Brief
  analysis?: Analysis
  recordings: Recording[]
  variant: { index: number; total: number; avoid: string[] }
  quality: Quality
  approvals: { script?: boolean; keyframes?: boolean }
  script?: Script
  refs: { product?: string[]; persona?: string }
  persona?: string
  scenes: SceneState[]
  voice?: string
  final?: string
  spentUsd: number
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await writeFile(`${file}.tmp`, JSON.stringify(data, null, 2))
  await rename(`${file}.tmp`, file)
}

export class Run {
  constructor(
    readonly dir: string,
    public state: RunState,
  ) {}

  static async create(dir: string, init: Omit<RunState, 'createdAt' | 'status' | 'refs' | 'scenes' | 'spentUsd' | 'approvals' | 'quality'>): Promise<Run> {
    await mkdir(path.join(dir, 'media'), { recursive: true })
    const run = new Run(path.resolve(dir), {
      ...init,
      createdAt: new Date().toISOString(),
      status: 'queued',
      quality: 'draft',
      approvals: {},
      refs: {},
      scenes: [],
      spentUsd: 0,
    })
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
    const write = () => writeJsonAtomic(path.join(this.dir, 'state.json'), this.state)
    this.saving = this.saving.then(write, write)
    return this.saving
  }

  /**
   * Forgets a stage's output and everything built from it, so the next
   * `resume` regenerates it. Scene-level stages can target a single scene.
   * Anything that changes the pictures asks for the keyframes to be approved again.
   */
  invalidate(stage: Stage, scene?: number): void {
    const s = this.state
    const from = STAGES.indexOf(stage)
    const drops = (st: Stage) => STAGES.indexOf(st) >= from
    // A new persona or script changes every scene, whatever scene was asked for.
    const perScene = from >= STAGES.indexOf('keyframes')
    const scenes = scene === undefined || !perScene ? s.scenes : s.scenes.filter((_, i) => i === scene)

    if (drops('script')) {
      delete s.script
      s.scenes = []
      delete s.approvals.script
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
    if (from <= STAGES.indexOf('keyframes')) delete s.approvals.keyframes
    // The voiceover covers the whole script: it depends on the script, not on the pictures.
    if (stage === 'voice' || drops('script')) delete s.voice
    delete s.final
  }
}

export const STAGES = ['script', 'persona', 'keyframes', 'clips', 'voice', 'assemble'] as const
export type Stage = (typeof STAGES)[number]

export type ProjectStatus = 'preparing' | 'ready' | 'error'

/** One brief + one example → several video variants (runs). */
export interface ProjectState {
  id: string
  name: string
  createdAt: string
  status: ProjectStatus
  error?: string
  brief: Brief
  example?: { source: string; file?: string; transcript?: string }
  variants: number
  analysis?: Analysis
  recordings?: Recording[]
  runs: string[]
}

export class Project {
  constructor(
    readonly dir: string,
    public state: ProjectState,
  ) {}

  static async create(projectsDir: string, init: Pick<ProjectState, 'name' | 'brief' | 'example' | 'variants'>, id = newId(init.name)): Promise<Project> {
    const dir = path.resolve(projectsDir, id)
    await mkdir(path.join(dir, 'runs'), { recursive: true })
    const project = new Project(dir, { ...init, id, createdAt: new Date().toISOString(), status: 'preparing', runs: [] })
    await project.save()
    return project
  }

  static async open(dir: string): Promise<Project> {
    const state = JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf8')) as ProjectState
    return new Project(path.resolve(dir), state)
  }

  static async list(projectsDir: string): Promise<Project[]> {
    let names: string[]
    try {
      names = await readdir(projectsDir)
    } catch {
      return []
    }
    const projects = await Promise.all(names.map((n) => Project.open(path.join(projectsDir, n)).catch(() => undefined)))
    return projects.filter((p): p is Project => Boolean(p)).sort((a, b) => b.state.createdAt.localeCompare(a.state.createdAt))
  }

  file(rel: string): string {
    return path.resolve(this.dir, rel)
  }

  runDir(runId: string): string {
    return path.join(this.dir, 'runs', runId)
  }

  openRun(runId: string): Promise<Run> {
    return Run.open(this.runDir(runId))
  }

  save(): Promise<void> {
    return writeJsonAtomic(path.join(this.dir, 'project.json'), this.state)
  }
}

/** Sortable, filesystem-safe id: date plus a slug of the name. */
export function newId(name: string): string {
  const date = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30)
  return slug ? `${date}_${slug}` : date
}

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
