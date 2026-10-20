import { clipPrompt, keyframePrompt, personaPrompt } from '../prompts.js'
import { mapLimit } from '../state.js'
import { sceneName, type Ctx } from './context.js'

/** One creator for the whole video: generated once, then passed as a reference to every scene. */
export async function personaStage({ run, gen, log }: Ctx): Promise<void> {
  const { state } = run
  const script = state.script!

  if (!state.refs.product) {
    state.refs.product = await Promise.all(state.brief.product.images.map((f) => gen.upload(f)))
    await run.save()
  }
  if (state.refs.persona) return

  if (state.brief.personaImage) {
    state.persona = state.brief.personaImage
  } else {
    log('Генерирую персонажа...')
    const image = await gen.image({ prompt: personaPrompt(script), refs: [] })
    state.persona = await run.writeMedia('persona.png', image)
  }
  state.refs.persona = await gen.upload(run.file(state.persona))
  await run.save()
}

export async function keyframesStage({ run, gen, cfg, log }: Ctx): Promise<void> {
  const { state } = run
  const script = state.script!
  const product = state.refs.product ?? []
  const todo = state.scenes.map((s, i) => ({ s, i })).filter(({ s }) => !s.keyframe)
  if (!todo.length) return

  log(`Кадры: ${todo.length} шт.`)
  await mapLimit(todo, cfg.concurrency, async ({ s, i }) => {
    const scene = script.scenes[i]!
    const refs = [state.refs.persona!, ...(scene.showsProduct ? product : [])]
    const image = await gen.image({ prompt: keyframePrompt(script, scene, product.length > 0), refs })
    s.keyframe = await run.writeMedia(sceneName(i, 'png'), image)
    s.keyframeRef = await gen.upload(run.file(s.keyframe))
    await run.save()
    log(`  кадр ${i + 1} готов`)
  })
}

export async function clipsStage({ run, gen, cfg, log }: Ctx): Promise<void> {
  const { state } = run
  const script = state.script!
  const todo = state.scenes.map((s, i) => ({ s, i })).filter(({ s }) => !s.clip)
  if (!todo.length) return

  log(`Видео: ${todo.length} клипов (это самый долгий шаг)`)
  await mapLimit(todo, cfg.concurrency, async ({ s, i }) => {
    const scene = script.scenes[i]!
    const video = await gen.video({
      prompt: clipPrompt(scene, { speaking: cfg.audio === 'native', language: cfg.language }),
      firstFrame: s.keyframeRef!,
      duration: scene.duration,
    })
    s.clip = await run.writeMedia(sceneName(i, 'mp4'), video)
    await run.save()
    log(`  клип ${i + 1} готов`)
  })
}

/** A single voiceover for the whole script keeps one voice; per-scene calls would design a new voice each time. */
export async function voiceStage({ run, gen, cfg, log }: Ctx): Promise<void> {
  const { state } = run
  if (cfg.audio !== 'tts' || state.voice) return
  const script = state.script!
  const text = script.scenes.map((s) => s.line.trim()).filter(Boolean).join(' ')
  if (!text) return

  log('Озвучка...')
  const audio = await gen.speech({ text, voice: script.persona.voice })
  state.voice = await run.writeMedia('voice.mp3', audio)
  await run.save()
}
