import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import { CliBridge } from './cliBridge'
import {
  buildCaptureCommand,
  buildEvalCommand,
  buildJuliaCells,
  findCellAtOffset,
  JuliaCell,
  nextCellWithCode,
  OffsetRange,
} from './evaluation'
import { EventSocketServer } from './eventSocketServer'
import { cliSocketPath, generatePipeName } from './paths'
import { ProfilerPanel } from './profilerPanel'
import { ProfileNode } from './types'
import { juliaArgsFromConfig, workspaceCwd } from './util'

interface ReplSession {
  id: string
  name: string
  pipeName: string
  terminal: vscode.Terminal
  eventServer: EventSocketServer
}

export class ReplManager implements vscode.Disposable {
  private readonly sessions: ReplSession[] = []
  private readonly disposables: vscode.Disposable[] = []
  private readonly output: vscode.OutputChannel
  private cliBridge?: CliBridge

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
      })
    )
    this.startCliBridge()
  }

  dispose() {
    for (const session of [...this.sessions]) {
      this.disposeSession(session, true)
    }
    this.cliBridge?.dispose()
    this.disposables.forEach((d) => d.dispose())
    this.output.dispose()
  }

  async openRepl() {
    const existing = this.getActiveTerminalSession() ?? this.sessions.at(-1)
    if (existing) {
      existing.terminal.show(false)
      return existing
    }
    return this.startRepl()
  }

  async startRepl(preserveFocus = false, cwd: string | vscode.Uri | undefined = workspaceCwd()) {
    const id = crypto.randomUUID()
    const name = `Julia REPL ${this.sessions.length + 1}`
    const pipeName = generatePipeName(id)

    const eventServer = new EventSocketServer(pipeName, {
      onConnected: () => this.output.appendLine(`${name} connected.`),
      onWarning: (message) => vscode.window.showWarningMessage(message),
      onProfile: (event) =>
        this.profiler.showProfile({
          sessionId: event.sessionId ?? id,
          sessionName: event.sessionName ?? name,
          profileType: event.profileType ?? 'Thread',
          data: (event.data ?? {}) as Record<string, ProfileNode>,
        }),
      onJuliaEvent: (event) => this.cliBridge?.handleJuliaEvent(event),
      onInvalid: (line) => this.output.appendLine(`${name} sent invalid JSON: ${line}`),
      onUnknown: (event) => this.output.appendLine(`${name} sent unknown event: ${JSON.stringify(event)}`),
      onError: (err) => this.output.appendLine(`${name} pipe error: ${err.message}`),
    })

    const session: ReplSession = {
      id,
      name,
      pipeName,
      eventServer,
      terminal: undefined as unknown as vscode.Terminal,
    }

    await eventServer.listen()

    const config = vscode.workspace.getConfiguration('julia')
    const executablePath = config.get<string>('executablePath')!
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
      cwd,
      isTransient: true,
    })

    this.sessions.push(session)
    session.terminal.show(preserveFocus)
    this.output.appendLine(`Started ${name} with pipe ${pipeName}`)
    return session
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
    const { cells, hasExplicitDelimiters } = buildJuliaCells(document.getText())
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
    await this.executeText(editor.document.getText(), editor.document.fileName, editor.document.uri, 0, 0, false)
  }

  private async executeRange(editor: vscode.TextEditor, range: vscode.Range, softscope: boolean) {
    const code = editor.document.getText(range)
    await this.executeText(code, editor.document.fileName, editor.document.uri, range.start.line, range.start.character, softscope)
  }

  private async executeOffsetRange(editor: vscode.TextEditor, range: OffsetRange, softscope: boolean) {
    await this.executeRange(editor, this.vscodeRangeFromOffsetRange(editor.document, range), softscope)
  }

  private async executeText(
    code: string,
    filename: string,
    uri: vscode.Uri,
    line: number,
    column: number,
    softscope: boolean
  ) {
    const session = this.getActiveTerminalSession() ?? await this.startRepl(true, this.cwdForExecutedFile(uri))
    if (!session) {
      vscode.window.showWarningMessage('Start a Julia REPL first.')
      return
    }
    session.terminal.show(true)
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

  private getActiveTerminalSession() {
    return this.sessions.find((session) => session.terminal === vscode.window.activeTerminal)
  }

  private cwdForExecutedFile(uri: vscode.Uri) {
    if (uri.scheme !== 'file') {
      return workspaceCwd()
    }
    return path.dirname(uri.fsPath)
  }

  // Start the command-line bridge for this window's workspace, so `julia-vscode eval` can
  // reach this REPL. Skipped when no workspace folder is open (the CLI then finds no socket).
  private startCliBridge() {
    const folder = workspaceCwd()?.fsPath
    if (!folder) {
      return
    }
    const socketPath = cliSocketPath(folder)
    const bridge = new CliBridge(socketPath, async (code) => {
      const session = this.getActiveTerminalSession() ?? this.sessions.at(-1) ?? await this.startRepl(true)
      session.terminal.show(true)
      this.sendTerminalCommand(session.terminal, buildCaptureCommand(code))
    })
    this.cliBridge = bridge
    bridge.listen().then(
      () => this.output.appendLine(`julia-vscode CLI listening at ${socketPath}`),
      (err) => this.output.appendLine(`julia-vscode CLI failed to listen at ${socketPath}: ${err.message}`)
    )
  }

  private disposeSession(session: ReplSession, disposeTerminal: boolean) {
    const index = this.sessions.indexOf(session)
    if (index >= 0) {
      this.sessions.splice(index, 1)
    }
    session.eventServer.dispose()
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
