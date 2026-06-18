const assert = require('node:assert/strict')
const test = require('node:test')

const {
  findUnicodeCompletionPrefix,
  isUnicodeCompletionCharacter,
  unicodeCompletionMatches,
} = require('../dist/unicodeCompletion')

test('finds Julia unicode completion prefixes', () => {
  assert.deepEqual(findUnicodeCompletionPrefix('x = \\alp', 8), {
    prefix: '\\alp',
    start: 4,
    end: 8,
  })
  assert.deepEqual(findUnicodeCompletionPrefix('# \\:smile:', 10), {
    prefix: '\\:smile:',
    start: 2,
    end: 10,
  })
  assert.deepEqual(findUnicodeCompletionPrefix('x = \\^2', 7), {
    prefix: '\\^2',
    start: 4,
    end: 7,
  })
})

test('rejects non-unicode completion prefixes', () => {
  assert.equal(findUnicodeCompletionPrefix('x = alpha', 9), undefined)
  assert.equal(findUnicodeCompletionPrefix('x = \\α', 6), undefined)
  assert.equal(isUnicodeCompletionCharacter('α'), false)
})

test('matches generated Julia unicode completions by prefix', () => {
  assert.ok(unicodeCompletionMatches('\\alpha').some(([label, value]) => label === '\\alpha' && value === 'α'))
  assert.ok(unicodeCompletionMatches('\\sqrt').some(([label, value]) => label === '\\sqrt' && value === '√'))
  assert.ok(unicodeCompletionMatches('\\:smil').some(([label]) => label.startsWith('\\:smil')))
  assert.deepEqual(unicodeCompletionMatches('alpha'), [])
})
