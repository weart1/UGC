import { createClient, fileToDataURI, type RunOptions } from '@runware/sdk'
import type { Config } from '../config.js'
import type { Generator } from './types.js'

type Item = Record<string, unknown>
type RunAny = (params: Item, options?: RunOptions) => Promise<Item[]>

const VIDEO_TIMEOUT_MS = 30 * 60_000

export async function createRunwareGenerator(cfg: Config): Promise<Generator> {
  const apiKey = process.env.RUNWARE_API_KEY
  if (!apiKey) throw new Error('RUNWARE_API_KEY не задан (см. .env.example)')

  const client = await createClient({
    apiKey,
    transport: 'rest',
    validate: cfg.validateParams,
    pollTimeout: VIDEO_TIMEOUT_MS,
  })
  // Model ids come from the config, so the per-model typed overloads don't apply.
  const run = client.run as unknown as RunAny
  const m = cfg.models
  let spent = 0

  async function one(base: Item, extra: Item, options?: RunOptions): Promise<Item> {
    const params = deepMerge({ includeCost: true, ...base }, extra)
    const [item] = await run(params, options)
    if (!item) throw new Error(`Runware вернул пустой ответ для ${String(params.model)}`)
    if (typeof item.cost === 'number') spent += item.cost
    return item
  }

  return {
    async text(_kind, prompt) {
      const item = await one({
        model: m.llm.model,
        messages: [{ role: 'user', content: prompt }],
        deliveryMethod: 'sync',
      }, m.llm.params)
      return String(item.text ?? '')
    },

    async caption(imagePath) {
      const item = await one({
        model: m.caption.model,
        inputs: { image: await fileToDataURI(imagePath) },
      }, m.caption.params)
      return String(item.text ?? '')
    },

    async upload(filePath) {
      const [res] = await client.mediaStorage({ operation: 'upload', media: await fileToDataURI(filePath) })
      if (!res || !('mediaUUID' in res)) throw new Error(`Не удалось загрузить ${filePath}`)
      return res.mediaUUID
    },

    async image({ prompt, refs }) {
      const item = await one({
        model: m.image.model,
        positivePrompt: prompt,
        width: m.image.width,
        height: m.image.height,
        outputFormat: 'PNG',
        ...(refs.length ? { inputs: { referenceImages: refs } } : {}),
      }, m.image.params)
      return download(item.imageURL)
    },

    async video({ prompt, firstFrame, duration, quality, withAudio }) {
      const profile = m.video[quality]
      const item = await one(
        {
          model: profile.model,
          positivePrompt: prompt,
          duration,
          outputFormat: 'MP4',
          // The aspect ratio follows the first frame, which is already 9:16.
          inputs: { frameImages: [{ image: firstFrame, frame: 'first' }] },
          settings: { audio: withAudio },
        },
        profile.params,
        { timeout: VIDEO_TIMEOUT_MS },
      )
      return download(item.videoURL)
    },

    async speech({ text, voice }) {
      const item = await one({
        model: m.tts.model,
        positivePrompt: voice,
        speech: { text, voice: 'design' },
        outputFormat: 'MP3',
      }, m.tts.params)
      return download(item.audioURL)
    },

    spentUsd: () => spent,
  }
}

/**
 * Plain objects merge key by key; anything else in `extra` (arrays included)
 * replaces the base value, and `null` removes the key (e.g. a model that takes
 * no width/height).
 */
export function deepMerge(base: Item, extra: Item): Item {
  const out: Item = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    if (value === null) {
      delete out[key]
      continue
    }
    const prev = out[key]
    out[key] = isPlainObject(prev) && isPlainObject(value) ? deepMerge(prev, value) : value
  }
  return out
}

function isPlainObject(v: unknown): v is Item {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

async function download(url: unknown): Promise<Buffer> {
  if (typeof url !== 'string') throw new Error('В ответе Runware нет URL результата')
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Скачивание ${url}: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}
