// In-memory symbol index plus a compact serializable form for the on-disk cache.
// Pure data structure — no `vscode`, no filesystem.

import type { SymbolKind, SymbolNamespace } from './lezerSymbols'

export type Tier = 'workspace' | 'package' | 'stdlib' | 'base'

export interface Pos {
  line: number
  character: number
}

export interface IndexedSymbol {
  name: string
  qualifiedName: string
  namespace: SymbolNamespace
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

export interface IndexedReference {
  name: string
  namespace: SymbolNamespace
  /** Absolute file path. */
  file: string
  /** Absolute source root this file belongs to. */
  root: string
  tier: Tier
  start: Pos
  end: Pos
}

function lookupKey(name: string, namespace: SymbolNamespace): string {
  return `${namespace}:${name}`
}

export class SymbolStore {
  private byFile = new Map<string, IndexedSymbol[]>()
  private refsByFile = new Map<string, IndexedReference[]>()
  private byName = new Map<string, IndexedSymbol[]>()
  private refsByName = new Map<string, IndexedReference[]>()

  /** Replace all symbols for a file. */
  setFile(file: string, symbols: IndexedSymbol[], references: IndexedReference[] = []): void {
    this.removeFile(file)
    if (symbols.length) this.byFile.set(file, symbols)
    if (references.length) this.refsByFile.set(file, references)
    for (const s of symbols) {
      const key = lookupKey(s.name, s.namespace)
      const list = this.byName.get(key)
      if (list) list.push(s)
      else this.byName.set(key, [s])
    }
    for (const r of references) {
      const key = lookupKey(r.name, r.namespace)
      const list = this.refsByName.get(key)
      if (list) list.push(r)
      else this.refsByName.set(key, [r])
    }
  }

  removeFile(file: string): void {
    const existing = this.byFile.get(file)
    if (existing) {
      this.byFile.delete(file)
      for (const s of existing) {
        const key = lookupKey(s.name, s.namespace)
        const list = this.byName.get(key)
        if (!list) continue
        const filtered = list.filter((e) => e.file !== file)
        if (filtered.length) this.byName.set(key, filtered)
        else this.byName.delete(key)
      }
    }
    const existingRefs = this.refsByFile.get(file)
    if (existingRefs) {
      this.refsByFile.delete(file)
      for (const r of existingRefs) {
        const key = lookupKey(r.name, r.namespace)
        const list = this.refsByName.get(key)
        if (!list) continue
        const filtered = list.filter((e) => e.file !== file)
        if (filtered.length) this.refsByName.set(key, filtered)
        else this.refsByName.delete(key)
      }
    }
  }

  private rootOf(file: string): string | undefined {
    return this.byFile.get(file)?.[0]?.root ?? this.refsByFile.get(file)?.[0]?.root
  }

  private fileSet(): Set<string> {
    return new Set([...this.byFile.keys(), ...this.refsByFile.keys()])
  }

  /** Drop every file under a source root (used when a package/source goes away). */
  removeRoot(root: string): void {
    for (const file of this.fileSet()) {
      if (this.rootOf(file) === root) this.removeFile(file)
    }
  }

  hasFile(file: string): boolean {
    return this.byFile.has(file) || this.refsByFile.has(file)
  }

  definitionsFor(name: string, namespace: SymbolNamespace = 'value'): IndexedSymbol[] {
    return this.byName.get(lookupKey(name, namespace)) ?? []
  }

  referencesFor(name: string, namespace: SymbolNamespace = 'value'): IndexedReference[] {
    return this.refsByName.get(lookupKey(name, namespace)) ?? []
  }

  symbolsOf(file: string): IndexedSymbol[] {
    return this.byFile.get(file) ?? []
  }

  referencesOf(file: string): IndexedReference[] {
    return this.refsByFile.get(file) ?? []
  }

  /** Module/file-level symbols only — used for workspace symbol search. */
  *globalSymbols(): IterableIterator<IndexedSymbol> {
    for (const symbols of this.byFile.values()) {
      for (const s of symbols) if (s.global) yield s
    }
  }

  files(): string[] {
    return [...this.fileSet()]
  }

  clear(): void {
    this.byFile.clear()
    this.refsByFile.clear()
    this.byName.clear()
    this.refsByName.clear()
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
