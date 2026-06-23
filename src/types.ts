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

export interface WireEvent {
  type: string
  sessionId?: string
  sessionName?: string
  profileType?: string
  message?: string
  // `profile` events carry a node tree; `output` events carry a base64-encoded byte string.
  data?: Record<string, ProfileNode> | string
}
