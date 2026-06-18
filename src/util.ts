import * as crypto from 'crypto'
import * as path from 'path'
import * as vscode from 'vscode'

export function generatePipeName(id: string) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\julia-${id}`
  }
  // Unix-domain socket paths have a small platform limit, so keep this short.
  return path.join('/tmp', `mjl-${id.replaceAll('-', '').slice(0, 16)}.sock`)
}

export function getNonce() {
  return crypto.randomBytes(16).toString('base64')
}

export function workspaceCwd() {
  return vscode.workspace.workspaceFolders?.[0]?.uri
}

function configuredValue<T>(config: vscode.WorkspaceConfiguration, key: string): T | undefined {
  const inspected = config.inspect<T>(key)
  return [
    inspected?.workspaceFolderLanguageValue,
    inspected?.workspaceFolderValue,
    inspected?.workspaceLanguageValue,
    inspected?.workspaceValue,
    inspected?.globalLanguageValue,
    inspected?.globalValue,
  ].find((value) => value !== undefined)
}

export function juliaArgsFromConfig() {
  const config = vscode.workspace.getConfiguration('julia')
  const executableArgs = config.get<string[]>('executableArgs') ?? []
  const additionalArgs = config.get<string[]>('additionalArgs') ?? []
  const configuredNumThreads = configuredValue<string | number | null>(config, 'NumThreads')
  const numThreads = configuredNumThreads === undefined ? 'auto' : configuredNumThreads

  const args: string[] = [...executableArgs, '--project=@.']
  if (numThreads !== null && numThreads !== undefined && `${numThreads}`.length > 0) {
    args.push(`--threads=${numThreads}`)
  }
  args.push('--banner=no', ...additionalArgs)
  return args
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
