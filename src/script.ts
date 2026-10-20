import { z } from 'zod'
import type { Generator, TextKind } from './gen/types.js'

export const AnalysisSchema = z.object({
  format: z.string(),
  hook: z.string(),
  tone: z.string(),
  pacing: z.string(),
  beats: z
    .array(
      z.object({
        purpose: z.string(),
        seconds: z.number(),
        shot: z.string(),
        description: z.string(),
      }),
    )
    .min(1),
  onScreenText: z.string().default(''),
  cta: z.string().default(''),
})
export type Analysis = z.infer<typeof AnalysisSchema>

export const SceneSchema = z.object({
  /** hook / problem / demo / result / offer / cta ... */
  purpose: z.string(),
  duration: z.number(),
  /** English: framing and camera, e.g. "selfie, arm's length, eye level". */
  shot: z.string(),
  /** English: what the first frame shows. Goes to the image model. */
  visual: z.string(),
  /** English: what happens during the clip. Goes to the video model. */
  motion: z.string(),
  /** Spoken line in the target language; may be empty for b-roll. */
  line: z.string().default(''),
  /** Short text overlay in the target language; may be empty. */
  onScreenText: z.string().default(''),
  /** Product is visible in frame (for an app: a phone showing it): its images are passed as references. */
  showsProduct: z.boolean().default(false),
  /**
   * Cut to a real screen recording of the app: `full` replaces the picture
   * while the creator keeps talking, `pip` shows it in a box over the creator.
   */
  screen: z
    .object({
      recording: z.number().int().min(0),
      start: z.number().min(0).default(0),
      layout: z.enum(['full', 'pip']).default('pip'),
    })
    .nullable()
    .default(null),
})
export type Scene = z.infer<typeof SceneSchema>

export const ScriptSchema = z.object({
  title: z.string(),
  persona: z.object({
    /** English: the creator's appearance, outfit, setting. */
    look: z.string(),
    /** English: voice description for the TTS voice designer. */
    voice: z.string(),
  }),
  scenes: z.array(SceneSchema).min(2).max(12),
})
export type Script = z.infer<typeof ScriptSchema>

/** Clamps scene durations to what the video model accepts and drops references to recordings that don't exist. */
export function normalizeScript(
  script: Script,
  opts: { minDuration: number; maxDuration: number; recordings: number },
): Script {
  return {
    ...script,
    scenes: script.scenes.map((s) => ({
      ...s,
      duration: Math.min(opts.maxDuration, Math.max(opts.minDuration, Math.round(s.duration))),
      screen: s.screen && s.screen.recording < opts.recordings ? s.screen : null,
    })),
  }
}

/** Pulls a JSON object out of an LLM answer that may wrap it in prose or code fences. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced?.[1] ?? text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('в ответе нет JSON-объекта')
  return JSON.parse(body.slice(start, end + 1))
}

/** Asks for JSON matching `schema`; on a bad answer, asks again once with the error. */
export async function askJson<T>(
  gen: Generator,
  kind: TextKind,
  prompt: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  attempts = 2,
): Promise<T> {
  let lastError = ''
  for (let i = 0; i < attempts; i++) {
    const fullPrompt = lastError
      ? `${prompt}\n\nYour previous answer was rejected: ${lastError}\nReturn only the corrected JSON object.`
      : prompt
    const answer = await gen.text(kind, fullPrompt)
    try {
      return schema.parse(extractJson(answer))
    } catch (err) {
      lastError = err instanceof z.ZodError ? JSON.stringify(err.issues.slice(0, 5)) : String(err)
    }
  }
  throw new Error(`LLM не вернул корректный JSON (${kind}): ${lastError}`)
}
