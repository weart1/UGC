import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { detectCuts, ffmpeg, probeDuration } from '../ffmpeg.js'
import { analysisPrompt } from '../prompts.js'
import { AnalysisSchema, askJson } from '../script.js'
import { mapLimit } from '../state.js'
import type { Ctx } from './context.js'

const MAX_FRAMES = 10

/** Turns the reference ad (a video or a text description) into a reusable structure. */
export async function analysisStage({ run, gen, cfg, log }: Ctx): Promise<void> {
  const example = run.state.example
  if (!example || run.state.analysis) return

  log('Разбираю пример...')
  const description = example.kind === 'video' ? await describeVideo({ run, gen, cfg, log }) : await readFile(example.file, 'utf8')
  const transcript = example.transcript ? `\nTRANSCRIPT:\n${await readFile(example.transcript, 'utf8')}` : ''

  run.state.analysis = await askJson(gen, 'analysis', analysisPrompt(description + transcript), AnalysisSchema)
  await run.save()
  log(`Формат примера: ${run.state.analysis.format}, ${run.state.analysis.beats.length} битов`)
}

/** Samples frames, captions them and adds cut points: a text the LLM can reason about. */
async function describeVideo({ run, gen, cfg }: Ctx): Promise<string> {
  const file = run.state.example!.file
  const duration = await probeDuration(file)
  const cuts = await detectCuts(file)
  const count = Math.min(MAX_FRAMES, Math.max(3, Math.ceil(duration / 2)))
  const times = Array.from({ length: count }, (_, i) => ((i + 0.5) * duration) / count)

  const dir = run.file('media/example')
  await mkdir(dir, { recursive: true })
  const captions = await mapLimit(times, cfg.concurrency, async (t, i) => {
    const frame = path.join(dir, `frame-${i}.jpg`)
    await ffmpeg(['-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=512:-2', frame])
    return `[${t.toFixed(1)}s] ${await gen.caption(frame)}`
  })

  return [
    `Duration: ${duration.toFixed(1)}s`,
    `Cuts at: ${cuts.length ? cuts.map((c) => `${c.toFixed(1)}s`).join(', ') : 'none detected (single shot)'}`,
    'Frames:',
    ...captions,
  ].join('\n')
}
