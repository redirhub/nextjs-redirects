/**
 * Visit reports to the rules file's `@hits` address: one Apache combined line per redirect, frame
 * page or 404, as specified in redirhub/integration-spec (spec/v1/reports.txt is the golden sample).
 */

import type { Logger } from './log.ts'
import { PACKAGE, USER_AGENT } from '../version.ts'

/** The Referer and User-Agent are cut to this many bytes. */
const MAX_HEADER_FIELD = 1024

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export interface Hit {
  /** The visitor's address as the platform sets it; null writes `-`. */
  ip: string | null
  method: string
  /** `http` or `https`, as the visitor asked. */
  scheme: string
  /** The hostname as listed in the rules: lowercase, no port. */
  host: string
  /** The request URL; its escaped path and query are the request target. */
  url: URL
  status: number
  /** Body bytes sent: 0 for a redirect and a frame page. */
  size: number
  referer: string | null
  userAgent: string | null
  /** For a redirect or frame page: the rule's source column and the `Location` sent (the frame's src). */
  redirect?: { source: string; location: string }
}

/**
 * One report line:
 *
 *     203.0.113.9 - - [31/Oct/2026:19:10:00 +0000] "GET https://host/path?q HTTP/1.1" 301 0 "referer" "agent" file=host/path destination=https://…
 *
 * The protocol is always `HTTP/1.1`: the Fetch API does not say which one the visitor used.
 */
export function hitLine(hit: Hit, now: Date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  const time = `${two(now.getUTCDate())}/${MONTHS[now.getUTCMonth()]}/${now.getUTCFullYear()}:${two(now.getUTCHours())}:${two(now.getUTCMinutes())}:${two(now.getUTCSeconds())} +0000`
  const target = `${hit.scheme}://${hit.host}${hit.url.pathname}${hit.url.search}`
  let line =
    `${hit.ip ? escape(hit.ip) : '-'} - - [${time}] "${escape(hit.method)} ${fieldValue(target)} HTTP/1.1" ${hit.status} ${hit.size}` +
    ` "${orDash(escape(truncate(headerText(hit.referer))))}" "${orDash(escape(truncate(headerText(hit.userAgent))))}"`
  if (hit.redirect) {
    line += ` file=${fieldValue(hit.redirect.source)} destination=${orDash(fieldValue(hit.redirect.location))}`
  }
  return line
}

/** Backslash-escapes `"` and `\` and writes control characters as `\xHH`: a value never breaks the line. */
function escape(value: string): string {
  return value.replace(/["\\\x00-\x1f\x7f]/g, (c) =>
    c === '"' || c === '\\' ? `\\${c}` : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`
  )
}

/** Percent-encodes what cannot stand in the request line or a `key=value` field: spaces, quotes, backslashes, control characters. */
function fieldValue(value: string): string {
  return value.replace(/[\x00-\x20"\\\x7f]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

function orDash(value: string): string {
  return value === '' ? '-' : value
}

const utf8 = new TextEncoder()
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })
const lenientUtf8 = new TextDecoder('utf-8')

/**
 * A header value as text. Fetch gives header values one character per byte, so UTF-8 bytes
 * (`é` sent as C3 A9) arrive as two characters; they are read back as UTF-8, so the line carries
 * the bytes the visitor sent.
 */
function headerText(value: string | null): string {
  if (!value || !/[\x80-\xff]/.test(value) || /[^\x00-\xff]/.test(value)) {
    return value ?? ''
  }
  try {
    return strictUtf8.decode(Uint8Array.from(value, (c) => c.charCodeAt(0)))
  } catch {
    return value
  }
}

/** Cuts to at most MAX_HEADER_FIELD UTF-8 bytes, never inside a character. */
function truncate(value: string): string {
  const bytes = utf8.encode(value)
  if (bytes.length <= MAX_HEADER_FIELD) {
    return value
  }
  let cut = MAX_HEADER_FIELD
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) {
    cut--
  }
  return lenientUtf8.decode(bytes.subarray(0, cut))
}

/** Lets work outlive the response: `event.waitUntil`, `ctx.waitUntil`, `after`. */
export type KeepAlive = (work: Promise<unknown>) => void

export interface ReporterOptions {
  /** The integration key; without it nothing is sent. */
  key: string
  /** The `@hits` address of the rules in use, read when a batch is sent. */
  hitsUrl: () => string | null
  fetch?: typeof fetch
  logger?: Logger
  /** Per request; default 2000. */
  timeoutMs?: number
  /** Lines that may wait; more are dropped. Default 10,000. */
  maxQueue?: number
  /** How long one invocation keeps sending before it leaves the rest to the next; default 10,000. */
  budgetMs?: number
  /** Requests out at the same time; default 4. */
  maxInFlight?: number
}

const MAX_BATCH_LINES = 100
const MAX_BATCH_BYTES = 64 << 10
const DROP_LOG_EVERY_MS = 10 * 60_000

/**
 * Sends report lines without delaying a response and without a timer.
 *
 * A line queued while nothing is being sent goes out at once, so a site with little traffic
 * reports each visit immediately and keeps nothing waiting. Lines queued while requests are out
 * go together in the next one (at most 100 lines, 64 KB, gzip), so a burst costs one request per
 * hundred visits; up to `maxInFlight` (4) requests are out at once, so a busy instance keeps up.
 * The invocation that starts sending keeps itself alive (through `keepAlive`) until the queue is
 * empty and its requests are back; the others only add their line, so no request waits on
 * another request's work. A failed or rejected batch is dropped and counted, never retried.
 */
export class Reporter {
  #options: Required<Omit<ReporterOptions, 'logger'>> & { logger: Logger | undefined }
  #queue: string[] = []
  /** The sender: the invocation that started it keeps it alive until it is done. */
  #sending: Promise<void> | null = null
  /** The sender's requests out now, and when it started (for the budget); #running once it has. */
  #out = new Set<Promise<void>>()
  #started = 0
  #running = false
  /** Lines dropped since the last log, by reason. */
  #dropped = new Map<string, number>()
  #droppedSince = 0
  #lastDropLog = Number.NEGATIVE_INFINITY

  constructor(options: ReporterOptions) {
    // `??` per field, not a spread: an option passed as undefined keeps its default.
    this.#options = {
      key: options.key,
      hitsUrl: options.hitsUrl,
      fetch: options.fetch ?? ((input, init) => fetch(input, init)),
      logger: options.logger,
      timeoutMs: options.timeoutMs ?? 2000,
      maxQueue: options.maxQueue ?? 10_000,
      budgetMs: options.budgetMs ?? 10_000,
      maxInFlight: options.maxInFlight ?? 4,
    }
  }

  /** Queues one line; `keepAlive` holds the invocation open while this call has to send. */
  enqueue(line: string, keepAlive?: KeepAlive): void {
    if (this.#options.key === '') {
      return
    }
    this.#logDrops()
    if (this.#queue.length >= this.#options.maxQueue) {
      this.#drop(1, 'queue full')
      return
    }
    this.#queue.push(line)
    if (this.#sending === null) {
      this.#sending = this.#send()
      keepAlive?.(this.#sending)
    } else if (this.#running) {
      this.#fill()
    }
  }

  /** Resolves once everything queued so far has been sent or dropped. */
  async flush(): Promise<void> {
    while (this.#sending !== null) {
      await this.#sending
    }
    if (this.#queue.length > 0) {
      this.#sending = this.#send()
      await this.#sending
    }
  }

  async #send(): Promise<void> {
    // Lines queued in the same turn of the event loop go in the first request.
    await Promise.resolve()
    this.#started = Date.now()
    this.#running = true
    for (;;) {
      this.#fill()
      if (this.#out.size === 0) {
        // Checked and cleared in one step: a line queued after this starts a new sender.
        this.#running = false
        this.#sending = null
        return
      }
      await Promise.race(this.#out)
    }
  }

  /**
   * Starts requests for the waiting lines, within the budget: one when none is out, and more,
   * up to maxInFlight, only for full batches, so lines that arrive while a request is out wait
   * for it and go together. Called by the sender and on each line queued while it runs.
   */
  #fill(): void {
    while (
      this.#out.size < this.#options.maxInFlight &&
      this.#queue.length > 0 &&
      (this.#out.size === 0 || this.#queue.length >= MAX_BATCH_LINES) &&
      Date.now() - this.#started < this.#options.budgetMs
    ) {
      const post: Promise<void> = this.#post(this.#take()).finally(() => this.#out.delete(post))
      this.#out.add(post)
    }
  }

  #take(): string[] {
    const batch: string[] = []
    let bytes = 0
    while (batch.length < MAX_BATCH_LINES && this.#queue.length > 0) {
      const size = utf8.encode(this.#queue[0]).length + 1
      if (batch.length > 0 && bytes + size > MAX_BATCH_BYTES) {
        break
      }
      batch.push(this.#queue.shift() as string)
      bytes += size
    }
    return batch
  }

  async #post(lines: string[]): Promise<void> {
    const url = this.#options.hitsUrl()
    if (!url) {
      return
    }
    try {
      const text = `${lines.join('\n')}\n`
      const gzip = typeof CompressionStream === 'function'
      const body = gzip ? await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer() : text
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.#options.key}`,
        'Content-Type': 'text/plain',
        'User-Agent': USER_AGENT,
      }
      if (gzip) {
        headers['Content-Encoding'] = 'gzip'
      }
      const response = await this.#options.fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.#options.timeoutMs),
      })
      await response.body?.cancel()
      if (!response.ok) {
        this.#drop(lines.length, `status ${response.status}`)
      }
    } catch (error) {
      this.#drop(lines.length, error instanceof Error ? error.name : 'error')
    }
  }

  /** Counts dropped lines by reason; see #logDrops. */
  #drop(lines: number, reason: string): void {
    if (this.#dropped.size === 0) {
      this.#droppedSince = Date.now()
    }
    this.#dropped.set(reason, (this.#dropped.get(reason) ?? 0) + lines)
    this.#logDrops()
  }

  /**
   * Logs the dropped lines: the first drop at once, then at most once per ten minutes with the
   * total since the last log, by reason. Called on every drop and every line queued, so a count
   * is logged even after the drops stop, without a timer.
   */
  #logDrops(): void {
    if (this.#dropped.size === 0 || Date.now() - this.#lastDropLog < DROP_LOG_EVERY_MS) {
      return
    }
    const total = [...this.#dropped.values()].reduce((sum, n) => sum + n, 0)
    const reasons = [...this.#dropped].map(([reason, n]) => `${reason} ${n}`).join(', ')
    this.#options.logger?.warn(`${PACKAGE}: ${total} report lines dropped since ${new Date(this.#droppedSince).toISOString()} (${reasons})`)
    this.#dropped.clear()
    this.#lastDropLog = Date.now()
  }
}
