import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'

import { RulesSource } from '../../src/index.ts'

const URL_ = 'https://rules.example.test/FAKE.txt'
const FILE = '@format 1\n@refresh 60\n@host a.example.test check=T\na.example.test/x\thttps://b.example.test/\n'

const later = (ms: number) => mock.timers.enable({ apis: ['Date'], now: Date.now() + ms })

describe('RulesSource', () => {
  afterEach(() => mock.timers.reset())

  it('waits for the first download, then answers the stale copy and revalidates in the background', async () => {
    const sent: Array<Record<string, string>> = []
    const source = new RulesSource({
      url: URL_,
      fetch: async (_u, init) => {
        sent.push(init?.headers as Record<string, string>)
        return sent.length === 1 ? new Response(FILE, { headers: { ETag: 'W/"v1"' } }) : new Response(null, { status: 304 })
      },
    })
    assert.equal((await source.get())?.etag, 'v1')
    assert.equal(sent[0]['If-None-Match'], undefined)

    const background: Array<Promise<unknown>> = []
    assert.ok(await source.get((p) => void background.push(p)), 'fresh: no download')
    assert.equal(background.length, 0)

    later(61_000)
    assert.equal((await source.get((p) => void background.push(p)))?.etag, 'v1', 'stale copy answered at once')
    await Promise.all(background)
    assert.equal(sent[1]['If-None-Match'], 'W/"v1"', 'the ETag goes back as received')
  })

  it('keeps the last good copy on errors, other formats and oversized files, and waits before retrying', async () => {
    const warnings: string[] = []
    const answers = [
      () => new Response(FILE, { headers: { ETag: '"v1"' } }),
      () => new Response('@format 2\n', { headers: { ETag: '"v2"' } }),
      () => new Response('x'.repeat(100), { headers: { ETag: '"v3"' } }),
      () => Promise.reject(new TypeError('network')),
    ]
    let calls = 0
    const source = new RulesSource({
      url: URL_,
      maxBytes: 99,
      logger: { warn: (m) => void warnings.push(m) },
      fetch: async () => answers[calls++](),
    })
    await source.get()
    let offset = 0
    for (let n = 1; n < answers.length; n++) {
      offset += 61_000 + 30_000
      later(offset)
      const background: Array<Promise<unknown>> = []
      await source.get((p) => void background.push(p))
      await Promise.all(background)
      assert.equal(source.current?.etag, 'v1')
      mock.timers.reset()
    }
    assert.equal(calls, 4)
    assert.equal(warnings.length, 1, 'repeated failures are logged once per ten minutes')

    // Right after a failure, no new download is tried.
    later(offset + 1000)
    await source.get()
    assert.equal(calls, 4)
  })

  it('has no rules, without throwing, while the first download fails', async () => {
    const source = new RulesSource({ url: URL_, logger: { warn() {} }, fetch: async () => new Response('gone', { status: 404 }) })
    assert.equal(await source.get(), null)
  })
})
