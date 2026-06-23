import * as fs from 'fs'
import * as vscode from 'vscode'
import { CellHighlighter } from './cellHighlighter'
import { ProfilerPanel } from './profilerPanel'
import { ReplManager } from './replManager'
import { registerUnicodeCompletionProvider } from './unicodeCompletionProvider'
import { registerSymbolIndexFeature } from './symbolIndexFeature'

// Symlink the bundled `julia-vscode` script onto PATH, mirroring VS Code's own
// "Install 'code' command in PATH". A .vsix is a zip and may not preserve the exec bit,
// so chmod the source first.
function installCli(context: vscode.ExtensionContext) {
  const source = vscode.Uri.joinPath(context.extensionUri, 'bin', 'julia-vscode').fsPath
  const target = '/usr/local/bin/julia-vscode'
  try {
    fs.chmodSync(source, 0o755)
    try {
      fs.unlinkSync(target)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw err
      }
    }
    fs.symlinkSync(source, target)
    vscode.window.showInformationMessage(`Installed julia-vscode CLI at ${target}`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EACCES') {
      vscode.window.showErrorMessage(
        `Cannot write ${target} (permission denied). Run manually: sudo ln -sf "${source}" "${target}" && sudo chmod +x "${source}"`
      )
    } else {
      const message = err instanceof Error ? err.message : String(err)
      vscode.window.showErrorMessage(`Failed to install julia-vscode CLI: ${message}`)
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  const cellHighlighter = new CellHighlighter()
  const profiler = new ProfilerPanel(context)
  const repls = new ReplManager(context, profiler)

  context.subscriptions.push(
    cellHighlighter,
    profiler,
    repls,
    registerUnicodeCompletionProvider(),
    registerSymbolIndexFeature(context),
    vscode.commands.registerCommand('julia.openRepl', () => repls.openRepl()),
    vscode.commands.registerCommand('julia.startRepl', () => repls.startRepl()),
    vscode.commands.registerCommand('language-julia.executeCodeBlockOrSelection', () => repls.executeCodeInRepl()),
    vscode.commands.registerCommand('language-julia.executeCodeBlockOrSelectionAndMove', () => repls.executeCodeInRepl(true)),
    vscode.commands.registerCommand('language-julia.executeCell', () => repls.executeCellInRepl()),
    vscode.commands.registerCommand('language-julia.executeCellAndMove', () => repls.executeCellInRepl(true)),
    vscode.commands.registerCommand('language-julia.executeFile', () => repls.executeFileInRepl()),
    vscode.commands.registerCommand('julia.openProfiler', () => profiler.showLatest()),
    vscode.commands.registerCommand('julia.clearProfileHeat', () => profiler.clearHeat()),
    vscode.commands.registerCommand('julia.installCli', () => installCli(context))
  )
}

export function deactivate() {
  // VS Code disposes subscriptions registered during activation.
}
