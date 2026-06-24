export interface ProfileNode {
  func: string
  file: string
  path: string
  line: number
  count: number
  countLabel?: string | number | null
  flags: number
  taskId?: number | null
  children: ProfileNode[]
}

export interface ProfileEvent {
  sessionId: string
  sessionName: string
  profileType: string
  data: Record<string, ProfileNode>
}

// `coverage` events carry per-file line deltas for one `@coverage` call: an absolute file path
// maps to `[line, count]` pairs (1-based line; count>0 ran this call, count==0 instrumented-but-not).
export type CoverageData = Record<string, [number, number][]>

export interface WireEvent {
  type: string
  sessionId?: string
  sessionName?: string
  profileType?: string
  message?: string
  // `profile` events carry a node tree; `output` events carry a base64-encoded byte string;
  // `coverage` events carry per-file line deltas.
  data?: Record<string, ProfileNode> | CoverageData | string
}
