const assert = require('node:assert/strict')
const test = require('node:test')

const { crc32c, slug, uuidToLeBytes, sha1HexToBytes, versionSlug } = require('../dist/symbolIndex/slug')

test('crc32c matches the standard CRC-32C check value', () => {
  // "123456789" -> 0xE3069283, the canonical CRC-32C (Castagnoli) check value.
  const bytes = Buffer.from('123456789', 'ascii')
  assert.equal(crc32c(bytes) >>> 0, 3808858755)
})

test('crc32c chaining equals a single pass over concatenated bytes', () => {
  const a = Buffer.from('hello', 'ascii')
  const b = Buffer.from('world', 'ascii')
  const chained = crc32c(b, crc32c(a))
  const single = crc32c(Buffer.concat([a, b]))
  assert.equal(chained, single)
})

test('uuidToLeBytes reverses the big-endian hex into native UInt128 order', () => {
  const le = uuidToLeBytes('00112233-4455-6677-8899-aabbccddeeff')
  assert.deepEqual(Array.from(le), [
    0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0x00,
  ])
})

test('sha1HexToBytes parses 20 bytes', () => {
  const bytes = sha1HexToBytes('01b8ccb13d68535d73d2b0c23e39bd23155fb712')
  assert.equal(bytes.length, 20)
  assert.equal(bytes[0], 0x01)
  assert.equal(bytes[19], 0x12)
})

test('versionSlug reproduces Base.version_slug for real packages', () => {
  // Verified against Base.version_slug in Julia 1.10.
  assert.equal(versionSlug('13072b0f-2c55-5437-9ae7-d433b7a33950', '01b8ccb13d68535d73d2b0c23e39bd23155fb712', 5), '08cuY')
  assert.equal(versionSlug('13072b0f-2c55-5437-9ae7-d433b7a33950', '01b8ccb13d68535d73d2b0c23e39bd23155fb712', 4), '08cu')
  assert.equal(versionSlug('70703baa-626e-46a2-a12c-08ffd08c73b4', '0000000000000000000000000000000000000001', 5), 'G3AJD')
})

test('versionSlug defaults to length-5 slugs', () => {
  assert.equal(versionSlug('13072b0f-2c55-5437-9ae7-d433b7a33950', '01b8ccb13d68535d73d2b0c23e39bd23155fb712').length, 5)
})

test('slug rejects nothing and is base62 over the alphabet', () => {
  assert.match(slug(0, 5), /^[A-Za-z0-9]{5}$/)
  assert.equal(slug(0, 5), 'AAAAA')
})

test('invalid inputs throw', () => {
  assert.throws(() => uuidToLeBytes('not-a-uuid'))
  assert.throws(() => sha1HexToBytes('abc'))
})
