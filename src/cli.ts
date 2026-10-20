import { existsSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { loadBrief, loadConfig } from './config.js'
import { isUrl } from './media.js'
import { startServer } from './server/app.js'
import { applyAction, continueRun, createService, newProject, runProject, type RunAction } from './service.js'
import { Project, STAGES, type Stage } from './state.js'

const USAGE = `Использование:
  ugc serve                                       веб-панель (порт из PORT, по умолчанию 3000)
  ugc new <brief.json> [--example ролик.mp4|ссылка|описание.txt] [--variants N]
  ugc show <проект>
  ugc approve <проект> <вариант> script|keyframes
  ugc redo <проект> <вариант> --stage <этап> [--scene N]
  ugc final <проект> <вариант>                    перерендер одобренного черновика на финальной модели
  ugc resume <проект> [вариант]

Общие опции:
  --config <файл>   конфиг моделей (по умолчанию ugc.config.json)
  --data <папка>    данные (по умолчанию DATA_DIR или ./data)
  --dry-run         без Runware: заглушки вместо генераций, ничего не тратит

Этапы: ${STAGES.join(', ')}`

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      example: { type: 'string' },
      variants: { type: 'string', default: '1' },
      stage: { type: 'string' },
      scene: { type: 'string' },
      config: { type: 'string', default: 'ugc.config.json' },
      data: { type: 'string', default: process.env.DATA_DIR ?? 'data' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const [command, target, runId, what] = positionals
  if (values.help || !command) {
    console.log(USAGE)
    process.exitCode = values.help ? 0 : 1
    return
  }

  try {
    process.loadEnvFile('.env')
  } catch {
    // .env is optional: settings can come from the environment.
  }

  const cfg = await loadConfig(values.config)
  const dryRun = values['dry-run'] || process.env.DRY_RUN === '1'
  const svc = createService(cfg, values.data, dryRun)
  const log = (msg: string) => console.log(msg)

  if (command === 'serve') {
    await startServer(svc, { port: Number(process.env.PORT ?? 3000), password: process.env.PANEL_PASSWORD })
    return
  }
  if (!target) throw new Error(USAGE)

  if (command === 'new') {
    const brief = await loadBrief(target)
    if (values.example && !isUrl(values.example) && !existsSync(values.example)) throw new Error(`Файл не найден: ${values.example}`)
    const example = values.example && (isUrl(values.example) ? values.example : path.resolve(values.example))
    const project = await newProject(svc, { name: brief.product.name, brief, example, variants: Number(values.variants) })
    log(`Проект: ${project.dir}`)
    await runProject(svc, project, log)
    return
  }

  const project = await Project.open(target)
  if (command === 'show') return show(project)

  const runIds = runId ? [runId] : project.state.runs
  let action: RunAction
  switch (command) {
    case 'resume':
      if (project.state.status !== 'ready') return runProject(svc, project, log)
      action = { type: 'resume' }
      break
    case 'approve':
      if (what !== 'script' && what !== 'keyframes') throw new Error('approve: script или keyframes')
      action = { type: 'approve', what }
      break
    case 'redo': {
      const stage = values.stage as Stage
      if (!STAGES.includes(stage)) throw new Error(`--stage: один из ${STAGES.join(', ')}`)
      action = { type: 'redo', stage, scene: values.scene === undefined ? undefined : Number(values.scene) - 1 }
      break
    }
    case 'final':
      action = { type: 'final' }
      break
    default:
      throw new Error(`Неизвестная команда «${command}»\n\n${USAGE}`)
  }
  if (command !== 'resume' && !runId) throw new Error(`${command}: укажи вариант`)

  for (const id of runIds) {
    const run = await project.openRun(id)
    await applyAction(run, action)
    await continueRun(svc, run, log)
  }
}

async function show(project: Project) {
  const st = project.state
  console.log(`${st.name} — ${st.status}${st.error ? `: ${st.error}` : ''}`)
  if (st.analysis) console.log(`Пример: ${st.analysis.format} — ${st.analysis.hook}`)
  for (const id of st.runs) {
    const r = (await project.openRun(id)).state
    console.log(`\nВариант ${id} [${r.status}${r.error ? `: ${r.error}` : ''}] ${r.quality} $${r.spentUsd.toFixed(3)}`)
    if (!r.script) continue
    console.log(`«${r.script.title}» — ${r.script.persona.look}`)
    r.script.scenes.forEach((s, i) => {
      const st = r.scenes[i] ?? {}
      const marks = `${st.keyframe ? 'кадр' : '----'} ${st.clip ? 'клип' : '----'}${s.screen ? ` экран:${s.screen.layout}` : ''}`
      console.log(`${String(i + 1).padStart(2)}. [${marks}] ${s.purpose}, ${s.duration}с: ${s.line || '(без текста)'}`)
    })
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
