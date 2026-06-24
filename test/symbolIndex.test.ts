const assert = require('node:assert/strict')
const test = require('node:test')

const { SymbolStore } = require('../dist/symbolIndex/store')
const { rankDefinitions, rankReferences, rankWorkspaceSymbols } = require('../dist/symbolIndex/ranking')
const { envChain, inScopeRoots } = require('../dist/symbolIndex/envScope')

const sym = (over) => ({
  name: 'x',
  qualifiedName: 'x',
  namespace: 'value',
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

const ref = (over) => ({
  name: 'x',
  namespace: 'value',
  file: '/a.jl',
  root: '/root',
  tier: 'workspace',
  start: { line: 0, character: 0 },
  end: { line: 0, character: 1 },
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

test('store keeps macro and value namespaces separate', () => {
  const store = new SymbolStore()
  store.setFile('/a.jl', [
    sym({ name: 'foo', namespace: 'value', file: '/a.jl' }),
    sym({ name: 'foo', namespace: 'macro', qualifiedName: '@foo', file: '/a.jl' }),
  ])
  assert.equal(store.definitionsFor('foo', 'value').length, 1)
  assert.equal(store.definitionsFor('foo', 'macro').length, 1)
  assert.equal(store.definitionsFor('foo', 'macro')[0].qualifiedName, '@foo')
})

test('store indexes references, including files without definitions', () => {
  const store = new SymbolStore()
  store.setFile('/a.jl', [], [ref({ name: 'foo', file: '/a.jl' })])
  store.setFile('/b.jl', [sym({ name: 'foo', file: '/b.jl' })], [ref({ name: 'foo', file: '/b.jl' })])
  assert.deepEqual(
    store.referencesFor('foo').map((r) => r.file),
    ['/a.jl', '/b.jl'],
  )
  assert.ok(store.hasFile('/a.jl'))
  store.removeFile('/a.jl')
  assert.deepEqual(
    store.referencesFor('foo').map((r) => r.file),
    ['/b.jl'],
  )
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
  store.setFile('/pkg/src/B.jl', [], [ref({ name: 'a', file: '/pkg/src/B.jl', root: '/pkg' })])
  store.setFile('/ws/x.jl', [sym({ name: 'b', file: '/ws/x.jl', root: '/ws' })], [ref({ name: 'b', file: '/ws/x.jl', root: '/ws' })])
  store.removeRoot('/pkg')
  assert.equal(store.definitionsFor('a').length, 0)
  assert.equal(store.referencesFor('a').length, 0)
  assert.equal(store.definitionsFor('b').length, 1)
  assert.equal(store.referencesFor('b').length, 1)
})

// ---- ranking: definitions ----

test('exact qualified match ranks first', () => {
  const token = { name: 'foo', namespace: 'value', full: 'Base.foo', qualifier: 'Base' }
  const candidates = [
    sym({ name: 'foo', qualifiedName: 'foo', tier: 'workspace', file: '/w.jl' }),
    sym({ name: 'foo', qualifiedName: 'Base.foo', tier: 'base', file: '/base.jl' }),
  ]
  const ranked = rankDefinitions(token, candidates, '/cur.jl', 10)
  assert.equal(ranked[0].qualifiedName, 'Base.foo')
})

test('unqualified click still matches a qualified method', () => {
  const token = { name: 'foo', namespace: 'value', full: 'foo' }
  const candidates = [sym({ name: 'foo', qualifiedName: 'Base.foo', tier: 'base' })]
  const ranked = rankDefinitions(token, candidates, '/cur.jl', 10)
  assert.equal(ranked.length, 1)
})

test('workspace ranks before package before stdlib', () => {
  const token = { name: 'foo', namespace: 'value', full: 'foo' }
  const candidates = [
    sym({ name: 'foo', qualifiedName: 'foo', tier: 'stdlib', file: '/s.jl' }),
    sym({ name: 'foo', qualifiedName: 'foo', tier: 'package', file: '/p.jl' }),
    sym({ name: 'foo', qualifiedName: 'foo', tier: 'workspace', file: '/w.jl' }),
  ]
  const ranked = rankDefinitions(token, candidates, '/cur.jl', 10)
  assert.deepEqual(ranked.map((r) => r.tier), ['workspace', 'package', 'stdlib'])
})

test('same-file definition is boosted above other tiers', () => {
  const token = { name: 'foo', namespace: 'value', full: 'foo' }
  const candidates = [
    sym({ name: 'foo', qualifiedName: 'foo', tier: 'workspace', file: '/other.jl' }),
    sym({ name: 'foo', qualifiedName: 'foo', tier: 'base', file: '/cur.jl', global: false }),
  ]
  const ranked = rankDefinitions(token, candidates, '/cur.jl', 10)
  assert.equal(ranked[0].file, '/cur.jl')
})

test('rankDefinitions caps results', () => {
  const token = { name: 'foo', namespace: 'value', full: 'foo' }
  const candidates = Array.from({ length: 10 }, (_, i) => sym({ name: 'foo', file: `/f${i}.jl` }))
  assert.equal(rankDefinitions(token, candidates, '/cur.jl', 3).length, 3)
})

test('rankReferences sorts current file first, merges lines, and caps', () => {
  const candidates = [
    ref({ file: '/b.jl', start: { line: 2, character: 3 }, end: { line: 2, character: 4 } }),
    ref({ file: '/cur.jl', start: { line: 5, character: 9 }, end: { line: 5, character: 10 } }),
    ref({ file: '/cur.jl', start: { line: 5, character: 20 }, end: { line: 5, character: 21 } }),
    ref({ file: '/a.jl', start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }),
  ]
  const ranked = rankReferences(candidates, '/cur.jl', 3)
  assert.deepEqual(
    ranked.map((r) => `${r.file}:${r.start.line}:${r.start.character}`),
    ['/cur.jl:5:9', '/a.jl:1:0', '/b.jl:2:3'],
  )
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
