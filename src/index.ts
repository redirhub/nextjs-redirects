/**
 * Next.js (`proxy.ts` in Next 16+, `middleware.ts` before): the check path, exact rules and frame
 * pages, before the app's own routes.
 *
 * The proxy never sees a page's final status, so there is no catch-all and no 404 report here;
 * where your app does see the final answer (a route handler), `createRedirects(…).afterSite` adds
 * them.
 */

import { createRedirects as create, type Redirects, type RedirectsOptions, type WaitUntil } from './core/redirects.ts'

export type { Logger } from './core/log.ts'
export type { Redirects, RedirectsOptions, WaitUntil }

export interface ProxyOptions extends Omit<RedirectsOptions, 'report404'> {}

/**
 * Returns the proxy step: a Response to send, or undefined to let the app answer.
 *
 * ```ts
 * const redirects = createProxy({ rulesUrl: process.env.ACME_RULES_URL, key: process.env.ACME_INTEGRATION_KEY })
 *
 * export async function proxy(request: NextRequest, event: NextFetchEvent) {
 *   const response = await redirects(request, event)
 *   if (response) return response
 *   // … the app's own proxy logic
 * }
 * ```
 */
export function createProxy(options: ProxyOptions): (request: Request, event?: WaitUntil) => Promise<Response | undefined> {
  const redirects = createRedirects(options)
  return async (request, event) => (await redirects.handle(request, event)) ?? undefined
}

/**
 * The integration in two steps, for code that sees the app's final answer (a route handler):
 * `handle` before it, `afterSite` after it (the catch-all and 404 reports). Same defaults as
 * `createProxy`: the visitor's address from `X-Forwarded-For`, the scheme from `X-Forwarded-Proto`.
 */
export function createRedirects(options: RedirectsOptions): Redirects {
  return create({
    ...options,
    clientIp: options.clientIp ?? vercelClientIp,
    scheme: options.scheme ?? forwardedScheme,
    // Next.js caches fetch by default in some versions; the rules must always be fresh.
    fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' } as RequestInit),
  })
}

/** On Vercel the first `X-Forwarded-For` address, which Vercel overwrites. */
function vercelClientIp(request: Request): string | null {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null
}

/** The scheme the visitor used: the first `X-Forwarded-Proto`, else the request URL's. */
function forwardedScheme(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  return forwarded === 'http' || forwarded === 'https' ? forwarded : new URL(request.url).protocol.replace(/:$/, '')
}
