import type { Brief } from './config.js'
import type { Analysis, Scene, Script } from './script.js'
import type { Recording, RunState } from './state.js'

const LANGUAGE_NAMES: Record<string, string> = { ru: 'Russian', en: 'English', es: 'Spanish', pt: 'Portuguese', de: 'German' }

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code
}

/** Shared look that makes generations read as phone-shot UGC rather than an ad. */
const UGC_LOOK =
  'authentic UGC smartphone footage, vertical 9:16, shot on an iPhone front camera, natural indoor light, ' +
  'realistic skin texture, slight grain, casual unstaged home setting, no studio lighting, no captions, no watermark'

export function analysisPrompt(example: string): string {
  return `You are a performance-marketing editor who reverse-engineers short-form UGC ads (TikTok, Reels, Shorts).

Below is a description of a reference video: frame captions with timestamps, cut points and, if available, the transcript.
Work out the structure that makes it convert, so it can be recreated for a different product.

REFERENCE:
${example}

Return ONLY a JSON object:
{
  "format": "name of the format, e.g. 'honest review', 'app demo', '3 reasons', 'before/after', 'POV', 'green screen'",
  "hook": "how the first 1-3 seconds grab attention (technique, plus the literal words if known)",
  "tone": "speaking style and energy",
  "pacing": "cut rhythm, average shot length",
  "beats": [
    { "purpose": "hook|problem|demo|proof|result|offer|cta|...", "seconds": 3, "shot": "framing and camera", "description": "what happens and what is said" }
  ],
  "onScreenText": "how text overlays are used",
  "cta": "how the video asks for action"
}`
}

function productSection(brief: Brief, recordings: Recording[]): string {
  if (brief.product.type !== 'app') {
    return `- Set "showsProduct": true when the product is visible; its real photos are used as references.
- "screen" is always null.`
  }
  const recs = recordings.length
    ? recordings.map((r, i) => `  [${i}] ${r.duration.toFixed(1)}s — ${r.description}`).join('\n')
    : '  (none)'
  return `The product is a MOBILE APP. Show it in two ways:
- "showsProduct": true → the creator holds a phone with the app on screen (app screenshots are passed as references). Use it for reaction / "look at this" beats.
- "screen": {"recording": N, "start": seconds, "layout": "full" | "pip"} → cut to a real screen recording while the creator keeps talking.
  "full" fills the frame with the recording (the voice continues), "pip" shows it in a box over the creator.
  Use it for demo beats — that is where the real interface must be visible. Pick "start" so the recording shows the moment the line talks about.
  Otherwise "screen": null.
Available screen recordings:
${recs}`
}

function creatorSection(brief: Brief, personaDescription?: string): string {
  const st = brief.style
  const wanted = [
    st.creatorGender && `gender: ${st.creatorGender}`,
    st.creatorAge && `age: ${st.creatorAge}`,
    st.setting && `filming location: ${st.setting}`,
    brief.persona,
  ].filter(Boolean)
  if (personaDescription && brief.personaRefs.length) {
    return brief.personaMode === 'exact'
      ? `CREATOR: fixed — the person from the reference photos (${personaDescription}). "persona.look" must describe THIS person's appearance, plus outfit and setting${wanted.length ? ` (${wanted.join('; ')})` : ''}.`
      : `CREATOR: a different person of a similar type and style to the reference photos (${personaDescription})${wanted.length ? `; ${wanted.join('; ')}` : ''}.`
  }
  return `CREATOR: ${wanted.length ? wanted.join('; ') : 'pick a creator who matches the audience'}`
}

function messageSection(brief: Brief, lang: string): string {
  if (!brief.talkingPoints) return ''
  return brief.talkingMode === 'verbatim'
    ? `WHAT THE CREATOR SAYS — use this text VERBATIM as the spoken lines (translate to ${lang} only if it is in another language), only split it into scenes; do not add, drop or reword sentences:
${brief.talkingPoints}`
    : `WHAT THE CREATOR TALKS ABOUT — cover every point, in this order where it makes sense, in the creator's own casual words:
${brief.talkingPoints}`
}

export function scriptPrompt(opts: {
  brief: Brief
  analysis?: Analysis
  recordings: Recording[]
  variant: RunState['variant']
  personaDescription?: string
  language: string
  minDuration: number
  maxDuration: number
  speaking: boolean
}): string {
  const { brief, analysis, recordings, variant, language, minDuration, maxDuration, speaking } = opts
  const fixedCreator = brief.personaRefs.length > 0 && brief.personaMode === 'exact'
  const lang = languageName(language)
  const structure = analysis
    ? `Follow the structure of this reference ad closely (same beats, hook technique, pacing and tone), adapted to the product:\n${JSON.stringify(analysis, null, 2)}`
    : `Format: ${brief.format ?? 'honest first-person review: hook → problem → how I use it → result → offer → call to action'}`
  const variation =
    variant.total > 1
      ? `\nThis is variant ${variant.index + 1} of ${variant.total} for an A/B test. Keep the structure, but use a clearly different hook angle${fixedCreator ? ' (the creator stays the same person; you may change outfit and location)' : ' and a different creator (age, gender, style, setting) within the CREATOR constraints'} from the earlier variants:\n${variant.avoid.map((a) => `- ${a}`).join('\n') || '- (this is the first one)'}\n`
      : ''

  return `You write scripts for UGC video ads that look like a real person filmed them on a phone.
They must not feel like an ad: first person, casual, specific details, no slogans, no corporate words.

PRODUCT: ${brief.product.name}
${brief.product.description}
${brief.product.price ? `Price: ${brief.product.price}` : ''}
${brief.offer ? `Offer: ${brief.offer}` : ''}
AUDIENCE: ${brief.audience}
GOAL: ${brief.goal}
${creatorSection(brief, opts.personaDescription)}
${brief.style.tone ? `TONE: ${brief.style.tone}` : ''}
${brief.style.hookStyle ? `HOOK STYLE: ${brief.style.hookStyle}` : ''}
${brief.notes ? `NOTES: ${brief.notes}` : ''}
${messageSection(brief, lang)}

${structure}
${variation}
Constraints:
- Total length about ${brief.targetSeconds} seconds.
- Each scene is ONE continuous shot of ${minDuration}-${maxDuration} seconds (integer). Prefer short scenes.
- The first scene is the hook: it must stop the scroll in under 2 seconds.
- "line" is what the creator says in ${lang}: natural spoken language, ~2.5 words per second of the scene${speaking ? ' — the video model will lip-sync it, so keep it short enough to fit' : ' (it will be voice-over)'}. Empty string for silent b-roll.
- "onScreenText" is a short overlay in ${lang} (max 6 words) or "". Use it on the hook and the offer.
- "shot", "visual", "motion", "persona.look", "persona.voice" are in ENGLISH (they go to image/video models).
- "visual" describes the first frame only: who/what is in frame, pose, setting, light. Do not describe the creator's face/outfit there — that comes from persona.look.
- "motion" describes the action during the shot: gestures, product handling, camera moves (handheld, slight shake).
- The same creator appears in every scene that has a person. Keep the setting consistent.
${productSection(brief, recordings)}

Return ONLY a JSON object:
{
  "title": "short internal name",
  "persona": { "look": "age, gender, appearance, hair, outfit, setting", "voice": "gender, age, timbre, energy, accent" },
  "scenes": [
    { "purpose": "hook", "duration": 4, "shot": "...", "visual": "...", "motion": "...", "line": "...", "onScreenText": "...", "showsProduct": false, "screen": null }
  ]
}`
}

export function personaPrompt(script: Script, refs?: 'exact' | 'inspired'): string {
  const ref =
    refs === 'exact'
      ? 'The same person as in the reference photos: keep the face, skin tone, hair and body identical. '
      : refs === 'inspired'
        ? 'A different person of a similar type and style to the reference photos — not the same face. '
        : ''
  return `${ref}Portrait photo of a real person filming a selfie video: ${script.persona.look}. Looking into the camera, relaxed natural expression, upper body in frame. ${UGC_LOOK}`
}

export function keyframePrompt(script: Script, scene: Scene, product: { type: 'physical' | 'app'; hasRefs: boolean }): string {
  let productRef = ''
  if (scene.showsProduct) {
    if (product.type === 'app') {
      productRef = product.hasRefs
        ? 'The person holds a smartphone; its screen shows the app exactly as in the other reference images (same UI, layout, colors).'
        : 'The person holds a smartphone with an app open on screen.'
    } else if (product.hasRefs) {
      productRef = 'The product must look exactly like in the other reference images: same packaging, shape, colors and label.'
    }
  }
  return `${scene.visual}. Camera: ${scene.shot}. Use the person from the first reference image: same face, hair and outfit. ${productRef} Creator: ${script.persona.look}. ${UGC_LOOK}`
}

export function clipPrompt(scene: Scene, opts: { speaking: boolean; language: string; voice: string }): string {
  const speech =
    opts.speaking && scene.line
      ? ` The person speaks to the camera in ${languageName(opts.language)} (${opts.voice}), saying: "${scene.line}". Natural lip sync, no background music.`
      : scene.line
        ? ' The person talks to the camera (mouth moving naturally).'
        : ''
  return `${scene.motion}. Camera: ${scene.shot}, handheld phone footage with subtle natural shake.${speech} Realistic motion, consistent identity, no morphing, no text on screen.`
}
