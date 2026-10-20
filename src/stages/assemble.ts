import { mkdir, writeFile } from 'node:fs/promises'
import { ffmpeg, hasAudio, probeDuration } from '../ffmpeg.js'
import { buildAss, perSceneCues, voiceoverCues, type Cue } from '../subtitles.js'
import { mapLimit } from '../state.js'
import type { Ctx } from './context.js'

/** Normalizes the clips, lays the voice and music under them and burns in captions. */
export async function assembleStage({ run, cfg, log }: Ctx): Promise<void> {
  const { state } = run
  if (state.final) return
  const script = state.script!
  const out = cfg.output
  log('Сборка ролика...')
  await mkdir(run.file('build'), { recursive: true })

  // Same size, fps, codec and an audio track on every clip, so they concat without re-encoding.
  const keepAudio = cfg.audio === 'native'
  const parts = await mapLimit(state.scenes, cfg.concurrency, async (scene, i) => {
    const src = run.file(scene.clip!)
    const dst = `build/part-${i}.mp4`
    const withAudio = keepAudio && (await hasAudio(src))
    await ffmpeg(
      [
        '-i', src,
        ...(withAudio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']),
        '-map', '0:v:0', '-map', withAudio ? '0:a:0' : '1:a:0',
        '-vf', `scale=${out.width}:${out.height}:force_original_aspect_ratio=increase,crop=${out.width}:${out.height},setsar=1,fps=${out.fps},format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
        '-shortest',
        dst,
      ],
      { cwd: run.dir },
    )
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
