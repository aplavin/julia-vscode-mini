import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import { CoverageData } from './types'

// Renders Julia REPL coverage in VS Code's native Test Coverage UI. Coverage display is only
// reachable through the Testing API, so we run a "publish-only" controller: a TestController plus
// a Coverage run profile (no real tests, no-op run handler) exist solely to host
// `loadDetailedCoverage` and accept programmatically-created runs. Each `@coverage` invocation
// publishes a fresh run whose coverage replaces what the editor gutter shows.
export class CoverageView implements vscode.Disposable {
  private readonly controller: vscode.TestController
  private readonly profile: vscode.TestRunProfile
  // uri.toString() -> per-line details for the most recent run (drives the gutter via
  // loadDetailedCoverage, which the editor calls when a covered file is opened).
  private readonly details = new Map<string, vscode.StatementCoverage[]>()

  constructor() {
    this.controller = vscode.tests.createTestController('julia-coverage', 'Julia Coverage')
    this.profile = this.controller.createRunProfile(
      'Julia REPL coverage',
      vscode.TestRunProfileKind.Coverage,
      () => {
        // No-op: coverage is published from the REPL (`@coverage`), not run from this button.
        vscode.window.showInformationMessage('Use @coverage in the Julia REPL (or "Execute … with Coverage") to gather coverage.')
      },
      false
    )
    this.profile.loadDetailedCoverage = async (_run, fileCoverage) =>
      this.details.get(fileCoverage.uri.toString()) ?? []
  }

  // Publish one `@coverage` invocation's per-file line deltas as a native coverage run.
  ingest(data: CoverageData) {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => realpathOrSelf(folder.uri.fsPath))
    this.details.clear()
    const run = this.controller.createTestRun(
      new vscode.TestRunRequest(undefined, undefined, this.profile),
      'Julia coverage',
      false
    )
    try {
      for (const [filePath, lines] of Object.entries(data)) {
        const real = realpathOrSelf(filePath)
        if (roots.length > 0 && !roots.some((root) => isUnder(real, root))) {
          continue
        }
        const statements = lines
          .filter(([line]) => line >= 1)
          .map(([line, count]) => new vscode.StatementCoverage(count, new vscode.Position(line - 1, 0)))
        if (statements.length === 0) {
          continue
        }
        const uri = vscode.Uri.file(real)
        this.details.set(uri.toString(), statements)
        run.addCoverage(vscode.FileCoverage.fromDetails(uri, statements))
      }
    } finally {
      run.end()
    }
  }

  dispose() {
    this.controller.dispose()
  }
}

function realpathOrSelf(p: string) {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return p
  }
}

function isUnder(child: string, parent: string) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
