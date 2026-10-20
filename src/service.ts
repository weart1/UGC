import path from 'node:path'
import { applySettings, type Brief, type Config, type Settings } from './config.js'
import { createFakeGenerator } from './gen/fake.js'
import { createRunwareGenerator } from './gen/runware.js'
import type { Generator } from './gen/types.js'
import { approve, makeFinal, runPipeline } from './pipeline.js'
import { prepareProject } from './project.js'
import { Project, type Run, type RunStatus, type Stage } from './state.js'

/**
 * Shared by the CLI and the web panel. Each job gets its own generator, so
 * the spend it reports belongs to that job alone.
 */
export interface Service {
  cfg: Config
  projectsDir: string
  newGenerator(cfg: Config): Promise<Generator>
}

export function createService(cfg: Config, dataDir: string, dryRun: boolean): Service {
  return {
    cfg,
    projectsDir: path.resolve(dataDir, 'projects'),
    newGenerator: (jobCfg) => (dryRun ? createFakeGenerator(jobCfg) : createRunwareGenerator(jobCfg)),
  }
}

export type Log = (msg: string) => void

export function newProject(
  svc: Service,
  init: { name: string; brief: Brief; settings?: Settings; example?: string; variants: number },
  id?: string,
): Promise<Project> {
  return Project.create(
    svc.projectsDir,
    {
      name: init.name,
      brief: init.brief,
      settings: init.settings ?? { approvals: {}, models: {} },
      example: init.example ? { source: init.example } : undefined,
      variants: init.variants,
    },
    id,
  )
}

/** Analyses the example and writes every variant's script; then pushes each run as far as its gates allow. */
export async function runProject(svc: Service, project: Project, log: Log): Promise<void> {
  const cfg = applySettings(svc.cfg, project.state.settings)
  const runs = await prepareProject({ project, gen: await svc.newGenerator(cfg), cfg, log })
  // Runs waiting at a gate stay there; only those stopped by `until` go on.
  for (const run of runs) if (run.state.status === 'paused') await continueRun(svc, run, log)
}

export async function continueRun(svc: Service, run: Run, log: Log): Promise<RunStatus> {
  const cfg = applySettings(svc.cfg, run.state.settings)
  return runPipeline({ run, gen: await svc.newGenerator(cfg), cfg, log })
}

export type RunAction =
  | { type: 'approve'; what: 'script' | 'keyframes' }
  | { type: 'redo'; stage: Stage; scene?: number }
  | { type: 'final' }
  | { type: 'resume' }

/** Applies a user action to a run's state. The caller then continues the run. */
export async function applyAction(run: Run, action: RunAction): Promise<void> {
  switch (action.type) {
    case 'approve':
      if (action.what === 'keyframes' && run.state.scenes.some((s) => !s.keyframe)) {
        throw new Error('Не все кадры готовы')
      }
      if (action.what === 'script' && !run.state.script) throw new Error('Сценария ещё нет')
      approve({ run }, action.what)
      break
    case 'redo':
      if (action.scene !== undefined && !(action.scene >= 0 && action.scene < run.state.scenes.length)) {
        throw new Error(`Сцены ${action.scene + 1} нет`)
      }
      run.invalidate(action.stage, action.scene)
      break
    case 'final':
      if (run.state.status !== 'done') throw new Error('Финал делается из готового черновика')
      makeFinal({ run })
      break
    case 'resume':
      break
  }
  run.state.status = 'queued'
  await run.save()
}
