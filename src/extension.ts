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
    vscode.commands.registerCommand('julia.sendSelectionToRepl', () => repls.sendSelectionToRepl()),
    vscode.commands.registerCommand('julia.sendLineToRepl', () => repls.sendLineToRepl()),
    vscode.commands.registerCommand('julia.sendFileToRepl', () => repls.sendFileToRepl()),
    vscode.commands.registerCommand('julia.openProfiler', () => profiler.showLatest()),
    vscode.commands.registerCommand('julia.clearProfileHeat', () => profiler.clearHeat())
  )
}

export function deactivate() {
  // VS Code disposes subscriptions registered during activation.
}
