export type GuestSummary = {
  kind: 'runner' | 'builder'
  arch: string
  downloadBytes: number
}

export type PlannedStep = {
  // 1-based Dockerfile line, and the one the instruction *started* on: these consumers never see parseDockerfile.
  line: number
  command: string
}

export type BuildEvent =
  | {
      type: 'plan'
      engine: 'chroot' | 'buildah'
      reason: string
      base: string | null
      inPlace: boolean
      guest: GuestSummary
      steps: PlannedStep[]
    }
  | { type: 'stage'; index: number; message: string; tone: 'normal' | 'error' }
  // `sinceMs` is the gap from the previous marker: the guest's own clock does not advance while it is blocked.
  | { type: 'phase'; label: string; sinceMs: number; atMs: number }
  | {
      type: 'pull'
      ref: string
      bytesReceived: number
      bytesTotal: number
      layersDone: number
      layersTotal: number
    }
  | { type: 'finished'; ok: boolean; message: string }

type Listener = (event: BuildEvent) => void

const listeners = new Set<Listener>()
const history: BuildEvent[] = []

export const onBuildEvent = (listener: Listener): (() => void) => {
  for (const event of history) listener(event)
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const emitBuildEvent = (event: BuildEvent): void => {
  history.push(event)
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (error) {
      console.error('[build-events] listener failed', error)
    }
  }
}
