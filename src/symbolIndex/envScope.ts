// Multi-environment Go-to-Definition scoping (pure; no `vscode`).
//
// A file's "environment chain" is every discovered project from the file's
// directory up to its workspace-folder root. Scope = the union of those envs'
// resolved package roots (nearest env wins per package uuid) plus those envs'
// own project dirs. Base/stdlib and the current file are always allowed by the
// caller. When no chain applies (loose file, or a depot package not referenced
// by any env), we fall back to a "global" scope (null = no filtering).

import * as path from 'path'

export interface EnvPackage {
  uuid?: string
  /** Absolute package source root. */
  root: string
}

export interface Environment {
  id: string
  /** Absolute directory containing the env's Project/Manifest. */
  projectDir: string
  packages: EnvPackage[]
}

function isInside(parent: string, child: string): boolean {
  const p = path.resolve(parent)
  const c = path.resolve(child)
  if (c === p) return true
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep)
}

/** Environments whose projectDir contains the file, nearest (deepest) first. */
export function envChain(filePath: string, environments: readonly Environment[]): Environment[] {
  return environments
    .filter((e) => isInside(e.projectDir, filePath))
    .sort((a, b) => b.projectDir.length - a.projectDir.length)
}

/**
 * Roots in scope for definitions resolved from `filePath`, or `null` for the
 * global (unfiltered) fallback. The caller additionally always admits the
 * current file and Base/stdlib symbols.
 */
export function inScopeRoots(filePath: string, environments: readonly Environment[]): Set<string> | null {
  const chain = envChain(filePath, environments)
  if (chain.length) {
    const roots = new Set<string>()
    const chosen = new Set<string>()
    for (const env of chain) {
      roots.add(path.resolve(env.projectDir))
      for (const pkg of env.packages) {
        const key = pkg.uuid ?? pkg.root
        if (!chosen.has(key)) {
          chosen.add(key)
          roots.add(path.resolve(pkg.root))
        }
      }
    }
    return roots
  }

  // No workspace chain: if the file lives inside a known package source root,
  // scope to the environments that reference it (expanded to their packages).
  const containing = environments.filter((e) => e.packages.some((p) => isInside(p.root, filePath)))
  if (containing.length) {
    const roots = new Set<string>()
    for (const env of containing) {
      roots.add(path.resolve(env.projectDir))
      for (const pkg of env.packages) roots.add(path.resolve(pkg.root))
    }
    return roots
  }

  return null
}
