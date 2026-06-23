const assert = require('node:assert/strict')
const test = require('node:test')

const { extractSymbols, lineStarts, positionAt } = require('../dist/symbolIndex/lezerSymbols')

const find = (syms, name) => syms.find((s) => s.name === name)
const all = (syms, name) => syms.filter((s) => s.name === name)

test('extracts modules, long/short functions, macros, types and consts', () => {
  const src = [
    'module M',
    'function foo(x) end',
    'bar(y) = y',
    'macro mac(x) end',
    'struct S a::Int end',
    'mutable struct MS end',
    'abstract type AT end',
    'primitive type PT 8 end',
    'const K = 3',
    'end',
  ].join('\n')
  const syms = extractSymbols(src)
  assert.equal(find(syms, 'M').kind, 'module')
  assert.equal(find(syms, 'foo').kind, 'function')
  assert.equal(find(syms, 'bar').kind, 'function')
  assert.equal(find(syms, 'mac').kind, 'macro')
  assert.equal(find(syms, 'mac').qualifiedName, '@mac')
  assert.equal(find(syms, 'S').kind, 'struct')
  assert.equal(find(syms, 'MS').kind, 'mutable struct')
  assert.equal(find(syms, 'AT').kind, 'abstract type')
  assert.equal(find(syms, 'PT').kind, 'primitive type')
  assert.equal(find(syms, 'K').kind, 'const')
  // all are nested inside module M
  assert.deepEqual(find(syms, 'foo').containerPath, ['M'])
})

test('bare-name long function (no parens)', () => {
  const syms = extractSymbols('function noparen end')
  assert.equal(find(syms, 'noparen').kind, 'function')
})

test('qualified method keeps qualifiedName but matches on leaf', () => {
  const syms = extractSymbols('function Base.foo(x::Int) where T\n  1\nend')
  const s = find(syms, 'foo')
  assert.ok(s)
  assert.equal(s.qualifiedName, 'Base.foo')
})

test('short functions with return-type and where clauses', () => {
  assert.ok(find(extractSymbols('f(x)::Int = x'), 'f'))
  assert.ok(find(extractSymbols('g(x) where T = x'), 'g'))
})

test('operator short definition', () => {
  const s = find(extractSymbols('+(a,b) = a'), '+')
  assert.ok(s)
  assert.equal(s.kind, 'function')
})

test('struct type parameters and supertype are stripped from the name', () => {
  const syms = extractSymbols('struct Bar{T} <: Abc\n a::Int\nend')
  assert.ok(find(syms, 'Bar'))
  assert.equal(find(syms, 'Bar'), all(syms, 'Bar')[0])
  assert.equal(find(syms, 'Abc'), undefined)
})

test('tuple const binds multiple names', () => {
  const syms = extractSymbols('const a, b = 1, 2')
  assert.ok(find(syms, 'a'))
  assert.ok(find(syms, 'b'))
})

test('docstring before a definition does not hide it', () => {
  const syms = extractSymbols('"a docstring"\nfunction documented() end')
  const s = find(syms, 'documented')
  assert.ok(s)
  assert.equal(s.global, true)
})

test('macro-wrapped definitions are found and remain global', () => {
  assert.equal(find(extractSymbols('@inline fast(x) = x'), 'fast').global, true)
  assert.equal(find(extractSymbols('@doc "d" function g() end'), 'g').global, true)
})

test('nested definitions are flagged non-global', () => {
  const src = 'function outer()\n  helper(z) = z + 1\n  return helper\nend'
  const syms = extractSymbols(src)
  assert.equal(find(syms, 'outer').global, true)
  assert.equal(find(syms, 'helper').global, false)
})

test('name range points at the name token', () => {
  const src = 'function foo(x) end'
  const syms = extractSymbols(src)
  const s = find(syms, 'foo')
  assert.equal(src.slice(s.nameRange.from, s.nameRange.to), 'foo')
})

test('const short-form function is not double-counted', () => {
  const syms = extractSymbols('const f(x) = x')
  assert.equal(all(syms, 'f').length, 1)
  assert.equal(find(syms, 'f').kind, 'const')
})

test('positionAt converts offsets to 0-based line/character', () => {
  const src = 'a\nbb\nccc'
  const starts = lineStarts(src)
  assert.deepEqual(positionAt(0, starts), { line: 0, character: 0 })
  assert.deepEqual(positionAt(2, starts), { line: 1, character: 0 })
  assert.deepEqual(positionAt(5, starts), { line: 2, character: 0 })
})
