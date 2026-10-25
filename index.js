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
const ROUTE_PREFIX = '/plugin-update'
const CLIENT_HEADER = 'x-plugin-update'
const OWN_PACKAGE = 'dsh-plugin-update'
const PACKUMENT_TTL_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 8000
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

/** How a saved dependency spec resolves: a registry range or something else. */
function classifySource(source) {
  if (typeof source !== 'string' || source === '') return { kind: 'unknown' }
  if (/^(?:link|file|workspace):/i.test(source)) return { kind: 'local' }
  if (/^(?:github|gitlab|bitbucket|gist):/i.test(source)
    || /^git(?:\+[a-z]+)?:\/\//i.test(source)
    || /^git@/i.test(source)
    || /^https?:\/\/[^/]+\/[^/]+\/[^/#]+(?:\.git)?(?:#.*)?$/i.test(source)) {
    return { kind: 'git' }
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
        // A single-bundle check drops just that packument, so the rest of the
        // report is served from the cache instead of asking every registry again.
        if (Array.isArray(names) && names.length > 0) {
          for (const name of names) packuments.delete(name)
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
      if (classifySource(bundle.source).kind !== 'registry') {
        return { ok: false, name, message: `${name} was not installed from a registry` }
      }
      const registries = registryOrder(await ctx.pluginManager.registries())
      const entry = await packumentFor(name, registries, true, new AbortController().signal)
      const newest = newestVersion(entry.document)
      if (!newest) return { ok: false, name, message: `${name} has no published version` }
      const range = rangeOf(name, bundle.source)
      const spec = nextSpec(name, range, newest.version)
      const from = bundle.version
      const previousSpec = bundle.source
      const enabled = bundle.enabled

      const steps = {}
      steps.remove = await ctx.pluginManager.removeBundle(name)
      if (steps.remove?.error || steps.remove?.application === 'failed') {
        return { ok: false, name, from, to: newest.version, spec, steps, message: 'removal failed' }
      }
      steps.install = await ctx.pluginManager.installBundle(spec, { enabled, registry: entry.registry })
      if (steps.install?.error || steps.install?.application === 'failed') {
        const pendingBuilds = steps.install?.pendingBuilds ?? []
        // Leave the person with a working plugin rather than nothing.
        if (typeof previousSpec === 'string' && previousSpec !== '') {
          try {
            steps.restore = await ctx.pluginManager.installBundle(previousSpec, { enabled, registry: entry.registry })
          } catch (error) {
            steps.restore = { application: 'failed', error: { code: 'operation-error', diagnostic: messageOf(error) } }
          }
        }
        return {
          ok: false,
          name,
          from,
          to: newest.version,
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
        to: steps.install.version ?? newest.version,
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
export const __test = { parseVersion, compareVersions, satisfies, classifySource, nextSpec, newestVersion }
