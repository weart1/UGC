export interface Cue {
  start: number
  end: number
  text: string
}

/** Splits a spoken line into short caption chunks, TikTok style. */
export function chunkWords(text: string, maxWords = 4): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const chunks: string[] = []
  for (let i = 0; i < words.length; i += maxWords) chunks.push(words.slice(i, i + maxWords).join(' '))
  return chunks
}

/**
 * Spreads `texts` over [start, end] in proportion to their length — a fair
 * guess at speech timing when no word timestamps are available.
 */
export function spreadCues(texts: string[], start: number, end: number): Cue[] {
  const weights = texts.map((t) => Math.max(1, t.replace(/\s+/g, '').length))
  const total = weights.reduce((a, b) => a + b, 0)
  const cues: Cue[] = []
  let t = start
  texts.forEach((text, i) => {
    const len = ((end - start) * (weights[i] ?? 1)) / total
    cues.push({ start: t, end: t + len, text })
    t += len
  })
  return cues
}

/** One voiceover for the whole script: captions follow the voice, not the scene cuts. */
export function voiceoverCues(lines: string[], voiceDuration: number): Cue[] {
  const chunks = lines.flatMap((l) => chunkWords(l))
  return spreadCues(chunks, 0, voiceDuration)
}

/** Each scene speaks its own line: captions stay inside the scene's time window. */
export function perSceneCues(scenes: { line: string; start: number; end: number }[]): Cue[] {
  return scenes.flatMap((s) => {
    const chunks = chunkWords(s.line)
    if (!chunks.length) return []
    const pad = Math.min(0.2, (s.end - s.start) / 10)
    return spreadCues(chunks, s.start + pad, s.end - pad)
  })
}

function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  const c = cs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`
}

function assText(text: string): string {
  return text.replace(/[{}]/g, '').replace(/\r?\n/g, '\\N')
}

/** Builds an ASS file: spoken captions in the lower third, text overlays at the top. */
export function buildAss(opts: {
  width: number
  height: number
  font: string
  captions: Cue[]
  overlays: Cue[]
}): string {
  const { width, height, font } = opts
  const size = Math.round(height / 26)
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,${font},${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${Math.round(size / 9)},0,2,60,60,${Math.round(height * 0.28)},1
Style: Overlay,${font},${Math.round(size * 0.9)},&H00000000,&H00000000,&H00FFFFFF,&H00FFFFFF,-1,0,0,0,100,100,0,0,3,${Math.round(size / 4)},0,8,80,80,${Math.round(height * 0.12)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`
  const line = (style: string, c: Cue) =>
    `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},${style},,0,0,0,,${assText(c.text)}`
  return header + [...opts.overlays.map((c) => line('Overlay', c)), ...opts.captions.map((c) => line('Caption', c))].join('\n') + '\n'
}
