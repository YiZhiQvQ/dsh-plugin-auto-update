/**
 * Exercises the update route against a scripted manager: the call order for a
 * successful update, the restore after a failed install, and the refusals that
 * must never reach the package manager.
 *
 *   node --test test/update.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const mod = await import('../index.js')

/**
 * The route reads npm through the global `fetch`. Serving a canned package
 * document keeps these assertions independent of what the registry publishes
 * today — a real release must not turn a green test red. The proxy path is
 * disabled so these stubs are what the code actually calls.
 */
process.env.DSH_PLUGIN_UPDATE_NO_PROXY = '1'
const PACKUMENTS = {
  'dsh-connect-workbuddy': {
    'dist-tags': { latest: '4.9.4' },
    versions: { '4.8.1': {}, '4.9.4': {} },
  },
}
/** Raw manifests a Git source publishes, keyed by `owner/repo`. */
const MANIFESTS = {
  'masknull/dsh-qoder-connect': { name: 'dsh-qoder-connect', version: '0.3.0' },
  'masknull/pinned-plugin': { name: 'pinned-plugin', version: '1.0.0' },
}
const realFetch = globalThis.fetch
const REGISTRY_HOST = /^https?:\/\/registry\.[^/]+\//
const RAW_HOST = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/HEAD\/package\.json$/
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input)
  if (REGISTRY_HOST.test(url)) {
    const name = decodeURIComponent(url.replace(REGISTRY_HOST, ''))
    const document = PACKUMENTS[name]
    if (document !== undefined) {
      return new Response(JSON.stringify(document), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{"error":"not found"}', { status: 404 })
  }
  const raw = RAW_HOST.exec(url)
  if (raw) {
    const document = MANIFESTS[raw[1]]
    if (document !== undefined) {
      return new Response(JSON.stringify(document), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('404: Not Found', { status: 404 })
  }
  return realFetch(input, init)
}

/** Mount `apply` on a context whose manager records every call. */
function mount({ bundles, install }) {
  const routes = new Map()
  const calls = []
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    pluginManager: {
      async listBundles() {
        return bundles
      },
      async registries() {
        return { registry: 'https://registry.npmmirror.com/', fallbackRegistries: [], resolved: null }
      },
      async removeBundle(name) {
        calls.push(['remove', name])
        return { changed: true, application: 'applied', stage: 'remove', target: name }
      },
      async installBundle(spec, options) {
        calls.push(['install', spec, options])
        return install(spec, options)
      },
    },
    effect(callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
  }
  mod.apply(ctx)
  return { routes, calls }
}

/** Serve one route set on an ephemeral port and run one POST against it. */
async function post(routes, path, body) {
  const server = createServer(async (req, res) => {
    const route = routes.get(req.url.split('?')[0])
    if (!route) {
      res.writeHead(404)
      res.end()
      return
    }
    await route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-plugin-update': '1' },
      body: JSON.stringify(body),
    })
    return { status: response.status, payload: await response.json() }
  } finally {
    server.close()
  }
}

const registryBundle = (overrides = {}) => ({
  name: 'dsh-connect-workbuddy',
  version: '4.8.1',
  source: 'dsh-connect-workbuddy@^4.8.1',
  enabled: true,
  installed: true,
  availability: 'profile',
  removable: true,
  ...overrides,
})

test('a successful update removes, installs the new range, and reports the version', async () => {
  const { routes, calls } = mount({
    bundles: [registryBundle()],
    install: (spec) => ({ changed: true, application: 'applied', stage: 'install', target: spec, version: '4.9.4' }),
  })
  const { status, payload } = await post(routes, '/plugin-update/update', { name: 'dsh-connect-workbuddy' })
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.result.from, '4.8.1')
  assert.equal(payload.result.to, '4.9.4')
  assert.deepEqual(calls.map((call) => call[0]), ['remove', 'install'])
  assert.equal(calls[0][1], 'dsh-connect-workbuddy')
  assert.equal(calls[1][1], 'dsh-connect-workbuddy@^4.9.4')
  assert.equal(calls[1][2].enabled, true)
})

test('a failed install reinstalls the previous spec', async () => {
  const { routes, calls } = mount({
    bundles: [registryBundle()],
    install: (spec) => (spec.startsWith('dsh-connect-workbuddy@^4.9')
      ? { changed: true, application: 'failed', stage: 'install', target: spec, error: { code: 'operation-error' } }
      : { changed: true, application: 'applied', stage: 'install', target: spec, version: '4.8.1' }),
  })
  const { payload } = await post(routes, '/plugin-update/update', { name: 'dsh-connect-workbuddy' })
  assert.equal(payload.ok, false)
  assert.deepEqual(calls.map((call) => call[1]), [
    'dsh-connect-workbuddy',
    'dsh-connect-workbuddy@^4.9.4',
    'dsh-connect-workbuddy@^4.8.1',
  ])
  assert.equal(payload.result.steps.restore.application, 'applied')
})

test('an exact pin stays exact and a disabled bundle stays disabled', async () => {
  const { routes, calls } = mount({
    bundles: [registryBundle({ source: 'dsh-connect-workbuddy@4.8.1', enabled: false })],
    install: (spec) => ({ changed: true, application: 'applied', stage: 'install', target: spec, version: '4.9.4' }),
  })
  await post(routes, '/plugin-update/update', { name: 'dsh-connect-workbuddy' })
  assert.equal(calls[1][1], 'dsh-connect-workbuddy@4.9.4')
  assert.equal(calls[1][2].enabled, false)
})

test('a local link is refused before anything is removed', async () => {
  const { routes, calls } = mount({
    bundles: [registryBundle({ name: 'dsh-chatmanager', source: 'link:E:/documents/Project/dsh-chatmanager' })],
    install: () => ({ changed: true, application: 'applied' }),
  })
  const { payload } = await post(routes, '/plugin-update/update', { name: 'dsh-chatmanager' })
  assert.equal(payload.ok, false)
  assert.match(payload.result.message, /not installed from a registry or a Git repository/)
  assert.deepEqual(calls, [])
})

test('a Git source reinstalls its own spec, because the branch carries the update', async () => {
  const { routes, calls } = mount({
    bundles: [registryBundle({
      name: 'dsh-qoder-connect',
      version: '0.2.11',
      source: 'github:masknull/dsh-qoder-connect',
    })],
    install: () => ({ changed: true, application: 'applied', version: '0.3.0' }),
  })
  const { payload } = await post(routes, '/plugin-update/update', { name: 'dsh-qoder-connect' })
  assert.equal(payload.ok, true)
  assert.equal(payload.result.from, '0.2.11')
  assert.equal(payload.result.to, '0.3.0')
  // The spec is the Git address itself: a version pin would freeze the branch.
  assert.equal(payload.result.spec, 'github:masknull/dsh-qoder-connect')
  assert.deepEqual(calls, [
    ['remove', 'dsh-qoder-connect'],
    ['install', 'github:masknull/dsh-qoder-connect', { enabled: true, registry: undefined }],
  ])
})

test('a Git source already at the remote version is left alone', async () => {
  const { routes, calls } = mount({
    bundles: [registryBundle({
      name: 'pinned-plugin',
      version: '1.0.0',
      source: 'github:masknull/pinned-plugin',
    })],
    install: () => ({ changed: true, application: 'applied' }),
  })
  const { payload } = await post(routes, '/plugin-update/update', { name: 'pinned-plugin' })
  assert.equal(payload.ok, false)
  assert.match(payload.result.message, /already at the newest version/)
  assert.deepEqual(calls, [])
})

test('the bundle refuses to update itself', async () => {
  const { routes, calls } = mount({
    bundles: [registryBundle({ name: 'dsh-plugin-update', source: 'dsh-plugin-update@^0.1.0' })],
    install: () => ({ changed: true, application: 'applied' }),
  })
  const { payload } = await post(routes, '/plugin-update/update', { name: 'dsh-plugin-update' })
  assert.equal(payload.ok, false)
  assert.match(payload.result.message, /cannot update itself/)
  assert.deepEqual(calls, [])
})

test('a mutation without the client header is rejected', async () => {
  const { routes } = mount({
    bundles: [registryBundle()],
    install: () => ({ changed: true, application: 'applied' }),
  })
  const server = createServer(async (req, res) => {
    await routes.get(req.url.split('?')[0]).handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/plugin-update/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'dsh-connect-workbuddy' }),
    })
    assert.equal(response.status, 403)
  } finally {
    server.close()
  }
})
