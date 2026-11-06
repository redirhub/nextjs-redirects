/**
 * spec/v1 is a copy of redirhub/integration-spec's spec/v1, the normative sample of format v1.
 * Fails when the copy differs: copy the files over and make the tests pass in the same change.
 */

import { readFileSync } from 'node:fs'

const SOURCE = 'https://raw.githubusercontent.com/redirhub/integration-spec/main/spec/v1/'
const FILES = ['rules.txt', 'requests.tsv', 'reports.txt']

let stale = false
for (const file of FILES) {
  const response = await fetch(SOURCE + file)
  if (!response.ok) {
    throw new Error(`${file}: ${response.status} from ${SOURCE}`)
  }
  const copy = readFileSync(new URL(`../spec/v1/${file}`, import.meta.url), 'utf8')
  if ((await response.text()) !== copy) {
    console.error(`spec/v1/${file} differs from ${SOURCE}${file}`)
    stale = true
  }
}
if (stale) {
  process.exit(1)
}
console.log('spec/v1 matches redirhub/integration-spec')
