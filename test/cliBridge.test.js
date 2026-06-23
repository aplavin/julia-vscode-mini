const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const { CliBridge } = require('../dist/cliBridge')

// Real sockets, no mocks. `paste` is never invoked here — these cases only exercise the
// socket-binding / liveness behavior, not the eval relay (that is covered by e2e.test.js).
function tmpSock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jlvsc-br-'))
  return path.join(dir, 's.sock')
}

test('a second bridge does not steal a live socket from the first', async () => {
  const sock = tmpSock()
  const a = new CliBridge(sock, () => {})
  await a.listen()
  const b = new CliBridge(sock, () => {})
  await assert.rejects(b.listen(), /already in use/)

  // The first bridge is still the live owner: a client can still connect to it.
  await new Promise((resolve, reject) => {
    const c = net.connect(sock)
    c.once('connect', () => { c.destroy(); resolve() })
    c.once('error', reject)
  })

  a.dispose()
})

test('a stale socket file is removed and rebound', async () => {
  const sock = tmpSock()
  fs.writeFileSync(sock, '') // leftover file with nothing listening (crash remnant)
  const a = new CliBridge(sock, () => {})
  await a.listen() // should remove the stale file and bind successfully
  assert.ok(fs.existsSync(sock))
  a.dispose()
})
