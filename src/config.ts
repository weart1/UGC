import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

// Extra params are merged verbatim into the Runware request, so a model whose
// schema differs from our defaults can be fixed from the config, not the code.
const Params = z.record(z.unknown()).default({})

const ModelSlot = z.object({ model: z.string(), params: Params })

export const ConfigSchema = z.object({
  /** Language of the spoken lines and subtitles. Prompts to image/video models are always English. */
  language: z.string().default('ru'),
  /**
   * tts    — one voiceover for the whole script via the TTS model, subtitles timed to it.
   * native — the video model speaks the line itself (needs a model/params with audio enabled).
   * none   — silent clips, subtitles only.
   */
  audio: z.enum(['tts', 'native', 'none']).default('tts'),
  subtitles: z.boolean().default(true),
  concurrency: z.number().int().min(1).max(8).default(2),
  /** Client-side schema validation in the Runware SDK: wrong params fail before you pay. */
  validateParams: z.boolean().default(true),
  models: z.object({
    llm: ModelSlot,
    caption: ModelSlot,
    image: ModelSlot.extend({ width: z.number().int(), height: z.number().int() }),
    video: ModelSlot.extend({
      width: z.number().int(),
      height: z.number().int(),
      minDuration: z.number().int().min(1),
      maxDuration: z.number().int().min(1),
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
    name: z.string(),
    description: z.string(),
    /** Product photos, relative to the brief file. Used as references so the packaging stays real. */
    images: z.array(z.string()).default([]),
    price: z.string().optional(),
  }),
  offer: z.string().optional(),
  audience: z.string(),
  /** What the viewer should do: install, buy, follow the link... */
  goal: z.string().default('купить по ссылке'),
  /** Desired look of the creator, free text. */
  persona: z.string().optional(),
  /** Existing creator photo to reuse instead of generating one. */
  personaImage: z.string().optional(),
  /** Format to follow when no example is given: unboxing, "3 reasons", before/after... */
  format: z.string().optional(),
  targetSeconds: z.number().int().min(5).max(90).default(25),
  /** Background music file, relative to the brief file. */
  music: z.string().optional(),
  notes: z.string().optional(),
})
export type Brief = z.infer<typeof BriefSchema>

export async function loadConfig(file: string): Promise<Config> {
  return ConfigSchema.parse(JSON.parse(await readFile(file, 'utf8')))
}

/** Loads a brief and makes every file path in it absolute. */
export async function loadBrief(file: string): Promise<Brief> {
  const brief = BriefSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  const dir = path.dirname(path.resolve(file))
  const abs = (p: string) => path.resolve(dir, p)
  return {
    ...brief,
    product: { ...brief.product, images: brief.product.images.map(abs) },
    personaImage: brief.personaImage && abs(brief.personaImage),
    music: brief.music && abs(brief.music),
  }
}
