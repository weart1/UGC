import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Config } from './config.js'
import { detectCuts, probeDuration } from './ffmpeg.js'
import type { Generator } from './gen/types.js'
import { downloadVideo, isUrl, sampleFrames, transcribe } from './media.js'
import { runPipeline } from './pipeline.js'
import { analysisPrompt } from './prompts.js'
import { AnalysisSchema, askJson } from './script.js'
import { mapLimit, Run, type Project, type Recording } from './state.js'

const MAX_EXAMPLE_FRAMES = 10
const RECORDING_FRAMES = 3
const TEXT_EXT = new Set(['.txt', '.md'])

export interface ProjectCtx {
  project: Project
  gen: Generator
  cfg: Config
  log: (msg: string) => void
}

/**
 * Everything shared by the variants: the example is fetched, transcribed and
 * analysed once, recordings are described once, then each variant gets a
 * script written in turn so it can steer away from the hooks already used.
 * Returns the runs, each stopped after its script.
 */
export async function prepareProject(ctx: ProjectCtx): Promise<Run[]> {
  const { project, log } = ctx
  const st = project.state
  try {
    if (st.example && !st.analysis) st.analysis = await analyseExample(ctx)
    await project.save()
    if (!st.recordings) st.recordings = await describeRecordings(ctx)
    await project.save()

    const runs: Run[] = []
    for (let i = 0; i < st.variants; i++) {
      const id = String(i + 1)
      let run: Run
      if (st.runs.includes(id)) {
        run = await project.openRun(id)
      } else {
        run = await Run.create(project.runDir(id), {
          id,
          projectId: st.id,
          brief: st.brief,
          analysis: st.analysis,
          recordings: st.recordings,
          variant: { index: i, total: st.variants, avoid: avoidList(runs) },
        })
        st.runs.push(id)
        await project.save()
      }
      log(`Вариант ${id}/${st.variants}`)
      await runPipeline({ run, gen: ctx.gen, cfg: ctx.cfg, log }, 'script')
      runs.push(run)
    }
    st.status = 'ready'
    delete st.error
    await project.save()
    return runs
  } catch (err) {
    st.status = 'error'
    st.error = err instanceof Error ? err.message : String(err)
    await project.save()
    throw err
  }
}

/** What earlier variants already used, so the next one tries a different angle. */
function avoidList(runs: Run[]): string[] {
  return runs.flatMap((r) => {
    const s = r.state.script
    if (!s) return []
    return [`hook: "${s.scenes[0]?.line ?? ''}" / creator: ${s.persona.look}`]
  })
}

async function analyseExample({ project, gen, cfg, log }: ProjectCtx): Promise<ReturnType<typeof AnalysisSchema.parse>> {
  const example = project.state.example!
  let description: string

  if (!isUrl(example.source) && TEXT_EXT.has(path.extname(example.source).toLowerCase())) {
    description = await readFile(example.source, 'utf8')
  } else {
    if (!example.file) {
      if (isUrl(example.source)) log('Скачиваю пример...')
      example.file = isUrl(example.source) ? await downloadVideo(example.source, project.file('example')) : example.source
      await project.save()
    }
    if (example.transcript === undefined) {
      log('Расшифровываю речь в примере...')
      const text = await transcribe(example.file)
      example.transcript = text ?? ''
      if (text) await writeFile(project.file('example/transcript.txt'), text)
      else log('  транскрипция недоступна (нет faster-whisper) — анализ только по картинке')
      await project.save()
    }
    description = await describeVideo(example.file, example.transcript, project.file('example/frames'), gen, cfg)
  }

  log('Разбираю структуру примера...')
  const analysis = await askJson(gen, 'analysis', analysisPrompt(description), AnalysisSchema)
  log(`Формат примера: ${analysis.format}, ${analysis.beats.length} битов`)
  return analysis
}

/** Samples frames, captions them and adds cut points: a text the LLM can reason about. */
async function describeVideo(file: string, transcript: string, framesDir: string, gen: Generator, cfg: Config): Promise<string> {
  const duration = await probeDuration(file)
  const cuts = await detectCuts(file)
  const count = Math.min(MAX_EXAMPLE_FRAMES, Math.max(3, Math.ceil(duration / 2)))
  const frames = await sampleFrames(file, duration, count, framesDir)
  const captions = await mapLimit(frames, cfg.concurrency, async (f) => `[${f.time.toFixed(1)}s] ${await gen.caption(f.file)}`)

  return [
    `Duration: ${duration.toFixed(1)}s`,
    `Cuts at: ${cuts.length ? cuts.map((c) => `${c.toFixed(1)}s`).join(', ') : 'none detected (single shot)'}`,
    'Frames:',
    ...captions,
    transcript ? `\nTRANSCRIPT:\n${transcript}` : '',
  ].join('\n')
}

async function describeRecordings({ project, gen, log }: ProjectCtx): Promise<Recording[]> {
  const files = project.state.brief.screenRecordings
  if (!files.length) return []
  log(`Описываю записи экрана: ${files.length} шт.`)
  const out: Recording[] = []
  for (const [i, file] of files.entries()) {
    const duration = await probeDuration(file)
    const frames = await sampleFrames(file, duration, RECORDING_FRAMES, project.file(`recordings/${i}`))
    const captions: string[] = []
    for (const f of frames) captions.push(`at ${f.time.toFixed(1)}s: ${await gen.caption(f.file)}`)
    out.push({ file, duration, description: captions.join('; ') })
  }
  return out
}
