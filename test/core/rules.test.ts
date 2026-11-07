import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildLocation, escapeHtml, framePage, matchPath, normalizeHost, parseRules, type Rule, UnknownFormatError } from '../../src/core/rules.ts'

const HEAD = '@format 1\n@host a.example.test check=T\n'

describe('parseRules', () => {
  it('reads a file without @format as v1 and refuses another major version', () => {
    assert.equal(parseRules('@host a.example.test check=T\na.example.test/x\thttps://b.example.test/').hosts.get('a.example.test')?.exact.size, 1)
    assert.equal(parseRules('@format 1.4\n').checkPath, '/_redirhub/check')
    assert.throws(() => parseRules('@format 2\n'), UnknownFormatError)
    assert.throws(() => parseRules('@format\n'), UnknownFormatError)
  })

  it('clamps @refresh and ignores values it cannot use', () => {
    assert.equal(parseRules('@refresh 5').refresh, 30)
    assert.equal(parseRules('@refresh 99999').refresh, 3600)
    assert.equal(parseRules('@refresh soon').refresh, 60)
    assert.equal(parseRules('@hits ftp://x.example.test/').hitsUrl, null)
    assert.equal(parseRules('@check nope').checkPath, '/_redirhub/check')
    assert.equal(parseRules('@powered-by Ünïcode').poweredBy, null)
    assert.equal(parseRules(`@powered-by ${'x'.repeat(129)}`).poweredBy, null)
  })

  it('drops rules of hostnames without @host, and keeps the first rule and @host for a source', () => {
    const rules = parseRules(
      `${HEAD}@host A.Example.Test. check=SECOND\nother.example.test/x\thttps://b.example.test/\na.example.test/x\thttps://first.example.test/\na.example.test/x/\thttps://second.example.test/\n`
    )
    assert.equal(rules.hosts.size, 1)
    assert.equal(rules.hosts.get('a.example.test')?.token, 'T')
    assert.equal(rules.hosts.get('a.example.test')?.exact.get('/x')?.target, 'https://first.example.test/')
  })

  it('skips sources and targets that are not rules', () => {
    const rules = parseRules(
      [
        HEAD,
        'https://a.example.test/scheme\thttps://b.example.test/',
        'a.example.test\thttps://b.example.test/',
        'a.example.test/sp ace\thttps://b.example.test/',
        'a.example.test/relative\t/elsewhere',
        'a.example.test/teapot\thttps://b.example.test/\t418',
        'a.example.test/framed\thttps://b.example.test/\tFRAME',
        'a.example.test/only-source',
        'a.example.test/q?ignored=1\thttps://b.example.test/q\t\t\tk=v\textra',
      ].join('\n')
    )
    assert.deepEqual([...rules.hosts.get('a.example.test')!.exact.keys()], ['/q'])
  })

  it('reads the frame status, with flags, exact and catch-all', () => {
    const host = parseRules(`${HEAD}a.example.test/tour\thttps://b.example.test/\tframe\na.example.test/*\thttps://b.example.test/\tframe\tpq\n`).hosts.get('a.example.test')!
    assert.equal(host.exact.get('/tour')?.status, 'frame')
    assert.equal(host.catchAll?.status, 'frame')
    assert.equal(host.catchAll?.appendPath, true)
  })

  it('keeps p for the catch-all only', () => {
    const host = parseRules(`${HEAD}a.example.test/*\thttps://b.example.test/\t301\tpq\na.example.test/x\thttps://b.example.test/\t301\tp\n`).hosts.get('a.example.test')!
    assert.equal(host.catchAll?.appendPath, true)
    assert.equal(host.exact.get('/x')?.appendPath, false)
  })
})

describe('matching', () => {
  it('compares paths decoded, bytewise, with slashes trimmed', () => {
    assert.equal(matchPath('//old/'), '/old')
    assert.equal(matchPath('/'), '/')
    assert.equal(matchPath('/%C3%BC'), matchPath('/ü'))
    assert.equal(matchPath('/%c3%bc'), '/ü')
    assert.equal(matchPath('/%zz'), '/%zz', 'a malformed escape is matched as written')
    assert.notEqual(matchPath('/%FF'), matchPath('/%FE'), 'bytes that are not UTF-8 stay distinct')
    assert.equal(matchPath('/%FF'), matchPath('/%ff'))
  })

  it('normalizes hostnames', () => {
    assert.equal(normalizeHost('Shop.Example.TEST.:8443'), 'shop.example.test')
    assert.equal(normalizeHost('[2001:db8::1]:443'), '2001:db8::1')
    assert.equal(normalizeHost('2001:db8::1'), '2001:db8::1')
  })

  it('builds the Location with path, query and fragment', () => {
    const rule = (target: string, flags = ''): Rule => ({ source: 'a/*', target, status: 301, appendPath: flags.includes('p'), keepQuery: flags.includes('q') })
    const url = new URL('https://a.example.test/x/y?k=1')
    assert.equal(buildLocation(rule('https://b.example.test/'), url), 'https://b.example.test/')
    assert.equal(buildLocation(rule('https://b.example.test/', 'pq'), url), 'https://b.example.test/x/y?k=1')
    assert.equal(buildLocation(rule('https://b.example.test/base?', 'q'), url), 'https://b.example.test/base?k=1')
    assert.equal(buildLocation(rule('https://b.example.test/base?v=2#top', 'q'), url), 'https://b.example.test/base?v=2&k=1#top')
    assert.equal(buildLocation(rule('https://b.example.test/base#', 'p'), url), 'https://b.example.test/base/x/y#')
  })
})

describe('framePage', () => {
  it('frames the src in one full-window iframe titled with the target hostname, both escaped', () => {
    const page = framePage('https://b.example.test/?a=1&b="<x>\'', 'https://B.Example.test/?v=1')
    assert.equal(page.match(/<iframe\b/g)?.length, 1)
    assert.match(page, /<iframe src="https:\/\/b\.example\.test\/\?a=1&#38;b=&#34;&#60;x&#62;&#39;" allowfullscreen><\/iframe>/)
    assert.match(page, /<title>b\.example\.test<\/title>/)
    assert.match(page, /<meta charset="utf-8">/)
    assert.match(page, /<meta name="viewport"/)
    assert.equal(escapeHtml(`&<>"'x`), '&#38;&#60;&#62;&#34;&#39;x')
  })
})
