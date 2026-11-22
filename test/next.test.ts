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

  describe('the 404 page script', () => {
    const headers = { host: 'shop.example.test', 'x-forwarded-for': '198.51.100.7', 'user-agent': 'Browser/1' }
    const post = (body: string, host = 'shop.example.test') =>
      new Request('http://localhost:3000/_redirhub/404', { method: 'POST', headers: { ...headers, host, 'content-type': 'text/plain' }, body })

    it('serves the script, which posts the page and follows a catch-all', async () => {
      const proxy = createProxy({ rulesUrl: RULES, key: 'k', logger: null })
      const response = await proxy(new Request('http://localhost:3000/_redirhub/404', { headers }))
      assert.equal(response?.status, 200)
      assert.equal(response?.headers.get('content-type'), 'text/javascript; charset=utf-8')
      const script = (await response?.text()) ?? ''
      assert.match(script, /fetch\("\/_redirhub\/404",\{method:"POST"/)
      assert.match(script, /location\.replace\(a\.location\)/)
      new Function(script) // valid JavaScript
    })

    it('reports a 404 page with the visitor, the page and its Referer', async () => {
      const file = FILE.replace('shop.example.test/*\thttps://www.example.test/\t302\tp\n', '')
      globalThis.fetch = async (input, init) => {
        const url = String(input instanceof Request ? input.url : input)
        if (url === RULES) return new Response(file, { headers: { ETag: '"r2"' } })
        lines.push(...gunzipSync(Buffer.from(init?.body as ArrayBuffer)).toString().split('\n').filter(Boolean))
        return new Response(null, { status: 204 })
      }
      const proxy = createProxy({ rulesUrl: RULES, key: 'k', logger: null })
      const event = context()
      await proxy(new Request('http://localhost:3000/gone', { headers }), event) // the page itself: loads the rules
      const response = await proxy(post('https://shop.example.test/gone?x=1\nhttps://www.google.com/'), event)
      assert.equal(response?.status, 204)
      await event.done()
      assert.equal(lines.length, 1)
      assert.match(lines[0], /^198\.51\.100\.7 - - \[[^\]]+\] "GET https:\/\/shop\.example\.test\/gone\?x=1 HTTP\/1\.1" 404 0 "https:\/\/www\.google\.com\/" "Browser\/1"$/)
    })

    it('answers the catch-all for the script to follow, and reports that redirect', async () => {
      const proxy = createProxy({ rulesUrl: RULES, key: 'k', logger: null })
      const event = context()
      await proxy(new Request('http://localhost:3000/gone', { headers }), event)
      const response = await proxy(post('https://shop.example.test/gone\n'), event)
      assert.equal(response?.status, 200)
      assert.deepEqual(await response?.json(), { location: 'https://www.example.test/gone' })
      await event.done()
      assert.equal(lines.length, 1)
      assert.match(lines[0], /"GET https:\/\/shop\.example\.test\/gone HTTP\/1\.1" 302 0 "-" "Browser\/1" file=shop\.example\.test\/\* destination=https:\/\/www\.example\.test\/gone$/)
    })

    it('ignores an address on another hostname and a body that is not one', async () => {
      const proxy = createProxy({ rulesUrl: RULES, key: 'k', logger: null })
      const event = context()
      await proxy(new Request('http://localhost:3000/gone', { headers }), event)
      for (const body of ['https://other.example.test/gone\n', 'not a url', 'javascript:alert(1)', '']) {
        assert.equal((await proxy(post(body), event))?.status, 204, body)
      }
      assert.equal((await proxy(post('https://shop.example.test/gone\n', 'other.example.test'), event))?.status, 204)
      await event.done()
      assert.equal(lines.length, 0)
    })
  })
})
