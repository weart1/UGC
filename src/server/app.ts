import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { BriefSchema, MODEL_OPTIONS, SettingsSchema, type Brief, type Settings } from '../config.js'
import { normalizeScript, ScriptSchema } from '../script.js'
import { applyAction, continueRun, newProject, runProject, type RunAction, type Service } from '../service.js'
import { saveScriptEdit } from '../stages/script.js'
import { newId, Project, STAGES, type Run, type RunState } from '../state.js'
import { createAuth } from './auth.js'
import { JobQueue } from './queue.js'

const WEB_DIR = path.resolve(import.meta.dirname, '../../web')
const MAX_VARIANTS = 10

export function createApp(svc: Service, opts: { password: string; jobs?: number }) {
  const app = new Hono()
  const auth = createAuth(opts.password, process.env.SESSION_SECRET)
  const queue = new JobQueue(opts.jobs ?? 2)
  const projectKey = (pid: string) => `project:${pid}`
  const runKey = (pid: string, rid: string) => `run:${pid}/${rid}`

  const openProject = async (pid: string) => {
    if (!/^[\w-]+$/.test(pid)) throw new HttpError(404, 'нет такого проекта')
    return Project.open(path.join(svc.projectsDir, pid)).catch(() => {
      throw new HttpError(404, 'нет такого проекта')
    })
  }
  const openRun = async (pid: string, rid: string) => {
    const project = await openProject(pid)
    if (!project.state.runs.includes(rid)) throw new HttpError(404, 'нет такого варианта')
    return { project, run: await project.openRun(rid) }
  }

  const enqueueProject = (project: Project) =>
    queue.push(projectKey(project.state.id), (log) => runProject(svc, project, log))
  const enqueueRun = (pid: string, run: Run) => queue.push(runKey(pid, run.state.id), (log) => continueRun(svc, run, log))

  app.onError((err, c) => {
    const status = err instanceof HttpError ? err.status : 500
    if (status === 500) console.error(err)
    return c.json({ error: err.message }, status)
  })

  // Unauthenticated liveness probe for Docker / uptime monitors.
  app.get('/healthz', (c) => c.json({ ok: true }))

  // --- auth ---
  app.post('/api/login', async (c) => {
    const { password } = await c.req.json<{ password?: string }>()
    if (auth.login(c, String(password ?? ''))) return c.json({ ok: true })
    await new Promise((r) => setTimeout(r, 1000)) // slows down guessing
    return c.json({ error: 'неверный пароль' }, 401)
  })
  app.post('/api/logout', (c) => {
    auth.logout(c)
    return c.json({ ok: true })
  })
  app.use('/api/*', auth.middleware)
  app.use('/files/*', auth.middleware)

  // --- projects ---
  /** Choices and defaults for the "new project" form. */
  app.get('/api/options', (c) =>
    c.json({
      ...MODEL_OPTIONS,
      defaults: {
        language: svc.cfg.language,
        audio: svc.cfg.audio,
        subtitles: svc.cfg.subtitles,
        approvals: svc.cfg.approvals,
        llm: svc.cfg.models.llm.model,
        image: svc.cfg.models.image.model,
        videoDraft: svc.cfg.models.video.draft.model,
        videoFinal: svc.cfg.models.video.final.model,
        draftResolution: svc.cfg.models.video.draft.params.resolution,
        finalResolution: svc.cfg.models.video.final.params.resolution,
      },
    }),
  )

  app.get('/api/projects', async (c) => {
    const projects = await Project.list(svc.projectsDir)
    return c.json(
      await Promise.all(
        projects.map(async (p) => ({
          ...projectSummary(p),
          busy: queue.busy(projectKey(p.state.id)),
          runs: await Promise.all(p.state.runs.map(async (id) => runSummary((await p.openRun(id)).state))),
        })),
      ),
    )
  })

  app.post('/api/projects', async (c) => {
    const form = await c.req.parseBody({ all: true })
    const field = (k: string) => {
      const v = form[k]
      return typeof v === 'string' && v.trim() ? v.trim() : undefined
    }
    const files = (k: string): File[] => {
      const v = form[k] ?? form[`${k}[]`]
      return (Array.isArray(v) ? v : [v]).filter((f): f is File => f instanceof File && f.size > 0)
    }

    const name = field('productName') ?? 'project'
    const id = newId(name)
    const uploads = path.join(svc.projectsDir, id, 'uploads')
    await mkdir(uploads, { recursive: true })
    const save = async (file: File, prefix: string) => {
      const safe = file.name.replace(/[^\w.-]+/g, '_').slice(-80) || 'file'
      const dst = path.join(uploads, `${prefix}-${safe}`)
      await writeFile(dst, Buffer.from(await file.arrayBuffer()))
      return dst
    }
    const saveAll = (list: File[], prefix: string) => Promise.all(list.map((f, i) => save(f, `${prefix}${i}`)))

    const briefInput: unknown = {
      product: {
        name,
        description: field('productDescription'),
        type: field('productType') ?? 'app',
        images: await saveAll(files('productImages'), 'product'),
        price: field('price'),
      },
      screenRecordings: await saveAll(files('screenRecordings'), 'screen'),
      offer: field('offer'),
      audience: field('audience'),
      goal: field('goal'),
      persona: field('persona'),
      personaRefs: await saveAll(files('personaRefs'), 'persona'),
      personaMode: field('personaMode'),
      talkingPoints: field('talkingPoints'),
      talkingMode: field('talkingMode'),
      style: {
        tone: field('tone'),
        hookStyle: field('hookStyle'),
        setting: field('setting'),
        creatorGender: field('creatorGender'),
        creatorAge: field('creatorAge'),
      },
      format: field('format'),
      targetSeconds: field('targetSeconds') ? Number(field('targetSeconds')) : undefined,
      music: files('music')[0] && (await save(files('music')[0]!, 'music')),
      notes: field('notes'),
    }
    const parsed = BriefSchema.safeParse(briefInput)
    if (!parsed.success) {
      throw new HttpError(400, `Бриф: ${parsed.error.issues.map((i) => `${i.path.join('.')} — ${i.message}`).join('; ')}`)
    }
    const brief: Brief = parsed.data

    const exampleFile = files('example')[0]
    const example = exampleFile ? await save(exampleFile, 'example') : field('exampleUrl')
    if (example && !exampleFile && !/^https?:\/\//.test(example)) throw new HttpError(400, 'Ссылка на пример должна начинаться с http')
    const variants = Math.min(MAX_VARIANTS, Math.max(1, Number(field('variants') ?? 1) || 1))

    const settings = parseSettings(field)
    const project = await newProject(svc, { name, brief, settings, example, variants }, id)
    enqueueProject(project)
    return c.json(projectSummary(project), 201)
  })

  app.get('/api/projects/:pid', async (c) => {
    const project = await openProject(c.req.param('pid'))
    const runs = await Promise.all(project.state.runs.map(async (id) => (await project.openRun(id)).state))
    return c.json({
      ...project.state,
      busy: queue.busy(projectKey(project.state.id)),
      log: queue.log(projectKey(project.state.id)),
      runs: runs.map(runSummary),
    })
  })

  app.post('/api/projects/:pid/retry', async (c) => {
    const project = await openProject(c.req.param('pid'))
    if (!enqueueProject(project)) throw new HttpError(409, 'проект уже в работе')
    return c.json({ ok: true })
  })

  // --- runs ---
  app.get('/api/projects/:pid/runs/:rid', async (c) => {
    const { pid, rid } = c.req.param()
    const { run } = await openRun(pid, rid)
    return c.json({ ...run.state, busy: queue.busy(runKey(pid, rid)), log: queue.log(runKey(pid, rid)), stages: STAGES })
  })

  app.put('/api/projects/:pid/runs/:rid/script', async (c) => {
    const { pid, rid } = c.req.param()
    const { run } = await openRun(pid, rid)
    if (queue.busy(runKey(pid, rid))) throw new HttpError(409, 'вариант сейчас генерируется')
    if (!run.state.script) throw new HttpError(409, 'сценария ещё нет')
    const parsed = ScriptSchema.safeParse(await c.req.json())
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    const { minDuration, maxDuration } = svc.cfg.models.video
    await saveScriptEdit(run, normalizeScript(parsed.data, { minDuration, maxDuration, recordings: run.state.recordings.length }))
    return c.json(run.state)
  })

  app.post('/api/projects/:pid/runs/:rid/action', async (c) => {
    const { pid, rid } = c.req.param()
    const { run } = await openRun(pid, rid)
    if (queue.busy(runKey(pid, rid))) throw new HttpError(409, 'вариант сейчас генерируется')
    const action = await c.req.json<RunAction>()
    if (action.type === 'redo' && !STAGES.includes(action.stage)) throw new HttpError(400, 'неизвестный этап')
    try {
      await applyAction(run, action)
    } catch (err) {
      throw new HttpError(409, err instanceof Error ? err.message : String(err))
    }
    enqueueRun(pid, run)
    return c.json({ ok: true })
  })

  // --- files & UI ---
  app.use('/files/*', async (c, next) => {
    if (decodeURIComponent(c.req.path).split('/').includes('..')) return c.notFound()
    await next()
  })
  app.get(
    '/files/:pid/*',
    serveStatic({
      root: svc.projectsDir,
      rewriteRequestPath: (p) => decodeURIComponent(p.replace(/^\/files/, '')),
    }),
  )
  app.use('/*', serveStatic({ root: WEB_DIR }))
  app.get('*', serveStatic({ path: path.join(WEB_DIR, 'index.html') }))

  /** Picks up jobs that a restart interrupted. */
  async function recover() {
    for (const project of await Project.list(svc.projectsDir)) {
      if (project.state.status === 'preparing') {
        enqueueProject(project)
        continue
      }
      for (const id of project.state.runs) {
        const run = await project.openRun(id)
        if (run.state.status === 'running' || run.state.status === 'queued') enqueueRun(project.state.id, run)
      }
    }
  }

  return { app, queue, recover }
}

export async function startServer(svc: Service, opts: { port: number; password?: string }) {
  if (!opts.password) throw new Error('Задай PANEL_PASSWORD в .env — без пароля панель не запускается')
  await mkdir(svc.projectsDir, { recursive: true })
  const { app, recover } = createApp(svc, { password: opts.password, jobs: Number(process.env.JOBS ?? 2) })
  await recover()
  serve({ fetch: app.fetch, port: opts.port, hostname: process.env.HOST ?? '0.0.0.0' })
  console.log(`Панель: http://localhost:${opts.port}`)
}

/** Form fields → per-project settings. Models are limited to the offered list. */
function parseSettings(field: (k: string) => string | undefined): Settings {
  const pick = (k: string, allowed: string[]) => {
    const v = field(k)
    if (v !== undefined && !allowed.includes(v)) throw new HttpError(400, `${k}: недопустимое значение ${v}`)
    return v
  }
  const bool = (k: string) => (field(k) === undefined ? undefined : field(k) === 'on' || field(k) === 'true')
  const ids = (list: { id: string }[]) => list.map((o) => o.id)
  return SettingsSchema.parse({
    language: pick('language', ids(MODEL_OPTIONS.languages)),
    audio: pick('audio', ['native', 'tts', 'none']),
    subtitles: bool('subtitles'),
    approvals: { script: bool('approveScript'), keyframes: bool('approveKeyframes') },
    models: {
      llm: pick('llm', ids(MODEL_OPTIONS.llm)),
      image: pick('image', ids(MODEL_OPTIONS.image)),
      videoDraft: pick('videoDraft', ids(MODEL_OPTIONS.video)),
      videoFinal: pick('videoFinal', ids(MODEL_OPTIONS.video)),
      draftResolution: pick('draftResolution', MODEL_OPTIONS.resolutions),
      finalResolution: pick('finalResolution', MODEL_OPTIONS.resolutions),
    },
  })
}

class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 409,
    message: string,
  ) {
    super(message)
  }
}

function projectSummary(p: Project) {
  const { id, name, createdAt, status, error, variants, brief, example, analysis } = p.state
  return { id, name, createdAt, status, error, variants, productType: brief.product.type, example: example?.source, format: analysis?.format }
}

function runSummary(r: RunState) {
  const thumb = r.scenes.find((s) => s.keyframe)?.keyframe ?? r.persona
  return {
    id: r.id,
    status: r.status,
    error: r.error,
    quality: r.quality,
    title: r.script?.title,
    hook: r.script?.scenes[0]?.line,
    persona: r.script?.persona.look,
    thumb: thumb && !path.isAbsolute(thumb) ? `runs/${r.id}/${thumb}` : undefined,
    final: r.final ? `runs/${r.id}/${r.final}` : undefined,
    hasClips: r.scenes.some((s) => s.clip),
    spentUsd: r.spentUsd,
  }
}
