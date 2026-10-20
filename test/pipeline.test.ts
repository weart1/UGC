import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BriefSchema, loadConfig } from '../src/config.js'
import { ffmpeg, probeDuration } from '../src/ffmpeg.js'
import { createApp } from '../src/server/app.js'
import { applyAction, continueRun, createService, newProject, runProject } from '../src/service.js'

const root = path.resolve(import.meta.dirname, '..')
const silent = () => {}

async function fixtures() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ugc-fx-'))
  const screen = path.join(dir, 'screen.mp4')
  const shot = path.join(dir, 'shot.png')
  const example = path.join(dir, 'ref.mp4')
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=360x780:d=6', '-pix_fmt', 'yuv420p', screen])
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=s=360x780', '-frames:v', '1', shot])
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=s=360x640:d=4', '-pix_fmt', 'yuv420p', example])
  return { dir, screen, shot, example }
}

describe('project flow (offline, fake generator)', () => {
  it('stops at both gates, builds a video with screen inserts, then re-renders as final', async () => {
    const cfg = await loadConfig(path.join(root, 'ugc.config.json'))
    const svc = createService(cfg, await mkdtemp(path.join(tmpdir(), 'ugc-data-')), true)
    const fx = await fixtures()
    const brief = BriefSchema.parse({
      product: { name: 'FocusFlow', description: 'habit app', type: 'app', images: [fx.shot] },
      screenRecordings: [fx.screen],
      personaRefs: [fx.shot],
      talkingPoints: 'blocks TikTok while studying',
      audience: 'students',
      targetSeconds: 20,
    })
    const settings = { approvals: {}, models: { videoDraft: 'bytedance:seedance@2.0-mini', draftResolution: '480p' } }
    const project = await newProject(svc, { name: 'FocusFlow', brief, settings, example: fx.example, variants: 2 })

    // Record what reaches the generator: the project's models and the persona references.
    const seen = { draftModels: new Set<string>(), personaRefs: [] as string[][] }
    const make = svc.newGenerator
    svc.newGenerator = async (cfg) => {
      seen.draftModels.add(`${cfg.models.video.draft.model} ${String(cfg.models.video.draft.params.resolution)}`)
      const gen = await make(cfg)
      return {
        ...gen,
        image: (req) => {
          if (req.prompt.includes('reference photos')) seen.personaRefs.push(req.refs)
          return gen.image(req)
        },
      }
    }
    await runProject(svc, project, silent)

    expect(project.state.status).toBe('ready')
    expect(project.state.analysis?.format).toBeTruthy()
    expect(project.state.recordings).toHaveLength(1)
    expect(project.state.personaDescription).toBeTruthy()
    const [run1, run2] = await Promise.all(project.state.runs.map((id) => project.openRun(id)))
    expect(run1!.state.status).toBe('awaiting_script')
    // The second variant is told what the first one used.
    expect(run2!.state.variant.avoid).toHaveLength(1)

    const run = run1!
    await applyAction(run, { type: 'approve', what: 'script' })
    expect(await continueRun(svc, run, silent)).toBe('awaiting_keyframes')
    expect(run.state.scenes.every((s) => s.keyframe && !s.clip)).toBe(true)
    expect([...seen.draftModels]).toEqual(['bytedance:seedance@2.0-mini 480p'])
    expect(seen.personaRefs).toEqual([[fx.shot]])

    await applyAction(run, { type: 'approve', what: 'keyframes' })
    expect(await continueRun(svc, run, silent)).toBe('done')
    const total = run.state.script!.scenes.reduce((a, s) => a + s.duration, 0)
    expect(await probeDuration(run.file('final.mp4'))).toBeCloseTo(total, 0)
    expect(run.state.script!.scenes.some((s) => s.screen)).toBe(true)

    const draftClip = await readFile(run.file(run.state.scenes[0]!.clip!))
    await applyAction(run, { type: 'final' })
    expect(await continueRun(svc, run, silent)).toBe('done')
    expect(run.state.quality).toBe('final')
    expect(run.state.final).toBe('final.mp4')
    expect(await readFile(run.file(run.state.scenes[0]!.clip!))).toBeDefined()
    expect(draftClip.length).toBeGreaterThan(0)
  }, 180_000)
})

describe('web panel API', () => {
  it('requires the password, creates a project from a form and serves its files', async () => {
    const cfg = await loadConfig(path.join(root, 'ugc.config.json'))
    const svc = createService(cfg, await mkdtemp(path.join(tmpdir(), 'ugc-data-')), true)
    const { app, queue } = createApp(svc, { password: 'pw' })

    expect((await app.request('/api/projects')).status).toBe(401)
    const bad = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: 'nope' }), headers: { 'content-type': 'application/json' } })
    expect(bad.status).toBe(401)
    const login = await app.request('/api/login', { method: 'POST', body: JSON.stringify({ password: 'pw' }), headers: { 'content-type': 'application/json' } })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const headers = { cookie }

    const fx = await fixtures()
    const form = new FormData()
    form.set('productName', 'Calmly')
    form.set('productDescription', 'meditation app')
    form.set('audience', 'parents')
    form.set('variants', '1')
    form.set('screenRecordings', new File([await readFile(fx.screen)], 'screen.mp4'))
    const created = await app.request('/api/projects', { method: 'POST', body: form, headers })
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }

    for (let i = 0; i < 100 && queue.busy(`project:${id}`); i++) await new Promise((r) => setTimeout(r, 100))
    const project = (await (await app.request(`/api/projects/${id}`, { headers })).json()) as {
      status: string
      runs: { id: string; status: string }[]
      recordings: unknown[]
    }
    expect(project.status).toBe('ready')
    expect(project.recordings).toHaveLength(1)
    expect(project.runs[0]?.status).toBe('awaiting_script')

    const missing = await app.request(`/api/projects/${id}/runs/1/action`, {
      method: 'POST',
      body: JSON.stringify({ type: 'approve', what: 'keyframes' }),
      headers: { ...headers, 'content-type': 'application/json' },
    })
    expect(missing.status).toBe(409)

    const script = await app.request(`/files/${id}/runs/1/script.json`, { headers })
    expect(script.status).toBe(200)
    expect((await app.request(`/files/${id}/runs/1/script.json`)).status).toBe(401)
    expect((await app.request(`/files/${id}/..%2F..%2Fetc%2Fpasswd`, { headers })).status).toBe(404)
  }, 60_000)
})
