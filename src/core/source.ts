/**
 * Downloads the rules file and keeps the last good copy in module memory, for runtimes that keep
 * no process or connection between requests (serverless functions, Workers): no timer, no push
 * channel. The first download is awaited; after that a stale copy is answered at once and
 * refreshed in the background, so no visitor waits for it. Fails open: before the first good copy,
 * or with no rules address, there are no rules, and nothing throws.
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
    this.#options = {
      fetch: options.fetch ?? ((input, init) => fetch(input, init)),
      timeoutMs: 5000,
      retryMs: 30_000,
      maxBytes: 32 << 20,
      ...options,
      logger: options.logger,
    }
  }

  /** The rules in use now, without downloading. */
  get current(): RuleSet | null {
    return this.#rules
  }

  /** The rules in use, downloading them when due; null until the first download succeeds. */
  async get(keepAlive?: KeepAlive): Promise<RuleSet | null> {
    const now = Date.now()
    const due = this.#rules === null || now - this.#fetchedAt >= this.#rules.refresh * 1000
    if (due && now >= this.#nextTry) {
      this.#inflight ??= this.#download()
      if (this.#rules === null) {
        await this.#inflight
      } else {
        keepAlive?.(this.#inflight)
      }
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
    } finally {
      this.#inflight = null
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
