import type { Config } from '../config.js'
import type { Generator } from '../gen/types.js'
import type { Run } from '../state.js'

export interface Ctx {
  run: Run
  gen: Generator
  cfg: Config
  log: (msg: string) => void
}

export const sceneName = (i: number, ext: string) => `scene-${String(i + 1).padStart(2, '0')}.${ext}`
