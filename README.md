# Julia Mini

Lean support for Julia code in VS Code, with the familiar essentials.

## 🪶 What it does

Julia Mini gives VS Code the core Julia editing pieces without keeping Julia busy in the background: syntax highlighting, Unicode completions like `\alpha`, native Go to Definition across your workspace and installed dependencies, profiling with `@profview` and `@profview_allocs`, and REPL-oriented code execution.

It is meant to feel familiar if you have used the `julia-vscode.org` extension, but smaller and more explicit. Julia starts only when you open or start a REPL, execute code, or ask the extension to inspect Julia-specific project information. Most editor features stay in the VS Code extension host.

## 🧰 Send code to Julia

Use the command palette commands `Julia: Open REPL` and `Julia: Start REPL` to connect to Julia. From an editor, `Julia: Execute Code in REPL`, `Julia: Execute Code in REPL and Move`, `Julia: Execute Code Cell in REPL`, and `Julia: Execute File in REPL` send source-aware code to the active Julia REPL with familiar semantics.

Profiling results from `@profview` and `@profview_allocs` open in a native VS Code panel, with source navigation back into your editor.

Julia Mini runs `julia` by default. Set `julia.executablePath` if your Julia executable lives somewhere else or you want to use a wrapper command.

## 🔬 Use the REPL from outside VS Code

Run `Julia: Install julia-vscode CLI` to install the `julia-vscode` command into `/usr/local/bin`. Then shell tools and AI assistants can send code to the active VS Code REPL:

```sh
julia-vscode eval 'VERSION'
```

The command talks to the REPL for the current project, so it is useful for quick checks, generated snippets, and keeping work inside the same Julia session you are already using.

## 🪟 Install it

Install Julia Mini from the VS Code Marketplace:

```text
ext install aplavin.julia-mini
```

You can also install without the Marketplace: download the latest `.vsix` from the [GitHub Releases](https://github.com/aplavin/julia-vscode-mini/releases) page, then use VS Code's `Extensions: Install from VSIX...` command.
