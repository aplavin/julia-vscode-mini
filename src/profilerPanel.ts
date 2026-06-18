import * as vscode from 'vscode'
import { ProfileEvent, ProfileNode } from './types'
import { getNonce, sortedProfileSelections } from './util'

interface InlineTraceElement {
  path: string
  line: number
  count: number
  countLabel?: string | number | null
  fraction: number
  flags: number
}

export class ProfilerPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined
  private latestProfile: ProfileEvent | undefined
  private latestSelection = ''
  private inlineTrace: InlineTraceElement[] = []
  private decoration: vscode.TextEditorDecorationType | undefined
  private readonly disposables: vscode.Disposable[] = []

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors((editors) => this.refreshInlineTrace(editors))
    )
  }

  dispose() {
    this.clearHeat()
    this.panel?.dispose()
    this.disposables.forEach((d) => d.dispose())
  }

  async showLatest() {
    await this.createPanel()
    this.postLatestProfile()
    this.panel?.reveal(this.panel.viewColumn, true)
  }

  async showProfile(profile: ProfileEvent) {
    this.latestProfile = profile
    this.latestSelection = sortedProfileSelections(profile.data)[0] ?? ''
    await this.createPanel()
    if (this.panel) {
      this.panel.title = this.makeTitle()
    }
    this.postLatestProfile()
    this.setInlineTraceFromLatest()
  }

  clearHeat() {
    this.inlineTrace = []
    this.decoration?.dispose()
    this.decoration = undefined
  }

  private makeTitle() {
    if (!this.latestProfile) {
      return 'Julia Profile'
    }
    return `Julia Profile: ${this.latestProfile.profileType} (${this.latestProfile.sessionName})`
  }

  private async createPanel() {
    if (this.panel) {
      return
    }

    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media')
    this.panel = vscode.window.createWebviewPanel(
      'julia.profiler',
      this.makeTitle(),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [mediaRoot],
      }
    )

    this.panel.webview.onDidReceiveMessage((message: { type?: string; node?: ProfileNode; selection?: string }) => {
      if (message.type === 'open' && message.node) {
        this.openFrame(message.node)
      } else if (message.type === 'selectionChange' && message.selection) {
        this.latestSelection = message.selection
        this.setInlineTraceFromLatest()
      } else if (message.type === 'ready') {
        this.postLatestProfile()
      }
    })

    this.panel.onDidDispose(() => {
      this.panel = undefined
    })

    this.panel.webview.html = this.htmlForWebview(this.panel.webview)
  }

  private postLatestProfile() {
    if (!this.panel) {
      return
    }
    if (!this.latestProfile) {
      this.panel.webview.postMessage(null)
      return
    }
    this.panel.webview.postMessage({
      data: this.latestProfile.data,
      type: this.latestProfile.profileType,
      sessionName: this.latestProfile.sessionName,
    })
  }

  private async openFrame(node: ProfileNode) {
    if (!node.path || node.line <= 0) {
      return
    }
    const line = Math.max(0, node.line - 1)
    const position = new vscode.Position(line, 0)
    await vscode.window.showTextDocument(vscode.Uri.file(node.path), {
      preview: true,
      viewColumn: this.panel?.viewColumn === vscode.ViewColumn.Two ? vscode.ViewColumn.One : vscode.ViewColumn.Beside,
      selection: new vscode.Range(position, position),
    })
  }

  private setInlineTraceFromLatest() {
    this.clearHeat()
    if (!this.latestProfile || !this.latestSelection) {
      return
    }
    const root = this.latestProfile.data[this.latestSelection]
    if (!root || root.count <= 0) {
      return
    }
    this.decoration = vscode.window.createTextEditorDecorationType({
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      isWholeLine: true,
    })
    this.collectInlineTrace(root, root.count)
    this.refreshInlineTrace(vscode.window.visibleTextEditors)
  }

  private collectInlineTrace(node: ProfileNode, rootCount: number) {
    this.inlineTrace.push({
      path: node.path,
      line: node.line,
      count: node.count,
      countLabel: node.countLabel,
      fraction: node.count / rootCount,
      flags: node.flags,
    })
    node.children.forEach((child) => this.collectInlineTrace(child, rootCount))
  }

  private refreshInlineTrace(editors: readonly vscode.TextEditor[]) {
    if (!this.decoration) {
      return
    }
    for (const editor of editors) {
      const highlights = this.highlightsForEditor(editor)
      editor.setDecorations(this.decoration, highlights)
    }
  }

  private highlightsForEditor(editor: vscode.TextEditor): vscode.DecorationOptions[] {
    const uri = editor.document.uri.toString()
    const byLine = new Map<number, { count: number; fraction: number; flags: number; countLabel?: string | number | null }>()

    for (const trace of this.inlineTrace) {
      if (!trace.path || trace.line <= 0 || vscode.Uri.file(trace.path).toString() !== uri) {
        continue
      }
      const line = Math.max(0, trace.line - 1)
      const current = byLine.get(line)
      byLine.set(line, {
        count: (current?.count ?? 0) + trace.count,
        fraction: Math.min(1, (current?.fraction ?? 0) + trace.fraction),
        flags: (current?.flags ?? 0) | trace.flags,
        countLabel: current?.countLabel ?? trace.countLabel,
      })
    }

    return Array.from(byLine.entries()).map(([line, info]) => {
      const position = new vscode.Position(line, 0)
      const percent = Math.round(info.fraction * 100)
      const label = info.countLabel ?? `${info.count} samples`
      return {
        range: new vscode.Range(position, position),
        hoverMessage: `${label} (${percent}%)`,
        renderOptions: {
          before: {
            contentText: ' ',
            backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
            width: `${Math.max(1, percent / 5)}em`,
            textDecoration: 'none; white-space: pre; position: absolute; pointer-events: none',
          },
        },
      }
    })
  }

  private htmlForWebview(webview: vscode.Webview) {
    const nonce = getNonce()
    const viewerUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'profile-viewer.js'))
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    ].join('; ')

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    html, body {
      width: 100%;
      height: 100%;
      padding: 0;
      margin: 0;
      overflow: hidden;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    #profiler-container {
      position: absolute;
      inset: 0;
      overflow: hidden;
    }
    select {
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      font: inherit;
      padding: 2px 6px;
    }
    button {
      color: var(--vscode-textLink-foreground);
      background: none;
      border: none;
      cursor: pointer;
      font: inherit;
    }
    #profiler-container .__profiler-filter {
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    #profiler-container .__profiler-tooltip {
      background-color: var(--vscode-editorHoverWidget-background);
      border: 1px solid var(--vscode-editorHoverWidget-border);
      color: var(--vscode-editorHoverWidget-foreground);
      font-size: 1em !important;
    }
  </style>
</head>
<body>
  <div id="profiler-container"></div>
  <script nonce="${nonce}" type="module">
    const vscode = acquireVsCodeApi();
    const container = document.getElementById('profiler-container');
    let viewer = undefined;

    import('${viewerUri}').then(({ ProfileViewer }) => {
      viewer = new ProfileViewer(container, null, 'Thread');
      viewer.registerCtrlClickHandler((node) => {
        vscode.postMessage({ type: 'open', node });
      });
      viewer.registerSelectionHandler((selection) => {
        vscode.postMessage({ type: 'selectionChange', selection });
      });
      window.addEventListener('message', (event) => {
        if (event.data && viewer) {
          viewer.setData(event.data.data);
          viewer.setSelectorLabel(event.data.type);
        } else if (viewer) {
          viewer.setData(null);
        }
      });
      vscode.postMessage({ type: 'ready' });
    });
  </script>
</body>
</html>`
  }
}
