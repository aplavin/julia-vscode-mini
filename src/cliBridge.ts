import * as fs from 'fs'
import * as net from 'net'
import { WireEvent } from './types'

// `paste` runs the given code in the REPL. In production it pastes a `_vscode_evalc(...)`
// call into the terminal; in tests it writes to a real Julia process's stdin. May be async.
export type PasteFn = (code: string) => void | Promise<void>

// Listens on the per-workspace CLI socket and bridges one `julia-vscode eval` invocation at a
// time to the REPL, relaying the captured output back. No `vscode` dependency, so the whole
// thing can be exercised with real sockets + a real Julia process in tests.
export class CliBridge {
  private readonly server: net.Server
  private busy = false
  private running = false
  private client: net.Socket | null = null

  constructor(private readonly socketPath: string, private readonly paste: PasteFn) {
    this.server = net.createServer({ allowHalfOpen: true }, (socket) => this.handleConnection(socket))
  }

  listen() {
    return new Promise<void>((resolve, reject) => {
      const bind = () => {
        const onError = (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            // The socket file exists. Probe it: if something answers, another window owns
            // this workspace's socket — back off (don't steal it). If the connection is
            // refused, it's a stale file from a crash — remove it and bind.
            const probe = net.connect(this.socketPath)
            probe.once('connect', () => {
              probe.destroy()
              reject(new Error('CLI socket already in use by another window'))
            })
            probe.once('error', () => {
              probe.destroy()
              this.removeStaleSocket()
              this.server.once('error', (e) => reject(e))
              this.server.listen(this.socketPath, () => resolve())
            })
            return
          }
          reject(err)
        }
        this.server.once('error', onError)
        this.server.listen(this.socketPath, () => {
          this.server.off('error', onError)
          resolve()
        })
      }
      bind()
    })
  }

  private handleConnection(socket: net.Socket) {
    if (this.busy) {
      socket.end('ERROR: Julia REPL is busy with another julia-vscode eval\n')
      return
    }
    // Claim the slot at connection time: the code arrives over time (raw bytes until the
    // client half-closes), so claiming only after reading would let two simultaneous calls
    // both pass the busy check.
    this.busy = true
    this.running = false
    this.client = socket

    const chunks: Buffer[] = []
    socket.on('data', (chunk) => chunks.push(chunk as Buffer))
    socket.on('end', () => {
      const code = Buffer.concat(chunks).toString('utf8')
      this.running = true
      Promise.resolve()
        .then(() => this.paste(code))
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          this.client?.write(`ERROR: ${message}\n`)
          this.finish()
        })
    })
    socket.on('error', () => this.onClientGone(socket))
    socket.on('close', () => this.onClientGone(socket))
  }

  private onClientGone(socket: net.Socket) {
    if (this.client === socket) {
      this.client = null
    }
    // Disconnected before we pasted ⇒ nothing is executing, so free the slot. If we already
    // pasted (`running`), leave `busy` set until `evaldone` — the eval is still going.
    if (!this.running) {
      this.busy = false
    }
  }

  // Called by replManager for the Julia `output` / `evaldone` events of the in-flight eval.
  handleJuliaEvent(event: WireEvent) {
    if (event.type === 'output') {
      if (typeof event.data === 'string') {
        this.client?.write(Buffer.from(event.data, 'base64'))
      }
      return
    }
    if (event.type === 'evaldone') {
      this.finish()
    }
  }

  private finish() {
    this.busy = false
    this.running = false
    const client = this.client
    this.client = null
    client?.end()
  }

  private removeStaleSocket() {
    try {
      if (fs.existsSync(this.socketPath)) {
        fs.unlinkSync(this.socketPath)
      }
    } catch {
      // Best-effort cleanup only.
    }
  }

  dispose() {
    this.client?.destroy()
    this.client = null
    this.server.close()
    this.removeStaleSocket()
  }
}
