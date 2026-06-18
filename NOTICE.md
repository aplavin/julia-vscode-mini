# Vendored Code

This extension vendors and adapts profiler code and grammar assets from:

- `julia-vscode/julia-vscode`, MIT license
- `pfitzseb/ProfileCanvas.jl`, MIT license
- `pfitzseb/jl-profile.js`, MIT license

The `syntaxes/` files are copied from `julia-vscode/julia-vscode`.

The `media/profile-viewer.js` file is copied from `jl-profile.js` as vendored
by `julia-vscode/julia-vscode`.

The Julia profiler tree-building logic in `julia/julia_profiler.jl` is adapted
from `ProfileCanvas.jl` and `julia-vscode/julia-vscode`.
