import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import { describe, it, mock } from 'node:test'

import { hitLine, Reporter } from '../../src/core/report.ts'
import { USER_AGENT } from '../../src/version.ts'

const HITS = 'https://edge.example.test/_edge/hits'

/** A hits endpoint that answers when told to, so tests can see what queues while a request is out. */
function endpoint(status = 204) {
  const batches: string[][] = []
  const headers: Array<Record<string, string>> = []
  const waiting: Array<() => void> = []
  let hold = false
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    batches.push(gunzipSync(Buffer.from(init?.body as ArrayBuffer)).toString('utf8').split('\n').filter(Boolean))
    headers.push(init?.headers as Record<string, string>)
    if (hold) await new Promise<void>((resolve) => waiting.push(resolve))
    return new Response(null, { status })
  }
  return {
    fetch,
    batches,
    headers,
    hold: () => (hold = true),
    release: () => {
      hold = false
      for (const resolve of waiting.splice(0)) resolve()
    },
  }
}

const keep = () => {
  const work: Array<Promise<unknown>> = []
  return { keepAlive: (p: Promise<unknown>) => void work.push(p), work }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

/** Waits until cond holds (gzip runs before each request), at most a second. */
async function until(cond: () => boolean): Promise<void> {
  for (let n = 0; n < 200 && !cond(); n++) await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('Reporter', () => {
  it('sends a lone line at once, with the key, gzip and its User-Agent', async () => {
    const hits = endpoint()
    const reporter = new Reporter({ key: 'k1', hitsUrl: () => HITS, fetch: hits.fetch })
    const { keepAlive, work } = keep()
    reporter.enqueue('line 1', keepAlive)
    assert.equal(work.length, 1, 'the request that sends keeps itself alive')
    await Promise.all(work)
    assert.deepEqual(hits.batches, [['line 1']])
    assert.equal(hits.headers[0].Authorization, 'Bearer k1')
    assert.equal(hits.headers[0]['Content-Encoding'], 'gzip')
    assert.equal(hits.headers[0]['User-Agent'], USER_AGENT)
  })

  it('batches the lines that arrive while a request is out; only the sender waits', async () => {
    const hits = endpoint()
    hits.hold()
    const reporter = new Reporter({ key: 'k', hitsUrl: () => HITS, fetch: hits.fetch })
    const first = keep()
    reporter.enqueue('a', first.keepAlive)
    await tick()
    const others = keep()
    for (const line of ['b', 'c', 'd']) reporter.enqueue(line, others.keepAlive)
    assert.equal(others.work.length, 0, 'later requests do not wait on the sender')
    hits.release()
    await Promise.all(first.work)
    assert.deepEqual(hits.batches, [['a'], ['b', 'c', 'd']])
  })

  it('puts lines of the same turn together and caps a request at 100 lines and 64 KB', async () => {
    const hits = endpoint()
    const reporter = new Reporter({ key: 'k', hitsUrl: () => HITS, fetch: hits.fetch })
    for (let n = 0; n < 130; n++) reporter.enqueue(`line ${n}`)
    await reporter.flush()
    assert.deepEqual(hits.batches.map((b) => b.length), [100, 30])

    hits.batches.length = 0
    const big = 'x'.repeat(40 << 10)
    for (let n = 0; n < 3; n++) reporter.enqueue(big)
    await reporter.flush()
    assert.deepEqual(hits.batches.map((b) => b.length), [1, 1, 1])
  })

  it('opens up to four requests at once for full batches, and the sender waits for all of them', async () => {
    let out = 0
    let most = 0
    const batches: number[] = []
    const waiting: Array<() => void> = []
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      batches.push(gunzipSync(Buffer.from(init?.body as ArrayBuffer)).toString('utf8').split('\n').filter(Boolean).length)
      out++
      most = Math.max(most, out)
      await new Promise<void>((resolve) => waiting.push(resolve))
      out--
      return new Response(null, { status: 204 })
    }
    const reporter = new Reporter({ key: 'k', hitsUrl: () => HITS, fetch })
    const sender = keep()
    reporter.enqueue('first', sender.keepAlive)
    await until(() => out === 1)
    assert.equal(out, 1, 'a lone line goes at once')

    const others = keep()
    for (let n = 0; n < 450; n++) reporter.enqueue(`line ${n}`, others.keepAlive)
    await until(() => out === 4)
    await tick()
    assert.equal(most, 4, 'full batches open more requests, up to four')
    assert.equal(others.work.length, 0, 'only the sender is kept alive')

    let settled = false
    void Promise.all(sender.work).then(() => (settled = true))
    for (let n = 0; n < 200 && batches.reduce((sum, b) => sum + b, 0) < 451; n++) {
      for (const resolve of waiting.splice(0)) resolve()
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    for (const resolve of waiting.splice(0)) resolve()
    await Promise.all(sender.work)
    assert.ok(settled, 'the sender is done once every request is back')
    assert.equal(batches.reduce((sum, n) => sum + n, 0), 451, 'every line sent once')
    assert.ok(batches.every((n) => n <= 100))
  })

  it('waits for the request out with a part batch, instead of sending tiny ones', async () => {
    const hits = endpoint()
    hits.hold()
    const reporter = new Reporter({ key: 'k', hitsUrl: () => HITS, fetch: hits.fetch })
    reporter.enqueue('a')
    await until(() => hits.batches.length === 1)
    for (const line of ['b', 'c']) reporter.enqueue(line)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(hits.batches.length, 1, 'b and c wait: less than a full batch')
    hits.release()
    await reporter.flush()
    assert.deepEqual(hits.batches, [['a'], ['b', 'c']])
  })

  it('logs dropped lines at once, then the total by reason at most every ten minutes, even after the drops stop', async () => {
    const warnings: string[] = []
    const logger = { warn: (m: string) => void warnings.push(m) }
    const reporter = new Reporter({ key: 'k', hitsUrl: () => HITS, fetch: async () => new Response(null, { status: 503 }), logger, maxQueue: 1 })
    reporter.enqueue('a')
    reporter.enqueue('b') // queue full
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /1 report lines dropped since .* \(queue full 1\)$/)
    await reporter.flush() // a: 503
    reporter.enqueue('c')
    reporter.enqueue('d') // queue full
    await reporter.flush() // c: 503
    assert.equal(warnings.length, 1, 'within ten minutes: counted, not logged')

    mock.timers.enable({ apis: ['Date'], now: Date.now() + 11 * 60_000 })
    try {
      reporter.enqueue('e') // no drop: the count since the last log is logged now
      assert.equal(warnings.length, 2)
      assert.match(warnings[1], /3 report lines dropped since .* \(status 503 2, queue full 1\)$/)
      await reporter.flush()
    } finally {
      mock.timers.reset()
    }
  })

  it('drops lines beyond the queue, and failed or rejected batches, logging once', async () => {
    const warnings: string[] = []
    const logger = { warn: (m: string) => void warnings.push(m) }
    const rejected = endpoint(401)
    const reporter = new Reporter({ key: 'k', hitsUrl: () => HITS, fetch: rejected.fetch, logger, maxQueue: 2 })
    for (const line of ['a', 'b', 'c']) reporter.enqueue(line)
    await reporter.flush()
    assert.deepEqual(rejected.batches, [['a', 'b']])
    assert.equal(warnings.length, 1)

    const failing = new Reporter({ key: 'k', hitsUrl: () => HITS, fetch: async () => Promise.reject(new TypeError('network')), logger })
    failing.enqueue('a')
    await assert.doesNotReject(failing.flush())
  })

  it('sends nothing without a key or a hits address', async () => {
    const hits = endpoint()
    const noKey = new Reporter({ key: '', hitsUrl: () => HITS, fetch: hits.fetch })
    noKey.enqueue('a')
    const noHits = new Reporter({ key: 'k', hitsUrl: () => null, fetch: hits.fetch })
    noHits.enqueue('a')
    await Promise.all([noKey.flush(), noHits.flush()])
    assert.equal(hits.batches.length, 0)
  })
})

describe('hitLine', () => {
  const at = new Date(Date.UTC(2026, 0, 2, 3, 4, 5))
  const base = { ip: '203.0.113.9', method: 'GET', scheme: 'https', host: 'a.example.test', url: new URL('https://a.example.test/p?q=1'), status: 404, size: 0 }

  it('reads header bytes as UTF-8 and cuts the Referer and User-Agent to 1 KB', () => {
    const utf8Bytes = String.fromCharCode(...new TextEncoder().encode('Agent é'))
    assert.match(hitLine({ ...base, referer: null, userAgent: utf8Bytes }, at), /"Agent é"$/)
    const long = hitLine({ ...base, referer: 'r'.repeat(5000), userAgent: `${'u'.repeat(1023)}é` }, at)
    assert.match(long, new RegExp(` "r{1024}" "u{1023}"$`))
  })

  it('escapes control characters and encodes the URL fields', () => {
    const line = hitLine(
      { ...base, ip: null, referer: 'a\tb', userAgent: null, status: 301, redirect: { source: 'a.example.test/x y', location: 'https://b.example.test/"q"' } },
      at
    )
    assert.equal(
      line,
      '- - - [02/Jan/2026:03:04:05 +0000] "GET https://a.example.test/p?q=1 HTTP/1.1" 301 0 "a\\x09b" "-" file=a.example.test/x%20y destination=https://b.example.test/%22q%22'
    )
  })
})
