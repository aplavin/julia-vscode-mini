import * as crypto from 'crypto'
import * as vscode from 'vscode'

export function getNonce() {
  return crypto.randomBytes(16).toString('base64')
}

export function workspaceCwd() {
  return vscode.workspace.workspaceFolders?.[0]?.uri
}

export function juliaArgsFromConfig() {
  const config = vscode.workspace.getConfiguration('julia')
  const executableArgs = config.get<string[]>('executableArgs')!
  return [...executableArgs, '--project=@.', '--banner=no']
}

export function sortedProfileSelections(data: Record<string, unknown>) {
  return Object.keys(data).sort((a, b) => {
    if (a === 'all') {
      return -1
    }
    if (b === 'all') {
      return 1
    }
    return a.localeCompare(b)
  })
}
