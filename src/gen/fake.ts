import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Config } from '../config.js'
import { ffmpeg } from '../ffmpeg.js'
import type { Generator } from './types.js'

const SCRIPT = {
  title: 'Тестовый ролик',
  persona: {
    look: 'woman in her mid-20s, natural makeup, hair in a bun, grey t-shirt, bright bathroom',
    voice: 'young woman, warm friendly voice, energetic, casual',
  },
  scenes: [
    { purpose: 'hook', duration: 4, shot: 'selfie, close-up', visual: 'woman looks into camera, surprised', motion: 'leans to camera', line: 'Я три недели молчала, но теперь скажу', onScreenText: 'честный отзыв', showsProduct: false },
    { purpose: 'problem', duration: 5, shot: 'selfie, medium', visual: 'woman touches her cheek', motion: 'turns face to light', line: 'Кожа была тусклая, никакой тональник не спасал', onScreenText: '', showsProduct: false },
    { purpose: 'demo', duration: 5, shot: 'close-up of hands', visual: 'hands hold orange serum bottle', motion: 'drops serum on fingers', line: 'Утром три капли, и всё, больше ничего', onScreenText: '', showsProduct: true },
    { purpose: 'result', duration: 5, shot: 'selfie, close-up', visual: 'woman smiles, glowing skin', motion: 'turns head slowly', line: 'Смотрите, какой тон, я просто в шоке', onScreenText: '', showsProduct: false },
    { purpose: 'cta', duration: 4, shot: 'selfie, medium', visual: 'woman holds bottle next to face', motion: 'points down', line: 'Ссылка в профиле, по промокоду минус тридцать', onScreenText: '−30% GLOW30', showsProduct: true },
  ],
}

const ANALYSIS = {
  format: 'honest review',
  hook: 'confession in the first second',
  tone: 'casual, excited',
  pacing: 'cuts every 3-5 s',
  beats: [{ purpose: 'hook', seconds: 3, shot: 'selfie', description: 'confession' }],
  onScreenText: 'short caption on hook',
  cta: 'link in profile',
}

/**
 * Offline stand-in for Runware: canned JSON and placeholder media made with
 * ffmpeg. Lets the whole pipeline run (and be tested) without an API key or spend.
 */
export async function createFakeGenerator(cfg: Config): Promise<Generator> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ugc-fake-'))
  let n = 0
  const tmp = (ext: string) => path.join(dir, `${n++}.${ext}`)
  const color = (s: string) => `0x${createHash('md5').update(s).digest('hex').slice(0, 6)}`

  return {
    async text(kind) {
      return '```json\n' + JSON.stringify(kind === 'script' ? SCRIPT : ANALYSIS) + '\n```'
    },
    async caption() {
      return 'a person talking to a phone camera in a bathroom'
    },
    async upload(filePath) {
      return path.resolve(filePath)
    },
    async image({ prompt }) {
      const out = tmp('png')
      const { width, height } = cfg.models.image
      await ffmpeg(['-f', 'lavfi', '-i', `color=c=${color(prompt)}:s=${width}x${height}`, '-frames:v', '1', out])
      return readFile(out)
    },
    async video({ firstFrame, duration }) {
      const out = tmp('mp4')
      const { width, height } = cfg.models.video
      await ffmpeg([
        '-loop', '1', '-i', firstFrame,
        '-t', String(duration),
        '-vf', `scale=${width}:${height},format=yuv420p`,
        '-r', '24', '-c:v', 'libx264', '-preset', 'ultrafast',
        out,
      ])
      return readFile(out)
    },
    async speech({ text }) {
      const out = tmp('mp3')
      const seconds = Math.max(1, text.length / 15)
      await ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=220:duration=${seconds.toFixed(2)}`, '-ac', '1', out])
      return readFile(out)
    },
    spentUsd: () => 0,
  }
}
