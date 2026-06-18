import * as crypto from 'crypto'
import * as fs from 'fs'
import * as net from 'net'
import * as vscode from 'vscode'
import {
  buildEvalCommand,
  buildJuliaCells,
  DEFAULT_CELL_DELIMITERS,
  findCellAtOffset,
  JuliaCell,
  nextCellWithCode,
  OffsetRange,
} from './evaluation'
import { ProfilerPanel } from './profilerPanel'
import { ProfileEvent, WireEvent } from './types'
import { generatePipeName, juliaArgsFromConfig, workspaceCwd } from './util'

interface ReplSession {
  id: string
  name: string
  pipeName: string
  terminal: vscode.Terminal
  server: net.Server
  socket?: net.Socket
  buffer: string
  connected: boolean
}

interface ReplPick extends vscode.QuickPickItem {
  session: ReplSession
}

export class ReplManager implements vscode.Disposable {
  private readonly sessions: ReplSession[] = []
  private activeSessionId: string | undefined
  private readonly disposables: vscode.Disposable[] = []
  private readonly output: vscode.OutputChannel

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly profiler: ProfilerPanel
  ) {
    this.output = vscode.window.createOutputChannel('Julia')
    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        const session = this.sessions.find((s) => s.terminal === terminal)
        if (session) {
          this.disposeSession(session, false)
        }
      }),
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        const session = this.sessions.find((s) => s.terminal === terminal)
        if (session) {
          this.activeSessionId = session.id
        }
      })
    )
  }

  dispose() {
    for (const session of [...this.sessions]) {
      this.disposeSession(session, true)
    }
    this.disposables.forEach((d) => d.dispose())
    this.output.dispose()
  }

  async startRepl() {
    const existing = this.getActiveSession() ?? this.sessions.at(-1)
    if (existing) {
      this.activeSessionId = existing.id
      existing.terminal.show(false)
      return existing
    }
    return this.startNewRepl()
  }

  async startNewRepl() {
    const id = crypto.randomUUID()
    const name = `Julia REPL ${this.sessions.length + 1}`
    const pipeName = generatePipeName(id)
    const server = net.createServer()

    const session: ReplSession = {
      id,
      name,
      pipeName,
      server,
      buffer: '',
      connected: false,
      terminal: undefined as unknown as vscode.Terminal,
    }

    server.on('connection', (socket) => this.attachSocket(session, socket))
    await this.listen(server, pipeName)

    const config = vscode.workspace.getConfiguration('julia')
    const executablePath = config.get<string>('executablePath') || 'julia'
    const bootstrap = vscode.Uri.joinPath(this.context.extensionUri, 'julia', 'julia_runtime.jl').fsPath
    const shellArgs = [
      ...juliaArgsFromConfig(),
      '-i',
      bootstrap,
      pipeName,
      id,
      name,
    ]

    session.terminal = vscode.window.createTerminal({
      name,
      shellPath: executablePath,
      shellArgs,
      cwd: workspaceCwd(),
      isTransient: true,
    })

    this.sessions.push(session)
    this.activeSessionId = id
    session.terminal.show(false)
    this.output.appendLine(`Started ${name} with pipe ${pipeName}`)
    return session
  }

  async setActiveRepl() {
    if (this.sessions.length === 0) {
      vscode.window.showWarningMessage('No Julia REPL is running.')
      return
    }

    const items: ReplPick[] = this.sessions.map((session) => ({
      label: session.name,
      description: session.connected ? 'connected' : 'not connected',
      detail: session.pipeName,
      session,
    }))
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Set Active Julia REPL',
      placeHolder: 'Select the REPL that execute commands should target',
    })
    if (picked) {
      this.activeSessionId = picked.session.id
      picked.session.terminal.show(false)
    }
  }

  async executeCodeInRepl(shouldMove = false) {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      vscode.window.showWarningMessage('No active editor.')
      return
    }
    const selections = editor.selections.filter((selection) => !selection.isEmpty)
    if (selections.length > 0) {
      for (const selection of selections) {
        await this.executeRange(editor, new vscode.Range(selection.start, selection.end), true)
      }
      if (shouldMove) {
        this.moveToNextNonEmptyLine(editor, selections.at(-1)?.end ?? editor.selection.active)
      }
      return
    }

    const line = editor.document.lineAt(editor.selection.active.line)
    await this.executeRange(editor, line.range, true)
    if (shouldMove) {
      this.moveToNextNonEmptyLine(editor, line.range.end)
    }
  }

  async executeCellInRepl(shouldMove = false) {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      vscode.window.showWarningMessage('No active editor.')
      return
    }
    const document = editor.document
    const delimiters = vscode.workspace.getConfiguration('julia').get<string[]>('cellDelimiters') ?? DEFAULT_CELL_DELIMITERS
    const { cells, hasExplicitDelimiters } = buildJuliaCells(document.getText(), delimiters)
    if (!hasExplicitDelimiters) {
      vscode.window.showWarningMessage('No Julia code cell found.')
      return
    }

    const currentOffset = document.offsetAt(editor.selection.active)
    const cell = findCellAtOffset(cells, currentOffset)
    if (!cell?.codeRange) {
      vscode.window.showWarningMessage('No Julia code in the current cell.')
      return
    }

    await this.executeOffsetRange(editor, cell.codeRange, true)
    if (shouldMove) {
      this.moveToNextCell(editor, cells, cell)
    }
  }

  async executeFileInRepl() {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      vscode.window.showWarningMessage('No active editor.')
      return
    }
    await this.executeText(editor.document.getText(), editor.document.fileName, 0, 0, false)
  }

  private async executeRange(editor: vscode.TextEditor, range: vscode.Range, softscope: boolean) {
    const code = editor.document.getText(range)
    await this.executeText(code, editor.document.fileName, range.start.line, range.start.character, softscope)
  }

  private async executeOffsetRange(editor: vscode.TextEditor, range: OffsetRange, softscope: boolean) {
    await this.executeRange(editor, this.vscodeRangeFromOffsetRange(editor.document, range), softscope)
  }

  private async executeText(code: string, filename: string, line: number, column: number, softscope: boolean) {
    const session = this.getTargetSession() ?? await this.startRepl()
    if (!session) {
      vscode.window.showWarningMessage('Start a Julia REPL first.')
      return
    }
    this.activeSessionId = session.id
    session.terminal.show(false)
    this.sendTerminalCommand(session.terminal, buildEvalCommand(code, filename, line, column, softscope))
  }

  private sendTerminalCommand(terminal: vscode.Terminal, command: string) {
    if (process.platform !== 'win32' && command.includes('\n')) {
      terminal.sendText(`\u001B[200~${command}\n\u001B[201~`, false)
      return
    }
    terminal.sendText(command, true)
  }

  private moveToNextNonEmptyLine(editor: vscode.TextEditor, position: vscode.Position) {
    for (let lineNumber = position.line + 1; lineNumber < editor.document.lineCount; lineNumber += 1) {
      const line = editor.document.lineAt(lineNumber)
      if (!line.isEmptyOrWhitespace) {
        const nextPosition = new vscode.Position(lineNumber, line.firstNonWhitespaceCharacterIndex)
        this.setCursor(editor, nextPosition)
        return
      }
    }
  }

  private moveToNextCell(editor: vscode.TextEditor, cells: readonly JuliaCell[], cell: JuliaCell) {
    const next = nextCellWithCode(cells, cell)
    if (next?.codeRange) {
      this.setCursor(editor, editor.document.positionAt(next.codeRange.start))
    }
  }

  private setCursor(editor: vscode.TextEditor, position: vscode.Position) {
    const selection = new vscode.Selection(position, position)
    editor.selection = selection
    editor.revealRange(new vscode.Range(position, position))
  }

  private vscodeRangeFromOffsetRange(document: vscode.TextDocument, range: OffsetRange) {
    return new vscode.Range(document.positionAt(range.start), document.positionAt(range.end))
  }

  private getTargetSession() {
    const terminalSession = this.sessions.find((session) => session.terminal === vscode.window.activeTerminal)
    return terminalSession ?? this.getActiveSession() ?? this.sessions.at(-1)
  }

  private getActiveSession() {
    return this.sessions.find((session) => session.id === this.activeSessionId)
  }

  private listen(server: net.Server, pipeName: string) {
    return new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        reject(err)
      }
      server.once('error', onError)
      server.listen(pipeName, () => {
        server.off('error', onError)
        resolve()
      })
    })
  }

  private attachSocket(session: ReplSession, socket: net.Socket) {
    session.socket?.destroy()
    session.socket = socket
    session.buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => this.handleChunk(session, chunk.toString()))
    socket.on('close', () => {
      session.connected = false
      if (session.socket === socket) {
        session.socket = undefined
      }
    })
    socket.on('error', (err) => {
      this.output.appendLine(`${session.name} pipe error: ${err.message}`)
    })
  }

  private handleChunk(session: ReplSession, chunk: string) {
    session.buffer += chunk
    while (true) {
      const newline = session.buffer.indexOf('\n')
      if (newline < 0) {
        break
      }
      const line = session.buffer.slice(0, newline).trim()
      session.buffer = session.buffer.slice(newline + 1)
      if (line.length > 0) {
        this.handleLine(session, line)
      }
    }
  }

  private handleLine(session: ReplSession, line: string) {
    let event: WireEvent
    try {
      event = JSON.parse(line) as WireEvent
    } catch (err) {
      this.output.appendLine(`${session.name} sent invalid JSON: ${line}`)
      return
    }

    if (event.type === 'connected') {
      session.connected = true
      this.activeSessionId = session.id
      this.output.appendLine(`${session.name} connected.`)
      return
    }

    if (event.type === 'warning') {
      vscode.window.showWarningMessage(event.message ?? 'Julia warning')
      return
    }

    if (event.type === 'profile' && event.data) {
      const profile: ProfileEvent = {
        sessionId: event.sessionId ?? session.id,
        sessionName: event.sessionName ?? session.name,
        profileType: event.profileType ?? 'Thread',
        data: event.data,
      }
      this.profiler.showProfile(profile)
      return
    }

    this.output.appendLine(`${session.name} sent unknown event: ${line}`)
  }

  private disposeSession(session: ReplSession, disposeTerminal: boolean) {
    const index = this.sessions.indexOf(session)
    if (index >= 0) {
      this.sessions.splice(index, 1)
    }
    if (this.activeSessionId === session.id) {
      this.activeSessionId = this.sessions.at(-1)?.id
    }
    session.socket?.destroy()
    session.server.close()
    if (disposeTerminal) {
      session.terminal.dispose()
    }
    if (process.platform !== 'win32' && fs.existsSync(session.pipeName)) {
      try {
        fs.unlinkSync(session.pipeName)
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}
