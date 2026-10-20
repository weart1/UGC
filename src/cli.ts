import { existsSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { loadBrief, loadConfig } from './config.js'
import { createFakeGenerator } from './gen/fake.js'
import { createRunwareGenerator } from './gen/runware.js'
import { runPipeline } from './pipeline.js'
import { Run, STAGES, type RunState, type Stage } from './state.js'

const USAGE = `Использование:
  ugc new <brief.json> [--example ролик.mp4|описание.txt] [--transcript текст.txt] [--until <этап>]
  ugc resume <папка-запуска> [--until <этап>]
  ugc redo <папка-запуска> --stage <этап> [--scene N] [--until <этап>]
  ugc show <папка-запуска>

Общие опции:
  --config <файл>   конфиг моделей (по умолчанию ugc.config.json)
  --runs <папка>    куда складывать запуски (по умолчанию runs/)
  --dry-run         без Runware: заглушки вместо генераций, ничего не тратит

Этапы: ${STAGES.join(', ')}
Сценарий можно поправить руками в <папка-запуска>/script.json и сделать resume —
перегенерируются только затронутые сцены.`

const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v'])

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      example: { type: 'string' },
      transcript: { type: 'string' },
      until: { type: 'string' },
      stage: { type: 'string' },
      scene: { type: 'string' },
      config: { type: 'string', default: 'ugc.config.json' },
      runs: { type: 'string', default: 'runs' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const [command, target] = positionals
  if (values.help || !command || !target) {
    console.log(USAGE)
    process.exitCode = values.help ? 0 : 1
    return
  }

  try {
    process.loadEnvFile('.env')
  } catch {
    // .env is optional: the key can come from the environment.
  }

  const until = parseStage(values.until, 'until') ?? 'assemble'
  const cfg = await loadConfig(values.config)
  const log = (msg: string) => console.log(msg)

  let run: Run
  switch (command) {
    case 'new': {
      const brief = await loadBrief(target)
      run = await Run.create(values.runs, brief, exampleOf(values.example, values.transcript))
      log(`Запуск: ${run.dir}`)
      break
    }
    case 'resume':
      run = await Run.open(target)
      break
    case 'redo': {
      const stage = parseStage(values.stage, 'stage')
      if (!stage) throw new Error('redo: укажи --stage')
      run = await Run.open(target)
      const scene = values.scene === undefined ? undefined : Number(values.scene) - 1
      if (scene !== undefined && !(scene >= 0 && scene < run.state.scenes.length)) {
        throw new Error(`--scene: в сценарии ${run.state.scenes.length} сцен`)
      }
      run.invalidate(stage, scene)
      await run.save()
      break
    }
    case 'show':
      show((await Run.open(target)).state)
      return
    default:
      throw new Error(`Неизвестная команда «${command}»\n\n${USAGE}`)
  }

  const gen = values['dry-run'] ? await createFakeGenerator(cfg) : await createRunwareGenerator(cfg)
  await runPipeline({ run, gen, cfg, log }, until)
}

function parseStage(value: string | undefined, flag: string): Stage | undefined {
  if (value === undefined) return undefined
  if (!(STAGES as readonly string[]).includes(value)) throw new Error(`--${flag}: один из ${STAGES.join(', ')}`)
  return value as Stage
}

function exampleOf(file?: string, transcript?: string): RunState['example'] {
  if (!file) return undefined
  for (const f of [file, transcript]) if (f && !existsSync(f)) throw new Error(`Файл не найден: ${f}`)
  const kind = VIDEO_EXT.has(path.extname(file).toLowerCase()) ? 'video' : 'text'
  return { kind, file: path.resolve(file), transcript: transcript && path.resolve(transcript) }
}

function show(state: RunState) {
  console.log(`${state.id}  $${state.spentUsd.toFixed(3)}  ${state.final ? 'готов: final.mp4' : 'не собран'}`)
  if (state.analysis) console.log(`Пример: ${state.analysis.format} — ${state.analysis.hook}`)
  if (!state.script) return console.log('Сценария ещё нет')
  console.log(`«${state.script.title}»`)
  state.script.scenes.forEach((s, i) => {
    const st = state.scenes[i] ?? {}
    const marks = `${st.keyframe ? 'кадр' : '----'} ${st.clip ? 'клип' : '----'}`
    console.log(`${String(i + 1).padStart(2)}. [${marks}] ${s.purpose}, ${s.duration}с: ${s.line || '(без текста)'}`)
  })
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
