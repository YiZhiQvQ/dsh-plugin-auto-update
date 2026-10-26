/**
 * dsh-plugin-update — Host half.
 *
 * The profile's plugin manager can install, remove and enable bundles, but it
 * never asks npm whether a newer version exists: the Web page only offers
 * Update for the Official catalog entries it ships, and a profile dependency
 * installed from a registry just keeps running whatever `pnpm` resolved the
 * day it was added.
 *
 * This half answers the missing question and performs the update:
 *
 *   GET  /plugin-update/state   -> { ok, report }         (cached report)
 *   POST /plugin-update/check   -> { ok, report }         (asks npm now)
 *   POST /plugin-update/update  -> { ok, result, report } (one bundle)
 *
 * Every mutation goes through `ctx.pluginManager`, the same service the Plugins
 * page and the `plugin_manager` tool use, so the unload/reinstall sequence and
 * the profile's saved state stay identical to a manual Update.
 */
import { execFileSync, spawn } from 'node:child_process'
import http from 'node:http'
import tls from 'node:tls'

const ROUTE_PREFIX = '/plugin-update'
const CLIENT_HEADER = 'x-plugin-update'
const OWN_PACKAGE = 'dsh-plugin-update'
const PACKUMENT_TTL_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 8000
// A raw Git host is slower than a registry from some networks and serves one
// small file, so it gets its own, longer budget instead of starving the pool.
const GIT_TIMEOUT_MS = 20000
// The plugin manager gives a Git spec host five seconds before it gives up, so
// a probe that waits longer would report a host the install cannot use.
const GIT_PROBE_TIMEOUT_MS = 5000
const MAX_PARALLEL = 4
const MAX_BODY_BYTES = 64 * 1024

export const inject = ['webServer', 'pluginManager']

function log(...args) {
  // eslint-disable-next-line no-console
  console.log('[dsh-plugin-update]', ...args)
}

function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message) return error.message
  return String(error)
}

// ── versions ────────────────────────────────────────────────────────────────

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** Parse one exact semver string; `undefined` for anything else. */
function parseVersion(text) {
  if (typeof text !== 'string') return undefined
  const match = VERSION_PATTERN.exec(text.trim())
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function comparePre(left, right) {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const size = Math.max(left.length, right.length)
  for (let index = 0; index < size; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const numericA = /^\d+$/.test(a)
    const numericB = /^\d+$/.test(b)
    if (numericA && numericB) {
      const difference = Number(a) - Number(b)
      if (difference !== 0) return difference < 0 ? -1 : 1
      continue
    }
    if (numericA) return -1
    if (numericB) return 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/** Total order over two parsed versions. */
function compareVersions(left, right) {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return comparePre(left.pre, right.pre)
}

/**
 * A `major[.minor[.patch]]` range part; `undefined` fields are wildcards, and
 * an explicit `x`, `X`, or `*` in any position is the same wildcard.
 */
function parsePartial(text) {
  const match = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/.exec(text)
  if (!match) return undefined
  const part = (raw) => {
    if (raw === undefined || raw === 'x' || raw === 'X' || raw === '*') return undefined
    return Number(raw)
  }
  const major = part(match[1])
  return {
    major,
    minor: part(match[2]),
    patch: part(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function lowerBound(partial) {
  return {
    major: partial.major,
    minor: partial.minor ?? 0,
    patch: partial.patch ?? 0,
    pre: partial.pre,
  }
}

/** The exclusive upper bound of a partial version: `1` → `2.0.0`, `1.2` → `1.3.0`. */
function partialUpper(partial) {
  if (partial.minor === undefined) return { major: partial.major + 1, minor: 0, patch: 0, pre: [] }
  if (partial.patch === undefined) return { major: partial.major, minor: partial.minor + 1, patch: 0, pre: [] }
  return undefined
}

/** The exclusive upper bound of `^partial`, following npm's caret rules. */
function caretUpper(partial) {
  if (partial.minor === undefined) return { major: partial.major + 1, minor: 0, patch: 0, pre: [] }
  if (partial.major !== 0) return { major: partial.major + 1, minor: 0, patch: 0, pre: [] }
  if (partial.minor !== 0) return { major: 0, minor: partial.minor + 1, patch: 0, pre: [] }
  if (partial.patch === undefined) return { major: 0, minor: 1, patch: 0, pre: [] }
  return { major: 0, minor: 0, patch: partial.patch + 1, pre: [] }
}

/** The exclusive upper bound of `~partial`. */
function tildeUpper(partial) {
  if (partial.minor === undefined) return { major: partial.major + 1, minor: 0, patch: 0, pre: [] }
  return { major: partial.major, minor: partial.minor + 1, patch: 0, pre: [] }
}
function testComparator(version, token) {
  const match = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(token)
  if (!match) return false
  const operator = match[1] ?? ''
  const raw = match[2].trim()
  if (raw === '' || /^[xX*]$/.test(raw)) return true
  const partial = parsePartial(raw)
  if (!partial) return false
  const exact = partial.minor !== undefined && partial.patch !== undefined
  if (operator === '^') {
    return compareVersions(version, lowerBound(partial)) >= 0
      && compareVersions(version, caretUpper(partial)) < 0
  }
  if (operator === '~') {
    return compareVersions(version, lowerBound(partial)) >= 0
      && compareVersions(version, tildeUpper(partial)) < 0
  }
  if (!exact) {
    // A partial version is a range, not a point: `1.2` means `>=1.2.0 <1.3.0`.
    const lower = lowerBound(partial)
    const upper = partialUpper(partial) ?? caretUpper(partial)
    if (operator === '=' || operator === '') {
      return compareVersions(version, lower) >= 0 && compareVersions(version, upper) < 0
    }
    const point = lower
    if (operator === '>=') return compareVersions(version, point) >= 0
    if (operator === '<=') return compareVersions(version, upper) < 0
    if (operator === '>') return compareVersions(version, upper) >= 0
    return compareVersions(version, point) < 0
  }
  const point = lowerBound(partial)
  const order = compareVersions(version, point)
  switch (operator) {
    case '': return order === 0
    case '=': return order === 0
    case '>=': return order >= 0
    case '<=': return order <= 0
    case '>': return order > 0
    case '<': return order < 0
    default: return false
  }
}

/**
 * Whether `version` satisfies `range`.
 *
 * Supports the forms real `engines` and peer ranges use: `||`, whitespace-joined
 * comparators, `^`, `~`, `x`/`*` wildcards, hyphen ranges, and bare versions.
 * A prerelease candidate matches only when a set that satisfies it also names a
 * prerelease, which is npm's rule.
 */
function satisfies(version, range) {
  if (typeof range !== 'string') return true
  const trimmed = range.trim()
  if (trimmed === '' || trimmed === '*' || trimmed === 'x') return true
  const parsed = typeof version === 'string' ? parseVersion(version) : version
  if (!parsed) return false
  const prerelease = parsed.pre.length > 0
  let matched = false
  let namesPrerelease = false
  for (const set of trimmed.split('||')) {
    const body = set.trim()
    if (body === '') return true
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(body)
    if (hyphen) {
      const lower = parsePartial(hyphen[1])
      const upper = parsePartial(hyphen[2])
      if (!lower || !upper) continue
      if (compareVersions(parsed, lowerBound(lower)) < 0) continue
      if (compareVersions(parsed, { major: upper.major, minor: (upper.minor ?? 0) + 1, patch: 0, pre: [] }) >= 0) continue
      matched = true
      namesPrerelease ||= /-[0-9A-Za-z]/.test(body)
      continue
    }
    const tokens = body.split(/\s+/).filter(Boolean)
    if (!tokens.every((token) => testComparator(parsed, token))) continue
    matched = true
    namesPrerelease ||= /-[0-9A-Za-z]/.test(body)
  }
  if (!matched) return false
  if (!prerelease) return true
  return namesPrerelease
}

// ── registry documents ──────────────────────────────────────────────────────

function packumentPath(name) {
  return name.startsWith('@') ? name.replace('/', '%2f') : name
}

function normalizeRegistry(registry) {
  if (typeof registry !== 'string' || registry === '') return undefined
  return registry.endsWith('/') ? registry : `${registry}/`
}

/** The registries to ask, first one first, without duplicates. */
function registryOrder(registries) {
  const seen = new Set()
  const out = []
  for (const entry of [registries?.registry, registries?.resolved, ...(registries?.fallbackRegistries ?? [])]) {
    const normalized = normalizeRegistry(entry)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  if (out.length === 0) out.push('https://registry.npmjs.org/')
  return out
}

/** Read one package document, moving to the next registry while one is unusable. */
async function readPackument(name, registries, signal) {
  let lastError
  for (const registry of registries) {
    try {
      const response = await fetch(`${registry}${packumentPath(name)}`, {
        headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
        redirect: 'follow',
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      })
      if (response.status === 404) {
        lastError = new Error(`${name} is not published on ${registry}`)
        continue
      }
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status} from ${registry}`)
        continue
      }
      const document = await response.json()
      if (!document || typeof document !== 'object' || typeof document.versions !== 'object') {
        lastError = new Error(`${registry} returned no package document for ${name}`)
        continue
      }
      return { document, registry }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error(`no registry answered for ${name}`)
}

/** The version npm calls newest: `latest`, else the highest stable, else the highest. */
function newestVersion(document) {
  const versions = document.versions ?? {}
  const tags = document['dist-tags'] ?? {}
  const tagged = typeof tags.latest === 'string' ? tags.latest : undefined
  if (tagged !== undefined && versions[tagged] !== undefined) return { version: tagged, channel: 'latest' }
  let bestStable
  let best
  for (const key of Object.keys(versions)) {
    const parsed = parseVersion(key)
    if (!parsed) continue
    if (parsed.pre.length === 0 && (bestStable === undefined || compareVersions(parsed, bestStable.parsed) > 0)) {
      bestStable = { version: key, parsed }
    }
    if (best === undefined || compareVersions(parsed, best.parsed) > 0) best = { version: key, parsed }
  }
  if (bestStable) return { version: bestStable.version, channel: 'stable' }
  if (best) return { version: best.version, channel: 'prerelease' }
  return undefined
}

/**
 * The `owner/repo` a Git source points at, with any `#ref` fragment and the
 * `git+`/`.git` decorations removed. Returns `undefined` for a Git address the
 * raw-manifest lookup cannot address (an arbitrary host, an scp-like remote
 * without an owner).
 */
function gitTarget(source) {
  if (typeof source !== 'string' || source === '') return undefined
  const bare = source.replace(/#.*$/, '')
  const shorthand = /^(?:github|gitlab|bitbucket|gist):([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(bare)
  if (shorthand) {
    const host = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org', gist: 'gist.github.com' }[
      /^([a-z]+):/i.exec(bare)[1].toLowerCase()
    ]
    return { host, owner: shorthand[1], repo: shorthand[2] }
  }
  const url = /^(?:git\+)?(?:https?|ssh):\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(bare)
  if (url) return { host: url[1].toLowerCase(), owner: url[2], repo: url[3] }
  const scp = /^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(bare)
  if (scp) return { host: scp[1].toLowerCase(), owner: scp[2], repo: scp[3] }
  return undefined
}

/** The raw-manifest URLs to try for one Git target, in order. */
function rawManifestUrls(target) {
  if (!target) return []
  const { host, owner, repo } = target
  if (host === 'github.com') {
    // HEAD follows the repository's default branch, so a rename from main to
    // master (or the reverse) needs no extra request.
    return [`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/package.json`]
  }
  if (host === 'gitlab.com') {
    return [`https://gitlab.com/${owner}/${repo}/-/raw/HEAD/package.json`]
  }
  if (host === 'bitbucket.org') {
    return [`https://bitbucket.org/${owner}/${repo}/raw/HEAD/package.json`]
  }
  return []
}

/**
 * The proxy to reach a raw Git host through, or `undefined` to go direct.
 *
 * A DSH process inherits neither `HTTPS_PROXY` nor the Windows Internet
 * Settings proxy that a shell's `Invoke-WebRequest` honours, so a raw host that
 * is only reachable through a local proxy fails inside the Host while working
 * from a terminal. Environment variables come first because they are explicit;
 * the Windows per-user setting is the fallback that makes the common desktop
 * setup work without configuration.
 */
function proxyFor(url) {
  // A test or a caller that stubs the global fetch asks for the direct path.
  if (process.env.DSH_PLUGIN_UPDATE_NO_PROXY === '1') return undefined
  const env = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
  if (typeof env === 'string' && env.trim() !== '') {
    try {
      const parsed = new URL(env.trim())
      return { host: parsed.hostname, port: Number(parsed.port || 8080) }
    } catch {
      // A malformed variable is ignored rather than fatal.
    }
  }
  if (process.platform !== 'win32') return undefined
  const bypass = process.env.NO_PROXY || process.env.no_proxy
  if (typeof bypass === 'string' && bypass.split(',').some((entry) => entry.trim() !== '' && url.includes(entry.trim()))) {
    return undefined
  }
  try {
    // Reading the registry needs a child process; it is cheap and only runs
    // when a Git manifest is actually fetched.
    const output = execFileSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v', 'ProxyServer',
    ], { encoding: 'utf8', timeout: 3000, windowsHide: true })
    const match = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(output)
    if (!match) return undefined
    const value = match[1].includes('=') ? (/https=([^;]+)/i.exec(match[1])?.[1] ?? '') : match[1]
    const [host, port] = value.split(':')
    if (!host || !port) return undefined
    return { host, port: Number(port) }
  } catch {
    return undefined
  }
}

/** Fetch one URL through `proxy` when one applies, else with the global fetch. */
async function fetchText(url, signal, timeoutMs) {
  const proxy = proxyFor(url)
  if (!proxy) {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      redirect: 'follow',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    })
    return { status: response.status, text: await response.text() }
  }
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const timer = setTimeout(() => {
      request.destroy(new Error(`timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    const request = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${target.hostname}:443`,
    })
    const fail = (error) => {
      clearTimeout(timer)
      reject(error)
    }
    request.on('error', fail)
    request.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        fail(new Error(`proxy refused CONNECT with ${response.statusCode}`))
        return
      }
      const secure = tls.connect({ socket, servername: target.hostname }, () => {
        secure.write(
          `GET ${target.pathname}${target.search} HTTP/1.1\r\n`
          + `Host: ${target.hostname}\r\n`
          + 'Accept: application/json\r\n'
          + 'Connection: close\r\n\r\n',
        )
      })
      let buffer = ''
      secure.setEncoding('utf8')
      secure.on('data', (chunk) => { buffer += chunk })
      secure.on('error', fail)
      secure.on('end', () => {
        clearTimeout(timer)
        const split = buffer.indexOf('\r\n\r\n')
        if (split === -1) {
          reject(new Error('the proxy returned no HTTP response'))
          return
        }
        const head = buffer.slice(0, split)
        const status = Number(/^HTTP\/\d\.\d (\d{3})/.exec(head)?.[1] ?? 0)
        resolve({ status, text: buffer.slice(split + 4) })
      })
    })
    request.end()
    if (signal) {
      signal.addEventListener('abort', () => {
        request.destroy(new Error('aborted'))
      }, { once: true })
    }
  })
}

/**
 * Whether `git` can open an HTTPS session to the host, checked without a
 * clone. The plugin manager runs `git` itself and has no proxy support, so a
 * host reachable only through a proxy fails its install — and the removal that
 * precedes it would already have happened.
 */
async function gitHostReachable(target) {
  if (!target) return { ok: false, reason: 'the Git address names no host' }
  // The test suite drives a scripted manager; a real `git` probe would reach
  // the network and make the assertions depend on it.
  if (process.env.DSH_PLUGIN_UPDATE_NO_PROXY === '1') return { ok: true }
  // The plugin manager runs `git` with the environment it was started with and
  // adds no proxy of its own, so the probe deliberately drops the proxy
  // variables this bundle would otherwise honour: a host that needs them is a
  // host the install cannot reach either.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete env[key]
  }
  env.GIT_CONFIG_COUNT = '1'
  env.GIT_CONFIG_KEY_0 = 'http.proxy'
  env.GIT_CONFIG_VALUE_0 = ''
  try {
    await runGit(['ls-remote', '--heads', `https://${target.host}/${target.owner}/${target.repo}`], env)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: messageOf(error) }
  }
}

/** Run `git` with a bounded wait, resolving when it exits 0. */
function runGit(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { env, windowsHide: true })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('git timed out'))
    }, GIT_PROBE_TIMEOUT_MS)
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(stderr.trim().split('\n').pop() || `git exited ${code}`))
    })
  })
}

/** Read the package manifest a Git source publishes, for its version and engines. */
async function readRemoteManifest(source, signal) {
  const urls = rawManifestUrls(gitTarget(source))
  if (urls.length === 0) {
    const error = new Error('this Git host publishes no raw manifest this bundle can read')
    error.permanent = true
    throw error
  }
  let lastError
  for (const url of urls) {
    try {
      const { status, text } = await fetchText(url, signal, GIT_TIMEOUT_MS)
      if (status === 404) {
        lastError = new Error(`${gitTarget(source)?.owner}/${gitTarget(source)?.repo} has no package.json on its default branch`)
        continue
      }
      if (status !== 200) {
        lastError = new Error(`HTTP ${status} reading ${url}`)
        continue
      }
      let document
      try {
        document = JSON.parse(text)
      } catch {
        lastError = new Error(`${url} is not a package manifest`)
        continue
      }
      if (!document || typeof document !== 'object' || typeof document.version !== 'string') {
        lastError = new Error(`${url} is not a package manifest`)
        continue
      }
      return document
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('the remote manifest could not be read')
}

/** `engines.dsh` else the DSH peer range, as the plugin manager reads them. */
function dshRequirement(manifest) {
  const engines = manifest?.engines
  if (engines && typeof engines.dsh === 'string' && engines.dsh.trim() !== '') {
    return { range: engines.dsh, source: 'engines.dsh' }
  }
  const peers = manifest?.peerDependencies
  if (peers && typeof peers['@deepseek-ai/dsh'] === 'string') {
    return { range: peers['@deepseek-ai/dsh'], source: 'peerDependencies["@deepseek-ai/dsh"]' }
  }
  return undefined
}

// ── profile facts ──────────────────────────────────────────────────────────

/**
 * How a saved dependency spec resolves. `git` means a remote repository this
 * bundle can ask for a newer manifest; `git-unreadable` is a Git address on a
 * host whose raw files are not reachable, kept separate so the row can say so.
 */
function classifySource(source) {
  if (typeof source !== 'string' || source === '') return { kind: 'unknown' }
  if (/^(?:link|file|workspace):/i.test(source)) return { kind: 'local' }
  if (/^(?:github|gitlab|bitbucket|gist):/i.test(source)
    || /^git(?:\+[a-z]+)?:\/\//i.test(source)
    || /^git@/i.test(source)
    || /^https?:\/\/[^/]+\/[^/]+\/[^/#]+(?:\.git)?(?:#.*)?$/i.test(source)) {
    const target = gitTarget(source)
    return rawManifestUrls(target).length > 0 ? { kind: 'git', target } : { kind: 'git-unreadable', target }
  }
  if (/\.(?:tgz|tar\.gz)(?:#.*)?$/i.test(source)) return { kind: 'tarball' }
  if (source.includes('@npm:')) return { kind: 'alias' }
  return { kind: 'registry' }
}

/** The range of a `name@range` dependency spec, or `undefined`. */
function rangeOf(name, source) {
  if (typeof source !== 'string' || !source.startsWith(`${name}@`)) return undefined
  return source.slice(name.length + 1)
}

/** The spec to install for `version`, keeping a caret or tilde the user already had. */
function nextSpec(name, range, version) {
  if (typeof range === 'string') {
    const operator = /^([\^~])/.exec(range)
    if (operator) return `${name}@${operator[1]}${version}`
  }
  return `${name}@${version}`
}

/** The DSH runtime version, read from the installation-provided base bundle. */
function runtimeVersionOf(bundles) {
  const base = bundles.find((bundle) => bundle.name === '@deepseek-ai/dsh-base' && bundle.version)
    ?? bundles.find((bundle) => bundle.name === '@deepseek-ai/dsh-web-app' && bundle.version)
  return base?.version
}

/** Run `task` over `items` with a bounded number in flight. */
async function mapLimited(items, limit, task) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await task(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function localizedText(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const out = {}
    for (const [locale, text] of Object.entries(value)) {
      if (typeof text === 'string') out[locale] = text
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
  return undefined
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
  } catch {
    // Headers already flushed; end() still terminates the response.
  }
  res.end(payload)
}

async function readJsonBody(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

export function apply(ctx) {
  const packuments = new Map()
  const manifests = new Map()
  let report
  let checkInFlight
  let updateInFlight

  /** The profile's registry-installed bundles, newest facts first. */
  async function profileBundles() {
    const all = await ctx.pluginManager.listBundles()
    return { all, managed: all.filter((bundle) => bundle.installed && bundle.availability === 'profile' && bundle.removable) }
  }

  function cachedPackument(name) {
    const entry = packuments.get(name)
    if (!entry) return undefined
    if (Date.now() - entry.at > PACKUMENT_TTL_MS) return undefined
    return entry
  }

  async function packumentFor(name, registries, refresh, signal) {
    if (!refresh) {
      const cached = cachedPackument(name)
      if (cached) return cached
    }
    const { document, registry } = await readPackument(name, registries, signal)
    const entry = { at: Date.now(), document, registry }
    packuments.set(name, entry)
    return entry
  }

  /** The remote manifest a Git source publishes, cached like a packument. */
  async function manifestFor(source, refresh, signal) {
    const cached = manifests.get(source)
    if (!refresh && cached && Date.now() - cached.at <= PACKUMENT_TTL_MS) return cached.document
    const document = await readRemoteManifest(source, signal)
    manifests.set(source, { at: Date.now(), document })
    return document
  }

  /** Build one row per profile bundle; only registry sources are asked about. */
  async function buildReport(options) {
    const { all, managed } = await profileBundles()
    const registries = registryOrder(await ctx.pluginManager.registries())
    const runtimeVersion = runtimeVersionOf(all)
    const controller = new AbortController()
    const startedAt = Date.now()

    const rows = await mapLimited(managed, MAX_PARALLEL, async (bundle) => {      const source = bundle.source
      const classification = classifySource(source)
      const row = {
        name: bundle.name,
        title: localizedText(bundle.meta?.title),
        description: localizedText(bundle.meta?.description) ?? bundle.description,
        current: bundle.version,
        enabled: bundle.enabled,
        source,
        kind: classification.kind,
        spec: source,
        status: 'unsupported',
      }
      if (classification.kind === 'git') {
        row.channel = 'repository'
        row.remote = `${classification.target.owner}/${classification.target.repo}`
        try {
          const manifest = await manifestFor(source, options.refresh, controller.signal)
          const latest = parseVersion(manifest.version)
          const current = parseVersion(bundle.version)
          row.latest = manifest.version
          if (!current || !latest) {
            row.status = 'error'
            row.reason = 'unreadable version'
            return row
          }
          if (compareVersions(latest, current) <= 0) {
            row.status = 'current'
            return row
          }
          const requirement = dshRequirement(manifest)
          if (requirement && runtimeVersion && !satisfies(runtimeVersion, requirement.range)) {
            row.status = 'incompatible'
            row.requirement = requirement
            return row
          }
          row.status = 'update'
          return row
        } catch (error) {
          row.status = 'error'
          row.reason = messageOf(error)
          return row
        }
      }
      if (classification.kind !== 'registry') {
        row.reason = classification.kind
        return row
      }
      const range = rangeOf(bundle.name, source)
      row.range = range
      try {
        const entry = await packumentFor(bundle.name, registries, options.refresh, controller.signal)
        const newest = newestVersion(entry.document)
        if (!newest) {
          row.status = 'error'
          row.reason = 'no published version'
          return row
        }
        row.latest = newest.version
        row.channel = newest.channel
        row.registry = entry.registry
        row.spec = nextSpec(bundle.name, range, newest.version)
        const current = parseVersion(bundle.version)
        const latest = parseVersion(newest.version)
        if (!current || !latest) {
          row.status = 'error'
          row.reason = 'unreadable version'
          return row
        }
        if (compareVersions(latest, current) <= 0) {
          row.status = 'current'
          return row
        }
        const manifest = entry.document.versions?.[newest.version]
        const requirement = dshRequirement(manifest)
        if (requirement && runtimeVersion && !satisfies(runtimeVersion, requirement.range)) {
          row.status = 'incompatible'
          row.requirement = requirement
          return row
        }
        row.status = 'update'
        return row
      } catch (error) {
        row.status = 'error'
        row.reason = messageOf(error)
        return row
      }
    })

    const order = { update: 0, incompatible: 1, error: 2, current: 3, unsupported: 4 }
    rows.sort((left, right) => {
      const delta = (order[left.status] ?? 9) - (order[right.status] ?? 9)
      if (delta !== 0) return delta
      return left.name.localeCompare(right.name)
    })

    return {
      checkedAt: Date.now(),
      elapsedMs: Date.now() - startedAt,
      runtimeVersion,
      registries,
      rows,
      counts: {
        total: rows.length,
        update: rows.filter((row) => row.status === 'update').length,
        incompatible: rows.filter((row) => row.status === 'incompatible').length,
        error: rows.filter((row) => row.status === 'error').length,
        current: rows.filter((row) => row.status === 'current').length,
        unsupported: rows.filter((row) => row.status === 'unsupported').length,
      },
    }
  }

  async function runCheck(refresh, names) {
    if (checkInFlight) return checkInFlight
    checkInFlight = (async () => {
      try {
        // A single-bundle check drops just that entry, so the rest of the
        // report is served from the cache instead of asking every remote again.
        if (Array.isArray(names) && names.length > 0) {
          const wanted = new Set(names)
          for (const name of wanted) packuments.delete(name)
          const { managed } = await profileBundles()
          for (const bundle of managed) {
            if (wanted.has(bundle.name)) manifests.delete(bundle.source)
          }
        }
        report = await buildReport({ refresh })
        return report
      } finally {
        checkInFlight = undefined
      }
    })()
    return checkInFlight
  }

  /** Remove, reinstall, and put the previous version back when the install fails. */
  async function updateBundle(name) {
    if (updateInFlight) {
      return { ok: false, busy: true, message: `an update of ${updateInFlight} is already running` }
    }
    if (name === OWN_PACKAGE) {
      // Removing this bundle would unload the routes answering this request.
      return { ok: false, name, message: 'this bundle cannot update itself while it serves the request' }
    }
    updateInFlight = name
    try {
      const { managed } = await profileBundles()
      const bundle = managed.find((candidate) => candidate.name === name)
      if (!bundle) return { ok: false, name, message: `${name} is not a removable profile bundle` }
      const classification = classifySource(bundle.source)
      const from = bundle.version
      const previousSpec = bundle.source
      const enabled = bundle.enabled

      let spec
      let registry
      let target
      if (classification.kind === 'git') {
        // A Git dependency names a branch, not a version: reinstalling the same
        // spec re-resolves it, which is what an update means for this source.
        const manifest = await manifestFor(bundle.source, true, new AbortController().signal)
        const latest = parseVersion(manifest.version)
        const current = parseVersion(bundle.version)
        if (!latest || !current) return { ok: false, name, message: `${name} has an unreadable version` }
        if (compareVersions(latest, current) <= 0) {
          return {
            ok: false,
            upToDate: true,
            name,
            from,
            to: manifest.version,
            message: `${name} is already at the newest version`,
          }
        }
        spec = previousSpec
        target = manifest.version
      } else if (classification.kind === 'registry') {
        const registries = registryOrder(await ctx.pluginManager.registries())
        const entry = await packumentFor(name, registries, true, new AbortController().signal)
        const newest = newestVersion(entry.document)
        if (!newest) return { ok: false, name, message: `${name} has no published version` }
        spec = nextSpec(name, rangeOf(name, bundle.source), newest.version)
        registry = entry.registry
        target = newest.version
      } else {
        return { ok: false, name, message: `${name} was not installed from a registry or a Git repository` }
      }

      const steps = {}
      // A Git install re-clones the repository, so a host that cannot be
      // reached right now would leave the bundle removed and unrestorable.
      // Prove reachability first, while the plugin is still installed.
      if (classification.kind === 'git') {
        const reachable = await gitHostReachable(classification.target)
        if (!reachable.ok) {
          return {
            ok: false,
            name,
            from,
            to: target,
            spec,
            message: `${classification.target.host} is not reachable from this Host, so ${name} was left installed (${reachable.reason})`,
          }
        }
      }
      steps.remove = await ctx.pluginManager.removeBundle(name)
      if (steps.remove?.error || steps.remove?.application === 'failed') {
        return { ok: false, name, from, to: target, spec, steps, message: 'removal failed' }
      }
      steps.install = await ctx.pluginManager.installBundle(spec, { enabled, registry })
      if (steps.install?.error || steps.install?.application === 'failed') {
        const pendingBuilds = steps.install?.pendingBuilds ?? []
        // Leave the person with a working plugin rather than nothing.
        if (typeof previousSpec === 'string' && previousSpec !== '') {
          try {
            steps.restore = await ctx.pluginManager.installBundle(previousSpec, { enabled, registry })
          } catch (error) {
            steps.restore = { application: 'failed', error: { code: 'operation-error', diagnostic: messageOf(error) } }
          }
        }
        return {
          ok: false,
          name,
          from,
          to: target,
          spec,
          steps,
          pendingBuilds,
          message: pendingBuilds.length > 0 ? 'installation was blocked by dependency build scripts' : 'installation failed',
        }
      }
      packuments.delete(name)
      report = await buildReport({ refresh: false }).catch(() => report)
      return {
        ok: true,
        name,
        from,
        to: steps.install.version ?? target,
        spec,
        steps,
        message: steps.install.application,
      }
    } catch (error) {
      return { ok: false, name, message: messageOf(error) }
    } finally {
      updateInFlight = undefined
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/state`,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      sendJson(res, 200, { ok: true, report: report ?? null, checking: checkInFlight !== undefined })
    },
  }), 'plugin-update: state route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/check`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      if (req.headers[CLIENT_HEADER] !== '1') {
        sendJson(res, 403, { ok: false, error: 'missing-client-header' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: messageOf(error) })
        return
      }
      try {
        const names = Array.isArray(body?.names)
          ? body.names.filter((name) => typeof name === 'string' && name !== '')
          : undefined
        const next = await runCheck(body?.refresh === true, names)
        sendJson(res, 200, { ok: true, report: next })
      } catch (error) {
        log('check failed:', messageOf(error))
        sendJson(res, 500, { ok: false, error: messageOf(error), report: report ?? null })
      }
    },
  }), 'plugin-update: check route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/update`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      if (req.headers[CLIENT_HEADER] !== '1') {
        sendJson(res, 403, { ok: false, error: 'missing-client-header' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: messageOf(error) })
        return
      }
      const name = typeof body?.name === 'string' ? body.name.trim() : ''
      if (name === '') {
        sendJson(res, 400, { ok: false, error: 'name is required' })
        return
      }
      log('updating', name)
      const result = await updateBundle(name)
      log('update finished:', name, result.ok ? 'ok' : messageOf(result.message))
      sendJson(res, 200, { ok: result.ok === true, result, report: report ?? null })
    },
  }), 'plugin-update: update route')

  // Warm the report once so opening the tab does not start from an empty page.
  ctx.effect(() => {
    const timer = setTimeout(() => {
      runCheck(false).catch((error) => log('initial check failed:', messageOf(error)))
    }, 4000)
    return () => clearTimeout(timer)
  }, 'plugin-update: initial check')
}

// Exported for a script that wants to exercise the range logic without the Host.
export const __test = {
  parseVersion, compareVersions, satisfies, classifySource, nextSpec, newestVersion,
  gitTarget, rawManifestUrls,
}
