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
  data?: Record<string, ProfileNode>
}
