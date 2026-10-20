/** Which prompt a text call answers; the fake generator uses it to pick a fixture. */
export type TextKind = 'analysis' | 'script'

/**
 * Everything the pipeline needs from a model provider. Media inputs are refs
 * returned by `upload` (a Runware media UUID, or a local path for the fake).
 */
export interface Generator {
  text(kind: TextKind, prompt: string): Promise<string>
  caption(imagePath: string): Promise<string>
  upload(filePath: string): Promise<string>
  image(req: { prompt: string; refs: string[] }): Promise<Buffer>
  video(req: { prompt: string; firstFrame: string; duration: number }): Promise<Buffer>
  speech(req: { text: string; voice: string }): Promise<Buffer>
  /** USD spent so far in this process, as reported by the provider. */
  spentUsd(): number
}
