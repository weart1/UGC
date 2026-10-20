// UGC Studio panel: vanilla JS, hash routing, polling while jobs run.

const app = document.getElementById('app')
const POLL_MS = 3000
let pollTimer = null

const STATUS = {
  queued: 'в очереди',
  running: 'генерируется',
  paused: 'на паузе',
  awaiting_script: 'ждёт одобрения сценария',
  awaiting_keyframes: 'ждёт одобрения кадров',
  done: 'готово',
  error: 'ошибка',
  preparing: 'подготовка',
  ready: 'готов',
}
const ACTIVE = new Set(['queued', 'running', 'preparing'])

// --- helpers ---

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const badge = (status) => `<span class="badge ${esc(status)}">${esc(STATUS[status] ?? status)}</span>`

const fileUrl = (pid, rel) => `/files/${encodeURIComponent(pid)}/${rel.split('/').map(encodeURIComponent).join('/')}`

function toast(msg) {
  const el = document.getElementById('toast')
  el.textContent = msg
  el.hidden = false
  clearTimeout(toast.t)
  toast.t = setTimeout(() => (el.hidden = true), 4000)
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401 && !url.endsWith('/login')) {
    location.hash = '#/login'
    throw new Error('Нужно войти')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

function poll(fn) {
  clearInterval(pollTimer)
  pollTimer = setInterval(fn, POLL_MS)
}

// --- router ---

const routes = [
  [/^#\/login$/, loginView],
  [/^#\/new$/, newProjectView],
  [/^#\/p\/([^/]+)$/, projectView],
  [/^#\/r\/([^/]+)\/([^/]+)$/, runView],
  [/^#?\/?$/, projectsView],
]

async function route() {
  clearInterval(pollTimer)
  const hash = location.hash || '#/'
  for (const [re, view] of routes) {
    const m = hash.match(re)
    if (m) {
      try {
        await view(...m.slice(1).map(decodeURIComponent))
      } catch (err) {
        app.innerHTML = `<div class="error-box">${esc(err.message)}</div>`
      }
      return
    }
  }
  location.hash = '#/'
}
window.addEventListener('hashchange', route)
document.getElementById('logout').onclick = async () => {
  await api('POST', '/api/logout')
  location.hash = '#/login'
}

// --- login ---

function loginView() {
  app.innerHTML = `
    <form class="card login" id="login">
      <h1>UGC Studio</h1>
      <p class="muted">Введите пароль панели</p>
      <label><input type="password" name="password" autofocus required></label>
      <p><button class="btn primary">Войти</button></p>
    </form>`
  document.getElementById('login').onsubmit = async (e) => {
    e.preventDefault()
    try {
      await api('POST', '/api/login', { password: e.target.password.value })
      location.hash = '#/'
    } catch (err) {
      toast(err.message)
    }
  }
}

// --- projects list ---

async function projectsView() {
  const render = async () => {
    const projects = await api('GET', '/api/projects')
    if (!projects.length) {
      app.innerHTML = `<div class="card"><h2>Проектов пока нет</h2><p class="muted">Создай проект: бриф продукта + ролик-пример → агент сделает пачку вариаций.</p><a class="btn primary" href="#/new">+ Новый проект</a></div>`
      return false
    }
    app.innerHTML = `<h1>Проекты</h1><p class="muted">Один проект = один пример и бриф, внутри несколько вариантов ролика.</p>` +
      projects
        .map(
          (p) => `
      <a class="card project" href="#/p/${encodeURIComponent(p.id)}" style="color:inherit">
        <div class="thumbs">${p.runs.slice(0, 5).map((r) => `<div class="thumb" style="${r.thumb ? `background-image:url('${fileUrl(p.id, r.thumb)}')` : ''}"></div>`).join('')}</div>
        <div style="flex:1">
          <div class="spread"><strong>${esc(p.name)}</strong>${badge(p.status)}</div>
          <div class="muted small">${new Date(p.createdAt).toLocaleString()} · ${p.variants} вар. · ${p.productType === 'app' ? 'приложение' : 'товар'}${p.format ? ` · формат: ${esc(p.format)}` : ''}</div>
          <div class="row small" style="margin-top:6px">${p.runs.map((r) => `${r.id}: ${badge(r.status)}`).join(' ')}</div>
        </div>
      </a>`,
        )
        .join('')
    return projects.some((p) => p.busy || ACTIVE.has(p.status) || p.runs.some((r) => ACTIVE.has(r.status)))
  }
  if (await render()) poll(async () => (await render()) || clearInterval(pollTimer))
}

// --- new project ---

function newProjectView() {
  app.innerHTML = `
  <h1>Новый проект</h1>
  <p class="muted">Агент разберёт пример, напишет сценарии для каждой вариации и остановится, чтобы ты их одобрил.</p>
  <form id="np">
    <div class="card"><h2>Пример</h2>
      <div class="form-grid">
        <label>Ссылка (TikTok / Reels / Shorts / YouTube)<input name="exampleUrl" placeholder="https://www.tiktok.com/@.../video/..."></label>
        <label>…или файл ролика<input type="file" name="example" accept="video/*,.txt"></label>
        <label>Сколько вариаций<input type="number" name="variants" min="1" max="10" value="3"></label>
        <label>Длина, сек<input type="number" name="targetSeconds" min="5" max="90" value="25"></label>
      </div>
      <p class="hint">Без примера сценарий строится по формату из поля «Формат» ниже.</p>
    </div>

    <div class="card"><h2>Продукт</h2>
      <div class="form-grid">
        <div class="field full">Тип
          <div class="radio-row">
            <label><input type="radio" name="productType" value="app" checked> Приложение / сервис</label>
            <label><input type="radio" name="productType" value="physical"> Физический товар</label>
          </div>
        </div>
        <label>Название*<input name="productName" required></label>
        <label>Цена<input name="price" placeholder="Free / $9.99 per month"></label>
        <label class="full">Описание* — что делает, ключевые фичи, чем лучше<textarea name="productDescription" required rows="3"></textarea></label>
        <label>Скриншоты приложения / фото товара<input type="file" name="productImages" accept="image/*" multiple>
          <span class="hint">Для кадров «телефон в руке» с твоим интерфейсом</span></label>
        <label>Записи экрана<input type="file" name="screenRecordings" accept="video/*" multiple>
          <span class="hint">Вставляются в ролик на весь экран или окном поверх креатора</span></label>
      </div>
    </div>

    <div class="card"><h2>Аудитория и подача</h2>
      <div class="form-grid">
        <label class="full">Аудитория*<textarea name="audience" required rows="2" placeholder="Women 25-40 in the US who..."></textarea></label>
        <label>Оффер<input name="offer" placeholder="7-day free trial"></label>
        <label>Целевое действие<input name="goal" placeholder="download the app"></label>
        <label>Креатор (внешность)<input name="persona" placeholder="mom in her 30s, cozy kitchen"></label>
        <label>Фото креатора (если своё)<input type="file" name="personaImage" accept="image/*"></label>
        <label>Формат (если нет примера)<input name="format" placeholder="honest review / 3 reasons / POV"></label>
        <label>Музыка<input type="file" name="music" accept="audio/*"></label>
        <label class="full">Заметки<textarea name="notes" rows="2" placeholder="No medical claims. Casual tone."></textarea></label>
      </div>
    </div>
    <div class="progress" id="up" hidden><div></div></div>
    <p><button class="btn primary" id="submit">Создать и запустить</button></p>
  </form>`

  document.getElementById('np').onsubmit = (e) => {
    e.preventDefault()
    const btn = document.getElementById('submit')
    const bar = document.getElementById('up')
    btn.disabled = true
    bar.hidden = false
    // XHR rather than fetch: upload progress matters for screen recordings.
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/projects')
    xhr.upload.onprogress = (ev) => ev.lengthComputable && (bar.firstElementChild.style.width = `${(ev.loaded / ev.total) * 100}%`)
    xhr.onload = () => {
      const data = JSON.parse(xhr.responseText || '{}')
      if (xhr.status === 201) location.hash = `#/p/${encodeURIComponent(data.id)}`
      else {
        toast(data.error ?? `HTTP ${xhr.status}`)
        btn.disabled = false
        bar.hidden = true
      }
    }
    xhr.onerror = () => {
      toast('Сеть недоступна')
      btn.disabled = false
    }
    xhr.send(new FormData(e.target))
  }
}

// --- project ---

async function projectView(pid) {
  const render = async () => {
    const p = await api('GET', `/api/projects/${encodeURIComponent(pid)}`)
    const a = p.analysis
    const counts = (s) => p.runs.filter((r) => r.status === s).length
    app.innerHTML = `
      <div class="spread"><div><a href="#/" class="small">← Проекты</a><h1>${esc(p.name)}</h1>
        <div class="muted small">${new Date(p.createdAt).toLocaleString()} · ${p.variants} вар. ${p.example ? `· пример: ${esc(p.example.source.split('/').pop())}` : ''}</div></div>
        <div class="row">${badge(p.status)}</div></div>
      ${p.error ? `<div class="error-box">${esc(p.error)}</div><p><button class="btn" data-retry>Повторить</button></p>` : ''}
      <div class="row" style="margin:14px 0">
        ${counts('awaiting_script') ? `<button class="btn primary" data-bulk="script">Одобрить сценарии (${counts('awaiting_script')})</button>` : ''}
        ${counts('awaiting_keyframes') ? `<button class="btn primary" data-bulk="keyframes">Одобрить кадры (${counts('awaiting_keyframes')})</button>` : ''}
        ${p.runs.some((r) => r.status === 'done' && r.quality === 'draft') ? `<button class="btn" data-bulk="final">Финал для всех готовых черновиков</button>` : ''}
      </div>
      <div class="grid wide">${p.runs.map((r) => variantCard(pid, r)).join('') || '<p class="muted">Варианты появятся после разбора примера…</p>'}</div>
      ${a ? `<div class="card" style="margin-top:16px"><h2>Разбор примера</h2>
        <p><b>Формат:</b> ${esc(a.format)}<br><b>Хук:</b> ${esc(a.hook)}<br><b>Тон:</b> ${esc(a.tone)}<br><b>Темп:</b> ${esc(a.pacing)}<br><b>CTA:</b> ${esc(a.cta)}</p>
        <ol class="beats">${a.beats.map((b) => `<li><b>${esc(b.purpose)}</b> (${b.seconds}с, ${esc(b.shot)}) — ${esc(b.description)}</li>`).join('')}</ol></div>` : ''}
      ${p.log.length ? `<div class="card"><h2>Журнал подготовки</h2><div class="log">${esc(p.log.join('\n'))}</div></div>` : ''}`

    app.querySelector('[data-retry]')?.addEventListener('click', async () => {
      await api('POST', `/api/projects/${encodeURIComponent(pid)}/retry`).catch((e) => toast(e.message))
      render()
    })
    app.querySelectorAll('[data-bulk]').forEach((b) =>
      b.addEventListener('click', async () => {
        const kind = b.dataset.bulk
        b.disabled = true
        const targets = p.runs.filter((r) =>
          kind === 'final' ? r.status === 'done' && r.quality === 'draft' : r.status === `awaiting_${kind}`,
        )
        const action = kind === 'final' ? { type: 'final' } : { type: 'approve', what: kind }
        for (const r of targets) {
          await api('POST', `/api/projects/${encodeURIComponent(pid)}/runs/${r.id}/action`, action).catch((e) => toast(e.message))
        }
        render()
      }),
    )
    return p.busy || p.status === 'preparing' || p.runs.some((r) => ACTIVE.has(r.status))
  }
  await render()
  poll(render)
}

function variantCard(pid, r) {
  const media = r.final
    ? `<video class="media" src="${fileUrl(pid, r.final)}" controls preload="metadata" playsinline></video>`
    : r.thumb
      ? `<div class="media" style="background-image:url('${fileUrl(pid, r.thumb)}')"></div>`
      : `<div class="placeholder">${esc(r.title ?? 'ещё нет кадров')}</div>`
  return `<div class="card variant">
    ${media}
    <div class="spread"><strong>Вариант ${esc(r.id)}</strong>${badge(r.status)}</div>
    ${r.hook ? `<div class="small">«${esc(r.hook)}»</div>` : ''}
    ${r.persona ? `<div class="muted small">${esc(r.persona)}</div>` : ''}
    <div class="spread small muted"><span>${r.quality === 'final' ? 'финал' : 'черновик'} · $${(r.spentUsd ?? 0).toFixed(2)}</span>
    <a href="#/r/${encodeURIComponent(pid)}/${encodeURIComponent(r.id)}">Открыть →</a></div>
  </div>`
}

// --- run ---

async function runView(pid, rid) {
  const base = `/api/projects/${encodeURIComponent(pid)}/runs/${encodeURIComponent(rid)}`
  let state = await api('GET', base)
  let dirty = false
  let mediaSig = ''

  app.innerHTML = `
    <a href="#/p/${encodeURIComponent(pid)}" class="small">← К проекту</a>
    <div id="head"></div>
    <div id="final"></div>
    <div id="frames"></div>
    <div id="clips"></div>
    <div class="card"><div class="spread"><h2>Сценарий</h2><div class="row" id="script-actions"></div></div><div id="script"></div></div>
    <div id="log"></div>`

  const act = async (action, confirmText) => {
    if (confirmText && !confirm(confirmText)) return
    try {
      await api('POST', `${base}/action`, action)
      await refresh()
    } catch (err) {
      toast(err.message)
    }
  }

  const renderHead = () => {
    const s = state
    document.getElementById('head').innerHTML = `
      <div class="spread"><div><h1>Вариант ${esc(s.id)}${s.script ? ` — ${esc(s.script.title)}` : ''}</h1>
      <div class="muted small">${s.quality === 'final' ? 'финальное качество' : 'черновик'} · потрачено $${s.spentUsd.toFixed(3)}</div></div>
      <div class="row">${badge(s.status)}${s.busy ? '<span class="badge running">в работе</span>' : ''}</div></div>
      ${s.error ? `<div class="error-box">${esc(s.error)}</div><p><button class="btn" data-act="resume">Продолжить с места ошибки</button></p>` : ''}
      ${s.status === 'paused' ? `<p><button class="btn primary" data-act="resume">Продолжить</button></p>` : ''}`
    document.querySelector('[data-act=resume]')?.addEventListener('click', () => act({ type: 'resume' }))
  }

  const renderFinal = () => {
    const s = state
    const el = document.getElementById('final')
    if (!s.final) return (el.innerHTML = '')
    el.innerHTML = `<div class="card"><div class="spread"><h2>Готовый ролик</h2><div class="row">
        <a class="btn" href="${fileUrl(pid, `runs/${rid}/${s.final}`)}" download="ugc-${esc(pid)}-${esc(rid)}.mp4">Скачать</a>
        ${s.quality === 'draft' ? `<button class="btn primary" id="mkfinal">Сделать финал</button>` : ''}
      </div></div>
      <video class="media" style="max-width:340px" src="${fileUrl(pid, `runs/${rid}/${s.final}`)}?v=${encodeURIComponent(s.spentUsd)}" controls playsinline></video>
      ${s.quality === 'draft' ? '<p class="hint">Черновик сделан на быстрой модели. «Сделать финал» перегенерирует клипы на финальной модели с теми же кадрами и сценарием.</p>' : ''}</div>`
    document.getElementById('mkfinal')?.addEventListener('click', () =>
      act({ type: 'final' }, 'Перегенерировать все клипы на финальной модели? Это самый дорогой шаг.'),
    )
  }

  const renderScript = () => {
    const s = state
    const el = document.getElementById('script')
    const actions = document.getElementById('script-actions')
    if (!s.script) {
      el.innerHTML = `<p class="muted">Сценарий ещё пишется…</p>`
      actions.innerHTML = ''
      return
    }
    const recOptions = (sel) =>
      `<option value="">нет</option>` +
      s.recordings.map((r, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>запись ${i + 1} (${r.duration.toFixed(0)}с)</option>`).join('')
    el.innerHTML = `
      <div class="form-grid" style="margin-bottom:12px">
        <label>Креатор (внешность, EN)<textarea data-p="look">${esc(s.script.persona.look)}</textarea></label>
        <label>Голос (EN)<textarea data-p="voice">${esc(s.script.persona.voice)}</textarea></label>
      </div>
      ${s.script.scenes
        .map(
          (sc, i) => `
        <div class="scene" data-i="${i}">
          <div><div class="num">${i + 1}</div><div class="small muted">${esc(sc.purpose)}</div></div>
          <div class="fields">
            <label class="full">Реплика<textarea data-f="line" rows="2">${esc(sc.line)}</textarea></label>
            <label>Текст на экране<input data-f="onScreenText" value="${esc(sc.onScreenText)}"></label>
            <label>Длительность, с<input type="number" data-f="duration" value="${sc.duration}" min="1" max="15"></label>
            <label>Кадр (EN)<textarea data-f="visual">${esc(sc.visual)}</textarea></label>
            <label>Движение (EN)<textarea data-f="motion">${esc(sc.motion)}</textarea></label>
            <label>Камера (EN)<input data-f="shot" value="${esc(sc.shot)}"></label>
            <label class="check"><input type="checkbox" data-f="showsProduct" ${sc.showsProduct ? 'checked' : ''}> продукт в кадре</label>
            ${s.recordings.length ? `<div class="field">Запись экрана<div class="row">
              <select data-f="screen.recording" style="width:auto">${recOptions(sc.screen?.recording)}</select>
              <select data-f="screen.layout" style="width:auto"><option value="full" ${sc.screen?.layout === 'full' ? 'selected' : ''}>на весь экран</option><option value="pip" ${sc.screen?.layout !== 'full' ? 'selected' : ''}>окном</option></select>
              <input type="number" data-f="screen.start" value="${sc.screen?.start ?? 0}" min="0" step="0.5" style="width:80px" title="с какой секунды записи">
            </div></div>` : ''}
          </div>
        </div>`,
        )
        .join('')}`
    el.oninput = () => {
      dirty = true
      renderScriptActions()
    }
    renderScriptActions()
  }

  const collectScript = () => {
    const s = structuredClone(state.script)
    const el = document.getElementById('script')
    s.persona.look = el.querySelector('[data-p=look]').value
    s.persona.voice = el.querySelector('[data-p=voice]').value
    el.querySelectorAll('.scene').forEach((node) => {
      const sc = s.scenes[Number(node.dataset.i)]
      const f = (k) => node.querySelector(`[data-f="${k}"]`)
      sc.line = f('line').value
      sc.onScreenText = f('onScreenText').value
      sc.duration = Number(f('duration').value)
      sc.visual = f('visual').value
      sc.motion = f('motion').value
      sc.shot = f('shot').value
      sc.showsProduct = f('showsProduct').checked
      if (f('screen.recording')) {
        const rec = f('screen.recording').value
        sc.screen = rec === '' ? null : { recording: Number(rec), layout: f('screen.layout').value, start: Number(f('screen.start').value) || 0 }
      }
    })
    return s
  }

  const saveScript = async () => {
    try {
      state = { ...state, ...(await api('PUT', `${base}/script`, collectScript())) }
      dirty = false
      toast('Сценарий сохранён: затронутые сцены перегенерируются')
      renderAll(true)
      return true
    } catch (err) {
      toast(err.message)
      return false
    }
  }

  const renderScriptActions = () => {
    const s = state
    const el = document.getElementById('script-actions')
    if (!s.script || s.busy) return (el.innerHTML = s.busy ? '<span class="muted small">идёт генерация…</span>' : '')
    el.innerHTML = `
      ${dirty ? '<button class="btn" id="save-script">Сохранить</button>' : ''}
      ${s.status === 'awaiting_script' ? '<button class="btn primary" id="approve-script">Одобрить сценарий →</button>' : ''}
      ${!dirty && s.status !== 'awaiting_script' ? '<button class="btn small" id="new-script">Новый сценарий</button>' : ''}
      ${dirty && s.status !== 'awaiting_script' ? '<button class="btn primary" id="save-run">Сохранить и перегенерировать</button>' : ''}`
    document.getElementById('save-script')?.addEventListener('click', saveScript)
    document.getElementById('approve-script')?.addEventListener('click', async () => {
      if (dirty && !(await saveScript())) return
      act({ type: 'approve', what: 'script' })
    })
    document.getElementById('new-script')?.addEventListener('click', () =>
      act({ type: 'redo', stage: 'script' }, 'Написать сценарий заново? Кадры и клипы этого варианта будут сделаны заново.'),
    )
    document.getElementById('save-run')?.addEventListener('click', async () => {
      if (await saveScript()) act({ type: 'resume' })
    })
  }

  const renderFrames = () => {
    const s = state
    const el = document.getElementById('frames')
    if (!s.script || (!s.persona && !s.scenes.some((x) => x.keyframe))) return (el.innerHTML = '')
    const personaSrc = s.persona && !s.persona.startsWith('/') ? fileUrl(pid, `runs/${rid}/${s.persona}`) : null
    el.innerHTML = `<div class="card"><div class="spread"><h2>Кадры</h2><div class="row">
      ${s.status === 'awaiting_keyframes' && !s.busy ? '<button class="btn primary" id="approve-frames">Одобрить кадры → видео</button>' : ''}
      </div></div>
      <div class="grid">
        <div class="variant">${personaSrc ? `<img class="media" src="${personaSrc}?v=${encodeURIComponent(s.refs.persona ?? '')}">` : '<div class="placeholder">персонаж</div>'}
          <div class="spread small"><b>Персонаж</b>${!s.busy && !s.brief.personaImage ? '<button class="btn small" data-redo-persona>Другой</button>' : ''}</div></div>
        ${s.scenes
          .map(
            (sc, i) => `<div class="variant">
            ${sc.keyframe ? `<img class="media" src="${fileUrl(pid, `runs/${rid}/${sc.keyframe}`)}?v=${encodeURIComponent(sc.keyframeRef ?? '')}">` : '<div class="placeholder">генерируется…</div>'}
            <div class="spread small"><b>Сцена ${i + 1}</b>${sc.keyframe && !s.busy ? `<button class="btn small" data-redo-frame="${i}">Заново</button>` : ''}</div></div>`,
          )
          .join('')}
      </div></div>`
    document.getElementById('approve-frames')?.addEventListener('click', () =>
      act({ type: 'approve', what: 'keyframes' }, 'Запустить генерацию видео по этим кадрам?'),
    )
    el.querySelector('[data-redo-persona]')?.addEventListener('click', () =>
      act({ type: 'redo', stage: 'persona' }, 'Новый персонаж — все кадры будут сделаны заново. Продолжить?'),
    )
    el.querySelectorAll('[data-redo-frame]').forEach((b) =>
      b.addEventListener('click', () => act({ type: 'redo', stage: 'keyframes', scene: Number(b.dataset.redoFrame) })),
    )
  }

  const renderClips = () => {
    const s = state
    const el = document.getElementById('clips')
    if (!s.scenes.some((x) => x.clip)) return (el.innerHTML = '')
    el.innerHTML = `<div class="card"><h2>Клипы</h2><div class="grid">
      ${s.scenes
        .map(
          (sc, i) => `<div class="variant">
          ${sc.clip ? `<video class="media" src="${fileUrl(pid, `runs/${rid}/${sc.clip}`)}?v=${encodeURIComponent(s.spentUsd)}" controls preload="metadata" playsinline></video>` : '<div class="placeholder">генерируется…</div>'}
          <div class="spread small"><b>Сцена ${i + 1}</b>${sc.clip && !s.busy ? `<button class="btn small" data-redo-clip="${i}">Заново</button>` : ''}</div></div>`,
        )
        .join('')}</div></div>`
    el.querySelectorAll('[data-redo-clip]').forEach((b) =>
      b.addEventListener('click', () => act({ type: 'redo', stage: 'clips', scene: Number(b.dataset.redoClip) })),
    )
  }

  const renderLog = () => {
    document.getElementById('log').innerHTML = state.log.length
      ? `<div class="card"><h2>Журнал</h2><div class="log">${esc(state.log.join('\n'))}</div></div>`
      : ''
  }

  // Media and the editor re-render only when something actually changed, so
  // playing videos and unsaved edits survive polling.
  const renderAll = (force = false) => {
    renderHead()
    renderLog()
    const sig = JSON.stringify([state.status, state.busy, state.quality, state.final, state.persona, state.refs, state.scenes, state.spentUsd])
    if (force || sig !== mediaSig) {
      mediaSig = sig
      renderFinal()
      renderFrames()
      renderClips()
      if (!dirty) renderScript()
      else renderScriptActions()
    }
  }

  const refresh = async () => {
    state = await api('GET', base)
    renderAll()
  }

  renderAll(true)
  poll(refresh)
}

route()
