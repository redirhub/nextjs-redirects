/**
 * Next.js (`proxy.ts` in Next 16+, `middleware.ts` before): the check path and exact rules,
 * before the app's own routes.
 *
 * The proxy never sees a page's final status, so there is no catch-all and no 404 report here;
 * where your app does see the final answer (a route handler), `createRedirects(…).afterSite` adds
 * them.
 */

import { createRedirects, type RedirectsOptions, type WaitUntil } from './core/redirects.ts'

export interface ProxyOptions extends Omit<RedirectsOptions, 'report404'> {}

/**
 * Returns the proxy step: a Response to send, or undefined to let the app answer.
 *
 * ```ts
 * const redirects = createProxy({ rulesUrl: process.env.ACME_RULES_URL, key: process.env.ACME_INTEGRATION_KEY })
 *
 * export async function proxy(request: NextRequest, event: NextFetchEvent) {
 *   const answer = await redirects(request, event)
 *   if (answer) return answer
 *   // … the app's own proxy logic
 * }
 * ```
 */
export function createProxy(options: ProxyOptions): (request: Request, event?: WaitUntil) => Promise<Response | undefined> {
  const baseFetch = options.fetch ?? ((input, init) => fetch(input, init))
  const redirects = createRedirects({
    clientIp: vercelClientIp,
    scheme: forwardedScheme,
    ...options,
    // Next.js caches fetch by default in some versions; the rules must always be fresh.
    fetch: (input, init) => baseFetch(input, { ...init, cache: 'no-store' } as RequestInit),
  })
  return async (request, event) => (await redirects.handle(request, event)) ?? undefined
}

/** On Vercel the first `X-Forwarded-For` address, which Vercel overwrites. Self-hosted, pass `clientIp` for your proxy. */
export function vercelClientIp(request: Request): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null
}

/** The scheme the visitor used: the first `X-Forwarded-Proto`, else the request URL's. */
export function forwardedScheme(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  return forwarded === 'http' || forwarded === 'https' ? forwarded : new URL(request.url).protocol.replace(/:$/, '')
}

export { anonymize, createRedirects, type Redirects, type RedirectsOptions, type WaitUntil } from './core/redirects.ts'
export type { Logger } from './core/log.ts'
export { hitLine, type Hit, type KeepAlive, Reporter, type ReporterOptions } from './core/report.ts'
export {
  buildLocation,
  DEFAULT_CHECK_PATH,
  FORMAT_MAJOR,
  type HostRules,
  matchExact,
  matchPath,
  normalizeHost,
  parseRules,
  type RedirectStatus,
  type Rule,
  type RuleSet,
  UnknownFormatError,
} from './core/rules.ts'
export { RulesSource, type RulesSourceOptions } from './core/source.ts'
export { PACKAGE, USER_AGENT, VERSION } from './version.ts'
