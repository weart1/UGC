import type { Brief } from './config.js'
import type { Analysis, Scene, Script } from './script.js'

const LANGUAGE_NAMES: Record<string, string> = { ru: 'Russian', en: 'English', uk: 'Ukrainian', kk: 'Kazakh' }

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code
}

/** Shared look that makes generations read as phone-shot UGC rather than an ad. */
const UGC_LOOK =
  'authentic UGC smartphone footage, vertical 9:16, shot on an iPhone front camera, natural indoor light, ' +
  'realistic skin texture, slight grain, casual unstaged home setting, no studio lighting, no text, no watermark'

export function analysisPrompt(example: string): string {
  return `You are a performance-marketing editor who reverse-engineers short-form UGC ads (TikTok, Reels, Shorts).

Below is a description of a reference video: frame captions with timestamps, cut points and, if available, the transcript.
Work out the structure that makes it convert, so it can be recreated for a different product.

REFERENCE:
${example}

Return ONLY a JSON object:
{
  "format": "name of the format, e.g. 'honest review', 'unboxing', '3 reasons', 'before/after', 'POV'",
  "hook": "how the first 1-3 seconds grab attention (technique, not the literal words)",
  "tone": "speaking style and energy",
  "pacing": "cut rhythm, average shot length",
  "beats": [
    { "purpose": "hook|problem|demo|proof|result|offer|cta|...", "seconds": 3, "shot": "framing and camera", "description": "what happens" }
  ],
  "onScreenText": "how text overlays are used",
  "cta": "how the video asks for action"
}`
}

export function scriptPrompt(opts: {
  brief: Brief
  analysis?: Analysis
  language: string
  minDuration: number
  maxDuration: number
  speaking: boolean
}): string {
  const { brief, analysis, language, minDuration, maxDuration, speaking } = opts
  const lang = languageName(language)
  const structure = analysis
    ? `Follow the structure of this reference ad closely (same beats, hook technique, pacing and tone), adapted to the product:\n${JSON.stringify(analysis, null, 2)}`
    : `Format: ${brief.format ?? 'honest first-person review: hook → problem → how I use it → result → offer → call to action'}`

  return `You write scripts for UGC video ads that look like a real person filmed them on a phone.
They must not feel like an ad: first person, casual, specific details, no slogans, no corporate words.

PRODUCT: ${brief.product.name}
${brief.product.description}
${brief.product.price ? `Price: ${brief.product.price}` : ''}
${brief.offer ? `Offer: ${brief.offer}` : ''}
AUDIENCE: ${brief.audience}
GOAL: ${brief.goal}
CREATOR: ${brief.persona ?? 'pick a creator who matches the audience'}
${brief.notes ? `NOTES: ${brief.notes}` : ''}

${structure}

Constraints:
- Total length about ${brief.targetSeconds} seconds.
- Each scene is ONE continuous shot of ${minDuration}-${maxDuration} seconds (integer). Prefer short scenes.
- The first scene is the hook: it must stop the scroll in under 2 seconds.
- "line" is what the creator says in ${lang}, natural spoken language, ~2.5 words per second of the scene${speaking ? '' : ' (it will be voice-over)'}. Empty string for silent b-roll.
- "onScreenText" is a short overlay in ${lang} (max 6 words) or "". Use it on the hook and the offer.
- "shot", "visual", "motion", "persona.look", "persona.voice" are in ENGLISH (they go to image/video models).
- "visual" describes the first frame only: who/what is in frame, pose, setting, light. Do not describe the creator's face/outfit there — that comes from persona.look.
- "motion" describes the action during the shot: gestures, product handling, camera moves (handheld, slight shake).
- Set "showsProduct": true when the product is visible.
- The same creator appears in every scene that has a person. Keep the setting consistent.

Return ONLY a JSON object:
{
  "title": "short internal name",
  "persona": { "look": "age, appearance, hair, outfit, setting", "voice": "voice description for a voice designer: gender, age, timbre, energy, accent" },
  "scenes": [
    { "purpose": "hook", "duration": 4, "shot": "...", "visual": "...", "motion": "...", "line": "...", "onScreenText": "...", "showsProduct": false }
  ]
}`
}

export function personaPrompt(script: Script): string {
  return `Portrait photo of a real person filming a selfie video: ${script.persona.look}. Looking into the camera, relaxed natural expression, upper body in frame. ${UGC_LOOK}`
}

export function keyframePrompt(script: Script, scene: Scene, hasProductRefs: boolean): string {
  const refs = [
    'Use the person from the first reference image: same face, hair and outfit.',
    hasProductRefs && scene.showsProduct
      ? 'The product must look exactly like in the other reference images: same packaging, shape, colors and label.'
      : '',
  ].join(' ')
  return `${scene.visual}. Camera: ${scene.shot}. ${refs} Creator: ${script.persona.look}. ${UGC_LOOK}`
}

export function clipPrompt(scene: Scene, opts: { speaking: boolean; language: string }): string {
  const speech =
    opts.speaking && scene.line
      ? ` The person speaks to the camera in ${languageName(opts.language)}, saying: "${scene.line}". Natural lip movement.`
      : scene.line
        ? ' The person talks to the camera (mouth moving naturally).'
        : ''
  return `${scene.motion}. Camera: ${scene.shot}, handheld phone footage with subtle natural shake.${speech} Realistic motion, consistent identity, no morphing, no text on screen.`
}
