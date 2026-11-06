/**
 * src/core/ and test/core/ are the same in every JavaScript implementation of the format. Fails
 * when a file differs from redirhub/cloudflare-redirects' main: change both repositories together.
 */

import { readdirSync, readFileSync } from 'node:fs'

const OTHER = 'https://raw.githubusercontent.com/redirhub/cloudflare-redirects/main/'
const DIRS = ['src/core', 'test/core']

let differs = false
for (const dir of DIRS) {
  for (const file of readdirSync(new URL(`../${dir}`, import.meta.url)).sort()) {
    const path = `${dir}/${file}`
    const response = await fetch(OTHER + path)
    const local = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    if (!response.ok || (await response.text()) !== local) {
      console.error(`${path} differs from ${OTHER}${path}${response.ok ? '' : ` (${response.status})`}`)
      differs = true
    }
  }
}
if (differs) {
  process.exit(1)
}
console.log('src/core and test/core match redirhub/cloudflare-redirects')
