import { mkdir, writeFile } from 'node:fs/promises'
import { ffmpeg, hasAudio, probeDuration } from '../ffmpeg.js'
import { buildAss, perSceneCues, voiceoverCues, type Cue } from '../subtitles.js'
import { mapLimit } from '../state.js'
import type { Config } from '../config.js'
import type { Ctx } from './context.js'

/** Normalizes the clips, lays the voice and music under them and burns in captions. */
export async function assembleStage({ run, cfg, log }: Ctx): Promise<void> {
  const { state } = run
  if (state.final) return
  const script = state.script!
  const out = cfg.output
  log('Сборка ролика...')
  await mkdir(run.file('build'), { recursive: true })

  // Same size, fps, codec and an audio track on every part, so they concat without re-encoding.
  const keepAudio = cfg.audio === 'native'
  const parts = await mapLimit(state.scenes, cfg.concurrency, async (scene, i) => {
    const src = run.file(scene.clip!)
    const dst = `build/part-${i}.mp4`
    const screen = script.scenes[i]!.screen
    const recording = screen ? state.recordings[screen.recording] : undefined
    await renderPart({
      clip: src,
      dst,
      cwd: run.dir,
      withAudio: keepAudio && (await hasAudio(src)),
      duration: await probeDuration(src),
      screen: screen && recording ? { file: recording.file, start: screen.start % recording.duration, layout: screen.layout } : undefined,
      out,
    })
    return { file: dst, duration: await probeDuration(run.file(dst)) }
  })

  await writeFile(run.file('build/concat.txt'), parts.map((p) => `file '${p.file.replace('build/', '')}'`).join('\n'))
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', 'build/concat.txt', '-c', 'copy', 'build/video.mp4'], { cwd: run.dir })
  const videoDuration = parts.reduce((a, p) => a + p.duration, 0)

  // Scene windows on the final timeline.
  let t = 0
  const windows = parts.map((p, i) => {
    const w = { start: t, end: t + p.duration, scene: script.scenes[i]! }
    t += p.duration
    return w
  })

  const voice = cfg.audio === 'tts' && state.voice ? run.file(state.voice) : undefined
  const voiceDuration = voice ? await probeDuration(voice) : 0
  // A voiceover longer than the picture holds the last frame instead of being cut off.
  const total = Math.max(videoDuration, voice ? voiceDuration + 0.3 : 0)
  const freeze = total - videoDuration

  let captions: Cue[] = []
  if (cfg.subtitles) {
    captions = voice
      ? voiceoverCues(script.scenes.map((s) => s.line), voiceDuration)
      : perSceneCues(windows.map((w) => ({ line: w.scene.line, start: w.start, end: w.end })))
  }
  const overlays = windows
    .filter((w) => w.scene.onScreenText)
    .map((w) => ({ start: w.start, end: w.end, text: w.scene.onScreenText }))
  const hasAss = captions.length > 0 || overlays.length > 0
  if (hasAss) {
    await writeFile(
      run.file('build/subs.ass'),
      buildAss({ width: out.width, height: out.height, font: out.font, captions, overlays }),
    )
  }

  const inputs = ['-i', 'build/video.mp4']
  let next = 1
  const voiceIdx = voice ? next++ : -1
  if (voice) inputs.push('-i', voice)
  const music = state.brief.music
  const musicIdx = music ? next++ : -1
  if (music) inputs.push('-stream_loop', '-1', '-i', music)

  const vf = [freeze > 0.05 ? `tpad=stop_mode=clone:stop_duration=${freeze.toFixed(2)}` : '', hasAss ? 'ass=build/subs.ass' : '']
    .filter(Boolean)
    .join(',')
  const audioChain = [
    voice ? `[${voiceIdx}:a]aresample=48000,apad[main]` : `[0:a]apad[main]`,
    music
      ? `[${musicIdx}:a]aresample=48000,volume=${out.musicVolume}[bg];[main][bg]amix=inputs=2:duration=first:normalize=0[mix]`
      : `[main]anull[mix]`,
    `[mix]loudnorm=I=-14:TP=-1.5:LRA=11[aout]`,
  ].join(';')

  await ffmpeg(
    [
      ...inputs,
      '-filter_complex', `${vf ? `[0:v]${vf}[vout];` : '[0:v]null[vout];'}${audioChain}`,
      '-map', '[vout]', '-map', '[aout]',
      '-t', total.toFixed(2),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      'final.mp4',
    ],
    { cwd: run.dir },
  )
  state.final = 'final.mp4'
  await run.save()
  log(`Готово: ${run.file('final.mp4')} (${total.toFixed(1)} с)`)
}

/**
 * One scene, normalized to the output format. A screen recording either
 * replaces the picture (`full`, on a blurred copy of itself) or sits in a
 * framed box over the creator (`pip`); the creator's audio keeps playing.
 */
async function renderPart(opts: {
  clip: string
  dst: string
  cwd: string
  withAudio: boolean
  duration: number
  screen?: { file: string; start: number; layout: 'full' | 'pip' }
  out: Config['output']
}): Promise<void> {
  const { width: W, height: H, fps } = opts.out
  const inputs = ['-i', opts.clip]
  let next = 1
  const silenceIdx = opts.withAudio ? -1 : next++
  if (!opts.withAudio) inputs.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo')
  const recIdx = opts.screen ? next++ : -1
  // Looped, so a recording shorter than the scene never runs out.
  if (opts.screen) inputs.push('-stream_loop', '-1', '-ss', opts.screen.start.toFixed(2), '-i', opts.screen.file)

  const cover = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`
  const tail = `fps=${fps},format=yuv420p`
  let graph: string
  if (opts.screen?.layout === 'full') {
    graph =
      `[${recIdx}:v]split[ra][rb];[ra]${cover},boxblur=20:5[bg];` +
      `[rb]scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,${tail}[v]`
  } else if (opts.screen?.layout === 'pip') {
    // Box between the top overlay text (~12% down) and the captions (~70% down).
    const boxW = Math.round((W * 0.38) / 2) * 2
    const boxH = Math.round((H * 0.44) / 2) * 2
    const border = Math.round(W / 120)
    graph =
      `[0:v]${cover}[base];` +
      `[${recIdx}:v]scale=${boxW}:${boxH}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,` +
      `pad=iw+${border * 2}:ih+${border * 2}:${border}:${border}:white[pip];` +
      `[base][pip]overlay=W-w-${Math.round(W / 27)}:${Math.round(H * 0.2)},${tail}[v]`
  } else {
    graph = `[0:v]${cover},${tail}[v]`
  }

  await ffmpeg(
    [
      ...inputs,
      '-filter_complex', graph,
      '-map', '[v]', '-map', opts.withAudio ? '0:a:0' : `${silenceIdx}:a:0`,
      '-t', opts.duration.toFixed(3),
      // Intermediate file: speed over size, the final encode sets the quality.
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      opts.dst,
    ],
    { cwd: opts.cwd },
  )
}
