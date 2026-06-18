export const DEFAULT_CELL_DELIMITERS = [
  '^[ \\t]?#[ \\t]#+',
  '^##(?!#)',
  '^#([ \\t]?)%%',
  '^##([ \\t]?)-',
  '^##([ \\t]?)\\+',
]

export interface OffsetRange {
  start: number
  end: number
}

export interface JuliaCell {
  id: number
  cellRange: OffsetRange
  codeRange?: OffsetRange
}

export function escapeJuliaStringContent(value: string, literalNewlines: boolean) {
  let escaped = ''
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0
    if (char === '\\') {
      escaped += '\\\\'
    } else if (char === '"') {
      escaped += '\\"'
    } else if (char === '$') {
      escaped += '\\$'
    } else if (char === '\n') {
      escaped += literalNewlines ? '\n' : '\\n'
    } else if (codePoint < 0x20) {
      escaped += `\\u${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
    } else {
      escaped += char
    }
  }
  return escaped
}

export function juliaMultilineStringLiteral(value: string) {
  return `"""\n${escapeJuliaStringContent(value, true)}\n"""`
}

export function juliaStringLiteral(value: string) {
  return `"${escapeJuliaStringContent(value, false)}"`
}

export function buildEvalCommand(code: string, filename: string, line: number, column: number, softscope = true) {
  const safeLine = Math.max(0, Math.trunc(line))
  const safeColumn = Math.max(0, Math.trunc(column))
  const softscopeArg = softscope ? '' : '; softscope=false'
  return `JuliaVSCodeRuntime.eval_code(${juliaMultilineStringLiteral(code)}, ${juliaStringLiteral(filename)}, ${safeLine}, ${safeColumn}${softscopeArg})`
}

export function buildJuliaCells(text: string, delimiters = DEFAULT_CELL_DELIMITERS) {
  const delimiterOffsets = findCellDelimiterOffsets(text, delimiters)
  const hasExplicitDelimiters = delimiterOffsets.length > 0
  const indexes = [...delimiterOffsets]
  let hasDelimiterAtStart = true

  if (indexes[0] !== 0) {
    hasDelimiterAtStart = false
    indexes.unshift(0)
  }
  indexes.push(text.length)

  const cells: JuliaCell[] = []
  for (let index = 0; index < indexes.length - 1; index += 1) {
    const cellStart = indexes[index]
    const cellEnd = indexes[index + 1]
    const codeStart = index === 0 && !hasDelimiterAtStart
      ? cellStart
      : offsetAfterLine(text, cellStart, cellEnd)
    const codeRange = codeStart < cellEnd ? { start: codeStart, end: cellEnd } : undefined
    cells.push({
      id: index,
      cellRange: { start: cellStart, end: cellEnd },
      codeRange,
    })
  }

  return { cells, hasExplicitDelimiters }
}

export function findCellAtOffset(cells: readonly JuliaCell[], offset: number) {
  if (cells.length === 0) {
    return undefined
  }
  return cells.find((cell) => offset >= cell.cellRange.start && offset < cell.cellRange.end)
    ?? cells.at(-1)
}

export function nextCellWithCode(cells: readonly JuliaCell[], current: JuliaCell) {
  return cells.slice(current.id + 1).find((cell) => cell.codeRange)
}

function findCellDelimiterOffsets(text: string, delimiters: readonly string[]) {
  if (delimiters.length === 0) {
    return []
  }

  const regex = new RegExp(delimiters.map((delimiter) => `(?:${delimiter})`).join('|'), 'gm')
  const offsets: number[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    offsets.push(match.index)
    if (match[0].length === 0) {
      regex.lastIndex += 1
    }
  }
  return offsets
}

function offsetAfterLine(text: string, offset: number, limit: number) {
  const newline = text.indexOf('\n', offset)
  if (newline < 0 || newline >= limit) {
    return limit
  }
  return newline + 1
}
