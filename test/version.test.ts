import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'

import { PACKAGE, VERSION } from '../src/index.ts'

it('names itself as package.json does', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(`@redirhub/${PACKAGE}`, pkg.name)
  assert.equal(VERSION, pkg.version)
})
