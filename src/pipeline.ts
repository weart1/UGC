import { STAGES, type RunStatus, type Stage } from './state.js'
import { assembleStage } from './stages/assemble.js'
import type { Ctx } from './stages/context.js'
import { scriptStage } from './stages/script.js'
import { clipsStage, keyframesStage, personaStage, voiceStage } from './stages/visuals.js'

const RUNNERS: Record<Stage, (ctx: Ctx) => Promise<void>> = {
  script: scriptStage,
  persona: personaStage,
  keyframes: keyframesStage,
  clips: clipsStage,
  voice: voiceStage,
  assemble: assembleStage,
}

/** The status a run waits in after `stage`, if a human has to approve it first. */
function gateAfter(stage: Stage, { run, cfg }: Ctx): RunStatus | undefined {
  const { approvals } = run.state
  if (stage === 'script' && cfg.approvals.script && !approvals.script) return 'awaiting_script'
  if (stage === 'keyframes' && cfg.approvals.keyframes && !approvals.keyframes) return 'awaiting_keyframes'
  return undefined
}

/**
 * Runs every stage in order; each one skips work already recorded in the run
 * state. Stops at approval gates and after `until`.
 */
export async function runPipeline(ctx: Ctx, until: Stage = 'assemble'): Promise<RunStatus> {
  const { run, gen, log } = ctx
  const spentBefore = gen.spentUsd()
  run.state.status = 'running'
  delete run.state.error
  await run.save()

  let status: RunStatus = 'done'
  try {
    for (const stage of STAGES) {
      await RUNNERS[stage](ctx)
      const gate = gateAfter(stage, ctx)
      if (gate) {
        status = gate
        break
      }
      if (stage === until && stage !== 'assemble') {
        status = 'paused'
        break
      }
    }
  } catch (err) {
    status = 'error'
    run.state.error = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    const spent = gen.spentUsd() - spentBefore
    run.state.spentUsd += spent
    run.state.status = status
    await run.save()
    if (spent > 0) log(`Потрачено: $${spent.toFixed(3)}, всего по варианту: $${run.state.spentUsd.toFixed(3)}`)
  }
  if (status === 'awaiting_script') log(`Вариант ${run.state.id}: сценарий ждёт одобрения`)
  if (status === 'awaiting_keyframes') log(`Вариант ${run.state.id}: кадры ждут одобрения`)
  return status
}

/** Marks a gate as passed. The caller resumes the run afterwards. */
export function approve(ctx: Pick<Ctx, 'run'>, what: 'script' | 'keyframes'): void {
  ctx.run.state.approvals[what] = true
}

/** Re-renders an already approved run on the expensive video profile. */
export function makeFinal(ctx: Pick<Ctx, 'run'>): void {
  const { run } = ctx
  run.state.quality = 'final'
  run.invalidate('clips')
  // Pictures don't change, so the keyframe approval stands.
  run.state.approvals.keyframes = true
}
