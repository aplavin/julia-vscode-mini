const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')

const {
  chooseManifestName,
  parseManifest,
  parseTomlSafely,
  packageSourceCandidates,
  resolvePackages,
} = require('../dist/symbolIndex/manifest')
const { buildProbeArgs, parseProbeOutput, parseVersion } = require('../dist/symbolIndex/probe')

const AXIS = { uuid: '13072b0f-2c55-5437-9ae7-d433b7a33950', tree: '01b8ccb13d68535d73d2b0c23e39bd23155fb712', slug: '08cuY' }

test('chooseManifestName prefers the versioned manifest', () => {
  const files = ['Project.toml', 'Manifest.toml', 'Manifest-v1.10.toml']
  assert.equal(chooseManifestName(files, 'Project.toml', { major: 1, minor: 10 }), 'Manifest-v1.10.toml')
})

test('chooseManifestName falls back to the plain manifest', () => {
  const files = ['Project.toml', 'Manifest.toml']
  assert.equal(chooseManifestName(files, 'Project.toml', { major: 1, minor: 11 }), 'Manifest.toml')
})

test('chooseManifestName pairs JuliaProject with JuliaManifest', () => {
  const files = ['JuliaProject.toml', 'JuliaManifest.toml']
  assert.equal(chooseManifestName(files, 'JuliaProject.toml'), 'JuliaManifest.toml')
})

test('parseManifest reads format 2.0 (deps-nested) entries', () => {
  const data = parseTomlSafely(
    ['manifest_format = "2.0"', 'julia_version = "1.10.0"', '[[deps.AxisAlgorithms]]', `uuid = "${AXIS.uuid}"`, `git-tree-sha1 = "${AXIS.tree}"`].join('\n'),
  )
  const entries = parseManifest(data)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, 'AxisAlgorithms')
  assert.equal(entries[0].uuid, AXIS.uuid)
  assert.equal(entries[0].treeSha1, AXIS.tree)
})

test('parseManifest reads format 1.0 (top-level) entries and skips meta keys', () => {
  const data = parseTomlSafely(
    ['julia_version = "1.6.0"', '[[AxisAlgorithms]]', `uuid = "${AXIS.uuid}"`, `git-tree-sha1 = "${AXIS.tree}"`].join('\n'),
  )
  const entries = parseManifest(data)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, 'AxisAlgorithms')
})

test('packageSourceCandidates uses the verified depot slug', () => {
  const candidates = packageSourceCandidates('AxisAlgorithms', AXIS.uuid, AXIS.tree, ['/depot'])
  assert.equal(candidates[0], path.join('/depot', 'packages', 'AxisAlgorithms', AXIS.slug))
})

test('resolvePackages resolves a git-tree-sha1 package from the depot', () => {
  const target = path.join('/depot', 'packages', 'AxisAlgorithms', AXIS.slug)
  const dirExists = (d) => d === target
  const { resolved, missing } = resolvePackages(
    [{ name: 'AxisAlgorithms', uuid: AXIS.uuid, treeSha1: AXIS.tree }],
    '/env',
    ['/depot'],
    dirExists,
  )
  assert.equal(missing.length, 0)
  assert.deepEqual(resolved, [
    { name: 'AxisAlgorithms', uuid: AXIS.uuid, sourceDir: target, kind: 'package', treeSha1: AXIS.tree },
  ])
})

test('resolvePackages tries depots in order', () => {
  const target = path.join('/depot2', 'packages', 'AxisAlgorithms', AXIS.slug)
  const dirExists = (d) => d === target
  const { resolved } = resolvePackages(
    [{ name: 'AxisAlgorithms', uuid: AXIS.uuid, treeSha1: AXIS.tree }],
    '/env',
    ['/depot1', '/depot2'],
    dirExists,
  )
  assert.equal(resolved[0].sourceDir, target)
})

test('resolvePackages resolves a path dependency relative to the manifest dir', () => {
  const target = path.resolve('/env', '../LocalPkg')
  const dirExists = (d) => d === target
  const { resolved } = resolvePackages([{ name: 'LocalPkg', uuid: 'u', path: '../LocalPkg' }], '/env', [], dirExists)
  assert.deepEqual(resolved, [{ name: 'LocalPkg', uuid: 'u', sourceDir: target, kind: 'path' }])
})

test('resolvePackages records missing sources without mutation, and skips stdlib entries', () => {
  const { resolved, missing } = resolvePackages(
    [
      { name: 'Gone', uuid: AXIS.uuid, treeSha1: AXIS.tree },
      { name: 'LinearAlgebra', uuid: '37e2e46d-f89d-539d-b4ee-838fcccc9c8e' }, // stdlib: no path/tree
    ],
    '/env',
    ['/depot'],
    () => false,
  )
  assert.equal(resolved.length, 0)
  assert.equal(missing.length, 1)
  assert.equal(missing[0].name, 'Gone')
})

test('buildProbeArgs forces a clean run and keeps executableArgs first', () => {
  const args = buildProbeArgs(['+1.10'])
  assert.equal(args[0], '+1.10')
  assert.ok(args.includes('--startup-file=no'))
  assert.ok(args.includes('-e'))
})

test('parseProbeOutput extracts version, base, stdlib and ordered depots', () => {
  const out = [
    'some banner noise',
    '__JLPROBE_VERSION=1.10.11',
    '__JLPROBE_BASE=/jl/share/julia/base',
    '__JLPROBE_STDLIB=/jl/share/julia/stdlib/v1.10',
    '__JLPROBE_DEPOT=/home/.julia',
    '__JLPROBE_DEPOT=/jl/share/julia',
  ].join('\n')
  const r = parseProbeOutput(out)
  assert.equal(r.version, '1.10.11')
  assert.equal(r.baseDir, '/jl/share/julia/base')
  assert.equal(r.stdlibDir, '/jl/share/julia/stdlib/v1.10')
  assert.deepEqual(r.depots, ['/home/.julia', '/jl/share/julia'])
})

test('parseVersion parses major.minor', () => {
  assert.deepEqual(parseVersion('1.10.11'), { major: 1, minor: 10 })
})
