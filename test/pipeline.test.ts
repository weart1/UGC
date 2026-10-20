import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadBrief, loadConfig } from '../src/config.js'
import { probeDuration } from '../src/ffmpeg.js'
import { createFakeGenerator } from '../src/gen/fake.js'
import { runPipeline } from '../src/pipeline.js'
import { Run } from '../src/state.js'

const root = path.resolve(import.meta.dirname, '..')

describe('pipeline (offline, fake generator)', () => {
  it('produces a vertical video with sound and resumes without regenerating', async () => {
    const cfg = await loadConfig(path.join(root, 'ugc.config.json'))
    const brief = await loadBrief(path.join(root, 'examples/serum/brief.json'))
    const run = await Run.create(await mkdtemp(path.join(tmpdir(), 'ugc-e2e-')), brief)
    const gen = await createFakeGenerator(cfg)
    const log = () => {}

    await runPipeline({ run, gen, cfg, log }, 'script')
    expect(run.state.script?.scenes.length).toBeGreaterThan(1)
    expect(run.state.scenes.every((s) => !s.keyframe)).toBe(true)

    await runPipeline({ run, gen, cfg, log })
    expect(run.state.final).toBe('final.mp4')
    const total = run.state.script!.scenes.reduce((a, s) => a + s.duration, 0)
    expect(await probeDuration(run.file('final.mp4'))).toBeCloseTo(total, 0)

    // A second pass finds everything done and touches no generator.
    const counted = { ...gen, image: () => Promise.reject(new Error('regenerated')) }
    const before = JSON.stringify((await Run.open(run.dir)).state)
    await runPipeline({ run: await Run.open(run.dir), gen: counted, cfg, log })
    expect(JSON.stringify((await Run.open(run.dir)).state)).toBe(before)
  }, 120_000)
})
