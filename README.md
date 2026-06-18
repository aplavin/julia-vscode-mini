# Julia

Julia support for VS Code:

- Julia syntax highlighting for `.jl` files
- command-started Julia REPLs
- source-aware editor-to-REPL execute commands
- `@profview`, `view_profile`, `@profview_allocs`, and `view_profile_allocs`
- VS Code profiler panel with source navigation and editor heat decorations

This extension intentionally does not include a language server, debugger, notebooks,
test controller, package UI, plot pane, Revise integration, or persistent helper
Julia processes.

Use this as a replacement for the upstream Julia VS Code extension while testing.
Disable the upstream extension to avoid duplicate language contributions.

## Development

```sh
npm install
npm run compile
npm test
npm run package
npm run install-extension-locally
```

If Node is not already available, use:

```sh
nix-shell
```
