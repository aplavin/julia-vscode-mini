import * as net from 'net'
import { WireEvent } from './types'

// Handlers for the events Julia sends back over the per-session socket. Kept as plain
// callbacks (no `vscode` dependency) so this server can be driven directly from tests.
export interface EventSocketHandlers {
  onConnected?: () => void
  onWarning?: (message: string) => void
  onProfile?: (event: WireEvent) => void
  onCoverage?: (event: WireEvent) => void
  // `output` / `evaldone` (and any other non-builtin event) — used by the CLI relay.
  onJuliaEvent?: (event: WireEvent) => void
  onInvalid?: (line: string) => void
  onUnknown?: (event: WireEvent) => void
  onError?: (err: Error) => void
}

// The Julia -> VS Code channel: VS Code listens, Julia connects as a client and writes
// newline-delimited JSON events. This owns the listening socket, the framing, and dispatch.
export class EventSocketServer {
  private readonly server: net.Server
  private socket?: net.Socket
  private buffer = ''
  private connected = false

  constructor(private readonly pipeName: string, private readonly handlers: EventSocketHandlers) {
    this.server = net.createServer((socket) => this.attach(socket))
  }

  get isConnected() {
    return this.connected
  }

  listen() {
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err)
      this.server.once('error', onError)
      this.server.listen(this.pipeName, () => {
        this.server.off('error', onError)
        resolve()
      })
    })
  }

  private attach(socket: net.Socket) {
    this.socket?.destroy()
    this.socket = socket
    this.buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => this.handleChunk(chunk.toString()))
    socket.on('close', () => {
      this.connected = false
      if (this.socket === socket) {
        this.socket = undefined
      }
    })
    socket.on('error', (err) => this.handlers.onError?.(err))
  }

  private handleChunk(chunk: string) {
    this.buffer += chunk
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) {
        break
      }
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length > 0) {
        this.handleLine(line)
      }
    }
  }

  private handleLine(line: string) {
    let event: WireEvent
    try {
      event = JSON.parse(line) as WireEvent
    } catch {
      this.handlers.onInvalid?.(line)
      return
    }

    switch (event.type) {
      case 'connected':
        this.connected = true
        this.handlers.onConnected?.()
        return
      case 'warning':
        this.handlers.onWarning?.(event.message ?? 'Julia warning')
        return
      case 'profile':
        if (event.data) {
          this.handlers.onProfile?.(event)
        }
        return
      case 'coverage':
        if (event.data) {
          this.handlers.onCoverage?.(event)
        }
        return
      case 'output':
      case 'evaldone':
        this.handlers.onJuliaEvent?.(event)
        return
      default:
        this.handlers.onUnknown?.(event)
    }
  }

  dispose() {
    this.socket?.destroy()
    this.socket = undefined
    this.server.close()
  }
}
