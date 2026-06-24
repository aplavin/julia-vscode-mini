// Pure ranking for Go-to-Definition and Workspace-Symbol results.
// Source priority workspace > package > stdlib > base; exact/qualified matches
// outrank unqualified; same-file definitions are boosted.

import type { SymbolNamespace } from './lezerSymbols'
import type { IndexedSymbol, Pos, Tier } from './store'

const TIER_BONUS: Record<Tier, number> = { workspace: 400, package: 300, stdlib: 200, base: 100 }

export interface ClickedToken {
  /** Bare leaf name, e.g. `foo` for a click on `Base.foo`. */
  name: string
  namespace: SymbolNamespace
  /** Full clicked text, e.g. `Base.foo` (equals `name` when unqualified). */
  full: string
  /** Namespace before the last dot, e.g. `Base` (undefined when unqualified). */
  qualifier?: string
}

function definitionScore(token: ClickedToken, c: IndexedSymbol, currentFile: string): number {
  let score = TIER_BONUS[c.tier]
  if (c.file === currentFile) score += 500
  if (c.global) score += 50

  if (token.qualifier) {
    if (c.qualifiedName === token.full) score += 600
    else if (c.qualifiedName.endsWith(`.${token.name}`)) {
      score += c.qualifiedName.startsWith(`${token.qualifier}.`) ? 300 : 150
    }
    if (c.container.length && c.container[c.container.length - 1] === token.qualifier) score += 100
  } else {
    // Unqualified click: prefer an unqualified definition, but qualified methods
    // ending in `.name` are still valid fallbacks.
    if (c.qualifiedName === token.name) score += 200
    else score += 50
  }
  return score
}

export function rankDefinitions(
  token: ClickedToken,
  candidates: readonly IndexedSymbol[],
  currentFile: string,
  cap: number,
): IndexedSymbol[] {
  return candidates
    .map((c) => ({ c, score: definitionScore(token, c, currentFile) }))
    .sort((a, b) => b.score - a.score || a.c.defStart.line - b.c.defStart.line)
    .slice(0, cap)
    .map((x) => x.c)
}

function workspaceScore(query: string, s: IndexedSymbol): number {
  const name = s.name.toLowerCase()
  let score = TIER_BONUS[s.tier]
  if (name === query) score += 300
  else if (name.startsWith(query)) score += 200
  else score += 100
  // Prefer shorter names (closer matches) on ties.
  score -= Math.min(name.length, 99)
  return score
}

export function rankWorkspaceSymbols(query: string, symbols: Iterable<IndexedSymbol>, cap: number): IndexedSymbol[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const matches: { s: IndexedSymbol; score: number }[] = []
  for (const s of symbols) {
    if (s.name.toLowerCase().includes(q)) matches.push({ s, score: workspaceScore(q, s) })
  }
  return matches
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
    .slice(0, cap)
    .map((x) => x.s)
}

export interface ReferenceCandidate {
  file: string
  start: Pos
  end: Pos
}

export function rankReferences(
  candidates: readonly ReferenceCandidate[],
  currentFile: string,
  cap: number,
): ReferenceCandidate[] {
  const sorted = [...candidates].sort((a, b) => {
    const aCurrent = a.file === currentFile
    const bCurrent = b.file === currentFile
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1
    return (
      a.file.localeCompare(b.file) ||
      a.start.line - b.start.line ||
      a.start.character - b.start.character ||
      a.end.line - b.end.line ||
      a.end.character - b.end.character
    )
  })
  const out: ReferenceCandidate[] = []
  const seenLines = new Set<string>()
  for (const loc of sorted) {
    const key = `${loc.file}:${loc.start.line}`
    if (seenLines.has(key)) continue
    seenLines.add(key)
    out.push(loc)
    if (out.length >= cap) break
  }
  return out
}
