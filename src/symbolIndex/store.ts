// In-memory symbol index plus a compact serializable form for the on-disk cache.
// Pure data structure — no `vscode`, no filesystem.

import type { SymbolKind } from './lezerSymbols'

export type Tier = 'workspace' | 'package' | 'stdlib' | 'base'

export interface Pos {
  line: number
  character: number
}

export interface IndexedSymbol {
  name: string
  qualifiedName: string
  kind: SymbolKind
  /** Enclosing module names, outermost first. */
  container: string[]
  /** Absolute file path. */
  file: string
  /** Absolute source root this file belongs to (workspace folder / package dir / base / stdlib pkg dir). */
  root: string
  tier: Tier
  global: boolean
  defStart: Pos
  defEnd: Pos
  nameStart: Pos
  nameEnd: Pos
}

export class SymbolStore {
  private byFile = new Map<string, IndexedSymbol[]>()
  private byName = new Map<string, IndexedSymbol[]>()

  /** Replace all symbols for a file. */
  setFile(file: string, symbols: IndexedSymbol[]): void {
    this.removeFile(file)
    if (symbols.length === 0) return
    this.byFile.set(file, symbols)
    for (const s of symbols) {
      const list = this.byName.get(s.name)
      if (list) list.push(s)
      else this.byName.set(s.name, [s])
    }
  }

  removeFile(file: string): void {
    const existing = this.byFile.get(file)
    if (!existing) return
    this.byFile.delete(file)
    for (const s of existing) {
      const list = this.byName.get(s.name)
      if (!list) continue
      const filtered = list.filter((e) => e.file !== file)
      if (filtered.length) this.byName.set(s.name, filtered)
      else this.byName.delete(s.name)
    }
  }

  /** Drop every file under a source root (used when a package/source goes away). */
  removeRoot(root: string): void {
    for (const [file, symbols] of this.byFile) {
      if (symbols.length && symbols[0].root === root) this.removeFile(file)
    }
  }

  hasFile(file: string): boolean {
    return this.byFile.has(file)
  }

  definitionsFor(name: string): IndexedSymbol[] {
    return this.byName.get(name) ?? []
  }

  symbolsOf(file: string): IndexedSymbol[] {
    return this.byFile.get(file) ?? []
  }

  /** Module/file-level symbols only — used for workspace symbol search. */
  *globalSymbols(): IterableIterator<IndexedSymbol> {
    for (const symbols of this.byFile.values()) {
      for (const s of symbols) if (s.global) yield s
    }
  }

  files(): string[] {
    return [...this.byFile.keys()]
  }

  clear(): void {
    this.byFile.clear()
    this.byName.clear()
  }

  /** Symbols for the given files, for writing a cache snapshot. */
  snapshot(files: Iterable<string>): Record<string, IndexedSymbol[]> {
    const out: Record<string, IndexedSymbol[]> = {}
    for (const file of files) {
      const symbols = this.byFile.get(file)
      if (symbols) out[file] = symbols
    }
    return out
  }

  /** Load a cache snapshot back into the store. */
  load(snapshot: Record<string, IndexedSymbol[]>): void {
    for (const [file, symbols] of Object.entries(snapshot)) this.setFile(file, symbols)
  }
}
