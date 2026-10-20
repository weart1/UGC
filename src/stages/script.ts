import { readFile, writeFile } from 'node:fs/promises'
import { scriptPrompt } from '../prompts.js'
import { askJson, normalizeScript, ScriptSchema, type Scene, type Script } from '../script.js'
import type { Run } from '../state.js'
import type { Ctx } from './context.js'

const SCRIPT_FILE = 'script.json'

/**
 * Writes the script, or picks up hand edits to script.json: only the scenes
 * whose edited fields affect a stage get regenerated.
 */
export async function scriptStage({ run, gen, cfg, log }: Ctx): Promise<void> {
  const { minDuration, maxDuration } = cfg.models.video

  if (run.state.script) {
    const edited = await readEdited(run)
    if (!edited) return
    const script = normalizeScript(edited, minDuration, maxDuration)
    applyScriptEdit(run, script)
    await writeFile(run.file(SCRIPT_FILE), JSON.stringify(script, null, 2))
    await run.save()
    log('script.json изменён вручную — перегенерирую затронутые сцены')
    return
  }

  log('Пишу сценарий...')
  const raw = await askJson(
    gen,
    'script',
    scriptPrompt({
      brief: run.state.brief,
      analysis: run.state.analysis,
      language: cfg.language,
      minDuration,
      maxDuration,
      speaking: cfg.audio === 'native',
    }),
    ScriptSchema,
  )
  const script = normalizeScript(raw, minDuration, maxDuration)
  run.state.script = script
  run.state.scenes = script.scenes.map(() => ({}))
  await writeFile(run.file(SCRIPT_FILE), JSON.stringify(script, null, 2))
  await run.save()

  const total = script.scenes.reduce((a, s) => a + s.duration, 0)
  log(`Сценарий «${script.title}»: ${script.scenes.length} сцен, ${total} с`)
  script.scenes.forEach((s, i) => log(`  ${i + 1}. [${s.purpose}, ${s.duration}с] ${s.line || '(без текста)'}`))
}

async function readEdited(run: Run): Promise<Script | undefined> {
  let text: string
  try {
    text = await readFile(run.file(SCRIPT_FILE), 'utf8')
  } catch {
    return undefined
  }
  const edited = ScriptSchema.parse(JSON.parse(text))
  return JSON.stringify(edited) === JSON.stringify(run.state.script) ? undefined : edited
}

const KEYFRAME_FIELDS: (keyof Scene)[] = ['visual', 'shot', 'showsProduct']
const CLIP_FIELDS: (keyof Scene)[] = ['motion', 'duration', 'line']

/** Replaces the script and invalidates exactly what the edit touches. */
export function applyScriptEdit(run: Run, next: Script): void {
  const prev = run.state.script!
  const changed = (a: Scene | undefined, b: Scene, fields: (keyof Scene)[]) =>
    !a || fields.some((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]))

  run.state.script = next
  const scenes = next.scenes.map((_, i) => run.state.scenes[i] ?? {})
  run.state.scenes = scenes

  if (JSON.stringify(prev.persona) !== JSON.stringify(next.persona)) {
    run.invalidate('persona')
  } else {
    next.scenes.forEach((scene, i) => {
      const old = prev.scenes[i]
      if (changed(old, scene, KEYFRAME_FIELDS)) run.invalidate('keyframes', i)
      else if (changed(old, scene, CLIP_FIELDS)) run.invalidate('clips', i)
    })
  }

  const lines = (s: Script) => s.scenes.map((x) => x.line).join('\n')
  if (lines(prev) !== lines(next) || prev.persona.voice !== next.persona.voice) run.invalidate('voice')
  delete run.state.final
}
