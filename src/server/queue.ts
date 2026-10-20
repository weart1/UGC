const LOG_LINES = 300

/**
 * In-process job runner: at most `limit` jobs at once, one job per key (a
 * project or a run), and a short log per key for the panel to show.
 */
export class JobQueue {
  private active = new Set<string>()
  private waiting: { key: string; fn: (log: (msg: string) => void) => Promise<unknown> }[] = []
  private logs = new Map<string, string[]>()

  constructor(private readonly limit: number) {}

  busy(key: string): boolean {
    return this.active.has(key) || this.waiting.some((j) => j.key === key)
  }

  /** Queues `fn` unless the same key is already queued or running. */
  push(key: string, fn: (log: (msg: string) => void) => Promise<unknown>): boolean {
    if (this.busy(key)) return false
    this.waiting.push({ key, fn })
    this.pump()
    return true
  }

  log(key: string): string[] {
    return this.logs.get(key) ?? []
  }

  private append(key: string, msg: string) {
    const lines = this.logs.get(key) ?? []
    lines.push(`${new Date().toISOString().slice(11, 19)} ${msg}`)
    if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES)
    this.logs.set(key, lines)
    console.log(`[${key}] ${msg}`)
  }

  private pump() {
    while (this.active.size < this.limit) {
      const job = this.waiting.shift()
      if (!job) return
      this.active.add(job.key)
      const log = (msg: string) => this.append(job.key, msg)
      job
        .fn(log)
        .catch((err) => log(`Ошибка: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => {
          this.active.delete(job.key)
          this.pump()
        })
    }
  }
}
