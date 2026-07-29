// What the runtime is doing, as structured events rather than as prose in a
// status line.
//
// The runtime already knew all of this and threw most of it away: it knew which
// engine would build the file and why, which guest that implied and how large it
// was, how many RUN steps there were and which line each came from, and how long
// every phase took by the page's own clock. What reached the reader was four
// fixed stages and a sentence.
//
// A pub/sub rather than a return value because the interesting part is the
// middle of a build, not the end, and a global because the alternative is
// threading a callback through every function between the button and the guest.
// The surface is deliberately one-way: the view can only read.

export type GuestSummary = {
  kind: 'runner' | 'builder'
  arch: string
  downloadBytes: number
}

export type PlannedStep = {
  // 1-based Dockerfile line, so the view can point at the source the reader
  // typed rather than at a step number they have to count out.
  line: number
  command: string
}

export type BuildEvent =
  // Emitted once, before anything boots, because all of it is known by then.
  | {
      type: 'plan'
      engine: 'chroot' | 'buildah'
      // Why this engine, in words the view shows without further translation.
      reason: string
      base: string | null
      // True when the guest already is the base image, so nothing transfers.
      inPlace: boolean
      guest: GuestSummary
      steps: PlannedStep[]
    }
  | { type: 'stage'; index: number; message: string; tone: 'normal' | 'error' }
  // One per `== label +Ns ==` marker, timed by the page. `sinceMs` is the gap
  // from the previous marker, which is the only honest per-phase duration
  // available: the guest's own clock does not advance while it is blocked.
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
// Replayed to a late subscriber, because the view is set up by a different
// module than the one that emits and the ordering between them is not worth
// depending on.
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
      // A broken view must not take the build down with it.
      console.error('[build-events] listener failed', error)
    }
  }
}
