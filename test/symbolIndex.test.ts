const assert = require('node:assert/strict')
const test = require('node:test')

const { SymbolStore } = require('../dist/symbolIndex/store')
const { rankDefinitions, rankWorkspaceSymbols } = require('../dist/symbolIndex/ranking')
const { envChain, inScopeRoots } = require('../dist/symbolIndex/envScope')

const sym = (over) => ({
  name: 'x',
  qualifiedName: 'x',
  kind: 'function',
  container: [],
  file: '/a.jl',
  root: '/root',
  tier: 'workspace',
  global: true,
  defStart: { line: 0, character: 0 },
  defEnd: { line: 0, character: 1 },
  nameStart: { line: 0, character: 0 },
  nameEnd: { line: 0, character: 1 },
  ...over,
})

// ---- store ----

test('store indexes, looks up, and removes by file', () => {
  const store = new SymbolStore()
  store.setFile('/a.jl', [sym({ name: 'foo', file: '/a.jl' })])
  store.setFile('/b.jl', [sym({ name: 'foo', file: '/b.jl' }), sym({ name: 'bar', file: '/b.jl' })])
  assert.equal(store.definitionsFor('foo').length, 2)
  store.removeFile('/a.jl')
  assert.equal(store.definitionsFor('foo').length, 1)
  assert.equal(store.definitionsFor('foo')[0].file, '/b.jl')
})

test('store globalSymbols yields only module-level symbols', () => {
  const store = new SymbolStore()
  store.setFile('/a.jl', [sym({ name: 'g', global: true }), sym({ name: 'local', global: false })])
  const names = [...store.globalSymbols()].map((s) => s.name)
  assert.deepEqual(names, ['g'])
})

test('store snapshot/load round-trips', () => {
  const store = new SymbolStore()
  store.setFile('/a.jl', [sym({ name: 'foo' })])
  const snap = store.snapshot(['/a.jl'])
  const store2 = new SymbolStore()
  store2.load(snap)
  assert.equal(store2.definitionsFor('foo').length, 1)
})

test('store removeRoot drops all files under a root', () => {
  const store = new SymbolStore()
  store.setFile('/pkg/src/A.jl', [sym({ name: 'a', file: '/pkg/src/A.jl', root: '/pkg' })])
  store.setFile('/ws/x.jl', [sym({ name: 'b', file: '/ws/x.jl', root: '/ws' })])
  store.removeRoot('/pkg')
  assert.equal(store.definitionsFor('a').length, 0)
  assert.equal(store.definitionsFor('b').length, 1)
})

// ---- ranking: definitions ----

test('exact qualified match ranks first', () => {
  const token = { name: 'foo', full: 'Base.foo', qualifier: 'Base' }
  const candidates = [
    sym({ name: 'foo', qualifiedName: 'foo', tier: 'workspace', file: '/w.jl' }),
    sym({ name: 'foo', qualifiedName: 'Base.foo', tier: 'base', file: '/base.jl' }),
  ]
  const ranked = rankDefinitions(token, candidates, '/cur.jl', 10)
  assert.equal(ranked[0].qualifiedName, 'Base.foo')
})

test('unqualified click still matches a qualified method', () => {
  const token = { name: 'foo', full: 'foo' }
  const candidates = [sym({ name: 'foo', qualifiedName: 'Base.foo', tier: 'base' })]
  const ranked = rankDefinitions(token, candidates, '/cur.jl', 10)
  assert.equal(ranked.length, 1)
})

test('workspace ranks before package before stdlib', () => {
  const token = { name: 'foo', full: 'foo' }
  const candidates = [
    sym({ name: 'foo', qualifiedName: 'foo', tier: 'stdlib', file: '/s.jl' }),
    sym({ name: 'foo', qualifiedName: 'foo', tier: 'package', file: '/p.jl' }),
    sym({ name: 'foo', qualifiedName: 'foo', tier: 'workspace', file: '/w.jl' }),
  ]
  const ranked = rankDefinitions(token, candidates, '/cur.jl', 10)
  assert.deepEqual(ranked.map((r) => r.tier), ['workspace', 'package', 'stdlib'])
})

test('same-file definition is boosted above other tiers', () => {
  const token = { name: 'foo', full: 'foo' }
  const candidates = [
    sym({ name: 'foo', qualifiedName: 'foo', tier: 'workspace', file: '/other.jl' }),
    sym({ name: 'foo', qualifiedName: 'foo', tier: 'base', file: '/cur.jl', global: false }),
  ]
  const ranked = rankDefinitions(token, candidates, '/cur.jl', 10)
  assert.equal(ranked[0].file, '/cur.jl')
})

test('rankDefinitions caps results', () => {
  const token = { name: 'foo', full: 'foo' }
  const candidates = Array.from({ length: 10 }, (_, i) => sym({ name: 'foo', file: `/f${i}.jl` }))
  assert.equal(rankDefinitions(token, candidates, '/cur.jl', 3).length, 3)
})

// ---- ranking: workspace symbols ----

test('workspace symbol search ranks exact/prefix and tiers, capped', () => {
  const symbols = [
    sym({ name: 'food', tier: 'package' }),
    sym({ name: 'foo', tier: 'workspace' }),
    sym({ name: 'bar', tier: 'workspace' }),
  ]
  const ranked = rankWorkspaceSymbols('foo', symbols, 10)
  assert.deepEqual(ranked.map((s) => s.name), ['foo', 'food'])
})

test('empty workspace query returns nothing', () => {
  assert.deepEqual(rankWorkspaceSymbols('  ', [sym({ name: 'foo' })], 10), [])
})

// ---- envScope ----

const ENVS = [
  { id: 'umbrella', projectDir: '/ws', packages: [{ uuid: 'foo', root: '/depot/Foo/v1' }] },
  { id: 'test', projectDir: '/ws/Pkg/test', packages: [{ uuid: 'foo', root: '/depot/Foo/v2' }] },
]

test('envChain is nearest-first', () => {
  const chain = envChain('/ws/Pkg/test/runtests.jl', ENVS)
  assert.deepEqual(chain.map((e) => e.id), ['test', 'umbrella'])
})

test('nearest env wins for a package pinned at two versions', () => {
  const scope = inScopeRoots('/ws/Pkg/test/runtests.jl', ENVS)
  assert.ok(scope.has('/depot/Foo/v2'))
  assert.ok(!scope.has('/depot/Foo/v1'))
  assert.ok(scope.has('/ws'))
})

test('loose file outside any env falls back to global (null)', () => {
  assert.equal(inScopeRoots('/elsewhere/x.jl', ENVS), null)
})

test('depot package file is scoped to the envs that reference it', () => {
  const scope = inScopeRoots('/depot/Foo/v1/src/Foo.jl', ENVS)
  assert.ok(scope.has('/depot/Foo/v1'))
  assert.ok(!scope.has('/depot/Foo/v2'))
})
