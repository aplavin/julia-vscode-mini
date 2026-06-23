// Pure-TypeScript Julia Project/Manifest parsing and package source resolution.
// Resolves package source directories from manifest entries + depot slug paths,
// WITHOUT ever instantiating, resolving, downloading, or mutating anything.

import * as fs from 'fs'
import * as path from 'path'
import { parse as parseToml } from 'smol-toml'
import { versionSlug } from './slug'

export interface ManifestEntry {
  name: string
  uuid?: string
  treeSha1?: string
  path?: string
}

export interface ResolvedPackage {
  name: string
  uuid?: string
  /** Absolute package root directory (contains `src/`, maybe `ext/`). */
  sourceDir: string
  kind: 'package' | 'path'
  /** git-tree-sha1 for registry packages (immutable; used as a cache key). */
  treeSha1?: string
}

export interface MissingPackage {
  name: string
  uuid?: string
  reason: string
}

export interface ResolveResult {
  resolved: ResolvedPackage[]
  missing: MissingPackage[]
}

const PROJECT_NAMES = ['JuliaProject.toml', 'Project.toml']

/** Locate the project file in a directory, preferring JuliaProject.toml. */
export function findProjectFile(dir: string, files: readonly string[]): string | undefined {
  return PROJECT_NAMES.find((n) => files.includes(n))
}

/**
 * Choose the manifest file name for an environment. Versioned manifests
 * (`Manifest-vMAJOR.MINOR.toml`) take precedence over the plain manifest, and
 * the `Julia`-prefixed variant pairs with `JuliaProject.toml`.
 */
export function chooseManifestName(
  files: readonly string[],
  projectFileName: string,
  version?: { major: number; minor: number },
): string | undefined {
  const base = projectFileName.startsWith('Julia') ? 'JuliaManifest' : 'Manifest'
  const candidates: string[] = []
  if (version) candidates.push(`${base}-v${version.major}.${version.minor}.toml`)
  candidates.push(`${base}.toml`)
  // Also accept the opposite prefix as a fallback (e.g. Manifest.toml next to JuliaProject.toml).
  const other = base === 'JuliaManifest' ? 'Manifest' : 'JuliaManifest'
  if (version) candidates.push(`${other}-v${version.major}.${version.minor}.toml`)
  candidates.push(`${other}.toml`)
  return candidates.find((c) => files.includes(c))
}

const META_KEYS = new Set(['julia_version', 'manifest_format', 'project_hash', 'other'])

/** Normalize a parsed manifest (format 1.0 or 2.0) into a flat entry list. */
export function parseManifest(data: Record<string, unknown>): ManifestEntry[] {
  const format = String((data as { manifest_format?: unknown }).manifest_format ?? '')
  const table =
    format.startsWith('2') && data.deps && typeof data.deps === 'object'
      ? (data.deps as Record<string, unknown>)
      : data
  const entries: ManifestEntry[] = []
  for (const [name, value] of Object.entries(table)) {
    if (META_KEYS.has(name) || !Array.isArray(value)) continue
    for (const raw of value) {
      if (!raw || typeof raw !== 'object') continue
      const e = raw as Record<string, unknown>
      entries.push({
        name,
        uuid: typeof e.uuid === 'string' ? e.uuid : undefined,
        treeSha1: typeof e['git-tree-sha1'] === 'string' ? (e['git-tree-sha1'] as string) : undefined,
        path: typeof e.path === 'string' ? e.path : undefined,
      })
    }
  }
  return entries
}

/** Candidate package source dirs for a git-tree-sha1 entry, in resolution order. */
export function packageSourceCandidates(
  name: string,
  uuid: string,
  treeSha1: string,
  depots: readonly string[],
): string[] {
  const candidates: string[] = []
  for (const depot of depots) {
    candidates.push(path.join(depot, 'packages', name, versionSlug(uuid, treeSha1, 5)))
    candidates.push(path.join(depot, 'packages', name, versionSlug(uuid, treeSha1, 4)))
  }
  return candidates
}

export type DirExists = (dir: string) => boolean

const realDirExists: DirExists = (dir) => {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve every manifest entry to an absolute source directory.
 *  - `path` entries resolve relative to the manifest directory.
 *  - `git-tree-sha1` entries resolve to the first existing depot slug dir.
 *  - stdlib/root entries (no path, no tree-sha1) are skipped (not errors).
 *  - anything expected but absent is recorded as missing — never fetched.
 */
export function resolvePackages(
  entries: readonly ManifestEntry[],
  manifestDir: string,
  depots: readonly string[],
  dirExists: DirExists = realDirExists,
): ResolveResult {
  const resolved: ResolvedPackage[] = []
  const missing: MissingPackage[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.path) {
      const sourceDir = path.resolve(manifestDir, entry.path)
      if (dirExists(sourceDir)) {
        if (!seen.has(sourceDir)) {
          seen.add(sourceDir)
          resolved.push({ name: entry.name, uuid: entry.uuid, sourceDir, kind: 'path' })
        }
      } else {
        missing.push({ name: entry.name, uuid: entry.uuid, reason: `path dependency not found: ${sourceDir}` })
      }
      continue
    }
    if (entry.treeSha1 && entry.uuid) {
      const candidates = packageSourceCandidates(entry.name, entry.uuid, entry.treeSha1, depots)
      const found = candidates.find((c) => dirExists(c))
      if (found) {
        if (!seen.has(found)) {
          seen.add(found)
          resolved.push({ name: entry.name, uuid: entry.uuid, sourceDir: found, kind: 'package', treeSha1: entry.treeSha1 })
        }
      } else {
        missing.push({
          name: entry.name,
          uuid: entry.uuid,
          reason: `package source not installed (tree ${entry.treeSha1.slice(0, 8)})`,
        })
      }
      continue
    }
    // No path and no tree-sha1: stdlib or the root project itself — skip silently.
  }
  return { resolved, missing }
}

export function parseTomlSafely(text: string): Record<string, unknown> {
  return parseToml(text) as Record<string, unknown>
}
