// The editor page builds in place, and shows the build while it happens.
//
// Two entry points have to work. Pressing the button must not navigate, because
// navigating threw away the guest download the editor had just warmed. And a
// link somebody was sent, which carries the Dockerfile in the hash, must go
// straight to a build rather than to an editor showing something else.

import { connect } from './cdp.mjs'

const ORIGIN = process.env.ORIGIN || 'http://localhost:1234'
let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log('  ok   ' + label + (detail ? '  ' + detail : ''))
  else {
    failures++
    console.error('  FAIL ' + label + (detail === undefined ? '' : '\n       ' + String(detail)))
  }
}

const DOCKERFILE = [
  'FROM alpine:3.21',
  'ENV WHO=world',
  'WORKDIR /srv/app',
  'RUN echo "hello $WHO" > note.txt',
  'RUN cat note.txt',
  'CMD ["/bin/sh"]',
  '',
].join('\n')

// The elements are all in the HTML, so their presence proves nothing about
// whether the module has run. The outlook line is written by it.
const EDITOR_READY = '!document.getElementById("build-outlook").hidden'

const settle = (page) => page.waitFor(
  `(() => {
     const footer = document.querySelector('.build-view-footer')
     return footer && footer.dataset.tone ? footer.dataset.tone + '|' + footer.textContent : null
   })()`,
  { timeoutMs: 300_000, everyMs: 1000, label: 'the build to finish' },
)

const rowsOf = (page) => page.evaluate(`
  [...document.querySelectorAll('.build-view-steps > li')].map(row => ({
    text: row.querySelector('code').textContent,
    state: row.className,
    timing: row.querySelector('em').textContent,
  }))`)

// --- pressing the button ----------------------------------------------------

console.log('\n=== the button builds without leaving the page')
{
  const page = await connect(ORIGIN + '/dockerfile/')
  try {
    await page.waitFor(EDITOR_READY, { label: 'the editor script' })
    await page.evaluate(`(() => {
      const box = document.getElementById('paste-box')
      box.value = ${JSON.stringify(DOCKERFILE)}
      box.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await page.evaluate('document.getElementById("run-btn").click(), true')
    await page.waitFor('!document.getElementById("build-stage").hasAttribute("hidden")',
      { label: 'the build stage' })

    check('it stays on /dockerfile/', await page.evaluate('location.pathname') === '/dockerfile/')
    check('the URL carries the Dockerfile, so a reload or a share still works',
      await page.evaluate('location.hash.includes("dockerfile=")'))
    check('the editor makes way',
      await page.evaluate('document.getElementById("workbench").hasAttribute("hidden")'))

    // The placeholder text is non-empty, so waiting on textContent alone returns
    // before the plan arrives. data-engine is only set once it has.
    const summary = await page.waitFor(
      `(() => {
         const node = document.querySelector('.build-view-summary')
         return node && node.dataset.engine ? node.textContent : null
       })()`, { label: 'the plan' })
    check('the plan is stated, not just a spinner', /Fast path/.test(summary), JSON.stringify(summary))

    const settled = await settle(page)
    check('the build finishes', settled.startsWith('ok|'), settled)

    const rows = await rowsOf(page)
    for (const row of rows) {
      console.log('       [' + (row.state.replace('is-', '') || '').padEnd(7) + '] ' +
        row.timing.padStart(6) + '  ' + row.text)
    }
    check('the reader\'s own RUN steps are the list',
      rows.length === 2 && rows.every((row) => row.text.startsWith('RUN ')), JSON.stringify(rows))
    check('every step resolves', rows.every((row) => /is-done|is-failed|is-skipped/.test(row.state)))
    check('every step carries a measured duration', rows.every((row) => /\d/.test(row.timing)))

    const tail = String(await page.evaluate('window.dockerWasmConsole ? window.dockerWasmConsole() : ""'))
    check('the container really built', /hello world/.test(tail), tail.split('\n').slice(-4).join(' / '))
  } finally {
    await page.close()
  }
}

// --- arriving with the Dockerfile already in the URL -------------------------

console.log('\n=== a shared link goes straight to the build')
{
  const encoded = Buffer.from(DOCKERFILE, 'utf8').toString('base64').replace(/=+$/, '')
  const page = await connect(ORIGIN + '/dockerfile/?net=webvpn#dockerfile=' + encoded)
  try {
    await page.waitFor('!document.getElementById("build-stage").hasAttribute("hidden")',
      { label: 'the build stage' })
    check('it does not wait for a second click',
      await page.evaluate('document.getElementById("workbench").hasAttribute("hidden")'))
    const settled = await settle(page)
    check('the build finishes', settled.startsWith('ok|'), settled)
    const rows = await rowsOf(page)
    check('with the same steps', rows.length === 2, JSON.stringify(rows.map((row) => row.text)))
  } finally {
    await page.close()
  }
}

// --- the transfer path, which has a row and a progress readout of its own ----

console.log('\n=== a base image that has to be pulled')
{
  const dockerfile = DOCKERFILE.replace('alpine:3.21', 'alpine:3.19')
  const encoded = Buffer.from(dockerfile, 'utf8').toString('base64').replace(/=+$/, '')
  const page = await connect(ORIGIN + '/dockerfile/?net=webvpn#dockerfile=' + encoded)
  try {
    await page.waitFor('!document.getElementById("build-stage").hasAttribute("hidden")',
      { label: 'the build stage' })

    // Caught while it is on screen; it is hidden again once the layers land.
    let transfer = null
    for (let attempt = 0; attempt < 300 && !transfer; attempt++) {
      transfer = await page.evaluate(`(() => {
        const node = document.querySelector('.build-view-transfer')
        const label = node && !node.hidden ? node.querySelector('span').textContent : ''
        return label || null
      })()`)
      if (!transfer) await new Promise((resolve) => setTimeout(resolve, 60))
    }
    check('the pull reports real byte totals', /of \d+\.\d MB/.test(transfer ?? ''), JSON.stringify(transfer))

    const settled = await settle(page)
    check('the build finishes', settled.startsWith('ok|'), settled)

    const rows = await rowsOf(page)
    for (const row of rows) {
      console.log('       [' + (row.state.replace('is-', '') || '').padEnd(7) + '] ' +
        row.timing.padStart(6) + '  ' + row.text)
    }
    check('the base image gets a row of its own',
      rows[0]?.text === 'FROM alpine:3.19', JSON.stringify(rows.map((row) => row.text)))
    // The base row spans three markers. Reporting only the last gap made a
    // transfer that took most of the build read as a fraction of a second.
    const baseSeconds = Number.parseFloat(rows[0]?.timing ?? '0')
    const runSeconds = rows.slice(1).reduce((total, row) => total + Number.parseFloat(row.timing), 0)
    check('and its duration covers the whole transfer, not one marker gap',
      baseSeconds > runSeconds, rows[0]?.timing + ' against ' + runSeconds.toFixed(2) + 's of RUN steps')
  } finally {
    await page.close()
  }
}

console.log(failures ? '\n' + failures + ' failing' : '\nall passing')
process.exitCode = failures ? 1 : 0
