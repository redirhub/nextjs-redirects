/**
 * The golden sample of format v1 (spec/v1, a copy of redirhub/integration-spec's spec/v1): read
 * rules.txt, answer every case of requests.tsv as it says, and report exactly reports.txt.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, it } from 'node:test'

import { createRedirects } from '../../src/core/redirects.ts'

const spec = (name: string) => readFileSync(new URL(`../../spec/v1/${name}`, import.meta.url), 'utf8')

const RULES_URL = 'https://rules.example.test/FAKE.txt'
const SPEC_TIME = new Date(Date.UTC(2026, 9, 31, 19, 10, 0))

interface Case {
  name: string
  method: string
  url: string
  referer: string | null
  userAgent: string | null
  site: number
  outcome: 'redirect' | 'frame' | 'site' | 'check'
  status: number
  location: string | null
  body: string | null
  report: number | null
}

function cases(): Case[] {
  const [header, ...rows] = spec('requests.tsv').split('\n').filter((line) => line !== '')
  assert.ok(header.startsWith('name\tmethod\turl\t'), header)
  return rows.map((row) => {
    const f = row.split('\t')
    assert.equal(f.length, 11, row)
    const dash = (v: string) => (v === '-' ? null : v)
    return {
      name: f[0],
      method: f[1],
      url: f[2],
      referer: dash(f[3]),
      userAgent: dash(f[4]),
      site: Number(f[5]),
      outcome: f[6] as Case['outcome'],
      status: Number(f[7]),
      location: dash(f[8]),
      body: dash(f[9]),
      report: f[10] === '-' ? null : Number(f[10]),
    }
  })
}

/** The character references an attribute value may hold, back to text. */
function unescapeHtml(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (ref, dec, hex, name) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : (named[name] ?? ref)
  )
}

describe('spec v1 golden sample', () => {
  it('answers every request as requests.tsv says and reports exactly reports.txt', async () => {
    const posted: string[] = []
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === RULES_URL) {
        return new Response(spec('rules.txt'), { status: 200, headers: { ETag: '"spec-v1"' } })
      }
      assert.equal(url, 'https://edge.example.test/_edge/hits')
      const headers = init?.headers as Record<string, string>
      assert.equal(headers.Authorization, 'Bearer spec-key')
      posted.push(...gunzipSync(Buffer.from(init?.body as ArrayBuffer)).toString('utf8').split('\n').filter(Boolean))
      return new Response(null, { status: 204 })
    }
    const redirects = createRedirects({
      rulesUrl: RULES_URL,
      key: 'spec-key',
      clientIp: () => '203.0.113.9',
      fetch: fakeFetch,
      now: () => SPEC_TIME,
      logger: null,
    })

    const expectedReports: number[] = []
    for (const c of cases()) {
      // The Host header as sent: letter case and port kept (URL parsing would lowercase it).
      const host = /^https?:\/\/([^/]+)/.exec(c.url)?.[1] ?? ''
      const headers: Record<string, string> = { host }
      if (c.referer) headers.referer = c.referer
      if (c.userAgent) headers['user-agent'] = c.userAgent
      const request = new Request(c.url, { method: c.method, headers })
      let siteCalled = false
      const response = await redirects.serve(request, async () => {
        siteCalled = true
        return new Response(null, { status: c.site })
      })

      assert.equal(response.status, c.status, c.name)
      assert.equal(response.headers.get('location'), c.location, c.name)
      assert.equal(response.headers.get('x-powered-by'), c.outcome === 'redirect' || c.outcome === 'frame' ? 'RedirHub (integrated)' : null, c.name)
      if (c.outcome === 'frame') {
        assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', c.name)
        const iframes = [...(await response.text()).matchAll(/<iframe\b[^>]*\bsrc="([^"]*)"/g)]
        assert.equal(iframes.length, 1, `${c.name}: exactly one iframe`)
        assert.equal(`src=${unescapeHtml(iframes[0][1])}`, c.body, c.name)
      }
      if (c.outcome === 'check') {
        assert.equal(await response.text(), c.body, c.name)
        assert.equal(response.headers.get('cache-control'), 'no-store', c.name)
      }
      if (c.outcome === 'site') {
        assert.ok(siteCalled, `${c.name}: the site answers`)
      }
      if (c.report !== null) {
        expectedReports.push(c.report)
      }
    }
    await redirects.flush()

    const reports = spec('reports.txt').split('\n').filter(Boolean)
    assert.deepEqual(expectedReports, reports.map((_, i) => i + 1), 'requests.tsv reports every line of reports.txt in order')
    assert.deepEqual(posted, reports)
  })
})
