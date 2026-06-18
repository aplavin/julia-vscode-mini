import * as vscode from 'vscode'
import { ProfilerPanel } from './profilerPanel'
import { ReplManager } from './replManager'

export function activate(context: vscode.ExtensionContext) {
  const profiler = new ProfilerPanel(context)
  const repls = new ReplManager(context, profiler)

  context.subscriptions.push(
    profiler,
    repls,
    vscode.commands.registerCommand('julia.startRepl', () => repls.startRepl()),
    vscode.commands.registerCommand('julia.startNewRepl', () => repls.startNewRepl()),
    vscode.commands.registerCommand('julia.setActiveRepl', () => repls.setActiveRepl()),
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
