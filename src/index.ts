/**
 * Next.js (`proxy.ts` in Next 16+, `middleware.ts` before): the check path, exact rules and frame
 * pages, before the app's own routes.
 *
 * The proxy never sees a page's final status, so the app's 404 page tells it: the page loads
 * `<script async src="/_redirhub/404">` (beside the rules' check path), which the proxy serves; the script posts the page's
 * address back, and the proxy reports the 404 or answers the hostname's catch-all, which the
 * script follows. Where your app sees the final answer itself (a route handler),
 * `createRedirects(…).afterSite` does the same on the server.
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
  return async (request, event) => {
    const { pathname } = new URL(request.url)
    if (pathname.endsWith('/404') && pathname === notFoundPath(await redirects.checkPath(event))) {
      return notFound(redirects, request, pathname, event)
    }
    return (await redirects.handle(request, event)) ?? undefined
  }
}

/**
 * Where the 404 page's script comes from and posts to: beside the check path, `404` in place of
 * its last segment (`/_redirhub/check` gives `/_redirhub/404`), so it carries the platform's own
 * name. Null for a check path at the root, where `/404` could be the site's own page.
 */
export function notFoundPath(checkPath: string | null): string | null {
  const folder = checkPath?.slice(0, checkPath.lastIndexOf('/')) ?? ''
  return folder === '' ? null : `${folder}/404`
}

/** The longest body the 404 script may post: its address and its Referer. */
const MAX_NOT_FOUND_BODY = 8192

/**
 * Posts the page's address and Referer to `path`; follows a catch-all's answer (a `location` to
 * go to, or a frame page to show). One request per page load; never throws into the page.
 */
const notFoundScript = (path: string) => `fetch(${JSON.stringify(path)},{method:"POST",keepalive:true,headers:{"Content-Type":"text/plain"},body:location.href+"\\n"+document.referrer}).then(function(r){return r.status===200?r.json():null}).then(function(a){if(a&&a.location)location.replace(a.location);else if(a&&a.html){document.open();document.write(a.html);document.close()}}).catch(function(){})
`

/**
 * `GET`: the script. `POST`: the 404 page at the address in the body was shown on this hostname;
 * it goes through `afterSite` as a 404 answer, so it is reported (`report404`) or the catch-all
 * answers: `200` with `{ location }` or `{ html }` for the script, `204` otherwise. An address on
 * another hostname, or a body that is not one, is ignored (`204`): nothing is reported.
 */
async function notFound(redirects: Redirects, request: Request, path: string, event?: WaitUntil): Promise<Response> {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return new Response(request.method === 'HEAD' ? null : notFoundScript(path), {
      headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
    })
  }
  const nothing = () => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD, POST' } })
  }
  const body = await request.text().catch(() => '')
  const [address = '', referer = ''] = body.slice(0, MAX_NOT_FOUND_BODY).split('\n')
  const page = URL.canParse(address) ? new URL(address) : null
  const host = (request.headers.get('host') ?? new URL(request.url).host).toLowerCase()
  if (!page || (page.protocol !== 'https:' && page.protocol !== 'http:') || page.host.toLowerCase() !== host || page.pathname === path) {
    return nothing()
  }
  // The visit as the server would have seen it: the page's path and query, the visitor's own
  // headers (address, User-Agent) and the page's Referer.
  const headers = new Headers(request.headers)
  headers.delete('content-type')
  headers.delete('content-length')
  headers.set('x-forwarded-proto', page.protocol.replace(/:$/, ''))
  if (referer.trim() === '') {
    headers.delete('referer')
  } else {
    headers.set('referer', referer.trim())
  }
  const visit = new Request(new URL(page.pathname + page.search, request.url), { headers })
  const answer = await redirects.afterSite(visit, new Response(null, { status: 404 }), event)
  if (answer.status === 404) {
    return nothing()
  }
  const location = answer.headers.get('location')
  const reply = location ? { location: latin1ToUtf8(location) } : { html: await answer.text() }
  return Response.json(reply, { headers: { 'Cache-Control': 'no-store' } })
}

/** A `Location` header carries UTF-8 bytes one per character (see byteString in core); read them back. */
function latin1ToUtf8(value: string): string {
  return /^[\x00-\x7f]*$/.test(value) ? value : new TextDecoder().decode(Uint8Array.from(value, (c) => c.charCodeAt(0)))
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
