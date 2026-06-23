// One-shot, read-only Julia metadata probe. Returns ONLY path metadata:
// version, Base source dir, stdlib dir, and DEPOT_PATH. No Pkg, no project
// activation, no startup file, no mutation.

export interface ProbeResult {
  version: string
  baseDir: string
  stdlibDir: string
  depots: string[]
}

// Line-based output (robust against path escaping); each value on its own
// prefixed line so we can ignore any incidental stdout noise.
export const PROBE_CODE = [
  'let',
  '  b = normpath(joinpath(Sys.BINDIR, "..", "share", "julia", "base"))',
  '  println("__JLPROBE_VERSION=", VERSION)',
  '  println("__JLPROBE_BASE=", b)',
  '  println("__JLPROBE_STDLIB=", Sys.STDLIB)',
  '  for d in DEPOT_PATH; println("__JLPROBE_DEPOT=", d); end',
  'end',
].join('\n')

// Argument vector for the probe, inserting the user's executableArgs first
// (e.g. juliaup channel selectors) and forcing a clean, non-interactive run.
export function buildProbeArgs(executableArgs: readonly string[] = []): string[] {
  return [...executableArgs, '--startup-file=no', '--history-file=no', '-e', PROBE_CODE]
}

export function parseProbeOutput(stdout: string): ProbeResult {
  let version = ''
  let baseDir = ''
  let stdlibDir = ''
  const depots: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('__JLPROBE_VERSION=')) version = line.slice('__JLPROBE_VERSION='.length).trim()
    else if (line.startsWith('__JLPROBE_BASE=')) baseDir = line.slice('__JLPROBE_BASE='.length).trim()
    else if (line.startsWith('__JLPROBE_STDLIB=')) stdlibDir = line.slice('__JLPROBE_STDLIB='.length).trim()
    else if (line.startsWith('__JLPROBE_DEPOT=')) {
      const d = line.slice('__JLPROBE_DEPOT='.length).trim()
      if (d) depots.push(d)
    }
  }
  if (!version) throw new Error('Julia probe produced no version output')
  return { version, baseDir, stdlibDir, depots }
}

// Parse "1.10.11" -> { major: 1, minor: 10 } for versioned-manifest selection.
export function parseVersion(version: string): { major: number; minor: number } | undefined {
  const m = /^(\d+)\.(\d+)/.exec(version)
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : undefined
}
