import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applySettings, BriefSchema, ConfigSchema } from '../src/config.js'
import { scriptPrompt } from '../src/prompts.js'
import { deepMerge } from '../src/gen/runware.js'
import type { Generator } from '../src/gen/types.js'
import { askJson, extractJson, normalizeScript, ScriptSchema, type Script } from '../src/script.js'
import { applyScriptEdit } from '../src/stages/script.js'
import { mapLimit, Run } from '../src/state.js'
import { buildAss, chunkWords, perSceneCues, voiceoverCues } from '../src/subtitles.js'

const scene = (over: Partial<Script['scenes'][number]> = {}) => ({
  purpose: 'hook',
  duration: 5,
  shot: 'selfie',
  visual: 'woman',
  motion: 'talks',
  line: 'привет как дела',
  onScreenText: '',
  showsProduct: false,
  screen: null,
  ...over,
})
const script = (): Script => ({
  title: 't',
  persona: { look: 'woman', voice: 'warm' },
  scenes: [scene(), scene({ purpose: 'demo' }), scene({ purpose: 'cta' })],
})
const brief = BriefSchema.parse({ product: { name: 'p', description: 'd', type: 'app' }, audience: 'a', targetSeconds: 20 })

describe('extractJson', () => {
  it('reads fenced and prose-wrapped JSON', () => {
    expect(extractJson('Вот:\n```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('Sure! {"a": {"b": 2}} hope it helps')).toEqual({ a: { b: 2 } })
  })
  it('fails without an object', () => {
    expect(() => extractJson('no json here')).toThrow()
  })
})

describe('askJson', () => {
  it('retries once with the validation error', async () => {
    const prompts: string[] = []
    const answers = ['{"title": 1}', JSON.stringify(script())]
    const gen = { text: async (_k: string, p: string) => (prompts.push(p), answers.shift()!) } as unknown as Generator
    const result = await askJson(gen, 'script', 'PROMPT', ScriptSchema)
    expect(result.title).toBe('t')
    expect(prompts[1]).toContain('previous answer was rejected')
  })
})

describe('normalizeScript', () => {
  it('clamps durations to the video model range', () => {
    const s = script()
    s.scenes[0]!.duration = 2
    s.scenes[1]!.duration = 7.6
    s.scenes[2]!.duration = 30
    expect(normalizeScript(s, { minDuration: 4, maxDuration: 10, recordings: 0 }).scenes.map((x) => x.duration)).toEqual([4, 8, 10])
  })
  it('drops references to recordings that do not exist', () => {
    const s = script()
    s.scenes[0]!.screen = { recording: 0, start: 0, layout: 'full' }
    s.scenes[1]!.screen = { recording: 3, start: 0, layout: 'pip' }
    const out = normalizeScript(s, { minDuration: 4, maxDuration: 10, recordings: 1 })
    expect(out.scenes[0]!.screen).not.toBeNull()
    expect(out.scenes[1]!.screen).toBeNull()
  })
})

describe('deepMerge', () => {
  it('merges nested objects, replaces arrays, drops nulls', () => {
    expect(
      deepMerge(
        { a: { b: 1, c: 2 }, list: [1, 2], width: 100 },
        { a: { c: 3 }, list: [9], width: null },
      ),
    ).toEqual({ a: { b: 1, c: 3 }, list: [9] })
  })
})

describe('subtitles', () => {
  it('chunks words', () => {
    expect(chunkWords('раз два три четыре пять', 2)).toEqual(['раз два', 'три четыре', 'пять'])
  })
  it('voiceover cues cover the voice duration', () => {
    const cues = voiceoverCues(['раз два три четыре пять шесть', 'семь'], 10)
    expect(cues[0]!.start).toBe(0)
    expect(cues.at(-1)!.end).toBeCloseTo(10)
  })
  it('per-scene cues stay inside their scene', () => {
    const cues = perSceneCues([
      { line: 'один два три четыре пять', start: 0, end: 4 },
      { line: '', start: 4, end: 8 },
      { line: 'шесть', start: 8, end: 12 },
    ])
    expect(cues).toHaveLength(3)
    expect(cues[1]!.end).toBeLessThanOrEqual(4)
    expect(cues[2]!.start).toBeGreaterThanOrEqual(8)
  })
  it('builds ASS with escaped text', () => {
    const ass = buildAss({
      width: 1080,
      height: 1920,
      font: 'DejaVu Sans',
      captions: [{ start: 0, end: 1.5, text: 'a{b}\nc' }],
      overlays: [{ start: 0, end: 61, text: 'hook' }],
    })
    expect(ass).toContain('Dialogue: 0,0:00:00.00,0:00:01.50,Caption,,0,0,0,,ab\\Nc')
    expect(ass).toContain('0:01:01.00,Overlay')
  })
})

describe('applyScriptEdit', () => {
  async function doneRun() {
    const run = await Run.create(await mkdtemp(path.join(tmpdir(), 'ugc-test-')), {
      id: '1',
      projectId: 'p',
      brief,
      settings: { approvals: {}, models: {} },
      recordings: [],
      variant: { index: 0, total: 1, avoid: [] },
    })
    run.state.script = script()
    run.state.approvals = { script: true, keyframes: true }
    run.state.persona = 'media/persona.png'
    run.state.refs = { persona: 'p', product: [] }
    run.state.scenes = [0, 1, 2].map((i) => ({ keyframe: `k${i}`, keyframeRef: `r${i}`, clip: `c${i}` }))
    run.state.voice = 'media/voice.mp3'
    run.state.final = 'final.mp4'
    return run
  }

  it('a visual change redoes that keyframe and clip only', async () => {
    const run = await doneRun()
    const next = script()
    next.scenes[1]!.visual = 'man'
    applyScriptEdit(run, next)
    expect(run.state.scenes.map((s) => Boolean(s.keyframe))).toEqual([true, false, true])
    expect(run.state.scenes.map((s) => Boolean(s.clip))).toEqual([true, false, true])
    expect(run.state.voice).toBeDefined()
    expect(run.state.final).toBeUndefined()
    // New pictures need a fresh look before paying for video.
    expect(run.state.approvals).toEqual({ script: true })
  })

  it('a screen-recording change only re-assembles', async () => {
    const run = await doneRun()
    const next = script()
    next.scenes[1]!.screen = { recording: 0, start: 2, layout: 'full' }
    applyScriptEdit(run, next)
    expect(run.state.scenes.every((s) => s.keyframe && s.clip)).toBe(true)
    expect(run.state.final).toBeUndefined()
    expect(run.state.approvals.keyframes).toBe(true)
  })

  it('a line change redoes the clip and the voiceover, keeps the keyframe', async () => {
    const run = await doneRun()
    const next = script()
    next.scenes[2]!.line = 'новая фраза'
    applyScriptEdit(run, next)
    expect(run.state.scenes[2]).toEqual({ keyframe: 'k2', keyframeRef: 'r2' })
    expect(run.state.voice).toBeUndefined()
  })

  it('a persona change redoes every scene', async () => {
    const run = await doneRun()
    const next = script()
    next.persona.look = 'man with beard'
    applyScriptEdit(run, next)
    expect(run.state.refs.persona).toBeUndefined()
    expect(run.state.scenes.every((s) => !s.keyframe && !s.clip)).toBe(true)
  })

  it('added scenes start empty', async () => {
    const run = await doneRun()
    const next = script()
    next.scenes.push(scene({ purpose: 'extra' }))
    applyScriptEdit(run, next)
    expect(run.state.scenes).toHaveLength(4)
    expect(run.state.scenes[3]).toEqual({})
  })
})

describe('mapLimit', () => {
  it('keeps order and the concurrency cap', async () => {
    let active = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (x) => {
      peak = Math.max(peak, ++active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return x * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10])
    expect(peak).toBe(2)
  })
})

describe('applySettings', () => {
  it('overrides models, resolution and gates, keeps the rest', () => {
    const slot = (model: string, params = {}) => ({ model, params })
    const cfg = ConfigSchema.parse({
      models: {
        llm: slot('llm-a'),
        caption: slot('cap'),
        image: { ...slot('img-a'), width: 768, height: 1376 },
        video: { minDuration: 4, maxDuration: 10, draft: slot('v-draft', { resolution: '720p', x: 1 }), final: slot('v-final') },
        tts: slot('tts'),
      },
    })
    const out = applySettings(cfg, {
      language: 'ru',
      approvals: { keyframes: false },
      models: { image: 'img-b', videoDraft: 'v-cheap', draftResolution: '480p' },
    })
    expect(out.language).toBe('ru')
    expect(out.approvals).toEqual({ script: true, keyframes: false })
    expect(out.models.image).toMatchObject({ model: 'img-b', width: 768 })
    expect(out.models.video.draft).toEqual({ model: 'v-cheap', params: { resolution: '480p', x: 1 } })
    expect(out.models.video.final.model).toBe('v-final')
    expect(out.models.llm.model).toBe('llm-a')
  })
})

describe('scriptPrompt', () => {
  const base = { analysis: undefined, recordings: [], variant: { index: 1, total: 3, avoid: ['hook: "x"'] }, language: 'en', minDuration: 4, maxDuration: 10, speaking: true }

  it('pins the creator from reference photos and asks only for a new hook', () => {
    const b = BriefSchema.parse({ ...brief, personaRefs: ['/a.jpg'], personaMode: 'exact', style: { tone: 'calm and trustworthy', hookStyle: 'POV format' } })
    const p = scriptPrompt({ ...base, brief: b, personaDescription: 'blonde woman, 30s' })
    expect(p).toContain('the person from the reference photos (blonde woman, 30s)')
    expect(p).toContain('the creator stays the same person')
    expect(p).toContain('TONE: calm and trustworthy')
    expect(p).toContain('HOOK STYLE: POV format')
  })

  it('keeps verbatim text and passes picked creator traits', () => {
    const b = BriefSchema.parse({ ...brief, talkingPoints: 'Say exactly this.', talkingMode: 'verbatim', style: { creatorGender: 'male', setting: 'gym' } })
    const p = scriptPrompt({ ...base, brief: b })
    expect(p).toContain('VERBATIM')
    expect(p).toContain('Say exactly this.')
    expect(p).toContain('gender: male; filming location: gym')
  })
})
