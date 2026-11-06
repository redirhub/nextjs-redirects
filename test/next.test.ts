import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import { describe, it } from 'node:test'

import { createProxy, forwardedScheme } from '../src/index.ts'

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

describe('next', () => {
  it('redirects exact rules with the Vercel address and scheme, and lets everything else through', async () => {
    const p = platform()
    const proxy = createProxy({ rulesUrl: RULES, key: 'k', fetch: p.fetch, logger: null })
    const event = context()
    const headers = { host: 'shop.example.test', 'x-forwarded-for': '198.51.100.7, 10.0.0.1', 'x-forwarded-proto': 'https' }

    const redirect = await proxy(new Request('http://localhost:3000/old', { headers }), event)
    assert.equal(redirect?.status, 301)
    assert.equal(redirect?.headers.get('location'), 'https://shop.example.test/new')
    assert.equal(await proxy(new Request('http://localhost:3000/missing', { headers }), event), undefined, 'no catch-all in the proxy')
    assert.equal(await proxy(new Request('http://localhost:3000/old', { method: 'POST', headers }), event), undefined)
    await event.done()

    assert.equal((p.inits[0] as RequestInit & { cache?: string }).cache, 'no-store')
    assert.equal(p.lines.length, 1)
    assert.match(p.lines[0], /^198\.51\.100\.7 - - \[[^\]]+\] "GET https:\/\/shop\.example\.test\/old HTTP\/1\.1" 301 0 /)
  })

  it('takes the scheme from X-Forwarded-Proto only when it is http or https', () => {
    assert.equal(forwardedScheme(new Request('https://a.example.test/', { headers: { 'x-forwarded-proto': 'javascript' } })), 'https')
    assert.equal(forwardedScheme(new Request('https://a.example.test/', { headers: { 'x-forwarded-proto': 'http' } })), 'http')
  })
})
