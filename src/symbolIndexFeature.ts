// Parser-powered Julia navigation: Document/Workspace symbols + Go-to-Definition,
// backed by a lezer symbol index over the workspace, manifest packages, stdlib,
// and Base. All parsing is in-process (no Julia LSP). The only subprocess is a
// short, read-only metadata probe (version / Base / stdlib / depots).

import { execFile } from 'child_process'
import { promises as fs, statSync } from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'

import {
  extractIndex,
  extractSymbols,
  lineStarts,
  positionAt,
  type RawReference,
  type RawSymbol,
  type SymbolKind,
} from './symbolIndex/lezerSymbols'
import {
  chooseManifestName,
  findProjectFile,
  parseManifest,
  parseProject,
  parseTomlSafely,
  resolvePackages,
  type ResolvedPackage,
} from './symbolIndex/manifest'
import { buildProbeArgs, parseProbeOutput, parseVersion, type ProbeResult } from './symbolIndex/probe'
import { rankDefinitions, rankReferences, rankWorkspaceSymbols, type ClickedToken } from './symbolIndex/ranking'
import { inScopeRoots, type Environment, type EnvPackage } from './symbolIndex/envScope'
import { SymbolStore, type IndexedReference, type IndexedSymbol, type Pos, type Tier } from './symbolIndex/store'

const IGNORED_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', '.vscode', '__pycache__'])
const SELECTOR: vscode.DocumentSelector = [
  { language: 'julia', scheme: 'file' },
  { language: 'julia', scheme: 'untitled' },
]
const CACHE_SCHEMA = 2
const BATCH = 40
const PROBE_TIMEOUT_MS = 30_000
const WORKSPACE_SYMBOL_CAP = 500

const KIND_MAP: Record<SymbolKind, vscode.SymbolKind> = {
  module: vscode.SymbolKind.Namespace,
  function: vscode.SymbolKind.Function,
  macro: vscode.SymbolKind.Function,
  struct: vscode.SymbolKind.Struct,
  'mutable struct': vscode.SymbolKind.Struct,
  'abstract type': vscode.SymbolKind.Class,
  'primitive type': vscode.SymbolKind.Class,
  const: vscode.SymbolKind.Constant,
  global: vscode.SymbolKind.Variable,
}

// ---- small fs helpers -------------------------------------------------------

async function readDirSafe(dir: string): Promise<import('fs').Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function collectJuliaFiles(root: string, into: string[]): Promise<void> {
  for (const entry of await readDirSafe(root)) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) await collectJuliaFiles(full, into)
    } else if (entry.isFile() && entry.name.endsWith('.jl')) {
      into.push(full)
    }
  }
}

// Walk a workspace folder once, collecting .jl files and directories that hold a
// Project/JuliaProject.toml.
async function walkWorkspaceFolder(root: string): Promise<{ jlFiles: string[]; projectDirs: string[] }> {
  const jlFiles: string[] = []
  const projectDirs: string[] = []
  const visit = async (dir: string): Promise<void> => {
    const entries = await readDirSafe(dir)
    const names = entries.map((e) => e.name)
    if (findProjectFile(dir, names)) projectDirs.push(dir)
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await visit(full)
      } else if (entry.isFile() && entry.name.endsWith('.jl')) {
        jlFiles.push(full)
      }
    }
  }
  await visit(root)
  return { jlFiles, projectDirs }
}

function nearestProjectDir(file: string, projectDirs: readonly string[], fallback: string): string {
  let best = fallback
  for (const dir of projectDirs) {
    if ((file === dir || file.startsWith(dir + path.sep)) && dir.length > best.length) best = dir
  }
  return best
}

function isInsideAny(file: string, roots: readonly string[]): boolean {
  return roots.some((r) => file === r || file.startsWith(r + path.sep))
}

// ---- conversion -------------------------------------------------------------

function toIndexed(raw: RawSymbol, file: string, root: string, tier: Tier, starts: number[]): IndexedSymbol {
  const at = (offset: number): Pos => positionAt(offset, starts)
  return {
    name: raw.name,
    qualifiedName: raw.qualifiedName,
    namespace: raw.namespace,
    kind: raw.kind,
    container: raw.containerPath,
    file,
    root: path.resolve(root),
    tier,
    global: raw.global,
    defStart: at(raw.defRange.from),
    defEnd: at(raw.defRange.to),
    nameStart: at(raw.nameRange.from),
    nameEnd: at(raw.nameRange.to),
  }
}

function toIndexedReference(raw: RawReference, file: string, root: string, tier: Tier, starts: number[]): IndexedReference {
  const at = (offset: number): Pos => positionAt(offset, starts)
  return {
    name: raw.name,
    namespace: raw.namespace,
    file,
    root: path.resolve(root),
    tier,
    start: at(raw.range.from),
    end: at(raw.range.to),
  }
}

interface ParsedFile {
  symbols: IndexedSymbol[]
  references: IndexedReference[]
}

function parseFile(text: string, file: string, root: string, tier: Tier, includeReferences = false): ParsedFile {
  const starts = lineStarts(text)
  if (!includeReferences) {
    return { symbols: extractSymbols(text).map((raw) => toIndexed(raw, file, root, tier, starts)), references: [] }
  }
  const parsed = extractIndex(text)
  return {
    symbols: parsed.symbols.map((raw) => toIndexed(raw, file, root, tier, starts)),
    references: parsed.references.map((raw) => toIndexedReference(raw, file, root, tier, starts)),
  }
}

const toRange = (a: Pos, b: Pos) => new vscode.Range(a.line, a.character, b.line, b.character)

// Extract the clicked token and any qualifier (`Base.` before it) at a position.
function clickedToken(document: vscode.TextDocument, position: vscode.Position): ClickedToken | undefined {
  const range = document.getWordRangeAtPosition(position, /@?[\p{L}\p{N}_!]+/u)
  if (!range) {
    // Operator definitions are indexed by their symbol (e.g. `==`, `+`, `<:`).
    const opRange = document.getWordRangeAtPosition(position, /<:|>:|::|[-+*/\\^%<>=!~&|÷×]+/u)
    if (!opRange) return undefined
    const op = document.getText(opRange)
    return { name: op, namespace: 'value', full: op }
  }
  let word = document.getText(range)
  const namespace = word.startsWith('@') ? 'macro' : 'value'
  if (namespace === 'macro') word = word.slice(1)
  if (!word) return undefined
  const before = document.getText(new vscode.Range(new vscode.Position(range.start.line, 0), range.start))
  const m = /([\p{L}\p{N}_.!]+)\.\s*$/u.exec(before)
  if (namespace === 'value' && m) {
    const chain = m[1]
    const qualifier = chain.includes('.') ? chain.slice(chain.lastIndexOf('.') + 1) : chain
    return { name: word, namespace, full: `${chain}.${word}`, qualifier }
  }
  return { name: word, namespace, full: namespace === 'macro' ? `@${word}` : word }
}

// ---- the feature ------------------------------------------------------------

interface PackageFileCache {
  [pkgKey: string]: { root: string; files: Record<string, IndexedSymbol[]> }
}
interface DiskCache {
  schema: number
  baseStdlib: { version: string; files: Record<string, IndexedSymbol[]> } | null
  packages: PackageFileCache
}

class SymbolIndexFeature {
  private readonly store = new SymbolStore()
  private environments: Environment[] = []
  private probe: ProbeResult | undefined
  private generation = 0
  private disposed = false
  private indexing = false
  private readonly output: vscode.OutputChannel
  /** Files touched during the current indexAll pass — everything else is pruned at the end. */
  private touched = new Set<string>()
  /** Base/stdlib source roots from the last index, for classifying watcher events. */
  private baseRoots: string[] = []
  private stdlibDir: string | undefined

  private setTracked(file: string, symbols: IndexedSymbol[], references: IndexedReference[] = []): void {
    this.touched.add(file)
    this.store.setFile(file, symbols, references)
  }
  private loadTracked(bucket: Record<string, IndexedSymbol[]>): void {
    for (const file of Object.keys(bucket)) this.touched.add(file)
    this.store.load(bucket)
  }

  constructor(private readonly context: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel('Julia Symbol Index')
  }

  // ---- config ----
  private config() {
    return vscode.workspace.getConfiguration('julia')
  }
  private get maxNavigationResults(): number {
    return this.config().get<number>('symbolIndex.maxNavigationResults')!
  }
  private get juliaSourceRoots(): string[] {
    return this.config().get<string[]>('symbolIndex.juliaSourceRoots')!
  }

  // ---- providers ----
  registerProviders(): vscode.Disposable[] {
    return [
      vscode.languages.registerDocumentSymbolProvider(SELECTOR, {
        provideDocumentSymbols: (doc) => this.provideDocumentSymbols(doc),
      }),
      vscode.languages.registerWorkspaceSymbolProvider({
        provideWorkspaceSymbols: (query) => this.provideWorkspaceSymbols(query),
      }),
      vscode.languages.registerDefinitionProvider(SELECTOR, {
        provideDefinition: (doc, pos) => this.provideDefinition(doc, pos),
      }),
      vscode.languages.registerReferenceProvider(SELECTOR, {
        provideReferences: (doc, pos, context) => this.provideReferences(doc, pos, context),
      }),
    ]
  }

  private provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const raws = extractSymbols(document.getText())
    // Build a hierarchy by range containment (modules contain members; nested defs nest).
    const nodes = raws
      .map((raw) => ({
        raw,
        symbol: new vscode.DocumentSymbol(
          raw.qualifiedName,
          raw.containerPath.join('.'),
          KIND_MAP[raw.kind],
          new vscode.Range(document.positionAt(raw.defRange.from), document.positionAt(raw.defRange.to)),
          new vscode.Range(document.positionAt(raw.nameRange.from), document.positionAt(raw.nameRange.to)),
        ),
      }))
      .sort((a, b) => a.raw.defRange.from - b.raw.defRange.from || b.raw.defRange.to - a.raw.defRange.to)
    const roots: vscode.DocumentSymbol[] = []
    const stack: { to: number; symbol: vscode.DocumentSymbol }[] = []
    for (const { raw, symbol } of nodes) {
      while (stack.length && raw.defRange.from >= stack[stack.length - 1].to) stack.pop()
      if (stack.length) stack[stack.length - 1].symbol.children.push(symbol)
      else roots.push(symbol)
      stack.push({ to: raw.defRange.to, symbol })
    }
    return roots
  }

  private provideWorkspaceSymbols(query: string): vscode.SymbolInformation[] {
    return rankWorkspaceSymbols(query, this.store.globalSymbols(), WORKSPACE_SYMBOL_CAP).map(
      (s) =>
        new vscode.SymbolInformation(
          s.qualifiedName,
          KIND_MAP[s.kind],
          s.container.join('.'),
          new vscode.Location(vscode.Uri.file(s.file), toRange(s.nameStart, s.nameEnd)),
        ),
    )
  }

  private provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Location[] {
    const token = clickedToken(document, position)
    if (!token) return []
    const currentFile = document.uri.fsPath
    const scope = inScopeRoots(currentFile, this.environments)
    // Loose files at the workspace-folder root (the top of the env chain) are in scope too.
    const folder = vscode.workspace.getWorkspaceFolder(document.uri)
    const folderRoot = folder ? path.resolve(folder.uri.fsPath) : undefined
    const candidates = this.store.definitionsFor(token.name, token.namespace).filter((c) => {
      if (scope === null) return true
      if (c.tier === 'base' || c.tier === 'stdlib' || c.file === currentFile) return true
      if (c.tier === 'workspace' && folderRoot && c.root === folderRoot) return true
      return scope.has(c.root)
    })
    return rankDefinitions(token, candidates, currentFile, this.maxNavigationResults).map(
      (s) => new vscode.Location(vscode.Uri.file(s.file), toRange(s.nameStart, s.nameEnd)),
    )
  }

  private provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
  ): vscode.Location[] {
    const token = clickedToken(document, position)
    if (!token) return []
    const currentFile = document.uri.fsPath
    const refs = this.store.referencesFor(token.name, token.namespace).filter((r) => r.tier === 'workspace')
    const declarations = context.includeDeclaration
      ? this.store
          .definitionsFor(token.name, token.namespace)
          .filter((s) => s.tier === 'workspace')
          .map((s) => ({ file: s.file, start: s.nameStart, end: s.nameEnd }))
      : []
    const locations = rankReferences(
      [
        ...refs.map((r) => ({ file: r.file, start: r.start, end: r.end })),
        ...declarations,
      ],
      currentFile,
      this.maxNavigationResults,
    )
    return locations.map((loc) => new vscode.Location(vscode.Uri.file(loc.file), toRange(loc.start, loc.end)))
  }

  // ---- probe ----
  private async runProbe(): Promise<ProbeResult | undefined> {
    const cfg = this.config()
    const exe = cfg.get<string>('executablePath')!
    const exeArgs = cfg.get<string[]>('executableArgs')!
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(exe, buildProbeArgs(exeArgs), { timeout: PROBE_TIMEOUT_MS }, (err, out) => {
          if (err) reject(err)
          else resolve(out)
        })
      })
      return parseProbeOutput(stdout)
    } catch (err) {
      this.output.appendLine(`Julia metadata probe failed (${exe}): ${err instanceof Error ? err.message : err}`)
      this.output.appendLine('Falling back to default depot; set julia.symbolIndex.juliaSourceRoots for Base/stdlib.')
      return undefined
    }
  }

  private fallbackDepots(): string[] {
    const env = process.env.JULIA_DEPOT_PATH
    if (env) return env.split(path.delimiter).filter(Boolean)
    const home = process.env.HOME || process.env.USERPROFILE
    return home ? [path.join(home, '.julia')] : []
  }

  // ---- environment discovery ----
  private async discoverWorkspace(): Promise<{
    workspaceFiles: { file: string; root: string }[]
    packages: ResolvedPackage[]
  }> {
    const folders = vscode.workspace.workspaceFolders ?? []
    const depots = this.probe?.depots.length ? this.probe.depots : this.fallbackDepots()
    const version = this.probe ? parseVersion(this.probe.version) : undefined
    const workspaceFiles: { file: string; root: string }[] = []
    const packages: ResolvedPackage[] = []
    const environments: Environment[] = []
    const missing: { name: string; reason: string }[] = []
    const pending: { env: Environment; ownUuid?: string; depUuids: string[] }[] = []

    for (const folder of folders) {
      const folderPath = folder.uri.fsPath
      const { jlFiles, projectDirs } = await walkWorkspaceFolder(folderPath)
      for (const file of jlFiles) {
        workspaceFiles.push({ file, root: nearestProjectDir(file, projectDirs, folderPath) })
      }
      for (const projectDir of projectDirs) {
        const res = await this.resolveEnvironment(projectDir, depots, version, missing)
        if (res) {
          environments.push(res.environment)
          packages.push(...res.packages)
          pending.push({ env: res.environment, ownUuid: res.ownUuid, depUuids: res.depUuids })
        }
      }
    }

    // Resolve each env's declared deps/weakdeps (Project.toml) to already-indexed
    // source roots, by uuid. Manifest packages win; workspace copies win over depot.
    const rootByUuid = new Map<string, string>()
    for (const p of packages) if (p.uuid) rootByUuid.set(p.uuid, path.resolve(p.sourceDir))
    for (const { env, ownUuid } of pending) if (ownUuid) rootByUuid.set(ownUuid, path.resolve(env.projectDir))
    for (const { env, depUuids } of pending) {
      const declared = depUuids
        .map((uuid): EnvPackage | undefined => {
          const root = rootByUuid.get(uuid)
          return root ? { uuid, root } : undefined
        })
        .filter((p): p is EnvPackage => p !== undefined)
      if (declared.length) env.declaredPackages = declared
    }

    this.environments = environments
    if (missing.length) {
      this.output.appendLine(`Uninstantiated/missing package sources (${missing.length}; not installed):`)
      for (const m of missing.slice(0, 50)) this.output.appendLine(`  - ${m.name}: ${m.reason}`)
    }
    return { workspaceFiles, packages }
  }

  private async resolveEnvironment(
    projectDir: string,
    depots: string[],
    version: { major: number; minor: number } | undefined,
    missing: { name: string; reason: string }[],
  ): Promise<{ environment: Environment; packages: ResolvedPackage[]; ownUuid?: string; depUuids: string[] } | undefined> {
    const names = (await readDirSafe(projectDir)).map((e) => e.name)
    const projectFile = findProjectFile(projectDir, names)
    if (!projectFile) return undefined
    let info = { uuid: undefined as string | undefined, depUuids: [] as string[] }
    try {
      const proj = parseProject(parseTomlSafely(await fs.readFile(path.join(projectDir, projectFile), 'utf8')))
      info = { uuid: proj.uuid, depUuids: proj.depUuids }
    } catch {
      /* unreadable/unparsable project file */
    }
    const manifestName = chooseManifestName(names, projectFile, version)
    if (!manifestName) {
      // Project with no manifest: not instantiated here; its deps come from an
      // enclosing environment via the scope chain.
      return { environment: { id: projectDir, projectDir, packages: [] }, packages: [], ownUuid: info.uuid, depUuids: info.depUuids }
    }
    try {
      const text = await fs.readFile(path.join(projectDir, manifestName), 'utf8')
      const entries = parseManifest(parseTomlSafely(text))
      const { resolved, missing: miss } = resolvePackages(entries, projectDir, depots)
      missing.push(...miss.map((m) => ({ name: m.name, reason: m.reason })))
      return {
        environment: { id: projectDir, projectDir, packages: resolved.map((p) => ({ uuid: p.uuid, root: p.sourceDir })) },
        packages: resolved,
        ownUuid: info.uuid,
        depUuids: info.depUuids,
      }
    } catch (err) {
      this.output.appendLine(`Failed to read manifest in ${projectDir}: ${err instanceof Error ? err.message : err}`)
      return { environment: { id: projectDir, projectDir, packages: [] }, packages: [], ownUuid: info.uuid, depUuids: info.depUuids }
    }
  }

  // ---- cache ----
  private get cacheUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'symbol-cache.json')
  }
  private async loadCache(): Promise<DiskCache> {
    try {
      const buf = await fs.readFile(this.cacheUri.fsPath, 'utf8')
      const data = JSON.parse(buf) as DiskCache
      if (data.schema === CACHE_SCHEMA) return data
    } catch {
      /* no cache yet */
    }
    return { schema: CACHE_SCHEMA, baseStdlib: null, packages: {} }
  }
  private async saveCache(cache: DiskCache): Promise<void> {
    try {
      await fs.mkdir(this.context.globalStorageUri.fsPath, { recursive: true })
      await fs.writeFile(this.cacheUri.fsPath, JSON.stringify(cache))
    } catch (err) {
      this.output.appendLine(`Failed to write symbol cache: ${err instanceof Error ? err.message : err}`)
    }
  }

  // ---- indexing ----
  private async yieldToEventLoop(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve))
  }
  private cancelled(generation: number): boolean {
    return this.disposed || generation !== this.generation
  }

  /** Index a list of files for a source root, reusing/refreshing a cache bucket. */
  private async indexFiles(
    files: string[],
    root: string,
    tier: Tier,
    generation: number,
    cacheBucket?: Record<string, IndexedSymbol[]>,
  ): Promise<void> {
    let n = 0
    for (const file of files) {
      if (this.cancelled(generation)) return
      let symbols: IndexedSymbol[]
      const cached = cacheBucket?.[file]
      if (cached) {
        symbols = cached
      } else {
        try {
          symbols = parseFile(await fs.readFile(file, 'utf8'), file, root, tier).symbols
        } catch {
          continue
        }
        if (cacheBucket) cacheBucket[file] = symbols
      }
      this.setTracked(file, symbols)
      if (++n % BATCH === 0) await this.yieldToEventLoop()
    }
  }

  private async indexAll(generation: number): Promise<void> {
    this.touched = new Set<string>()
    this.probe = await this.runProbe()
    if (this.cancelled(generation)) return

    const cache = await this.loadCache()
    const { workspaceFiles, packages } = await this.discoverWorkspace()
    if (this.cancelled(generation)) return

    const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)

    // 1) Workspace files first (mtime/size cache so unchanged files load instantly).
    const wsCache = this.context.workspaceState.get<Record<string, { mtime: number; size: number }>>('symbolIndex.ws') ?? {}
    for (let i = 0; i < workspaceFiles.length; i += 1) {
      if (this.cancelled(generation)) return
      const { file, root } = workspaceFiles[i]
      try {
        const stat = statSync(file)
        const meta = wsCache[file]
        if (!meta || meta.mtime !== stat.mtimeMs || meta.size !== stat.size || !this.store.hasFile(file)) {
          const parsed = parseFile(await fs.readFile(file, 'utf8'), file, root, 'workspace', true)
          this.setTracked(file, parsed.symbols, parsed.references)
          wsCache[file] = { mtime: stat.mtimeMs, size: stat.size }
        } else {
          this.touched.add(file) // unchanged but still current — keep it from being pruned
        }
      } catch {
        /* unreadable */
      }
      if (i % BATCH === 0) await this.yieldToEventLoop()
    }
    // Drop workspace-cache entries for files that no longer exist.
    for (const cachedFile of Object.keys(wsCache)) if (!this.touched.has(cachedFile)) delete wsCache[cachedFile]
    await this.context.workspaceState.update('symbolIndex.ws', wsCache)

    // 2) Base + stdlib (cached by Julia version).
    const sourceRoots = [...(this.probe?.baseDir ? [this.probe.baseDir] : []), ...this.juliaSourceRoots]
    this.baseRoots = sourceRoots.map((r) => path.resolve(r))
    this.stdlibDir = this.probe?.stdlibDir
    if (this.probe) {
      if (cache.baseStdlib && cache.baseStdlib.version === this.probe.version) {
        this.loadTracked(cache.baseStdlib.files)
      } else {
        const files: Record<string, IndexedSymbol[]> = {}
        for (const baseDir of sourceRoots) {
          const baseFiles: string[] = []
          await collectJuliaFiles(baseDir, baseFiles)
          await this.indexFiles(baseFiles, baseDir, 'base', generation, files)
        }
        if (this.probe.stdlibDir) {
          for (const entry of await readDirSafe(this.probe.stdlibDir)) {
            if (!entry.isDirectory()) continue
            const srcDir = path.join(this.probe.stdlibDir, entry.name, 'src')
            const stdFiles: string[] = []
            await collectJuliaFiles(srcDir, stdFiles)
            await this.indexFiles(stdFiles, path.join(this.probe.stdlibDir, entry.name), 'stdlib', generation, files)
          }
        }
        if (!this.cancelled(generation)) cache.baseStdlib = { version: this.probe.version, files }
      }
    } else if (sourceRoots.length) {
      for (const baseDir of sourceRoots) {
        const baseFiles: string[] = []
        await collectJuliaFiles(baseDir, baseFiles)
        await this.indexFiles(baseFiles, baseDir, 'base', generation)
      }
    }

    // 3) Manifest packages (dedup by source dir; skip those inside the workspace;
    //    cache immutable git-tree packages by uuid@tree).
    const seenPkgRoots = new Set<string>()
    const usedPackageKeys = new Set<string>()
    for (const pkg of packages) {
      if (this.cancelled(generation)) return
      if (seenPkgRoots.has(pkg.sourceDir) || isInsideAny(pkg.sourceDir, workspaceRoots)) continue
      seenPkgRoots.add(pkg.sourceDir)
      const key = pkg.uuid && pkg.treeSha1 ? `${pkg.uuid}@${pkg.treeSha1}` : undefined
      if (key) usedPackageKeys.add(key)
      if (key && cache.packages[key]) {
        this.loadTracked(cache.packages[key].files)
        continue
      }
      const pkgFiles: string[] = []
      for (const sub of ['src', 'ext']) await collectJuliaFiles(path.join(pkg.sourceDir, sub), pkgFiles)
      const bucket: Record<string, IndexedSymbol[]> = {}
      await this.indexFiles(pkgFiles, pkg.sourceDir, 'package', generation, bucket)
      if (key && !this.cancelled(generation)) cache.packages[key] = { root: pkg.sourceDir, files: bucket }
    }

    if (this.cancelled(generation)) return

    // Prune symbols and cache buckets that are no longer part of the index.
    for (const file of this.store.files()) if (!this.touched.has(file)) this.store.removeFile(file)
    for (const key of Object.keys(cache.packages)) if (!usedPackageKeys.has(key)) delete cache.packages[key]

    await this.saveCache(cache)
    this.output.appendLine(`Symbol index ready: ${this.store.files().length} files indexed.`)
  }

  start(): void {
    if (this.indexing) return
    void this.rebuild()
  }

  async rebuild(): Promise<void> {
    this.generation += 1
    const generation = this.generation
    this.indexing = true
    try {
      await this.indexAll(generation)
    } catch (err) {
      this.output.appendLine(`Symbol index error: ${err instanceof Error ? err.stack ?? err.message : err}`)
    } finally {
      if (generation === this.generation) this.indexing = false
    }
  }

  async clearAndRebuild(): Promise<void> {
    this.store.clear()
    await this.context.workspaceState.update('symbolIndex.ws', undefined)
    try {
      await fs.rm(this.cacheUri.fsPath, { force: true })
    } catch {
      /* ignore */
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Rebuilding Julia symbol index…' },
      () => this.rebuild(),
    )
  }

  // Classify a changed .jl file into the right tier/root, matching how indexAll
  // assigned it. Returns undefined if the file isn't part of the index.
  private classifyFile(file: string): { root: string; tier: Tier } | undefined {
    const folder = (vscode.workspace.workspaceFolders ?? []).find(
      (f) => file === f.uri.fsPath || file.startsWith(f.uri.fsPath + path.sep),
    )
    if (folder) {
      return { root: path.resolve(nearestProjectDirForUri(file, this.environments, folder.uri.fsPath)), tier: 'workspace' }
    }
    for (const env of this.environments) {
      const pkg = env.packages.find((p) => file === p.root || file.startsWith(p.root + path.sep))
      if (pkg) return { root: path.resolve(pkg.root), tier: 'package' }
    }
    if (this.stdlibDir && file.startsWith(this.stdlibDir + path.sep)) {
      const rest = file.slice(this.stdlibDir.length + 1)
      const pkgName = rest.split(path.sep)[0]
      return { root: path.resolve(path.join(this.stdlibDir, pkgName)), tier: 'stdlib' }
    }
    const baseRoot = this.baseRoots.find((r) => file === r || file.startsWith(r + path.sep))
    if (baseRoot) return { root: baseRoot, tier: 'base' }
    return undefined
  }

  // ---- incremental refresh ----
  registerWatchers(): vscode.Disposable[] {
    const jlWatcher = vscode.workspace.createFileSystemWatcher('**/*.jl')
    const reindexFile = async (uri: vscode.Uri) => {
      const file = uri.fsPath
      if (file.split(path.sep).some((seg) => IGNORED_DIRS.has(seg))) return
      const classified = this.classifyFile(file)
      if (!classified) return
      try {
        const parsed = parseFile(await fs.readFile(file, 'utf8'), file, classified.root, classified.tier, classified.tier === 'workspace')
        this.store.setFile(file, parsed.symbols, parsed.references)
      } catch {
        /* ignore */
      }
    }
    jlWatcher.onDidChange(reindexFile)
    jlWatcher.onDidCreate(reindexFile)
    jlWatcher.onDidDelete((uri) => this.store.removeFile(uri.fsPath))

    const projWatcher = vscode.workspace.createFileSystemWatcher('**/{Project,JuliaProject,Manifest,JuliaManifest}.toml')
    const onProjectChange = () => void this.rebuild()
    projWatcher.onDidChange(onProjectChange)
    projWatcher.onDidCreate(onProjectChange)
    projWatcher.onDidDelete(onProjectChange)

    const folderWatcher = vscode.workspace.onDidChangeWorkspaceFolders(() => void this.rebuild())

    return [jlWatcher, projWatcher, folderWatcher]
  }

  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.store.clear()
    this.output.dispose()
  }
}

// Workspace file -> nearest enclosing environment project dir (for scope filtering).
function nearestProjectDirForUri(file: string, environments: readonly Environment[], fallback: string): string {
  let best = fallback
  for (const env of environments) {
    const dir = env.projectDir
    if ((file === dir || file.startsWith(dir + path.sep)) && dir.length > best.length) best = dir
  }
  return best
}

export function registerSymbolIndexFeature(context: vscode.ExtensionContext): vscode.Disposable {
  const enabled = vscode.workspace.getConfiguration('julia').get<boolean>('symbolIndex.enable')!
  if (!enabled) return new vscode.Disposable(() => {})

  const feature = new SymbolIndexFeature(context)
  const disposables: vscode.Disposable[] = [
    ...feature.registerProviders(),
    ...feature.registerWatchers(),
    vscode.commands.registerCommand('julia.symbolIndex.rebuild', () => feature.clearAndRebuild()),
    new vscode.Disposable(() => feature.dispose()),
  ]
  feature.start()
  return vscode.Disposable.from(...disposables)
}
