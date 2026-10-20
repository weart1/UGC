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
  /** Existing creator photo to reuse instead of generating one. */
  personaImage: z.string().optional(),
  /** Format to follow when no example is given: unboxing, "3 reasons", before/after... */
  format: z.string().optional(),
  targetSeconds: z.number().int().min(5).max(90).default(25),
  /** Background music file. */
  music: z.string().optional(),
  notes: z.string().optional(),
})
export type Brief = z.infer<typeof BriefSchema>

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
    personaImage: brief.personaImage && abs(brief.personaImage),
    music: brief.music && abs(brief.music),
  }
}

export async function loadBrief(file: string): Promise<Brief> {
  const brief = BriefSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  return resolveBriefPaths(brief, path.dirname(path.resolve(file)))
}
