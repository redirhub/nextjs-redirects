/**
 * The integration on any runtime with the Fetch API (Request, Response, fetch): answers the check
 * path, redirects exact rules before the site, redirects a hostname's catch-all where the site
 * answers 404, and reports redirects and 404s. The platform entry (`src/index.ts`) only says
 * where the visitor's address and the background work come from.
 *
 * `src/core/` is the same in every JavaScript implementation (nextjs-redirects,
 * cloudflare-redirects); CI compares it with the others.
 */

import type { Logger } from './log.ts'
import { hitLine, type KeepAlive, Reporter } from './report.ts'
import { buildLocation, type HostRules, matchExact, normalizeHost, type Rule, type RuleSet } from './rules.ts'
import { RulesSource } from './source.ts'
import { PACKAGE } from '../version.ts'

export interface RedirectsOptions {
  /** The rules address from the dashboard. Empty: the integration is off and every request passes. */
  rulesUrl: string | null | undefined
  /** The integration key. Without it redirects work and nothing is reported. */
  key?: string | null
  /**
   * Whether to report, over the key: `false` reports nothing, a function decides per request
   * (e.g. not for preview deployments). Default: report whenever there is a key.
   */
  report?: boolean | ((request: Request) => boolean)
  /**
   * Which 404 answers of the site are reported (where the site's answer is seen, `afterSite`):
   * `rules` (default) for hostnames whose `@host` line has `report404`, `all` for every hostname.
   */
  report404?: 'rules' | 'all'
  /**
   * The hostname to look up in the rules, report and answer the check path for. Return null to
   * leave the request alone: no rules are loaded for it and nothing is reported. Default: the
   * `Host` header (behind `next start` the request URL names the server, not the site), else the
   * request URL's host. Any letter case and a port are fine.
   */
  hostname?: (request: Request) => string | null
  /**
   * The path the visitor asked for, percent-encoded as in a URL (`/caf%C3%A9`): it is matched,
   * appended by a catch-all with `p` and reported. Return null to leave the request alone, as with
   * `hostname`. Default: the request URL's path. Set it where the platform changed the path before
   * your code sees it, e.g. a proxy that strips a prefix.
   */
  path?: (request: Request) => string | null
  /**
   * The `Location` to send, from the one the rule gives (e.g. a same-site target in the visitor's
   * language). It is also what the report names as the destination. Default: as the rule gives it.
   */
  location?: (location: string, request: Request) => string
  /**
   * The visitor's address in reports: only a value the platform sets, never a header a client can
   * forge. Null writes `-`.
   */
  clientIp?: (request: Request) => string | null
  /** The User-Agent in reports. Default: the `User-Agent` header. Null writes `-`. */
  userAgent?: (request: Request) => string | null
  /** `http` or `https` as the visitor asked; default the request URL's scheme. */
  scheme?: (request: Request) => string
  /** Report IPv4 addresses with the last byte zeroed and IPv6 addresses cut to /48. */
  anonymizeIp?: boolean
  /** Default `console`; null logs nothing. */
  logger?: Logger | null
}

/**
 * What the platform entry and the tests set, and users do not: the platform entries export a
 * `createRedirects` that takes RedirectsOptions only.
 */
export interface InternalOptions extends RedirectsOptions {
  /** Next.js passes one that sets `cache: 'no-store'`; tests pass fakes. */
  fetch?: typeof fetch
  /** The clock report lines are stamped with; tests fix it. */
  now?: () => Date
  /** How long the request that starts the first rules download waits for it; default 1000. */
  firstWaitMs?: number
}

/** What lets work outlive the response: Next's `event`, a Worker's `ctx`. */
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void
}

export interface Redirects {
  /**
   * Before the site: the check path's answer or an exact rule's redirect, or null to let the site
   * answer. Never throws.
   */
  handle(request: Request, context?: WaitUntil): Promise<Response | null>
  /**
   * After the site answered a request `handle` passed: its 404 becomes the catch-all's redirect,
   * or is reported; any other answer is returned unchanged.
   */
  afterSite(request: Request, response: Response, context?: WaitUntil): Promise<Response>
  /** `handle`, then the site (`next`), then `afterSite`. */
  serve(request: Request, next: (request: Request) => Promise<Response>, context?: WaitUntil): Promise<Response>
  /** Sends the report lines still waiting (tests, graceful shutdown). */
  flush(): Promise<void>
}

const WARN_EVERY_MS = 10 * 60_000

export function createRedirects(options: InternalOptions): Redirects {
  const logger = options.logger === undefined ? console : (options.logger ?? undefined)
  const rulesUrl = options.rulesUrl?.trim() ?? ''
  const source = rulesUrl === '' ? null : new RulesSource({ url: rulesUrl, fetch: options.fetch, firstWaitMs: options.firstWaitMs, logger })
  const key = options.key?.trim() ?? ''
  const reporter =
    source && key !== '' ? new Reporter({ key, hitsUrl: () => source.current?.hitsUrl ?? null, fetch: options.fetch, logger }) : null
  const now = options.now ?? (() => new Date())
  let lastWarn = Number.NEGATIVE_INFINITY

  const warn = (error: unknown) => {
    if (Date.now() - lastWarn >= WARN_EVERY_MS) {
      lastWarn = Date.now()
      logger?.warn(`${PACKAGE}: request passed on after an error (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  /**
   * What the visitor asked for: the hostname as listed in the rules (lowercase, no port) and the
   * URL with the visitor's path, or null when `hostname` or `path` leaves the request alone.
   */
  const visitOf = (request: Request): { name: string; url: URL } | null => {
    const url = new URL(request.url)
    const hostname = options.hostname ? options.hostname(request) : (request.headers.get('host') ?? url.host)
    const name = hostname === null ? '' : normalizeHost(hostname)
    const path = options.path ? options.path(request) : url.pathname
    if (name === '' || path === null) {
      return null
    }
    url.pathname = path
    return { name, url }
  }

  const keepAliveOf = (context?: WaitUntil): KeepAlive | undefined => (context ? (work) => context.waitUntil(work) : undefined)

  const report = (request: Request, url: URL, host: string, status: number, size: number, keepAlive: KeepAlive | undefined, redirect?: { source: string; location: string }) => {
    if (!reporter || options.report === false || (typeof options.report === 'function' && !options.report(request))) {
      return
    }
    const ip = options.clientIp?.(request) ?? null
    reporter.enqueue(
      hitLine(
        {
          ip: ip && options.anonymizeIp ? anonymize(ip) : ip,
          method: request.method,
          scheme: options.scheme?.(request) ?? url.protocol.replace(/:$/, ''),
          host,
          url,
          status,
          size,
          referer: request.headers.get('referer'),
          userAgent: options.userAgent ? options.userAgent(request) : request.headers.get('user-agent'),
          redirect,
        },
        now()
      ),
      keepAlive
    )
  }

  const redirect = (request: Request, url: URL, rules: RuleSet, host: HostRules, rule: Rule, keepAlive: KeepAlive | undefined): Response => {
    const target = buildLocation(rule, url)
    const location = options.location ? options.location(target, request) : target
    const headers = new Headers({ Location: byteString(location) })
    if (rules.poweredBy) {
      headers.set('X-Powered-By', rules.poweredBy)
    }
    report(request, url, host.name, rule.status, 0, keepAlive, { source: rule.source, location })
    return new Response(null, { status: rule.status, headers })
  }

  const handle = async (request: Request, context?: WaitUntil): Promise<Response | null> => {
    if (!source || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return null
    }
    try {
      // Before the rules: a request the integration leaves alone never waits for them.
      const visit = visitOf(request)
      if (visit === null) {
        return null
      }
      const { name, url } = visit
      const keepAlive = keepAliveOf(context)
      const rules = await source.get(keepAlive)
      const host = rules?.hosts.get(name)
      if (!rules || !host) {
        return null
      }
      if (url.pathname === rules.checkPath) {
        const body = `token=${host.token} etag=${rules.etag}`
        return new Response(request.method === 'HEAD' ? null : body, {
          status: 200,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(new TextEncoder().encode(body).length) },
        })
      }
      const rule = matchExact(host, url)
      return rule ? redirect(request, url, rules, host, rule, keepAlive) : null
    } catch (error) {
      warn(error)
      return null
    }
  }

  const afterSite = async (request: Request, response: Response, context?: WaitUntil): Promise<Response> => {
    if (response.status !== 404 || !source || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return response
    }
    try {
      const rules = source.current
      if (!rules) {
        return response
      }
      const visit = visitOf(request)
      if (visit === null) {
        return response
      }
      const { name, url } = visit
      const host = rules.hosts.get(name)
      const keepAlive = keepAliveOf(context)
      if (host?.catchAll) {
        await response.body?.cancel()
        return redirect(request, url, rules, host, host.catchAll, keepAlive)
      }
      if (host?.report404 || options.report404 === 'all') {
        report(request, url, name, 404, Number(response.headers.get('content-length') ?? 0) || 0, keepAlive)
      }
      return response
    } catch (error) {
      warn(error)
      return response
    }
  }

  return {
    handle,
    afterSite,
    async serve(request, next, context) {
      return (await handle(request, context)) ?? afterSite(request, await next(request), context)
    },
    async flush() {
      await reporter?.flush()
    },
  }
}

/** Header values carry bytes: a UTF-8 target is sent as its UTF-8 bytes, as other implementations do. */
function byteString(value: string): string {
  return /^[\x00-\x7f]*$/.test(value) ? value : String.fromCharCode(...new TextEncoder().encode(value))
}

/** IPv4 with the last byte zeroed, IPv6 cut to its first 48 bits; anything else unchanged. */
export function anonymize(ip: string): string {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.replace(/\.\d{1,3}$/, '.0')
  }
  if (ip.includes(':')) {
    const [head, tail = ''] = ip.split('::')
    const left = head === '' ? [] : head.split(':')
    const right = tail === '' ? [] : tail.split(':')
    const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left
    return `${groups.slice(0, 3).join(':')}::`
  }
  return ip
}
