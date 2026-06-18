import * as vscode from 'vscode'
import { CellHighlighter } from './cellHighlighter'
import { ProfilerPanel } from './profilerPanel'
import { ReplManager } from './replManager'

export function activate(context: vscode.ExtensionContext) {
  const cellHighlighter = new CellHighlighter()
  const profiler = new ProfilerPanel(context)
  const repls = new ReplManager(context, profiler)

  context.subscriptions.push(
    cellHighlighter,
    profiler,
    repls,
    vscode.commands.registerCommand('julia.openRepl', () => repls.openRepl()),
    vscode.commands.registerCommand('julia.startRepl', () => repls.startRepl()),
    vscode.commands.registerCommand('language-julia.executeCodeBlockOrSelection', () => repls.executeCodeInRepl()),
    vscode.commands.registerCommand('language-julia.executeCodeBlockOrSelectionAndMove', () => repls.executeCodeInRepl(true)),
    vscode.commands.registerCommand('language-julia.executeCell', () => repls.executeCellInRepl()),
    vscode.commands.registerCommand('language-julia.executeCellAndMove', () => repls.executeCellInRepl(true)),
    vscode.commands.registerCommand('language-julia.executeFile', () => repls.executeFileInRepl()),
    vscode.commands.registerCommand('julia.openProfiler', () => profiler.showLatest()),
    vscode.commands.registerCommand('julia.clearProfileHeat', () => profiler.clearHeat())
  )
}

export function deactivate() {
  // VS Code disposes subscriptions registered during activation.
}
