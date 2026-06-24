const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync, execFile } = require('node:child_process')
const { promisify } = require('node:util')

const pexec = promisify(execFile)

const { CliBridge } = require('../dist/cliBridge')
const { EventSocketServer } = require('../dist/eventSocketServer')
const { cliSocketPath, generatePipeName } = require('../dist/paths')
const { buildCaptureCommand } = require('../dist/evaluation')

const REPO = path.join(__dirname, '..')
const RUNTIME = path.join(REPO, 'julia', 'julia_runtime.jl')
const CLI = path.join(REPO, 'bin', 'julia-vscode')
const MAXBUF = 32 * 1024 * 1024

function juliaAvailable() {
  return spawnSync('julia', ['--version'], { stdio: 'ignore' }).status === 0
}

// In-memory coverage gathering (jl_write_coverage_data) requires Julia >= 1.11.
function juliaSupportsCoverage() {
  const r = spawnSync('julia', ['--startup-file=no', '-e', 'print(VERSION >= v"1.11")'], { encoding: 'utf8' })
  return r.status === 0 && r.stdout.trim() === 'true'
}

// One real pipeline: real EventSocketServer + real CliBridge + a real Julia REPL process
// (driven over its stdin) + the real `bin/julia-vscode` shell client. No mocks anywhere.
// The only thing this can't reproduce outside VS Code is the pty/bracketed-paste input path
// (here code reaches Julia via a stdin pipe) — that is covered by the real-VS-Code checks.
test('end-to-end: CLI -> extension -> real Julia REPL', { skip: juliaAvailable() ? false : 'julia not on PATH' }, async (t) => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jlvsc-e2e-')))
  const id = `e2e-${process.pid}`
  const pipeName = generatePipeName(id)
  const sockPath = cliSocketPath(workspace)
  for (const p of [pipeName, sockPath]) {
    try { fs.unlinkSync(p) } catch { /* not present */ }
  }

  let child
  let bridge
  let resolveConnected
  const connected = new Promise((res) => { resolveConnected = res })

  const events = new EventSocketServer(pipeName, {
    onConnected: () => resolveConnected(),
    onWarning: () => {},
    onProfile: () => {},
    onJuliaEvent: (event) => bridge.handleJuliaEvent(event),
  })
  await events.listen()

  bridge = new CliBridge(sockPath, (code) => {
    child.stdin.write(`${buildCaptureCommand(code)}\n`)
  })
  await bridge.listen()

  let childStderr = ''
  child = spawn('julia', ['--startup-file=no', '-i', RUNTIME, pipeName, id, 'e2e'], {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.on('data', () => {}) // drain the terminal-echo side
  child.stderr.on('data', (d) => { childStderr += d.toString() })

  t.after(async () => {
    bridge.dispose()
    events.dispose()
    try { child.stdin.destroy() } catch { /* ignore */ }
    // SIGTERM doesn't reliably stop a Julia REPL, which would leave this test process's
    // event loop alive for minutes. SIGKILL it and wait for the handles to release.
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        child.once('exit', resolve)
        try { child.kill('SIGKILL') } catch { resolve() }
        setTimeout(resolve, 3000).unref?.()
      })
    }
    try { fs.rmSync(workspace, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  let connectTimer
  await Promise.race([
    connected,
    new Promise((_, rej) => { connectTimer = setTimeout(() => rej(new Error(`Julia did not connect.\nstderr:\n${childStderr}`)), 90000) }),
  ])
  clearTimeout(connectTimer) // otherwise this 90s timer keeps the event loop alive after tests pass

  // Drive the CLI ASYNCHRONOUSLY: the CliBridge + EventSocketServer run on this process's
  // event loop, so a synchronous child call would block the very loop that must service nc.
  // (In real VS Code the bridge and the CLI are separate processes, so this isn't a concern.)
  const run = async (code, cwd = workspace) =>
    (await pexec('sh', [CLI, 'eval', code], { cwd, encoding: 'utf8', timeout: 90000, maxBuffer: MAXBUF })).stdout

  await t.test('streams stdout and stderr/@warn back to the CLI', async () => {
    const out = await run('println("hi"); @warn "careful"; for i in 1:3\n  println(i)\nend')
    assert.match(out, /hi/)
    assert.match(out, /1\n2\n3/)
    assert.match(out, /careful/)
  })

  await t.test('prints the error (with stacktrace) for a failing eval', async () => {
    const out = await run('sqrt(-1)')
    assert.match(out, /DomainError/)
  })

  await t.test('state persists across separate CLI calls (same REPL)', async () => {
    await run('x = 41')
    assert.match(await run('println(x + 1)'), /42/)
  })

  await t.test('large output streams without hanging', async () => {
    const out = await run('for i in 1:100000\n  println(i)\nend')
    assert.match(out, /\n100000\n?$/)
  })

  await t.test('discovers the socket from a nested working directory', async () => {
    const nested = path.join(workspace, 'sub', 'dir')
    fs.mkdirSync(nested, { recursive: true })
    assert.match(await run('println("nested-ok")', nested), /nested-ok/)
  })

  await t.test('a second concurrent call is rejected as busy', async () => {
    const slow = spawn('sh', [CLI, 'eval', 'sleep(3); println("slow-done")'], { cwd: workspace })
    let slowOut = ''
    slow.stdout.on('data', (d) => { slowOut += d.toString() })
    await new Promise((r) => setTimeout(r, 700)) // let it claim the slot
    const second = await run('1 + 1')
    assert.match(second, /busy/)
    await new Promise((r) => slow.on('close', r))
    assert.match(slowOut, /slow-done/)
  })

  await t.test('reports "no REPL" where no socket exists', async () => {
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jlvsc-none-')))
    try {
      await pexec('sh', [CLI, 'eval', '1 + 1'], { cwd: empty, encoding: 'utf8', timeout: 15000 })
      assert.fail('expected a nonzero exit')
    } catch (err) {
      assert.equal(err.code, 1)
      assert.match((err.stderr || '').toString(), /no Julia REPL window found/)
    } finally {
      try { fs.rmSync(empty, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })
})

// Real pipeline for coverage: a Julia REPL started with --code-coverage=user, driven over stdin,
// publishing per-line coverage back through the real EventSocketServer. Only the VS Code-native
// rendering (TestController gutter) can't run headlessly; the wire data is asserted here.
test('end-to-end: @coverage publishes per-line workspace coverage', {
  skip: !juliaAvailable() ? 'julia not on PATH' : (!juliaSupportsCoverage() ? 'coverage requires Julia 1.11+' : false),
}, async (t) => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jlvsc-cov-')))
  const src = path.join(workspace, 'CovSrc.jl')
  // foo: line 3 = `return x*2` (positive branch), line 5 = `return -x` (else branch).
  fs.writeFileSync(src, 'function foo(x)\n    if x > 0\n        return x * 2\n    else\n        return -x\n    end\nend\n')
  const id = `cov-${process.pid}`
  const pipeName = generatePipeName(id)
  try { fs.unlinkSync(pipeName) } catch { /* not present */ }

  let resolveConnected
  let resolveCoverage
  const connected = new Promise((res) => { resolveConnected = res })
  const coverage = new Promise((res) => { resolveCoverage = res })

  const events = new EventSocketServer(pipeName, {
    onConnected: () => resolveConnected(),
    onWarning: () => {},
    onCoverage: (event) => resolveCoverage(event.data),
  })
  await events.listen()

  let childStderr = ''
  const child = spawn('julia', ['--startup-file=no', '--code-coverage=user', '-i', RUNTIME, pipeName, id, 'cov'], {
    cwd: workspace,
    env: { ...process.env, JULIA_VSCODE_COVERAGE_ROOTS: workspace },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', (d) => { childStderr += d.toString() })

  const timers = []
  t.after(async () => {
    timers.forEach(clearTimeout)
    events.dispose()
    try { child.stdin.destroy() } catch { /* ignore */ }
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        child.once('exit', resolve)
        try { child.kill('SIGKILL') } catch { resolve() }
        setTimeout(resolve, 3000).unref?.()
      })
    }
    try { fs.rmSync(workspace, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  const deadline = (ms, what) => new Promise((_, rej) => {
    const tm = setTimeout(() => rej(new Error(`${what} timed out.\nstderr:\n${childStderr}`)), ms)
    timers.push(tm)
  })

  await Promise.race([connected, deadline(120000, 'connect (coverage instrumentation is slow)')])

  child.stdin.write(`include(${JSON.stringify(src)})\n`)
  timers.push(setTimeout(() => child.stdin.write('@coverage foo(5)\n'), 2000))

  const data = await Promise.race([coverage, deadline(120000, 'coverage event')])

  const key = Object.keys(data).find((k) => k.endsWith('CovSrc.jl'))
  assert.ok(key, `coverage reported for the workspace source file (got ${Object.keys(data)})`)
  const counts = new Map(data[key]) // [line, count] pairs
  assert.equal(counts.get(3), 1, 'line 3 (return x*2) ran for foo(5)')
  assert.equal(counts.get(5), 0, 'line 5 (else return -x) did not run for foo(5)')
  // Only workspace files are reported (deps were filtered out by JULIA_VSCODE_COVERAGE_ROOTS).
  assert.ok(Object.keys(data).every((k) => k.startsWith(workspace)), 'only workspace files reported')
})
