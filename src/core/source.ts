/**
 * Downloads the rules file and keeps the last good copy in module memory, for runtimes that keep
 * no process or connection between requests (serverless functions, Workers): no timer, no push
 * channel. Fails open: before the first good copy, or with no rules address, there are no rules,
 * and nothing throws.
 *
 * No visitor waits long for a download. The request that starts a new instance's first download
 * waits for it at most `firstWaitMs`; if it takes longer, that request goes on without rules and
 * the download finishes in the background. Requests that arrive while a download is running do
 * not wait at all. After the first copy, a stale copy is used at once and refreshed in the
 * background. Only the request that starts a download keeps it alive (`keepAlive`): no request
 * waits on another request's work.
 */

import type { Logger } from './log.ts'
import type { KeepAlive } from './report.ts'
import { parseRules, type RuleSet } from './rules.ts'
import { PACKAGE, USER_AGENT } from '../version.ts'

export interface RulesSourceOptions {
  /** The rules address from the dashboard. */
  url: string
  /** Next.js passes one that sets `cache: 'no-store'`, so its fetch cache stays out of the way. */
  fetch?: typeof fetch
  logger?: Logger
  /** Per download; default 5000. */
  timeoutMs?: number
  /** How long the request that starts the first download waits for it; default 1000. */
  firstWaitMs?: number
  /** After a failed download, wait this long before the next try; default 30,000. */
  retryMs?: number
  /** A larger file counts as a failed download; default 32 MB. */
  maxBytes?: number
}

const WARN_EVERY_MS = 10 * 60_000

export class RulesSource {
  #options: Required<Omit<RulesSourceOptions, 'logger'>> & { logger: Logger | undefined }
  #rules: RuleSet | null = null
  /** The ETag header as received, sent back in If-None-Match. */
  #etag = ''
  #fetchedAt = 0
  #nextTry = 0
  #inflight: Promise<void> | null = null
  #lastWarn = Number.NEGATIVE_INFINITY

  constructor(options: RulesSourceOptions) {
    // `??` per field, not a spread: an option passed as undefined keeps its default.
    this.#options = {
      url: options.url,
      fetch: options.fetch ?? ((input, init) => fetch(input, init)),
      logger: options.logger,
      timeoutMs: options.timeoutMs ?? 5000,
      firstWaitMs: options.firstWaitMs ?? 1000,
      retryMs: options.retryMs ?? 30_000,
      maxBytes: options.maxBytes ?? 32 << 20,
    }
  }

  /** The rules in use now, without downloading. */
  get current(): RuleSet | null {
    return this.#rules
  }

  /** The rules in use, starting a download when one is due; null while there are none. */
  async get(keepAlive?: KeepAlive): Promise<RuleSet | null> {
    const now = Date.now()
    const due = this.#rules === null || now - this.#fetchedAt >= this.#rules.refresh * 1000
    if (!due || now < this.#nextTry || this.#inflight !== null) {
      return this.#rules
    }
    // Cleared once settled; set first, so even a download that fails at once is cleared.
    const download = this.#download().finally(() => {
      this.#inflight = null
    })
    this.#inflight = download
    keepAlive?.(download)
    if (this.#rules === null) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([download, new Promise<void>((resolve) => (timer = setTimeout(resolve, this.#options.firstWaitMs)))])
      clearTimeout(timer)
    }
    return this.#rules
  }

  async #download(): Promise<void> {
    try {
      const headers: Record<string, string> = { 'User-Agent': USER_AGENT }
      if (this.#rules !== null && this.#etag !== '') {
        headers['If-None-Match'] = this.#etag
      }
      const response = await this.#options.fetch(this.#options.url, {
        headers,
        signal: AbortSignal.timeout(this.#options.timeoutMs),
      })
      if (response.status === 304 && this.#rules !== null) {
        await response.body?.cancel()
        this.#fetchedAt = Date.now()
        return
      }
      if (response.status !== 200) {
        await response.body?.cancel()
        this.#fail(`status ${response.status}`)
        return
      }
      if (Number(response.headers.get('content-length') ?? 0) > this.#options.maxBytes) {
        await response.body?.cancel()
        this.#fail('rules file too large')
        return
      }
      const body = await response.text()
      if (body.length > this.#options.maxBytes) {
        this.#fail('rules file too large')
        return
      }
      const etag = response.headers.get('etag') ?? ''
      this.#rules = parseRules(body, etag)
      this.#etag = etag
      this.#fetchedAt = Date.now()
    } catch (error) {
      this.#fail(error instanceof Error ? `${error.name}: ${error.message}` : 'error')
    }
  }

  #fail(reason: string): void {
    const now = Date.now()
    this.#nextTry = now + this.#options.retryMs
    if (now - this.#lastWarn >= WARN_EVERY_MS) {
      this.#lastWarn = now
      this.#options.logger?.warn(`${PACKAGE}: rules download failed (${reason}); ${this.#rules ? 'keeping the last good copy' : 'no rules yet'}`)
    }
  }
}
