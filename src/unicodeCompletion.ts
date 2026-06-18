import { UNICODE_COMPLETIONS } from './unicodeCompletions.generated'
import type { UnicodeCompletionEntry } from './unicodeCompletions.generated'

export interface UnicodeCompletionPrefix {
  prefix: string
  start: number
  end: number
}

export function findUnicodeCompletionPrefix(line: string, cursorCharacter: number): UnicodeCompletionPrefix | undefined {
  const end = Math.max(0, Math.min(cursorCharacter, line.length))
  let start = end
  while (start > 0 && isUnicodeCompletionCharacter(line[start - 1])) {
    start -= 1
  }
  if (start === 0 || line[start - 1] !== '\\') {
    return undefined
  }

  const prefixStart = start - 1
  return {
    prefix: line.slice(prefixStart, end),
    start: prefixStart,
    end,
  }
}

export function unicodeCompletionMatches(prefix: string): readonly UnicodeCompletionEntry[] {
  if (!prefix.startsWith('\\')) {
    return []
  }
  return UNICODE_COMPLETIONS.filter(([label]) => label.startsWith(prefix))
}

export function isUnicodeCompletionCharacter(char: string) {
  const code = char.charCodeAt(0)
  return code === 0x21 ||
    code === 0x28 ||
    code === 0x29 ||
    code === 0x2b ||
    code === 0x2d ||
    code === 0x2f ||
    (0x30 <= code && code <= 0x39) ||
    code === 0x3a ||
    code === 0x3d ||
    (0x41 <= code && code <= 0x5a) ||
    code === 0x5e ||
    code === 0x5f ||
    (0x61 <= code && code <= 0x7a)
}
