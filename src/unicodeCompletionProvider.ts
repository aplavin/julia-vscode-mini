import * as vscode from 'vscode'
import {
  findUnicodeCompletionPrefix,
  unicodeCompletionMatches,
} from './unicodeCompletion'

const selector: vscode.DocumentSelector = [
  { language: 'julia', scheme: 'file' },
  { language: 'julia', scheme: 'untitled' },
]

export function registerUnicodeCompletionProvider() {
  return vscode.languages.registerCompletionItemProvider(
    selector,
    {
      provideCompletionItems(document, position) {
        const line = document.lineAt(position.line).text
        const prefix = findUnicodeCompletionPrefix(line, position.character)
        if (!prefix) {
          return undefined
        }

        const range = new vscode.Range(position.line, prefix.start, position.line, prefix.end)
        const items = unicodeCompletionMatches(prefix.prefix).map(([label, value]) => {
          const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Unit)
          item.detail = value
          item.insertText = value
          item.range = range
          item.filterText = label
          item.sortText = label
          return item
        })

        return new vscode.CompletionList(items, true)
      },
    },
    '\\'
  )
}
