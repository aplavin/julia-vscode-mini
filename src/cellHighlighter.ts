import * as vscode from 'vscode'
import {
  buildJuliaCells,
  DEFAULT_CELL_DELIMITERS,
  findCellAtOffset,
} from './evaluation'
import type { JuliaCell, OffsetRange } from './evaluation'

interface CachedCells {
  version: number
  cells: JuliaCell[]
  hasExplicitDelimiters: boolean
}

export class CellHighlighter implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = []
  private readonly cache = new Map<string, CachedCells>()

  private readonly codeDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    isWholeLine: true,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })

  private readonly topDecoration = vscode.window.createTextEditorDecorationType({
    borderColor: new vscode.ThemeColor('interactive.activeCodeBorder'),
    borderStyle: 'solid',
    borderWidth: '1px 0 0 0',
    isWholeLine: true,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })

  private readonly bottomDecoration = vscode.window.createTextEditorDecorationType({
    borderColor: new vscode.ThemeColor('interactive.activeCodeBorder'),
    borderStyle: 'solid',
    borderWidth: '0 0 1px 0',
    isWholeLine: true,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })

  constructor() {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.refreshEditor(editor)
        }
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => this.refreshEditor(event.textEditor)),
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.cache.delete(event.document.uri.toString())
        this.refreshEditorsForDocument(event.document)
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.cache.delete(document.uri.toString())
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('julia.cellDelimiters')) {
          this.cache.clear()
          this.refreshVisibleEditors()
        }
      })
    )
    this.refreshVisibleEditors()
  }

  dispose() {
    this.cache.clear()
    this.disposables.forEach((disposable) => disposable.dispose())
    this.codeDecoration.dispose()
    this.topDecoration.dispose()
    this.bottomDecoration.dispose()
  }

  private refreshVisibleEditors() {
    vscode.window.visibleTextEditors.forEach((editor) => this.refreshEditor(editor))
  }

  private refreshEditorsForDocument(document: vscode.TextDocument) {
    vscode.window.visibleTextEditors
      .filter((editor) => editor.document === document)
      .forEach((editor) => this.refreshEditor(editor))
  }

  private refreshEditor(editor: vscode.TextEditor) {
    if (editor.document.languageId !== 'julia') {
      this.clearEditor(editor)
      return
    }

    const docCells = this.getDocCells(editor.document)
    if (!docCells.hasExplicitDelimiters) {
      this.clearEditor(editor)
      return
    }

    const cell = findCellAtOffset(docCells.cells, editor.document.offsetAt(editor.selection.active))
    if (!cell) {
      this.clearEditor(editor)
      return
    }

    editor.setDecorations(this.topDecoration, [this.boundaryRange(editor.document, cell.cellRange.start)])
    editor.setDecorations(this.bottomDecoration, [this.boundaryRange(editor.document, this.lastOffsetInside(cell.cellRange))])
    editor.setDecorations(
      this.codeDecoration,
      cell.codeRange ? [this.wholeLineOffsetRangeToRange(editor.document, cell.codeRange)] : []
    )
  }

  private clearEditor(editor: vscode.TextEditor) {
    editor.setDecorations(this.codeDecoration, [])
    editor.setDecorations(this.topDecoration, [])
    editor.setDecorations(this.bottomDecoration, [])
  }

  private getDocCells(document: vscode.TextDocument) {
    const key = document.uri.toString()
    const cached = this.cache.get(key)
    if (cached?.version === document.version) {
      return cached
    }

    const delimiters = vscode.workspace.getConfiguration('julia').get<string[]>('cellDelimiters') ?? DEFAULT_CELL_DELIMITERS
    const docCells = buildJuliaCells(document.getText(), delimiters)
    const cachedCells = {
      version: document.version,
      ...docCells,
    }
    this.cache.set(key, cachedCells)
    return cachedCells
  }

  private wholeLineOffsetRangeToRange(document: vscode.TextDocument, range: OffsetRange) {
    return new vscode.Range(document.positionAt(range.start), document.positionAt(this.lastOffsetInside(range)))
  }

  private boundaryRange(document: vscode.TextDocument, offset: number) {
    const position = document.positionAt(offset)
    return new vscode.Range(position, position)
  }

  private lastOffsetInside(range: OffsetRange) {
    return Math.max(range.start, range.end - 1)
  }
}
