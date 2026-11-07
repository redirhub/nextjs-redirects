import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createProxy } from '../src/index.ts'

const RULES = 'https://rules.example.test/FAKE.txt'
const FILE = [
  '@format 1',
  '@hits https://edge.example.test/_edge/hits',
  '@host shop.example.test check=TOKEN report404',
  'shop.example.test/old\thttps://shop.example.test/new',
  'shop.example.test/tour\thttps://tour.example.test/\tframe',
  'shop.example.test/*\thttps://www.example.test/\t302\tp',
  '',
].join('\n')

/** The platform's fetch: serves the rules file and records report lines and request options. */
const lines: string[] = []
const inits: Array<RequestInit | undefined> = []
const original = globalThis.fetch

beforeEach(() => {
  lines.length = 0
  inits.length = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    inits.push(init)
    if (url === RULES) return new Response(FILE, { headers: { ETag: '"r1"' } })
    lines.push(...gunzipSync(Buffer.from(init?.body as ArrayBuffer)).toString().split('\n').filter(Boolean))
    return new Response(null, { status: 204 })
  }
})

afterEach(() => {
  globalThis.fetch = original
})

const context = () => {
  const work: Array<Promise<unknown>> = []
  return { waitUntil: (p: Promise<unknown>) => void work.push(p), done: () => Promise.all(work) }
}

describe('createProxy', () => {
  it('redirects exact rules with the Vercel address and scheme, and lets everything else through', async () => {
    const proxy = createProxy({ rulesUrl: RULES, key: 'k', logger: null })
    const event = context()
    const headers = { host: 'shop.example.test', 'x-forwarded-for': '198.51.100.7, 10.0.0.1', 'x-forwarded-proto': 'https' }

    const response = await proxy(new Request('http://localhost:3000/old', { headers }), event)
    assert.equal(response?.status, 301)
    assert.equal(response?.headers.get('location'), 'https://shop.example.test/new')
    assert.equal(await proxy(new Request('http://localhost:3000/missing', { headers }), event), undefined, 'no catch-all in the proxy')
    assert.equal(await proxy(new Request('http://localhost:3000/old', { method: 'POST', headers }), event), undefined)
    await event.done()

    assert.equal((inits[0] as RequestInit & { cache?: string }).cache, 'no-store', 'the rules bypass the Next.js fetch cache')
    assert.equal(lines.length, 1)
    assert.match(lines[0], /^198\.51\.100\.7 - - \[[^\]]+\] "GET https:\/\/shop\.example\.test\/old HTTP\/1\.1" 301 0 /)
  })

  it('answers a frame rule with an HTML page of its own, and reports it with status 200', async () => {
    const proxy = createProxy({ rulesUrl: RULES, key: 'k', logger: null })
    const event = context()
    const response = await proxy(new Request('https://shop.example.test/tour?ref=nl'), event)
    assert.ok(response instanceof Response)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.match(await response.text(), /<iframe src="https:\/\/tour\.example\.test\/" allowfullscreen>/)
    await event.done()
    assert.equal(lines.length, 1)
    assert.match(lines[0], /" 200 0 "-" "-" file=shop\.example\.test\/tour destination=https:\/\/tour\.example\.test\/$/)
  })

  it('takes the scheme from X-Forwarded-Proto only when it is http or https', async () => {
    const proxy = createProxy({ rulesUrl: RULES, key: 'k', logger: null })
    const event = context()
    for (const proto of ['javascript', 'http']) {
      await proxy(new Request('https://shop.example.test/old', { headers: { 'x-forwarded-proto': proto } }), event)
    }
    await event.done()
    assert.deepEqual(
      lines.map((line) => line.split('"')[1].split(' ')[1].split(':')[0]),
      ['https', 'http']
    )
  })
})
