import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

// Extra params are merged verbatim into the Runware request, so a model whose
// schema differs from our defaults can be fixed from the config, not the code.
const Params = z.record(z.unknown()).default({})

const ModelSlot = z.object({ model: z.string(), params: Params })

export const QUALITIES = ['draft', 'final'] as const
export type Quality = (typeof QUALITIES)[number]

export const ConfigSchema = z.object({
  /** Language of the spoken lines and subtitles. Prompts to image/video models are always English. */
  language: z.string().default('en'),
  /**
   * native — the video model speaks the line itself, lip-synced.
   * tts    — one voiceover for the whole script via the TTS model, subtitles timed to it.
   * none   — silent clips, subtitles only.
   */
  audio: z.enum(['native', 'tts', 'none']).default('native'),
  subtitles: z.boolean().default(true),
  concurrency: z.number().int().min(1).max(8).default(2),
  /** Client-side schema validation in the Runware SDK: wrong params fail before you pay. */
  validateParams: z.boolean().default(true),
  /** Where a run stops and waits for a human before spending more. */
  approvals: z
    .object({ script: z.boolean().default(true), keyframes: z.boolean().default(true) })
    .default({}),
  models: z.object({
    llm: ModelSlot,
    caption: ModelSlot,
    image: ModelSlot.extend({ width: z.number().int(), height: z.number().int() }),
    /** Drafts are rendered on the cheap profile; "make final" re-renders approved runs on the expensive one. */
    video: z.object({
      minDuration: z.number().int().min(1),
      maxDuration: z.number().int().min(1),
      draft: ModelSlot,
      final: ModelSlot,
    }),
    tts: ModelSlot,
  }),
  output: z
    .object({
      width: z.number().int().default(1080),
      height: z.number().int().default(1920),
      fps: z.number().int().default(30),
      font: z.string().default('DejaVu Sans'),
      musicVolume: z.number().min(0).max(1).default(0.12),
    })
    .default({}),
})
export type Config = z.infer<typeof ConfigSchema>

export const BriefSchema = z.object({
  product: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    /** physical: photos of the product; app: screenshots of the app. */
    type: z.enum(['physical', 'app']).default('physical'),
    /** Product photos or app screenshots. Used as references so packaging / UI stays real. */
    images: z.array(z.string()).default([]),
    price: z.string().optional(),
  }),
  /** Real screen recordings of the app, cut into scenes full-screen or picture-in-picture. */
  screenRecordings: z.array(z.string()).default([]),
  offer: z.string().optional(),
  audience: z.string().min(1),
  /** What the viewer should do: install, buy, follow the link... */
  goal: z.string().default('download the app'),
  /** Desired look of the creator, free text. */
  persona: z.string().optional(),
  /** Photos of the creator: the same person in every video (`exact`) or just a similar look (`inspired`). */
  personaRefs: z.array(z.string()).default([]),
  personaMode: z.enum(['exact', 'inspired']).default('exact'),
  /**
   * What the creator talks about. `points`: key messages the LLM turns into
   * natural lines; `verbatim`: the exact text, only split into scenes.
   */
  talkingPoints: z.string().optional(),
  talkingMode: z.enum(['points', 'verbatim']).default('points'),
  /** Picked in the panel from fixed lists; values are English, ready for the prompt. Empty = let the LLM decide. */
  style: z
    .object({
      tone: z.string().optional(),
      hookStyle: z.string().optional(),
      setting: z.string().optional(),
      creatorGender: z.string().optional(),
      creatorAge: z.string().optional(),
    })
    .default({}),
  /** Format to follow when no example is given: unboxing, "3 reasons", before/after... */
  format: z.string().optional(),
  targetSeconds: z.number().int().min(5).max(90).default(25),
  /** Background music file. */
  music: z.string().optional(),
  notes: z.string().optional(),
})
export type Brief = z.infer<typeof BriefSchema>

/**
 * Per-project overrides of the config, picked in the "new project" form.
 * Model ids replace the config's; resolutions go into the video params.
 */
export const SettingsSchema = z
  .object({
    language: z.string().optional(),
    audio: z.enum(['native', 'tts', 'none']).optional(),
    subtitles: z.boolean().optional(),
    approvals: z.object({ script: z.boolean().optional(), keyframes: z.boolean().optional() }).default({}),
    models: z
      .object({
        llm: z.string().optional(),
        image: z.string().optional(),
        videoDraft: z.string().optional(),
        videoFinal: z.string().optional(),
        draftResolution: z.string().optional(),
        finalResolution: z.string().optional(),
      })
      .default({}),
  })
  .default({})
export type Settings = z.infer<typeof SettingsSchema>

export function applySettings(cfg: Config, s: Settings): Config {
  const m = s.models
  const video = (slot: Config['models']['video']['draft'], model?: string, resolution?: string) => ({
    model: model ?? slot.model,
    params: resolution ? { ...slot.params, resolution } : slot.params,
  })
  return {
    ...cfg,
    language: s.language ?? cfg.language,
    audio: s.audio ?? cfg.audio,
    subtitles: s.subtitles ?? cfg.subtitles,
    approvals: {
      script: s.approvals.script ?? cfg.approvals.script,
      keyframes: s.approvals.keyframes ?? cfg.approvals.keyframes,
    },
    models: {
      ...cfg.models,
      llm: { ...cfg.models.llm, model: m.llm ?? cfg.models.llm.model },
      image: { ...cfg.models.image, model: m.image ?? cfg.models.image.model },
      video: {
        ...cfg.models.video,
        draft: video(cfg.models.video.draft, m.videoDraft, m.draftResolution),
        final: video(cfg.models.video.final, m.videoFinal, m.finalResolution),
      },
    },
  }
}

/** Models offered in the panel. Ids come from the Runware SDK registry. */
export const MODEL_OPTIONS = {
  llm: [
    { id: 'google:gemini@3.5-flash', label: 'Gemini 3.5 Flash — быстро и дёшево' },
    { id: 'google:gemini@3.1-pro', label: 'Gemini 3.1 Pro' },
    { id: 'anthropic:claude@sonnet-4.6', label: 'Claude Sonnet 4.6' },
    { id: 'openai:gpt@5.4', label: 'GPT-5.4' },
  ],
  image: [
    { id: 'google:4@2', label: 'Nano Banana Pro — лучшее качество' },
    { id: 'google:nano-banana@2.1', label: 'Nano Banana 2.1' },
    { id: 'google:4@3', label: 'Nano Banana 2' },
    { id: 'google:nano-banana@2-lite', label: 'Nano Banana 2 Lite — дешевле' },
  ],
  video: [
    { id: 'bytedance:seedance@2.5', label: 'Seedance 2.5 — лучшее качество' },
    { id: 'bytedance:seedance@2.0', label: 'Seedance 2.0' },
    { id: 'bytedance:seedance@2.0-fast', label: 'Seedance 2.0 Fast — быстро' },
    { id: 'bytedance:seedance@2.0-mini', label: 'Seedance 2.0 Mini — дешевле всего' },
  ],
  resolutions: ['480p', '720p', '1080p'],
  languages: [
    { id: 'en', label: 'Английский' },
    { id: 'ru', label: 'Русский' },
    { id: 'es', label: 'Испанский' },
    { id: 'pt', label: 'Португальский' },
    { id: 'de', label: 'Немецкий' },
  ],
}

export async function loadConfig(file: string): Promise<Config> {
  return ConfigSchema.parse(JSON.parse(await readFile(file, 'utf8')))
}

/** Makes every file path in a brief absolute, relative to `dir`. */
export function resolveBriefPaths(brief: Brief, dir: string): Brief {
  const abs = (p: string) => path.resolve(dir, p)
  return {
    ...brief,
    product: { ...brief.product, images: brief.product.images.map(abs) },
    screenRecordings: brief.screenRecordings.map(abs),
    personaRefs: brief.personaRefs.map(abs),
    music: brief.music && abs(brief.music),
  }
}

export async function loadBrief(file: string): Promise<Brief> {
  const brief = BriefSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  return resolveBriefPaths(brief, path.dirname(path.resolve(file)))
}
