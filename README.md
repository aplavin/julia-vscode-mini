# Julia Mini

Julia Mini is a lean Julia extension for VS Code: syntax highlighting, Unicode completions such as `\alpha`, native Go to Definition across the workspace and installed dependencies, profiling via `@profview`, `view_profile`, `@profview_allocs`, and `view_profile_allocs`, and REPL-oriented execution commands. Use `Julia: Execute Code in REPL`, `Julia: Execute Code in REPL and Move`, `Julia: Execute Code Cell in REPL`, and `Julia: Execute File in REPL`; the core command semantics and keybindings match the existing Julia extension.

Julia Mini does not keep long-running Julia processes in the background. It starts Julia only when you explicitly open or start a REPL or execute Julia code, does the rest cheaply in the JavaScript backend, and exposes `julia-vscode eval <code>` so shell tools and AI assistants can run code in the active VS Code REPL. No magic: explicit actions, lightweight indexing, and predictable REPL interaction.
