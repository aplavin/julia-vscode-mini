const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')

const { cliSocketPath, generatePipeName } = require('../dist/paths')

test('generatePipeName uses the renamed julia-vscode-repl scheme (short)', () => {
  const p = generatePipeName('11112222-3333-4444-5555-666677778888')
  assert.equal(p, '/tmp/julia-vscode-repl-1111222233334444.sock')
  assert.ok(p.length < 104, 'socket path must fit the sun_path limit')
})

test('cliSocketPath hash matches the shell `shasum | cut` the CLI uses', () => {
  const dir = fs.realpathSync(__dirname)
  const got = cliSocketPath(dir)
  // Reproduce exactly what bin/julia-vscode computes for the same (real) directory.
  const sh = execFileSync('sh', ['-c', `printf '%s' "$1" | shasum | cut -c1-16`, '_', dir])
    .toString()
    .trim()
  assert.equal(got, `/tmp/julia-vscode-cli-${sh}.sock`)
  assert.ok(got.length < 104, 'socket path must fit the sun_path limit')
})
