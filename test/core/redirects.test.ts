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
