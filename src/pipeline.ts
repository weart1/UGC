import { STAGES, type Stage } from './state.js'
import { analysisStage } from './stages/analysis.js'
import { assembleStage } from './stages/assemble.js'
import type { Ctx } from './stages/context.js'
import { scriptStage } from './stages/script.js'
import { clipsStage, keyframesStage, personaStage, voiceStage } from './stages/visuals.js'

const RUNNERS: Record<Stage, (ctx: Ctx) => Promise<void>> = {
  analysis: analysisStage,
  script: scriptStage,
  persona: personaStage,
  keyframes: keyframesStage,
  clips: clipsStage,
  voice: voiceStage,
  assemble: assembleStage,
}

/**
 * Runs every stage in order; each one skips work already recorded in the run
 * state. `until` stops after a stage, e.g. to review the script before paying
 * for video.
 */
export async function runPipeline(ctx: Ctx, until: Stage = 'assemble'): Promise<void> {
  const startSpent = ctx.run.state.spentUsd
  try {
    for (const stage of STAGES) {
      await RUNNERS[stage](ctx)
      if (stage === until) break
    }
  } finally {
    ctx.run.state.spentUsd = startSpent + ctx.gen.spentUsd()
    await ctx.run.save()
    ctx.log(`Потрачено в этом запуске: $${ctx.gen.spentUsd().toFixed(3)}, всего по ролику: $${ctx.run.state.spentUsd.toFixed(3)}`)
  }
}
