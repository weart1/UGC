// UGC Studio panel: vanilla JS, hash routing, polling while jobs run.

const app = document.getElementById('app')
const bar = document.getElementById('actionbar')
const POLL_MS = 3000
let pollTimer = null

// ---------- icons ----------

const PATHS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  back: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  upload: '<path d="M12 21V9M7 14l5-5 5 5M5 3h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 7.5h4M3 12h18M3 16.5h4M17 7.5h4M17 16.5h4"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
}
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name]}</svg>`

// ---------- helpers ----------

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const fileUrl = (pid, rel) => `/files/${encodeURIComponent(pid)}/${rel.split('/').map(encodeURIComponent).join('/')}`
const runUrl = (pid, rid, rel) => fileUrl(pid, `runs/${rid}/${rel}`)

const STATUS = {
  queued: ['В очереди', 'work'],
  running: ['Генерируется', 'work'],
  preparing: ['Готовим сценарии', 'work'],
  paused: ['На паузе', 'wait'],
  awaiting_script: ['Проверь сценарий', 'wait'],
  awaiting_keyframes: ['Проверь кадры', 'wait'],
  done: ['Готово', 'ok'],
  ready: ['Готов', 'ok'],
  error: ['Ошибка', 'err'],
}
const statusTone = (s) => STATUS[s]?.[1] ?? ''
const statusPill = (s) => `<span class="status ${statusTone(s)}">${esc(STATUS[s]?.[0] ?? s)}</span>`
const ACTIVE = new Set(['queued', 'running', 'preparing'])

/** Where a variant is on the road script → frames → video → done. */
function stageOf(r) {
  if (r.final || r.status === 'done') return 3
  if (r.status === 'awaiting_script' || !r.title) return 0
  if (r.status === 'awaiting_keyframes') return 1
  return r.hasClips ? 2 : 1
}

function toast(msg) {
  const el = document.getElementById('toast')
  el.textContent = msg
  el.hidden = false
  clearTimeout(toast.t)
  toast.t = setTimeout(() => (el.hidden = true), 3500)
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
  if (!res.ok) throw new Error(data.error ?? `Ошибка ${res.status}`)
  return data
}

function poll(fn) {
  clearInterval(pollTimer)
  pollTimer = setInterval(() => fn().catch(() => {}), POLL_MS)
}

function setBar(html, narrow = false) {
  bar.innerHTML = html ? `<div class="actionbar ${narrow ? 'narrow' : ''}"><div>${html}</div></div>` : ''
}

const timeAgo = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'только что'
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`
  return new Date(iso).toLocaleDateString('ru', { day: 'numeric', month: 'short' })
}
const plural = (n, one, few, many) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many}`

// ---------- router ----------

const routes = [
  [/^#\/login$/, loginView],
  [/^#\/new$/, newProjectView],
  [/^#\/p\/([^/]+)$/, projectView],
  [/^#\/r\/([^/]+)\/([^/]+)$/, runView],
  [/^#?\/?$/, homeView],
]

async function route() {
  clearInterval(pollTimer)
  setBar('')
  window.scrollTo(0, 0)
  const hash = location.hash || '#/'
  document.getElementById('topbar').hidden = hash === '#/login'
  document.getElementById('nav-new').hidden = hash === '#/new'
  for (const [re, view] of routes) {
    const m = hash.match(re)
    if (!m) continue
    try {
      await view(...m.slice(1).map(decodeURIComponent))
    } catch (err) {
      if (location.hash !== '#/login') app.innerHTML = `<div class="callout err">${icon('alert')}<div class="grow">${esc(err.message)}</div><a class="btn sm" href="#/">На главную</a></div>`
    }
    return
  }
  location.hash = '#/'
}
window.addEventListener('hashchange', route)
document.getElementById('logout').onclick = async () => {
  await api('POST', '/api/logout')
  location.hash = '#/login'
}

// ---------- login ----------

function loginView() {
  app.innerHTML = `
    <form class="login" id="login">
      <span class="brand-mark">${icon('play')}</span>
      <div><h1>UGC Studio</h1><p class="muted" style="margin-top:6px">Введите пароль, чтобы продолжить</p></div>
      <input type="password" name="password" placeholder="Пароль" autofocus required autocomplete="current-password">
      <button class="btn primary lg">Войти</button>
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

// ---------- home ----------

async function homeView() {
  const render = async () => {
    const projects = await api('GET', '/api/projects')
    if (!projects.length) {
      app.innerHTML = `
        <div class="empty-state">
          <div class="art">${icon('film')}</div>
          <h2>Сделаем первый ролик</h2>
          <p>Загрузи ролик-пример и опиши продукт — агент напишет сценарии, сгенерирует креатора, кадры и видео. Ты только одобряешь.</p>
          <a class="btn primary lg" href="#/new">${icon('plus')} Новый проект</a>
        </div>`
      return false
    }

    const todo = projects.flatMap((p) =>
      p.runs
        .filter((r) => r.status === 'awaiting_script' || r.status === 'awaiting_keyframes' || r.status === 'error')
        .map((r) => ({ p, r })),
    )
    const action = (r) =>
      r.status === 'awaiting_script' ? 'Проверить сценарий' : r.status === 'awaiting_keyframes' ? 'Проверить кадры' : 'Разобраться с ошибкой'

    app.innerHTML = `
      ${
        todo.length
          ? `<div class="card inbox">
          <div class="inbox-head">${icon('bell')}<h2>Ждут тебя</h2><span class="muted small">${todo.length}</span></div>
          ${todo
            .slice(0, 6)
            .map(
              ({ p, r }) => `
            <a class="inbox-item" href="#/r/${encodeURIComponent(p.id)}/${encodeURIComponent(r.id)}">
              <div class="thumb" style="${r.thumb ? `background-image:url('${fileUrl(p.id, r.thumb)}')` : ''}"></div>
              <div class="grow"><div><b>${esc(p.name)}</b> <span class="muted">· вариант ${esc(r.id)}</span></div>
                <div class="small muted">${esc(r.hook ?? r.title ?? '')}</div></div>
              <span class="btn sm"><span class="hide-sm">${action(r)}</span> ${icon('arrow')}</span>
            </a>`,
            )
            .join('')}
        </div>`
          : ''
      }
      <div class="page-head"><div><h1>Проекты</h1><p class="sub muted">${plural(projects.length, 'проект', 'проекта', 'проектов')}</p></div></div>
      <div class="projects">${projects.map(projectCard).join('')}</div>`
    return projects.some((p) => p.busy || ACTIVE.has(p.status) || p.runs.some((r) => ACTIVE.has(r.status)))
  }
  await render()
  poll(render)
}

function projectCard(p) {
  const thumbs = p.runs.map((r) => r.thumb).filter(Boolean).slice(0, 3)
  const counts = { ok: 0, wait: 0, work: 0, err: 0 }
  p.runs.forEach((r) => counts[statusTone(r.status)]++)
  const summary =
    p.status === 'error'
      ? statusPill('error')
      : p.status === 'preparing'
        ? statusPill('preparing')
        : counts.wait
          ? `<span class="status wait">Ждёт тебя: ${counts.wait}</span>`
          : counts.work
            ? statusPill('running')
            : counts.ok === p.runs.length && p.runs.length
              ? statusPill('done')
              : ''
  return `
    <a class="card project-card" href="#/p/${encodeURIComponent(p.id)}">
      <div class="project-cover">${thumbs.length ? thumbs.map((t) => `<div style="background-image:url('${fileUrl(p.id, t)}')"></div>`).join('') : `<div class="empty">${icon('film')}</div>`}</div>
      <div class="project-body">
        <div class="between"><h3>${esc(p.name)}</h3>${summary}</div>
        <div class="segments">${(p.runs.length ? p.runs : Array.from({ length: p.variants })).map((r) => `<i class="${r ? statusTone(r.status) : ''}"></i>`).join('')}</div>
        <div class="small muted">${p.productType === 'app' ? 'Приложение' : 'Товар'} · ${plural(p.variants, 'вариант', 'варианта', 'вариантов')} · ${timeAgo(p.createdAt)}</div>
      </div>
    </a>`
}

// ---------- new project wizard ----------

const AUTO = { id: '', label: 'Авто' }
const GENDERS = [{ id: '', label: 'Любой' }, { id: 'female', label: 'Женщина' }, { id: 'male', label: 'Мужчина' }]
const AGES = [{ id: '', label: 'Любой' }, { id: '18-24', label: '18–24' }, { id: '25-34', label: '25–34' }, { id: '35-44', label: '35–44' }, { id: '45-60', label: '45+' }]
const PLACES = [
  AUTO,
  { id: 'bedroom', label: 'Спальня' },
  { id: 'living room', label: 'Гостиная' },
  { id: 'kitchen', label: 'Кухня' },
  { id: 'bathroom mirror', label: 'У зеркала' },
  { id: 'car, parked', label: 'Машина' },
  { id: 'street, walking', label: 'Улица' },
  { id: 'office desk', label: 'Офис' },
  { id: 'gym', label: 'Зал' },
  { id: 'cafe', label: 'Кафе' },
]
const TONES = [
  AUTO,
  { id: 'casual and friendly, like talking to a friend', label: 'Как подруге' },
  { id: 'high energy, excited', label: 'Энергично' },
  { id: 'calm and trustworthy', label: 'Спокойно' },
  { id: 'funny, self-ironic', label: 'С юмором' },
  { id: 'emotional personal story', label: 'Личная история' },
  { id: 'confident expert explaining', label: 'Экспертно' },
]
const HOOKS = [
  AUTO,
  { id: 'a provocative question to the viewer', label: 'Вопрос' },
  { id: 'a bold, surprising statement', label: 'Смелое заявление' },
  { id: 'POV format', label: 'POV' },
  { id: 'show the result first, then explain', label: 'Сразу результат' },
  { id: "call out the viewer's pain", label: 'Боль зрителя' },
  { id: '"if you are X, stop scrolling" callout', label: '«Если ты X — стоп»' },
  { id: 'a secret nobody talks about', label: 'Секрет' },
  { id: 'reaction to the product, surprised', label: 'Реакция' },
]
const LENGTHS = [15, 25, 35, 45, 60]
const AUDIO = [
  { id: 'native', label: 'Говорит в кадре', hint: 'Креатор произносит текст сам, с липсинком' },
  { id: 'tts', label: 'Голос за кадром', hint: 'Озвучка поверх видео и субтитры' },
  { id: 'none', label: 'Без голоса', hint: 'Только субтитры и музыка' },
]

const chips = (name, list, cur = '') =>
  `<div class="chips">${list.map((o) => `<label class="chip"><input type="radio" name="${name}" value="${esc(o.id)}" ${String(o.id) === String(cur) ? 'checked' : ''}><span>${esc(o.label)}</span></label>`).join('')}</div>`
const seg = (name, list, cur) =>
  `<div class="seg">${list.map((o) => `<label><input type="radio" name="${name}" value="${esc(o.id)}" ${o.id === cur ? 'checked' : ''}><span>${esc(o.label)}</span></label>`).join('')}</div>`
const dropzone = (name, { accept, multiple, title, hint }) => `
  <div class="dz" data-dz="${name}">
    <input type="file" name="${name}" accept="${accept}" ${multiple ? 'multiple' : ''} hidden>
    <div class="dz-title">${icon('upload')} ${esc(title)}</div>
    <div class="dz-hint">${esc(hint)}</div>
    <div class="dz-files"></div>
  </div>`

const WIZARD = [
  {
    title: 'Пример',
    lead: 'Ролик, который нужно повторить. Агент разберёт его структуру: хук, подачу, темп.',
    body: () => `
      <div class="block">${seg('exampleMode', [{ id: 'url', label: 'Ссылка' }, { id: 'file', label: 'Файл' }, { id: 'none', label: 'Без примера' }], 'url')}</div>
      <div class="block" data-show="exampleMode=url">
        <input name="exampleUrl" type="url" placeholder="https://www.tiktok.com/@user/video/…">
        <span class="hint">TikTok, Reels, Shorts или YouTube — скачаем сами</span>
      </div>
      <div class="block" data-show="exampleMode=file">${dropzone('example', { accept: 'video/*,.txt', title: 'Перетащи ролик или нажми', hint: 'mp4 / mov до 300 МБ' })}</div>
      <div class="block" data-show="exampleMode=none">
        <div class="label">Формат ролика</div>
        <input name="format" placeholder="Честный отзыв · 3 причины · до/после · POV">
      </div>
      <div class="grid-2">
        <div class="block"><div class="label">Сколько вариаций</div>
          <div class="stepper"><button type="button" data-step="-1">−</button><input name="variants" type="number" min="1" max="10" value="3"><button type="button" data-step="1">+</button></div>
          <span class="hint">Разные хуки и креаторы для A/B-теста</span></div>
        <div class="block"><div class="label">Длина ролика</div>${chips('targetSeconds', LENGTHS.map((n) => ({ id: n, label: `${n} с` })), 25)}</div>
      </div>`,
  },
  {
    title: 'Продукт',
    lead: 'Что рекламируем и кому.',
    body: () => `
      <div class="block">${seg('productType', [{ id: 'app', label: 'Приложение / сервис' }, { id: 'physical', label: 'Товар' }], 'app')}</div>
      <div class="grid-2">
        <label class="field"><span class="label req">Название</span><input name="productName" required placeholder="FocusFlow"></label>
        <label class="field"><span class="label">Цена</span><input name="price" placeholder="Бесплатно, Pro $4.99/мес"></label>
        <label class="field span-2"><span class="label req">Что это и чем хорош</span><textarea name="productDescription" rows="3" required placeholder="Блокирует отвлекающие приложения во время учёбы и превращает фокус в игру"></textarea></label>
        <label class="field span-2"><span class="label req">Для кого</span><textarea name="audience" rows="2" required placeholder="Студенты 18–25 в США, которые залипают в телефоне"></textarea></label>
        <label class="field"><span class="label">Оффер</span><input name="offer" placeholder="7 дней Pro бесплатно"></label>
        <label class="field"><span class="label">Что должен сделать зритель</span><input name="goal" placeholder="Скачать по ссылке в профиле"></label>
      </div>
      <div class="grid-2">
        <div class="block"><div class="label" data-label-images>Скриншоты приложения</div>
          ${dropzone('productImages', { accept: 'image/*', multiple: true, title: 'Добавить изображения', hint: 'Для кадров «телефон в руке»' })}</div>
        <div class="block" data-show="productType=app"><div class="label">Записи экрана</div>
          ${dropzone('screenRecordings', { accept: 'video/*', multiple: true, title: 'Добавить видео', hint: 'Вставим в ролик настоящий интерфейс' })}</div>
      </div>`,
  },
  {
    title: 'Креатор',
    lead: 'Кто снимает ролик. Можно дать фото — или выбрать параметры, и агент сгенерирует человека.',
    body: () => `
      <div class="block"><div class="label">Фото креатора <span class="faint">— необязательно</span></div>
        ${dropzone('personaRefs', { accept: 'image/*', multiple: true, title: 'Добавить 1–3 фото', hint: 'Лицо хорошо видно, один и тот же человек' })}</div>
      <div class="block" data-show="personaRefs">
        <div class="options">
          <label class="option"><input type="radio" name="personaMode" value="exact" checked><div><b>Этот человек</b><small>Одно и то же лицо во всех вариациях</small></div></label>
          <label class="option"><input type="radio" name="personaMode" value="inspired"><div><b>Похожий типаж</b><small>Другое лицо в том же стиле</small></div></label>
        </div>
      </div>
      <div class="block"><div class="label">Пол</div>${chips('creatorGender', GENDERS)}</div>
      <div class="block"><div class="label">Возраст</div>${chips('creatorAge', AGES)}</div>
      <div class="block"><div class="label">Где снимает</div>${chips('setting', PLACES)}</div>
      <label class="field"><span class="label">Образ</span><input name="persona" placeholder="Худи, небрежный пучок, без макияжа"></label>`,
  },
  {
    title: 'Сообщение',
    lead: 'О чём говорит креатор и как.',
    body: () => `
      <div class="block">
        <div class="between"><div class="label">О чём рассказывает</div>${seg('talkingMode', [{ id: 'points', label: 'Тезисы' }, { id: 'verbatim', label: 'Дословный текст' }], 'points')}</div>
        <textarea name="talkingPoints" rows="5" placeholder="Раньше сидел в телефоне по 6 часов в день&#10;FocusFlow блокирует TikTok, пока я учусь&#10;Закрыл сессию без хвостов&#10;Первая неделя Pro — бесплатно"></textarea>
        <span class="hint" data-hint-talking>Агент перескажет тезисы живыми словами. Пусто — придумает сам по примеру и описанию.</span>
      </div>
      <div class="block"><div class="label">Тон</div>${chips('tone', TONES)}</div>
      <div class="block"><div class="label">Хук — первые 2 секунды</div>${chips('hookStyle', HOOKS)}</div>
      <div class="grid-2">
        <label class="field"><span class="label">Заметки</span><input name="notes" placeholder="Без медицинских обещаний"></label>
        <div class="block"><div class="label">Музыка</div>${dropzone('music', { accept: 'audio/*', title: 'Добавить трек', hint: 'Пойдёт тихо фоном' })}</div>
      </div>`,
  },
  {
    title: 'Запуск',
    lead: 'Проверь и запускай. Агент остановится, чтобы ты одобрил сценарии и кадры.',
    body: () => `
      <div class="card pad"><dl class="summary" id="summary"></dl></div>
      <div class="block"><div class="label">Звук</div>
        <div class="options">${AUDIO.map((a, i) => `<label class="option"><input type="radio" name="audio" value="${a.id}" ${i === 0 ? 'checked' : ''}><div><b>${a.label}</b><small>${a.hint}</small></div></label>`).join('')}</div></div>
      <div class="card pad" style="padding-top:4px;padding-bottom:4px">
        <label class="switch"><div><b class="small">Остановиться на сценарии</b><div class="hint">Проверишь и поправишь текст до генерации картинок</div></div><input type="checkbox" name="approveScript" checked></label>
        <label class="switch"><div><b class="small">Остановиться на кадрах</b><div class="hint">Видео — самый дорогой шаг, сначала посмотришь кадры</div></div><input type="checkbox" name="approveKeyframes" checked></label>
        <label class="switch"><div><b class="small">Субтитры</b><div class="hint">Крупные, по 3–4 слова</div></div><input type="checkbox" name="subtitles" checked></label>
      </div>
      <details class="card" id="advanced"><summary>Язык и модели ${icon('chevron')}</summary><div class="body" id="models"><p class="muted small">Загрузка…</p></div></details>`,
  },
]

function newProjectView() {
  let step = 0
  app.innerHTML = `
    <form class="wizard" id="wizard" novalidate>
      <div class="crumbs"><a href="#/">Проекты</a><span>/</span><span>Новый проект</span></div>
      <div class="steps">${WIZARD.map((s, i) => `<button type="button" data-goto="${i}"><span>${i + 1}. ${s.title}</span></button>`).join('')}</div>
      ${WIZARD.map((s, i) => `<section class="step-panel" data-panel="${i}" hidden><header><h1>${s.title}</h1><p class="muted">${s.lead}</p></header>${s.body()}</section>`).join('')}
    </form>`
  const form = document.getElementById('wizard')
  initDropzones(form)

  // Variants stepper.
  form.querySelectorAll('[data-step]').forEach((b) =>
    b.addEventListener('click', () => {
      const input = form.variants
      input.value = Math.min(10, Math.max(1, Number(input.value) + Number(b.dataset.step)))
    }),
  )

  // Conditional blocks: data-show="name=value" or data-show="fileInput".
  const sync = () => {
    form.querySelectorAll('[data-show]').forEach((el) => {
      const [name, value] = el.dataset.show.split('=')
      const field = form.elements[name]
      el.hidden = value === undefined ? !(field?.files?.length > 0) : field?.value !== value
    })
    const isApp = form.productType.value === 'app'
    form.querySelector('[data-label-images]').textContent = isApp ? 'Скриншоты приложения' : 'Фото товара'
    form.querySelector('[data-hint-talking]').textContent =
      form.talkingMode.value === 'verbatim'
        ? 'Креатор скажет именно этот текст, агент только разобьёт его на сцены.'
        : 'Агент перескажет тезисы живыми словами. Пусто — придумает сам по примеру и описанию.'
  }
  form.addEventListener('change', sync)
  form.addEventListener('dz-change', sync)

  const show = (i) => {
    step = i
    form.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = Number(p.dataset.panel) !== i))
    form.querySelectorAll('[data-goto]').forEach((b) => {
      const n = Number(b.dataset.goto)
      b.className = n < i ? 'done' : n === i ? 'current' : ''
    })
    if (i === WIZARD.length - 1) renderSummary(form)
    const last = i === WIZARD.length - 1
    setBar(
      `<button type="button" class="btn ghost" id="wz-back" ${i === 0 ? 'disabled' : ''}>${icon('back')} Назад</button>
       <span class="small muted hide-sm">Шаг ${i + 1} из ${WIZARD.length}</span>
       <button type="button" class="btn ${last ? 'accent lg' : 'primary'}" id="wz-next">${last ? `${icon('sparkle')} Создать и запустить` : `Далее ${icon('arrow')}`}</button>`,
      true,
    )
    document.getElementById('wz-back').onclick = () => show(step - 1)
    document.getElementById('wz-next').onclick = () => (last ? submit() : valid(step) && show(step + 1))
    window.scrollTo(0, 0)
  }

  const valid = (i) => {
    const panel = form.querySelector(`[data-panel="${i}"]`)
    for (const el of panel.querySelectorAll('[required]')) {
      if (!el.value.trim()) {
        el.focus()
        toast('Заполни обязательные поля')
        return false
      }
    }
    if (i === 0 && form.exampleMode.value === 'url' && form.exampleUrl.value && !/^https?:\/\//.test(form.exampleUrl.value)) {
      toast('Ссылка должна начинаться с https://')
      return false
    }
    return true
  }

  form.querySelectorAll('[data-goto]').forEach((b) =>
    b.addEventListener('click', () => {
      const target = Number(b.dataset.goto)
      for (let i = step; i < target; i++) if (!valid(i)) return show(i)
      show(target)
    }),
  )

  const submit = () => {
    for (let i = 0; i < WIZARD.length; i++) if (!valid(i)) return show(i)
    const fd = new FormData(form)
    const mode = form.exampleMode.value
    if (mode !== 'url') fd.delete('exampleUrl')
    if (mode !== 'file') fd.delete('example')
    if (mode !== 'none') fd.delete('format')
    if (form.productType.value !== 'app') fd.delete('screenRecordings')
    fd.delete('exampleMode')
    form.querySelectorAll('input[type=checkbox]').forEach((c) => fd.set(c.name, c.checked ? 'true' : 'false'))

    const overlay = document.createElement('div')
    overlay.className = 'overlay'
    overlay.innerHTML = `<div class="card"><h2>Загружаем файлы</h2><p class="muted small" style="margin-top:4px">Не закрывай вкладку</p><div class="bar"><div></div></div></div>`
    document.body.append(overlay)
    const fill = overlay.querySelector('.bar > div')
    // XHR rather than fetch: upload progress matters for screen recordings.
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/projects')
    xhr.upload.onprogress = (ev) => ev.lengthComputable && (fill.style.width = `${(ev.loaded / ev.total) * 100}%`)
    xhr.onload = () => {
      overlay.remove()
      const data = JSON.parse(xhr.responseText || '{}')
      if (xhr.status === 201) location.hash = `#/p/${encodeURIComponent(data.id)}`
      else toast(data.error ?? `Ошибка ${xhr.status}`)
    }
    xhr.onerror = () => {
      overlay.remove()
      toast('Нет соединения с сервером')
    }
    xhr.send(fd)
  }

  api('GET', '/api/options')
    .then((o) => {
      const d = o.defaults
      const opts = (list, cur) => list.map((x) => `<option value="${esc(x.id)}" ${x.id === cur ? 'selected' : ''}>${esc(x.label)}</option>`).join('')
      const res = (cur) => o.resolutions.map((r) => `<option ${r === cur ? 'selected' : ''}>${r}</option>`).join('')
      form.querySelector(`[name=audio][value="${d.audio}"]`)?.click()
      form.approveScript.checked = d.approvals.script
      form.approveKeyframes.checked = d.approvals.keyframes
      form.subtitles.checked = d.subtitles
      document.getElementById('models').innerHTML = `
        <div class="grid-2">
          <label class="field"><span class="label">Язык роликов</span><select name="language">${opts(o.languages, d.language)}</select></label>
          <label class="field"><span class="label">Сценарии</span><select name="llm">${opts(o.llm, d.llm)}</select></label>
          <label class="field"><span class="label">Креатор и кадры</span><select name="image">${opts(o.image, d.image)}</select></label>
          <div></div>
          <div class="field"><span class="label">Видео — черновик</span><div class="row" style="flex-wrap:nowrap"><select name="videoDraft">${opts(o.video, d.videoDraft)}</select><select name="draftResolution" style="width:92px">${res(d.draftResolution)}</select></div></div>
          <div class="field"><span class="label">Видео — финал</span><div class="row" style="flex-wrap:nowrap"><select name="videoFinal">${opts(o.video, d.videoFinal)}</select><select name="finalResolution" style="width:92px">${res(d.finalResolution)}</select></div></div>
        </div>
        <p class="hint" style="margin-top:12px">Черновики делаются на быстрой модели. Финал — на дорогой, только для роликов, которые тебе понравились.</p>`
    })
    .catch((err) => toast(err.message))

  sync()
  show(0)
}

function renderSummary(form) {
  const v = (n) => form.elements[n]?.value?.trim()
  const files = (n) => form.elements[n]?.files?.length ?? 0
  const label = (list, id) => list.find((o) => String(o.id) === String(id))?.label
  const mode = v('exampleMode')
  const rows = [
    ['Пример', mode === 'url' ? v('exampleUrl') || '—' : mode === 'file' ? form.example.files[0]?.name ?? '—' : `без примера${v('format') ? `, формат: ${v('format')}` : ''}`],
    ['Вариаций', `${v('variants')} × ${v('targetSeconds')} с`],
    ['Продукт', `${v('productName') || '—'}${v('offer') ? ` · ${v('offer')}` : ''}`],
    ['Аудитория', v('audience') || '—'],
    ['Материалы', [files('productImages') && plural(files('productImages'), 'изображение', 'изображения', 'изображений'), files('screenRecordings') && plural(files('screenRecordings'), 'запись экрана', 'записи экрана', 'записей экрана')].filter(Boolean).join(', ') || 'нет'],
    [
      'Креатор',
      [
        files('personaRefs') ? `по фото (${form.personaMode.value === 'exact' ? 'этот человек' : 'похожий типаж'})` : 'сгенерируем',
        label(GENDERS, v('creatorGender')) !== 'Любой' && label(GENDERS, v('creatorGender')),
        v('creatorAge') && `${label(AGES, v('creatorAge'))} лет`,
        v('setting') && label(PLACES, v('setting')),
      ]
        .filter(Boolean)
        .join(' · '),
    ],
    ['Тон и хук', [label(TONES, v('tone')), label(HOOKS, v('hookStyle'))].join(' · ')],
    ['Текст', v('talkingPoints') ? `${v('talkingMode') === 'verbatim' ? 'дословно: ' : 'тезисы: '}${v('talkingPoints').split('\n').length} стр.` : 'агент придумает сам'],
  ]
  document.getElementById('summary').innerHTML = rows.map(([k, val]) => `<dt>${k}</dt><dd>${esc(val)}</dd>`).join('')
}

/** Drag-and-drop file inputs with thumbnails and remove buttons. */
function initDropzones(root) {
  root.querySelectorAll('[data-dz]').forEach((dz) => {
    const input = dz.querySelector('input[type=file]')
    const list = dz.querySelector('.dz-files')
    const set = (files) => {
      const dt = new DataTransfer()
      const all = input.multiple ? [...input.files, ...files] : files.slice(0, 1)
      all.forEach((f) => dt.items.add(f))
      input.files = dt.files
      render()
    }
    const render = () => {
      list.innerHTML = ''
      ;[...input.files].forEach((f, i) => {
        const el = document.createElement('div')
        el.className = 'dz-file'
        const url = URL.createObjectURL(f)
        el.innerHTML = f.type.startsWith('image/')
          ? `<img src="${url}" alt="">`
          : f.type.startsWith('video/')
            ? `<span>${esc(f.name)}</span><video src="${url}#t=0.5" muted playsinline preload="metadata"></video>`
            : `<span>${esc(f.name)}</span>`
        const rm = document.createElement('button')
        rm.type = 'button'
        rm.innerHTML = icon('x')
        rm.title = 'Убрать'
        rm.onclick = (e) => {
          e.stopPropagation()
          const dt = new DataTransfer()
          ;[...input.files].forEach((x, j) => j !== i && dt.items.add(x))
          input.files = dt.files
          render()
        }
        el.append(rm)
        list.append(el)
      })
      root.dispatchEvent(new Event('dz-change'))
    }
    dz.addEventListener('click', (e) => e.target.closest('.dz-file') || input.click())
    input.addEventListener('change', (e) => {
      e.stopPropagation()
      const picked = [...input.files]
      if (input.multiple) {
        // The picker replaces the selection; keep what was added before.
        const prev = dz._files ?? []
        const dt = new DataTransfer()
        ;[...prev, ...picked].forEach((f) => dt.items.add(f))
        input.files = dt.files
      }
      render()
    })
    input.addEventListener('click', () => (dz._files = [...input.files]))
    dz.addEventListener('dragover', (e) => {
      e.preventDefault()
      dz.classList.add('over')
    })
    dz.addEventListener('dragleave', () => dz.classList.remove('over'))
    dz.addEventListener('drop', (e) => {
      e.preventDefault()
      dz.classList.remove('over')
      const accept = input.accept.split(',').map((s) => s.trim())
      const ok = [...e.dataTransfer.files].filter((f) =>
        accept.some((a) => (a.endsWith('/*') ? f.type.startsWith(a.slice(0, -1)) : f.name.toLowerCase().endsWith(a))),
      )
      if (!ok.length) return toast('Этот тип файла здесь не подходит')
      set(ok)
    })
  })
}

// ---------- project ----------

async function projectView(pid) {
  const render = async () => {
    const p = await api('GET', `/api/projects/${encodeURIComponent(pid)}`)
    const count = (s) => p.runs.filter((r) => r.status === s).length
    const scripts = count('awaiting_script')
    const frames = count('awaiting_keyframes')
    const drafts = p.runs.filter((r) => r.status === 'done' && r.quality === 'draft').length

    let callout = ''
    if (p.status === 'error') {
      callout = `<div class="callout err">${icon('alert')}<div class="grow"><b>Не удалось подготовить проект</b><div class="small">${esc(p.error)}</div></div><button class="btn sm" data-retry>${icon('refresh')} Повторить</button></div>`
    } else if (p.status === 'preparing') {
      callout = `<div class="callout" style="background:var(--accent-soft)"><span class="spinner" style="color:var(--accent)"></span><div class="grow"><b>Агент готовит сценарии</b><div class="small muted">${esc(lastLine(p.log) || 'Разбираем пример…')}</div></div></div>`
    } else if (scripts || frames) {
      const what = scripts ? `${plural(scripts, 'сценарий ждёт', 'сценария ждут', 'сценариев ждут')} проверки` : `${plural(frames, 'вариант ждёт', 'варианта ждут', 'вариантов ждут')} проверки кадров`
      callout = `<div class="callout">${icon('bell')}<div class="grow"><b>${what}</b><div class="small muted">Открой вариант, чтобы поправить, или одобри все сразу</div></div>
        <button class="btn primary sm" data-bulk="${scripts ? 'script' : 'keyframes'}">${icon('check')} Одобрить все (${scripts || frames})</button></div>`
    }

    app.innerHTML = `
      <div class="crumbs"><a href="#/">Проекты</a><span>/</span><span>${esc(p.name)}</span></div>
      <div class="page-head">
        <div><h1>${esc(p.name)}</h1><p class="sub muted small">${p.brief.product.type === 'app' ? 'Приложение' : 'Товар'} · ${plural(p.variants, 'вариант', 'варианта', 'вариантов')} · ${timeAgo(p.createdAt)}${p.analysis ? ` · формат примера: ${esc(p.analysis.format)}` : ''}</p></div>
        ${drafts ? `<button class="btn" data-bulk="final">${icon('sparkle')} Финал для ${plural(drafts, 'черновика', 'черновиков', 'черновиков')}</button>` : ''}
      </div>
      ${callout}
      <div class="variants">${p.runs.length ? p.runs.map((r) => variantCard(pid, r)).join('') : Array.from({ length: p.variants }, (_, i) => `<div class="card variant-card"><div class="placeholder"><span class="spinner"></span>Вариант ${i + 1}</div><div class="body"><span class="small muted">Пишем сценарий…</span></div></div>`).join('')}</div>
      <div class="section stack">
        ${p.analysis ? analysisCard(p.analysis) : ''}
        ${briefCard(p)}
        ${p.log.length ? `<details class="card"><summary>Журнал ${icon('chevron')}</summary><div class="body"><div class="log">${esc(p.log.join('\n'))}</div></div></details>` : ''}
      </div>`

    app.querySelector('[data-retry]')?.addEventListener('click', async () => {
      await api('POST', `/api/projects/${encodeURIComponent(pid)}/retry`).catch((e) => toast(e.message))
      render()
    })
    app.querySelectorAll('[data-bulk]').forEach((b) =>
      b.addEventListener('click', async () => {
        const kind = b.dataset.bulk
        if (kind === 'final' && !confirm('Перегенерировать клипы всех готовых черновиков на финальной модели? Это самый дорогой шаг.')) return
        b.disabled = true
        const targets = p.runs.filter((r) => (kind === 'final' ? r.status === 'done' && r.quality === 'draft' : r.status === `awaiting_${kind}`))
        const action = kind === 'final' ? { type: 'final' } : { type: 'approve', what: kind }
        for (const r of targets) {
          await api('POST', `/api/projects/${encodeURIComponent(pid)}/runs/${r.id}/action`, action).catch((e) => toast(e.message))
        }
        toast('Готово, запустили')
        render()
      }),
    )
    return true
  }
  await render()
  poll(render)
}

const lastLine = (log) => (log?.at(-1) ?? '').replace(/^\d\d:\d\d:\d\d\s+/, '').trim()

function variantCard(pid, r) {
  const stage = stageOf(r)
  const media = r.final
    ? `<video class="media" src="${fileUrl(pid, r.final)}" controls preload="metadata" playsinline></video>`
    : r.thumb
      ? `<div class="media" style="background-image:url('${fileUrl(pid, r.thumb)}')"></div>`
      : `<div class="placeholder">${ACTIVE.has(r.status) ? '<span class="spinner"></span>' : ''}${esc(r.title ?? 'Нет кадров')}</div>`
  const href = `#/r/${encodeURIComponent(pid)}/${encodeURIComponent(r.id)}`
  const cta =
    r.status === 'awaiting_script'
      ? `<a class="btn primary sm" href="${href}">Проверить сценарий</a>`
      : r.status === 'awaiting_keyframes'
        ? `<a class="btn primary sm" href="${href}">Проверить кадры</a>`
        : r.status === 'error'
          ? `<a class="btn sm" href="${href}">Что случилось?</a>`
          : `<a class="btn sm" href="${href}">Открыть</a>`
  return `
    <div class="card variant-card">
      ${media}
      <div class="body">
        <div class="between"><b>Вариант ${esc(r.id)}</b>${r.status.startsWith('awaiting_') ? '' : statusPill(r.status)}</div>
        <div class="dots" title="Сценарий → Кадры → Видео → Готово">${[0, 1, 2, 3].map((i) => `<i class="${i < stage || (i === 3 && r.final) ? 'done' : i === stage ? 'now' : ''}"></i>`).join('')}</div>
        ${r.hook ? `<div class="hook">«${esc(r.hook)}»</div>` : ''}
        <div class="foot between">${cta}<span class="tiny faint">${r.quality === 'final' ? 'финал' : 'черновик'}${r.spentUsd ? ` · $${r.spentUsd.toFixed(2)}` : ''}</span></div>
      </div>
    </div>`
}

function analysisCard(a) {
  return `<details class="card"><summary>Разбор примера ${icon('chevron')}</summary><div class="body">
    <dl class="summary"><dt>Формат</dt><dd>${esc(a.format)}</dd><dt>Хук</dt><dd>${esc(a.hook)}</dd><dt>Тон</dt><dd>${esc(a.tone)}</dd><dt>Темп</dt><dd>${esc(a.pacing)}</dd><dt>Призыв</dt><dd>${esc(a.cta)}</dd>
    <dt>Структура</dt><dd>${a.beats.map((b, i) => `${i + 1}. ${esc(b.purpose)} · ${b.seconds} с — ${esc(b.description)}`).join('<br>')}</dd></dl>
  </div></details>`
}

function briefCard(p) {
  const b = p.brief
  const st = b.style ?? {}
  const label = (list, id) => list.find((o) => o.id === id)?.label ?? id
  const m = p.settings?.models ?? {}
  const rows = [
    ['Продукт', b.product.description],
    ['Аудитория', b.audience],
    b.offer && ['Оффер', b.offer],
    b.talkingPoints && [b.talkingMode === 'verbatim' ? 'Текст (дословно)' : 'Тезисы', b.talkingPoints],
    ['Креатор', [b.personaRefs?.length ? `по фото — ${b.personaMode === 'exact' ? 'этот человек' : 'похожий типаж'}` : 'генерируется', st.creatorGender && label(GENDERS, st.creatorGender), st.creatorAge, st.setting && label(PLACES, st.setting), b.persona].filter(Boolean).join(' · ')],
    ['Тон и хук', [st.tone ? label(TONES, st.tone) : 'тон авто', st.hookStyle ? label(HOOKS, st.hookStyle) : 'хук авто'].join(' · ')],
    ['Модели', [m.videoDraft && `черновик ${m.videoDraft} ${m.draftResolution ?? ''}`, m.videoFinal && `финал ${m.videoFinal} ${m.finalResolution ?? ''}`].filter(Boolean).join(' · ') || 'по умолчанию'],
  ].filter(Boolean)
  return `<details class="card"><summary>Бриф и настройки ${icon('chevron')}</summary><div class="body"><dl class="summary">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div></details>`
}

// ---------- variant ----------

const TABS = ['Сценарий', 'Кадры', 'Видео', 'Готово']

async function runView(pid, rid) {
  const base = `/api/projects/${encodeURIComponent(pid)}/runs/${encodeURIComponent(rid)}`
  let s = await api('GET', base)
  let dirty = false
  let tab = currentStage(s)
  let sig = ''

  app.innerHTML = `
    <div class="crumbs"><a href="#/">Проекты</a><span>/</span><a href="#/p/${encodeURIComponent(pid)}" id="crumb-project">Проект</a><span>/</span><span>Вариант ${esc(rid)}</span></div>
    <div class="page-head"><div><h1 id="title"></h1><p class="sub muted small" id="sub"></p></div><div id="pill"></div></div>
    <nav class="pipeline" id="pipeline"></nav>
    <div id="error"></div>
    <div id="content"></div>
    <details class="card section" id="log-wrap" hidden><summary>Журнал ${icon('chevron')}</summary><div class="body"><div class="log" id="log"></div></div></details>`
  api('GET', `/api/projects/${encodeURIComponent(pid)}`)
    .then((p) => (document.getElementById('crumb-project').textContent = p.name))
    .catch(() => {})

  const act = async (action, confirmText) => {
    if (confirmText && !confirm(confirmText)) return
    try {
      await api('POST', `${base}/action`, action)
      await refresh(true)
    } catch (err) {
      toast(err.message)
    }
  }

  // ----- header, pipeline, action bar -----

  const renderHead = () => {
    document.getElementById('title').textContent = s.script?.title ?? `Вариант ${rid}`
    document.getElementById('sub').textContent = `${s.quality === 'final' ? 'Финальное качество' : 'Черновик'}${s.spentUsd ? ` · потрачено $${s.spentUsd.toFixed(2)}` : ''}`
    document.getElementById('pill').innerHTML = statusPill(s.busy && !ACTIVE.has(s.status) ? 'running' : s.status)
    const now = currentStage(s)
    const available = [Boolean(s.script), Boolean(s.persona || s.scenes.some((x) => x.keyframe)), s.scenes.some((x) => x.clip), Boolean(s.final)]
    document.getElementById('pipeline').innerHTML = TABS.map((name, i) => {
      const cls = [i < now || (i === 3 && s.final) ? 'done' : i === now ? 'now' : '', i === tab ? 'active' : ''].join(' ')
      return `<button data-tab="${i}" class="${cls}" ${available[i] || i === now ? '' : 'disabled'}><div class="num">Шаг ${i + 1}</div><div class="name">${i < now || (i === 3 && s.final) ? icon('check') : ''}${name}</div></button>`
    }).join('')
    document.querySelectorAll('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        tab = Number(b.dataset.tab)
        renderAll(true)
      }),
    )
    document.getElementById('error').innerHTML = s.error
      ? `<div class="callout err">${icon('alert')}<div class="grow"><b>Генерация остановилась</b><div class="small">${esc(s.error)}</div></div><button class="btn sm" data-resume>${icon('refresh')} Продолжить</button></div>`
      : ''
    document.querySelector('[data-resume]')?.addEventListener('click', () => act({ type: 'resume' }))
    const logWrap = document.getElementById('log-wrap')
    logWrap.hidden = !s.log.length
    document.getElementById('log').textContent = s.log.join('\n')
  }

  const renderBar = () => {
    if (dirty) {
      setBar(`<div class="info">${icon('alert')}<span>Есть несохранённые изменения</span></div>
        <div class="row"><button class="btn ghost" id="discard">Отменить</button><button class="btn primary" id="save">Сохранить</button></div>`)
      document.getElementById('discard').onclick = () => {
        dirty = false
        renderAll(true)
      }
      document.getElementById('save').onclick = saveScript
      return
    }
    if (s.busy || ACTIVE.has(s.status)) {
      const doing = ['Пишем сценарий', 'Рисуем креатора и кадры', 'Генерируем видео', 'Собираем ролик'][currentStage(s)]
      const detail = s.status === 'queued' ? 'в очереди' : lastLine(s.log).replace(/^Вариант \d+:\s*/, '')
      setBar(`<div class="info"><span class="spinner" style="color:var(--accent)"></span><span><b>${doing}</b>${detail ? ` <span class="muted">· ${esc(detail)}</span>` : ''}</span></div><span class="small muted hide-sm">Можно закрыть страницу — работа продолжится</span>`)
      return
    }
    switch (s.status) {
      case 'awaiting_script':
        setBar(`<div class="info"><span class="hide-sm">Всё устраивает? Дальше — креатор и кадры</span></div>
          <button class="btn accent lg" id="primary">${icon('check')} Одобрить сценарий</button>`)
        document.getElementById('primary').onclick = () => act({ type: 'approve', what: 'script' })
        break
      case 'awaiting_keyframes':
        setBar(`<div class="info"><span class="hide-sm">Кадры ок? Дальше — видео, самый долгий шаг</span></div>
          <button class="btn accent lg" id="primary">${icon('play')} Запустить видео</button>`)
        document.getElementById('primary').onclick = () => act({ type: 'approve', what: 'keyframes' })
        break
      case 'done':
        setBar(`<div class="info"><span class="hide-sm">${s.quality === 'final' ? 'Финальная версия готова' : 'Черновик готов. Нравится — сделай финал в высоком качестве'}</span></div>
          <div class="row"><a class="btn" href="${runUrl(pid, rid, s.final)}" download="${esc(pid)}-${esc(rid)}.mp4">${icon('download')} Скачать</a>
          ${s.quality === 'draft' ? `<button class="btn accent" id="primary">${icon('sparkle')} Сделать финал</button>` : ''}</div>`)
        document.getElementById('primary')?.addEventListener('click', () =>
          act({ type: 'final' }, 'Перегенерировать клипы на финальной модели? Кадры и сценарий останутся теми же.'),
        )
        break
      case 'paused':
        setBar(`<div class="info"><span>Генерация на паузе</span></div><button class="btn primary" id="primary">Продолжить</button>`)
        document.getElementById('primary').onclick = () => act({ type: 'resume' })
        break
      default:
        setBar('')
    }
  }

  // ----- tabs -----

  const renderScript = () => {
    const c = document.getElementById('content')
    if (!s.script) {
      c.innerHTML = `<div class="card pad"><div class="row muted"><span class="spinner"></span> Пишем сценарий…</div></div>`
      return
    }
    const locked = s.busy || ACTIVE.has(s.status)
    const recs = s.recordings
    const total = s.script.scenes.reduce((a, x) => a + x.duration, 0)
    c.innerHTML = `
      <div class="between" style="margin-bottom:14px"><p class="muted small">${plural(s.script.scenes.length, 'сцена', 'сцены', 'сцен')} · ${total} с · правки сохраняются кнопкой внизу</p>
        ${locked ? '' : `<button class="btn ghost sm" id="rewrite">${icon('refresh')} Написать заново</button>`}</div>
      <div class="card pad" id="editor">
        <div class="persona-row">
          <label class="field"><span class="label">Креатор</span><textarea data-p="look" rows="2">${esc(s.script.persona.look)}</textarea></label>
          <label class="field"><span class="label">Голос</span><textarea data-p="voice" rows="2">${esc(s.script.persona.voice)}</textarea></label>
        </div>
        ${s.script.scenes
          .map(
            (sc, i) => `
          <div class="scene" data-i="${i}">
            <div class="idx">${String(i + 1).padStart(2, '0')}</div>
            <div class="main">
              <div class="meta"><span class="tag">${esc(sc.purpose)}</span>${sc.showsProduct ? '<span class="tag">продукт в кадре</span>' : ''}${sc.screen ? `<span class="tag">запись экрана · ${sc.screen.layout === 'full' ? 'весь кадр' : 'окно'}</span>` : ''}</div>
              <textarea class="line" data-f="line" rows="2" placeholder="Без слов">${esc(sc.line)}</textarea>
              <div class="inline">
                <label><span class="mini-label">Текст на экране</span><input data-f="onScreenText" value="${esc(sc.onScreenText)}" placeholder="Необязательно"></label>
                <label><span class="mini-label">Секунд</span><input data-f="duration" type="number" min="1" max="15" value="${sc.duration}"></label>
              </div>
              ${
                recs.length
                  ? `<div class="screen-row">
                  <label><span class="mini-label">Запись экрана</span><select data-f="screen.recording"><option value="">Нет</option>${recs.map((r, j) => `<option value="${j}" ${sc.screen?.recording === j ? 'selected' : ''}>Запись ${j + 1} · ${r.duration.toFixed(0)} с</option>`).join('')}</select></label>
                  <label><span class="mini-label">Как показать</span><select data-f="screen.layout"><option value="full" ${sc.screen?.layout === 'full' ? 'selected' : ''}>На весь кадр</option><option value="pip" ${sc.screen?.layout !== 'full' ? 'selected' : ''}>Окном</option></select></label>
                  <label><span class="mini-label">С секунды</span><input data-f="screen.start" type="number" min="0" step="0.5" value="${sc.screen?.start ?? 0}"></label>
                </div>`
                  : ''
              }
              <details><summary>${icon('chevron')} Промпты для моделей</summary>
                <div class="grid-2">
                  <label><span class="mini-label">Кадр</span><textarea data-f="visual" rows="2">${esc(sc.visual)}</textarea></label>
                  <label><span class="mini-label">Движение</span><textarea data-f="motion" rows="2">${esc(sc.motion)}</textarea></label>
                  <label><span class="mini-label">Камера</span><input data-f="shot" value="${esc(sc.shot)}"></label>
                  <label class="check" style="align-self:end;padding-bottom:10px"><input type="checkbox" data-f="showsProduct" ${sc.showsProduct ? 'checked' : ''}> Продукт в кадре</label>
                </div>
              </details>
            </div>
          </div>`,
          )
          .join('')}
      </div>`
    const editor = document.getElementById('editor')
    editor.querySelectorAll('input, textarea, select').forEach((el) => (el.disabled = locked))
    const syncScreens = () =>
      editor.querySelectorAll('.screen-row').forEach((row) => {
        const off = row.querySelector('[data-f="screen.recording"]').value === ''
        row.querySelectorAll('[data-f="screen.layout"], [data-f="screen.start"]').forEach((el) => (el.disabled = locked || off))
      })
    syncScreens()
    editor.addEventListener('change', syncScreens)
    editor.addEventListener('input', () => {
      if (!dirty) {
        dirty = true
        renderBar()
      }
    })
    document.getElementById('rewrite')?.addEventListener('click', () =>
      act({ type: 'redo', stage: 'script' }, 'Написать сценарий заново? Кадры и видео этого варианта будут сделаны заново.'),
    )
  }

  const collectScript = () => {
    const out = structuredClone(s.script)
    const ed = document.getElementById('editor')
    out.persona.look = ed.querySelector('[data-p=look]').value
    out.persona.voice = ed.querySelector('[data-p=voice]').value
    ed.querySelectorAll('.scene').forEach((node) => {
      const sc = out.scenes[Number(node.dataset.i)]
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
    return out
  }

  const saveScript = async () => {
    try {
      const wasDone = s.status !== 'awaiting_script'
      s = { ...s, ...(await api('PUT', `${base}/script`, collectScript())) }
      dirty = false
      if (wasDone) {
        // Edits after approval regenerate only what they touch.
        await api('POST', `${base}/action`, { type: 'resume' })
        toast('Сохранено — переделываем затронутые сцены')
      } else toast('Сохранено')
      await refresh(true)
    } catch (err) {
      toast(err.message)
    }
  }

  const renderFrames = () => {
    const c = document.getElementById('content')
    const locked = s.busy || ACTIVE.has(s.status)
    const personaSrc = s.persona && !s.persona.startsWith('/') ? `${runUrl(pid, rid, s.persona)}?v=${encodeURIComponent(s.refs.persona ?? '')}` : null
    c.innerHTML = `
      <p class="muted small" style="margin-bottom:14px">Первый кадр каждой сцены. Видео начнётся с него. Не нравится — нажми «Заново» на кадре.</p>
      <div class="board">
        <div class="frame">
          <div class="media-wrap">${personaSrc ? `<img class="media" src="${personaSrc}" alt="">` : `<div class="placeholder"><span class="spinner"></span>Креатор</div>`}
            ${personaSrc && !locked ? `<div class="over"><button class="btn sm" data-redo-persona>${icon('refresh')} Другой</button></div>` : ''}</div>
          <div class="cap"><b>Креатор</b> — общий для всех сцен</div>
        </div>
        ${s.scenes
          .map((sc, i) => {
            const line = s.script?.scenes[i]?.line
            return `<div class="frame">
            <div class="media-wrap">${sc.keyframe ? `<img class="media" src="${runUrl(pid, rid, sc.keyframe)}?v=${encodeURIComponent(sc.keyframeRef ?? '')}" alt="">` : `<div class="placeholder">${locked ? '<span class="spinner"></span>' : ''}Сцена ${i + 1}</div>`}
              ${sc.keyframe && !locked ? `<div class="over"><button class="btn sm" data-redo-frame="${i}">${icon('refresh')} Заново</button></div>` : ''}</div>
            <div class="cap"><b>${i + 1}.</b> ${esc(line || 'без слов')}</div>
          </div>`
          })
          .join('')}
      </div>`
    c.querySelector('[data-redo-persona]')?.addEventListener('click', () =>
      act({ type: 'redo', stage: 'persona' }, 'Сгенерировать другого креатора? Все кадры будут сделаны заново.'),
    )
    c.querySelectorAll('[data-redo-frame]').forEach((b) => b.addEventListener('click', () => act({ type: 'redo', stage: 'keyframes', scene: Number(b.dataset.redoFrame) })))
  }

  const renderClips = () => {
    const c = document.getElementById('content')
    const locked = s.busy || ACTIVE.has(s.status)
    c.innerHTML = `
      <p class="muted small" style="margin-bottom:14px">Клипы по сценам. Неудачный можно перегенерировать отдельно — ролик пересоберётся сам.</p>
      <div class="board">${s.scenes
        .map(
          (sc, i) => `<div class="frame">
          <div class="media-wrap">${sc.clip ? `<video class="media" src="${runUrl(pid, rid, sc.clip)}?v=${encodeURIComponent(s.spentUsd)}" controls preload="metadata" playsinline></video>` : `<div class="placeholder">${locked ? '<span class="spinner"></span>' : ''}Сцена ${i + 1}</div>`}
            ${sc.clip && !locked ? `<div class="over"><button class="btn sm" data-redo-clip="${i}">${icon('refresh')} Заново</button></div>` : ''}</div>
          <div class="cap"><b>${i + 1}.</b> ${esc(s.script?.scenes[i]?.line || 'без слов')}</div>
        </div>`,
        )
        .join('')}</div>`
    c.querySelectorAll('[data-redo-clip]').forEach((b) => b.addEventListener('click', () => act({ type: 'redo', stage: 'clips', scene: Number(b.dataset.redoClip) })))
  }

  const renderFinal = () => {
    const c = document.getElementById('content')
    if (!s.final) {
      c.innerHTML = `<div class="card pad"><div class="row muted">${ACTIVE.has(s.status) ? '<span class="spinner"></span>' : ''} Ролик появится здесь после сборки</div></div>`
      return
    }
    const total = s.script?.scenes.reduce((a, x) => a + x.duration, 0) ?? 0
    c.innerHTML = `
      <div class="final">
        <video class="media" src="${runUrl(pid, rid, s.final)}?v=${encodeURIComponent(s.spentUsd)}" controls playsinline></video>
        <div class="facts">
          <div><h2>${esc(s.script?.title ?? '')}</h2><p class="muted small" style="margin-top:4px">${s.quality === 'final' ? 'Финальное качество' : 'Черновик'} · ~${total} с · 1080×1920</p></div>
          <dl class="summary">
            <dt>Хук</dt><dd>${esc(s.script?.scenes[0]?.line ?? '')}</dd>
            <dt>Креатор</dt><dd>${esc(s.script?.persona.look ?? '')}</dd>
            <dt>Стоимость</dt><dd>$${s.spentUsd.toFixed(2)}</dd>
          </dl>
        </div>
      </div>`
  }

  const renderAll = (force = false) => {
    renderHead()
    const next = JSON.stringify([tab, s.status, s.busy, s.quality, s.final, s.persona, s.refs, s.scenes, s.spentUsd, s.error])
    if (force || next !== sig) {
      sig = next
      if (tab === 0 && dirty) {
        // keep unsaved edits on screen
      } else [renderScript, renderFrames, renderClips, renderFinal][tab]()
    }
    renderBar()
  }

  const refresh = async (jump = false) => {
    const before = currentStage(s)
    s = await api('GET', base)
    // Follow the work forward unless the user is looking at something else on purpose.
    if (jump || (tab === before && currentStage(s) !== before && !dirty)) tab = currentStage(s)
    renderAll(jump)
  }

  renderAll(true)
  poll(refresh)
}

/** The step a variant is on: script → frames → video → done. */
function currentStage(s) {
  if (!s.script || s.status === 'awaiting_script') return 0
  if (s.final) return 3
  if (s.status === 'awaiting_keyframes' || s.scenes.some((x) => !x.keyframe)) return 1
  return 2
}

route()
