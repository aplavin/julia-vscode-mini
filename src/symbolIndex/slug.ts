// Julia-compatible depot "version slug" computation, reimplemented in TypeScript.
//
// Reproduces Base.version_slug (base/loading.jl) bit-exactly:
//   crc = _crc32c(uuid)               # CRC-32C over the 16 little-endian UUID bytes
//   crc = _crc32c(sha1.bytes, crc)    # chained over the 20 SHA1 bytes
//   slug(crc, p)                      # base62, least-significant digit first, length p
//
// _crc32c is the standard CRC-32C (Castagnoli): reflected polynomial 0x82F63B78,
// init = xorout = 0xFFFFFFFF. Verified against Base.version_slug for real packages.

const POLY = 0x82f63b78

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? POLY ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

// Standard CRC-32C over `bytes`. `seed` is a previously returned CRC, so chaining
// `crc32c(b, crc32c(a))` equals `crc32c([...a, ...b])` (the xorout/init cancel out).
export function crc32c(bytes: Uint8Array | number[], seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0
  for (let i = 0; i < bytes.length; i += 1) {
    c = (CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0
  }
  return (c ^ 0xffffffff) >>> 0
}

const SLUG_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

// base62 of `x`, least-significant digit first, `p` characters (Base.slug).
export function slug(x: number, p: number): string {
  let y = x >>> 0
  const n = SLUG_CHARS.length
  let out = ''
  for (let i = 0; i < p; i += 1) {
    const d = y % n
    y = Math.floor(y / n)
    out += SLUG_CHARS[d]
  }
  return out
}

// 16 bytes of the UUID's UInt128 value in native (little-endian) order, matching
// `_crc32c(uuid::UUID) = _crc32c(uuid.value, ...)` via `Ref{UInt128}`.
export function uuidToLeBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '')
  if (hex.length !== 32 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error(`invalid UUID: ${uuid}`)
  }
  const be = new Uint8Array(16)
  for (let i = 0; i < 16; i += 1) {
    be[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return be.reverse()
}

export function sha1HexToBytes(hex: string): Uint8Array {
  if (hex.length !== 40 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error(`invalid git-tree-sha1: ${hex}`)
  }
  const bytes = new Uint8Array(20)
  for (let i = 0; i < 20; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

// Base.version_slug(uuid, sha1, p). Julia tries p=5 (current) and p=4 (legacy).
export function versionSlug(uuid: string, treeSha1: string, p = 5): string {
  let crc = crc32c(uuidToLeBytes(uuid))
  crc = crc32c(sha1HexToBytes(treeSha1), crc)
  return slug(crc, p)
}
