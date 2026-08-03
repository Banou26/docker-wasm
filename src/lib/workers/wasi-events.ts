// Struct layout ported from container2wasm's wasi-util.js, which in turn follows the layout proposed in browser_wasi_shim issue 14.

export type EventVariant = 'clock' | 'fd_read' | 'fd_write'

const EVENTTYPE_CLOCK = 0
const EVENTTYPE_FD_READ = 1
const EVENTTYPE_FD_WRITE = 2

const variantFromU8 = (value: number): EventVariant => {
  switch (value) {
    case EVENTTYPE_CLOCK: return 'clock'
    case EVENTTYPE_FD_READ: return 'fd_read'
    case EVENTTYPE_FD_WRITE: return 'fd_write'
    default: throw new Error('invalid WASI event type ' + value)
  }
}

const variantToU8 = (variant: EventVariant): number => {
  switch (variant) {
    case 'clock': return EVENTTYPE_CLOCK
    case 'fd_read': return EVENTTYPE_FD_READ
    case 'fd_write': return EVENTTYPE_FD_WRITE
  }
}

export type Subscription = {
  userdata: bigint
  variant: EventVariant
  // Present for fd_read / fd_write subscriptions.
  fd: number
  // Nanoseconds, present for clock subscriptions.
  timeout: number
}

export const readSubscriptions = (
  view: DataView,
  ptr: number,
  count: number,
): Subscription[] => {
  const out: Subscription[] = []
  for (let index = 0; index < count; index++) {
    const base = ptr + 48 * index
    const userdata = view.getBigUint64(base, true)
    const variant = variantFromU8(view.getUint8(base + 8))
    out.push({
      userdata,
      variant,
      fd: variant === 'clock' ? -1 : view.getUint32(base + 16, true),
      timeout: variant === 'clock' ? Number(view.getBigUint64(base + 24, true)) : 0,
    })
  }
  return out
}

export type PollEvent = { userdata: bigint; variant: EventVariant }

export const writeEvents = (view: DataView, ptr: number, events: PollEvent[]): void => {
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!
    const base = ptr + 32 * index
    view.setBigUint64(base, event.userdata, true)
    view.setUint8(base + 8, 0)
    view.setUint8(base + 9, 0)
    view.setUint8(base + 10, variantToU8(event.variant))
  }
}
