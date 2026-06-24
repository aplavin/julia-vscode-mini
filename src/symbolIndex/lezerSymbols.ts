// Pure (no `vscode`) Julia symbol extraction over the @plutojl/lezer-julia tree.
//
// Adapted and hardened from parser-benchmarks/lezer-julia/bench.mjs to handle:
//  - long functions with bare names (`function f end`) and qualified/operator names
//  - short functions incl. return-type / where clauses (`f(x)::Int = x`, `f(x) where T = x`)
//  - operator short defs (`+(a,b) = a`)
//  - macros, modules (nested), struct/abstract/primitive types (param/subtype stripping)
//  - consts incl. tuple consts (`const a, b = 1, 2`)
//  - docstring/macro wrappers (`@inline`, `@doc "..." function ... end`)
// Each symbol is flagged `global` (module/file level) vs nested (inside another scope).

import { parser } from '@plutojl/lezer-julia'
import type { SyntaxNode } from '@lezer/common'

export type SymbolKind =
  | 'module'
  | 'function'
  | 'macro'
  | 'struct'
  | 'mutable struct'
  | 'abstract type'
  | 'primitive type'
  | 'const'
  | 'global'

export type SymbolNamespace = 'value' | 'macro'

export interface RawSymbol {
  /** Bare leaf name used for lookups, e.g. `foo` for `Base.foo`, `==` for `Base.:(==)`. */
  name: string
  /** Full definition text of the name, e.g. `Base.foo`. Equals `name` when unqualified. */
  qualifiedName: string
  namespace: SymbolNamespace
  kind: SymbolKind
  /** Enclosing module names, outermost first. */
  containerPath: string[]
  /** Offset range of the name token. */
  nameRange: { from: number; to: number }
  /** Offset range of the whole definition. */
  defRange: { from: number; to: number }
  /** True when defined at module/file level (not inside a function/other local scope). */
  global: boolean
}

export interface RawReference {
  /** Bare leaf name used for lookups, e.g. `foo` for `M.foo`. */
  name: string
  namespace: SymbolNamespace
  /** Offset range to highlight. */
  range: { from: number; to: number }
}

export interface RawIndex {
  symbols: RawSymbol[]
  references: RawReference[]
}

const DEFINITION_NODES = new Set([
  'ModuleDefinition',
  'FunctionDefinition',
  'MacroDefinition',
  'StructDefinition',
  'AbstractDefinition',
  'PrimitiveDefinition',
  'Assignment',
  'ConstStatement',
  'GlobalStatement',
])

// Ancestor node types that are "transparent" for scoping: a definition nested only
// under these (plus the file root) is still a module/file-level (global) binding.
// MacrocallExpression/MacroArguments cover `@inline f()=...` and `@doc "..." f()`.
const TRANSPARENT_ANCESTORS = new Set(['Program', 'ModuleDefinition', 'MacrocallExpression', 'MacroArguments'])
const SKIP_REFERENCE_ANCESTORS = new Set(['UsingStatement', 'ImportStatement', 'ExportStatement'])
const OPERATOR_RE = /^(?:<:|>:|::|[-+*/\\^%<>=!~&|÷×]+)$/u

const text = (source: string, node: SyntaxNode) => source.slice(node.from, node.to).replace(/\s+/g, ' ').trim()

function firstChildNamed(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) return child
  }
  return null
}

function firstDescendant(node: SyntaxNode, predicate: (n: SyntaxNode) => boolean): SyntaxNode | null {
  if (predicate(node)) return node
  for (let child = node.firstChild; child; child = child.nextSibling) {
    const found = firstDescendant(child, predicate)
    if (found) return found
  }
  return null
}

function hasChildNamed(node: SyntaxNode, name: string): boolean {
  return firstChildNamed(node, name) !== null
}

function childIndex(parent: SyntaxNode, child: SyntaxNode): number {
  let i = 0
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (sameNode(node, child)) return i
    i += 1
  }
  return -1
}

function sameNode(a: SyntaxNode, b: SyntaxNode): boolean {
  return a.name === b.name && a.from === b.from && a.to === b.to
}

function isFirstChild(parent: SyntaxNode, child: SyntaxNode): boolean {
  return !!parent.firstChild && sameNode(parent.firstChild, child)
}

function hasAncestor(node: SyntaxNode, predicate: (n: SyntaxNode) => boolean): boolean {
  for (let p = node.parent; p; p = p.parent) if (predicate(p)) return true
  return false
}

function ancestorNamed(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let p = node.parent; p; p = p.parent) if (p.name === name) return p
  return null
}

// Reduce a qualified/operator definition name to its bare leaf, e.g.
//   "Base.foo" -> "foo", "Base.:(==)" -> "==", ":+" -> "+".
function leafName(qualified: string): string {
  let leaf = qualified.includes('.') ? qualified.slice(qualified.lastIndexOf('.') + 1) : qualified
  leaf = leaf.trim()
  if (leaf.startsWith('@')) leaf = leaf.slice(1)
  if (leaf.startsWith(':')) leaf = leaf.slice(1)
  if (leaf.startsWith('(') && leaf.endsWith(')')) leaf = leaf.slice(1, -1)
  return leaf.trim() || qualified.trim()
}

// Callee node of a CallExpression: the first non-Arguments child.
function calleeNode(call: SyntaxNode): SyntaxNode | null {
  for (let child = call.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'Arguments') return child
  }
  return null
}

// Name node from a function/macro `Signature`: bare identifier, call callee,
// or qualified/operator name; unwraps where/return-type signatures.
function nameNodeFromSignature(def: SyntaxNode): SyntaxNode | null {
  const sig = firstChildNamed(def, 'Signature')
  if (!sig) return null
  const call = firstDescendant(sig, (n) => n.name === 'CallExpression')
  if (call) return calleeNode(call)
  return firstDescendant(sig, (n) => n.name === 'Identifier' || n.name === 'FieldExpression' || n.name === 'Operator')
}

// Name node from a struct/abstract/primitive `TypeHead`, stripping `{T}`/`<:Super`.
function nameNodeFromTypeHead(def: SyntaxNode): SyntaxNode | null {
  const head = firstChildNamed(def, 'TypeHead')
  if (!head) return null
  return firstDescendant(head, (n) => n.name === 'Identifier' || n.name === 'Field') ?? head
}

// If an Assignment is a short-form function/operator definition, return its name node.
function shortFunctionNameNode(assignment: SyntaxNode): SyntaxNode | null {
  const head = assignment.firstChild
  if (!head) return null
  if (head.name === 'CallExpression') return calleeNode(head)
  // `f(x)::Int = x` / `f(x) where T = x`: a CallExpression buried in the LHS head.
  if (head.name === 'BinaryExpression' || head.name === 'WhereExpression') {
    const call = firstDescendant(head, (n) => n.name === 'CallExpression')
    if (call) return calleeNode(call)
  }
  // Operator short def `+(a,b) = a`: operator/identifier sibling of a TupleExpression.
  if (head.name === 'UnaryExpression' || head.name === 'BinaryExpression') {
    if (firstChildNamed(head, 'TupleExpression')) {
      for (let child = head.firstChild; child; child = child.nextSibling) {
        if (child.name !== 'TupleExpression') return child
      }
    }
  }
  return null
}

// All identifier name nodes bound by a const statement (handles tuple consts).
function constNameNodes(constStmt: SyntaxNode): SyntaxNode[] {
  const assignment = firstChildNamed(constStmt, 'Assignment')
  if (!assignment) return []
  const head = assignment.firstChild
  if (!head) return []
  if (head.name === 'OpenTuple' || head.name === 'TupleExpression') {
    const nodes: SyntaxNode[] = []
    for (let child = head.firstChild; child; child = child.nextSibling) {
      if (child.name === 'Identifier') nodes.push(child)
    }
    return nodes
  }
  const ident = firstDescendant(head, (n) => n.name === 'Identifier')
  return ident ? [ident] : []
}

function simpleGlobalAssignmentNameNode(assignment: SyntaxNode): SyntaxNode | null {
  if (!isGlobal(assignment)) return null
  if (assignment.parent?.name === 'ConstStatement' || assignment.parent?.name === 'GlobalStatement') return null
  if (!hasChildNamed(assignment, 'AssignmentOp')) return null
  if (shortFunctionNameNode(assignment)) return null
  const head = assignment.firstChild
  return head?.name === 'Identifier' ? head : null
}

function globalStatementNameNode(globalStmt: SyntaxNode): SyntaxNode | null {
  if (!isGlobal(globalStmt)) return null
  const assignment = firstChildNamed(globalStmt, 'Assignment')
  if (!assignment || !hasChildNamed(assignment, 'AssignmentOp')) return null
  const head = assignment.firstChild
  return head?.name === 'Identifier' ? head : null
}

function moduleNameNode(node: SyntaxNode): SyntaxNode | null {
  return firstChildNamed(node, 'Identifier')
}

function isGlobal(node: SyntaxNode): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (!TRANSPARENT_ANCESTORS.has(p.name)) return false
  }
  return true
}

function containerPath(source: string, node: SyntaxNode): string[] {
  const path: string[] = []
  for (let p = node.parent; p; p = p.parent) {
    if (p.name === 'ModuleDefinition') {
      const ident = moduleNameNode(p)
      if (ident) path.unshift(text(source, ident))
    }
  }
  return path
}

function pushSymbol(
  source: string,
  out: RawSymbol[],
  def: SyntaxNode,
  kind: SymbolKind,
  nameNode: SyntaxNode | null,
  decorate: (raw: string) => string = (s) => s,
): void {
  if (!nameNode) return
  const qualifiedName = decorate(text(source, nameNode))
  if (!qualifiedName) return
  out.push({
    name: leafName(qualifiedName),
    qualifiedName,
    namespace: kind === 'macro' ? 'macro' : 'value',
    kind,
    containerPath: containerPath(source, def),
    nameRange: { from: nameNode.from, to: nameNode.to },
    defRange: { from: def.from, to: def.to },
    global: isGlobal(def),
  })
}

function symbolsForNode(source: string, node: SyntaxNode, out: RawSymbol[]): void {
  switch (node.name) {
    case 'ModuleDefinition':
      return pushSymbol(source, out, node, 'module', moduleNameNode(node))
    case 'FunctionDefinition':
      return pushSymbol(source, out, node, 'function', nameNodeFromSignature(node))
    case 'MacroDefinition':
      return pushSymbol(source, out, node, 'macro', nameNodeFromSignature(node), (s) => (s.startsWith('@') ? s : `@${s}`))
    case 'StructDefinition': {
      const kind: SymbolKind = source.slice(node.from, node.to).startsWith('mutable') ? 'mutable struct' : 'struct'
      return pushSymbol(source, out, node, kind, nameNodeFromTypeHead(node))
    }
    case 'AbstractDefinition':
      return pushSymbol(source, out, node, 'abstract type', nameNodeFromTypeHead(node))
    case 'PrimitiveDefinition':
      return pushSymbol(source, out, node, 'primitive type', nameNodeFromTypeHead(node))
    case 'Assignment':
      // A `const f(x) = x` Assignment is already handled by its ConstStatement parent.
      if (node.parent?.name === 'ConstStatement' || node.parent?.name === 'GlobalStatement') return
      return pushSymbol(source, out, node, 'function', shortFunctionNameNode(node))
    case 'ConstStatement': {
      for (const nameNode of constNameNodes(node)) pushSymbol(source, out, node, 'const', nameNode)
      return
    }
    case 'GlobalStatement':
      return pushSymbol(source, out, node, 'global', globalStatementNameNode(node))
  }
}

function rangeContains(outer: { from: number; to: number }, inner: { from: number; to: number }): boolean {
  return inner.from >= outer.from && inner.to <= outer.to
}

function isInDefinitionName(node: SyntaxNode, symbols: readonly RawSymbol[]): boolean {
  return symbols.some((s) => rangeContains(s.nameRange, node))
}

function isInsideSkippedReferenceSyntax(node: SyntaxNode): boolean {
  return hasAncestor(node, (p) => SKIP_REFERENCE_ANCESTORS.has(p.name))
}

function isKwargLabel(node: SyntaxNode): boolean {
  return node.parent?.name === 'KwArg' && childIndex(node.parent, node) === 0
}

function isNamedTupleLabel(node: SyntaxNode): boolean {
  return node.parent?.name === 'KeywordArguments' && node.parent.parent?.name === 'TupleExpression'
}

function isSimpleAssignmentLhs(node: SyntaxNode): boolean {
  return node.parent?.name === 'Assignment' && isFirstChild(node.parent, node) && hasChildNamed(node.parent, 'AssignmentOp')
}

function isForBindingName(node: SyntaxNode): boolean {
  return node.parent?.name === 'ForBinding' && isFirstChild(node.parent, node)
}

function isLocalOrGlobalDeclarationName(node: SyntaxNode): boolean {
  const parent = node.parent
  return !!parent && (parent.name === 'LocalStatement' || parent.name === 'GlobalStatement') && isFirstChild(parent, node)
}

function isSignatureArgumentName(node: SyntaxNode): boolean {
  const args = ancestorNamed(node, 'Arguments')
  if (!args) return false
  const call = args.parent
  if (!call || call.name !== 'CallExpression') return false
  const inSignature = call.parent?.name === 'Signature'
  const assignment = ancestorNamed(node, 'Assignment')
  const inShortFunctionHead =
    !!assignment && !!assignment.firstChild && rangeContains(assignment.firstChild, node) && shortFunctionNameNode(assignment) !== null
  if (!inSignature && !inShortFunctionHead) return false
  if (node.parent && sameNode(node.parent, args)) return true
  return node.parent?.name === 'BinaryExpression' && isFirstChild(node.parent, node) && hasChildNamed(node.parent, 'SubTypeOp')
}

function isStructFieldName(node: SyntaxNode): boolean {
  return (
    !!ancestorNamed(node, 'StructDefinition') &&
    node.parent?.name === 'BinaryExpression' &&
    isFirstChild(node.parent, node) &&
    hasChildNamed(node.parent, 'SubTypeOp')
  )
}

function shouldSkipIdentifierReference(node: SyntaxNode, symbols: readonly RawSymbol[]): boolean {
  return (
    isInDefinitionName(node, symbols) ||
    isInsideSkippedReferenceSyntax(node) ||
    node.parent?.name === 'MacroIdentifier' ||
    isKwargLabel(node) ||
    isNamedTupleLabel(node) ||
    isSimpleAssignmentLhs(node) ||
    isForBindingName(node) ||
    isLocalOrGlobalDeclarationName(node) ||
    isSignatureArgumentName(node) ||
    isStructFieldName(node)
  )
}

function isOperatorNode(source: string, node: SyntaxNode): boolean {
  if (node.name === 'AssignmentOp' || node.name === 'UpdateOp') return false
  if (node.parent?.name === 'Operator') return false
  const raw = text(source, node)
  return (node.name === 'Operator' || node.name.endsWith('Op')) && OPERATOR_RE.test(raw)
}

function pushReference(
  source: string,
  out: RawReference[],
  node: SyntaxNode,
  namespace: SymbolNamespace = 'value',
  raw = text(source, node),
): void {
  const name = leafName(raw)
  if (!name) return
  out.push({ name, namespace, range: { from: node.from, to: node.to } })
}

function referencesForNode(source: string, node: SyntaxNode, symbols: readonly RawSymbol[], out: RawReference[]): void {
  if (isInsideSkippedReferenceSyntax(node) || isInDefinitionName(node, symbols)) return
  if (node.name === 'MacroIdentifier') {
    pushReference(source, out, node, 'macro')
    return
  }
  if (node.name === 'Identifier') {
    if (!shouldSkipIdentifierReference(node, symbols)) pushReference(source, out, node)
    return
  }
  if (isOperatorNode(source, node)) pushReference(source, out, node)
}

export function extractIndex(source: string): RawIndex {
  const tree = parser.parse(source)
  const symbols: RawSymbol[] = []
  const visitSymbols = (node: SyntaxNode) => {
    if (DEFINITION_NODES.has(node.name)) symbolsForNode(source, node, symbols)
    const globalName = node.name === 'Assignment' ? simpleGlobalAssignmentNameNode(node) : null
    if (globalName) pushSymbol(source, symbols, node, 'global', globalName)
    for (let child = node.firstChild; child; child = child.nextSibling) visitSymbols(child)
  }
  visitSymbols(tree.topNode)

  const references: RawReference[] = []
  const visitReferences = (node: SyntaxNode) => {
    referencesForNode(source, node, symbols, references)
    for (let child = node.firstChild; child; child = child.nextSibling) visitReferences(child)
  }
  visitReferences(tree.topNode)
  return { symbols, references }
}

export function extractSymbols(source: string): RawSymbol[] {
  return extractIndex(source).symbols
}

export function extractReferences(source: string): RawReference[] {
  return extractIndex(source).references
}

// Offset -> 0-based {line, character}, for converting ranges to editor positions.
export function lineStarts(source: string): number[] {
  const starts = [0]
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

export function positionAt(offset: number, starts: number[]): { line: number; character: number } {
  let lo = 0
  let hi = starts.length
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid
  }
  return { line: lo, character: offset - starts[lo] }
}
