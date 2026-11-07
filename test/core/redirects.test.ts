import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import { describe, it } from 'node:test'

import { anonymize, createRedirects } from '../../src/core/redirects.ts'

const RULES = 'https://rules.example.test/FAKE.txt'
const FILE = [
  '@format 1',
  '@hits https://edge.example.test/_edge/hits',
  '@host shop.example.test check=TOKEN report404',
  'shop.example.test/old\thttps://shop.example.test/new',
  'shop.example.test/*\thttps://www.example.test/\t302\tp',
  '',
].join('\n')

/** Serves the rules file and records report lines and other requests. */
function platform() {
  const lines: string[] = []
  const inits: Array<RequestInit | undefined> = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    inits.push(init)
    if (url === RULES) return new Response(FILE, { headers: { ETag: '"r1"' } })
    lines.push(...gunzipSync(Buffer.from(init?.body as ArrayBuffer)).toString().split('\n').filter(Boolean))
    return new Response(null, { status: 204 })
  }
  return { fetch, lines, inits }
}

const context = () => {
  const work: Array<Promise<unknown>> = []
  return { waitUntil: (p: Promise<unknown>) => void work.push(p), done: () => Promise.all(work) }
}

describe('createRedirects', () => {
  it('reports the site 404 of a report404 hostname where there is no catch-all, and anonymizes when asked', async () => {
    const p = platform()
    const redirects = createRedirects({
      rulesUrl: RULES,
      key: 'k',
      clientIp: () => '2001:db8:1234:5678::1',
      anonymizeIp: true,
      fetch: async (input, init) => (String(input) === RULES ? new Response(FILE.replace(/^shop.*\*.*$/m, '')) : p.fetch(input, init)),
      logger: null,
    })
    const response = await redirects.serve(new Request('https://shop.example.test/nope'), async () => new Response('missing', { status: 404 }))
    assert.equal(response.status, 404)
    assert.equal(await response.text(), 'missing')
    await redirects.flush()
    assert.equal(p.lines.length, 1)
    assert.match(p.lines[0], /^2001:db8:1234:: .* 404 0 "-" "-"$/)
  })

  it('uses the global fetch and the defaults when no internal option is passed', async (t) => {
    const original = globalThis.fetch
    t.after(() => {
      globalThis.fetch = original
    })
    const p = platform()
    globalThis.fetch = p.fetch
    const redirects = createRedirects({ rulesUrl: RULES, key: 'k', logger: null, fetch: undefined, firstWaitMs: undefined })
    const check = await redirects.handle(new Request('https://shop.example.test/_redirhub/check'))
    assert.equal(await check?.text(), 'token=TOKEN etag=r1')
    await redirects.handle(new Request('https://shop.example.test/old'))
    await redirects.flush()
    assert.equal(p.lines.length, 1, 'reports go through the global fetch too')
  })

  it('leaves a request alone, without loading the rules, when hostname returns null', async () => {
    let downloads = 0
    const redirects = createRedirects({
      rulesUrl: RULES,
      key: 'k',
      hostname: (request) => (new URL(request.url).hostname === 'www.example.test' ? null : request.headers.get('host')),
      fetch: async () => {
        downloads++
        return new Response(FILE)
      },
      logger: null,
    })
    const response = await redirects.serve(new Request('https://www.example.test/old'), async () => new Response('site', { status: 404 }))
    assert.equal(await response.text(), 'site')
    assert.equal(downloads, 0, 'our own site never waits for the rules')
  })

  it('matches, answers and reports the hostname that hostname returns, with the custom User-Agent', async () => {
    const p = platform()
    const redirects = createRedirects({
      rulesUrl: RULES,
      key: 'k',
      hostname: (request) => (request.headers.get('host')?.endsWith('.vercel.app') ? 'Shop.Example.TEST:443' : request.headers.get('host')),
      clientIp: () => null,
      userAgent: (request) => request.headers.get('x-original-user-agent'),
      fetch: p.fetch,
      logger: null,
    })
    const headers = { host: 'shop-git-main.vercel.app', 'user-agent': 'proxy/1.0', 'x-original-user-agent': 'Visitor/2.0' }
    const check = await redirects.handle(new Request('https://shop-git-main.vercel.app/_redirhub/check', { headers }))
    assert.equal(await check?.text(), 'token=TOKEN etag=r1')
    const response = await redirects.handle(new Request('https://shop-git-main.vercel.app/old', { headers }))
    assert.equal(response?.headers.get('location'), 'https://shop.example.test/new')
    await redirects.flush()
    assert.equal(p.lines.length, 1)
    assert.match(p.lines[0], /^- - - \[[^\]]+\] "GET https:\/\/shop\.example\.test\/old HTTP\/1\.1" 301 0 "-" "Visitor\/2\.0" file=/)
  })

  it('matches, appends and reports the path that path returns, and leaves a request alone on null', async () => {
    const p = platform()
    let downloads = 0
    const redirects = createRedirects({
      rulesUrl: RULES,
      key: 'k',
      // A proxy in front strips /shop and says so in a header; /api never goes through the rules.
      path: (request) => {
        const { pathname } = new URL(request.url)
        return pathname.startsWith('/api/') ? null : `${request.headers.get('x-forwarded-prefix') ?? ''}${pathname}`
      },
      fetch: async (input, init) => {
        if (String(input) === RULES) downloads++
        return String(input) === RULES
          ? new Response(`${FILE}shop.example.test/shop/old\thttps://shop.example.test/new\n`, { headers: { ETag: '"r1"' } })
          : p.fetch(input, init)
      },
      logger: null,
    })
    const api = await redirects.serve(new Request('https://shop.example.test/api/x'), async () => new Response('api', { status: 404 }))
    assert.equal(await api.text(), 'api')
    assert.equal(downloads, 0, 'a path left alone never waits for the rules')

    const headers = { 'x-forwarded-prefix': '/shop' }
    const exact = await redirects.handle(new Request('https://shop.example.test/old', { headers }))
    assert.equal(exact?.headers.get('location'), 'https://shop.example.test/new', 'the rule for /shop/old')
    const gone = await redirects.serve(new Request('https://shop.example.test/gone', { headers }), async () => new Response(null, { status: 404 }))
    assert.equal(gone.headers.get('location'), 'https://www.example.test/shop/gone', 'the catch-all appends the visitor path')
    await redirects.flush()
    assert.deepEqual(
      p.lines.map((line) => line.split('"')[1]),
      ['GET https://shop.example.test/shop/old HTTP/1.1', 'GET https://shop.example.test/shop/gone HTTP/1.1']
    )
  })

  it('reports only where report allows, even with a key', async () => {
    const p = platform()
    const make = (report: boolean | ((request: Request) => boolean)) =>
      createRedirects({ rulesUrl: RULES, key: 'k', report, fetch: p.fetch, logger: null })
    const off = make(false)
    await off.handle(new Request('https://shop.example.test/old'))
    await off.flush()
    assert.equal(p.lines.length, 0, 'report: false sends nothing')

    const live = make((request) => !request.headers.has('x-preview'))
    await live.handle(new Request('https://shop.example.test/old', { headers: { 'x-preview': '1' } }))
    const response = await live.handle(new Request('https://shop.example.test/old'))
    await live.flush()
    assert.equal(response?.status, 301, 'redirects either way')
    assert.equal(p.lines.length, 1, 'only the request report allows')
  })

  it('sends and reports the Location that location returns: one rule for every language', async () => {
    const p = platform()
    const localeOf = (request: Request) => /^\/(es|fr)(?=\/|$)/.exec(new URL(request.url).pathname)?.[1] ?? null
    const redirects = createRedirects({
      rulesUrl: RULES,
      key: 'k',
      // Rules are written for the default-locale path: /es/old finds shop.example.test/old ...
      path: (request) => new URL(request.url).pathname.replace(/^\/(es|fr)(?=\/|$)/, '') || '/',
      // ... and a same-site target lands in the visitor's language.
      location: (location, request) => {
        const locale = localeOf(request)
        const url = new URL(location)
        return locale && url.hostname === 'shop.example.test' ? `${url.origin}/${locale}${url.pathname}${url.search}` : location
      },
      fetch: p.fetch,
      logger: null,
    })
    const es = await redirects.handle(new Request('https://shop.example.test/es/old'))
    assert.equal(es?.headers.get('location'), 'https://shop.example.test/es/new')
    const en = await redirects.handle(new Request('https://shop.example.test/old'))
    assert.equal(en?.headers.get('location'), 'https://shop.example.test/new')
    await redirects.flush()
    assert.match(p.lines[0], / file=shop\.example\.test\/old destination=https:\/\/shop\.example\.test\/es\/new$/)
  })

  it('answers a frame rule with an escaped frame page, also as a catch-all, and HEAD without a body', async () => {
    const p = platform()
    const file = `${FILE.replace(/^shop.*\*.*$/m, '')}@powered-by Test\nshop.example.test/tour\thttps://tour.example.test/a?x=1&y="2"\tframe\tq\tpassword=$2y$10$FAKE plugins=nobot\n`
    const redirects = createRedirects({
      rulesUrl: RULES,
      key: 'k',
      fetch: async (input, init) => (String(input) === RULES ? new Response(file) : p.fetch(input, init)),
      logger: null,
    })
    const response = await redirects.handle(new Request('https://shop.example.test/tour?ref=<b>'))
    assert.equal(response?.status, 200)
    assert.equal(response?.headers.get('location'), null)
    assert.equal(response?.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(response?.headers.get('x-powered-by'), 'Test')
    const html = (await response?.text()) ?? ''
    assert.equal(response?.headers.get('content-length'), String(new TextEncoder().encode(html).length))
    assert.match(html, /<title>tour\.example\.test<\/title>/)
    assert.match(html, /<meta charset="utf-8">/)
    assert.deepEqual(
      [...html.matchAll(/<iframe [^>]*>/g)].map((m) => m[0]),
      ['<iframe src="https://tour.example.test/a?x=1&#38;y=&#34;2&#34;&#38;ref=%3Cb%3E" allowfullscreen>'],
      'one iframe, its src escaped, the options ignored'
    )

    const head = await redirects.handle(new Request('https://shop.example.test/tour', { method: 'HEAD' }))
    assert.equal(head?.status, 200)
    assert.equal(head?.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.equal(await head?.text(), '')

    const catchAll = createRedirects({
      rulesUrl: RULES,
      fetch: async () => new Response(FILE.replace('\t302\tp', '\tframe\tp')),
      logger: null,
    })
    const framed = await catchAll.serve(new Request('https://shop.example.test/gone'), async () => new Response(null, { status: 404 }))
    assert.equal(framed.status, 200)
    assert.match(await framed.text(), /<iframe src="https:\/\/www\.example\.test\/gone"/)

    await redirects.flush()
    assert.equal(p.lines.length, 2)
    assert.match(p.lines[0], /" 200 0 "-" "-" file=shop\.example\.test\/tour destination=https:\/\/tour\.example\.test\/a\?x=1&y=%222%22&ref=%3Cb%3E$/)
  })

  it('fails open', async () => {
    assert.equal(await createRedirects({ rulesUrl: '' }).handle(new Request('https://shop.example.test/old')), null)
    const broken = createRedirects({ rulesUrl: RULES, fetch: async () => Promise.reject(new Error('down')), logger: null })
    const response = await broken.serve(new Request('https://shop.example.test/old'), async () => new Response('site'))
    assert.equal(await response.text(), 'site')
  })

  it('anonymizes IPv4 and IPv6 addresses', () => {
    assert.equal(anonymize('203.0.113.9'), '203.0.113.0')
    assert.equal(anonymize('2001:db8::1'), '2001:db8:0::')
    assert.equal(anonymize('::1'), '0:0:0::')
    assert.equal(anonymize('unknown'), 'unknown')
  })
})
