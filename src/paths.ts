import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

// Per-session Julia -> VS Code event socket. Kept short because unix-domain socket paths
// have a small platform length limit.
export function generatePipeName(id: string) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\julia-vscode-repl-${id}`
  }
  return path.join('/tmp', `julia-vscode-repl-${id.replaceAll('-', '').slice(0, 16)}.sock`)
}

// Per-workspace CLI ingress socket. Must match what the `julia-vscode` shell script computes:
// sha1 of the workspace folder's real path, first 16 hex chars (shell: `shasum | cut -c1-16`).
export function cliSocketPath(folder: string) {
  let real: string
  try {
    real = fs.realpathSync(folder)
  } catch {
    real = folder
  }
  const hash = crypto.createHash('sha1').update(real).digest('hex').slice(0, 16)
  return path.join('/tmp', `julia-vscode-cli-${hash}.sock`)
}
