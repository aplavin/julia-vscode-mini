const assert = require('node:assert/strict')
const test = require('node:test')

const {
  buildEvalCommand,
  buildJuliaCells,
  escapeJuliaStringContent,
  findCellAtOffset,
  juliaMultilineStringLiteral,
  nextCellWithCode,
} = require('../dist/evaluation')

test('escapes normal Julia string content for multiline literals', () => {
  const source = 'println("x = $x")\nr"\\d+"\r\0'
  assert.equal(
    escapeJuliaStringContent(source, true),
    'println(\\"x = \\$x\\")\nr\\"\\\\d+\\"\\u000D\\u0000'
  )
})

test('builds multiline literals without changing indentation', () => {
  assert.equal(
    juliaMultilineStringLiteral('    x = 1\n        y = 2'),
    '"""\n    x = 1\n        y = 2\n"""'
  )
})

test('builds source-aware eval commands', () => {
  assert.equal(
    buildEvalCommand('x = 1', '/tmp/example.jl', 2, 4, false),
    'JuliaVSCodeRuntime.eval_code("""\nx = 1\n""", "/tmp/example.jl", 2, 4; softscope=false)'
  )
})

test('parses Julia cells with upstream delimiter defaults', () => {
  const text = 'a = 1\n##\nb = 2\n# %%\nc = 3'
  const { cells, hasExplicitDelimiters } = buildJuliaCells(text)

  assert.equal(hasExplicitDelimiters, true)
  assert.equal(cells.length, 3)
  assert.equal(text.slice(cells[0].codeRange.start, cells[0].codeRange.end), 'a = 1\n')
  assert.equal(text.slice(cells[1].codeRange.start, cells[1].codeRange.end), 'b = 2\n')
  assert.equal(text.slice(cells[2].codeRange.start, cells[2].codeRange.end), 'c = 3')

  const current = findCellAtOffset(cells, text.indexOf('b = 2'))
  assert.equal(current.id, 1)
  assert.equal(findCellAtOffset(cells, text.indexOf('# %%')).id, 2)
  assert.equal(nextCellWithCode(cells, current).id, 2)
})

test('reports no explicit cells when no delimiter exists', () => {
  const { cells, hasExplicitDelimiters } = buildJuliaCells('x = 1\ny = 2')

  assert.equal(hasExplicitDelimiters, false)
  assert.equal(cells.length, 1)
  assert.equal(cells[0].codeRange.start, 0)
  assert.equal(cells[0].codeRange.end, 'x = 1\ny = 2'.length)
})
