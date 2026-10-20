import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Config } from '../config.js'
import { ffmpeg } from '../ffmpeg.js'
import type { Generator } from './types.js'

const SCRIPT = {
  title: 'Test video',
  persona: {
    look: 'woman in her mid-20s, natural makeup, hair in a bun, grey t-shirt, bright living room',
    voice: 'young woman, warm friendly voice, energetic, casual, American accent',
  },
  scenes: [
    { purpose: 'hook', duration: 4, shot: 'selfie, close-up', visual: 'woman looks into camera, surprised', motion: 'leans to camera', line: "I can't believe nobody told me about this", onScreenText: 'wait for it', showsProduct: false, screen: null },
    { purpose: 'problem', duration: 5, shot: 'selfie, medium', visual: 'woman sighs on the couch', motion: 'shrugs', line: 'I used to waste an hour every evening on this', onScreenText: '', showsProduct: false, screen: null },
    { purpose: 'demo', duration: 5, shot: 'selfie, medium', visual: 'woman holds phone to camera', motion: 'taps the screen', line: 'Now I just open the app and it is done in a minute', onScreenText: '', showsProduct: true, screen: { recording: 0, start: 1, layout: 'full' } },
    { purpose: 'result', duration: 5, shot: 'selfie, close-up', visual: 'woman smiles', motion: 'points at the screen', line: 'Look at this, honestly I am obsessed', onScreenText: '', showsProduct: false, screen: { recording: 0, start: 3, layout: 'pip' } },
    { purpose: 'cta', duration: 4, shot: 'selfie, medium', visual: 'woman holds phone next to face', motion: 'points down', line: 'Link is in my bio, it is free to try', onScreenText: 'free trial', showsProduct: true, screen: null },
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
    async text(kind, prompt) {
      const variant = prompt.match(/This is variant (\d+)/)?.[1]
      const script = { ...SCRIPT, title: variant ? `${SCRIPT.title} #${variant}` : SCRIPT.title }
      return '```json\n' + JSON.stringify(kind === 'script' ? script : ANALYSIS) + '\n```'
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
    async video({ firstFrame, duration, withAudio }) {
      const out = tmp('mp4')
      await ffmpeg([
        '-loop', '1', '-i', firstFrame,
        ...(withAudio ? ['-f', 'lavfi', '-i', `sine=frequency=330:duration=${duration}`] : []),
        '-t', String(duration),
        '-vf', 'scale=720:1280,format=yuv420p',
        '-r', '24', '-c:v', 'libx264', '-preset', 'ultrafast',
        ...(withAudio ? ['-c:a', 'aac'] : []),
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
