/**
 * The workspace rules file, format v1, as specified in redirhub/integration-spec (its README and
 * the golden sample in spec/v1). Everything here is pure: parsing, matching and building the
 * `Location` need no server.
 */

/** The check path used when the rules file has no `@check` directive. */
export const DEFAULT_CHECK_PATH = '/_redirhub/check'

/** The rules file format this package understands. */
export const FORMAT_MAJOR = 1

/** Poll interval bounds for `@refresh`, in seconds. */
export const DEFAULT_REFRESH = 60
export const MIN_REFRESH = 30
export const MAX_REFRESH = 3600

export type RedirectStatus = 301 | 302 | 307 | 308

/** A rule's status column: a redirect status, or `frame` (the target shown in a frame page). */
export type RuleStatus = RedirectStatus | 'frame'

const STATUSES: ReadonlySet<number> = new Set([301, 302, 307, 308])

/** A rules file whose `@format` major version is not 1: the caller keeps its last good copy. */
export class UnknownFormatError extends Error {
  override name = 'UnknownFormatError'
}

export interface Rule {
  /** The source column as written; reports name the rule with it (`file=`). */
  source: string
  target: string
  status: RuleStatus
  /** `p`: append the request path (catch-all only). */
  appendPath: boolean
  /** `q`: keep the request query string. */
  keepQuery: boolean
}

export interface HostRules {
  name: string
  /** The check token of the `@host` line. */
  token: string
  /** `report404` on the `@host` line: the site's own 404 answers are reported too. */
  report404: boolean
  /** Exact rules by matching path (`matchPath`). */
  exact: Map<string, Rule>
  /** The `{host}/*` rule, or null. */
  catchAll: Rule | null
}

/** One parsed copy of a rules file. Immutable once built. */
export interface RuleSet {
  /** The file's ETag without quotes or the `W/` prefix. */
  etag: string
  /** Seconds between downloads, clamped to 30–3600. */
  refresh: number
  /** Where redirects and 404s are reported; null disables reporting. */
  hitsUrl: string | null
  checkPath: string
  /** Sent as `X-Powered-By` on every redirect and frame page from the rules; null sends none. */
  poweredBy: string | null
  /** The `@notify` push channel. Parsed for completeness; this package polls. */
  notifyUrl: string | null
  notifyToken: string | null
  /** Hostnames listed with `@host`, lowercase. */
  hosts: Map<string, HostRules>
}

/**
 * Parses a rules file. Lines that cannot be parsed, rules with an unknown flag letter and unknown
 * `@` directives are skipped; rules for hostnames without an `@host` line are dropped; the first
 * rule for a source wins. Throws UnknownFormatError for an `@format` whose major version is not 1;
 * a file without `@format` is read as v1.
 */
export function parseRules(body: string, etag = ''): RuleSet {
  const rules: RuleSet = {
    etag: cleanEtag(etag),
    refresh: DEFAULT_REFRESH,
    hitsUrl: null,
    checkPath: DEFAULT_CHECK_PATH,
    poweredBy: null,
    notifyUrl: null,
    notifyToken: null,
    hosts: new Map(),
  }
  const pending: Array<{ host: string; path: string | null; rule: Rule }> = []

  for (const raw of body.split('\n')) {
    const line = raw.replace(/\r+$/, '')
    if (line.trim() === '') {
      continue
    }
    if (line.startsWith('@')) {
      directive(rules, line)
      continue
    }
    const parsed = parseRuleLine(line)
    if (parsed) {
      pending.push(parsed)
    }
  }

  for (const { host, path, rule } of pending) {
    const hostRules = rules.hosts.get(host)
    if (!hostRules) {
      continue
    }
    if (path === null) {
      hostRules.catchAll ??= rule
    } else if (!hostRules.exact.has(path)) {
      hostRules.exact.set(path, { ...rule, appendPath: false })
    }
  }
  return rules
}

function directive(rules: RuleSet, line: string): void {
  const fields = line.trim().split(/\s+/)
  const [name, value] = fields
  switch (name) {
    case '@format': {
      const major = value?.split('.')[0]
      if (major === undefined || !/^[+-]?\d+$/.test(major) || Number(major) !== FORMAT_MAJOR) {
        throw new UnknownFormatError(`unknown rules file format: ${value ?? '(none)'}`)
      }
      break
    }
    case '@refresh':
      if (value !== undefined && /^[+-]?\d+$/.test(value)) {
        rules.refresh = Math.min(Math.max(Number(value), MIN_REFRESH), MAX_REFRESH)
      }
      break
    case '@hits':
      if (value !== undefined && isHttpUrl(value)) {
        rules.hitsUrl = value
      }
      break
    case '@check':
      if (value?.startsWith('/')) {
        rules.checkPath = value
      }
      break
    case '@notify':
      if (value !== undefined && isHttpUrl(value)) {
        rules.notifyUrl = value
        for (const option of fields.slice(2)) {
          if (option.startsWith('token=')) {
            rules.notifyToken = option.slice('token='.length)
          }
        }
      }
      break
    case '@powered-by': {
      // The rest of the line after the first space, trimmed, verbatim: printable ASCII, at most 128 bytes.
      const space = line.indexOf(' ')
      const text = space < 0 ? '' : line.slice(space + 1).trim()
      if (text.length <= 128 && /^[\x20-\x7e]*$/.test(text)) {
        rules.poweredBy = text === '' ? null : text
      }
      break
    }
    case '@host': {
      if (value === undefined) {
        break
      }
      const host = normalizeHost(value)
      if (host === '' || /[/*]/.test(host) || rules.hosts.has(host)) {
        break
      }
      const hostRules: HostRules = { name: host, token: '', report404: false, exact: new Map(), catchAll: null }
      for (const option of fields.slice(2)) {
        if (option.startsWith('check=')) {
          hostRules.token = option.slice('check='.length)
        } else if (option === 'report404') {
          hostRules.report404 = true
        }
      }
      rules.hosts.set(host, hostRules)
      break
    }
  }
}

/** `source<TAB>target[<TAB>status[<TAB>flags[<TAB>options]]]`; `path` null is the catch-all. */
function parseRuleLine(line: string): { host: string; path: string | null; rule: Rule } | null {
  const columns = line.split('\t')
  if (columns.length < 2) {
    return null
  }
  const source = columns[0].trim()
  const split = splitSource(source)
  const target = columns[1].trim()
  if (!split || !isHttpUrl(target)) {
    return null
  }
  const rule: Rule = { source, target, status: 301, appendPath: false, keepQuery: false }

  const status = columns[2]?.trim() ?? ''
  if (status === 'frame') {
    rule.status = 'frame'
  } else if (status !== '') {
    if (!/^[+-]?\d+$/.test(status) || !STATUSES.has(Number(status))) {
      return null
    }
    rule.status = Number(status) as RedirectStatus
  }
  // The options column (password=, destinations=, routing=, plugins=, …) is may-ignore: this
  // client carries none of them out, so the rule answers as if they were absent.
  for (const flag of columns[3]?.trim() ?? '') {
    if (flag === 'p') {
      rule.appendPath = true
    } else if (flag === 'q') {
      rule.keepQuery = true
    } else {
      return null // flags are must-understand
    }
  }

  return { host: split.host, path: split.path === '/*' ? null : matchPath(split.path), rule }
}

/** `host/path?query` into host and path; the query is ignored. A scheme or no path is not a rule. */
function splitSource(source: string): { host: string; path: string } | null {
  if (source.includes('://') || /[ "\\]/.test(source)) {
    return null
  }
  const end = source.search(/[?#]/)
  const rest = end < 0 ? source : source.slice(0, end)
  const slash = rest.indexOf('/')
  if (slash < 0) {
    return null
  }
  const host = normalizeHost(rest.slice(0, slash))
  return host === '' ? null : { host, path: rest.slice(slash) }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname !== ''
  } catch {
    return false
  }
}

const utf8 = new TextEncoder()
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/**
 * The form a path is matched in, as on RedirHub's edge: percent-decoded, leading and trailing
 * slashes trimmed (`/old/` and `//old` are `/old`), the root `/`. A path with a malformed escape
 * is matched as written. Decoding is bytewise, so `%c3%bc`, `%C3%BC` and a raw `ü` are one path,
 * and bytes that are not UTF-8 still only match the same bytes.
 */
export function matchPath(path: string): string {
  const decoded = percentDecode(path)
  return `/${(decoded ?? path).replace(/^\/+|\/+$/g, '')}`
}

function percentDecode(path: string): string | null {
  if (!path.includes('%')) {
    return path
  }
  const input = utf8.encode(path)
  const out = new Uint8Array(input.length)
  let n = 0
  for (let i = 0; i < input.length; i++) {
    if (input[i] !== 0x25) {
      out[n++] = input[i]
      continue
    }
    const hi = hex(input[i + 1])
    const lo = hex(input[i + 2])
    if (hi < 0 || lo < 0) {
      return null
    }
    out[n++] = (hi << 4) | lo
    i += 2
  }
  const bytes = out.subarray(0, n)
  try {
    return strictUtf8.decode(bytes)
  } catch {
    // Not UTF-8: one char per byte, behind a NUL no decoded path can start with.
    return `\0${String.fromCharCode(...bytes)}`
  }
}

function hex(byte: number | undefined): number {
  if (byte === undefined) return -1
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57
  return -1
}

/** A hostname lowercase, without its port and trailing dot (`Shop.Example.com.:443` → `shop.example.com`). */
export function normalizeHost(value: string): string {
  let host = value.trim()
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    if (end > 0 && host[end + 1] === ':') {
      host = host.slice(1, end)
    }
  } else {
    const colon = host.indexOf(':')
    if (colon >= 0 && colon === host.lastIndexOf(':')) {
      host = host.slice(0, colon)
    }
  }
  return host.toLowerCase().trim().replace(/\.$/, '')
}

/** An ETag without the weak prefix and quotes. */
export function cleanEtag(etag: string): string {
  return etag.trim().replace(/^W\//, '').replace(/^"+|"+$/g, '')
}

/** The exact rule for a request URL on a listed hostname, or null. */
export function matchExact(host: HostRules, url: URL): Rule | null {
  return host.exact.get(matchPath(url.pathname)) ?? null
}

/**
 * The `Location` of a rule for a request URL. With `appendPath` the escaped request path is
 * appended to the target's path without a double slash; with `keepQuery` the request query is
 * added with `?` or `&`, otherwise dropped. A fragment of the target stays last.
 */
export function buildLocation(rule: Rule, url: URL): string {
  const hash = rule.target.indexOf('#')
  const target = hash < 0 ? rule.target : rule.target.slice(0, hash)
  const question = target.indexOf('?')
  let base = question < 0 ? target : target.slice(0, question)
  const query = question < 0 ? '' : target.slice(question + 1)

  if (rule.appendPath) {
    base = base.replace(/\/$/, '') + url.pathname
  }
  let location = question < 0 ? base : `${base}?${query}`
  const requestQuery = url.search.replace(/^\?/, '')
  if (rule.keepQuery && requestQuery !== '') {
    location += question < 0 ? `?${requestQuery}` : query === '' ? requestQuery : `&${requestQuery}`
  }
  return hash < 0 ? location : `${location}#${rule.target.slice(hash + 1)}`
}

/**
 * The page a `frame` rule answers with: one full-window `<iframe>` showing `src` (the Location the
 * rule would redirect to), titled with its hostname. Both are HTML-escaped.
 */
export function framePage(src: string): string {
  let title = ''
  try {
    title = new URL(src).hostname
  } catch {
    // A Location changed by the caller into something that is not a URL: no title.
  }
  return (
    '<!DOCTYPE html>\n' +
    '<html>\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${escapeHtml(title)}</title>\n` +
    '<style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style>\n' +
    '</head>\n' +
    '<body>\n' +
    `<iframe src="${escapeHtml(src)}" allowfullscreen></iframe>\n` +
    '</body>\n' +
    '</html>\n'
  )
}

/** `&`, `<`, `>`, `"` and `'` as character references: safe in text and in a quoted attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}
