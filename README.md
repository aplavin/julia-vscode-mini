# Julia Mini

Lean support for Julia code in VS Code, with the familiar essentials.

## 🪶 What it does

Julia Mini gives VS Code the core Julia editing pieces without keeping Julia busy in the background:

- syntax highlighting
- Unicode completions like `\alpha`
- native Go to Definition across your workspace and installed dependencies
- profiling with `@profview` and `@profview_allocs`
- REPL-oriented code execution

It is meant to feel familiar if you have used the [julia-vscode.org](https://www.julia-vscode.org/) extension, but smaller and more explicit. Julia starts only when you open or start a REPL, execute code, or ask the extension to inspect Julia-specific project information. Other features stay in the VS Code extension host.

## 🧰 Execute Julia code

Use `Open REPL` to open a Julia REPL terminal in VS Code.
From an editor, commands like `Execute Code in REPL`, `Execute Code Cell in REPL`, and `Execute File in REPL` send code to the active Julia REPL if one is open – or create a new REPL automatically in the right Julia environment.

Profiling results from `@profview` and `@profview_allocs` open in a native VS Code panel, with source navigation back into your editor.

The Julia Mini extension runs the `julia` command from your PATH by default. Set `julia.executablePath` if your Julia executable lives somewhere else.

## 🔬 Use the REPL from outside VS Code

Run the `Install julia-vscode CLI` command to install the `julia-vscode` command into `/usr/local/bin`. Then shell tools and AI assistants can send code to the active VS Code REPL:

```sh
> julia-vscode eval 'println(1 + 2)'
3
```

The command talks to the active REPL in the corresponding VS Code workspace, so it is useful for quick checks and work inside the same Julia session you are already using.

## 🪟 Install it

Install Julia Mini from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=aplavin.julia-mini):

```text
ext install aplavin.julia-mini
```

You can also install without the Marketplace: download the latest `.vsix` from the [GitHub Releases](https://github.com/aplavin/julia-vscode-mini/releases) page, then use VS Code's `Extensions: Install from VSIX...` command.
