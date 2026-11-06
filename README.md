# nextjs-redirects: bulk redirects for Next.js

[![npm](https://img.shields.io/npm/v/@redirhub/nextjs-redirects)](https://www.npmjs.com/package/@redirhub/nextjs-redirects)
[![CI](https://github.com/redirhub/nextjs-redirects/actions/workflows/ci.yml/badge.svg)](https://github.com/redirhub/nextjs-redirects/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**Serve thousands of 301 and 302 redirects from your [Next.js](https://nextjs.org) app, from a
remote rules file.** Your domains keep pointing at your Next.js app; its proxy (`proxy.ts`, or
`middleware.ts` before Next.js 16) redirects old URLs, short links and whole website migrations,
and reports every redirect back, without a deploy for each change.

- Redirects, short links and whole website migrations, live within a minute, without touching
  `next.config` or redeploying.
- Fails open: no rules yet, a download error or a bug never breaks a page; the request goes on.
- Reports go out in the background, batched, without delaying a response and without a timer.
- No dependencies; works on Vercel and self-hosted (`next start`).

The rules file format is open: [Integration Mode format v1](https://github.com/redirhub/integration-spec),
and this package passes its [golden sample](spec/v1). [RedirHub](https://www.redirhub.com)
publishes the file for you: you manage the redirects in its dashboard, API or MCP server and see
the redirects in its analytics.

## For AI coding assistants

To add this to a Next.js app:

1. `npm install @redirhub/nextjs-redirects`.
2. In `proxy.ts` (Next.js 16+) or `middleware.ts` (15 and earlier), call `createProxy(…)` once at
   module scope and, first thing in the proxy function, `const response = await redirects(request, event)`;
   return `response` when it is set. Keep the app's own proxy logic after it.
3. Two server-side environment variables: the rules address and the integration key from the
   RedirHub dashboard (names like `ACME_RULES_URL`, `ACME_INTEGRATION_KEY`; never `NEXT_PUBLIC_`).
4. Make sure `config.matcher` reaches `/_redirhub/check` and the redirected paths.
5. Check: `GET https://<hostname>/_redirhub/check` answers `token=… etag=…`, and a rule's path
   redirects with its status. Then press **Check now** in the dashboard.

Do not reimplement the rules format: this package passes the specification's golden sample.

## When to use it

`redirects()` in `next.config` is the right tool for a handful of permanent rules that change with
your code. This package is for redirect lists that change without a release: a website
migration with thousands of old URLs, marketing and short links, redirects that people who do not
touch the code maintain, the same rules across several Next.js apps, or when you want to see which
redirects are still used. The rules change in a dashboard, API or MCP server, and every instance
picks them up within a minute.

## Install

```sh
npm install @redirhub/nextjs-redirects
```

In the RedirHub dashboard, add the domain, pick **Connect through your own platform**, and copy
the **rules address** and the **integration key**. Store both as environment variables (Vercel
project settings, `.env.local` locally); the examples call them `ACME_RULES_URL` and
`ACME_INTEGRATION_KEY` (the dashboard shows the names for your platform). The key is a secret:
never prefix it with `NEXT_PUBLIC_`.

## Use

`proxy.ts` (Next.js 16+; in Next.js 15 and earlier `middleware.ts` with `export function middleware`):

```ts
import type { NextFetchEvent, NextRequest } from 'next/server'
import { createProxy } from '@redirhub/nextjs-redirects'

const redirects = createProxy({
  rulesUrl: process.env.ACME_RULES_URL,
  key: process.env.ACME_INTEGRATION_KEY,
})

export async function proxy(request: NextRequest, event: NextFetchEvent) {
  const response = await redirects(request, event)
  if (response) return response
  // … your own proxy logic, or nothing
}
```

- Call it first, before rewrites and locale handling: rules match the path as the visitor sent it.
- The `matcher` must let the check path (`/_redirhub/check`) and the paths you redirect through.
  A matcher that skips every path with a dot (a common default) also skips rules such as
  `/old.html`.
- `redirects()` in `next.config` run before the proxy: don't let them shadow these paths.
- On Vercel the visitor's address is the first `X-Forwarded-For` value, which Vercel overwrites.
  Self-hosted behind your own proxy, pass `clientIp` with a header that proxy sets.

| Option | |
| --- | --- |
| `rulesUrl` | The rules address. Empty: off, every request goes to the app. |
| `key` | The integration key. Without it redirects work and nothing is reported. |
| `hostname(request)` | The hostname to look up in the rules; `null` leaves the request alone (no rules loaded, nothing reported). Default the `Host` header. |
| `path(request)` | The path the visitor asked for, percent-encoded; `null` leaves the request alone. Default the request URL's path. |
| `clientIp(request)` | The visitor's address in reports; default the first `X-Forwarded-For` value. `null` writes `-`. |
| `userAgent(request)` | The User-Agent in reports; default the `User-Agent` header. `null` writes `-`. |
| `scheme(request)` | `http` or `https` as the visitor asked; default `X-Forwarded-Proto`, else the URL's. |
| `anonymizeIp` | Report IPv4 with the last byte zeroed, IPv6 cut to /48. |
| `logger` | Default `console`; `null` for silence. Failures are logged at most once per ten minutes. |

## Customize

Each option that reads the request is a function of it, so a site decides with ordinary code:

```ts
const redirects = createProxy({
  rulesUrl: process.env.ACME_RULES_URL,
  key: process.env.ACME_INTEGRATION_KEY,
  // Which hostname to look up in the rules. null: leave the request alone.
  hostname: (request) => {
    const host = request.headers.get('host')
    if (host === 'www.example.com') return null // our own site never goes through the rules
    if (host?.endsWith('.vercel.app')) return 'shop.example.com' // previews act as production
    return host
  },
  // A proxy in front strips /shop; /api never goes through the rules.
  path: (request) => {
    const { pathname } = new URL(request.url)
    return pathname.startsWith('/api/') ? null : `${request.headers.get('x-forwarded-prefix') ?? ''}${pathname}`
  },
  // Behind your own proxy: the headers it sets.
  clientIp: (request) => request.headers.get('x-real-ip'),
  userAgent: (request) => request.headers.get('x-original-user-agent') ?? request.headers.get('user-agent'),
  anonymizeIp: true,
})
```

The hostname and path these return are the ones matched, answered on the check path, appended by
a catch-all and reported, so they always agree. Options that identify the request (`hostname`,
`path`) leave it alone on `null`, and such a request costs nothing: the rules are not even loaded
for it. Options that are only reported (`clientIp`, `userAgent`) write `-` on `null`.

## Behaviour

Only **GET and HEAD** on a **hostname listed** in the rules are answered; everything else passes.

1. **Check path** (`/_redirhub/check`): `200`, `text/plain`, `Cache-Control: no-store`, body
   `token=<check token> etag=<ETag of the rules in use>`. It proves the hostname is yours and
   tells RedirHub which rules you serve.
2. **Exact rules** redirect before the app, even when the page exists, with the rule's status
   (301, 302, 307 or 308).
3. Everything else goes to the app.

The hostname is taken from the `Host` header (self-hosted, the request URL names the server).
Matching follows format v1: the hostname in any case, port ignored; the path case-sensitive,
percent-decoded, leading and trailing slashes ignored; scheme and query ignored.

**No catch-all, no 404 reports.** The proxy runs before the page, so it never sees whether the app
answers 404: a hostname's catch-all rule (`{host}/*`) is not served and the app's 404s are not
reported. Where you do see the final answer, e.g. in a route handler, `createRedirects()` from this
package gives you `afterSite(request, response, context)`, which adds both.

**Rules download.** The first request of a new instance starts the download and waits for it at
most one second; if the rules server is slower, that request goes on without rules and the download
(5 second timeout) finishes in the background. Requests that arrive meanwhile do not wait. After
that the copy in memory is used, and once it is older than `@refresh` seconds (60 by default) it is
revalidated in the background (`event.waitUntil`) with `If-None-Match`, so no visitor waits. Any
failure keeps the last good copy and waits 30 seconds before trying again.

**Reports.** A line queued while nothing is being sent goes out at once; lines queued while a
request is out go together in the next one (at most 100 lines or 64 KB, gzip, 2 second timeout).
A quiet site reports each visit immediately and keeps no function waiting; a busy one sends one
request per hundred visits. Only the invocation that starts sending is kept alive for it, for at
most 10 seconds. A failed or rejected batch is dropped, never retried; beyond 10,000 waiting
lines, lines are dropped.

## Privacy

Each report is one Apache combined line with the absolute URL:

```
203.0.113.9 - - [31/Oct/2026:19:10:00 +0000] "GET https://shop.example.com/old-pricing?utm=x HTTP/1.1" 301 0 "https://www.google.com/" "Mozilla/5.0 …" file=shop.example.com/old-pricing destination=https://shop.example.com/pricing
```

That is the visitor's IP address (or `-`, or anonymized with `anonymizeIp`), the time (UTC), the
method, the requested URL with its query string, the status, the Referer and the User-Agent (each
cut to 1 KB), the rule's source and the `Location` sent. The protocol is always written
`HTTP/1.1`. No cookies, other headers or bodies are sent, and only redirects are reported. Reports
go only to the `@hits` address of your rules file, with your key.

## Limits

- No catch-all and no 404 reports in the proxy (see above).
- The rules live in each instance's memory: a new instance (a cold start) waits up to one second
  for them, and serves no redirects until they arrive.
- Changes are live within `@refresh` seconds per instance (60 by default).
- The rules file is at most 32 MB.

## Development

Node.js 22.18 or later runs the TypeScript tests directly.

```sh
npm install
npm run typecheck
npm test
npm run build
npm run check:spec   # spec/v1 is still the same as redirhub/integration-spec's
npm run check:core   # src/core and test/core are the same as redirhub/cloudflare-redirects'
```

`src/core/` (the format: parsing, matching, downloading, reporting) and its tests in `test/core/`
are shared, file for file, with [cloudflare-redirects](https://github.com/redirhub/cloudflare-redirects).
Change both repositories together; CI flags a difference. `src/index.ts` is the Next.js part.

## Releasing

Bump `version` in `package.json` and `VERSION` in `src/version.ts` (a test checks they match) and
merge to `main`. The Release workflow sees a version without a tag, runs the checks, publishes to
npm through Trusted Publishing (with provenance, no npm token stored anywhere), then tags the
commit `v<version>` and creates the GitHub Release. Nobody pushes a tag by hand; a push without a
version change releases nothing.

## License

Apache License 2.0, see [LICENSE](LICENSE). Copyright 2026 RedirHub.
