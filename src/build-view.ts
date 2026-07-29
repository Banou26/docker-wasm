// The build, shown as it happens.
//
// What was here before was four fixed stages and a sentence, which is the same
// display whether the build is pulling 40 MB, extracting a rootfs, or running
// the reader's third RUN. This shows the plan it chose and why, then the RUN
// steps from the reader's own file ticking over with the time each took.
//
// Every number comes from the page's clock. The guest's own `+Ns` is in the
// console for anyone who wants it, but it does not advance while the guest is
// blocked on I/O, so it reads as zero for exactly the phases that take longest.

import { onBuildEvent, type BuildEvent, type PlannedStep } from './build-events'

const seconds = (ms: number): string =>
  ms < 950 ? (ms / 1000).toFixed(2) + 's' : (ms / 1000).toFixed(1) + 's'

const megabytes = (bytes: number): string => (bytes / 1e6).toFixed(1) + ' MB'

// Which planned step a phase marker belongs to. The marker carries the step
// number the script generated, which is more reliable than matching the command
// text back, since the label truncates at 120 characters.
const stepIndexOf = (label: string): number | null => {
  const match = /^RUN (\d+)\/(\d+)/.exec(label)
  return match ? Number(match[1]) - 1 : null
}

type Row = {
  element: HTMLLIElement
  status: HTMLElement
  timing: HTMLElement
}

export const mountBuildView = (root: HTMLElement): void => {
  root.replaceChildren()
  root.classList.add('build-view')

  const summary = document.createElement('p')
  summary.className = 'build-view-summary'
  summary.textContent = 'Working out what this Dockerfile needs'

  const transfer = document.createElement('div')
  transfer.className = 'build-view-transfer'
  transfer.hidden = true
  const transferLabel = document.createElement('span')
  const transferBar = document.createElement('i')
  const transferTrack = document.createElement('div')
  transferTrack.className = 'build-view-track'
  transferTrack.append(transferBar)
  transfer.append(transferLabel, transferTrack)

  const list = document.createElement('ol')
  list.className = 'build-view-steps'

  const footer = document.createElement('p')
  footer.className = 'build-view-footer'

  root.append(summary, transfer, list, footer)

  const rows: Row[] = []
  let running: number | null = null
  // When the running row opened, so its duration covers every marker it spans.
  // The base image row covers three (fetch, extract, device setup) and reporting
  // only the last gap made a 15 second transfer read as 0.6 seconds.
  let runningSince: number | null = null
  let startedAt: number | null = null

  const addRow = (key: string, text: string): Row => {
    const element = document.createElement('li')
    element.dataset.key = key
    const status = document.createElement('span')
    status.className = 'build-view-status'
    status.textContent = ''
    const body = document.createElement('code')
    body.textContent = text
    const timing = document.createElement('em')
    element.append(status, body, timing)
    list.append(element)
    return { element, status, timing }
  }

  const settle = (row: Row | undefined, ms: number, tone: 'done' | 'failed' = 'done'): void => {
    if (!row) return
    row.element.classList.remove('is-running')
    row.element.classList.add(tone === 'done' ? 'is-done' : 'is-failed')
    row.timing.textContent = seconds(ms)
  }

  // A marker is printed before the work it names, so a row runs from the marker
  // that opened it until the marker that opens the next one.
  const openRow = (index: number | null, atMs: number): void => {
    if (index !== null && index === running) return
    if (running !== null && runningSince !== null) settle(rows[running], atMs - runningSince)
    running = null
    runningSince = null
    if (index === null) return
    const row = rows[index]
    if (!row || row.element.classList.contains('is-done')) return
    row.element.classList.add('is-running')
    running = index
    runningSince = atMs
  }

  const describePlan = (event: Extract<BuildEvent, { type: 'plan' }>): void => {
    const guest = event.guest.kind === 'runner'
      ? 'busybox guest, ' + megabytes(event.guest.downloadBytes)
      : 'buildah guest, ' + megabytes(event.guest.downloadBytes)
    summary.textContent = event.engine === 'chroot'
      ? (event.inPlace
          ? 'Fast path. ' + event.base + ' is the guest, so nothing transfers. ' + guest
          : 'Fast path. Pulls ' + event.base + ' into a ' + guest)
      : 'Full builder. ' + event.reason + '. ' + guest
    summary.dataset.engine = event.engine

    // One row per instruction the reader wrote, plus the work around them, so
    // the list reads as their file rather than as this page's internals.
    rows.length = 0
    list.replaceChildren()
    if (!event.inPlace && event.base) {
      rows.push(addRow('base', 'FROM ' + event.base))
    }
    for (const step of event.steps as PlannedStep[]) {
      rows.push(addRow('run:' + step.line, 'RUN ' + step.command))
    }
    if (event.steps.length === 0 && event.engine === 'chroot') {
      rows.push(addRow('none', 'Nothing to build, launching the image'))
    }
  }

  const applyPhase = (event: Extract<BuildEvent, { type: 'phase' }>): void => {
    if (startedAt === null) startedAt = event.atMs - event.sinceMs
    if (/nothing to transfer/.test(event.label)) transfer.hidden = true

    const step = stepIndexOf(event.label)
    if (step !== null) {
      // The step list may start with a FROM row, so the RUN numbering is offset.
      const offset = rows.findIndex((row) => row.element.dataset.key?.startsWith('run:'))
      openRow((offset === -1 ? 0 : offset) + step, event.atMs)
      return
    }

    // Everything up to the first RUN is getting the base image in place, and it
    // is one row however many markers the script prints along the way.
    if (/fetch layer|extract|base image ready/.test(event.label)) {
      const base = rows.findIndex((row) => row.element.dataset.key === 'base')
      if (base !== -1) openRow(base, event.atMs)
      return
    }

    // The build is over: close whatever was still running rather than leaving it
    // spinning at the end of a finished build.
    if (/build complete|starting container/.test(event.label)) openRow(null, event.atMs)
  }

  onBuildEvent((event) => {
    if (event.type === 'plan') {
      describePlan(event)
      return
    }
    if (event.type === 'pull') {
      transfer.hidden = false
      const share = event.bytesTotal > 0 ? event.bytesReceived / event.bytesTotal : 0
      transferBar.style.width = Math.round(share * 100) + '%'
      transferLabel.textContent = 'Pulling ' + event.ref + ' / ' +
        megabytes(event.bytesReceived) + ' of ' + megabytes(event.bytesTotal) +
        ' / layer ' + Math.min(event.layersDone + 1, event.layersTotal) + ' of ' + event.layersTotal
      return
    }
    if (event.type === 'phase') {
      applyPhase(event)
      return
    }
    if (event.type === 'stage') {
      if (event.tone === 'error') {
        if (running !== null) {
          rows[running]?.element.classList.remove('is-running')
          rows[running]?.element.classList.add('is-failed')
        }
        footer.textContent = event.message
        footer.dataset.tone = 'error'
      } else if (!footer.dataset.tone) {
        footer.textContent = event.message
      }
      return
    }
    if (event.type === 'finished') {
      transfer.hidden = true
      if (running !== null) {
        settle(rows[running], performance.now() - (runningSince ?? performance.now()),
          event.ok ? 'done' : 'failed')
        running = null
        runningSince = null
      }
      for (const row of rows) {
        if (!row.element.classList.contains('is-done') && !row.element.classList.contains('is-failed')) {
          row.element.classList.add(event.ok ? 'is-done' : 'is-skipped')
        }
      }
      const total = startedAt === null ? null : Math.round(performance.now() - startedAt)
      footer.dataset.tone = event.ok ? 'ok' : 'error'
      footer.textContent = event.ok && total !== null
        ? event.message + ' / built in ' + seconds(total)
        : event.message
    }
  })
}
