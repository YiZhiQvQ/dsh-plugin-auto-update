/**
 * Offline checks for the pure helpers in index.js: version comparison, npm
 * range matching, install-spec classification, and the "next spec" rule.
 *
 *   node --test test/helpers.test.js
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const { __test } = await import('../index.js')
const { parseVersion, compareVersions, satisfies, classifySource, nextSpec, newestVersion } = __test

test('parseVersion accepts exact semver only', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, pre: [] })
  assert.deepEqual(parseVersion('0.2.1-rc.2'), { major: 0, minor: 2, patch: 1, pre: ['rc', '2'] })
  assert.equal(parseVersion('^1.2.3'), undefined)
  assert.equal(parseVersion('1.2'), undefined)
  assert.equal(parseVersion(undefined), undefined)
})

test('compareVersions orders releases, prereleases, and builds', () => {
  const v = (text) => parseVersion(text)
  assert.equal(compareVersions(v('1.2.3'), v('1.2.3')), 0)
  assert.equal(compareVersions(v('1.2.3'), v('1.2.4')), -1)
  assert.equal(compareVersions(v('1.10.0'), v('1.9.9')), 1)
  assert.equal(compareVersions(v('1.0.0-rc.2'), v('1.0.0')), -1)
  assert.equal(compareVersions(v('1.0.0-rc.2'), v('1.0.0-rc.10')), -1)
  assert.equal(compareVersions(v('1.0.0-alpha'), v('1.0.0-alpha.1')), -1)
  assert.equal(compareVersions(v('1.0.0-alpha.1'), v('1.0.0-alpha.beta')), -1)
  assert.equal(compareVersions(v('1.0.0-beta'), v('1.0.0-beta.2')), -1)
})

test('satisfies follows caret, tilde, comparator and union ranges', () => {
  assert.equal(satisfies('0.2.5', '^0.2.0-rc.2'), true)
  assert.equal(satisfies('0.3.0', '^0.2.0-rc.2'), false)
  assert.equal(satisfies('0.2.9', '^0.2.1-rc.2'), true)
  assert.equal(satisfies('1.9.0', '^1.2.3'), true)
  assert.equal(satisfies('2.0.0', '^1.2.3'), false)
  assert.equal(satisfies('0.0.4', '^0.0.3'), false)
  assert.equal(satisfies('0.0.3', '^0.0.3'), true)
  assert.equal(satisfies('1.2.9', '~1.2.3'), true)
  assert.equal(satisfies('1.3.0', '~1.2.3'), false)
  assert.equal(satisfies('1.2.3', '>=1.2.0 <2.0.0'), true)
  assert.equal(satisfies('2.0.0', '>=1.2.0 <2.0.0'), false)
  assert.equal(satisfies('3.1.4', '^1 || ^2 || ^3'), true)
  assert.equal(satisfies('4.0.0', '^1 || ^2 || ^3'), false)
  assert.equal(satisfies('1.5.0', '1.2.0 - 1.6.0'), true)
  assert.equal(satisfies('1.7.0', '1.2.0 - 1.6.0'), false)
  assert.equal(satisfies('0.2.1-rc.2', '>=0.2.1-rc.2 <0.3.0'), true)
  assert.equal(satisfies('0.2.0', '>=0.2.1-rc.2 <0.3.0'), false)
  assert.equal(satisfies('1.2.3', '*'), true)
  assert.equal(satisfies('1.2.3', 'x'), true)
  assert.equal(satisfies('1.2.3', '1.x'), true)
  assert.equal(satisfies('1.2.3', '1.2'), true)
  assert.equal(satisfies('1.3.0', '1.2'), false)
  assert.equal(satisfies('1.2.3', ''), true)
})

test('classifySource separates registry specs from everything else', () => {
  assert.equal(classifySource('dsh-ops@^0.3.0').kind, 'registry')
  assert.equal(classifySource('@scope/pkg@1.2.3').kind, 'registry')
  assert.equal(classifySource('link:E:/documents/Project/x').kind, 'local')
  assert.equal(classifySource('file:../x').kind, 'local')
  assert.equal(classifySource('workspace:*').kind, 'local')
  assert.equal(classifySource('github:user/repo').kind, 'git')
  assert.equal(classifySource('git+https://example.com/x.git').kind, 'git')
  assert.equal(classifySource('https://example.com/x.tgz').kind, 'tarball')
  assert.equal(classifySource('alias@npm:real@1.0.0').kind, 'alias')
  assert.equal(classifySource(undefined).kind, 'unknown')
})

test('nextSpec keeps the caret or tilde the dependency already used', () => {
  assert.equal(nextSpec('dsh-ops', '^0.3.0', '0.4.0'), 'dsh-ops@^0.4.0')
  assert.equal(nextSpec('dsh-ops', '~0.3.0', '0.4.0'), 'dsh-ops@~0.4.0')
  assert.equal(nextSpec('dsh-ops', '0.3.0', '0.4.0'), 'dsh-ops@0.4.0')
  assert.equal(nextSpec('dsh-ops', undefined, '0.4.0'), 'dsh-ops@0.4.0')
})

test('newestVersion prefers the latest tag, then the highest stable', () => {
  assert.deepEqual(
    newestVersion({ 'dist-tags': { latest: '1.2.0' }, versions: { '1.1.0': {}, '1.2.0': {} } }),
    { version: '1.2.0', channel: 'latest' },
  )
  assert.deepEqual(
    newestVersion({ versions: { '1.1.0': {}, '1.2.0': {}, '2.0.0-beta.1': {} } }),
    { version: '1.2.0', channel: 'stable' },
  )
  assert.deepEqual(
    newestVersion({ versions: { '2.0.0-beta.1': {} } }),
    { version: '2.0.0-beta.1', channel: 'prerelease' },
  )
  assert.equal(newestVersion({ versions: {} }), undefined)
})
