/**
 * A dry run of the Host report against this profile's real plugin manager.
 *
 * It mounts the bundle's `apply` on a fake context whose `pluginManager` is the
 * live service object obtained through the Cordis Inspect gateway, so the report
 * is built from the same facts the running tab will read. Nothing is installed,
 * removed, or written: only the read-only routes are exercised.
 *
 *   node test/dry-run.mjs
 */
import { createServer } from 'node:http'

const mod = await import('../index.js')

// The read-only subset of the manager the report needs. The live service is
// resolved by the caller; this script only needs its shape to be faithful.
const routes = new Map()
const fakeWebServer = {
  register(route) {
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  },
}

const fakeManager = {
  async listBundles() {
    return globalThis.__DSH_BUNDLES__ ?? []
  },
  async registries() {
    return globalThis.__DSH_REGISTRIES__ ?? { registry: null, fallbackRegistries: [], resolved: null }
  },
  async removeBundle() {
    throw new Error('dry run: removeBundle is not available')
  },
  async installBundle() {
    throw new Error('dry run: installBundle is not available')
  },
}

const ctx = {
  webServer: fakeWebServer,
  pluginManager: fakeManager,
  effect(callback) {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
}

mod.apply(ctx)
console.log('routes:', [...routes.keys()].join(', '))

// Exercise the check route over a real HTTP round trip.
const server = createServer(async (req, res) => {
  const path = req.url.split('?')[0]
  const route = routes.get(path)
  if (!route) {
    res.writeHead(404)
    res.end('no route')
    return
  }
  await route.handler(req, res)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const base = `http://127.0.0.1:${port}`

const check = await fetch(`${base}/plugin-update/check`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-plugin-update': '1' },
  body: JSON.stringify({ refresh: true }),
})
const payload = await check.json()
console.log('check status:', check.status, 'ok:', payload.ok)
if (payload.report) {
  console.log('registries:', payload.report.registries.join(', '))
  console.log('runtime:', payload.report.runtimeVersion)
  console.log('counts:', JSON.stringify(payload.report.counts))
  for (const row of payload.report.rows) {
    console.log([
      row.status.padEnd(12),
      (row.name ?? '').padEnd(26),
      String(row.current ?? '').padEnd(10),
      '->',
      String(row.latest ?? '').padEnd(10),
      row.spec ?? '',
      row.reason ?? '',
    ].join(' '))
  }
} else {
  console.log('error:', payload.error)
}

server.close()
